import { ChildProcessWithoutNullStreams, spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow } from 'electron'

type PendingRequest = {
  resolve: (value: any) => void
  reject: (reason?: any) => void
  timer: NodeJS.Timeout
}

interface RustCoreResponse {
  type: 'response'
  id?: string
  success: boolean
  result?: any
  error?: {
    code: string
    message: string
  }
}

interface RustCoreEventBase {
  type: 'event'
}

interface RustCoreReadyEvent extends RustCoreEventBase {
  version?: string
}

interface RustCoreLogEvent extends RustCoreEventBase {
  level?: string
  message?: string
}

type LaunchConfig = {
  command: string
  args: string[]
  cwd: string
  readyTimeoutMs: number
  source: string
}

interface RustCoreSshDataEvent extends RustCoreEventBase {
  session_id: string
  data: string
}

interface RustCoreSshCloseEvent extends RustCoreEventBase {
  session_id: string
}

interface RustCoreSshErrorEvent extends RustCoreEventBase {
  session_id: string
  error: string
}

interface RustCorePortForwardStatusEvent extends RustCoreEventBase {
  rule_id: string
  status: string
}

interface RustCoreDockerLogsEvent extends RustCoreEventBase {
  container_id: string
  data: string
}

interface RustCoreExternalShellCloseEvent extends RustCoreEventBase {
  session_id: string
}

interface RustCoreNativeTransferProgressEvent extends RustCoreEventBase {
  transfer_id: string
  transferred: number
  total: number
  status: string
  error?: string
}

type RustCoreEvent =
  | RustCoreReadyEvent
  | RustCoreLogEvent
  | RustCoreSshDataEvent
  | RustCoreSshCloseEvent
  | RustCoreSshErrorEvent
  | RustCorePortForwardStatusEvent
  | RustCoreDockerLogsEvent
  | RustCoreExternalShellCloseEvent
  | RustCoreNativeTransferProgressEvent

export interface RustSshConnectConfig {
  sessionId: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key' | 'keyWithPassphrase'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  aiCompatibilityMode?: boolean
}

export interface RustRunCommandParams {
  sessionId: string
  command: string
  cwd?: string
  timeoutMs?: number
  env?: Array<{ key: string; value: string }>
  requireConfirmation?: boolean
}

export interface RustListDirParams {
  sessionId: string
  path: string
}

export interface RustReadFileParams {
  sessionId: string
  path: string
  maxBytes?: number
}

export interface RustReadBinaryFileParams {
  sessionId: string
  path: string
  offset?: number
  maxBytes?: number
}

export interface RustSearchParams {
  sessionId: string
  rootPath: string
  pattern: string
  limit?: number
}

export interface RustWriteFileParams {
  sessionId: string
  path: string
  content: string
  createDirs?: boolean
}

export interface RustWriteBinaryFileParams {
  sessionId: string
  path: string
  contentBase64: string
  append?: boolean
  createDirs?: boolean
}

export interface RustStatPathParams {
  sessionId: string
  path: string
}

export interface RustMkdirParams {
  sessionId: string
  path: string
  recursive?: boolean
}

export interface RustRemovePathParams {
  sessionId: string
  path: string
  recursive?: boolean
}

export interface RustMovePathParams {
  sessionId: string
  fromPath: string
  toPath: string
}

export interface RustChmodPathParams {
  sessionId: string
  path: string
  mode: string
}

export interface RustReadMultipleFilesParams {
  sessionId: string
  paths: string[]
  maxBytesPerFile?: number
}

export interface RustProjectRootParams {
  sessionId: string
  rootPath: string
}

export interface RustMonitorSnapshotParams {
  sessionId: string
}

export interface RustPortForwardRule {
  id: string
  connectionId: string
  type: 'local' | 'remote' | 'dynamic'
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
  enabled: boolean
}

export interface RustDockerLogStreamParams {
  sessionId: string
  containerId: string
  tail?: string
}

export interface RustNativeTransferParams {
  sessionId: string
  transferId: string
  localPath: string
  remotePath: string
}

class RustCoreService {
  private process: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = Buffer.alloc(0)
  private nextRequestId = 1
  private pending = new Map<string, PendingRequest>()
  private sessionShellClosed = new Set<string>()
  private knownSshSessions = new Set<string>()
  private activeSshSessions = new Set<string>()
  private readyVersion: string | null = null
  private startupError: Error | null = null
  private currentLaunchSource = 'unknown'
  private restartAttempts = 0
  private manuallyStopped = false
  private starting: Promise<void> | null = null

