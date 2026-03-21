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

type RustCoreEvent =
  | RustCoreReadyEvent
  | RustCoreLogEvent
  | RustCoreSshDataEvent
  | RustCoreSshCloseEvent
  | RustCoreSshErrorEvent

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

export interface RustReadMultipleFilesParams {
  sessionId: string
  paths: string[]
  maxBytesPerFile?: number
}

export interface RustProjectRootParams {
  sessionId: string
  rootPath: string
}

class RustCoreService {
  private process: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = Buffer.alloc(0)
  private nextRequestId = 1
  private pending = new Map<string, PendingRequest>()
  private readyVersion: string | null = null
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

    const { command, args, cwd } = this.resolveLaunchConfig()
    this.manuallyStopped = false
    this.stdoutBuffer = Buffer.alloc(0)

    this.process = spawn(command, args, {
      cwd,
      stdio: 'pipe',
      windowsHide: true
    })

    this.process.stdout.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    this.process.stderr.setEncoding('utf8')
    this.process.stderr.on('data', (chunk: string) => {
      console.warn('[rust-core][stderr]', chunk.trim())
    })
    this.process.on('exit', (code, signal) => {
      console.warn(`[rust-core] exited with code=${code} signal=${signal}`)
      this.process = null
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

    await this.waitForReady(8000)
    this.restartAttempts = 0
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const started = Date.now()

    while (Date.now() - started < timeoutMs) {
      if (!this.process || this.process.killed) {
        throw new Error('Rust core process exited before ready')
      }
      if (this.readyVersion) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    throw new Error('Rust core startup timed out while waiting for ready event')
  }

  async stop(): Promise<void> {
    this.manuallyStopped = true
    this.rejectAllPending(new Error('Rust core stopped'))
    if (this.process && !this.process.killed) {
      this.process.kill()
    }
    this.process = null
    this.readyVersion = null
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

  async connectSsh(config: RustSshConnectConfig): Promise<{ sessionId: string }> {
    return this.request('ssh.connect', {
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
  }

  async disconnectSsh(sessionId: string): Promise<void> {
    await this.request('ssh.disconnect', { session_id: sessionId }, 5000)
  }

  async writeSsh(sessionId: string, data: string): Promise<void> {
    await this.request('ssh.write', { session_id: sessionId, data }, 5000)
  }

  async resizeSsh(sessionId: string, cols: number, rows: number): Promise<void> {
    await this.request('ssh.resize', { session_id: sessionId, cols, rows }, 5000)
  }

  hasSshSession(sessionId: string): boolean {
    return sessionId.startsWith('rust-')
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

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Rust core request timed out: ${method}`))
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      processRef.stdin.write(payload, (error) => {
        if (error) {
          clearTimeout(timer)
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

    if ('data' in message) {
      this.broadcast('ssh:data', message.session_id, message.data)
      return
    }

    if ('error' in message) {
      this.broadcast('ssh:error', message.session_id, message.error)
      return
    }

    if ('session_id' in message) {
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

  private resolveLaunchConfig(): { command: string; args: string[]; cwd: string } {
    const exeName = process.platform === 'win32' ? 'nutshell-core.exe' : 'nutshell-core'

    if (app.isPackaged) {
      const packagedDir = join(process.resourcesPath, 'native', 'nutshell-core')
      const packagedExe = join(packagedDir, exeName)
      if (existsSync(packagedExe)) {
        return { command: packagedExe, args: [], cwd: packagedDir }
      }
    }

    const crateDir = join(app.getAppPath(), 'native', 'nutshell-core')

    const debugExe = join(crateDir, 'target', 'debug', exeName)
    if (existsSync(debugExe)) {
      return { command: debugExe, args: [], cwd: crateDir }
    }

    const releaseExe = join(crateDir, 'target', 'release', exeName)
    if (existsSync(releaseExe)) {
      return { command: releaseExe, args: [], cwd: crateDir }
    }

    return {
      command: 'cargo',
      args: ['run', '--quiet'],
      cwd: crateDir
    }
  }
}

export const rustCoreService = new RustCoreService()
