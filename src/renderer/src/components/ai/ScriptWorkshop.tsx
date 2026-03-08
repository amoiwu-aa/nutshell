import { useState } from 'react'
import {
  Sparkles, Copy, Save, X, Loader2, Play, FileText,
  Terminal, Container, Server, Clock, Settings, Check, History, Trash2, ExternalLink
} from 'lucide-react'
import { cn } from '../../lib/utils'

interface ScriptWorkshopProps {
  isOpen: boolean
  onClose: () => void
  sessionId?: string
}

interface HistoryItem {
  id: string
  type: string
  description: string
  code: string
  savedPath?: string
  timestamp: number
}

const scriptTypes = [
  { id: 'shell', label: 'Shell', icon: Terminal, ext: '.sh', placeholder: '例如：自动备份 MySQL 数据库到 /backup，保留最近7天' },
  { id: 'dockerfile', label: 'Dockerfile', icon: Container, ext: '', placeholder: '例如：基于 Node.js 18 构建前端项目镜像' },
  { id: 'compose', label: 'Compose', icon: Container, ext: '.yml', placeholder: '例如：WordPress + MySQL + Redis' },
  { id: 'nginx', label: 'Nginx', icon: Server, ext: '.conf', placeholder: '例如：反向代理 /api 到 localhost:3000' },
  { id: 'systemd', label: 'Systemd', icon: Settings, ext: '.service', placeholder: '例如：创建 service 运行 /opt/app 并开机自启' },
  { id: 'crontab', label: 'Crontab', icon: Clock, ext: '', placeholder: '例如：每天凌晨3点备份数据库' }
]

