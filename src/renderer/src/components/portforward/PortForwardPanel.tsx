import { useState, useEffect } from 'react'
import {
  ArrowRightLeft,
  Plus,
  Trash2,
  X
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
  isOpen: boolean
  onClose: () => void
  sessionId: string
}

export function PortForwardPanel({ isOpen, onClose, sessionId }: PortForwardPanelProps) {
  const [rules, setRules] = useState<PortForwardRule[]>([])
  const [showEditor, setShowEditor] = useState(false)
  const [ruleStatuses, setRuleStatuses] = useState<Record<string, string>>({})

  const [editForm, setEditForm] = useState<PortForwardRule>({
    id: '',
    connectionId: sessionId,
    type: 'local',
    localHost: '127.0.0.1',
    localPort: 8080,
    remoteHost: '127.0.0.1',
    remotePort: 80,
    enabled: true
  })

  useEffect(() => {
    if (isOpen) loadRules()
  }, [isOpen, sessionId])

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

  const handleCreate = async () => {
    const rule = { ...editForm, id: uuidv4(), connectionId: sessionId }
    const result = await window.api.portForward.create(rule)
    if (result.success) {
      setRules((prev) => [...prev, rule])
      setShowEditor(false)
    }
  }

  const handleRemove = async (ruleId: string) => {
    await window.api.portForward.remove(ruleId)
    setRules((prev) => prev.filter((r) => r.id !== ruleId))
    setRuleStatuses((prev) => {
      const next = { ...prev }
      delete next[ruleId]
      return next
    })
  }

  const typeLabels: Record<string, string> = {
    local: '本地转发',
    remote: '远程转发',
    dynamic: '动态转发 (SOCKS5)'
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[600px] max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <ArrowRightLeft className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">端口转发管理</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setEditForm({
                  id: '',
                  connectionId: sessionId,
                  type: 'local',
                  localHost: '127.0.0.1',
                  localPort: 8080,
                  remoteHost: '127.0.0.1',
                  remotePort: 80,
                  enabled: true
                })
                setShowEditor(true)
              }}
              className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary/90 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              新建规则
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-accent rounded-md transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Rules list */}
        <div className="overflow-y-auto max-h-[calc(80vh-180px)] p-4 space-y-2">
          {rules.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <ArrowRightLeft className="w-8 h-8 mb-2 mx-auto opacity-50" />
              <p className="text-sm">暂无端口转发规则</p>
            </div>
          ) : (
            rules.map((rule) => (
              <div
                key={rule.id}
                className="flex items-center gap-3 bg-background border border-border rounded-lg px-4 py-3"
              >
                <div
                  className={cn(
                    'w-2 h-2 rounded-full',
                    ruleStatuses[rule.id] === 'active' ? 'bg-green-500' : 'bg-muted-foreground'
                  )}
                />

                <div className="flex-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-xs">
                      {typeLabels[rule.type]}
                    </span>
                    <span className="font-mono text-xs">
                      {rule.localHost}:{rule.localPort}
                    </span>
                    <ArrowRightLeft className="w-3 h-3 text-muted-foreground" />
                    <span className="font-mono text-xs">
                      {rule.remoteHost}:{rule.remotePort}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    状态: {ruleStatuses[rule.id] || '未知'}
                  </div>
                </div>

                <button
                  onClick={() => handleRemove(rule.id)}
                  className="p-1.5 hover:bg-accent rounded transition-colors text-destructive"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Create rule form */}
        {showEditor && (
          <div className="px-5 py-4 border-t border-border space-y-3">
            <div className="flex gap-2">
              {(['local', 'remote', 'dynamic'] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setEditForm((prev) => ({ ...prev, type }))}
                  className={cn(
                    'flex-1 py-1.5 rounded-lg text-xs font-medium transition-colors',
                    editForm.type === type
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                  )}
                >
                  {typeLabels[type]}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">本地地址</label>
                <input
                  type="text"
                  value={editForm.localHost}
                  onChange={(e) => setEditForm((prev) => ({ ...prev, localHost: e.target.value }))}
                  className="w-full px-2 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">本地端口</label>
                <input
                  type="number"
                  value={editForm.localPort}
                  onChange={(e) =>
                    setEditForm((prev) => ({
                      ...prev,
                      localPort: parseInt(e.target.value) || 0
                    }))
                  }
                  className="w-full px-2 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              {editForm.type !== 'dynamic' && (
                <>
                  <div>
                    <label className="block text-xs font-medium mb-1">远程地址</label>
                    <input
                      type="text"
                      value={editForm.remoteHost}
                      onChange={(e) =>
                        setEditForm((prev) => ({ ...prev, remoteHost: e.target.value }))
                      }
                      className="w-full px-2 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">远程端口</label>
                    <input
                      type="number"
                      value={editForm.remotePort}
                      onChange={(e) =>
                        setEditForm((prev) => ({
                          ...prev,
                          remotePort: parseInt(e.target.value) || 0
                        }))
                      }
                      className="w-full px-2 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowEditor(false)}
                className="px-3 py-1.5 text-sm hover:bg-accent rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
              >
                创建
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
