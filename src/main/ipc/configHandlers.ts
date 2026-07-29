import { ipcMain, dialog } from 'electron'
import { configStore } from '../store/ConfigStore'
import { knownHosts } from '../ssh/KnownHosts'

export function registerConfigHandlers(): void {
  ipcMain.handle('config:listHostKeys', async () => {
    try {
      return { success: true, hostKeys: knownHosts.list() }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:forgetHostKey', async (_event, host: string, port: number) => {
    try {
      knownHosts.forget(host, port)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:getConnections', async () => {
    try {
      return { success: true, connections: configStore.getConnections() }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:saveConnection', async (_event, connection) => {
    try {
      configStore.saveConnection(connection)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:deleteConnection', async (_event, id: string) => {
    try {
      configStore.deleteConnection(id)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:getSnippets', async () => {
    try {
      return { success: true, snippets: configStore.getSnippets() }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:saveSnippet', async (_event, snippet) => {
    try {
      configStore.saveSnippet(snippet)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:deleteSnippet', async (_event, id: string) => {
    try {
      configStore.deleteSnippet(id)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:getSettings', async () => {
    try {
      return { success: true, settings: configStore.getSettings() }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:saveSettings', async (_event, settings) => {
    try {
      configStore.saveSettings(settings)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:selectFile', async (_event, options) => {
    try {
      const result = await dialog.showOpenDialog({
        properties: options?.properties || ['openFile'],
        filters: options?.filters || [{ name: 'All Files', extensions: ['*'] }]
      })
      return { success: true, filePaths: result.filePaths, canceled: result.canceled }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:selectDirectory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory']
      })
      return { success: true, filePaths: result.filePaths, canceled: result.canceled }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:importSnippets', async (_event, snippets, mode) => {
    try {
      configStore.importSnippets(snippets, mode)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:getSessionState', async () => {
    try {
      return { success: true, state: configStore.getSessionState() }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('config:saveSessionState', async (_event, state) => {
    try {
      configStore.saveSessionState(state)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

}
