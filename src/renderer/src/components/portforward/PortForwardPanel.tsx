import { useState, useEffect, useRef, useCallback } from 'react'
import {
  ArrowRightLeft,
  ArrowRight,
  Plus,
  Trash2,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Globe,
  ExternalLink,
  Chrome
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
    return () => {
      removeListener()
    }
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
    const isRemote = rule.type === 'remote'
    const addr = isRemote ? `${rule.remoteHost}:${rule.remotePort}` : `${rule.localHost}:${rule.localPort}`
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
          <thead className="sticky top-0 bg-card/90 backdrop-blur-sm border-b border-border z-10">
            <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
              <th className="text-left px-3 py-2 font-medium w-10"></th>
              <th className="text-left px-3 py-2 font-medium w-20">类型</th>
              <th className="text-left px-3 py-2 font-medium">监听入口</th>
              <th className="text-center px-1 py-2 font-medium text-muted-foreground/40 w-8">方向</th>
              <th className="text-left px-3 py-2 font-medium">转发目标</th>
              <th className="text-left px-3 py-2 font-medium w-24">状态</th>
              <th className="text-right px-3 py-2 font-medium w-32">操作</th>
            </tr>
          </thead>
          <tbody>
            {rules.length === 0 ? (
              <tr>
                <td colSpan={7} className="text-center py-10 text-muted-foreground">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-10 h-10 rounded-full bg-accent/50 flex flex-col items-center justify-center">
                      <ArrowRightLeft className="w-5 h-5 opacity-40" />
                    </div>
                    <span className="text-sm font-medium">暂无端口转发规则</span>
                    <span className="text-xs opacity-60">在下方输入端口号快速添加</span>
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
                    <td className="px-3 py-2.5 text-center">
                      <div
                        className={cn('w-2 h-2 rounded-full mx-auto shadow-sm', status.color, status.color === 'bg-green-500' ? 'shadow-green-500/40 ring-2 ring-green-500/20' : '')}
                        title={status.label}
                      />
                    </td>
                    {/* Type badge */}
                    <td className="px-3 py-2.5">
                      <span className={cn('px-2 py-0.5 rounded text-[10px] font-medium border border-transparent', typeColors[rule.type])}>
                        {typeLabels[rule.type]}
                      </span>
                    </td>
                    {/* Ingress (Listen) */}
                    <td className="px-3 py-2.5 font-mono text-xs">
                      <span className="text-muted-foreground/60">{rule.type === 'remote' ? rule.remoteHost : rule.localHost}:</span>
                      <span className="text-foreground tracking-wider font-semibold">{rule.type === 'remote' ? rule.remotePort : rule.localPort}</span>
                    </td>
                    {/* Arrow */}
                    <td className="px-1 py-2.5 text-center text-muted-foreground/40">
                      <ArrowRight className="w-3.5 h-3.5 inline-block" />
                    </td>
                    {/* Egress (Target) */}
                    <td className="px-3 py-2.5 font-mono text-xs">
                      {rule.type === 'dynamic' ? (
                        <span className="flex items-center gap-1.5 pt-0.5">
                          <Globe className="w-3.5 h-3.5 text-blue-400/80" />
                          <span className="text-foreground/80 font-sans text-[11px] font-medium tracking-wide">动态代理 (SOCKS5)</span>
                        </span>
                      ) : (
                        <>
                          <span className="text-muted-foreground/60">{rule.type === 'remote' ? rule.localHost : rule.remoteHost}:</span>
                          <span className="text-foreground/80 tracking-wider font-medium">{rule.type === 'remote' ? rule.localPort : rule.remotePort}</span>
                        </>
                      )}
                    </td>
                    {/* Status text */}
                    <td className="px-3 py-2.5">
                      <span className={cn(
                        'text-[10px] font-medium px-1.5 py-0.5 rounded-sm',
                        status.color === 'bg-green-500' ? 'text-green-500 bg-green-500/10' :
                        status.color === 'bg-red-500' ? 'text-red-500 bg-red-500/10' :
                        'text-muted-foreground bg-accent'
                      )}>
                        {status.label}
                      </span>
                    </td>
                    {/* Actions */}
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-all">
                        {rule.type === 'local' && (
                          <button
                            onClick={() => window.open(`http://${rule.localHost}:${rule.localPort}`, '_blank')}
                            className="p-1.5 hover:bg-primary/10 hover:text-primary rounded-md transition-colors"
                            title="在浏览器中打开"
                          >
                            <Chrome className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={() => handleCopy(rule)}
                          className="p-1.5 hover:bg-primary/10 hover:text-primary rounded-md transition-colors"
                          title="复制监听地址"
                        >
                          {copiedId === rule.id ? (
                            <Check className="w-3.5 h-3.5 text-green-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        <button
                          onClick={() => handleRemove(rule.id)}
                          className="p-1.5 hover:bg-destructive/10 hover:text-destructive rounded-md transition-colors"
                          title="删除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
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
      <div className="border-t border-border/60 bg-card/60 backdrop-blur-md shrink-0">
        <div className="flex flex-col">
          {/* Main quick add row */}
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <Plus className="w-4 h-4 text-primary" />
            </div>

            {/* Type selector */}
            <div className="relative">
              <button
                onClick={() => setShowTypeMenu(!showTypeMenu)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 bg-secondary/80 rounded-md text-xs font-medium hover:bg-secondary transition-colors"
                title="选择转发类型"
              >
                <span className={cn('w-2 h-2 rounded-full shadow-sm', addType === 'local' ? 'bg-blue-400' : addType === 'remote' ? 'bg-amber-400' : 'bg-purple-400')} />
                {typeLabels[addType]}
                <ChevronDown className="w-3.5 h-3.5 opacity-60" />
              </button>
              {showTypeMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowTypeMenu(false)} />
                  <div className="absolute bottom-full left-0 mb-2 z-50 bg-card border border-border/60 rounded-lg shadow-xl shadow-black/10 py-1.5 min-w-[130px] overflow-hidden">
                    {(['local', 'remote', 'dynamic'] as const).map((type) => (
                      <button
                        key={type}
                        onClick={() => { setAddType(type); setShowTypeMenu(false) }}
                        className={cn(
                          'flex items-center gap-2 w-full px-3 py-2 text-xs font-medium hover:bg-accent/80 transition-colors',
                          addType === type ? 'text-primary bg-primary/5' : 'text-foreground/80'
                        )}
                      >
                        <span className={cn('w-2 h-2 rounded-full', type === 'local' ? 'bg-blue-400' : type === 'remote' ? 'bg-amber-400' : 'bg-purple-400')} />
                        {typeLabels[type]}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            {/* Port input */}
            <div className="relative">
              <input
                ref={portInputRef}
                type="number"
                value={addPort}
                onChange={(e) => setAddPort(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleQuickAdd() }}
                placeholder={addType === 'remote' ? "输入远程端口" : "输入本地端口"}
                min={1}
                max={65535}
                className="w-[140px] pl-3 pr-2 py-1.5 bg-background/50 border border-input rounded-md text-sm outline-none focus:ring-1 focus:ring-primary focus:border-primary font-mono transition-all [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none placeholder:text-muted-foreground/50 placeholder:font-sans"
              />
            </div>

            {/* Advanced toggle */}
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className={cn(
                "flex items-center gap-1 ml-1 px-2 py-1.5 text-xs font-medium rounded-md transition-colors duration-200",
                showAdvanced ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              高级设置
              <ChevronDown className={cn("w-3.5 h-3.5 transition-transform duration-200", showAdvanced ? "rotate-180" : "")} />
            </button>

            <div className="flex-1" />

            {/* Add button */}
            <button
              onClick={handleQuickAdd}
              disabled={!addPort || creating}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium shadow-sm hover:bg-primary/90 transition-all active:scale-95 disabled:opacity-50 disabled:active:scale-100 disabled:cursor-not-allowed shrink-0"
            >
              <ArrowRight className="w-3.5 h-3.5" />
              添加规则
            </button>
          </div>

          {/* Advanced options with grid animation */}
          <div className={cn(
            "grid transition-all duration-300 ease-in-out border-t",
            showAdvanced ? "grid-rows-[1fr] opacity-100 border-border/30" : "grid-rows-[0fr] opacity-0 border-transparent"
          )}>
            <div className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-3 py-3 pl-12 bg-accent/20">
                <div className="flex items-center gap-2">
                  <label className="text-[11px] font-medium text-muted-foreground shrink-0 uppercase tracking-wider">绑定本地IP</label>
                  <input
                    type="text"
                    value={advLocalHost}
                    onChange={(e) => setAdvLocalHost(e.target.value)}
                    className="w-32 px-2 py-1 bg-background border border-input rounded-md text-xs outline-none focus:ring-1 focus:ring-primary font-mono shadow-sm"
                  />
                </div>
                {addType !== 'dynamic' && (
                  <>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] font-medium text-muted-foreground shrink-0 uppercase tracking-wider">目标IP</label>
                      <input
                        type="text"
                        value={advRemoteHost}
                        onChange={(e) => setAdvRemoteHost(e.target.value)}
                        className="w-32 px-2 py-1 bg-background border border-input rounded-md text-xs outline-none focus:ring-1 focus:ring-primary font-mono shadow-sm"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[11px] font-medium text-muted-foreground shrink-0 uppercase tracking-wider">目标端口</label>
                      <input
                        type="number"
                        value={advRemotePort}
                        onChange={(e) => setAdvRemotePort(e.target.value)}
                        placeholder="同绑定端口"
                        className="w-24 px-2 py-1 bg-background border border-input rounded-md text-xs outline-none focus:ring-1 focus:ring-primary font-mono shadow-sm placeholder:text-[10px] placeholder:font-sans [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      />
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
