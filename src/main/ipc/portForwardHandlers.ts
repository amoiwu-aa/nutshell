import { ipcMain } from 'electron'
import { portForwardManager } from '../ssh/PortForward'

export function registerPortForwardHandlers(): void {
  ipcMain.handle('portForward:create', async (_event, rule) => {
    try {
      await portForwardManager.createForward(rule)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('portForward:remove', async (_event, ruleId: string) => {
    try {
      portForwardManager.removeForward(ruleId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('portForward:list', async (_event, sessionId: string) => {
    try {
      const rules = portForwardManager.listForwards(sessionId)
      return { success: true, rules }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })
}
