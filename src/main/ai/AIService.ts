import { configStore } from '../store/ConfigStore'
import { net } from 'electron'

interface AIConfig {
  provider: string
  apiKey: string
  apiUrl: string
  model: string
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

const SYSTEM_PROMPT = `你是一个 Linux 服务器运维专家 AI 助手，内嵌在 SSH 远程管理工具 Nutshell 中。
你的职责：
1. 根据用户的自然语言描述生成准确的 Linux 命令
2. 解释用户不理解的命令和输出
3. 诊断终端错误并给出修复建议
回复规则：
- 命令用 \`\`\` 代码块包裹
- 每次只生成一条命令（不要一次给多条），等待执行结果后再给下一条
- 简洁、准确、实用
- 对危险操作（rm -rf、格式化、删除数据等）在命令前加 [CONFIRM] 标记
- 当任务完成时，在回复末尾加 [DONE] 标记
- 用中文回复`

const PROVIDERS: Record<string, { url: string; model: string }> = {
  openai: { url: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  claude: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-20250514' },
  deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' }
}

class AIService {
  private getConfig(): AIConfig {
    const settings = configStore.getSettings() as any
    return settings.ai || { provider: 'openai', apiKey: '', apiUrl: '', model: '' }
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const config = this.getConfig()
    if (!config.apiKey) throw new Error('请先在设置中配置 AI API Key')

    const provider = config.provider || 'openai'
    const defaults = PROVIDERS[provider] || PROVIDERS.openai

    const apiUrl = config.apiUrl || defaults.url
    const model = config.model || defaults.model

    // Prepend system prompt
    const fullMessages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages
    ]

    if (provider === 'claude') {
      return this.callClaude(apiUrl, config.apiKey, model, fullMessages)
    } else {
      return this.callOpenAICompatible(apiUrl, config.apiKey, model, fullMessages)
    }
  }

  async generateCommand(description: string): Promise<string> {
    return this.chat([{
      role: 'user',
      content: `请根据以下描述生成对应的 Linux 命令，只给命令和简短说明：\n\n${description}`
    }])
  }

  async explainCommand(command: string): Promise<string> {
    return this.chat([{
      role: 'user',
      content: `请解释以下命令的含义、每个参数的作用，以及可能的风险：\n\n\`\`\`\n${command}\n\`\`\``
    }])
  }

  async diagnoseError(errorOutput: string): Promise<string> {
    return this.chat([{
      role: 'user',
      content: `终端出现以下错误，请分析原因并给出修复命令：\n\n\`\`\`\n${errorOutput}\n\`\`\``
    }])
  }

  // ===== Code AI methods =====
  private chatWithPrompt(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    const config = this.getConfig()
    if (!config.apiKey) throw new Error('请先在设置中配置 AI API Key')
    const provider = config.provider || 'openai'
    const defaults = PROVIDERS[provider] || PROVIDERS.openai
    const apiUrl = config.apiUrl || defaults.url
    const model = config.model || defaults.model
    const full: ChatMessage[] = [{ role: 'system', content: systemPrompt }, ...messages]
    if (provider === 'claude') return this.callClaude(apiUrl, config.apiKey, model, full)
    return this.callOpenAICompatible(apiUrl, config.apiKey, model, full)
  }

  async codeGenerate(fileContent: string, language: string, instruction: string): Promise<string> {
    return this.chatWithPrompt(
      `你是一个专业的${language}编程助手。根据用户的指令在代码中生成新代码。只返回生成的代码片段，用\`\`\`代码块包裹。简洁准确，用中文解释。`,
      [{ role: 'user', content: `文件语言: ${language}\n\n当前文件内容:\n\`\`\`${language}\n${fileContent.substring(0, 4000)}\n\`\`\`\n\n请求: ${instruction}` }]
    )
  }

  async codeExplain(code: string, language: string): Promise<string> {
    return this.chatWithPrompt(
      `你是一个编程导师。用中文详细解释代码的功能、逻辑和关键点。`,
      [{ role: 'user', content: `请解释以下 ${language} 代码:\n\`\`\`${language}\n${code}\n\`\`\`` }]
    )
  }

  async codeRefactor(code: string, language: string, instruction: string): Promise<string> {
    return this.chatWithPrompt(
      `你是一个代码重构专家。根据指令优化代码，返回优化后的完整代码（用\`\`\`代码块包裹），并简短说明改动。`,
      [{ role: 'user', content: `语言: ${language}\n原始代码:\n\`\`\`${language}\n${code}\n\`\`\`\n\n重构要求: ${instruction || '优化代码质量、可读性和性能'}` }]
    )
  }

  async codeFix(code: string, language: string, error: string): Promise<string> {
    return this.chatWithPrompt(
      `你是一个代码调试专家。分析代码中的问题，返回修复后的代码（用\`\`\`代码块包裹），并解释问题原因。`,
      [{ role: 'user', content: `语言: ${language}\n代码:\n\`\`\`${language}\n${code}\n\`\`\`\n\n错误信息: ${error || '请分析可能的问题'}` }]
    )
  }


  // ===== Agent Chat (with tool execution loop) =====
  async agentChat(
    messages: ChatMessage[],
    sessionId: string,
    rootPath: string,
    executeTool: (name: string, args: any) => Promise<string>,
    onToolCall?: (name: string, args: any) => void,
    maxIterations: number = 50
  ): Promise<{ content: string; toolCalls: Array<{ tool: string; args: any; result: string }> }> {

    const agentPrompt = `你是一个全栈开发 AI Agent，正在远程服务器上操作项目 "${rootPath}"。
你可以使用以下工具，通过在回复中使用特定格式调用：

[TOOL:read_file] path=/path/to/file [/TOOL]
[TOOL:write_file] path=/path/to/file
文件内容写在这里
[/TOOL]
[TOOL:list_directory] path=/path/to/dir [/TOOL]
[TOOL:search_code] query=搜索内容 [/TOOL]
[TOOL:run_command] cmd=要执行的命令 [/TOOL]
[TOOL:read_multiple_files] paths=/a,/b,/c [/TOOL]
[TOOL:scan_project] path=/project/root [/TOOL]
[TOOL:project_summary] path=/project/root [/TOOL]

规则：
- 每次回复只调用一个工具
- 工具调用后等待结果再决定下一步
- 完成任务后正常回复文本，不调用工具
- 写文件时给出完整内容，不要省略
- 如果 run_command 返回 requiresConfirmation=true 或 blocked=true，先向用户解释风险，再等待用户确认，不要换个命令偷偷继续执行
- 用中文回复`

    const fullMessages: ChatMessage[] = [
      { role: 'system', content: agentPrompt },
      ...messages
    ]

    const toolCalls: Array<{ tool: string; args: any; result: string }> = []

    for (let i = 0; i < maxIterations; i++) {
      const config = this.getConfig()
      if (!config.apiKey) throw new Error('请先配置 AI API Key')

      const provider = config.provider || 'openai'
      const defaults = PROVIDERS[provider] || PROVIDERS.openai
      const apiUrl = config.apiUrl || defaults.url
      const model = config.model || defaults.model

      let response: string
      if (provider === 'claude') {
        response = await this.callClaude(apiUrl, config.apiKey, model, fullMessages)
      } else {
        response = await this.callOpenAICompatible(apiUrl, config.apiKey, model, fullMessages)
      }

      // Parse tool calls from response
      const toolMatch = response.match(/\[TOOL:(\w+)\]\s*([\s\S]*?)\[\/TOOL\]/)

      if (!toolMatch) {
        // No tool call - agent is done
        return { content: response, toolCalls }
      }

      const toolName = toolMatch[1]
      const toolBody = toolMatch[2].trim()

      // Parse tool arguments
      let toolArgs: any = {}
      if (toolName === 'write_file') {
        const pathMatch = toolBody.match(/^path=(.+)\n([\s\S]*)$/)
        if (pathMatch) {
          toolArgs = { path: pathMatch[1].trim(), content: pathMatch[2] }
        }
      } else {
        // Parse key=value pairs
        for (const part of toolBody.split(/\s+/)) {
          const [k, ...v] = part.split('=')
          if (k && v.length) toolArgs[k] = v.join('=')
        }
      }

      // Notify frontend
      onToolCall?.(toolName, toolArgs)

      // Execute tool
      let toolResult: string
      try {
        toolResult = await executeTool(toolName, toolArgs)
      } catch (err: any) {
        toolResult = `工具执行错误: ${err.message}`
      }

      toolCalls.push({ tool: toolName, args: toolArgs, result: toolResult.substring(0, 3000) })

      // Add to conversation
      fullMessages.push({ role: 'assistant', content: response })
      fullMessages.push({ role: 'user', content: `工具 ${toolName} 执行结果:\n\`\`\`\n${toolResult.substring(0, 3000)}\n\`\`\`\n请继续。如果任务完成，直接回复总结。` })
    }

    return { content: `已完成 ${toolCalls.length} 次工具调用（达到单次上限 ${maxIterations} 次）。如果任务未全部完成，请再次发送"继续"让我接着执行。`, toolCalls }
  }

  private async callOpenAICompatible(
    url: string, apiKey: string, model: string, messages: ChatMessage[]
  ): Promise<string> {
    const body = JSON.stringify({
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: 2048,
      temperature: 0.3
    })

    const response = await this.fetchJSON(url, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    }, body)

    return response.choices?.[0]?.message?.content || '无响应'
  }

