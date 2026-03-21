import { ipcMain } from 'electron'
import { sshManager } from '../ssh/SSHManager'
import { configStore } from '../store/ConfigStore'
import { rustCoreService } from '../rust/RustCoreService'

export function registerSSHHandlers(): void {
  ipcMain.handle('ssh:connect', async (_event, config) => {
    try {
      const settings = configStore.getSettings()
      const useRustEngine = settings.useRustSshEngine === true

      if (useRustEngine && !config.jumpHost) {
        const sessionId = `rust-${config.id || crypto.randomUUID()}`
        await rustCoreService.connectSsh({
          sessionId,
          host: config.host,
          port: config.port,
          username: config.username,
          authType: config.authType,
          password: config.password,
          privateKeyPath: config.privateKeyPath,
          passphrase: config.passphrase,
          aiCompatibilityMode: config.aiCompatibilityMode
        })
        return { success: true, sessionId, engine: 'rust' }
      }

      const sessionId = await sshManager.connect(config)
      await sshManager.openShell(sessionId)
      return { success: true, sessionId, engine: 'node' }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('ssh:disconnect', async (_event, sessionId: string) => {
    try {
      const rustStatus = await rustCoreService.ping().then(() => true).catch(() => false)
      if (rustStatus) {
        await rustCoreService.disconnectSsh(sessionId).catch(() => {})
      }
      await sshManager.disconnect(sessionId).catch(() => {})
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.on('ssh:write', (_event, sessionId: string, data: string) => {
    if (sshManager.isConnected(sessionId)) {
      sshManager.write(sessionId, data)
      return
    }
    rustCoreService.writeSsh(sessionId, data).catch(() => {})
  })

  ipcMain.on('ssh:resize', (_event, sessionId: string, cols: number, rows: number) => {
    if (sshManager.isConnected(sessionId)) {
      sshManager.resize(sessionId, cols, rows)
      return
    }
    rustCoreService.resizeSsh(sessionId, cols, rows).catch(() => {})
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
