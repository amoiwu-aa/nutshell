import { ipcMain, dialog, BrowserWindow, app } from 'electron'
import path from 'path'
import { sftpManager } from '../ssh/SFTPManager'
import { sshManager } from '../ssh/SSHManager'
import { rustCoreService } from '../rust/RustCoreService'
import { rustRemoteFS } from '../rust/RustRemoteFS'

function getRemoteFs(sessionId: string) {
  return resolveRemoteSession(sessionId).usesRustFs ? rustRemoteFS : sftpManager
}

function resolveRemoteSession(sessionId: string): { remoteSessionId: string; usesRustFs: boolean } {
  if (rustCoreService.hasManagedSshSession(sessionId)) {
    return { remoteSessionId: sessionId, usesRustFs: true }
  }

  return { remoteSessionId: sessionId, usesRustFs: false }
}

export function registerSFTPHandlers(): void {
  ipcMain.handle('sftp:list', async (_event, sessionId: string, remotePath: string) => {
    try {
      const { remoteSessionId } = resolveRemoteSession(sessionId)
      const files = await getRemoteFs(sessionId).list(remoteSessionId, remotePath)
      return { success: true, files }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'sftp:upload',
    async (_event, sessionId: string, localPath: string, remotePath: string) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        await getRemoteFs(sessionId).upload(remoteSessionId, localPath, remotePath)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle(
    'sftp:download',
    async (_event, sessionId: string, remotePath: string, localPath: string) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        await getRemoteFs(sessionId).download(remoteSessionId, remotePath, localPath)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle('sftp:mkdir', async (_event, sessionId: string, remotePath: string) => {
    try {
      const { remoteSessionId } = resolveRemoteSession(sessionId)
      await getRemoteFs(sessionId).mkdir(remoteSessionId, remotePath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('sftp:delete', async (_event, sessionId: string, remotePath: string) => {
    try {
      const { remoteSessionId } = resolveRemoteSession(sessionId)
      await getRemoteFs(sessionId).deleteFile(remoteSessionId, remotePath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'sftp:rename',
    async (_event, sessionId: string, oldPath: string, newPath: string) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        await getRemoteFs(sessionId).rename(remoteSessionId, oldPath, newPath)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle('sftp:readFile', async (_event, sessionId: string, remotePath: string) => {
    try {
      const { remoteSessionId } = resolveRemoteSession(sessionId)
      const content = await getRemoteFs(sessionId).readFile(remoteSessionId, remotePath)
      return { success: true, content }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'sftp:writeFile',
    async (_event, sessionId: string, remotePath: string, content: string) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        await getRemoteFs(sessionId).writeFile(remoteSessionId, remotePath, content)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle('sftp:stat', async (_event, sessionId: string, remotePath: string) => {
    try {
      const { remoteSessionId } = resolveRemoteSession(sessionId)
      const stat = await getRemoteFs(sessionId).stat(remoteSessionId, remotePath)
      return { success: true, stat }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'sftp:chmod',
    async (_event, sessionId: string, remotePath: string, mode: string) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        await getRemoteFs(sessionId).chmod(remoteSessionId, remotePath, mode)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Enhanced upload with transferId
  ipcMain.handle(
    'sftp:uploadWithId',
    async (_event, sessionId: string, localPath: string, remotePath: string, transferId: string, resumeOffset?: number) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        await getRemoteFs(sessionId).upload(remoteSessionId, localPath, remotePath, transferId, resumeOffset || 0)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Upload entire directory recursively
  ipcMain.handle(
    'sftp:uploadDir',
    async (_event, sessionId: string, localPath: string, remotePath: string, transferId: string) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        await getRemoteFs(sessionId).uploadDir(remoteSessionId, localPath, remotePath, transferId)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Enhanced download with transferId — auto-detects directories
  ipcMain.handle(
    'sftp:downloadWithId',
    async (_event, sessionId: string, remotePath: string, localPath: string, transferId: string, resumeOffset?: number) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        const remoteFs = getRemoteFs(sessionId)
        let dest = localPath
        // If localPath is empty, derive it from Downloads folder + remote filename
        if (!dest) {
          const downloadsDir = app.getPath('downloads')
          const fileName = path.posix.basename(remotePath)
          dest = path.join(downloadsDir, fileName)
        }

        // Check if remote path is a directory
        let isDir = false
        try {
          const stat = await remoteFs.stat(remoteSessionId, remotePath)
          // S_IFDIR = 0o040000 = 16384
          isDir = (stat.mode & 0o170000) === 0o040000
        } catch {
          // If stat fails, assume it's a file
        }

        if (isDir) {
          await remoteFs.downloadDir(remoteSessionId, remotePath, dest, transferId)
        } else {
          await remoteFs.download(remoteSessionId, remotePath, dest, transferId, resumeOffset || 0)
        }
        return { success: true, localPath: dest }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Download entire directory recursively
  ipcMain.handle(
    'sftp:downloadDir',
    async (_event, sessionId: string, remotePath: string, localPath: string, transferId: string) => {
      try {
        const { remoteSessionId } = resolveRemoteSession(sessionId)
        await getRemoteFs(sessionId).downloadDir(remoteSessionId, remotePath, localPath, transferId)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Cancel a transfer
  ipcMain.handle('sftp:cancelTransfer', async (_event, transferId: string) => {
    const cancelled = sftpManager.cancelTransfer(transferId) || rustRemoteFS.cancelTransfer(transferId)
    return { success: cancelled }
  })

  // Skip a sub-file in a directory transfer
  ipcMain.handle('sftp:skipFile', async (_event, transferId: string, fileIndex: number) => {
    const skipped = sftpManager.skipFile(transferId, fileIndex) || rustRemoteFS.skipFile(transferId, fileIndex)
    return { success: skipped }
  })

  // Get remote file size (for resume)
  ipcMain.handle('sftp:getRemoteFileSize', async (_event, sessionId: string, remotePath: string) => {
    try {
      const { remoteSessionId } = resolveRemoteSession(sessionId)
      const size = await getRemoteFs(sessionId).getRemoteFileSize(remoteSessionId, remotePath)
      return { success: true, size }
    } catch (error: any) {
      return { success: false, error: error.message, size: 0 }
    }
  })

  ipcMain.handle('sftp:listLocal', async (_event, localPath: string) => {
    try {
      const files = await rustRemoteFS.listLocal(localPath)
      return { success: true, files }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('sftp:statLocal', async (_event, localPath: string) => {
    try {
      const info = await rustRemoteFS.statLocal(localPath)
      return { success: true, ...info }
    } catch (error: any) {
      return { success: false, error: error.message, exists: false, isDirectory: false, size: 0 }
    }
  })

  ipcMain.handle('sftp:getHomeDir', async () => {
    return rustRemoteFS.getHomeDir()
  })

  ipcMain.handle('sftp:getRemoteHomeDir', async (_event, sessionId: string) => {
    try {
      const { remoteSessionId, usesRustFs } = resolveRemoteSession(sessionId)
      const home = usesRustFs
        ? await rustRemoteFS.getRemoteHomeDir(remoteSessionId)
        : await sshManager.getRemoteHomeDir(remoteSessionId)
      return { success: true, home }
    } catch (error: any) {
      return { success: false, error: error.message, home: '/' }
    }
  })

  // Select a directory via native OS dialog
  ipcMain.handle('sftp:selectDirectory', async (_event, title?: string) => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      title: title || '选择下载目录',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, canceled: true }
    }
    return { success: true, path: result.filePaths[0] }
  })
}
