import { ipcMain } from 'electron'
import { rustCoreService } from '../rust/RustCoreService'

export function registerRustCoreHandlers(): void {
  ipcMain.handle('rustCore:status', async () => {
    try {
      const result = await rustCoreService.ping()
      return {
        success: true,
        status: 'ready',
        version: result.version,
        capabilities: result.capabilities
      }
    } catch (error: any) {
      return {
        success: false,
        status: 'error',
        error: error.message
      }
    }
  })

  ipcMain.handle('rustCore:migrationPlan', async () => {
    try {
      const result = await rustCoreService.getMigrationPlan()
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:aiBlueprint', async () => {
    try {
      const result = await rustCoreService.getAiRemoteBlueprint()
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:runCommand', async (_event, params) => {
    try {
      const result = await rustCoreService.runCommand(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:listDir', async (_event, params) => {
    try {
      const result = await rustCoreService.listDir(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:readFile', async (_event, params) => {
    try {
      const result = await rustCoreService.readFile(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:search', async (_event, params) => {
    try {
      const result = await rustCoreService.search(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:writeFile', async (_event, params) => {
    try {
      const result = await rustCoreService.writeFile(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:statPath', async (_event, params) => {
    try {
      const result = await rustCoreService.statPath(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:mkdir', async (_event, params) => {
    try {
      const result = await rustCoreService.mkdir(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:removePath', async (_event, params) => {
    try {
      const result = await rustCoreService.removePath(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:movePath', async (_event, params) => {
    try {
      const result = await rustCoreService.movePath(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:readMultipleFiles', async (_event, params) => {
    try {
      const result = await rustCoreService.readMultipleFiles(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:scanProject', async (_event, params) => {
    try {
      const result = await rustCoreService.scanProject(params)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('rustCore:projectSummary', async (_event, params) => {
    try {
      return await rustCoreService.projectSummary(params)
    } catch (error: any) {
      throw new Error(`Failed to get project summary via Rust core: ${error.message}`)
    }
  })

  ipcMain.handle('rustCore:nativeUpload', async (_event, params) => {
    try {
      return await rustCoreService.nativeUpload(params)
    } catch (error: any) {
      throw new Error(`Failed to perform native upload: ${error.message}`)
    }
  })

  ipcMain.handle('rustCore:nativeDownload', async (_event, params) => {
    try {
      return await rustCoreService.nativeDownload(params)
    } catch (error: any) {
      throw new Error(`Failed to perform native download: ${error.message}`)
    }
  })

  ipcMain.handle('rustCore:cancelNativeTransfer', async (_event, params) => {
    try {
      return await rustCoreService.cancelNativeTransfer(params)
    } catch (error: any) {
      throw new Error(`Failed to cancel native transfer: ${error.message}`)
    }
  })
}
