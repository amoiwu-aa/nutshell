import { Client, ClientChannel } from 'ssh2'
import type { ExecOptions } from 'ssh2'
import { BrowserWindow } from 'electron'
import { v4 as uuidv4 } from 'uuid'
import { sftpManager } from './SFTPManager'
import { portForwardManager } from './PortForward'
import { serverMonitor } from '../monitor/ServerMonitor'
import {
  getConnectionTuning,
  computeReconnectDelay,
  shouldRetryReconnect,
  PREFERRED_CIPHERS,
  SSH_HIGH_WATER_MARK,
  DEFAULT_CONNECTION_TUNING
} from './connectionTuning'

const DEFAULT_SSH_TERM = 'xterm-256color'

interface TerminalDiagnosticsResult {
  term: string
  locale: string[]
  widthSample: string
  boxSample: string[]
  emojiSample: string
  rawOutput: string
  checks: {
    termMatches: boolean
    localeUtf8: boolean
    widthMatches: boolean
    boxMatches: boolean
    emojiMatches: boolean
  }
}

interface SessionConnectConfig {
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
  aiCompatibilityMode?: boolean
}

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
    aiCompatibilityMode?: boolean
  }
  connected: boolean
  reconnectAttempts: number
  maxReconnectAttempts: number
  autoReconnect: boolean
}

const EXEC_TIMEOUT_MS = DEFAULT_CONNECTION_TUNING.execTimeoutMs

class SSHManager {
  private sessions: Map<string, SSHSession> = new Map()
  private connectingLocks: Map<string, Promise<string>> = new Map()

  /**
   * Build ssh2 connect options from a session config and the centralized tuning.
   * Shared by initial connect and reconnect so both paths stay in lockstep.
   */
  private buildConnectOptions(
    config: {
      host: string
      port: number
      username: string
      authType: string
      password?: string
      passphrase?: string
    },
    privateKeyData?: Buffer
  ): Record<string, unknown> {
    const tuning = getConnectionTuning()
    const options: Record<string, unknown> = {
      host: config.host,
      port: config.port,
      username: config.username,
      keepaliveInterval: tuning.keepaliveIntervalMs,
      keepaliveCountMax: tuning.keepaliveCountMax,
      readyTimeout: tuning.readyTimeoutMs,
      highWaterMark: SSH_HIGH_WATER_MARK,
      algorithms: { cipher: [...PREFERRED_CIPHERS] }
    }

    if (config.authType === 'password') {
      options.password = config.password
    } else {
      options.privateKey = privateKeyData
      if (config.passphrase) {
        options.passphrase = config.passphrase
      }
    }

    return options
  }

  private getTerminalEnvironment(aiCompatibilityMode: boolean): NodeJS.ProcessEnv | undefined {
    if (!aiCompatibilityMode) {
      return undefined
    }

    return {
      TERM: DEFAULT_SSH_TERM,
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Nutshell',
      TERM_PROGRAM_VERSION: '1.0.1',
      INSIDE_NUTSHELL: '1',
      FORCE_COLOR: '1'
    }
  }

