import { SFTPWrapper } from 'ssh2'
import { BrowserWindow } from 'electron'
import { sshManager } from './SSHManager'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const MAX_READ_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const INACTIVITY_TIMEOUT_MS = 60 * 1000 // 60 seconds no data = timeout

export interface RemoteFileInfo {
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

// --- Input validation ---
function sanitizePath(remotePath: string): string {
  // Normalize the path: resolve .. and .
  const normalized = path.posix.normalize(remotePath)
  // Block null bytes
  if (normalized.includes('\0')) {
    throw new Error('Invalid path: contains null bytes')
  }
  return normalized
}

class SFTPManager {
  private sftpSessions: Map<string, SFTPWrapper> = new Map()
  private sftpLocks: Map<string, Promise<SFTPWrapper>> = new Map()
  private activeTransfers: Map<string, { abort: () => void }> = new Map()

  private async getSFTP(sessionId: string): Promise<SFTPWrapper> {
    const existing = this.sftpSessions.get(sessionId)
    if (existing) return existing

    // Prevent concurrent SFTP session creation (race condition fix)
    const existingLock = this.sftpLocks.get(sessionId)
    if (existingLock) return existingLock

    const lockPromise = this._createSFTP(sessionId)
    this.sftpLocks.set(sessionId, lockPromise)

    try {
      const sftp = await lockPromise
      return sftp
    } finally {
      this.sftpLocks.delete(sessionId)
    }
  }

  private async _createSFTP(sessionId: string): Promise<SFTPWrapper> {
    const client = sshManager.getClient(sessionId)
    if (!client) throw new Error('SSH session not found')

    return new Promise((resolve, reject) => {
      client.sftp((err, sftpSession) => {
        if (err) {
          reject(err)
          return
        }
        this.sftpSessions.set(sessionId, sftpSession)
        resolve(sftpSession)
      })
    })
  }

