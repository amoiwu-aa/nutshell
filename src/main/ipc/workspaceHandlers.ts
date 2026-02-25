import { ipcMain } from 'electron'
import { workspaceService } from '../workspace/WorkspaceService'

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:listDirectory', async (_event, sessionId: string, path: string) => {
    try { return { success: true, entries: await workspaceService.listDirectory(sessionId, path) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:searchFiles', async (_event, sessionId: string, rootPath: string, query: string) => {
    try { return { success: true, results: await workspaceService.searchFiles(sessionId, rootPath, query) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:searchFileNames', async (_event, sessionId: string, rootPath: string, pattern: string) => {
    try { return { success: true, files: await workspaceService.searchFileNames(sessionId, rootPath, pattern) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:getGitStatus', async (_event, sessionId: string, rootPath: string) => {
    try { return { success: true, git: await workspaceService.getGitStatus(sessionId, rootPath) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:getGitDiff', async (_event, sessionId: string, rootPath: string, file: string) => {
    try { return { success: true, diff: await workspaceService.getGitDiff(sessionId, rootPath, file) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:scanProject', async (_event, sessionId: string, rootPath: string) => {
    try { return { success: true, files: await workspaceService.scanProject(sessionId, rootPath) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:readMultipleFiles', async (_event, sessionId: string, paths: string[]) => {
    try { return { success: true, results: await workspaceService.readMultipleFiles(sessionId, paths) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:getProjectSummary', async (_event, sessionId: string, rootPath: string) => {
    try { return { success: true, summary: await workspaceService.getProjectSummary(sessionId, rootPath) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:agentReadFile', async (_event, sessionId: string, filePath: string) => {
    try { return { success: true, content: await workspaceService.readFile(sessionId, filePath) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:agentWriteFile', async (_event, sessionId: string, filePath: string, content: string) => {
    try { await workspaceService.writeFile(sessionId, filePath, content); return { success: true } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  ipcMain.handle('workspace:agentRunCommand', async (_event, sessionId: string, rootPath: string, command: string) => {
    try { return { success: true, output: await workspaceService.runCommand(sessionId, rootPath, command) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
}
