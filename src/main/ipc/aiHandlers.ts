import { ipcMain, BrowserWindow } from 'electron'
import { aiService } from '../ai/AIService'
import { workspaceService } from '../workspace/WorkspaceService'
import { rustCoreService } from '../rust/RustCoreService'

function formatRustToolResult(result: any): string {
  if (typeof result === 'string') return result
  if (result == null) return '空结果'
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function registerAIHandlers(): void {
  ipcMain.handle('ai:chat', async (_event, messages: Array<{ role: string; content: string }>) => {
    try {
      const result = await aiService.chat(messages as any)
      return { success: true, content: result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('ai:generateCommand', async (_event, description: string) => {
    try {
      const result = await aiService.generateCommand(description)
      return { success: true, content: result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('ai:explainCommand', async (_event, command: string) => {
    try {
      const result = await aiService.explainCommand(command)
      return { success: true, content: result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('ai:diagnoseError', async (_event, errorOutput: string) => {
    try {
      const result = await aiService.diagnoseError(errorOutput)
      return { success: true, content: result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // Code AI
  ipcMain.handle('ai:codeGenerate', async (_event, fileContent: string, language: string, instruction: string) => {
    try { return { success: true, content: await aiService.codeGenerate(fileContent, language, instruction) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('ai:codeExplain', async (_event, code: string, language: string) => {
    try { return { success: true, content: await aiService.codeExplain(code, language) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('ai:codeRefactor', async (_event, code: string, language: string, instruction: string) => {
    try { return { success: true, content: await aiService.codeRefactor(code, language, instruction) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('ai:codeFix', async (_event, code: string, language: string, error: string) => {
    try { return { success: true, content: await aiService.codeFix(code, language, error) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  // Agent Chat with tool execution
  ipcMain.handle('ai:agentChat', async (_event, messages: any[], sessionId: string, rootPath: string, maxIterations?: number) => {
    try {
      const executeTool = async (name: string, args: any): Promise<string> => {
        switch (name) {
          case 'read_file':
            return formatRustToolResult(await rustCoreService.readFile({ sessionId, path: args.path, maxBytes: 128 * 1024 }))
          case 'write_file':
            await rustCoreService.writeFile({ sessionId, path: args.path, content: args.content, createDirs: true })
            return `文件已写入: ${args.path}`
          case 'list_directory':
            return formatRustToolResult(await rustCoreService.listDir({ sessionId, path: args.path }))
          case 'search_code':
            return formatRustToolResult(await rustCoreService.search({ sessionId, rootPath, pattern: args.query, limit: 100 }))
          case 'run_command':
            return formatRustToolResult(await rustCoreService.runCommand({ sessionId, command: args.cmd, cwd: rootPath, timeoutMs: 30000, requireConfirmation: false }))
          case 'read_multiple_files':
            return formatRustToolResult(await rustCoreService.readMultipleFiles({ sessionId, paths: Array.isArray(args.paths) ? args.paths : String(args.paths || '').split(',').map((s) => s.trim()).filter(Boolean) }))
          case 'scan_project':
            return formatRustToolResult(await rustCoreService.scanProject({ sessionId, rootPath }))
          case 'project_summary':
            return formatRustToolResult(await rustCoreService.projectSummary({ sessionId, rootPath }))
          default:
            return `未知工具: ${name}`
        }
      }

      const onToolCall = (name: string, args: any) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('ai:toolCall', name, args)
        }
      }

      const result = await aiService.agentChat(messages, sessionId, rootPath, executeTool, onToolCall, maxIterations || 50)
      return { success: true, content: result.content, toolCalls: result.toolCalls }
    } catch (e: any) {
      return { success: false, error: e.message }
    }
  })
}
