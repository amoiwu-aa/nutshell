import { Client, ClientChannel } from 'ssh2'
import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { sftpManager } from './SFTPManager'
import { portForwardManager } from './PortForward'
import { serverMonitor } from '../monitor/ServerMonitor'

export interface SSHSession {
  id: string
  client: Client
  shell?: ClientChannel
  config: {
    host: string
    port: number
    username: string
    authType: string
    password?: string
    privateKeyPath?: string
    passphrase?: string
  }
  connected: boolean
  reconnectAttempts: number
  maxReconnectAttempts: number
  autoReconnect: boolean
}

const EXEC_TIMEOUT_MS = 30000
const MAX_RECONNECT_DELAY_MS = 30000

class SSHManager {
  private sessions: Map<string, SSHSession> = new Map()
  private connectingLocks: Map<string, Promise<string>> = new Map()

  async connect(config: {
    id?: string
    host: string
    port: number
    username: string
    authType: 'password' | 'key' | 'keyWithPassphrase'
    password?: string
    privateKeyPath?: string
    passphrase?: string
    jumpHost?: string
    autoReconnect?: boolean
    maxReconnectAttempts?: number
  }): Promise<string> {
    const sessionId = config.id || uuidv4()

    // Prevent duplicate concurrent connections for same session
    const existingLock = this.connectingLocks.get(sessionId)
    if (existingLock) {
      return existingLock
    }

    const connectPromise = this._doConnect(sessionId, config)
    this.connectingLocks.set(sessionId, connectPromise)

    try {
      const result = await connectPromise
      return result
    } finally {
      this.connectingLocks.delete(sessionId)
    }
  }

