import { ipcMain } from 'electron'
import { lspManager } from '../lsp/LspManager'

export function registerLspHandlers(): void {
  // Start a language server
  ipcMain.handle('lsp:start', async (_event, sessionId: string, rootPath: string, language: string) => {
    try {
      return await lspManager.start(sessionId, rootPath, language)
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // Stop a language server
  ipcMain.handle('lsp:stop', async (_event, sessionId: string, language: string) => {
    try {
      await lspManager.stop(sessionId, language)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // Send LSP request (with response)
  ipcMain.handle('lsp:request', async (_event, sessionId: string, language: string, method: string, params: any) => {
    try {
      const result = await lspManager.request(sessionId, language, method, params)
      return { success: true, result }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // Send LSP notification (no response)
  ipcMain.handle('lsp:notify', async (_event, sessionId: string, language: string, method: string, params: any) => {
    try {
      lspManager.notify(sessionId, language, method, params)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // Check language server availability
  ipcMain.handle('lsp:checkAvailability', async (_event, sessionId: string, language: string) => {
    try {
      return { success: true, ...(await lspManager.checkAvailability(sessionId, language)) }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // Detect project servers
  ipcMain.handle('lsp:detectServers', async (_event, sessionId: string, rootPath: string) => {
    try {
      const servers = await lspManager.detectProjectServers(sessionId, rootPath)
      return { success: true, servers }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // Get running servers for a session
  ipcMain.handle('lsp:getRunning', async (_event, sessionId: string) => {
    try {
      return { success: true, servers: lspManager.getRunningServers(sessionId) }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // File sync notifications
  ipcMain.handle('lsp:didOpen', async (_event, sessionId: string, language: string, uri: string, languageId: string, version: number, text: string) => {
    try {
      lspManager.didOpen(sessionId, language, uri, languageId, version, text)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('lsp:didChange', async (_event, sessionId: string, language: string, uri: string, version: number, text: string) => {
    try {
      lspManager.didChange(sessionId, language, uri, version, text)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('lsp:didClose', async (_event, sessionId: string, language: string, uri: string) => {
    try {
      lspManager.didClose(sessionId, language, uri)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  ipcMain.handle('lsp:didSave', async (_event, sessionId: string, language: string, uri: string, text: string) => {
    try {
      lspManager.didSave(sessionId, language, uri, text)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })

  // Stop all servers for a session
  ipcMain.handle('lsp:stopAll', async (_event, sessionId: string) => {
    try {
      lspManager.stopAll(sessionId)
      return { success: true }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
}
