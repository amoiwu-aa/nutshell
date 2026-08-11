import { BrowserWindow } from 'electron'
import { sshManager } from './SSHManager'
import * as net from 'net'
import { buildConnectReply, parseConnectRequest, SOCKS5_REPLY, SOCKS5_VERSION } from './socks5'

export interface PortForwardRule {
  id: string
  connectionId: string
  type: 'local' | 'remote' | 'dynamic'
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
  enabled: boolean
}

type TcpConnectionHandler = (info: any, accept: () => any, reject: () => void) => void

interface ActiveForward {
  rule: PortForwardRule
  server?: net.Server
  // Kept for remote forwards so removeForward can detach the exact listener
  // from the exact client the forward was registered on
  client?: any
  tcpConnectionHandler?: TcpConnectionHandler
}

class PortForwardManager {
  private forwards: Map<string, ActiveForward> = new Map()

  async createForward(rule: PortForwardRule): Promise<void> {
    const client = sshManager.getClient(rule.connectionId)
    if (!client) throw new Error('SSH session not found')

    if (rule.type === 'local') {
      await this.createLocalForward(rule, client)
    } else if (rule.type === 'remote') {
      await this.createRemoteForward(rule, client)
    } else if (rule.type === 'dynamic') {
      await this.createDynamicForward(rule, client)
    }
  }

  private async createLocalForward(rule: PortForwardRule, client: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Swallow socket errors that fire before the SSH channel exists
        socket.on('error', () => {})
        client.forwardOut(
          rule.localHost,
          rule.localPort,
          rule.remoteHost,
          rule.remotePort,
          (err: any, stream: any) => {
            if (err) {
              socket.destroy()
              return
            }
            if (socket.destroyed) {
              stream.destroy()
              return
            }
            socket.on('error', () => stream.destroy())
            stream.on('error', () => socket.destroy())
            socket.pipe(stream).pipe(socket)
          }
        )
      })

      server.on('error', (err) => {
        this.notifyStatus(rule.id, `error: ${err.message}`)
        reject(err)
      })

      server.listen(rule.localPort, rule.localHost, () => {
        this.forwards.set(rule.id, { rule, server })
        this.notifyStatus(rule.id, 'active')
        resolve()
      })
    })
  }

  private async createRemoteForward(rule: PortForwardRule, client: any): Promise<void> {
    return new Promise((resolve, reject) => {
      client.forwardIn(rule.remoteHost, rule.remotePort, (err: any) => {
        if (err) {
          this.notifyStatus(rule.id, `error: ${err.message}`)
          reject(err)
          return
        }

        // The client emits 'tcp connection' for every forwarded-in port, so
        // each rule needs its own handler that only accepts its own port
        const tcpConnectionHandler: TcpConnectionHandler = (info, accept, _reject) => {
          if (info.destPort !== rule.remotePort) return
          const stream = accept()
          const socket = net.connect(rule.localPort, rule.localHost, () => {
            socket.pipe(stream).pipe(socket)
          })
          socket.on('error', () => stream.destroy())
          stream.on('error', () => socket.destroy())
        }

        client.on('tcp connection', tcpConnectionHandler)

        this.forwards.set(rule.id, { rule, client, tcpConnectionHandler })
        this.notifyStatus(rule.id, 'active')
        resolve()
      })
    })
  }

  private async createDynamicForward(rule: PortForwardRule, client: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        socket.on('error', () => {})
        // Simple SOCKS5 proxy
        socket.once('data', (data) => {
          // SOCKS5 handshake
          if (data[0] !== SOCKS5_VERSION) {
            socket.destroy()
            return
          }
          socket.write(Buffer.from([SOCKS5_VERSION, 0x00])) // No auth required

          socket.once('data', (request) => {
            const parsed = parseConnectRequest(request)
            if ('replyCode' in parsed) {
              socket.end(buildConnectReply(parsed.replyCode))
              return
            }

            client.forwardOut(
              rule.localHost,
              rule.localPort,
              parsed.host,
              parsed.port,
              (err: any, stream: any) => {
                if (socket.destroyed) {
                  if (stream) stream.destroy()
                  return
                }
                if (err) {
                  socket.end(buildConnectReply(SOCKS5_REPLY.connectionRefused))
                  return
                }
                socket.on('error', () => stream.destroy())
                stream.on('error', () => socket.destroy())
                socket.write(buildConnectReply(SOCKS5_REPLY.succeeded))
                socket.pipe(stream).pipe(socket)
              }
            )
          })
        })
      })

      server.on('error', (err) => {
        this.notifyStatus(rule.id, `error: ${err.message}`)
        reject(err)
      })

      server.listen(rule.localPort, rule.localHost, () => {
        this.forwards.set(rule.id, { rule, server })
        this.notifyStatus(rule.id, 'active')
        resolve()
      })
    })
  }

  removeForward(ruleId: string): void {
    const forward = this.forwards.get(ruleId)
    if (forward) {
      if (forward.server) {
        forward.server.close()
      }
      if (forward.rule.type === 'remote') {
        this.teardownRemoteForward(forward)
      }
      this.forwards.delete(ruleId)
      this.notifyStatus(ruleId, 'stopped')
    }
  }

  private teardownRemoteForward(forward: ActiveForward): void {
    const { rule, client, tcpConnectionHandler } = forward
    // If the session dropped (or reconnected onto a new client), the remote
    // listener is already gone with the old connection: nothing to undo
    if (!client || sshManager.getClient(rule.connectionId) !== client) return
    if (tcpConnectionHandler) {
      client.removeListener('tcp connection', tcpConnectionHandler)
    }
    try {
      client.unforwardIn(rule.remoteHost, rule.remotePort, () => {})
    } catch {
      // Client can disconnect between the liveness check and this call
    }
  }

  listForwards(sessionId: string): PortForwardRule[] {
    const rules: PortForwardRule[] = []
    for (const forward of this.forwards.values()) {
      if (forward.rule.connectionId === sessionId) {
        rules.push(forward.rule)
      }
    }
    return rules
  }

  removeAllForwards(sessionId: string): void {
    for (const [id, forward] of this.forwards) {
      if (forward.rule.connectionId === sessionId) {
        this.removeForward(id)
      }
    }
  }

  private notifyStatus(ruleId: string, status: string): void {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach((win) => {
      win.webContents.send('portForward:status', ruleId, status)
    })
  }
}

export const portForwardManager = new PortForwardManager()
