import { ipcMain, BrowserWindow } from 'electron'
import { aiService } from '../ai/AIService'
import { workspaceService } from '../workspace/WorkspaceService'

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
  ipcMain.handle('ai:generateScript', async (_event, type: string, description: string) => {
    try { return { success: true, content: await aiService.generateScript(type, description) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  // Agent Chat with tool execution
  ipcMain.handle('ai:agentChat', async (_event, messages: any[], sessionId: string, rootPath: string, maxIterations?: number) => {
    try {
      const executeTool = async (name: string, args: any): Promise<string> => {
        switch (name) {
          case 'read_file':
            return await workspaceService.readFile(sessionId, args.path)
          case 'write_file':
            await workspaceService.writeFile(sessionId, args.path, args.content)
            return `文件已写入: ${args.path}`
          case 'list_directory':
            const entries = await workspaceService.listDirectory(sessionId, args.path)
            return entries.map((e) => `${e.isDirectory ? '[DIR]' : '[FILE]'} ${e.name}`).join('\n')
          case 'search_code':
            const results = await workspaceService.searchFiles(sessionId, rootPath, args.query)
            return results.map((r) => `${r.file}:${r.line}: ${r.content}`).join('\n') || '无匹配结果'
          case 'run_command':
            return await workspaceService.runCommand(sessionId, rootPath, args.cmd)
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