  async connect(config: SessionConnectConfig & { id?: string }): Promise<string> {
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
    config: SessionConnectConfig
  ): Promise<string> {
    // Clean up existing session if any
    if (this.sessions.has(sessionId)) {
      await this.disconnect(sessionId)
    }

    let privateKeyData: Buffer | undefined
    if (config.authType === 'key' || config.authType === 'keyWithPassphrase') {
      const fs = require('fs')
      privateKeyData = await fs.promises.readFile(config.privateKeyPath!)
    }

    const client = new Client()

    return new Promise((resolve, reject) => {
      const tuning = getConnectionTuning()
      const connectOptions = this.buildConnectOptions(
        {
          host: config.host,
          port: config.port,
          username: config.username,
          authType: config.authType,
          password: config.password,
          passphrase: config.passphrase
        },
        privateKeyData
      )

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
            passphrase: config.passphrase,
            aiCompatibilityMode: config.aiCompatibilityMode
          },
          connected: true,
          reconnectAttempts: 0,
          maxReconnectAttempts: config.maxReconnectAttempts ?? tuning.maxReconnectAttempts,
          autoReconnect: config.autoReconnect ?? tuning.autoReconnect
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

    // Auto reconnect if enabled (next attempt is reconnectAttempts + 1)
    const tuning = getConnectionTuning()
    if (session.autoReconnect && shouldRetryReconnect(session.reconnectAttempts + 1, tuning)) {
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
    try { serverMonitor.stop(sessionId, true) } catch { /* ignore */ }
  }

  private async attemptReconnect(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session.connected) return

    const tuning = getConnectionTuning()
    session.reconnectAttempts++
    const delay = computeReconnectDelay(session.reconnectAttempts, tuning)

    this.notifyReconnecting(sessionId, session.reconnectAttempts, delay)

    await new Promise((resolve) => setTimeout(resolve, delay))

    // Check if session still exists and still wants reconnect
    const currentSession = this.sessions.get(sessionId)
    if (!currentSession || currentSession.connected || !currentSession.autoReconnect) return

    try {
      const newClient = new Client()

      let reconnectKeyData: Buffer | undefined
      if (currentSession.config.authType !== 'password' && currentSession.config.privateKeyPath) {
        const fs = require('fs')
        reconnectKeyData = await fs.promises.readFile(currentSession.config.privateKeyPath)
      }

      await new Promise<void>((resolve, reject) => {
        const connectOptions = this.buildConnectOptions(currentSession.config, reconnectKeyData)

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
      // Retry again if still permitted by the tuning policy
      if (shouldRetryReconnect(session.reconnectAttempts + 1, tuning)) {
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

    const aiCompatibilityMode = session.config.aiCompatibilityMode === true
    const windowOptions: {
      term: string
      cols: number
      rows: number
      modes?: {
        [key: string]: number
      }
    } = {
      term: 'xterm-256color',
      cols,
      rows
    }

    if (!aiCompatibilityMode) {
      windowOptions.modes = {
        ICRNL: 1,
        IXON: 1,
        IXANY: 1,
        IMAXBEL: 1,
        OPOST: 1,
        ONLCR: 1,
        ISIG: 1,
        ICANON: 1,
        ECHO: 1,
        ECHOE: 1,
        ECHOK: 1,
        ECHONL: 0,
        IEXTEN: 1
      }
    }

    const shellOptions = aiCompatibilityMode
      ? {
          env: this.getTerminalEnvironment(true)
        }
      : {}

    return new Promise((resolve, reject) => {
      session.client.shell(
        windowOptions,
        shellOptions,
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
    return this.execWithOptions(sessionId, command, timeoutMs)
  }

  async runTerminalDiagnostics(sessionId: string): Promise<TerminalDiagnosticsResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')

    const output = await this.execWithOptions(
      sessionId,
      [
        "cat <<'NUTSHELL_DIAG' | sh",
        "printf '__NUTSHELL_TERM__\\n'",
        "printf '%s\\n' \"$TERM\"",
        "printf '__NUTSHELL_LOCALE__\\n'",
        "(locale 2>/dev/null || env | grep -E '^(LANG|LC_)=' 2>/dev/null || true)",
        "printf '__NUTSHELL_WIDTH__\\n'",
        "printf '%s\\n' '| hello | 中文宽度 | ⅠⅡⅢ | 🙂🚀 |'",
        "printf '__NUTSHELL_BOX__\\n'",
        "printf '%s\\n' '┌──────────┬────┐'",
        "printf '%s\\n' '│ 中文 🙂  │ OK │'",
        "printf '%s\\n' '└──────────┴────┘'",
        "printf '__NUTSHELL_EMOJI__\\n'",
        "printf '%s\\n' '🙂 🚀 🧠 ✅ 🔥'",
        "printf '__NUTSHELL_DONE__\\n'",
        'NUTSHELL_DIAG'
      ].join('\n'),
      15000,
      {
        pty: {
          term: DEFAULT_SSH_TERM,
          cols: 80,
          rows: 24
        },
        env: {
          TERM: DEFAULT_SSH_TERM,
          ...this.getTerminalEnvironment(session.config.aiCompatibilityMode === true)
        }
      }
    )

    const readSection = (name: string, nextName: string): string[] => {
      const startMarker = `__NUTSHELL_${name}__`
      const endMarker = `__NUTSHELL_${nextName}__`
      const start = output.indexOf(startMarker)
      const end = output.indexOf(endMarker)
      if (start === -1 || end === -1 || end <= start) {
        return []
      }

      return output
        .slice(start + startMarker.length, end)
        .replace(/^\r?\n/, '')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
    }

    const term = readSection('TERM', 'LOCALE')[0] || ''
    const locale = readSection('LOCALE', 'WIDTH')
    const widthSample = readSection('WIDTH', 'BOX')[0] || ''
    const boxSample = readSection('BOX', 'EMOJI')
    const emojiSample = readSection('EMOJI', 'DONE')[0] || ''
    const expectedWidthSample = '| hello | 中文宽度 | ⅠⅡⅢ | 🙂🚀 |'
    const expectedBoxSample = ['┌──────────┬────┐', '│ 中文 🙂  │ OK │', '└──────────┴────┘']
    const expectedEmojiSample = '🙂 🚀 🧠 ✅ 🔥'

    return {
      term,
      locale,
      widthSample,
      boxSample,
      emojiSample,
      rawOutput: output,
      checks: {
        termMatches: term === DEFAULT_SSH_TERM,
        localeUtf8: locale.some((line) => /utf-?8|c\.utf-?8/i.test(line)),
        widthMatches: widthSample === expectedWidthSample,
        boxMatches: JSON.stringify(boxSample) === JSON.stringify(expectedBoxSample),
        emojiMatches: emojiSample === expectedEmojiSample
      }
    }
  }

  async execWithOptions(
    sessionId: string,
    command: string,
    timeoutMs: number = EXEC_TIMEOUT_MS,
    execOptions?: ExecOptions
  ): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('Session not found')
    if (!session.connected) throw new Error('Session not connected')

    return new Promise((resolve, reject) => {
      let settled = false
      let activeStream: ClientChannel | null = null

      // Always release the channel + listeners exactly once. Without this, a
      // timed-out command would leak its SSH channel, eventually exhausting the
      // server's MaxSessions limit and breaking every subsequent exec.
      const cleanupStream = (): void => {
        const stream = activeStream
        if (!stream) return
        activeStream = null
        try { stream.removeAllListeners() } catch { /* ignore */ }
        try { stream.stderr?.removeAllListeners() } catch { /* ignore */ }
        try { stream.close() } catch { /* ignore */ }
        try { stream.destroy() } catch { /* ignore */ }
      }

      const finish = (err: Error | null, value?: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        cleanupStream()
        if (err) reject(err)
        else resolve(value ?? '')
      }

      const timer = setTimeout(() => {
        finish(new Error(`Command timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const callback = (err: Error | undefined, stream: ClientChannel): void => {
        if (err) {
          finish(err)
          return
        }
        if (settled) {
          // Timed out before the channel opened — close it immediately.
          try { stream.close() } catch { /* ignore */ }
          try { stream.destroy() } catch { /* ignore */ }
          return
        }

        activeStream = stream
        let output = ''
        let errorOutput = ''

        stream.on('data', (data: Buffer) => {
          output += data.toString()
        })
        stream.stderr.on('data', (data: Buffer) => {
          errorOutput += data.toString()
        })
        stream.on('close', () => {
          finish(null, output || errorOutput)
        })
        stream.on('error', (streamErr: Error) => {
          finish(streamErr)
        })
      }

      try {
        if (execOptions) {
          session.client.exec(command, execOptions, callback)
        } else {
          session.client.exec(command, callback)
        }
      } catch (syncErr: any) {
        finish(syncErr instanceof Error ? syncErr : new Error(String(syncErr)))
      }
    })
  }

  // --- External shell management (for docker exec, etc.) ---
  private externalShells: Map<string, ClientChannel> = new Map()

  hasExternalShell(shellId: string): boolean {
    return this.externalShells.has(shellId)
  }

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
