import { BrowserWindow } from 'electron'
import { sshManager } from './SSHManager'
import * as net from 'net'

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

interface ActiveForward {
  rule: PortForwardRule
  server?: net.Server
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
        client.forwardOut(
          rule.localHost,
          rule.localPort,
          rule.remoteHost,
          rule.remotePort,
          (err: any, stream: any) => {
            if (err) {
              socket.end()
              return
            }
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

        client.on(
          'tcp connection',
          (info: any, accept: () => any, _reject: () => void) => {
            const stream = accept()
            const socket = net.connect(rule.localPort, rule.localHost, () => {
              socket.pipe(stream).pipe(socket)
            })
          }
        )

        this.forwards.set(rule.id, { rule })
        this.notifyStatus(rule.id, 'active')
        resolve()
      })
    })
  }

  private async createDynamicForward(rule: PortForwardRule, client: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        // Simple SOCKS5 proxy
        socket.once('data', (data) => {
          // SOCKS5 handshake
          if (data[0] === 0x05) {
            socket.write(Buffer.from([0x05, 0x00])) // No auth required

            socket.once('data', (request) => {
              const cmd = request[1]
              if (cmd !== 0x01) {
                // Only CONNECT supported
                socket.end()
                return
              }

              let destHost: string
              let destPort: number
              const addrType = request[3]

              if (addrType === 0x01) {
                // IPv4
                destHost = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`
                destPort = request.readUInt16BE(8)
              } else if (addrType === 0x03) {
                // Domain
                const domainLen = request[4]
                destHost = request.subarray(5, 5 + domainLen).toString()
                destPort = request.readUInt16BE(5 + domainLen)
              } else {
                socket.end()
                return
              }

              client.forwardOut(
                rule.localHost,
                rule.localPort,
                destHost,
                destPort,
                (err: any, stream: any) => {
                  if (err) {
                    socket.end()
                    return
                  }

                  const response = Buffer.from([
                    0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
                  ])
                  socket.write(response)
                  socket.pipe(stream).pipe(socket)
                }
              )
            })
          }
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
      this.forwards.delete(ruleId)
      this.notifyStatus(ruleId, 'stopped')
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
