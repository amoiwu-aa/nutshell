import { ipcMain } from 'electron'
import { sshManager } from '../ssh/SSHManager'

export function registerSSHHandlers(): void {
  ipcMain.handle('ssh:connect', async (_event, config) => {
    try {
      const sessionId = await sshManager.connect(config)
      await sshManager.openShell(sessionId)
      return { success: true, sessionId }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('ssh:disconnect', async (_event, sessionId: string) => {
    try {
      await sshManager.disconnect(sessionId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.on('ssh:write', (_event, sessionId: string, data: string) => {
    sshManager.write(sessionId, data)
  })

  ipcMain.on('ssh:resize', (_event, sessionId: string, cols: number, rows: number) => {
    sshManager.resize(sessionId, cols, rows)
  })

  ipcMain.handle('ssh:runDiagnostics', async (_event, sessionId: string) => {
    try {
      const result = await sshManager.runTerminalDiagnostics(sessionId)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })
}
