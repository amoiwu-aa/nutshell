import { ipcMain } from 'electron'
import { sftpManager } from '../ssh/SFTPManager'
import { sshManager } from '../ssh/SSHManager'

export function registerSFTPHandlers(): void {
  ipcMain.handle('sftp:list', async (_event, sessionId: string, remotePath: string) => {
    try {
      const files = await sftpManager.list(sessionId, remotePath)
      return { success: true, files }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'sftp:upload',
    async (_event, sessionId: string, localPath: string, remotePath: string) => {
      try {
        await sftpManager.upload(sessionId, localPath, remotePath)
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
        await sftpManager.download(sessionId, remotePath, localPath)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle('sftp:mkdir', async (_event, sessionId: string, remotePath: string) => {
    try {
      await sftpManager.mkdir(sessionId, remotePath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('sftp:delete', async (_event, sessionId: string, remotePath: string) => {
    try {
      await sftpManager.deleteFile(sessionId, remotePath)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'sftp:rename',
    async (_event, sessionId: string, oldPath: string, newPath: string) => {
      try {
        await sftpManager.rename(sessionId, oldPath, newPath)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle('sftp:readFile', async (_event, sessionId: string, remotePath: string) => {
    try {
      const content = await sftpManager.readFile(sessionId, remotePath)
      return { success: true, content }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'sftp:writeFile',
    async (_event, sessionId: string, remotePath: string, content: string) => {
      try {
        await sftpManager.writeFile(sessionId, remotePath, content)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle('sftp:stat', async (_event, sessionId: string, remotePath: string) => {
    try {
      const stat = await sftpManager.stat(sessionId, remotePath)
      return { success: true, stat }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'sftp:chmod',
    async (_event, sessionId: string, remotePath: string, mode: string) => {
      try {
        await sftpManager.chmod(sessionId, remotePath, mode)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Enhanced upload with transferId and resumeOffset
  ipcMain.handle(
    'sftp:uploadWithId',
    async (_event, sessionId: string, localPath: string, remotePath: string, transferId: string, resumeOffset?: number) => {
      try {
        await sftpManager.upload(sessionId, localPath, remotePath, transferId, resumeOffset)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Enhanced download with transferId and resumeOffset
  ipcMain.handle(
    'sftp:downloadWithId',
    async (_event, sessionId: string, remotePath: string, localPath: string, transferId: string, resumeOffset?: number) => {
      try {
        await sftpManager.download(sessionId, remotePath, localPath, transferId, resumeOffset)
        return { success: true }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Cancel a transfer
  ipcMain.handle('sftp:cancelTransfer', async (_event, transferId: string) => {
    const cancelled = sftpManager.cancelTransfer(transferId)
    return { success: cancelled }
  })

  // Get remote file size (for resume)
  ipcMain.handle('sftp:getRemoteFileSize', async (_event, sessionId: string, remotePath: string) => {
    try {
      const size = await sftpManager.getRemoteFileSize(sessionId, remotePath)
      return { success: true, size }
    } catch (error: any) {
      return { success: false, error: error.message, size: 0 }
    }
  })

  ipcMain.handle('sftp:listLocal', async (_event, localPath: string) => {
    try {
      const files = await sftpManager.listLocal(localPath)
      return { success: true, files }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('sftp:getHomeDir', async () => {
    return sftpManager.getHomeDir()
  })

  ipcMain.handle('sftp:getRemoteHomeDir', async (_event, sessionId: string) => {
    try {
      const home = await sshManager.getRemoteHomeDir(sessionId)
      return { success: true, home }
    } catch (error: any) {
      return { success: false, error: error.message, home: '/' }
    }
  })
}
