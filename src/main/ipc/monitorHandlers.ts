import { ipcMain } from 'electron'
import { serverMonitor } from '../monitor/ServerMonitor'

export function registerMonitorHandlers(): void {
  ipcMain.handle('monitor:start', async (_event, sessionId: string, interval?: number, modules?: any) => {
    try {
      await serverMonitor.start(sessionId, interval, modules)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('monitor:stop', async (_event, sessionId: string) => {
    try {
      serverMonitor.stop(sessionId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('monitor:updateModules', async (_event, sessionId: string, modules: any) => {
    try {
      serverMonitor.updateModules(sessionId, modules)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('monitor:getSystemInfo', async (_event, sessionId: string) => {
    try {
      const info = await serverMonitor.getSystemInfo(sessionId)
      return { success: true, info }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('monitor:getProcesses', async (_event, sessionId: string) => {
    try {
      const processes = await serverMonitor.getProcesses(sessionId)
      return { success: true, processes }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('monitor:getListeningPorts', async (_event, sessionId: string) => {
    try {
      const ports = await serverMonitor.getListeningPorts(sessionId)
      return { success: true, ports }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('monitor:killProcess', async (_event, sessionId: string, pid: number, signal?: number) => {
    try {
      const result = await serverMonitor.killProcess(sessionId, pid, signal || 9)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('monitor:killProcesses', async (_event, sessionId: string, pids: number[], signal?: number) => {
    try {
      const result = await serverMonitor.killProcesses(sessionId, pids, signal || 9)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })
}
