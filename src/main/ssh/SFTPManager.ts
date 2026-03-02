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
    transferId?: string,
    resumeOffset?: number
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file not found: ${localPath}`)
    }

    const stat = fs.statSync(localPath)
    const totalSize = stat.size
    const id = transferId || `${Date.now()}`
    const offset = resumeOffset || 0

    // Adaptive chunk size for large files
    const chunkSize = totalSize > 10 * 1024 * 1024 * 1024 ? 1024 * 1024
      : totalSize > 1024 * 1024 * 1024 ? 256 * 1024
        : 64 * 1024

    const sftp = await this.getFreshSFTP(sessionId)

    return new Promise((resolve, reject) => {
      let aborted = false
      let settled = false

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        this.activeTransfers.delete(id)
        if (err) reject(err)
        else resolve()
      }

      const readStream = fs.createReadStream(localPath, {
        start: offset,
        highWaterMark: chunkSize
      })
      const writeStream = sftp.createWriteStream(safePath, {
        flags: offset > 0 ? 'a' : 'w'
      })

      let transferred = offset

      this.activeTransfers.set(id, {
        abort: () => {
          aborted = true
          readStream.destroy()
          writeStream.destroy()
        }
      })

      readStream.on('data', (chunk: any) => {
        transferred += chunk.length
        this.notifyProgress(id, transferred, totalSize)
      })

      readStream.on('error', (err: any) => {
        writeStream.destroy()
        finish(aborted ? new Error('Transfer cancelled') : err as Error)
      })

      writeStream.on('error', (err: any) => {
        readStream.destroy()
        finish(aborted ? new Error('Transfer cancelled') : err as Error)
      })

      writeStream.on('close', () => {
        if (aborted) finish(new Error('Transfer cancelled'))
        else {
          console.log(`[SFTP] Upload success: ${localPath} -> ${safePath} (${totalSize} bytes)`)
          finish()
        }
      })

      readStream.pipe(writeStream)
    })
  }

  async download(
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId?: string,
    resumeOffset?: number
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)
    const sftp = await this.getFreshSFTP(sessionId)
    const id = transferId || `${Date.now()}`

    const stats = await this.stat(sessionId, safePath)
    const totalSize = stats.size
    const offset = resumeOffset || 0

    return new Promise((resolve, reject) => {
      let aborted = false
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
          readStream.destroy()
          finish(new Error('Download timed out (no data received for 60s)'))
        }
      }, 10000)

      const readStreamOpts: any = {}
      if (offset > 0) readStreamOpts.start = offset

      const readStream = sftp.createReadStream(safePath, readStreamOpts)
      const writeStream = fs.createWriteStream(localPath, {
        flags: offset > 0 ? 'r+' : 'w',
        start: offset > 0 ? offset : undefined
      })

      let transferred = offset

      this.activeTransfers.set(id, {
        abort: () => {
          aborted = true
          readStream.destroy()
          writeStream.destroy()
        }
      })

      readStream.on('data', (chunk: any) => {
        transferred += chunk.length
        lastActivity = Date.now()
        this.notifyProgress(id, transferred, totalSize)
      })

      readStream.on('error', (err: any) => {
        writeStream.destroy()
        finish(aborted ? new Error('Transfer cancelled') : err as Error)
      })

      writeStream.on('error', (err: any) => {
        readStream.destroy()
        finish(aborted ? new Error('Transfer cancelled') : err as Error)
      })

      writeStream.on('close', () => {
        if (aborted) finish(new Error('Transfer cancelled'))
        else {
          console.log(`[SFTP] Download success: ${safePath} -> ${localPath} (${totalSize} bytes)`)
          finish()
        }
      })

      readStream.pipe(writeStream)
    })
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

  private notifyProgress(id: string, transferred: number, total: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sftp:progress', id, transferred, total)
    }
  }
}

export const sftpManager = new SFTPManager()
