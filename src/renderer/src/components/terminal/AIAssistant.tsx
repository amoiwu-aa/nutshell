import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Send, Terminal, HelpCircle, AlertTriangle, Sparkles, X, Copy, Play,
  Loader2, Shield, Zap, Eye, Check, Ban, ChevronDown
} from 'lucide-react'
import { cn } from '../../lib/utils'

interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  type?: 'command' | 'explain' | 'diagnose' | 'chat' | 'output' | 'auto-exec' | 'confirm-needed'
  autoExecuted?: boolean
  confirmed?: boolean
}

interface AIAssistantProps {
  sessionId: string
  onInsertCommand: (command: string) => void
  onExecuteAndCapture: (command: string) => Promise<string>
  getTerminalContent: () => string
  onClose: () => void
}

const MAX_AUTO_STEPS = 10

export function AIAssistant({
  sessionId,
  onInsertCommand,
  onExecuteAndCapture,
  getTerminalContent,
  onClose
}: AIAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [activeMode, setActiveMode] = useState<'chat' | 'command' | 'explain' | 'diagnose'>('chat')
  const [executionMode, setExecutionMode] = useState<'confirm' | 'auto'>('confirm')
  const [autoStatus, setAutoStatus] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef(false)
  const [pendingConfirm, setPendingConfirm] = useState<{ command: string; msgId: string } | null>(null)

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages, autoStatus])

  const addMsg = useCallback((role: Message['role'], content: string, type?: Message['type'], extra?: Partial<Message>) => {
    const msg: Message = { id: `${Date.now()}-${Math.random()}`, role, content, type, ...extra }
    setMessages((prev) => [...prev, msg])
    return msg.id
  }, [])

  const updateMsg = useCallback((id: string, updates: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => m.id === id ? { ...m, ...updates } : m))
  }, [])

  // Extract code blocks
  const extractCommands = (content: string): string[] => {
    const matches = content.match(/```[\s\S]*?```/g) || []
    return matches.map((m) => m.replace(/```(?:\w+)?\n?/g, '').replace(/```/g, '').trim()).filter(Boolean)
  }

  const hasConfirmTag = (content: string) => content.includes('[CONFIRM]')
  const hasDoneTag = (content: string) => content.includes('[DONE]')

  // Build messages with terminal context
  const buildContextMessages = useCallback((userMessages: Array<{ role: string; content: string }>) => {
    const termContent = getTerminalContent()
    const contextMsg = termContent
      ? [{ role: 'user', content: `[当前终端屏幕内容]\n\`\`\`\n${termContent.substring(termContent.length - 2000)}\n\`\`\`\n(以上是终端当前显示的内容，供你参考)` },
         { role: 'assistant', content: '好的，我已看到终端内容，请问需要什么帮助？' }]
      : []
    return [...contextMsg, ...userMessages]
  }, [getTerminalContent])

  // Auto-execution loop
  const autoExecuteLoop = useCallback(async (
    aiContent: string,
    chatHistory: Array<{ role: string; content: string }>,
    step: number = 0
  ) => {
    if (abortRef.current || step >= MAX_AUTO_STEPS) {
      if (step >= MAX_AUTO_STEPS) addMsg('system', `已达最大自动执行次数 (${MAX_AUTO_STEPS})，已暂停`, 'auto-exec')
      setLoading(false)
      setAutoStatus('')
      return
    }

    const commands = extractCommands(aiContent)
    if (commands.length === 0 || hasDoneTag(aiContent)) {
      setLoading(false)
      setAutoStatus('')
      return
    }

    const cmd = commands[0]

    // Check for [CONFIRM] tag - pause for user confirmation
    if (hasConfirmTag(aiContent)) {
      const msgId = addMsg('assistant', aiContent.replace('[CONFIRM]', ''), 'confirm-needed')
      setPendingConfirm({ command: cmd, msgId })
      setAutoStatus('')
      setLoading(false)
      return
    }

    // Auto-execute
    addMsg('assistant', aiContent, 'auto-exec', { autoExecuted: true })
    setAutoStatus(`正在执行: ${cmd.substring(0, 50)}...`)

    const output = await onExecuteAndCapture(cmd)
    addMsg('system', `执行结果:\n\`\`\`\n${output.substring(0, 3000)}\n\`\`\``, 'output')

    setAutoStatus('AI 分析中...')

    // Send output back to AI for next step
    const updatedHistory = [
      ...chatHistory,
      { role: 'assistant', content: aiContent },
      { role: 'user', content: `命令已执行，输出如下:\n\`\`\`\n${output.substring(0, 3000)}\n\`\`\`\n请分析结果，如果任务完成请回复 [DONE]，否则给出下一步命令。` }
    ]

    try {
      const result = await window.api.ai.chat(buildContextMessages(updatedHistory))
      if (result.success && !abortRef.current) {
        // Continue loop
        await autoExecuteLoop(result.content, updatedHistory, step + 1)
      } else {
        addMsg('assistant', result.success ? result.content : `错误: ${result.error}`)
        setLoading(false)
        setAutoStatus('')
      }
    } catch (err: any) {
      addMsg('assistant', `请求失败: ${err.message}`)
      setLoading(false)
      setAutoStatus('')
    }
  }, [addMsg, buildContextMessages, onExecuteAndCapture])

  // Handle confirmed dangerous command in auto mode
  const handleConfirmExec = useCallback(async (approved: boolean) => {
    if (!pendingConfirm) return

    if (!approved) {
      updateMsg(pendingConfirm.msgId, { confirmed: false })
      addMsg('system', '用户已取消该命令', 'auto-exec')
      setPendingConfirm(null)
      return
    }

    updateMsg(pendingConfirm.msgId, { confirmed: true })
    setPendingConfirm(null)
    setLoading(true)
    setAutoStatus(`正在执行: ${pendingConfirm.command.substring(0, 50)}...`)

    const output = await onExecuteAndCapture(pendingConfirm.command)
    addMsg('system', `执行结果:\n\`\`\`\n${output.substring(0, 3000)}\n\`\`\``, 'output')

    setAutoStatus('AI 分析中...')
    const history = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }))
    history.push({ role: 'user', content: `命令已执行，输出:\n\`\`\`\n${output.substring(0, 3000)}\n\`\`\`\n任务完成请回复 [DONE]，否则给下一步。` })

    try {
      const result = await window.api.ai.chat(buildContextMessages(history))
      if (result.success) {
        await autoExecuteLoop(result.content, history, 0)
      } else {
        addMsg('assistant', `错误: ${result.error}`)
        setLoading(false)
        setAutoStatus('')
      }
    } catch {
      setLoading(false)
      setAutoStatus('')
    }
  }, [pendingConfirm, messages, addMsg, updateMsg, buildContextMessages, onExecuteAndCapture, autoExecuteLoop])

  const handleSend = async () => {
    if (!input.trim() || loading) return

    const userInput = input.trim()
    setInput('')
    abortRef.current = false
    addMsg('user', userInput, activeMode)
    setLoading(true)

    try {
      let result: any
      const chatHistory = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }))

      if (activeMode === 'command') {
        result = await window.api.ai.generateCommand(userInput)
      } else if (activeMode === 'explain') {
        result = await window.api.ai.explainCommand(userInput)
      } else if (activeMode === 'diagnose') {
        const termContent = getTerminalContent()
        const fullInput = termContent
          ? `终端最近输出:\n\`\`\`\n${termContent.substring(termContent.length - 1500)}\n\`\`\`\n\n用户描述: ${userInput}`
          : userInput
        result = await window.api.ai.diagnoseError(fullInput)
      } else {
        chatHistory.push({ role: 'user', content: userInput })
        result = await window.api.ai.chat(buildContextMessages(chatHistory))
      }

      if (!result.success) {
        addMsg('assistant', `错误: ${result.error}`)
        setLoading(false)
        return
      }

      // Auto mode: start execution loop
      if (executionMode === 'auto' && (activeMode === 'chat' || activeMode === 'command')) {
        chatHistory.push({ role: 'user', content: userInput })
        await autoExecuteLoop(result.content, chatHistory, 0)
      } else {
        addMsg('assistant', result.content, activeMode)
        setLoading(false)
      }
    } catch (err: any) {
      addMsg('assistant', `请求失败: ${err.message}`)
      setLoading(false)
    }
  }

  const handleAbort = () => {
    abortRef.current = true
    setAutoStatus('正在停止...')
  }

  // Render message content with code blocks
  const renderContent = (msg: Message) => {
    const content = msg.content.replace('[DONE]', '').replace('[CONFIRM]', '')
    const parts = content.split(/(```[\s\S]*?```)/g)
    return parts.map((part, i) => {
      const codeMatch = part.match(/```(?:\w+)?\n?([\s\S]*?)```/)
      if (codeMatch) {
        const code = codeMatch[1].trim()
        return (
          <div key={i} className="my-2 rounded-lg overflow-hidden border border-border">
            <div className="flex items-center justify-between px-3 py-1.5 bg-card text-xs text-muted-foreground">
              <span>{msg.autoExecuted ? '已自动执行' : '命令'}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => navigator.clipboard.writeText(code)} className="p-1 hover:bg-accent rounded" title="复制">
                  <Copy className="w-3 h-3" />
                </button>
                {!msg.autoExecuted && executionMode === 'confirm' && (
                  <button onClick={() => onInsertCommand(code)} className="flex items-center gap-1 px-1.5 py-0.5 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90">
                    <Play className="w-3 h-3" /> 执行
                  </button>
                )}
              </div>
            </div>
            <pre className="px-3 py-2 text-xs font-mono bg-[#0d1117] text-[#c9d1d9] overflow-x-auto" style={{ userSelect: 'text' }}>{code}</pre>
          </div>
        )
      }
      return (
        <span key={i} className="whitespace-pre-wrap" style={{ userSelect: 'text' }}>
          {part.split(/(`[^`]+`)/g).map((seg, j) => {
            if (seg.startsWith('`') && seg.endsWith('`')) {
              return <code key={j} className="px-1 py-0.5 bg-secondary rounded text-xs font-mono">{seg.slice(1, -1)}</code>
            }
            return seg
          })}
        </span>
      )
    })
  }

  const modes = [
    { id: 'chat' as const, icon: Sparkles, label: '对话' },
    { id: 'command' as const, icon: Terminal, label: '生成命令' },
    { id: 'explain' as const, icon: HelpCircle, label: '解释' },
    { id: 'diagnose' as const, icon: AlertTriangle, label: '诊断' }
  ]

  return (
    <div className="flex flex-col h-full w-[340px] bg-card border-l border-border shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-primary/15 flex items-center justify-center">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
          </div>
          <span className="text-sm font-semibold">AI 助手</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setExecutionMode(executionMode === 'confirm' ? 'auto' : 'confirm')}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-all',
              executionMode === 'auto'
                ? 'bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 shadow-[0_0_8px_rgba(234,179,8,0.1)]'
                : 'bg-secondary text-muted-foreground hover:text-foreground'
            )}
            title={executionMode === 'auto' ? '自主模式：AI 自动执行命令' : '确认模式：每条命令需手动确认'}
          >
            {executionMode === 'auto' ? <Zap className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
            {executionMode === 'auto' ? '自主' : '确认'}
          </button>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded-md transition-colors"><X className="w-4 h-4 text-muted-foreground" /></button>
        </div>
      </div>



      {/* Auto mode banner */}
      {executionMode === 'auto' && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-yellow-500/10 border-b border-yellow-500/20 text-xs text-yellow-400 shrink-0">
          <Zap className="w-3 h-3 shrink-0" />
          <span>自主模式：AI 将自动执行命令，危险操作会暂停确认</span>
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {messages.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-primary/10 flex items-center justify-center welcome-logo">
              <Sparkles className="w-7 h-7 text-primary/60" />
            </div>
            <p className="text-xs font-medium text-foreground/70 mb-1">AI 可以看到你的终端内容</p>
            <p className="text-[10px] text-muted-foreground/60">需要先在设置中配置 API Key</p>
            <div className="flex flex-wrap justify-center gap-1.5 mt-5">
              {modes.map((m) => (
                <button key={m.id} onClick={() => setActiveMode(m.id)}
                  className={cn('flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[10px] transition-all border',
                    activeMode === m.id
                      ? 'bg-primary/10 text-primary border-primary/20'
                      : 'bg-secondary/50 text-muted-foreground border-transparent hover:border-border hover:text-foreground'
                  )}>
                  <m.icon className="w-3 h-3" />{m.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id}>
            {msg.role === 'system' ? (
              <div className="text-xs text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2">
                {renderContent(msg)}
              </div>
            ) : (
              <div className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn(
                  'max-w-[95%] rounded-lg px-3 py-2 text-xs',
                  msg.role === 'user' ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-secondary/70 text-secondary-foreground border-l-2 border-primary/30 rounded-bl-sm',
                  msg.type === 'confirm-needed' && 'border-2 border-yellow-500/50 bg-yellow-500/10'
                )}>
                  {msg.role === 'assistant' ? renderContent(msg) : msg.content}
                </div>
              </div>
            )}

            {/* Confirm buttons for dangerous commands */}
            {msg.type === 'confirm-needed' && pendingConfirm?.msgId === msg.id && (
              <div className="flex items-center gap-2 mt-2 ml-2">
                <button onClick={() => handleConfirmExec(true)} className="flex items-center gap-1 px-3 py-1 bg-yellow-600 text-white rounded text-xs hover:bg-yellow-700">
                  <Check className="w-3 h-3" /> 确认执行
                </button>
                <button onClick={() => handleConfirmExec(false)} className="flex items-center gap-1 px-3 py-1 bg-secondary text-secondary-foreground rounded text-xs hover:bg-secondary/80">
                  <Ban className="w-3 h-3" /> 取消
                </button>
              </div>
            )}
          </div>
        ))}

        {/* Auto status */}
        {autoStatus && (
          <div className="flex items-center justify-between bg-secondary rounded-lg px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>{autoStatus}</span>
            </div>
            <button onClick={handleAbort} className="px-2 py-0.5 bg-destructive/20 text-destructive rounded text-xs hover:bg-destructive/30">
              停止
            </button>
          </div>
        )}

        {loading && !autoStatus && (
          <div className="flex justify-start">
            <div className="bg-secondary rounded-lg px-3 py-2 text-xs flex items-center gap-2">
              <Loader2 className="w-3 h-3 animate-spin" /> AI 思考中...
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-3 py-2.5 border-t border-border shrink-0 space-y-2">
        {/* Mode selector row */}
        <div className="flex items-center gap-2">
          <select
            value={activeMode}
            onChange={(e) => setActiveMode(e.target.value as any)}
            className="px-2 py-1 bg-secondary border-none rounded-md text-[10px] font-medium text-muted-foreground outline-none cursor-pointer hover:text-foreground transition-colors"
            style={{ backgroundImage: 'none', paddingRight: '8px' }}
          >
            {modes.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <button
            onClick={() => {
              const content = getTerminalContent()
              if (content) setInput((prev) => prev + '\n[终端内容]\n' + content.substring(content.length - 500))
            }}
            className="flex items-center gap-1 px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors ml-auto"
            title="插入终端内容"
          >
            <Eye className="w-3 h-3" /> 终端
          </button>
        </div>
        {/* Input row */}
        <div className="flex gap-1.5 items-end">
          <div className="flex-1 relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
              placeholder={activeMode === 'diagnose' ? '描述错误或直接发送...' : activeMode === 'command' ? '描述你想做什么...' : '输入消息...'}
              rows={1}
              className="w-full px-3 py-2 bg-background border border-input rounded-xl text-xs outline-none focus:ring-1 focus:ring-ring resize-none"
              disabled={loading}
              style={{ minHeight: '36px', maxHeight: '80px' }}
            />
          </div>
          <button onClick={handleSend} disabled={loading || !input.trim()}
            className="p-2 bg-primary text-primary-foreground rounded-xl disabled:opacity-50 hover:bg-primary/90 transition-colors btn-glow shrink-0">
            <Send className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
