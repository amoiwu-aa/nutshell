import { SFTPWrapper } from 'ssh2'
import { BrowserWindow } from 'electron'
import { sshManager } from './SSHManager'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'

const MAX_READ_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const INACTIVITY_TIMEOUT_MS = 60 * 1000 // 60 seconds no data = timeout
const TAR_DOWNLOAD_THRESHOLD = 30 // Use tar-based download when dir has more than this many files

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
  private skipFileSets: Map<string, Set<number>> = new Map()

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

  /**
   * Create a standalone SFTP session (not cached) for parallel workers.
   * Caller is responsible for closing it when done.
   */
  private async createWorkerSFTP(sessionId: string): Promise<SFTPWrapper> {
    const client = sshManager.getClient(sessionId)
    if (!client) throw new Error('SSH session not found')
    return new Promise((resolve, reject) => {
      client.sftp((err, sftpSession) => {
        if (err) reject(err)
        else resolve(sftpSession)
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
    resumeOffset: number = 0
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)

    if (!fs.existsSync(localPath)) {
      throw new Error(`Local file not found: ${localPath}`)
    }

    const stat = fs.statSync(localPath)
    if (stat.isDirectory()) {
      throw new Error('暂不支持直接上传文件夹，请选择文件而不是文件夹')
    }

    const totalSize = stat.size
    const id = transferId || `${Date.now()}`

    const sftp = await this.getFreshSFTP(sessionId)

    return new Promise((resolve, reject) => {
      let settled = false
      let lastActivity = Date.now()
      let transferred = Math.max(0, Math.min(resumeOffset, totalSize))

      let inactivityCheck: NodeJS.Timeout | null = null

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        if (inactivityCheck) clearInterval(inactivityCheck)
        this.activeTransfers.delete(id)
        this._lastProgressTime.delete(id)
        this._lastProgressTime.delete(id + '_timer')
        this._pendingProgress.delete(id)
        if (err) reject(err)
        else resolve()
      }

      this.activeTransfers.set(id, {
        abort: () => {
          finish(new Error('Transfer cancelled'))
        }
      })

      inactivityCheck = setInterval(() => {
        if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
          finish(new Error('Upload timed out (no data sent for 60s)'))
        }
      }, 10000)

      if (transferred === 0) {
        // Use fastPut for fast concurrent uploads if starting from beginning
        sftp.fastPut(localPath, safePath, {
          concurrency: 32,
          chunkSize: 64 * 1024,
          step: (transferredBytes: number, _chunk: number, total: number) => {
            lastActivity = Date.now()
            if (this.activeTransfers.has(id)) {
              this.notifyProgress(id, transferredBytes, total, path.basename(localPath))
            }
          }
        }, (err) => {
          if (err) {
            if (this.activeTransfers.has(id)) finish(err)
          } else {
            console.log(`[SFTP] Upload success: ${localPath} -> ${safePath} (${totalSize} bytes)`)
            if (this.activeTransfers.has(id)) {
              this.notifyProgress(id, totalSize, totalSize, path.basename(localPath))
            }
            finish()
          }
        })
      } else {
        // Fallback to sequential stream for resuming uploads
        const readStream = fs.createReadStream(localPath, {
          start: transferred,
          highWaterMark: 256 * 1024
        })
        const writeStream = sftp.createWriteStream(safePath, {
          flags: transferred > 0 ? 'a' : 'w'
        } as any)

        this.activeTransfers.set(id, {
          ...this.activeTransfers.get(id)!,
          abort: () => {
            try { readStream.destroy() } catch { /* ignore */ }
            try { writeStream.destroy() } catch { /* ignore */ }
            finish(new Error('Transfer cancelled'))
          }
        })

        readStream.on('data', (chunk: string | Buffer) => {
          lastActivity = Date.now()
          const chunkLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
          transferred = Math.min(totalSize, transferred + chunkLength)
          if (this.activeTransfers.has(id)) {
            this.notifyProgress(id, transferred, totalSize, path.basename(localPath))
          }
        })

        readStream.on('error', (err: any) => {
          try { writeStream.destroy() } catch { /* ignore */ }
          finish(err instanceof Error ? err : new Error(err?.message || String(err)))
        })

        writeStream.on('error', (err: any) => {
          try { readStream.destroy() } catch { /* ignore */ }
          finish(err instanceof Error ? err : new Error(err?.message || String(err)))
        })

        writeStream.on('drain', () => {
          lastActivity = Date.now()
        })

        const handleUploadDone = () => {
          if (settled) return
          console.log(`[SFTP] Resumed upload success: ${localPath} -> ${safePath} (${totalSize} bytes)`)
          if (this.activeTransfers.has(id)) {
            this.notifyProgress(id, totalSize, totalSize, path.basename(localPath))
          }
          finish()
        }

        writeStream.on('finish', handleUploadDone)
        writeStream.on('close', handleUploadDone)

        if (transferred >= totalSize) {
          writeStream.end()
          return
        }

        readStream.pipe(writeStream)
      }
    })
  }

  async download(
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId?: string,
    resumeOffset: number = 0
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)
    const sftp = await this.getFreshSFTP(sessionId)
    const id = transferId || `${Date.now()}`

    const stats = await this.stat(sessionId, safePath)
    const totalSize = stats.size
    let transferred = Math.max(0, Math.min(resumeOffset, totalSize))

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

      if (transferred > 0) {
        this.notifyProgress(id, transferred, totalSize, path.basename(safePath))
      }

      if (transferred === 0) {
        sftp.fastGet(safePath, localPath, {
          concurrency: 32,
          chunkSize: 64 * 1024,
          step: (transferredBytes: number, _chunk: number, total: number) => {
            lastActivity = Date.now()
            if (this.activeTransfers.has(id)) {
              this.notifyProgress(id, transferredBytes, total, path.basename(safePath))
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
        return
      }

      const readStream = sftp.createReadStream(safePath, {
        start: transferred,
        highWaterMark: 256 * 1024
      } as any)
      const writeStream = fs.createWriteStream(localPath, {
        flags: 'a'
      })

      this.activeTransfers.set(id, {
        ...this.activeTransfers.get(id)!,
        abort: () => {
          try { readStream.destroy() } catch { /* ignore */ }
          try { writeStream.destroy() } catch { /* ignore */ }
          finish(new Error('Transfer cancelled'))
        }
      })

      readStream.on('data', (chunk: Buffer | string) => {
        lastActivity = Date.now()
        const chunkLength = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
        transferred = Math.min(totalSize, transferred + chunkLength)
        if (this.activeTransfers.has(id)) {
          this.notifyProgress(id, transferred, totalSize, path.basename(safePath))
        }
      })

      readStream.on('error', (err: any) => {
        try { writeStream.destroy() } catch { /* ignore */ }
        finish(err instanceof Error ? err : new Error(err?.message || String(err)))
      })

      writeStream.on('error', (err: any) => {
        try { readStream.destroy() } catch { /* ignore */ }
        finish(err instanceof Error ? err : new Error(err?.message || String(err)))
      })

      writeStream.on('drain', () => {
        lastActivity = Date.now()
      })

      const handleDownloadDone = () => {
        if (settled) return
        console.log(`[SFTP] Resumed download success: ${safePath} -> ${localPath} (${totalSize} bytes)`)
        if (this.activeTransfers.has(id)) {
          this.notifyProgress(id, totalSize, totalSize, path.basename(safePath))
        }
        finish()
      }

      writeStream.on('finish', handleDownloadDone)
      writeStream.on('close', handleDownloadDone)

      if (transferred >= totalSize) {
        writeStream.end()
        return
      }

      readStream.pipe(writeStream)
    })
  }

  async downloadDir(
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId?: string
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)
    const id = transferId || `${Date.now()}`

    // Always create the target directory (even if remote dir is empty)
    if (!fs.existsSync(localPath)) {
      fs.mkdirSync(localPath, { recursive: true })
    }

    // Try tar-based download FIRST — avoids the slow recursive SFTP scan entirely
    try {
      await this.downloadDirViaTar(sessionId, safePath, localPath, id, 0)
      return
    } catch (err: any) {
      console.warn(`[SFTP] Tar-based download failed, falling back to per-file: ${err?.message}`)
      // Fall through to scan + per-file download
    }

    // Fallback: scan and download per-file
    const scanSftp = await this.getFreshSFTP(sessionId)
    const fileList: { remote: string; local: string; size: number }[] = []
    await this._scanDir(scanSftp, safePath, localPath, fileList, 0)

    const totalSize = fileList.reduce((sum, f) => sum + f.size, 0)

    console.log(`[SFTP] Downloading directory (per-file fallback): ${safePath} -> ${localPath} (${fileList.length} files, ${totalSize} bytes)`)

    let cancelled = false

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

    // Initialize skip set for this transfer
    this.skipFileSets.set(id, new Set())

    this.activeTransfers.set(id, {
      abort: () => {
        cancelled = true
        this.activeTransfers.delete(id)
        this.skipFileSets.delete(id)
      }
    })

    this.notifyProgress(id, 0, totalSize)

    // Pre-create all needed local directories upfront
    const localDirs = new Set<string>()
    for (const file of fileList) {
      localDirs.add(path.dirname(file.local))
    }
    for (const dir of localDirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }

    const MAX_RETRIES = 3
    const CONCURRENT_FILES = 4
    let nextIdx = 0
    let firstError: Error | null = null

    // Per-file progress tracking for accurate concurrent progress
    const fileProgress = new Array<number>(fileList.length).fill(0)
    const getTotal = () => fileProgress.reduce((sum, b) => sum + b, 0)

    // Create dedicated SFTP sessions for each worker
    const workerSessions: SFTPWrapper[] = []
    try {
      for (let i = 0; i < Math.min(CONCURRENT_FILES, fileList.length); i++) {
        const workerSftp = await this.createWorkerSFTP(sessionId)
        workerSessions.push(workerSftp)
      }
    } catch (err) {
      // Close any sessions we managed to create
      for (const s of workerSessions) {
        try { s.end() } catch { /* ignore */ }
      }
      throw err
    }

    const downloadOne = async (workerSftp: SFTPWrapper): Promise<void> => {
      while (nextIdx < fileList.length) {
        if (cancelled || !this.activeTransfers.has(id)) return
        if (firstError) return

        const fileIdx = nextIdx++
        const file = fileList[fileIdx]

        // Check if this file was skipped by the user
        const skipSet = this.skipFileSets.get(id)
        if (skipSet && skipSet.has(fileIdx)) {
          fileProgress[fileIdx] = file.size
          this.notifyFileStatus(id, fileIdx, 'skipped')
          this.notifyProgress(id, getTotal(), totalSize, path.basename(file.remote))
          continue
        }

        this.notifyFileStatus(id, fileIdx, 'active')

        // Download file with retry
        let lastErr: Error | null = null
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          if (cancelled || !this.activeTransfers.has(id) || firstError) return

          try {
            await new Promise<void>((resolve, reject) => {
              let lastActivity = Date.now()
              const inactivityTimer = setInterval(() => {
                if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
                  clearInterval(inactivityTimer)
                  reject(new Error(`File download timed out: ${file.remote}`))
                }
              }, 10000)

              workerSftp.fastGet(file.remote, file.local, {
                concurrency: 8,
                chunkSize: 64 * 1024,
                step: (transferred: number, _chunk: number, _total: number) => {
                  lastActivity = Date.now()
                  fileProgress[fileIdx] = transferred
                  if (this.activeTransfers.has(id)) {
                    this.notifyProgress(id, getTotal(), totalSize, path.basename(file.remote))
                  }
                }
              }, (err) => {
                clearInterval(inactivityTimer)
                if (err) reject(err)
                else resolve()
              })
            })
            lastErr = null
            break
          } catch (err: any) {
            lastErr = err
            if (cancelled || !this.activeTransfers.has(id) || firstError) return
            console.warn(`[SFTP] File download failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${file.remote} — ${err?.message}`)
            if (attempt < MAX_RETRIES - 1) {
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
            }
          }
        }

        if (lastErr) {
          this.notifyFileStatus(id, fileIdx, 'failed')
          firstError = lastErr
          return
        }

        fileProgress[fileIdx] = file.size
        this.notifyProgress(id, getTotal(), totalSize, path.basename(file.remote))
        this.notifyFileStatus(id, fileIdx, 'completed')
      }
    }

    // Launch concurrent download workers, each with its own SFTP session
    const workers = workerSessions.map((ws) => downloadOne(ws))
    await Promise.all(workers)

    // Close worker SFTP sessions
    for (const s of workerSessions) {
      try { s.end() } catch { /* ignore */ }
    }

    this.activeTransfers.delete(id)
    this.skipFileSets.delete(id)

    if (firstError) {
      throw firstError
    }

    if (cancelled) {
      throw new Error('Transfer cancelled')
    }

    console.log(`[SFTP] Directory download complete: ${safePath} -> ${localPath}`)
  }

  /**
   * Download a directory by tar-packing on the remote, downloading the single tar.gz,
   * and extracting locally. Orders of magnitude faster for many small files.
   * No upfront scan needed — completely bypasses the slow recursive SFTP readdir.
   */
  private async downloadDirViaTar(
    sessionId: string,
    remotePath: string,
    localPath: string,
    transferId: string,
    _estimatedSize: number
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
        await sshManager.exec(sessionId, `rm -f '${tempTarRemote}'`, 10000)
      } catch { /* ignore */ }
    }

    try {
      // Step 1: Create tar.gz on remote (skip scan entirely)
      this.notifyProgress(transferId, 0, 100, '远端打包中...')
      console.log(`[SFTP] Tar-packing remote directory: ${remotePath}`)
      const escapedParent = parentDir.replace(/'/g, "'\\''")
      const escapedDir = dirName.replace(/'/g, "'\\''")
      const tarCmd = `tar cf '${tempTarRemote}' -C '${escapedParent}' '${escapedDir}' 2>&1 && echo __TAR_OK__`
      const tarResult = await sshManager.exec(sessionId, tarCmd, 600000)
      if (!tarResult.includes('__TAR_OK__')) {
        throw new Error(`Remote tar failed: ${tarResult.slice(0, 200)}`)
      }

      if (cancelled) throw new Error('Transfer cancelled')

      // Step 2: Get the tar.gz size — this IS the transfer size (accurate progress)
      const sftp = await this.getFreshSFTP(sessionId)
      const tarStats = await this.stat(sessionId, tempTarRemote)
      const tarSize = tarStats.size
      console.log(`[SFTP] Tar.gz ready: ${tarSize} bytes`)

      if (cancelled) throw new Error('Transfer cancelled')

      // Step 3: Download single tar.gz via SFTP fastGet (full speed, one file)
      await new Promise<void>((resolve, reject) => {
        let lastActivity = Date.now()
        const inactivityTimer = setInterval(() => {
          if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
            clearInterval(inactivityTimer)
            reject(new Error('Tar download timed out'))
          }
        }, 10000)

        sftp.fastGet(tempTarRemote, tempTarLocal, {
          concurrency: 32,
          chunkSize: 64 * 1024,
          step: (transferred: number, _chunk: number, total: number) => {
            lastActivity = Date.now()
            if (!cancelled && this.activeTransfers.has(transferId)) {
              this.notifyProgress(transferId, transferred, total, '下载中...')
            }
          }
        }, (err) => {
          clearInterval(inactivityTimer)
          if (err) reject(err)
          else resolve()
        })
      })

      if (cancelled) throw new Error('Transfer cancelled')

      // Step 4: Extract locally
      this.notifyProgress(transferId, tarSize, tarSize, '本地解压中...')
      const extractDir = path.dirname(localPath)
      if (!fs.existsSync(extractDir)) {
        fs.mkdirSync(extractDir, { recursive: true })
      }

      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['xf', tempTarLocal, '-C', extractDir], { maxBuffer: 10 * 1024 * 1024 }, (err) => {
          if (err) reject(err)
          else resolve()
        })
      })

      this.activeTransfers.delete(transferId)
      console.log(`[SFTP] Tar-based directory download complete: ${remotePath} -> ${localPath}`)
    } catch (err) {
      this.activeTransfers.delete(transferId)
      await cleanup()
      throw err
    }

    await cleanup()
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

  async uploadDir(
    sessionId: string,
    localPath: string,
    remotePath: string,
    transferId?: string
  ): Promise<void> {
    const safePath = sanitizePath(remotePath)
    const id = transferId || `${Date.now()}`

    // Scan local directory tree
    const fileList: { local: string; remote: string; size: number }[] = []
    this._scanLocalDir(localPath, safePath, fileList, 0)

    const totalSize = fileList.reduce((sum, f) => sum + f.size, 0)
    let cancelled = false

    console.log(`[SFTP] Uploading directory: ${localPath} -> ${safePath} (${fileList.length} files, ${totalSize} bytes)`)

    // Send file list to frontend
    const subFileList = fileList.map((f, idx) => ({
      index: idx,
      filename: path.basename(f.local),
      remotePath: f.remote,
      size: f.size,
      status: 'queued' as string
    }))
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sftp:dirFileList', id, subFileList)
    }

    this.skipFileSets.set(id, new Set())

    this.activeTransfers.set(id, {
      abort: () => {
        cancelled = true
        this.activeTransfers.delete(id)
        this.skipFileSets.delete(id)
      }
    })

    this.notifyProgress(id, 0, totalSize)

    // Collect all remote directories that need to be created
    const remoteDirs = new Set<string>()
    for (const file of fileList) {
      const dir = path.posix.dirname(file.remote)
      if (dir !== safePath) {
        // Add all parent directories
        let cur = dir
        while (cur !== safePath && cur !== '/' && cur !== '.') {
          remoteDirs.add(cur)
          cur = path.posix.dirname(cur)
        }
      }
    }

    // Create remote directories (sorted by depth so parents come first)
    const sortedDirs = Array.from(remoteDirs).sort((a, b) => a.split('/').length - b.split('/').length)
    let sftp = await this.getFreshSFTP(sessionId)
    for (const dir of [safePath, ...sortedDirs]) {
      try {
        await new Promise<void>((resolve, reject) => {
          sftp.mkdir(dir, (err) => {
            if (err && (err as any).code !== 4) reject(err) // code 4 = already exists
            else resolve()
          })
        })
      } catch {
        // Directory might already exist
      }
    }

    const MAX_RETRIES = 3
    const CONCURRENT_FILES = 4
    let nextIdx = 0
    let firstError: Error | null = null

    // Per-file progress tracking for accurate concurrent progress
    const fileProgress = new Array<number>(fileList.length).fill(0)
    const getTotal = () => fileProgress.reduce((sum, b) => sum + b, 0)

    // Create dedicated SFTP sessions for each worker
    const workerSessions: SFTPWrapper[] = []
    try {
      for (let i = 0; i < Math.min(CONCURRENT_FILES, fileList.length); i++) {
        const workerSftp = await this.createWorkerSFTP(sessionId)
        workerSessions.push(workerSftp)
      }
    } catch (err) {
      for (const s of workerSessions) {
        try { s.end() } catch { /* ignore */ }
      }
      throw err
    }

    const uploadOne = async (workerSftp: SFTPWrapper): Promise<void> => {
      while (nextIdx < fileList.length) {
        if (cancelled || !this.activeTransfers.has(id)) return
        if (firstError) return

        const fileIdx = nextIdx++
        const file = fileList[fileIdx]

        const skipSet = this.skipFileSets.get(id)
        if (skipSet && skipSet.has(fileIdx)) {
          fileProgress[fileIdx] = file.size
          this.notifyFileStatus(id, fileIdx, 'skipped')
          this.notifyProgress(id, getTotal(), totalSize, path.basename(file.local))
          continue
        }

        this.notifyFileStatus(id, fileIdx, 'active')

        let lastErr: Error | null = null
        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
          if (cancelled || !this.activeTransfers.has(id) || firstError) return

          try {
            await new Promise<void>((resolve, reject) => {
              let lastActivity = Date.now()
              const inactivityTimer = setInterval(() => {
                if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
                  clearInterval(inactivityTimer)
                  reject(new Error(`File upload timed out: ${file.local}`))
                }
              }, 10000)

              const readStream = fs.createReadStream(file.local, { highWaterMark: 256 * 1024 })
              const writeStream = workerSftp.createWriteStream(file.remote, { flags: 'w' } as any)

              let fileTransferred = 0

              readStream.on('data', (chunk: string | Buffer) => {
                lastActivity = Date.now()
                const chunkLen = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk)
                fileTransferred = Math.min(file.size, fileTransferred + chunkLen)
                fileProgress[fileIdx] = fileTransferred
                if (this.activeTransfers.has(id)) {
                  this.notifyProgress(id, getTotal(), totalSize, path.basename(file.local))
                }
              })

              readStream.on('error', (err) => {
                clearInterval(inactivityTimer)
                try { writeStream.destroy() } catch { /* ignore */ }
                reject(err)
              })

              writeStream.on('error', (err: any) => {
                clearInterval(inactivityTimer)
                try { readStream.destroy() } catch { /* ignore */ }
                reject(err)
              })

              const done = () => {
                clearInterval(inactivityTimer)
                resolve()
              }
              writeStream.on('finish', done)
              writeStream.on('close', done)

              readStream.pipe(writeStream)
            })
            lastErr = null
            break
          } catch (err: any) {
            lastErr = err
            if (cancelled || !this.activeTransfers.has(id) || firstError) return
            console.warn(`[SFTP] File upload failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${file.local} — ${err?.message}`)
            if (attempt < MAX_RETRIES - 1) {
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
            }
          }
        }

        if (lastErr) {
          this.notifyFileStatus(id, fileIdx, 'failed')
          firstError = lastErr
          return
        }

        fileProgress[fileIdx] = file.size
        this.notifyProgress(id, getTotal(), totalSize, path.basename(file.local))
        this.notifyFileStatus(id, fileIdx, 'completed')
      }
    }

    // Launch concurrent upload workers, each with its own SFTP session
    const workers = workerSessions.map((ws) => uploadOne(ws))
    await Promise.all(workers)

    // Close worker SFTP sessions
    for (const s of workerSessions) {
      try { s.end() } catch { /* ignore */ }
    }

    this.activeTransfers.delete(id)
    this.skipFileSets.delete(id)

    if (firstError) {
      throw firstError
    }

    if (cancelled) {
      throw new Error('Transfer cancelled')
    }

    console.log(`[SFTP] Directory upload complete: ${localPath} -> ${safePath}`)
  }

  private _scanLocalDir(
    localPath: string,
    remotePath: string,
    result: { local: string; remote: string; size: number }[],
    depth: number
  ): void {
    if (depth > 50) throw new Error('Directory nesting too deep')

    const items = fs.readdirSync(localPath, { withFileTypes: true })
    for (const item of items) {
      if (item.name.startsWith('.')) continue

      const localChild = path.join(localPath, item.name)
      const remoteChild = `${remotePath}/${item.name}`

      if (item.isSymbolicLink()) continue

      if (item.isDirectory()) {
        this._scanLocalDir(localChild, remoteChild, result, depth + 1)
      } else {
        try {
          const stat = fs.statSync(localChild)
          result.push({ local: localChild, remote: remoteChild, size: stat.size })
        } catch {
          // Skip unreadable files
        }
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

  private _pendingFileStatuses: Map<string, { id: string; fileIdx: number; status: string }[]> = new Map()
  private _fileStatusTimer: NodeJS.Timeout | null = null

  private notifyFileStatus(id: string, fileIdx: number, status: string): void {
    const key = id
    if (!this._pendingFileStatuses.has(key)) {
      this._pendingFileStatuses.set(key, [])
    }
    this._pendingFileStatuses.get(key)!.push({ id, fileIdx, status })

    if (!this._fileStatusTimer) {
      this._fileStatusTimer = setTimeout(() => {
        this._fileStatusTimer = null
        for (const [, batch] of this._pendingFileStatuses) {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('sftp:fileStatusBatch', batch)
          }
        }
        this._pendingFileStatuses.clear()
      }, 100)
    }
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