export function ScriptWorkshop({ isOpen, onClose, sessionId }: ScriptWorkshopProps) {
  const [activeType, setActiveType] = useState('shell')

  // Per-type state: each type keeps its own code and description
  const [typeStates, setTypeStates] = useState<Record<string, { description: string; code: string }>>({})

  const [loading, setLoading] = useState(false)
  const [savePath, setSavePath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveResult, setSaveResult] = useState('')
  const [execResult, setExecResult] = useState('')

  // History
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [showHistory, setShowHistory] = useState(false)

  const currentType = scriptTypes.find((t) => t.id === activeType) || scriptTypes[0]

  // Get/set per-type state
  const currentState = typeStates[activeType] || { description: '', code: '' }
  const setCurrentDescription = (desc: string) => {
    setTypeStates((prev) => ({ ...prev, [activeType]: { ...currentState, description: desc } }))
  }
  const setCurrentCode = (code: string) => {
    setTypeStates((prev) => ({ ...prev, [activeType]: { ...currentState, code } }))
  }

  const handleGenerate = async () => {
    if (!currentState.description.trim() || loading) return
    setLoading(true); setSaveResult(''); setExecResult('')
    try {
      const result = await window.api.ai.generateScript(activeType, currentState.description)
      if (result.success) {
        const match = result.content.match(/```[\w]*\n?([\s\S]*?)```/)
        const code = match ? match[1].trim() : result.content
        setCurrentCode(code)

        // Add to history
        setHistory((prev) => [{
          id: `${Date.now()}`,
          type: activeType,
          description: currentState.description,
          code,
          timestamp: Date.now()
        }, ...prev].slice(0, 50)) // Keep max 50 items
      } else {
        setCurrentCode(`# 错误: ${result.error}`)
      }
    } catch (err: any) {
      setCurrentCode(`# 请求失败: ${err.message}`)
    }
    setLoading(false)
  }

  const handleSaveToServer = async () => {
    if (!savePath.trim() || !sessionId || !currentState.code) return
    setSaving(true); setSaveResult('')
    try {
      const r = await window.api.sftp.writeFile(sessionId, savePath, currentState.code)
      if (r.success) {
        let msg = '已保存'
        if (activeType === 'shell' && savePath.endsWith('.sh')) {
          await window.api.sftp.chmod(sessionId, savePath, '755')
          msg = '已保存 (chmod 755)'
        }
        setSaveResult(msg)
        // Update history with saved path
        setHistory((prev) => prev.map((h) =>
          h.code === currentState.code && !h.savedPath ? { ...h, savedPath: savePath } : h
        ))
      } else { setSaveResult(`失败: ${r.error}`) }
    } catch (err: any) { setSaveResult(`失败: ${err.message}`) }
    setSaving(false)
  }

  const handleExecuteInTerminal = () => {
    if (!sessionId || !currentState.code) return
    const tempPath = '/tmp/nutshell_script_' + Date.now() + '.sh'
    const escapedContent = currentState.code.replace(/'/g, "'\\''")
    window.api.ssh.write(sessionId, `echo '${escapedContent}' > ${tempPath} && chmod +x ${tempPath} && bash ${tempPath} ; rm -f ${tempPath}\n`)
    setExecResult('已发送到终端')
  }

  const loadFromHistory = (item: HistoryItem) => {
    setActiveType(item.type)
    setTypeStates((prev) => ({ ...prev, [item.type]: { description: item.description, code: item.code } }))
    if (item.savedPath) setSavePath(item.savedPath)
    setShowHistory(false)
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  const typeLabel = (id: string) => scriptTypes.find((t) => t.id === id)?.label || id

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="absolute inset-0 bg-black/50 dialog-overlay" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[880px] dialog-content flex flex-col" style={{ height: '82vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-primary/15 flex items-center justify-center"><Sparkles className="w-3.5 h-3.5 text-primary" /></div>
            <h2 className="text-sm font-semibold">AI 脚本工坊</h2>
            {!sessionId && <span className="text-xs text-yellow-400 bg-yellow-500/10 px-2 py-0.5 rounded">未连接</span>}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowHistory(!showHistory)}
              className={cn('flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
                showHistory ? 'bg-primary/20 text-primary' : 'hover:bg-accent text-muted-foreground')}>
              <History className="w-3.5 h-3.5" /> 历史 ({history.length})
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
          </div>
        </div>

        {/* Type tabs */}
        <div className="flex items-center gap-1 px-5 py-2 border-b border-border shrink-0">
          {scriptTypes.map((t) => {
            const hasCode = !!typeStates[t.id]?.code
            return (
              <button key={t.id} onClick={() => { setActiveType(t.id); setSaveResult(''); setExecResult('') }}
                className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-colors relative',
                  activeType === t.id ? 'bg-primary text-primary-foreground shadow-[0_0_10px_hsl(var(--primary)/0.3)]' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80')}>
                <t.icon className="w-3.5 h-3.5" />{t.label}
                {hasCode && activeType !== t.id && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full" />}
              </button>
            )
          })}
        </div>

        {/* History panel (overlay) */}
        {showHistory && (
          <div className="absolute inset-0 z-10 bg-card rounded-xl flex flex-col" style={{ top: 85 }}>
            <div className="flex items-center justify-between px-5 py-2.5 border-b border-border shrink-0">
              <h3 className="text-sm font-medium">生成历史</h3>
              <div className="flex items-center gap-2">
                {history.length > 0 && <button onClick={() => setHistory([])} className="text-xs text-destructive hover:underline">清空</button>}
                <button onClick={() => setShowHistory(false)} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {history.length === 0 ? (
                <div className="flex items-center justify-center h-full text-muted-foreground text-xs">暂无历史记录</div>
              ) : (
                <div className="divide-y divide-border">
                  {history.map((item) => (
                    <div key={item.id} onClick={() => loadFromHistory(item)} className="px-5 py-3 hover:bg-accent/50 cursor-pointer transition-colors">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="px-1.5 py-0.5 bg-secondary rounded text-xs">{typeLabel(item.type)}</span>
                          <span className="text-xs text-muted-foreground">{formatTime(item.timestamp)}</span>
                        </div>
                        {item.savedPath && (
                          <span className="flex items-center gap-1 text-xs text-green-500">
                            <ExternalLink className="w-3 h-3" />{item.savedPath}
                          </span>
                        )}
                      </div>
                      <p className="text-xs font-medium mb-1 truncate">{item.description}</p>
                      <pre className="text-xs text-muted-foreground font-mono truncate">{item.code.substring(0, 100)}</pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Main content */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left panel */}
          <div className="w-[260px] border-r border-border flex flex-col shrink-0">
            <div className="flex-1 p-3 flex flex-col gap-2">
              <label className="text-xs font-medium text-muted-foreground">需求描述</label>
              <textarea value={currentState.description} onChange={(e) => setCurrentDescription(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && e.ctrlKey) handleGenerate() }}
                placeholder={currentType.placeholder}
                className="flex-1 w-full min-h-[80px] px-3 py-2 bg-background border border-input rounded-lg text-xs outline-none resize-none focus:ring-1 focus:ring-ring" />

              <button onClick={handleGenerate} disabled={loading || !currentState.description.trim()}
                className="flex items-center justify-center gap-2 w-full py-2 bg-primary text-primary-foreground rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-primary/90 btn-glow">
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                {loading ? '生成中...' : '生成 (Ctrl+Enter)'}
              </button>
            </div>

            {/* Actions */}
            {currentState.code && (
              <div className="p-3 border-t border-border space-y-2">
                {sessionId && (
                  <>
                    <label className="text-xs font-medium text-muted-foreground">保存到服务器</label>
                    <div className="flex gap-1.5">
                      <input type="text" value={savePath} onChange={(e) => setSavePath(e.target.value)}
                        placeholder={`/opt/script${currentType.ext}`}
                        className="flex-1 px-2 py-1.5 bg-background border border-input rounded text-xs outline-none font-mono" />
                      <button onClick={handleSaveToServer} disabled={saving || !savePath.trim()}
                        className="flex items-center gap-1 px-2.5 py-1.5 bg-green-600 text-white rounded text-xs disabled:opacity-50 hover:bg-green-700 shrink-0">
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      </button>
                    </div>
                    {saveResult && <p className={cn('text-xs flex items-center gap-1', saveResult.includes('失败') ? 'text-destructive' : 'text-green-500')}>{!saveResult.includes('失败') && <Check className="w-3 h-3" />}{saveResult}</p>}
                  </>
                )}
                {activeType === 'shell' && sessionId && (
                  <>
                    <button onClick={handleExecuteInTerminal}
                      className="flex items-center gap-1.5 w-full justify-center py-1.5 bg-yellow-600 text-white rounded text-xs font-medium hover:bg-yellow-700">
                      <Play className="w-3.5 h-3.5" /> 在终端执行
                    </button>
                    {execResult && <p className="text-xs text-green-500 flex items-center gap-1"><Check className="w-3 h-3" />{execResult}</p>}
                  </>
                )}
                {!sessionId && <p className="text-xs text-muted-foreground">连接服务器后可保存和执行</p>}
              </div>
            )}
          </div>

          {/* Right: Code editor */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-1.5 border-b border-border shrink-0 bg-[#0d1117]">
              <span className="text-xs text-[#8b949e]">{currentType.label}</span>
              {currentState.code && (
                <button onClick={() => navigator.clipboard.writeText(currentState.code)}
                  className="flex items-center gap-1 px-2 py-0.5 text-xs text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#161b22] rounded">
                  <Copy className="w-3 h-3" /> 复制
                </button>
              )}
            </div>
            <div className="flex-1 overflow-hidden">
              {currentState.code ? (
                <textarea value={currentState.code} onChange={(e) => setCurrentCode(e.target.value)}
                  className="w-full h-full p-4 bg-[#0d1117] text-[#c9d1d9] font-mono text-xs outline-none resize-none leading-[1.6rem]"
                  style={{ tabSize: 2, userSelect: 'text' }} spellCheck={false} />
              ) : (
                <div className="flex items-center justify-center h-full bg-[#0d1117]">
                  {loading ? (
                    <div className="text-center"><Loader2 className="w-6 h-6 mx-auto mb-2 text-primary animate-spin" /><p className="text-xs text-[#8b949e]">生成中...</p></div>
                  ) : (
                    <div className="text-center"><FileText className="w-8 h-8 mx-auto mb-2 text-[#30363d]" /><p className="text-xs text-[#8b949e]">描述需求后点击生成</p></div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
