import { ipcMain } from 'electron'
import { portForwardManager } from '../ssh/PortForward'
import { rustCoreService } from '../rust/RustCoreService'

export function registerPortForwardHandlers(): void {
  ipcMain.handle('portForward:create', async (_event, rule) => {
    try {
      if (rustCoreService.hasSshSession(rule.connectionId)) {
        await rustCoreService.createPortForward(rule)
        return { success: true }
      }
      await portForwardManager.createForward(rule)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('portForward:remove', async (_event, ruleId: string) => {
    try {
      await rustCoreService.removePortForward(ruleId).catch(() => {})
      portForwardManager.removeForward(ruleId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('portForward:list', async (_event, sessionId: string) => {
    try {
      if (rustCoreService.hasSshSession(sessionId)) {
        const result = await rustCoreService.listPortForwards(sessionId)
        return { success: true, rules: result.rules }
      }
      const rules = portForwardManager.listForwards(sessionId)
      return { success: true, rules }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })
}