  private async getFreshSFTP(sessionId: string): Promise<SFTPWrapper> {
    // Test if existing session is still alive
    const existing = this.sftpSessions.get(sessionId)
    if (existing) {
      try {
        await new Promise<void>((resolve, reject) => {
          existing.stat('.', (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        return existing
      } catch {
        // Stale session, remove and recreate
        console.log(`[SFTP] Stale session detected for ${sessionId}, recreating...`)
        this.sftpSessions.delete(sessionId)
      }
    }
    return this.getSFTP(sessionId)
  }

  async list(sessionId: string, remotePath: string): Promise<RemoteFileInfo[]> {
    const safePath = sanitizePath(remotePath)
    const sftp = await this.getSFTP(sessionId)

    return new Promise((resolve, reject) => {
      sftp.readdir(safePath, (err, list) => {
        if (err) {
          reject(err)
          return
        }

        const files: RemoteFileInfo[] = list.map((item) => ({
          filename: item.filename,
          longname: item.longname,
          attrs: {
            mode: item.attrs.mode!,
            uid: item.attrs.uid!,
            gid: item.attrs.gid!,
            size: item.attrs.size!,
            atime: item.attrs.atime!,
            mtime: item.attrs.mtime!
          },
          isDirectory: (item.attrs.mode! & 0o40000) !== 0,
          isSymlink: item.longname.startsWith('l'),
          permissions: this.modeToPermissions(item.attrs.mode!),
          size: item.attrs.size!,
          mtime: item.attrs.mtime!
        }))

        files.sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.filename.localeCompare(b.filename)
        })

        resolve(files)
      })
    })
  }

  async upload(
    sessionId: string,
    localPath: string,
    remotePath: string,
    transferId?: string
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file not found: ${localPath}`)
    }

    const stat = fs.statSync(localPath)
    const totalSize = stat.size
    const id = transferId || `${Date.now()}`

    const sftp = await this.getFreshSFTP(sessionId)

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        this.activeTransfers.delete(id)
        if (err) reject(err)
        else resolve()
      }

      this.activeTransfers.set(id, {
        abort: () => {
          finish(new Error('Transfer cancelled'))
        }
      })

      sftp.fastPut(localPath, safePath, {
        concurrency: 64, // 64 concurrent max-size requests
        chunkSize: 64 * 1024, // SSH2 max chunk is usually ~32-64k for protocol payload. Concurrency is key.
        step: (transferred: number, chunk: number, total: number) => {
          if (this.activeTransfers.has(id)) {
            this.notifyProgress(id, transferred, total, path.basename(localPath))
          }
        }
      }, (err) => {
        if (err) {
          if (this.activeTransfers.has(id)) {
            finish(err)
          }
        } else {
          console.log(`[SFTP] Upload success: ${localPath} -> ${safePath} (${totalSize} bytes)`)
          finish()
        }
      })
    })
  }

  async download(
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId?: string
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)
    const sftp = await this.getFreshSFTP(sessionId)
    const id = transferId || `${Date.now()}`

    const stats = await this.stat(sessionId, safePath)
    const totalSize = stats.size

    return new Promise((resolve, reject) => {
      let settled = false
      let lastActivity = Date.now()

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        clearInterval(inactivityCheck)
        this.activeTransfers.delete(id)
        if (err) reject(err)
        else resolve()
      }

      const inactivityCheck = setInterval(() => {
        if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
          finish(new Error('Download timed out (no data received for 60s)'))
        }
      }, 10000)

      this.activeTransfers.set(id, {
        abort: () => {
          finish(new Error('Transfer cancelled'))
        }
      })

      sftp.fastGet(safePath, localPath, {
        concurrency: 64, // 64 concurrent reads
        chunkSize: 64 * 1024,
        step: (transferred: number, chunk: number, total: number) => {
          lastActivity = Date.now()
          if (this.activeTransfers.has(id)) {
            this.notifyProgress(id, transferred, total, path.basename(safePath))
          }
        }
      }, (err) => {
        if (err) {
          if (this.activeTransfers.has(id)) {
            finish(err)
          }
        } else {
          console.log(`[SFTP] Download success: ${safePath} -> ${localPath} (${totalSize} bytes)`)
          finish()
        }
      })
    })
  }

  async downloadDir(
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId?: string
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)
    let sftp = await this.getFreshSFTP(sessionId)
    const id = transferId || `${Date.now()}`

    // First, scan the entire directory tree to get total size
    const fileList: { remote: string; local: string; size: number }[] = []
    await this._scanDir(sftp, safePath, localPath, fileList, 0)

    const totalSize = fileList.reduce((sum, f) => sum + f.size, 0)
    let totalTransferred = 0
    let cancelled = false

    // Always create the target directory (even if remote dir is empty)
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true })
    }

    console.log(`[SFTP] Downloading directory: ${safePath} -> ${localPath} (${fileList.length} files, ${totalSize} bytes)`)

    // Send file list to frontend so it can show sub-file details
    const subFileList = fileList.map((f, idx) => ({
      index: idx,
      filename: path.basename(f.remote),
      remotePath: f.remote,
      size: f.size,
      status: 'queued' as string
    }))
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sftp:dirFileList', id, subFileList)
    }

    this.activeTransfers.set(id, {
      abort: () => {
        cancelled = true
        this.activeTransfers.delete(id)
      }
    })

    this.notifyProgress(id, 0, totalSize)

    const MAX_RETRIES = 3

    for (let fileIdx = 0; fileIdx < fileList.length; fileIdx++) {
      const file = fileList[fileIdx]
      if (cancelled || !this.activeTransfers.has(id)) {
        throw new Error('Transfer cancelled')
      }

      // Notify frontend that this sub-file is now active
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('sftp:fileStatus', id, fileIdx, 'active')
      }

      // Ensure local directory exists
      const dir = path.dirname(file.local)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      // Download file with retry
      let lastErr: Error | null = null
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (cancelled || !this.activeTransfers.has(id)) {
          throw new Error('Transfer cancelled')
        }

        try {
          await new Promise<void>((resolve, reject) => {
            let lastActivity = Date.now()
            const inactivityTimer = setInterval(() => {
              if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
                clearInterval(inactivityTimer)
                reject(new Error(`File download timed out: ${file.remote}`))
              }
            }, 10000)

            sftp.fastGet(file.remote, file.local, {
              concurrency: 25,
              chunkSize: 64 * 1024,
              step: (transferred: number, _chunk: number, _total: number) => {
                lastActivity = Date.now()
                if (this.activeTransfers.has(id)) {
                  this.notifyProgress(id, totalTransferred + transferred, totalSize, path.basename(file.remote))
                }
              }
            }, (err) => {
              clearInterval(inactivityTimer)
              if (err) reject(err)
              else resolve()
            })
          })
          // Success — break out of retry loop
          lastErr = null
          break
        } catch (err: any) {
          lastErr = err
          if (cancelled || !this.activeTransfers.has(id)) {
            throw new Error('Transfer cancelled')
          }
          console.warn(`[SFTP] File download failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${file.remote} — ${err?.message}`)
          if (attempt < MAX_RETRIES - 1) {
            // Wait before retry with exponential backoff
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
            // Try to get a fresh SFTP session in case the channel died
            try {
              this.closeSFTP(sessionId)
              sftp = await this.getSFTP(sessionId)
            } catch {
              // If we can't get a new session, the next attempt will fail anyway
            }
          }
        }
      }

      if (lastErr) {
        // Notify this sub-file failed
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('sftp:fileStatus', id, fileIdx, 'failed')
        }
        this.activeTransfers.delete(id)
        throw lastErr
      }

      totalTransferred += file.size
      this.notifyProgress(id, totalTransferred, totalSize, path.basename(file.remote))

      // Notify this sub-file completed
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('sftp:fileStatus', id, fileIdx, 'completed')
      }
    }

    this.activeTransfers.delete(id)
    console.log(`[SFTP] Directory download complete: ${safePath} -> ${localPath}`)
  }

  private async _scanDir(
    sftp: SFTPWrapper,
    remotePath: string,
    localPath: string,
    result: { remote: string; local: string; size: number }[],
    depth: number
  ): Promise<void> {
    if (depth > 50) throw new Error('Directory nesting too deep')

    const items = await new Promise<any[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, list) => {
        if (err) reject(err)
        else resolve(list || [])
      })
    })

    for (const item of items) {
      if (item.filename === '.' || item.filename === '..') {
        continue
      }

      const remoteChild = `${remotePath}/${item.filename}`
      const localChild = path.join(localPath, item.filename)
      const isDir = (item.attrs.mode & 0o40000) !== 0
      const isSymlink = item.longname.startsWith('l') || (item.attrs.mode & 0o120000) === 0o120000

      if (isSymlink) {
        // Skip symlinks to avoid infinite loops and downloading directory symlinks as files
        continue
      }

      if (isDir) {
        await this._scanDir(sftp, remoteChild, localChild, result, depth + 1)
      } else {
        result.push({ remote: remoteChild, local: localChild, size: item.attrs.size || 0 })
      }
    }
  }

  async mkdir(sessionId: string, remotePath: string): Promise<void> {
    const safePath = sanitizePath(remotePath)
    const sftp = await this.getSFTP(sessionId)

    return new Promise((resolve, reject) => {
      sftp.mkdir(safePath, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async deleteFile(sessionId: string, remotePath: string): Promise<void> {
    const safePath = sanitizePath(remotePath)
    const sftp = await this.getSFTP(sessionId)
    const stats = await this.stat(sessionId, safePath)

    if ((stats.mode & 0o40000) !== 0) {
      await this.rmdirRecursive(sftp, safePath)
    } else {
      return new Promise((resolve, reject) => {
        sftp.unlink(safePath, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  }

  private async rmdirRecursive(sftp: SFTPWrapper, dirPath: string, depth: number = 0): Promise<void> {
    if (depth > 50) throw new Error('Directory nesting too deep')

    const items = await new Promise<any[]>((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) reject(err)
        else resolve(list)
      })
    })

    for (const item of items) {
      const fullPath = `${dirPath}/${item.filename}`
      if ((item.attrs.mode & 0o40000) !== 0) {
        await this.rmdirRecursive(sftp, fullPath, depth + 1)
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(fullPath, (err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      }
    }

    await new Promise<void>((resolve, reject) => {
      sftp.rmdir(dirPath, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async rename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
    const safeOld = sanitizePath(oldPath)
    const safeNew = sanitizePath(newPath)
    const sftp = await this.getSFTP(sessionId)

    return new Promise((resolve, reject) => {
      sftp.rename(safeOld, safeNew, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  async readFile(sessionId: string, remotePath: string): Promise<string> {
    const safePath = sanitizePath(remotePath)

    // Check file size before reading
    const stats = await this.stat(sessionId, safePath)
    if (stats.size > MAX_READ_FILE_SIZE) {
      throw new Error(`File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_READ_FILE_SIZE / 1024 / 1024}MB`)
    }

    const sftp = await this.getSFTP(sessionId)

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalRead = 0
      const readStream = sftp.createReadStream(safePath)

      const timer = setTimeout(() => {
        readStream.destroy()
        reject(new Error('Read file timed out'))
      }, 30000)

      readStream.on('data', (chunk: Buffer) => {
        totalRead += chunk.length
        if (totalRead > MAX_READ_FILE_SIZE) {
          readStream.destroy()
          clearTimeout(timer)
          reject(new Error('File exceeds size limit'))
          return
        }
        chunks.push(chunk)
      })

      readStream.on('error', (err: any) => {
        clearTimeout(timer)
        reject(err)
      })

      readStream.on('end', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks).toString('utf-8'))
      })
    })
  }

  async writeFile(sessionId: string, remotePath: string, content: string): Promise<void> {
    const safePath = sanitizePath(remotePath)
    const sftp = await this.getSFTP(sessionId)

    return new Promise((resolve, reject) => {
      const writeStream = sftp.createWriteStream(safePath)

      writeStream.on('error', reject)
      writeStream.on('close', () => resolve())

      writeStream.end(Buffer.from(content, 'utf-8'))
    })
  }

  async stat(
    sessionId: string,
    remotePath: string
  ): Promise<{ mode: number; size: number; atime: number; mtime: number }> {
    const safePath = sanitizePath(remotePath)
    const sftp = await this.getSFTP(sessionId)

    return new Promise((resolve, reject) => {
      sftp.stat(safePath, (err, stats) => {
        if (err) reject(err)
        else
          resolve({
            mode: stats.mode!,
            size: stats.size!,
            atime: stats.atime!,
            mtime: stats.mtime!
          })
      })
    })
  }

  async chmod(sessionId: string, remotePath: string, mode: string): Promise<void> {
    const safePath = sanitizePath(remotePath)
    // Validate mode is numeric
    if (!/^[0-7]{3,4}$/.test(mode)) {
      throw new Error('Invalid chmod mode')
    }
    const sftp = await this.getSFTP(sessionId)

    return new Promise((resolve, reject) => {
      sftp.chmod(safePath, parseInt(mode, 8), (err) => {
        if (err) reject(err)
        else resolve()
      })
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

  getHomeDir(): string {
    return os.homedir()
  }

  cancelTransfer(transferId: string): boolean {
    const transfer = this.activeTransfers.get(transferId)
    if (transfer) {
      transfer.abort()
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

  closeSFTP(sessionId: string): void {
    const sftp = this.sftpSessions.get(sessionId)
    if (sftp) {
      try { sftp.end() } catch { /* ignore */ }
      this.sftpSessions.delete(sessionId)
    }
    this.sftpLocks.delete(sessionId)
  }

  private modeToPermissions(mode: number): string {
    const perms = ['---', '--x', '-w-', '-wx', 'r--', 'r-x', 'rw-', 'rwx']
    const owner = perms[(mode >> 6) & 7]
    const group = perms[(mode >> 3) & 7]
    const others = perms[mode & 7]
    return `${owner}${group}${others}`
  }

  private _lastProgressTime: Map<string, number> = new Map()
  private _pendingProgress: Map<string, { transferred: number; total: number; currentFile?: string }> = new Map()

  private notifyProgress(id: string, transferred: number, total: number, currentFile?: string): void {
    const now = Date.now()
    const last = this._lastProgressTime.get(id) || 0
    const isComplete = transferred >= total

    if (!isComplete && now - last < 200) {
      // Throttle: queue this update, it will be sent on next allowed tick
      this._pendingProgress.set(id, { transferred, total, currentFile })
      if (!this._lastProgressTime.has(id + '_timer')) {
        this._lastProgressTime.set(id + '_timer', 1)
        setTimeout(() => {
          this._lastProgressTime.delete(id + '_timer')
          const pending = this._pendingProgress.get(id)
          if (pending) {
            this._pendingProgress.delete(id)
            this.notifyProgress(id, pending.transferred, pending.total, pending.currentFile)
          }
        }, 200)
      }
      return
    }

    this._lastProgressTime.set(id, now)
    this._pendingProgress.delete(id)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sftp:progress', id, transferred, total, currentFile)
    }
  }
}

export const sftpManager = new SFTPManager()
