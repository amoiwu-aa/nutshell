import { useState, useEffect, useRef, useCallback } from 'react'
import {
  ArrowRightLeft,
  Plus,
  Trash2,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  ExternalLink
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { v4 as uuidv4 } from 'uuid'

interface PortForwardRule {
  id: string
  connectionId: string
  type: 'local' | 'remote' | 'dynamic'
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
  enabled: boolean
}

interface PortForwardPanelProps {
  sessionId: string
}

const typeLabels: Record<string, string> = {
  local: '本地',
  remote: '远程',
  dynamic: 'SOCKS5'
}

const typeColors: Record<string, string> = {
  local: 'bg-blue-500/10 text-blue-400',
  remote: 'bg-amber-500/10 text-amber-400',
  dynamic: 'bg-purple-500/10 text-purple-400'
}

export function PortForwardPanel({ sessionId }: PortForwardPanelProps) {
  const [rules, setRules] = useState<PortForwardRule[]>([])
  const [ruleStatuses, setRuleStatuses] = useState<Record<string, string>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const [error, setError] = useState('')

  // Quick add state
  const [addPort, setAddPort] = useState('')
  const [addType, setAddType] = useState<'local' | 'remote' | 'dynamic'>('local')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advLocalHost, setAdvLocalHost] = useState('127.0.0.1')
  const [advRemoteHost, setAdvRemoteHost] = useState('127.0.0.1')
  const [advRemotePort, setAdvRemotePort] = useState('')
  const [showTypeMenu, setShowTypeMenu] = useState(false)
  const [creating, setCreating] = useState(false)

  const portInputRef = useRef<HTMLInputElement>(null)
  const prevSessionId = useRef(sessionId)

  // Load rules when sessionId changes
  useEffect(() => {
    if (sessionId !== prevSessionId.current) {
      prevSessionId.current = sessionId
    }
    loadRules()
  }, [sessionId])

  // Listen for status updates
  useEffect(() => {
    const removeListener = window.api.portForward.onStatus((ruleId, status) => {
      setRuleStatuses((prev) => ({ ...prev, [ruleId]: status }))
    })
    return () => removeListener()
  }, [])

  const loadRules = async () => {
    const result = await window.api.portForward.list(sessionId)
    if (result.success) {
      setRules(result.rules)
    }
  }

  const handleQuickAdd = useCallback(async () => {
    const port = parseInt(addPort)
    if (!port || port < 1 || port > 65535 || creating) return

    setCreating(true)
    setError('')
    const remotePort = advRemotePort ? parseInt(advRemotePort) || port : port
    const rule: PortForwardRule = {
      id: uuidv4(),
      connectionId: sessionId,
      type: addType,
      localHost: advLocalHost || '127.0.0.1',
      localPort: port,
      remoteHost: addType === 'dynamic' ? '127.0.0.1' : (advRemoteHost || '127.0.0.1'),
      remotePort: addType === 'dynamic' ? 0 : remotePort,
      enabled: true
    }

    try {
      const result = await window.api.portForward.create(rule)
      if (result.success) {
        setRules((prev) => [...prev, rule])
        setAddPort('')
        setAdvRemotePort('')
        setShowAdvanced(false)
        portInputRef.current?.focus()
      } else {
        setError(result.error || '创建失败')
      }
    } catch (err: any) {
      setError(err.message || '创建失败')
    }
    setCreating(false)
  }, [addPort, addType, advLocalHost, advRemoteHost, advRemotePort, sessionId, creating])

  const handleRemove = async (ruleId: string) => {
    await window.api.portForward.remove(ruleId)
    setRules((prev) => prev.filter((r) => r.id !== ruleId))
    setRuleStatuses((prev) => {
      const next = { ...prev }
      delete next[ruleId]
      return next
    })
  }

  const handleCopy = (rule: PortForwardRule) => {
    const addr = `${rule.localHost}:${rule.localPort}`
    navigator.clipboard.writeText(addr)
    setCopiedId(rule.id)
    setTimeout(() => setCopiedId(null), 1500)
  }

  const getStatusInfo = (ruleId: string) => {
    const status = ruleStatuses[ruleId]
    if (status === 'active') return { color: 'bg-green-500', label: '活跃' }
    if (status?.startsWith('error')) return { color: 'bg-red-500', label: status.replace('error: ', '') }
    if (status === 'stopped') return { color: 'bg-muted-foreground', label: '已停止' }
    return { color: 'bg-muted-foreground', label: '等待中' }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card border-b border-border z-10">
            <tr className="text-xs text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium w-10"></th>
              <th className="text-left px-3 py-2 font-medium">端口</th>
              <th className="text-left px-3 py-2 font-medium">类型</th>
              <th className="text-left px-3 py-2 font-medium">本地地址</th>
              <th className="text-left px-3 py-2 font-medium">远程地址</th>
              <th className="text-left px-3 py-2 font-medium w-20">状态</th>
              <th className="text-right px-3 py-2 font-medium w-20">操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-8 text-muted-foreground">
                  <div className="flex flex-col items-center gap-1.5">
                    <ArrowRightLeft className="w-5 h-5 opacity-40" />
                    <span className="text-xs">暂无端口转发规则，在下方输入端口号快速添加</span>
                  </div>
                </td>
              </tr>
            ) : (
              rules.map((rule) => {
                const status = getStatusInfo(rule.id)
                return (
                  <tr
                    key={rule.id}
                    className="border-b border-border/30 hover:bg-accent/30 transition-colors group"
                  >
                    {/* Status dot */}
                    <td className="px-3 py-2">
                      <div
                        className={cn('w-2 h-2 rounded-full', status.color)}
                        title={status.label}
                      />
                    </td>
                    {/* Port */}
                    <td className="px-3 py-2 font-mono text-xs font-medium">
                      {rule.localPort}
                    </td>
                    {/* Type badge */}
                    <td className="px-3 py-2">
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', typeColors[rule.type])}>
                        {typeLabels[rule.type]}
                      </span>
                    </td>
                    {/* Local address */}
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {rule.localHost}:{rule.localPort}
                    </td>
                    {/* Remote address */}
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {rule.type === 'dynamic' ? (
                        <span className="flex items-center gap-1">
                          <Globe className="w-3 h-3" />
                          <span>动态代理</span>
                        </span>
                      ) : (
                        `${rule.remoteHost}:${rule.remotePort}`
                      )}
                    </td>
                    {/* Status text */}
                    <td className="px-3 py-2">
                      <span className={cn(
                        'text-[10px]',
                        status.color === 'bg-green-500' ? 'text-green-400' :
                        status.color === 'bg-red-500' ? 'text-red-400' :
                        'text-muted-foreground'
                      )}>
                        {status.label}
                      </span>
                    </td>
                    {/* Actions */}
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => window.open(`http://${rule.localHost}:${rule.localPort}`, '_blank')}
                          className="p-1 hover:bg-accent rounded transition-colors"
                          title="在浏览器中打开"
                        >
                          <ExternalLink className="w-3 h-3 text-muted-foreground" />
                        </button>
                        <button
                          onClick={() => handleCopy(rule)}
                          className="p-1 hover:bg-accent rounded transition-colors"
                          title="复制本地地址"
                        >
                          {copiedId === rule.id ? (
                            <Check className="w-3 h-3 text-green-400" />
                          ) : (
                            <Copy className="w-3 h-3 text-muted-foreground" />
                          )}
                        </button>
                        <button
                          onClick={() => handleRemove(rule.id)}
                          className="p-1 hover:bg-accent rounded transition-colors"
                          title="删除"
                        >
                          <Trash2 className="w-3 h-3 text-destructive" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Error message */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-red-500/10 border-t border-red-500/20 text-red-400 text-xs">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="text-red-400/60 hover:text-red-400">x</button>
        </div>
      )}

      {/* Quick add bar */}
      <div className="border-t border-border bg-background/50 shrink-0">
        <div className="flex items-center gap-2 px-3 py-1.5">
          <Plus className="w-3.5 h-3.5 text-muted-foreground shrink-0" />

          {/* Port input */}
          <input
            ref={portInputRef}
            type="number"
            value={addPort}
            onChange={(e) => setAddPort(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleQuickAdd() }}
            placeholder="输入端口号..."
            min={1}
            max={65535}
            className="w-24 px-2 py-1 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />

          {/* Type selector */}
          <div className="relative">
            <button
              onClick={() => setShowTypeMenu(!showTypeMenu)}
              className="flex items-center gap-1 px-2 py-1 bg-secondary rounded text-xs hover:bg-secondary/80 transition-colors"
            >
              <span className={cn('w-1.5 h-1.5 rounded-full', addType === 'local' ? 'bg-blue-400' : addType === 'remote' ? 'bg-amber-400' : 'bg-purple-400')} />
              {typeLabels[addType]}
              <ChevronDown className="w-3 h-3" />
            </button>
            {showTypeMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowTypeMenu(false)} />
                <div className="absolute bottom-full left-0 mb-1 z-50 bg-card border border-border rounded-md shadow-lg py-1 min-w-[120px]">
                  {(['local', 'remote', 'dynamic'] as const).map((type) => (
                    <button
                      key={type}
                      onClick={() => { setAddType(type); setShowTypeMenu(false) }}
                      className={cn(
                        'flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent transition-colors',
                        addType === type && 'text-primary'
                      )}
                    >
                      <span className={cn('w-1.5 h-1.5 rounded-full', type === 'local' ? 'bg-blue-400' : type === 'remote' ? 'bg-amber-400' : 'bg-purple-400')} />
                      {typeLabels[type]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Advanced toggle */}
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-1 px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {showAdvanced ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            高级
          </button>

          <div className="flex-1" />

          {/* Add button */}
          <button
            onClick={handleQuickAdd}
            disabled={!addPort || creating}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            <Plus className="w-3 h-3" />
            转发
          </button>
        </div>

        {/* Advanced options */}
        {showAdvanced && (
          <div className="flex items-center gap-3 px-3 pb-2 pt-0.5">
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-muted-foreground shrink-0">本地地址</label>
              <input
                type="text"
                value={advLocalHost}
                onChange={(e) => setAdvLocalHost(e.target.value)}
                className="w-28 px-1.5 py-0.5 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring font-mono"
              />
            </div>
            {addType !== 'dynamic' && (
              <>
                <div className="flex items-center gap-1.5">
                  <label className="text-[10px] text-muted-foreground shrink-0">远程地址</label>
                  <input
                    type="text"
                    value={advRemoteHost}
                    onChange={(e) => setAdvRemoteHost(e.target.value)}
                    className="w-28 px-1.5 py-0.5 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring font-mono"
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="text-[10px] text-muted-foreground shrink-0">远程端口</label>
                  <input
                    type="number"
                    value={advRemotePort}
                    onChange={(e) => setAdvRemotePort(e.target.value)}
                    placeholder="同本地"
                    className="w-20 px-1.5 py-0.5 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