  async start(): Promise<void> {
    if (this.process && !this.process.killed) {
      return
    }
    if (this.starting) {
      return this.starting
    }

    this.starting = this.startInternal()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  private async startInternal(): Promise<void> {
    if (this.process && !this.process.killed) {
      return
    }

    const { command, args, cwd, readyTimeoutMs, source } = this.resolveLaunchConfig()
    this.manuallyStopped = false
    this.stdoutBuffer = Buffer.alloc(0)
    this.readyVersion = null
    this.startupError = null
    this.currentLaunchSource = source

    console.info(`[rust-core] starting via ${source}: ${command}${args.length ? ` ${args.join(' ')}` : ''}`)

    this.process = spawn(command, args, {
      cwd,
      stdio: 'pipe',
      windowsHide: true
    })

    this.process.on('error', (error) => {
      this.startupError = error
      console.error('[rust-core] process launch error', error)
    })
    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', (chunk: string) => {
      console.warn('[rust-core][stderr]', chunk.trim())
    })
    this.process.on('exit', (code, signal) => {
      console.warn(`[rust-core] exited with code=${code} signal=${signal}`)
      this.process = null

      // Notify renderer that all Rust SSH sessions are gone
      for (const sessionId of this.activeSshSessions) {
        this.broadcast('ssh:close', sessionId)
      }

      this.sessionShellClosed.clear()
      this.knownSshSessions.clear()
      this.activeSshSessions.clear()
      this.readyVersion = null
      this.rejectAllPending(new Error('Rust core process exited'))

      if (!this.manuallyStopped && this.restartAttempts < 3) {
        this.restartAttempts += 1
        setTimeout(() => {
          this.start().catch((error) => {
            console.error('[rust-core] restart failed', error)
          })
        }, 500)
      }
    })