  private async callClaude(
    url: string, apiKey: string, model: string, messages: ChatMessage[]
  ): Promise<string> {
    // Claude API format: system separate, messages without system role
    const systemMsg = messages.find((m) => m.role === 'system')?.content || ''
    const userMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }))

    const body = JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemMsg,
      messages: userMessages
    })

    const response = await this.fetchJSON(url, {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }, body)

    return response.content?.[0]?.text || '无响应'
  }

  private fetchJSON(url: string, headers: Record<string, string>, body: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('AI 请求超时 (30s)')), 30000)

      try {
        // Use Node.js fetch (available in Electron 33+)
        fetch(url, {
          method: 'POST',
          headers,
          body
        })
          .then(async (res) => {
            clearTimeout(timeoutId)
            if (!res.ok) {
              const text = await res.text()
              reject(new Error(`AI API 错误 (${res.status}): ${text.substring(0, 200)}`))
              return
            }
            resolve(await res.json())
          })
          .catch((err) => {
            clearTimeout(timeoutId)
            reject(new Error(`AI 请求失败: ${err.message}`))
          })
      } catch (err: any) {
        clearTimeout(timeoutId)
        reject(new Error(`AI 请求异常: ${err.message}`))
      }
    })
  }
}

export const aiService = new AIService()
