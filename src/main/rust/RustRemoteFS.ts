import { BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { rustCoreService } from './RustCoreService'

// sshManager and configStore are require()'d lazily in downloadDirViaTar to avoid circular imports

const BINARY_CHUNK_SIZE = 1024 * 1024
const TEXT_FILE_LIMIT = 10 * 1024 * 1024
const DOWNLOAD_CHUNK_RETRY_COUNT = 3
const DOWNLOAD_CHUNK_RETRY_BASE_DELAY_MS = 800
const UPLOAD_CHUNK_RETRY_COUNT = 3
const UPLOAD_CHUNK_RETRY_BASE_DELAY_MS = 800

export interface RustRemoteFileInfo {
  filename: string
  longname: string
  attrs: {
    mode: number
    uid: number
    gid: number
    size: number
    atime: number
    mtime: number
  }
  isDirectory: boolean
  isSymlink: boolean
  permissions: string
  size?: number
  mtime?: number
}

function sanitizeRemotePath(remotePath: string): string {
  const normalized = path.posix.normalize(remotePath)
  if (normalized.includes('\0')) {
    throw new Error('Invalid path: contains null bytes')
  }
  return normalized
}

function basename(remotePath: string): string {
  return path.posix.basename(remotePath)
}

function modeToLongname(mode: number, size: number, mtime: number, filename: string, isDirectory: boolean): string {
  const typeChar = isDirectory ? 'd' : '-'
  const perms = modeToPermissions(mode)
  const dt = new Date(mtime * 1000)
  const yyyy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  const hh = String(dt.getHours()).padStart(2, '0')
  const mi = String(dt.getMinutes()).padStart(2, '0')
  return `${typeChar}${perms} 1 0 0 ${size} ${yyyy}-${mm}-${dd} ${hh}:${mi} ${filename}`
}

function modeToPermissions(mode: number): string {
  const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']
  const owner = perms[(mode >> 6) & 7]
  const group = perms[(mode >> 3) & 7]
  const others = perms[mode & 7]
  return `${owner}${group}${others}`
}

class RustRemoteFS {
  private activeTransfers = new Map<string, { abort: () => void }>()
  private skipFileSets = new Map<string, Set<number>>()
  private lastProgressTime = new Map<string, number>()
  private pendingProgress = new Map<string, { transferred: number; total: number; currentFile?: string }>()

  async list(sessionId: string, remotePath: string): Promise<RustRemoteFileInfo[]> {
    const safePath = sanitizeRemotePath(remotePath)
    const result = await rustCoreService.listDir({ sessionId, path: safePath })

    return (result.entries || []).map((entry: any) => {
      const filename = entry.name || path.posix.basename(entry.path || '')
      const modeValue = typeof entry.mode === 'string' ? parseInt(entry.mode, 8) : Number(entry.mode || 0)
      const size = Number(entry.size || 0)
      const mtime = Number(entry.mtime || 0)
      const isDirectory = entry.isDir === true
      return {
        filename,
        longname: modeToLongname(modeValue, size, mtime, filename, isDirectory),
        attrs: {
          mode: isDirectory ? (0o040000 | modeValue) : (0o100000 | modeValue),
          uid: 0,
          gid: 0,
          size,
          atime: mtime,
          mtime
        },
        isDirectory,
        isSymlink: false,
        permissions: modeToPermissions(modeValue),
        size,
        mtime
      }
    })
  }

  async upload(sessionId: string, localPath: string, remotePath: string, transferId?: string, resumeOffset: number = 0): Promise<void> {
    const safePath = sanitizeRemotePath(remotePath)

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file not found: ${localPath}`)
    }

    const stat = fs.statSync(localPath)
    if (stat.isDirectory()) {
      throw new Error('暂不支持直接上传文件夹，请选择文件而不是文件夹')
    }

    const id = transferId || `${Date.now()}`

    return new Promise((resolve, reject) => {
      let cancelled = false
      this.activeTransfers.set(id, {
        abort: () => {
          cancelled = true
          rustCoreService.cancelNativeTransfer({ sessionId, transferId: id }).catch(() => {})
        }
      })

      // We rely on RustCoreService to emit sftp:nativeProgress which we could intercept,
      // but for simplicity we rely on the promise resolution.
      rustCoreService
        .nativeUpload({
          sessionId,
          transferId: id,
          localPath,
          remotePath: safePath
        })
        .then((res) => {
          this.activeTransfers.delete(id)
          if (!res.success) reject(new Error('Native upload failed'))
          else resolve()
        })
        .catch((err) => {
          this.activeTransfers.delete(id)
          reject(err)
        })
    })
  }

  async download(sessionId: string, remotePath: string, localPath: string, transferId?: string, resumeOffset: number = 0): Promise<void> {
    const safePath = sanitizeRemotePath(remotePath)
    const id = transferId || `${Date.now()}`

    return new Promise((resolve, reject) => {
      let cancelled = false
      this.activeTransfers.set(id, {
        abort: () => {
          cancelled = true
          rustCoreService.cancelNativeTransfer({ sessionId, transferId: id }).catch(() => {})
        }
      })

      rustCoreService
        .nativeDownload({
          sessionId,
          transferId: id,
          localPath,
          remotePath: safePath
        })
        .then((res) => {
          this.activeTransfers.delete(id)
          if (!res.success) reject(new Error('Native download failed'))
          else resolve()
        })
        .catch((err) => {
          this.activeTransfers.delete(id)
          reject(err)
        })
    })
  }

  private async readBinaryChunkWithRetry(sessionId: string, remotePath: string, offset: number): Promise<{ contentBase64: string; size: number; bytesRead: number; eof: boolean }> {
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= DOWNLOAD_CHUNK_RETRY_COUNT; attempt += 1) {
      try {
        return await rustCoreService.readBinaryFile({
          sessionId,
          path: remotePath,
          offset,
          maxBytes: BINARY_CHUNK_SIZE
        })
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(error?.message || String(error))
        console.warn('[rust-transfer] readBinaryFile attempt failed', {
          sessionId,
          remotePath,
          offset,
          chunkSize: BINARY_CHUNK_SIZE,
          attempt,
          maxAttempts: DOWNLOAD_CHUNK_RETRY_COUNT,
          error: lastError.message
        })
        if (attempt < DOWNLOAD_CHUNK_RETRY_COUNT) {
          const delayMs = DOWNLOAD_CHUNK_RETRY_BASE_DELAY_MS * attempt
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }

    throw lastError || new Error('Failed to read binary chunk')
  }

  private async writeBinaryChunkWithRetry(sessionId: string, remotePath: string, buffer: Buffer, append: boolean): Promise<void> {
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= UPLOAD_CHUNK_RETRY_COUNT; attempt += 1) {
      try {
        await rustCoreService.writeBinaryFile({
          sessionId,
          path: remotePath,
          contentBase64: buffer.toString('base64'),
          append,
          createDirs: true
        })
        return
      } catch (error: any) {
        lastError = error instanceof Error ? error : new Error(error?.message || String(error))
        console.warn('[rust-transfer] writeBinaryFile attempt failed', {
          sessionId,
          remotePath,
          chunkSize: buffer.length,
          append,
          attempt,
          maxAttempts: UPLOAD_CHUNK_RETRY_COUNT,
          error: lastError.message
        })
        if (attempt < UPLOAD_CHUNK_RETRY_COUNT) {
          const delayMs = UPLOAD_CHUNK_RETRY_BASE_DELAY_MS * attempt
          await new Promise((resolve) => setTimeout(resolve, delayMs))
        }
      }
    }

    throw lastError || new Error('Failed to write binary chunk')
  }

  async downloadDir(sessionId: string, remotePath: string, localPath: string, transferId?: string): Promise<void> {
    const safePath = sanitizeRemotePath(remotePath)
    const id = transferId || `${Date.now()}`

    await fs.promises.mkdir(localPath, { recursive: true })

    // Try tar-based download first — avoids slow recursive scan + per-file SFTP entirely
    try {
      await this.downloadDirViaTar(sessionId, safePath, localPath, id)
      return
    } catch (err: any) {
      console.warn(`[RustRemoteFS] Tar-based download failed, falling back to per-file: ${err?.message}`)
    }

    // Fallback: scan and download per-file
    const fileList: { remote: string; local: string; size: number }[] = []
    await this.scanRemoteDir(sessionId, safePath, localPath, fileList, 0)

    const totalSize = fileList.reduce((sum, file) => sum + file.size, 0)
    let totalTransferred = 0
    let cancelled = false

    const subFileList = fileList.map((file, index) => ({
      index,
      filename: path.basename(file.remote),
      remotePath: file.remote,
      size: file.size,
      status: 'queued' as string
    }))
    this.broadcast('sftp:dirFileList', id, subFileList)

    this.skipFileSets.set(id, new Set())
    this.activeTransfers.set(id, {
      abort: () => {
        cancelled = true
        this.activeTransfers.delete(id)
        this.skipFileSets.delete(id)
      }
    })

    this.notifyProgress(id, 0, totalSize)

    for (let fileIdx = 0; fileIdx < fileList.length; fileIdx += 1) {
      const file = fileList[fileIdx]
      if (cancelled || !this.activeTransfers.has(id)) {
        this.skipFileSets.delete(id)
        throw new Error('Transfer cancelled')
      }

      const skipSet = this.skipFileSets.get(id)
      if (skipSet?.has(fileIdx)) {
        totalTransferred += file.size
        this.broadcast('sftp:fileStatus', id, fileIdx, 'skipped')
        this.notifyProgress(id, totalTransferred, totalSize, path.basename(file.remote))
        continue
      }

      this.broadcast('sftp:fileStatus', id, fileIdx, 'active')
      await fs.promises.mkdir(path.dirname(file.local), { recursive: true })
      await this.download(sessionId, file.remote, file.local, `${id}:${fileIdx}`)
      totalTransferred += file.size
      this.notifyProgress(id, totalTransferred, totalSize, path.basename(file.remote))
      this.broadcast('sftp:fileStatus', id, fileIdx, 'completed')
    }

    this.activeTransfers.delete(id)
    this.skipFileSets.delete(id)
  }

  /**
   * Download directory via: remote `tar cf` → ssh2 SFTP fastGet → local `tar xf`.
   * No gzip = instant packing. Creates a temporary ssh2 connection for fast SFTP transfer.
   */
  private async downloadDirViaTar(
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId: string
  ): Promise<void> {
    const parentDir = path.posix.dirname(remotePath)
    const dirName = path.posix.basename(remotePath)
    const tempName = `.nutshell-dl-${transferId}-${Date.now()}`
    const tempTarRemote = `/tmp/${tempName}.tar`
    const tempTarLocal = path.join(os.tmpdir(), `${tempName}.tar`)
    let cancelled = false

    this.activeTransfers.set(transferId, {
      abort: () => {
        cancelled = true
        this.activeTransfers.delete(transferId)
      }
    })

    const cleanup = async () => {
      try { fs.unlinkSync(tempTarLocal) } catch { /* ignore */ }
      try {
        await rustCoreService.runCommand({
          sessionId,
          command: `rm -f '${tempTarRemote}'`,
          timeoutMs: 10000,
          requireConfirmation: false
        })
      } catch { /* ignore */ }
    }

    try {
      // Step 1: tar cf (NO gzip — packing is near-instant)
      this.notifyProgress(transferId, 0, 100, '远端打包中...')
      console.log(`[RustRemoteFS] Tar-packing remote directory (no gzip): ${remotePath}`)
      const escapedParent = parentDir.replace(/'/g, "'\\''")
      const escapedDir = dirName.replace(/'/g, "'\\''")
      const tarResult = await rustCoreService.runCommand({
        sessionId,
        command: `tar cf '${tempTarRemote}' -C '${escapedParent}' '${escapedDir}' && echo __TAR_OK__`,
        timeoutMs: 600000,
        requireConfirmation: false
      })
      if (!tarResult.stdout.includes('__TAR_OK__')) {
        throw new Error(`Remote tar failed: ${tarResult.stderr || tarResult.stdout}`.slice(0, 200))
      }

      if (cancelled) throw new Error('Transfer cancelled')

      // Step 2: Get tar size
      const statResult = await rustCoreService.statPath({ sessionId, path: tempTarRemote })
      const tarSize = Number(statResult.size || 0)
      console.log(`[RustRemoteFS] Tar ready: ${tarSize} bytes`)

      if (cancelled) throw new Error('Transfer cancelled')

      // Step 3: Download tar via a temporary ssh2 connection (fast SFTP)
      this.notifyProgress(transferId, 0, tarSize, '下载中...')
      const tempSessionId = await this.createTempSsh2Session(sessionId)
      const { sshManager: sm } = require('../ssh/SSHManager')

      try {
        const tempClient = sm.getClient(tempSessionId)
        if (!tempClient) throw new Error('Temporary ssh2 client not available')

        const sftp = await new Promise<any>((resolve, reject) => {
          tempClient.sftp((err: any, sftpSession: any) => {
            if (err) reject(err)
            else resolve(sftpSession)
          })
        })

        await new Promise<void>((resolve, reject) => {
          sftp.fastGet(tempTarRemote, tempTarLocal, {
            concurrency: 32,
            chunkSize: 256 * 1024,
            step: (transferred: number, _chunk: number, total: number) => {
              if (!cancelled && this.activeTransfers.has(transferId)) {
                this.notifyProgress(transferId, transferred, total, '下载中...')
              }
            }
          }, (err: any) => {
            try { sftp.end() } catch { /* ignore */ }
            if (err) reject(err)
            else resolve()
          })
        })
      } finally {
        sm.disconnect(tempSessionId).catch(() => {})
      }

      if (cancelled) throw new Error('Transfer cancelled')

      // Step 4: Extract locally
      this.notifyProgress(transferId, tarSize, tarSize, '本地解压中...')
      const extractDir = path.dirname(localPath)
      await fs.promises.mkdir(extractDir, { recursive: true })

      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['xf', tempTarLocal, '-C', extractDir], { maxBuffer: 10 * 1024 * 1024 }, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      this.activeTransfers.delete(transferId)
      console.log(`[RustRemoteFS] Tar-based directory download complete: ${remotePath} -> ${localPath}`)
    } catch (err) {
      this.activeTransfers.delete(transferId)
      await cleanup()
      throw err
    }

    await cleanup()
  }

  /**
   * Create a temporary ssh2 connection via sshManager, returns the sessionId.
   * Caller must call sshManager.disconnect(tempId) when done.
   */
  private async createTempSsh2Session(sessionId: string): Promise<string> {
    // Lazy import to avoid circular dep at module load time
    const { configStore } = require('../store/ConfigStore')
    const { sshManager } = require('../ssh/SSHManager')

    const connectionId = sessionId.replace(/^rust-/, '')
    const connections = configStore.getConnections()
    const connConfig = connections.find((c: any) => c.id === connectionId)
    if (!connConfig) {
      throw new Error('Connection config not found')
    }

    const tempId = `tmp-sftp-${Date.now()}`
    await sshManager.connect({
      id: tempId,
      host: connConfig.host,
      port: connConfig.port || 22,
      username: connConfig.username,
      authType: connConfig.authType,
      password: connConfig.password,
      privateKeyPath: connConfig.privateKeyPath,
      passphrase: connConfig.passphrase
    })
    return tempId
  }

  async uploadDir(sessionId: string, localPath: string, remotePath: string, transferId?: string): Promise<void> {
    const safePath = sanitizeRemotePath(remotePath)
    const id = transferId || `${Date.now()}`
    const fileList: { local: string; remote: string; size: number }[] = []
    this.scanLocalDir(localPath, safePath, fileList, 0)

    const totalSize = fileList.reduce((sum, file) => sum + file.size, 0)
    let totalTransferred = 0
    let cancelled = false

    const subFileList = fileList.map((file, index) => ({
      index,
      filename: path.basename(file.local),
      remotePath: file.remote,
      size: file.size,
      status: 'queued' as string
    }))
    this.broadcast('sftp:dirFileList', id, subFileList)

    this.skipFileSets.set(id, new Set())
    this.activeTransfers.set(id, {
      abort: () => {
        cancelled = true
        this.activeTransfers.delete(id)
        this.skipFileSets.delete(id)
      }
    })

    await rustCoreService.mkdir({ sessionId, path: safePath, recursive: true })
    this.notifyProgress(id, 0, totalSize)

    for (let fileIdx = 0; fileIdx < fileList.length; fileIdx += 1) {
      const file = fileList[fileIdx]
      if (cancelled || !this.activeTransfers.has(id)) {
        this.skipFileSets.delete(id)
        throw new Error('Transfer cancelled')
      }

      const skipSet = this.skipFileSets.get(id)
      if (skipSet?.has(fileIdx)) {
        totalTransferred += file.size
        this.broadcast('sftp:fileStatus', id, fileIdx, 'skipped')
        this.notifyProgress(id, totalTransferred, totalSize, path.basename(file.local))
        continue
      }

      this.broadcast('sftp:fileStatus', id, fileIdx, 'active')
      await rustCoreService.mkdir({ sessionId, path: path.posix.dirname(file.remote), recursive: true })
      await this.upload(sessionId, file.local, file.remote, `${id}:${fileIdx}`)
      totalTransferred += file.size
      this.notifyProgress(id, totalTransferred, totalSize, path.basename(file.local))
      this.broadcast('sftp:fileStatus', id, fileIdx, 'completed')
    }

    this.activeTransfers.delete(id)
    this.skipFileSets.delete(id)
  }

  async mkdir(sessionId: string, remotePath: string): Promise<void> {
    await rustCoreService.mkdir({ sessionId, path: sanitizeRemotePath(remotePath), recursive: false })
  }

  async deleteFile(sessionId: string, remotePath: string): Promise<void> {
    const safePath = sanitizeRemotePath(remotePath)
    const stats = await this.stat(sessionId, safePath)
    const isDirectory = (stats.mode & 0o170000) === 0o040000
    await rustCoreService.removePath({ sessionId, path: safePath, recursive: isDirectory })
  }

  async rename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
    await rustCoreService.movePath({
      sessionId,
      fromPath: sanitizeRemotePath(oldPath),
      toPath: sanitizeRemotePath(newPath)
    })
  }

  async readFile(sessionId: string, remotePath: string): Promise<string> {
    const safePath = sanitizeRemotePath(remotePath)
    const stats = await this.stat(sessionId, safePath)
    if (stats.size > TEXT_FILE_LIMIT) {
      throw new Error(`File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max: ${TEXT_FILE_LIMIT / 1024 / 1024}MB`)
    }

    const result = await rustCoreService.readFile({
      sessionId,
      path: safePath,
      maxBytes: TEXT_FILE_LIMIT
    })
    return result.content
  }

  async writeFile(sessionId: string, remotePath: string, content: string): Promise<void> {
    await rustCoreService.writeFile({
      sessionId,
      path: sanitizeRemotePath(remotePath),
      content,
      createDirs: true
    })
  }

  async stat(sessionId: string, remotePath: string): Promise<{ mode: number; size: number; atime: number; mtime: number }> {
    const result = await rustCoreService.statPath({ sessionId, path: sanitizeRemotePath(remotePath) })
    if (!result?.exists) {
      throw new Error(`Path not found: ${remotePath}`)
    }
    const modeValue = typeof result.mode === 'string' ? parseInt(result.mode, 8) : Number(result.mode || 0)
    let fileType = 0o100000
    if (result.isDir) fileType = 0o040000
    else if (result.isSymlink) fileType = 0o120000
    return {
      mode: fileType | modeValue,
      size: Number(result.size || 0),
      atime: Number(result.mtime || 0),
      mtime: Number(result.mtime || 0)
    }
  }

  async chmod(sessionId: string, remotePath: string, mode: string): Promise<void> {
    const safeMode = String(mode).trim()
    if (!/^[0-7]{3,4}$/.test(safeMode)) {
      throw new Error('Invalid chmod mode')
    }
    await rustCoreService.chmodPath({
      sessionId,
      path: sanitizeRemotePath(remotePath),
      mode: safeMode
    })
  }

  async listLocal(localPath: string): Promise<any[]> {
    if (!fs.existsSync(localPath)) {
      throw new Error('Directory not found')
    }

    const items = fs.readdirSync(localPath, { withFileTypes: true })
    return items
      .filter((item) => !item.name.startsWith('.'))
      .map((item) => {
        const fullPath = path.join(localPath, item.name)
        try {
          const stat = fs.statSync(fullPath)
          return {
            filename: item.name,
            isDirectory: item.isDirectory(),
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs / 1000),
            path: fullPath
          }
        } catch {
          return {
            filename: item.name,
            isDirectory: false,
            size: 0,
            mtime: 0,
            path: fullPath
          }
        }
      })
      .sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.filename.localeCompare(b.filename)
      })
  }

  async statLocal(localPath: string): Promise<{ exists: boolean; isDirectory: boolean; size: number }> {
    if (!fs.existsSync(localPath)) {
      return { exists: false, isDirectory: false, size: 0 }
    }
    const stat = fs.statSync(localPath)
    return {
      exists: true,
      isDirectory: stat.isDirectory(),
      size: stat.size
    }
  }

  getHomeDir(): string {
    return os.homedir()
  }

  async getRemoteHomeDir(sessionId: string): Promise<string> {
    try {
      const homeStats = await this.stat(sessionId, '/home')
      if ((homeStats.mode & 0o170000) === 0o040000) {
        const entries = await this.list(sessionId, '/home')
        const userDir = entries.find((entry) => entry.isDirectory)
        if (userDir) {
          return `/home/${userDir.filename}`
        }
        return '/home'
      }
    } catch {
      // fall through
    }

    try {
      const rootStats = await this.stat(sessionId, '/')
      if ((rootStats.mode & 0o170000) === 0o040000) {
        return '/'
      }
    } catch {
      // ignore
    }

    return '/'
  }

  cancelTransfer(transferId: string): boolean {
    const transfer = this.activeTransfers.get(transferId)
    if (transfer) {
      transfer.abort()
      return true
    }
    return false
  }

  skipFile(transferId: string, fileIndex: number): boolean {
    const skipSet = this.skipFileSets.get(transferId)
    if (skipSet) {
      skipSet.add(fileIndex)
      return true
    }
    return false
  }

  async getRemoteFileSize(sessionId: string, remotePath: string): Promise<number> {
    try {
      const stats = await this.stat(sessionId, remotePath)
      return stats.size
    } catch {
      return 0
    }
  }

  closeSFTP(_sessionId: string): void {
    // No persistent channel to close for Rust-backed file operations.
  }

  private async scanRemoteDir(
    sessionId: string,
    remotePath: string,
    localPath: string,
    result: { remote: string; local: string; size: number }[],
    depth: number
  ): Promise<void> {
    if (depth > 50) throw new Error('Directory nesting too deep')

    const items = await this.list(sessionId, remotePath)
    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') continue
      const remoteChild = remotePath === '/' ? `/${item.filename}` : `${remotePath}/${item.filename}`
      const localChild = path.join(localPath, item.filename)
      if (item.isDirectory) {
        await this.scanRemoteDir(sessionId, remoteChild, localChild, result, depth + 1)
      } else {
        result.push({ remote: remoteChild, local: localChild, size: item.size || 0 })
      }
    }
  }

  private scanLocalDir(localPath: string, remotePath: string, result: { local: string; remote: string; size: number }[], depth: number): void {
    if (depth > 50) throw new Error('Directory nesting too deep')
    const items = fs.readdirSync(localPath, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.')) continue
      const localChild = path.join(localPath, item.name)
      const remoteChild = `${remotePath}/${item.name}`
      if (item.isSymbolicLink()) continue
      if (item.isDirectory()) {
        this.scanLocalDir(localChild, remoteChild, result, depth + 1)
      } else {
        try {
          const stat = fs.statSync(localChild)
          result.push({ local: localChild, remote: remoteChild, size: stat.size })
        } catch {
          // Skip unreadable files.
        }
      }
    }
  }

  private broadcast(channel: string, ...args: any[]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, ...args)
    }
  }

  private notifyProgress(id: string, transferred: number, total: number, currentFile?: string): void {
    const now = Date.now()
    const last = this.lastProgressTime.get(id) || 0
    const isComplete = transferred >= total

    if (!isComplete && now - last < 200) {
      this.pendingProgress.set(id, { transferred, total, currentFile })
      if (!this.lastProgressTime.has(id + '_timer')) {
        this.lastProgressTime.set(id + '_timer', 1)
        setTimeout(() => {
          this.lastProgressTime.delete(id + '_timer')
          const pending = this.pendingProgress.get(id)
          if (pending) {
            this.pendingProgress.delete(id)
            this.notifyProgress(id, pending.transferred, pending.total, pending.currentFile)
          }
        }, 200)
      }
      return
    }

    this.lastProgressTime.set(id, now)
    this.pendingProgress.delete(id)
    this.broadcast('sftp:progress', id, transferred, total, currentFile)
  }
}

export const rustRemoteFS = new RustRemoteFS()