    await this.waitForReady(readyTimeoutMs)
    this.restartAttempts = 0
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
      if (this.startupError) {
        throw this.startupError
      }
      if (!this.process || this.process.killed) {
        throw new Error('Rust core process exited before ready')
      }
      if (this.readyVersion) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    throw new Error(`Rust core startup timed out while waiting for ready event (${this.currentLaunchSource})`)
  }

  async stop(): Promise<void> {
    this.manuallyStopped = true
    this.rejectAllPending(new Error('Rust core stopped'))
    if (this.process && !this.process.killed) {
      this.process.kill()
    }
    this.process = null
    this.sessionShellClosed.clear()
    this.knownSshSessions.clear()
    this.activeSshSessions.clear()
    this.readyVersion = null
    this.startupError = null
  }

  async ping(): Promise<{ pong: boolean; version: string; capabilities: Record<string, boolean> }> {
    return this.request('core.ping', {})
  }

  async getMigrationPlan(): Promise<{ status: string; message: string }> {
    return this.request('ssh.plan', {})
  }

  async getAiRemoteBlueprint(): Promise<{ status: string; message: string }> {
    return this.request('ssh.plan', {})
  }

  async runCommand(params: RustRunCommandParams): Promise<{ command: string; stdout: string; stderr: string; exitCode: number | null; durationMs: number; riskLevel: string; requiresConfirmation: boolean; blocked: boolean; reason: string }> {
    return this.request('tool.runCommand', {
      session_id: params.sessionId,
      command: params.command,
      cwd: params.cwd,
      timeout_ms: params.timeoutMs,
      env: params.env,
      require_confirmation: params.requireConfirmation
    }, (params.timeoutMs ?? 15000) + 5000)
  }

  async listDir(params: RustListDirParams): Promise<{ entries: any[] }> {
    return this.request('tool.listDir', {
      session_id: params.sessionId,
      path: params.path
    }, 15000)
  }

  async readFile(params: RustReadFileParams): Promise<{ content: string; truncated: boolean; size: number }> {
    return this.request('tool.readFile', {
      session_id: params.sessionId,
      path: params.path,
      max_bytes: params.maxBytes
    }, 15000)
  }

  async readBinaryFile(params: RustReadBinaryFileParams): Promise<{ contentBase64: string; size: number; bytesRead: number; eof: boolean }> {
    return this.request('tool.readBinaryFile', {
      session_id: params.sessionId,
      path: params.path,
      offset: params.offset,
      max_bytes: params.maxBytes
    }, 60000)
  }

  async search(params: RustSearchParams): Promise<{ matches: any[] }> {
    return this.request('tool.search', {
      session_id: params.sessionId,
      root_path: params.rootPath,
      pattern: params.pattern,
      limit: params.limit
    }, 20000)
  }

  async writeFile(params: RustWriteFileParams): Promise<{ path: string; written: number }> {
    return this.request('tool.writeFile', {
      session_id: params.sessionId,
      path: params.path,
      content: params.content,
      create_dirs: params.createDirs
    }, 15000)
  }

  async writeBinaryFile(params: RustWriteBinaryFileParams): Promise<{ path: string; written: number }> {
    return this.request('tool.writeBinaryFile', {
      session_id: params.sessionId,
      path: params.path,
      content_base64: params.contentBase64,
      append: params.append,
      create_dirs: params.createDirs
    }, 60000)
  }

  async nativeUpload(params: RustNativeTransferParams): Promise<{ success: boolean }> {
    return this.request('tool.nativeUpload', {
      session_id: params.sessionId,
      transfer_id: params.transferId,
      local_path: params.localPath,
      remote_path: params.remotePath
    }, 0) // No timeout for bulk transfers
  }

  async nativeDownload(params: RustNativeTransferParams): Promise<{ success: boolean }> {
    return this.request('tool.nativeDownload', {
      session_id: params.sessionId,
      transfer_id: params.transferId,
      local_path: params.localPath,
      remote_path: params.remotePath
    }, 0) // No timeout
  }

  async statPath(params: RustStatPathParams): Promise<any> {
    return this.request('tool.statPath', {
      session_id: params.sessionId,
      path: params.path
    }, 10000)
  }

  async mkdir(params: RustMkdirParams): Promise<{ path: string; created: boolean }> {
    return this.request('tool.mkdir', {
      session_id: params.sessionId,
      path: params.path,
      recursive: params.recursive
    }, 10000)
  }

  async removePath(params: RustRemovePathParams): Promise<{ path: string; removed: boolean }> {
    return this.request('tool.removePath', {
      session_id: params.sessionId,
      path: params.path,
      recursive: params.recursive
    }, 15000)
  }

  async movePath(params: RustMovePathParams): Promise<{ from: string; to: string; moved: boolean }> {
    return this.request('tool.movePath', {
      session_id: params.sessionId,
      from_path: params.fromPath,
      to_path: params.toPath
    }, 15000)
  }

  async chmodPath(params: RustChmodPathParams): Promise<{ path: string; mode: string; updated: boolean }> {
    return this.request('tool.chmodPath', {
      session_id: params.sessionId,
      path: params.path,
      mode: params.mode
    }, 15000)
  }

  async readMultipleFiles(params: RustReadMultipleFilesParams): Promise<{ results: any[] }> {
    return this.request('tool.readMultipleFiles', {
      session_id: params.sessionId,
      paths: params.paths,
      max_bytes_per_file: params.maxBytesPerFile
    }, 20000)
  }

  async scanProject(params: RustProjectRootParams): Promise<{ files: string[] }> {
    return this.request('tool.scanProject', {
      session_id: params.sessionId,
      root_path: params.rootPath
    }, 20000)
  }

  async projectSummary(params: RustProjectRootParams): Promise<{ summary: string }> {
    return this.request('tool.projectSummary', {
      session_id: params.sessionId,
      root_path: params.rootPath
    }, 20000)
  }

  async monitorSnapshot(params: RustMonitorSnapshotParams): Promise<{ serverTime: string; cpu: string; loadavg: string; uptime: string; memory: string; network: string }> {
    return this.request('tool.monitorSnapshot', {
      session_id: params.sessionId
    }, 15000)
  }

  async createPortForward(rule: RustPortForwardRule): Promise<void> {
    await this.request('ssh.portForward.create', {
      id: rule.id,
      connection_id: rule.connectionId,
      type: rule.type,
      local_host: rule.localHost,
      local_port: rule.localPort,
      remote_host: rule.remoteHost,
      remote_port: rule.remotePort,
      enabled: rule.enabled
    }, 10000)
  }

  async removePortForward(ruleId: string): Promise<void> {
    await this.request('ssh.portForward.remove', {
      rule_id: ruleId
    }, 5000)
  }

  async listPortForwards(sessionId: string): Promise<{ rules: RustPortForwardRule[] }> {
    return this.request('ssh.portForward.list', {
      session_id: sessionId
    }, 5000)
  }

  async startDockerExec(sessionId: string, containerId: string): Promise<{ execSessionId: string }> {
    const result = await this.request<{ execSessionId: string }>('docker.exec.start', {
      session_id: sessionId,
      container_id: containerId
    }, 10000)
    // Register the exec session so ssh:write and ssh:resize route correctly
    this.activeSshSessions.add(result.execSessionId)
    return result
  }

  async startDockerLogStream(params: RustDockerLogStreamParams): Promise<{ streamId: string }> {
    return this.request('docker.logs.start', {
      session_id: params.sessionId,
      container_id: params.containerId,
      tail: params.tail
    }, 10000)
  }

  async stopDockerLogStream(streamId: string): Promise<void> {
    await this.request('docker.logs.stop', {
      rule_id: streamId
    }, 5000)
  }

  async connectSsh(config: RustSshConnectConfig): Promise<{ sessionId: string }> {
    const result = await this.request<{ sessionId: string }>('ssh.connect', {
      session_id: config.sessionId,
      host: config.host,
      port: config.port,
      username: config.username,
      auth_type: config.authType,
      password: config.password,
      private_key_path: config.privateKeyPath,
      passphrase: config.passphrase,
      ai_compatibility_mode: config.aiCompatibilityMode ?? false
    }, 15000)
    this.knownSshSessions.add(result.sessionId)
    this.activeSshSessions.add(result.sessionId)
    return result
  }

  async disconnectSsh(sessionId: string): Promise<void> {
    try {
      await this.request('ssh.disconnect', { session_id: sessionId }, 5000)
    } finally {
      this.knownSshSessions.delete(sessionId)
      this.activeSshSessions.delete(sessionId)
      this.sessionShellClosed.delete(sessionId)
    }
  }

  async writeSsh(sessionId: string, data: string): Promise<void> {
    await this.request('ssh.write', { session_id: sessionId, data }, 5000)
  }

  async resizeSsh(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request('ssh.resize', { session_id: sessionId, cols, rows }, 5000)
  }

  hasSshSession(sessionId: string): boolean {
    return this.activeSshSessions.has(sessionId) && !this.sessionShellClosed.has(sessionId)
  }

  hasManagedSshSession(sessionId: string): boolean {
    return this.knownSshSessions.has(sessionId)
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activeSshSessions).filter((sessionId) => !this.sessionShellClosed.has(sessionId))
  }

  getVersion(): string | null {
    return this.readyVersion
  }

  private async request<T>(method: string, params: unknown, timeoutMs: number = 5000): Promise<T> {
    await this.ensureProcess()

    const processRef = this.process
    if (!processRef) {
      throw new Error('Rust core process not available')
    }

    const id = `req-${this.nextRequestId++}`
    const payload = this.encodeFrame({ id, method, params })
    const paramSummary = this.summarizeParams(params)

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          const error = new Error(`Rust core request timed out: ${method} (id=${id}, timeout=${timeoutMs}ms, activeSessions=${this.getActiveSessionIds().length}, params=${paramSummary})`)
          console.warn('[rust-core] request timeout', {
            id,
            method,
            timeoutMs,
            activeSessions: this.getActiveSessionIds().length,
            params: paramSummary
          })
          reject(error)
        }, timeoutMs)
      }

      this.pending.set(id, { resolve, reject, timer: timer as NodeJS.Timeout })
      processRef.stdin.write(payload, (error) => {
        if (error) {
          if (timer) clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  private async ensureProcess(): Promise<void> {
    if (!this.process || this.process.killed) {
      await this.start()
    }
  }

  private handleStdout(chunk: string | Buffer): void {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8')
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bufferChunk])

    while (this.stdoutBuffer.length >= 4) {
      const frameLength = this.stdoutBuffer.readUInt32BE(0)
      if (this.stdoutBuffer.length < 4 + frameLength) break

      const payload = this.stdoutBuffer.subarray(4, 4 + frameLength)
      this.stdoutBuffer = this.stdoutBuffer.subarray(4 + frameLength)

      try {
        const message = JSON.parse(payload.toString('utf8')) as RustCoreResponse | RustCoreEvent
        this.handleMessage(message)
      } catch (error) {
        console.warn('[rust-core] failed to parse framed stdout payload', error)
      }
    }
  }

  private encodeFrame(payload: unknown): Buffer {
    const json = Buffer.from(JSON.stringify(payload), 'utf8')
    const frame = Buffer.allocUnsafe(4 + json.length)
    frame.writeUInt32BE(json.length, 0)
    json.copy(frame, 4)
    return frame
  }

  private summarizeParams(params: unknown): string {
    if (!params || typeof params !== 'object') return String(params)
    const obj = params as Record<string, unknown>
    const picked: Record<string, unknown> = {}
    for (const key of ['session_id', 'path', 'offset', 'max_bytes', 'command', 'cwd', 'rule_id', 'container_id']) {
      if (key in obj) {
        let value = obj[key]
        if (typeof value === 'string' && value.length > 120) {
          value = `${value.slice(0, 117)}...`
        }
        picked[key] = value
      }
    }
    try {
      return JSON.stringify(picked)
    } catch {
      return '[unserializable params]'
    }
  }

  private handleMessage(message: RustCoreResponse | RustCoreEvent): void {
    if (message.type === 'event') {
      this.handleEvent(message)
      return
    }

    const id = message.id
    if (!id) return

    const pending = this.pending.get(id)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(id)

    if (message.success) {
      pending.resolve(message.result)
    } else {
      pending.reject(new Error(message.error?.message || 'Rust core request failed'))
    }
  }

  private handleEvent(message: RustCoreEvent): void {
    if ('version' in message && typeof message.version === 'string') {
      this.readyVersion = message.version
      return
    }

    if ('level' in message && message.level && 'message' in message && message.message) {
      console.log(`[rust-core][${message.level}] ${message.message}`)
      return
    }

    if ('container_id' in message && 'data' in message) {
      this.broadcast('docker:logs', message.container_id, message.data)
      return
    }

    if ('rule_id' in message && 'status' in message) {
      this.broadcast('portForward:status', message.rule_id, message.status)
      return
    }

    if ('transfer_id' in message && 'transferred' in message && 'total' in message) {
      this.broadcast('sftp:progress', message.transfer_id, message.transferred, message.total, '')
      return
    }

    if ('data' in message) {
      this.broadcast('ssh:data', message.session_id, message.data)
      return
    }

    if ('session_id' in message && !('error' in message)) {
      if ('version' in message || 'level' in message || 'container_id' in message || 'rule_id' in message || 'data' in message) {
        return
      }

      if ((message as { type?: string }).type === 'event' && !this.activeSshSessions.has(message.session_id)) {
        this.broadcast('ssh:close', message.session_id)
        return
      }
    }

    if ('error' in message) {
      if ('session_id' in message) {
        this.knownSshSessions.delete(message.session_id)
        this.activeSshSessions.delete(message.session_id)
        this.sessionShellClosed.add(message.session_id)
      }
      this.broadcast('ssh:error', message.session_id, message.error)
      this.broadcast('ssh:close', message.session_id)
      return
    }

    if ('session_id' in message) {
      this.sessionShellClosed.add(message.session_id)
      this.activeSshSessions.delete(message.session_id)
      this.broadcast('ssh:close', message.session_id)
    }
  }

  private broadcast(channel: string, ...args: any[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, ...args)
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private resolveLaunchConfig(): LaunchConfig {
    const exeName = process.platform === 'win32' ? 'nutshell-core.exe' : 'nutshell-core'

    if (app.isPackaged) {
      const packagedDir = join(process.resourcesPath, 'native', 'nutshell-core')
      const packagedExe = join(packagedDir, exeName)
      if (existsSync(packagedExe)) {
        return {
          command: packagedExe,
          args: [],
          cwd: packagedDir,
          readyTimeoutMs: 8000,
          source: 'packaged executable'
        }
      }
    }

    const crateDir = join(app.getAppPath(), 'native', 'nutshell-core')

    const debugExe = join(crateDir, 'target', 'debug', exeName)
    if (existsSync(debugExe)) {
      return {
        command: debugExe,
        args: [],
        cwd: crateDir,
        readyTimeoutMs: 8000,
        source: 'debug executable'
      }
    }

    const releaseExe = join(crateDir, 'target', 'release', exeName)
    if (existsSync(releaseExe)) {
      return {
        command: releaseExe,
        args: [],
        cwd: crateDir,
        readyTimeoutMs: 8000,
        source: 'release executable'
      }
    }

    return {
      command: 'cargo',
      args: ['run', '--quiet'],
      cwd: crateDir,
      readyTimeoutMs: 60000,
      source: 'cargo run fallback'
    }
  }
}

export const rustCoreService = new RustCoreService()
