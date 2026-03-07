import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import {
  Send, Sparkles, X, Copy, Loader2, ChevronDown, ChevronLeft, Plus, Trash2, Minimize2,
  FolderSearch, FileText, Terminal, Search, Edit, Check, Zap, Bug, ListChecks, Shield,
  MessageSquare, Clock, GitCompare, XCircle, CheckCircle, Play, FileText as FileDoc, ExternalLink
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../stores/settingsStore'
import { v4 as uuidv4 } from 'uuid'

// ===== Types =====
interface Message {
  id: string; role: 'user' | 'assistant' | 'system'; content: string
  toolCalls?: Array<{ tool: string; args: any; result: string }>
  pendingChanges?: PendingChange[]
  planPath?: string  // Set when this message is a plan card
  timestamp: number
}

interface PlanTodo {
  text: string
  done: boolean
}

interface PendingChange {
  id: string; path: string; newContent: string; originalContent: string
  status: 'pending' | 'accepted' | 'rejected'
  addedLines: number; removedLines: number
}

interface ConvSummary { id: string; title: string; createdAt: number; updatedAt: number }

interface WorkspaceAIProps {
  sessionId: string; rootPath: string
  currentFile?: { path: string; content: string; language: string } | null
  onInsertCode: (code: string) => void; onExecuteCommand: (cmd: string) => void
  onOpenFile: (path: string) => void; onWriteFile: (path: string, content: string) => void
  onReviewDiff?: (path: string, original: string, modified: string) => void
  onClose: () => void
}

// ===== Constants =====
type AIMode = 'agent' | 'ask' | 'debug' | 'plan'
const MODES: Array<{ id: AIMode; icon: any; label: string; desc: string }> = [
  { id: 'agent', icon: Zap, label: 'Agent', desc: '自主编码 - 读写文件/执行命令' },
  { id: 'ask', icon: Shield, label: 'Ask', desc: '问答模式 - 不操作文件' },
  { id: 'debug', icon: Bug, label: 'Debug', desc: '调试分析 - 错误诊断/修复方案' },
  { id: 'plan', icon: ListChecks, label: 'Plan', desc: '架构规划 - 设计方案/任务拆分' }
]
const MODE_PROMPTS: Record<AIMode, string> = {
  agent: '你是开发 Agent，可以读写文件和执行命令来完成编码任务。用中文回复。',
  ask: '你是编程助手，回答关于代码和技术的问题。不修改文件。用中文回复。',
  debug: '你是调试专家。分析代码错误和异常输出，给出精确修复方案。用中文回复。',
  plan: `你是架构师。你的回复必须包含结构化的 TODO 清单。格式要求：
1. 先用一段话概述方案
2. 然后输出一个带复选框的任务列表，格式：
   - [ ] 任务1：具体描述
   - [ ] 任务2：具体描述
   每个任务要具体、可执行，包含涉及的文件路径
3. 最后可以补充注意事项
用中文回复。`
}
const PROVIDERS_MODELS: Record<string, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
  claude: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
  deepseek: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
  custom: []
}
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'gpt-4o-mini': 128000, 'gpt-4o': 128000, 'gpt-4-turbo': 128000,
  'claude-sonnet-4-20250514': 200000, 'claude-3-5-haiku-20241022': 200000,
  'deepseek-chat': 64000, 'deepseek-coder': 128000, 'deepseek-reasoner': 64000,
}
const toolIcons: Record<string, any> = { read_file: FileText, write_file: Edit, list_directory: FolderSearch, search_code: Search, run_command: Terminal }
const toolLabels: Record<string, string> = { read_file: '读取文件', write_file: '写入文件', list_directory: '列目录', search_code: '搜索代码', run_command: '执行命令' }
function estimateTokens(text: string): number { return Math.ceil(text.length / 3) }
function formatTokens(n: number): string { return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}` }

function computeLineDiff(original: string, modified: string): { added: number; removed: number } {
  const oldLines = original ? original.split('\n') : []
  const newLines = modified ? modified.split('\n') : []
  if (oldLines.length === 0) return { added: newLines.length, removed: 0 }
  if (newLines.length === 0) return { added: 0, removed: oldLines.length }
  // Simple LCS-based diff count
  let added = 0, removed = 0
  const maxLen = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < maxLen; i++) {
    if (i >= oldLines.length) { added++; continue }
    if (i >= newLines.length) { removed++; continue }
    if (oldLines[i] !== newLines[i]) { added++; removed++ }
  }
  return { added, removed }
}

// ===== Markdown Renderer =====
function MarkdownBlock({ text }: { text: string }) {
  if (!text.trim()) return null
  const lines = text.split('\n')
  const elements: JSX.Element[] = []
  let listItems: JSX.Element[] = []
  let listType: 'ul' | 'ol' | null = null

  const flushList = () => {
    if (listItems.length > 0) {
      const key = `list-${elements.length}`
      if (listType === 'ol') {
        elements.push(<ol key={key} className="pl-5 my-1 space-y-0.5" style={{ listStyleType: 'decimal' }}>{listItems}</ol>)
      } else {
        elements.push(<ul key={key} className="pl-4 my-1 space-y-0.5">{listItems}</ul>)
      }
      listItems = []
      listType = null
    }
  }

  const renderInline = (s: string): (string | JSX.Element)[] => {
    const result: (string | JSX.Element)[] = []
    // Process: **bold**, *italic*, `code`, [link](url)
    const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(s)) !== null) {
      if (match.index > lastIndex) result.push(s.substring(lastIndex, match.index))
      if (match[2]) { // **bold**
        result.push(<strong key={match.index} style={{ color: '#e0e0e0', fontWeight: 600 }}>{match[2]}</strong>)
      } else if (match[3]) { // *italic*
        result.push(<em key={match.index} style={{ fontStyle: 'italic', color: '#b0b0b0' }}>{match[3]}</em>)
      } else if (match[4]) { // `code`
        result.push(<code key={match.index} className="px-1 py-0.5 rounded text-[12px] font-mono" style={{ background: '#3c3c3c', color: '#ce9178' }}>{match[4]}</code>)
      } else if (match[5] && match[6]) { // [text](url)
        result.push(<span key={match.index} className="underline cursor-pointer" style={{ color: '#58a6ff' }}>{match[5]}</span>)
      }
      lastIndex = match.index + match[0].length
    }
    if (lastIndex < s.length) result.push(s.substring(lastIndex))
    return result
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    const trimmed = line.trimStart()

    // Heading ##
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)/)
    if (hMatch) {
      flushList()
      const level = hMatch[1].length
      const fontSize = level === 1 ? 16 : level === 2 ? 15 : level === 3 ? 14 : 13
      const weight = level <= 2 ? 700 : 600
      elements.push(
        <div key={idx} style={{ fontSize, fontWeight: weight, color: '#e0e0e0', marginTop: level <= 2 ? 10 : 6, marginBottom: 4 }}>
          {renderInline(hMatch[2])}
        </div>
      )
      continue
    }

    // Checkbox list - [ ] or - [x]
    const cbMatch = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)/)
    if (cbMatch) {
      if (listType !== 'ul') { flushList(); listType = 'ul' }
      const checked = cbMatch[1] !== ' '
      listItems.push(
        <li key={idx} className="flex items-start gap-1.5 text-[13px]" style={{ listStyle: 'none', marginLeft: -16, color: '#cccccc' }}>
          <span className="mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0" style={{
            borderColor: checked ? '#3fb950' : '#6e7681',
            background: checked ? '#3fb95022' : 'transparent',
          }}>
            {checked && <Check className="w-3 h-3" style={{ color: '#3fb950' }} />}
          </span>
          <span>{renderInline(cbMatch[2])}</span>
        </li>
      )
      continue
    }

    // Unordered list - or *
    const ulMatch = trimmed.match(/^[-*]\s+(.+)/)
    if (ulMatch) {
      if (listType !== 'ul') { flushList(); listType = 'ul' }
      listItems.push(
        <li key={idx} className="text-[13px]" style={{ color: '#cccccc', listStyleType: 'disc' }}>
          {renderInline(ulMatch[1])}
        </li>
      )
      continue
    }

    // Ordered list 1.
    const olMatch = trimmed.match(/^(\d+)[.)]\s+(.+)/)
    if (olMatch) {
      if (listType !== 'ol') { flushList(); listType = 'ol' }
      listItems.push(
        <li key={idx} className="text-[13px]" style={{ color: '#cccccc' }}>
          {renderInline(olMatch[2])}
        </li>
      )
      continue
    }

    // Horizontal rule ---
    if (/^---+\s*$/.test(trimmed)) {
      flushList()
      elements.push(<hr key={idx} className="my-2" style={{ borderColor: '#3c3c3c' }} />)
      continue
    }

    // Blockquote >
    if (trimmed.startsWith('> ')) {
      flushList()
      elements.push(
        <div key={idx} className="pl-3 my-1 text-[13px]" style={{ borderLeft: '3px solid #3c3c3c', color: '#969696' }}>
          {renderInline(trimmed.substring(2))}
        </div>
      )
      continue
    }

    // Empty line
    if (!trimmed) {
      flushList()
      elements.push(<div key={idx} className="h-1" />)
      continue
    }

    // Normal paragraph
    flushList()
    elements.push(
      <div key={idx} className="text-[13px] leading-relaxed" style={{ color: '#cccccc', userSelect: 'text' }}>
        {renderInline(line)}
      </div>
    )
  }
  flushList()

  return <div className="space-y-0.5">{elements}</div>
}

// ===== Main Component =====
export function WorkspaceAI({ sessionId, rootPath, currentFile, onInsertCode, onExecuteCommand, onOpenFile, onWriteFile, onReviewDiff, onClose }: WorkspaceAIProps) {
  // View state
  const [view, setView] = useState<'list' | 'chat'>('list')
  const [conversations, setConversations] = useState<ConvSummary[]>([])
  const [activeConvId, setActiveConvId] = useState<string | null>(null)

  // Chat state
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<AIMode>('agent')
  const [showModePicker, setShowModePicker] = useState(false)
  const [projectSummary, setProjectSummary] = useState('')
  const [projectScanned, setProjectScanned] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [toolStatus, setToolStatus] = useState('')
  const [activePlanPath, setActivePlanPath] = useState<string | null>(null)
  const [planTodos, setPlanTodos] = useState<PlanTodo[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const { settings, setSettings } = useSettingsStore()

  const ai = (settings as any).ai || { provider: 'openai', model: '', maxTokens: 128000 }
  const currentModel = ai.model || PROVIDERS_MODELS[ai.provider]?.[0] || 'gpt-4o-mini'
  const maxTokens = MODEL_CONTEXT_LIMITS[currentModel] || (ai.provider === 'custom' ? (ai.maxTokens || 128000) : 128000)
  const currentModeInfo = MODES.find((m) => m.id === mode) || MODES[0]

  // Auto-scroll only on NEW messages (not on status updates like accept/reject)
  const prevMsgCountRef = useRef(0)
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current || toolStatus) {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
    prevMsgCountRef.current = messages.length
  }, [messages.length, toolStatus])

  // Load conversation list on mount
  useEffect(() => { loadConversations() }, [rootPath])

  // Tool call events
  useEffect(() => {
    const remove = window.api.ai.onToolCall?.((name: string, args: any) => {
      setToolStatus(`${toolLabels[name] || name}: ${(args.path || args.query || args.cmd || '').substring(0, 60)}`)
    })
    return () => remove?.()
  }, [])

  // Scan project on mount (silent)
  useEffect(() => { scanProject() }, [rootPath])

  const loadConversations = async () => {
    try {
      const r = await window.api.config.getConversations(rootPath)
      if (r.success) setConversations(r.conversations || [])
    } catch { }
  }

  const scanProject = async () => {
    setScanning(true)
    try {
      const r = await window.api.workspace.getProjectSummary(sessionId, rootPath)
      if (r.success) { setProjectSummary(r.summary); setProjectScanned(true) }
    } catch { }
    setScanning(false)
  }

  // ===== Conversation management =====
  const createNewConversation = useCallback(() => {
    const id = uuidv4()
    setActiveConvId(id)
    setMessages([])
    setView('chat')
  }, [])

  const openConversation = useCallback(async (convId: string) => {
    try {
      const r = await window.api.config.getConversation(rootPath, convId)
      if (r.success && r.conversation) {
        setActiveConvId(convId)
        setMessages(r.conversation.messages.map((m: any) => ({ ...m, id: m.id || `${m.timestamp}-${Math.random()}` })))
        setView('chat')
      }
    } catch { }
  }, [rootPath])

  const saveCurrentConversation = useCallback(async (msgs?: Message[]) => {
    if (!activeConvId) return
    const toSave = msgs || messages
    if (toSave.length === 0) return
    const firstUser = toSave.find((m) => m.role === 'user')
    const title = firstUser ? firstUser.content.substring(0, 30) : '新对话'
    const existing = conversations.find((c) => c.id === activeConvId)
    await window.api.config.saveConversation(rootPath, {
      id: activeConvId,
      title,
      createdAt: existing?.createdAt || Date.now(),
      updatedAt: Date.now(),
      messages: toSave.map((m) => ({ role: m.role, content: m.content, timestamp: m.timestamp }))
    })
    loadConversations()
  }, [activeConvId, messages, conversations, rootPath])

  const deleteConversation = useCallback(async (convId: string) => {
    await window.api.config.deleteConversation(rootPath, convId)
    if (activeConvId === convId) { setActiveConvId(null); setMessages([]); setView('list') }
    loadConversations()
  }, [rootPath, activeConvId])

  const goBackToList = useCallback(() => {
    saveCurrentConversation()
    setView('list')
  }, [saveCurrentConversation])

  // ===== Chat logic =====
  const addMsg = (role: Message['role'], content: string, extra?: Partial<Message>) => {
    setMessages((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, role, content, timestamp: Date.now(), ...extra }])
  }

  // Token breakdown
  const tokenBreakdown = useMemo(() => {
    const summaryTok = estimateTokens(projectSummary)
    const historyTok = estimateTokens(messages.filter((m) => m.role !== 'system').map((m) => m.content).join(''))
    const fileTok = estimateTokens(currentFile?.content || '')
    const inputTok = estimateTokens(input)
    const total = summaryTok + historyTok + fileTok + inputTok
    return { summaryTok, historyTok, fileTok, inputTok, total }
  }, [projectSummary, messages, currentFile, input])

  const tokenPercent = Math.min(100, (tokenBreakdown.total / maxTokens) * 100)
  const tokenColor = tokenPercent < 50 ? '#3fb950' : tokenPercent < 80 ? '#d29922' : '#f85149'

  const compressContext = useCallback(() => {
    const before = tokenBreakdown.total
    setProjectSummary((s) => s.substring(0, 1500))
    setMessages((prev) => {
      const nonSystem = prev.filter((m) => m.role !== 'system')
      const kept = nonSystem.slice(-8)
      return kept
    })
  }, [tokenBreakdown.total])

  // ===== Plan helpers =====
  const parsePlanTodos = useCallback((content: string): PlanTodo[] => {
    return content.split('\n')
      .map((line) => {
        const m = line.match(/^[\s]*[-*]\s+\[([ xX])\]\s+(.+)/)
        if (m) return { text: m[2].trim(), done: m[1] !== ' ' }
        return null
      })
      .filter(Boolean) as PlanTodo[]
  }, [])

  const refreshPlanTodos = useCallback(async () => {
    if (!activePlanPath) return
    try {
      const r = await window.api.sftp.readFile(sessionId, activePlanPath)
      if (r.success) setPlanTodos(parsePlanTodos(r.content))
    } catch { }
  }, [activePlanPath, sessionId, parsePlanTodos])

  // Refresh plan todos periodically when plan is active
  useEffect(() => {
    if (!activePlanPath) return
    refreshPlanTodos()
    const interval = setInterval(refreshPlanTodos, 5000)
    return () => clearInterval(interval)
  }, [activePlanPath, refreshPlanTodos])

  const planDone = planTodos.filter((t) => t.done).length
  const planTotal = planTodos.length

  const executePlan = useCallback(async () => {
    if (!activePlanPath) return
    setMode('agent')
    setLoading(true); setToolStatus('')

    try {
      // Read plan file
      const planResult = await window.api.sftp.readFile(sessionId, activePlanPath)
      if (!planResult.success) { addMsg('assistant', '无法读取计划文件'); setLoading(false); return }

      const planContent = planResult.content
      const instruction = `请按照以下计划逐项执行。每完成一项任务后，使用 write_file 工具更新计划文件，将对应的 "- [ ]" 改为 "- [x]"。