  private async _doConnect(
    sessionId: string,
    config: {
      host: string
      port: number
      username: string
      authType: 'password' | 'key' | 'keyWithPassphrase'
      password?: string
      privateKeyPath?: string
      passphrase?: string
      autoReconnect?: boolean
      maxReconnectAttempts?: number
    }
  ): Promise<string> {
    // Clean up existing session if any
    if (this.sessions.has(sessionId)) {
      await this.disconnect(sessionId)
    }

    const client = new Client()

    return new Promise((resolve, reject) => {
      const connectOptions: any = {
        host: config.host,
        port: config.port,
        username: config.username,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        readyTimeout: 30000
      }

      if (config.authType === 'password') {
        connectOptions.password = config.password
      } else if (config.authType === 'key' || config.authType === 'keyWithPassphrase') {
        const fs = require('fs')
        try {
          connectOptions.privateKey = fs.readFileSync(config.privateKeyPath!)
          if (config.passphrase) {
            connectOptions.passphrase = config.passphrase
          }
        } catch (err) {
          reject(new Error(`Failed to read private key: ${err}`))
          return
        }
      }

      const onReady = (): void => {
        if (settled) return
        settled = true
        cleanup()
        const session: SSHSession = {
          id: sessionId,
          client,
          config: {
            host: config.host,
            port: config.port,
            username: config.username,
            authType: config.authType,
            password: config.password,
            privateKeyPath: config.privateKeyPath,
            passphrase: config.passphrase
          },
          connected: true,
          reconnectAttempts: 0,
          maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
          autoReconnect: config.autoReconnect ?? true
        }
        this.sessions.set(sessionId, session)

        // Set up persistent close/error handlers after connection
        client.on('close', () => this.handleSessionClose(sessionId))
        client.on('error', (err) => this.handleSessionError(sessionId, err))

        resolve(sessionId)
      }

      let settled = false

      const onError = (err: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(err)
      }

      const onClose = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('Connection closed before handshake completed'))
      }

      const cleanup = (): void => {
        client.removeListener('ready', onReady)
        client.removeListener('error', onError)
        client.removeListener('close', onClose)
      }

      client.once('ready', onReady)
      client.once('error', onError)
      client.once('close', onClose)
      client.connect(connectOptions)
    })
  }

  private handleSessionClose(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.connected = false
    this.notifyClose(sessionId)

    // Clean up dependent resources
    this.cleanupDependents(sessionId)

    // Auto reconnect if enabled
    if (session.autoReconnect && session.reconnectAttempts < session.maxReconnectAttempts) {
      this.attemptReconnect(sessionId)
    }
  }

  private handleSessionError(sessionId: string, err: Error): void {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.connected = false
      this.notifyError(sessionId, err.message)
    }
  }

  private cleanupDependents(sessionId: string): void {
    try { sftpManager.closeSFTP(sessionId) } catch { /* ignore */ }
    try { portForwardManager.removeAllForwards(sessionId) } catch { /* ignore */ }
    try { serverMonitor.stop(sessionId) } catch { /* ignore */ }
    try { this.closeAllLspChannels(sessionId) } catch { /* ignore */ }
  }

  private async attemptReconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.connected) return

    session.reconnectAttempts++
    const delay = Math.min(1000 * Math.pow(2, session.reconnectAttempts - 1), MAX_RECONNECT_DELAY_MS)

    this.notifyReconnecting(sessionId, session.reconnectAttempts, delay)

    await new Promise((resolve) => setTimeout(resolve, delay))

    // Check if session still exists and still wants reconnect
    const currentSession = this.sessions.get(sessionId)
    if (!currentSession || currentSession.connected || !currentSession.autoReconnect) return

    try {
      const newClient = new Client()
      await new Promise<void>((resolve, reject) => {
        const connectOptions: any = {
          host: currentSession.config.host,
          port: currentSession.config.port,
          username: currentSession.config.username,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
          readyTimeout: 30000
        }

        if (currentSession.config.authType === 'password') {
          connectOptions.password = currentSession.config.password
        } else {
          const fs = require('fs')
          try {
            connectOptions.privateKey = fs.readFileSync(currentSession.config.privateKeyPath!)
            if (currentSession.config.passphrase) {
              connectOptions.passphrase = currentSession.config.passphrase
            }
          } catch {
            reject(new Error('Key read failed'))
            return
          }
        }

        newClient.once('ready', () => {
          // Replace old client
          try { currentSession.client.end() } catch { /* ignore */ }
          currentSession.client = newClient
          currentSession.connected = true
          currentSession.reconnectAttempts = 0

          // Re-setup close/error handlers
          newClient.on('close', () => this.handleSessionClose(sessionId))
          newClient.on('error', (err) => this.handleSessionError(sessionId, err))

          this.notifyReconnected(sessionId)

          // Re-open shell if needed
          this.openShell(sessionId).catch(() => { })
          resolve()
        })

        newClient.once('error', (err) => reject(err))
        newClient.connect(connectOptions)
      })
    } catch {
      // Retry again if under limit
      if (session.reconnectAttempts < session.maxReconnectAttempts) {
        this.attemptReconnect(sessionId)
      } else {
        this.notifyError(sessionId, '自动重连失败，已达最大重试次数')
      }
    }
  }

  async openShell(
    sessionId: string, // logged below
    cols: number = 80,
    rows: number = 24
  ): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.connected) throw new Error('Session not connected')

    return new Promise((resolve, reject) => {
      session.client.shell(
        {
          term: 'xterm-256color',
          cols,
          rows,
          modes: {
            // Input modes
            ICRNL: 1,    // Translate CR to NL on input (fixes double-enter bug)
            IXON: 1,     // Enable XON/XOFF flow control
            IXANY: 1,    // Any char restarts output after XOFF
            IMAXBEL: 1,  // Ring bell on input queue full
            // Output modes  
            OPOST: 1,    // Enable output processing
            ONLCR: 1,    // Translate NL to CR-NL on output
            // Local modes
            ISIG: 1,     // Enable signals (INTR, QUIT, SUSP)
            ICANON: 1,   // Canonical input (line editing)
            ECHO: 1,     // Echo input characters
            ECHOE: 1,    // Echo erase as BS-SP-BS
            ECHOK: 1,    // Echo NL after kill
            ECHONL: 0,   // Don't echo NL when ECHO is off  
            IEXTEN: 1,   // Enable extensions
          }
        },
        (err, stream) => {
          if (err) {
            reject(err)
            return
          }

          // Clean up old shell listeners
          if (session.shell) {
            session.shell.removeAllListeners()
            session.shell.end()
          }

          session.shell = stream

          stream.on('data', (data: Buffer) => {
            this.notifyData(sessionId, data.toString('utf-8'))
          })

          stream.on('close', () => {
            this.notifyClose(sessionId)
          })

          stream.stderr.on('data', (data: Buffer) => {
            this.notifyData(sessionId, data.toString('utf-8'))
          })

          resolve()
        }
      )
    })
  }

  write(sessionId: string, data: string): void {
    // First check regular sessions
    const session = this.sessions.get(sessionId)
    if (session?.shell && session.connected) {
      session.shell.write(data)
      return
    }
    // Then check external shells (docker exec, etc.)
    this.writeExternal(sessionId, data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId)
    if (session?.shell && session.connected) {
      session.shell.setWindow(rows, cols, 0, 0)
      return
    }
    // Also handle external shells
    this.resizeExternal(sessionId, cols, rows)
  }

  async disconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      session.autoReconnect = false // Prevent reconnect on intentional disconnect
      session.connected = false

      // Clean up dependents first
      this.cleanupDependents(sessionId)

      // Clean up shell
      if (session.shell) {
        session.shell.removeAllListeners()
        session.shell.end()
      }

      // Clean up client
      session.client.removeAllListeners()
      session.client.end()

      this.sessions.delete(sessionId)
    }
  }

  getSession(sessionId: string): SSHSession | undefined {
    return this.sessions.get(sessionId)
  }

  getClient(sessionId: string): Client | undefined {
    return this.sessions.get(sessionId)?.client
  }

  isConnected(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.connected ?? false
  }

  getAllSessions(): SSHSession[] {
    return Array.from(this.sessions.values())
  }

  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys())
    await Promise.all(ids.map((id) => this.disconnect(id)))
  }

  async getRemoteHomeDir(sessionId: string): Promise<string> {
    try {
      const result = await this.exec(sessionId, 'echo $HOME', 5000)
      const home = result.trim()
      return home || '/'
    } catch {
      return '/'
    }
  }

  async exec(sessionId: string, command: string, timeoutMs: number = EXEC_TIMEOUT_MS): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.connected) throw new Error('Session not connected')

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Command timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      session.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          reject(err)
          return
        }

        let output = ''
        let errorOutput = ''

        stream.on('data', (data: Buffer) => {
          output += data.toString()
        })

        stream.stderr.on('data', (data: Buffer) => {
          errorOutput += data.toString()
        })

        stream.on('close', () => {
          clearTimeout(timer)
          stream.removeAllListeners()
          resolve(output || errorOutput)
        })

        stream.on('error', (streamErr: Error) => {
          clearTimeout(timer)
          stream.removeAllListeners()
          reject(streamErr)
        })
      })
    })
  }

  // --- LSP Stream channels (persistent bidirectional exec streams) ---
  private lspChannels: Map<string, ClientChannel> = new Map()

  /**
   * Create a persistent bidirectional exec stream for LSP communication.
   * Unlike exec(), this does NOT wait for the command to finish.
   * Returns a channelId for subsequent read/write operations.
   */
  async execStream(
    sessionId: string,
    command: string,
    onData: (data: string) => void,
    onStderr: (data: string) => void,
    onClose: () => void
  ): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.connected) throw new Error('Session not connected')

    const channelId = `lsp-${sessionId}-${Date.now()}`

    return new Promise((resolve, reject) => {
      session.client.exec(command, (err, stream) => {
        if (err) { reject(err); return }

        this.lspChannels.set(channelId, stream)

        stream.on('data', (data: Buffer) => {
          onData(data.toString('utf-8'))
        })

        stream.stderr.on('data', (data: Buffer) => {
          onStderr(data.toString('utf-8'))
        })

        stream.on('close', () => {
          stream.removeAllListeners()
          this.lspChannels.delete(channelId)
          onClose()
        })

        stream.on('error', (err: Error) => {
          stream.removeAllListeners()
          this.lspChannels.delete(channelId)
          onClose()
        })

        resolve(channelId)
      })
    })
  }

  /**
   * Write data to an LSP stream channel
   */
  writeLspChannel(channelId: string, data: string): boolean {
    const stream = this.lspChannels.get(channelId)
    if (stream) {
      stream.write(data)
      return true
    }
    return false
  }

  /**
   * Close an LSP stream channel
   */
  closeLspChannel(channelId: string): void {
    const stream = this.lspChannels.get(channelId)
    if (stream) {
      stream.removeAllListeners()
      stream.end()
      this.lspChannels.delete(channelId)
    }
  }

  /**
   * Close all LSP channels for a session
   */
  closeAllLspChannels(sessionId: string): void {
    for (const [id, stream] of this.lspChannels.entries()) {
      if (id.startsWith(`lsp-${sessionId}-`)) {
        stream.removeAllListeners()
        stream.end()
        this.lspChannels.delete(id)
      }
    }
  }

  // --- External shell management (for docker exec, etc.) ---
  private externalShells: Map<string, ClientChannel> = new Map()

  registerExternalShell(shellId: string, stream: ClientChannel): void {
    this.externalShells.set(shellId, stream)

    stream.on('close', () => {
      stream.removeAllListeners()
      this.externalShells.delete(shellId)
    })
  }

  writeExternal(shellId: string, data: string): boolean {
    const stream = this.externalShells.get(shellId)
    if (stream) {
      stream.write(data)
      return true
    }
    return false
  }

  resizeExternal(shellId: string, cols: number, rows: number): void {
    const stream = this.externalShells.get(shellId)
    if (stream) {
      stream.setWindow(rows, cols, 0, 0)
    }
  }

  closeExternalShell(shellId: string): void {
    const stream = this.externalShells.get(shellId)
    if (stream) {
      stream.removeAllListeners()
      stream.end()
      this.externalShells.delete(shellId)
    }
  }

  // --- Notifications ---
  private notifyData(sessionId: string, data: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ssh:data', sessionId, data)
    }
  }

  private notifyClose(sessionId: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ssh:close', sessionId)
    }
  }

  private notifyError(sessionId: string, error: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ssh:error', sessionId, error)
    }
  }

  private notifyReconnecting(sessionId: string, attempt: number, delay: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ssh:reconnecting', sessionId, attempt, delay)
    }
  }

  private notifyReconnected(sessionId: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('ssh:reconnected', sessionId)
    }
  }
}

export const sshManager = new SSHManager()