计划文件路径: ${activePlanPath}

当前计划内容:
${planContent}

请从第一个未完成的任务（标记为 - [ ] 的）开始执行。完成后更新计划文件并继续下一项。`

      addMsg('user', '执行计划')

      // Ensure conversation ID
      if (!activeConvId) setActiveConvId(uuidv4())

      const chatHistory = messages.filter((m) => m.role !== 'system').slice(-10).map((m) => ({ role: m.role, content: m.content }))
      let ctx = projectSummary ? `[项目]\n${projectSummary.substring(0, 2000)}\n` : ''
      chatHistory.push({ role: 'user', content: `${ctx}\n${instruction}` })

      const r = await window.api.ai.agentChat(chatHistory, sessionId, rootPath, 80)
      if (r.success) {
        if (r.toolCalls?.length) {
          const pendingChanges: PendingChange[] = []
          for (const tc of r.toolCalls) {
            if (tc.tool === 'write_file' && tc.args?.path) {
              // Plan file updates go directly (no review needed)
              if (tc.args.path === activePlanPath) {
                onWriteFile(tc.args.path, tc.args.content || '')
                continue
              }
              try {
                const readResult = await window.api.sftp.readFile(sessionId, tc.args.path)
                const original = readResult.success ? readResult.content : ''
                const diff = computeLineDiff(original, tc.args.content || '')
                pendingChanges.push({ id: uuidv4(), path: tc.args.path, newContent: tc.args.content || '', originalContent: original, status: 'pending', addedLines: diff.added, removedLines: diff.removed })
              } catch {
                pendingChanges.push({ id: uuidv4(), path: tc.args.path, newContent: tc.args.content || '', originalContent: '', status: 'pending', addedLines: (tc.args.content || '').split('\n').length, removedLines: 0 })
              }
            }
            if (tc.tool === 'run_command' && tc.args?.cmd) onExecuteCommand(`# AI 执行: ${tc.args.cmd}`)
          }
          const nonWriteCalls = r.toolCalls.filter((tc: any) => tc.tool !== 'write_file' || tc.args?.path === activePlanPath)
          if (nonWriteCalls.length > 0) addMsg('system', `执行了 ${nonWriteCalls.length} 个操作`, { toolCalls: nonWriteCalls.filter((tc: any) => tc.tool !== 'write_file') })
          if (pendingChanges.length > 0) addMsg('system', `AI 修改了 ${pendingChanges.length} 个文件`, { pendingChanges })
        }
        addMsg('assistant', r.content)
        refreshPlanTodos()
      } else { addMsg('assistant', `错误: ${r.error}`) }
    } catch (err: any) { addMsg('assistant', `执行失败: ${err.message}`) }
    setLoading(false); setToolStatus('')
  }, [activePlanPath, sessionId, rootPath, projectSummary, messages, activeConvId, onWriteFile, onExecuteCommand, refreshPlanTodos])

  const handleSend = async () => {
    if (!input.trim() || loading) return
    const userInput = input.trim(); setInput(''); addMsg('user', userInput); setLoading(true); setToolStatus('')

    // Ensure conversation ID
    if (!activeConvId) {
      const id = uuidv4()
      setActiveConvId(id)
    }

    try {
      const chatHistory = messages.filter((m) => m.role !== 'system').slice(-30).map((m) => ({ role: m.role, content: m.content }))
      let ctx = projectSummary ? `[项目]\n${projectSummary.substring(0, 3000)}\n` : ''
      if (currentFile) ctx += `[当前文件: ${currentFile.path}]\n\`\`\`${currentFile.language}\n${currentFile.content.substring(0, 2000)}\n\`\`\`\n`

      // Agent mode: inject active plan context
      if (mode === 'agent' && activePlanPath) {
        try {
          const planR = await window.api.sftp.readFile(sessionId, activePlanPath)
          if (planR.success) ctx += `\n[活跃计划: ${activePlanPath}]\n${planR.content.substring(0, 2000)}\n`
        } catch { }
      }

      if (mode === 'agent') {
        chatHistory.push({ role: 'user', content: `${ctx}\n${userInput}` })
        const r = await window.api.ai.agentChat(chatHistory, sessionId, rootPath)
        if (r.success) {
          if (r.toolCalls?.length) {
            // Process tool calls - write_file goes to pending review
            const pendingChanges: PendingChange[] = []
            for (const tc of r.toolCalls) {
              if (tc.tool === 'write_file' && tc.args?.path) {
                try {
                  const readResult = await window.api.sftp.readFile(sessionId, tc.args.path)
                  const original = readResult.success ? readResult.content : ''
                  const diff = computeLineDiff(original, tc.args.content || '')
                  pendingChanges.push({
                    id: uuidv4(), path: tc.args.path,
                    newContent: tc.args.content || '', originalContent: original,
                    status: 'pending', addedLines: diff.added, removedLines: diff.removed
                  })
                } catch {
                  pendingChanges.push({
                    id: uuidv4(), path: tc.args.path,
                    newContent: tc.args.content || '', originalContent: '',
                    status: 'pending', addedLines: (tc.args.content || '').split('\n').length, removedLines: 0
                  })
                }
              }
              if (tc.tool === 'run_command' && tc.args?.cmd) onExecuteCommand(`# AI 执行: ${tc.args.cmd}`)
            }
            const nonWriteCalls = r.toolCalls.filter((tc: any) => tc.tool !== 'write_file')
            if (nonWriteCalls.length > 0) {
              addMsg('system', `执行了 ${nonWriteCalls.length} 个操作`, { toolCalls: nonWriteCalls })
            }
            if (pendingChanges.length > 0) {
              addMsg('system', `AI 修改了 ${pendingChanges.length} 个文件`, { pendingChanges })
            }
          }
          addMsg('assistant', r.content)
        } else { addMsg('assistant', `错误: ${r.error}`) }
      } else {
        chatHistory.push({ role: 'user', content: `[模式: ${mode}] ${ctx}\n${userInput}` })
        const r = await window.api.ai.chat([{ role: 'system' as any, content: MODE_PROMPTS[mode] }, ...chatHistory])
        if (r.success) {
          addMsg('assistant', r.content)

          // Plan mode: write .md file + show plan card
          if (mode === 'plan' && r.content) {
            const todos = parsePlanTodos(r.content)
            if (todos.length > 0) {
              try {
                // Create plans directory
                await window.api.workspace.agentRunCommand(sessionId, rootPath, 'mkdir -p .nutshell/plans')
                // Generate filename
                const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 16)
                const titleSlug = userInput.substring(0, 20).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '_')
                const planFileName = `${ts}-${titleSlug}.md`
                const planPath = `${rootPath}/.nutshell/plans/${planFileName}`
                // Write plan file
                await window.api.sftp.writeFile(sessionId, planPath, r.content)
                // Set as active plan
                setActivePlanPath(planPath)
                setPlanTodos(todos)
                // Show plan card in chat
                addMsg('system', `计划已保存`, { planPath })
                // Open in editor
                onOpenFile(planPath)
              } catch (err: any) {
                addMsg('system', `计划文件保存失败: ${err.message}`)
              }
            }
          }
        } else { addMsg('assistant', `错误: ${r.error}`) }
      }
    } catch (err: any) { addMsg('assistant', `失败: ${err.message}`) }
    setLoading(false); setToolStatus('')
  }

  // Auto-save after messages change
  useEffect(() => {
    if (messages.length > 0 && activeConvId) {
      const timer = setTimeout(() => saveCurrentConversation(messages), 1000)
      return () => clearTimeout(timer)
    }
  }, [messages, activeConvId])

  // ===== Pending change actions =====
  const acceptChange = useCallback((changeId: string) => {
    setMessages((prev) => prev.map((msg) => {
      if (!msg.pendingChanges) return msg
      const updated = msg.pendingChanges.map((pc) => {
        if (pc.id === changeId && pc.status === 'pending') {
          onWriteFile(pc.path, pc.newContent)
          return { ...pc, status: 'accepted' as const }
        }
        return pc
      })
      return { ...msg, pendingChanges: updated }
    }))
  }, [onWriteFile])

  const acceptAllChanges = useCallback(() => {
    setMessages((prev) => prev.map((msg) => {
      if (!msg.pendingChanges) return msg
      const updated = msg.pendingChanges.map((pc) => {
        if (pc.status === 'pending') {
          onWriteFile(pc.path, pc.newContent)
          return { ...pc, status: 'accepted' as const }
        }
        return pc
      })
      return { ...msg, pendingChanges: updated }
    }))
  }, [onWriteFile])

  const rejectChange = useCallback((changeId: string) => {
    setMessages((prev) => prev.map((msg) => {
      if (!msg.pendingChanges) return msg
      return { ...msg, pendingChanges: msg.pendingChanges.map((pc) => pc.id === changeId ? { ...pc, status: 'rejected' as const } : pc) }
    }))
  }, [])

  const reviewChange = useCallback((pc: PendingChange) => {
    onReviewDiff?.(pc.path, pc.originalContent, pc.newContent)
  }, [onReviewDiff])

  // ===== Markdown Render =====
  const renderContent = (msg: Message) => {
    const parts = msg.content.split(/(```[\s\S]*?```)/g)
    return parts.map((part, i) => {
      // Code block
      const codeMatch = part.match(/```(\w+)?\n?([\s\S]*?)```/)
      if (codeMatch) {
        const code = codeMatch[2].trim()
        return (
          <div key={i} className="my-1.5 rounded overflow-hidden" style={{ border: '1px solid #3c3c3c' }}>
            <div className="flex items-center justify-between px-2 py-1 text-[12px]" style={{ background: '#2d2d2d', color: '#969696' }}>
              <span>{codeMatch[1] || 'code'}</span>
              <div className="flex gap-1">
                <button onClick={() => navigator.clipboard.writeText(code)} className="p-0.5 hover:bg-[#3c3c3c] rounded"><Copy className="w-3 h-3" /></button>
                <button onClick={() => onInsertCode(code)} className="px-1.5 py-0.5 rounded text-[11px]" style={{ background: '#007acc', color: '#fff' }}>插入</button>
              </div>
            </div>
            <pre className="px-2 py-1.5 text-[13px] font-mono overflow-x-auto" style={{ background: '#1e1e1e', color: '#cccccc', userSelect: 'text' }}>{code}</pre>
          </div>
        )
      }
      // Render markdown text
      return <MarkdownBlock key={i} text={part} />
    })
  }

  const renderPendingChanges = (changes: PendingChange[]) => {
    const hasPending = changes.some((pc) => pc.status === 'pending')
    return (<>
      {/* Batch actions when multiple pending */}
      {hasPending && changes.filter((c) => c.status === 'pending').length > 1 && (
        <div className="mt-1.5 flex items-center gap-2 px-1">
          <button onClick={acceptAllChanges} className="flex items-center gap-1 px-2 py-1 rounded text-[11px] hover:bg-[#2ea04322]" style={{ color: '#3fb950' }}>
            <CheckCircle className="w-3 h-3" />全部接受
          </button>
          <button onClick={() => {
            setMessages((prev) => prev.map((msg) => {
              if (!msg.pendingChanges) return msg
              return { ...msg, pendingChanges: msg.pendingChanges.map((pc) => pc.status === 'pending' ? { ...pc, status: 'rejected' as const } : pc) }
            }))
          }} className="flex items-center gap-1 px-2 py-1 rounded text-[11px] hover:bg-[#f8514922]" style={{ color: '#f85149' }}>
            <XCircle className="w-3 h-3" />全部拒绝
          </button>
        </div>
      )}
      {changes.map((pc) => {
        const relPath = pc.path.startsWith(rootPath) ? pc.path.substring(rootPath.length).replace(/^\//, '') : pc.path
        const isNew = !pc.originalContent
        return (
          <div key={pc.id} className="mt-1.5 rounded overflow-hidden" style={{
            border: `1px solid ${pc.status === 'accepted' ? '#3fb950' : pc.status === 'rejected' ? '#f85149' : '#3c3c3c'}`,
            opacity: pc.status === 'rejected' ? 0.5 : 1
          }}>
            {/* File header */}
            <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ background: pc.status === 'accepted' ? '#3fb95011' : pc.status === 'rejected' ? '#f8514911' : '#2d2d2d' }}>
              <Edit className="w-3.5 h-3.5 shrink-0" style={{ color: pc.status === 'accepted' ? '#3fb950' : '#d4b37b' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-mono truncate" style={{ color: '#cccccc' }}>{relPath}</div>
                <div className="flex items-center gap-2 text-[11px]">
                  {isNew && <span style={{ color: '#3fb950' }}>新文件</span>}
                  {pc.addedLines > 0 && <span style={{ color: '#3fb950' }}>+{pc.addedLines}</span>}
                  {pc.removedLines > 0 && <span style={{ color: '#f85149' }}>-{pc.removedLines}</span>}
                  {!isNew && pc.addedLines === 0 && pc.removedLines === 0 && <span style={{ color: '#969696' }}>无变化</span>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {/* View diff - always available */}
                <button onClick={() => reviewChange(pc)} className="px-2 py-0.5 rounded text-[11px] hover:bg-[#3c3c3c]" style={{ color: '#58a6ff' }} title="查看差异">
                  <GitCompare className="w-3 h-3 inline mr-0.5" />查看
                </button>
                {/* Open file in editor */}
                <button onClick={() => onOpenFile(pc.path)} className="px-2 py-0.5 rounded text-[11px] hover:bg-[#3c3c3c]" style={{ color: '#969696' }} title="打开文件">
                  <ExternalLink className="w-3 h-3" />
                </button>
                {pc.status === 'pending' && (
                  <>
                    <button onClick={() => acceptChange(pc.id)} className="p-1 rounded hover:bg-[#2ea04344]" title="接受更改">
                      <CheckCircle className="w-3.5 h-3.5" style={{ color: '#3fb950' }} />
                    </button>
                    <button onClick={() => rejectChange(pc.id)} className="p-1 rounded hover:bg-[#f8514944]" title="拒绝更改">
                      <XCircle className="w-3.5 h-3.5" style={{ color: '#f85149' }} />
                    </button>
                  </>
                )}
                {pc.status === 'accepted' && <span className="text-[11px] flex items-center gap-0.5 px-1" style={{ color: '#3fb950' }}><Check className="w-3 h-3" />已接受</span>}
                {pc.status === 'rejected' && <span className="text-[11px] px-1 line-through" style={{ color: '#f85149' }}>已拒绝</span>}
              </div>
            </div>
          </div>
        )
      })}
    </>)
  }

  // ===== Plan card renderer =====
  const renderPlanCard = (planPath: string) => {
    const fileName = planPath.split('/').pop() || planPath
    return (
      <div className="mt-1.5 rounded overflow-hidden" style={{ border: '1px solid #007acc', background: '#1e1e1e' }}>
        <div className="flex items-center gap-2 px-2.5 py-2" style={{ background: '#007acc22' }}>
          <ListChecks className="w-4 h-4 shrink-0" style={{ color: '#007acc' }} />
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-medium" style={{ color: '#cccccc' }}>计划已生成</div>
            <div className="text-[11px] font-mono truncate" style={{ color: '#969696' }}>{fileName}</div>
          </div>
        </div>
        {/* Preview TODOs */}
        {planTodos.length > 0 && (
          <div className="px-2.5 py-1.5 space-y-0.5">
            {planTodos.slice(0, 8).map((todo, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[12px]" style={{ color: '#cccccc' }}>
                <span className="w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0" style={{
                  borderColor: todo.done ? '#3fb950' : '#6e7681',
                  background: todo.done ? '#3fb95022' : 'transparent',
                }}>
                  {todo.done && <Check className="w-2.5 h-2.5" style={{ color: '#3fb950' }} />}
                </span>
                <span className={todo.done ? 'line-through opacity-50' : ''} style={{ color: todo.done ? '#969696' : '#cccccc' }}>
                  {todo.text.substring(0, 50)}{todo.text.length > 50 ? '...' : ''}
                </span>
              </div>
            ))}
            {planTodos.length > 8 && <div className="text-[11px]" style={{ color: '#969696' }}>...还有 {planTodos.length - 8} 项</div>}
          </div>
        )}
        {/* Action buttons */}
        <div className="flex items-center gap-2 px-2.5 py-2" style={{ borderTop: '1px solid #3c3c3c' }}>
          <button onClick={() => onOpenFile(planPath)} className="flex items-center gap-1 px-2 py-1 rounded text-[12px] hover:bg-[#2a2d2e]" style={{ color: '#58a6ff' }}>
            <ExternalLink className="w-3 h-3" />在编辑器打开
          </button>
          <button onClick={executePlan} disabled={loading} className="flex items-center gap-1 px-2 py-1 rounded text-[12px]" style={{ background: '#007acc', color: '#ffffff' }}>
            <Play className="w-3 h-3" />执行计划
          </button>
        </div>
      </div>
    )
  }

  // Group conversations by date
  const groupedConversations = useMemo(() => {
    const now = Date.now()
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1)
    const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7)

    const groups: Array<{ label: string; items: ConvSummary[] }> = [
      { label: '今天', items: [] },
      { label: '昨天', items: [] },
      { label: '本周', items: [] },
      { label: '更早', items: [] },
    ]
    for (const c of conversations) {
      if (c.updatedAt >= today.getTime()) groups[0].items.push(c)
      else if (c.updatedAt >= yesterday.getTime()) groups[1].items.push(c)
      else if (c.updatedAt >= weekAgo.getTime()) groups[2].items.push(c)
      else groups[3].items.push(c)
    }
    return groups.filter((g) => g.items.length > 0)
  }, [conversations])

  // ===== Render =====
  return (
    <div className="flex flex-col h-full w-[360px] shrink-0" style={{ background: '#252526', borderLeft: '1px solid #3c3c3c' }}>

      {/* ===== CONVERSATION LIST VIEW ===== */}
      {view === 'list' && (
        <>
          <div className="flex items-center justify-between px-3 h-[40px] shrink-0" style={{ borderBottom: '1px solid #3c3c3c' }}>
            <span className="text-[13px] font-medium" style={{ color: '#cccccc' }}>AI 对话</span>
            <div className="flex items-center gap-1">
              <button onClick={createNewConversation} className="flex items-center gap-1 px-2 py-1 rounded text-[12px] hover:bg-[#2a2d2e]" style={{ color: '#58a6ff' }}>
                <Plus className="w-3.5 h-3.5" /> 新对话
              </button>
              <button onClick={onClose} className="p-1 rounded hover:bg-[#2a2d2e]" style={{ color: '#969696' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {groupedConversations.length === 0 && (
              <div className="flex flex-col items-center justify-center py-12" style={{ color: '#6e7681' }}>
                <MessageSquare className="w-10 h-10 mb-3 opacity-30" />
                <p className="text-[14px] mb-1">暂无对话</p>
                <p className="text-[12px]">点击"新对话"开始</p>
              </div>
            )}
            {groupedConversations.map((group) => (
              <div key={group.label}>
                <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#969696' }}>
                  <Clock className="w-3 h-3 inline mr-1" />{group.label}
                </div>
                {group.items.map((conv) => (
                  <div key={conv.id} onClick={() => openConversation(conv.id)}
                    className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[#2a2d2e] group mx-1 rounded"
                    style={{ color: '#cccccc' }}>
                    <Sparkles className="w-4 h-4 shrink-0" style={{ color: '#969696' }} />
                    <span className="text-[13px] truncate flex-1">{conv.title}</span>
                    <button onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id) }}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#3c3c3c]" style={{ color: '#f85149' }}>
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      {/* ===== CHAT VIEW ===== */}
      {view === 'chat' && (
        <>
          {/* Header row 1: back + title */}
          <div className="flex items-center gap-1 px-2 h-[36px] shrink-0" style={{ borderBottom: '1px solid #3c3c3c' }}>
            <button onClick={goBackToList} className="p-1 rounded hover:bg-[#2a2d2e]" style={{ color: '#969696' }} title="返回对话列表">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[13px] truncate flex-1" style={{ color: '#cccccc' }}>
              {messages.find((m) => m.role === 'user')?.content.substring(0, 25) || '新对话'}
            </span>
            <button onClick={onClose} className="p-1 rounded hover:bg-[#2a2d2e]" style={{ color: '#969696' }}>
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Active plan indicator */}
          {activePlanPath && planTotal > 0 && (
            <div className="flex items-center gap-2 px-2 h-[28px] shrink-0 cursor-pointer hover:bg-[#2a2d2e]"
              style={{ borderBottom: '1px solid #3c3c3c', background: '#007acc11' }}
              onClick={() => onOpenFile(activePlanPath)}>
              <ListChecks className="w-3.5 h-3.5 shrink-0" style={{ color: '#007acc' }} />
              <span className="text-[12px] truncate" style={{ color: '#cccccc' }}>
                {activePlanPath.split('/').pop()}
              </span>
              <div className="flex items-center gap-1 ml-auto shrink-0">
                <div className="w-[50px] h-[4px] rounded-full overflow-hidden" style={{ background: '#3c3c3c' }}>
                  <div className="h-full rounded-full" style={{ width: `${planTotal > 0 ? (planDone / planTotal) * 100 : 0}%`, background: planDone === planTotal ? '#3fb950' : '#007acc' }} />
                </div>
                <span className="text-[11px] tabular-nums" style={{ color: '#969696' }}>{planDone}/{planTotal}</span>
                <button onClick={(e) => { e.stopPropagation(); executePlan() }} disabled={loading || planDone === planTotal}
                  className="p-0.5 rounded hover:bg-[#007acc33] disabled:opacity-30" title="执行计划">
                  <Play className="w-3 h-3" style={{ color: '#007acc' }} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); setActivePlanPath(null); setPlanTodos([]) }}
                  className="p-0.5 rounded hover:bg-[#3c3c3c]" title="取消计划" style={{ color: '#969696' }}>
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}

          {/* Header row 2: mode + progress + compress + scan */}
          <div className="flex items-center gap-1.5 px-2 h-[32px] shrink-0" style={{ borderBottom: '1px solid #3c3c3c' }}>
            {/* Mode dropdown */}
            <div className="relative">
              <button onClick={() => setShowModePicker(!showModePicker)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[12px] hover:bg-[#2a2d2e]"
                style={{ color: mode === 'agent' ? '#d4b37b' : '#cccccc' }}>
                <currentModeInfo.icon className="w-3 h-3" />
                {currentModeInfo.label}
                <ChevronDown className="w-3 h-3" />
              </button>
              {showModePicker && (
                <><div className="fixed inset-0 z-50" onClick={() => setShowModePicker(false)} />
                  <div className="absolute left-0 top-full mt-1 z-50 rounded shadow-lg py-1 min-w-[200px]" style={{ background: '#252526', border: '1px solid #3c3c3c' }}>
                    {MODES.map((m) => (
                      <button key={m.id} onClick={() => { setMode(m.id); setShowModePicker(false) }}
                        className="flex items-center gap-2 w-full px-3 py-2 text-[12px] hover:bg-[#094771]"
                        style={{ color: mode === m.id ? '#ffffff' : '#cccccc' }}>
                        <m.icon className="w-3.5 h-3.5 shrink-0" />
                        <div className="text-left"><div className="font-medium">{m.label}</div><div className="text-[11px]" style={{ color: '#969696' }}>{m.desc}</div></div>
                      </button>
                    ))}
                  </div></>
              )}
            </div>

            {/* Token progress bar */}
            <div className="flex-1 flex items-center gap-1.5 group relative" title={`项目 ${formatTokens(tokenBreakdown.summaryTok)} / 历史 ${formatTokens(tokenBreakdown.historyTok)} / 文件 ${formatTokens(tokenBreakdown.fileTok)} / 输入 ${formatTokens(tokenBreakdown.inputTok)}`}>
              <div className="flex-1 h-[6px] rounded-full overflow-hidden" style={{ background: '#3c3c3c' }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${tokenPercent}%`, background: tokenColor }} />
              </div>
              <span className="text-[10px] shrink-0 tabular-nums" style={{ color: '#969696' }}>
                {formatTokens(tokenBreakdown.total)}/{formatTokens(maxTokens)}
              </span>
              {/* Tooltip */}
              <div className="absolute left-0 top-full mt-1 z-50 hidden group-hover:block rounded px-2 py-1.5 text-[11px] min-w-[160px] shadow-lg" style={{ background: '#1e1e1e', border: '1px solid #3c3c3c', color: '#cccccc' }}>
                <div>项目摘要: {formatTokens(tokenBreakdown.summaryTok)}</div>
                <div>历史消息: {formatTokens(tokenBreakdown.historyTok)}</div>
                <div>当前文件: {formatTokens(tokenBreakdown.fileTok)}</div>
                <div>输入: {formatTokens(tokenBreakdown.inputTok)}</div>
                <div className="mt-1 pt-1" style={{ borderTop: '1px solid #3c3c3c' }}>上限: {formatTokens(maxTokens)} ({currentModel})</div>
              </div>
            </div>

            {/* Compress button */}
            <button onClick={compressContext} className="p-1 rounded hover:bg-[#2a2d2e]" title="压缩上下文" style={{ color: '#969696' }}>
              <Minimize2 className="w-3 h-3" />
            </button>

            {/* Scan status */}
            <div className="relative">
              <button onClick={scanProject} disabled={scanning} className="p-1 rounded hover:bg-[#2a2d2e]" title={projectScanned ? '已扫描项目' : '扫描项目'}>
                {scanning ? <Loader2 className="w-3 h-3 animate-spin" style={{ color: '#969696' }} /> : <FolderSearch className="w-3 h-3" style={{ color: '#969696' }} />}
              </button>
              {projectScanned && <span className="absolute -top-0.5 -right-0.5 w-[6px] h-[6px] rounded-full" style={{ background: '#3fb950' }} />}
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
            {messages.length === 0 && (
              <div className="text-center py-8" style={{ color: '#6e7681' }}>
                <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-[13px]">{currentModeInfo.desc}</p>
              </div>
            )}
            {messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === 'system' ? (
                  <div className="text-[12px] rounded px-2 py-1.5" style={{ color: '#969696', background: '#2d2d2d' }}>
                    {msg.content}
                    {msg.toolCalls?.map((tc, i) => {
                      const Icon = toolIcons[tc.tool] || Terminal
                      return (
                        <div key={i} className="mt-1 px-2 py-1.5 rounded" style={{ background: '#1e1e1e', border: '1px solid #3c3c3c' }}>
                          <div className="flex items-center gap-1.5 text-[12px]">
                            <Icon className="w-3 h-3 shrink-0" style={{ color: '#58a6ff' }} />
                            <span style={{ color: '#cccccc' }}>{toolLabels[tc.tool]}</span>
                            {tc.args?.path && <span className="font-mono opacity-70 truncate">{tc.args.path}</span>}
                            {tc.args?.cmd && <span className="font-mono opacity-70 truncate">{tc.args.cmd}</span>}
                            <Check className="w-3 h-3 shrink-0 ml-auto" style={{ color: '#3fb950' }} />
                          </div>
                          {tc.result && (
                            <details className="mt-1"><summary className="text-[11px] cursor-pointer" style={{ color: '#969696' }}>查看结果</summary>
                              <pre className="mt-1 p-1.5 rounded text-[11px] font-mono overflow-x-auto max-h-[150px] overflow-y-auto" style={{ background: '#1e1e1e', color: '#969696', userSelect: 'text' }}>
                                {tc.result.substring(0, 1000)}{tc.result.length > 1000 ? '...' : ''}
                              </pre>
                            </details>
                          )}
                        </div>
                      )
                    })}
                    {msg.pendingChanges && renderPendingChanges(msg.pendingChanges)}
                    {msg.planPath && renderPlanCard(msg.planPath)}
                  </div>
                ) : (
                  <div className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className="max-w-[95%] rounded-lg px-3 py-2 text-[13px]" style={{
                      background: msg.role === 'user' ? '#007acc' : '#2d2d2d',
                      color: msg.role === 'user' ? '#ffffff' : '#cccccc'
                    }}>
                      {msg.role === 'assistant' ? renderContent(msg) : msg.content}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {toolStatus && (
              <div className="flex items-center gap-2 rounded px-2 py-1.5 text-[12px]" style={{ background: '#2d2d2d', border: '1px solid #d2992233', color: '#d29922' }}>
                <Loader2 className="w-3 h-3 animate-spin shrink-0" />{toolStatus}
              </div>
            )}
            {loading && !toolStatus && (
              <div className="flex justify-start"><div className="rounded-lg px-3 py-2 text-[13px] flex items-center gap-2" style={{ background: '#2d2d2d', color: '#969696' }}>
                <Loader2 className="w-3 h-3 animate-spin" />思考中...
              </div></div>
            )}
          </div>

          {/* Input */}
          <div className="px-3 py-2 shrink-0" style={{ borderTop: '1px solid #3c3c3c' }}>
            <div className="flex gap-2">
              <textarea value={input} onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                placeholder={currentModeInfo.desc}
                rows={2} className="flex-1 px-2.5 py-1.5 rounded-lg text-[13px] outline-none resize-none"
                style={{ background: '#3c3c3c', color: '#cccccc', border: '1px solid #3c3c3c' }}
                onFocus={(e) => (e.target.style.borderColor = '#007fd4')}
                onBlur={(e) => (e.target.style.borderColor = '#3c3c3c')}
                disabled={loading} />
              <button onClick={handleSend} disabled={loading || !input.trim()}
                className="self-end p-2 rounded-lg disabled:opacity-30" style={{ background: '#007acc', color: '#ffffff' }}>
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
