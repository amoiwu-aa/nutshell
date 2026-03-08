import { useState, useEffect, useMemo } from 'react'
import { X, Key, Lock, Server, FolderOpen, Eye, EyeOff } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore, type ConnectionConfig } from '../../stores/connectionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { v4 as uuidv4 } from 'uuid'

const colorOptions = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316'
]

export function ConnectionDialog() {
  const { addConnection, updateConnection, connections } = useConnectionStore()
  const { settings, setSettings } = useSettingsStore()
  const [isOpen, setIsOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [activeAuthTab, setActiveAuthTab] = useState<'password' | 'key'>('password')

  const savedKeys = useMemo(() => {
    const keys = new Set([
      ...(settings.savedKeys || []),
      ...connections.filter((c) => c.privateKeyPath).map((c) => c.privateKeyPath!)
    ])
    return Array.from(keys)
  }, [settings.savedKeys, connections])

  const [customKeyPath, setCustomKeyPath] = useState(false)

  const [form, setForm] = useState<ConnectionConfig>({
    id: '',
    name: '',
    host: '',
    port: 22,
    username: 'root',
    authType: 'password',
    password: '',
    privateKeyPath: '',
    passphrase: '',
    group: '默认分组',
    jumpHost: '',
    color: '#3b82f6'
  })

  // Listen for connection:new and connection:edit events
  useEffect(() => {
    const handleNew = (e?: CustomEvent<{ group?: string }>) => {
      const defaultGroup = e?.detail?.group || '默认分组'
      setForm({
        id: uuidv4(),
        name: '',
        host: '',
        port: 22,
        username: 'root',
        authType: 'password',
        password: '',
        privateKeyPath: '',
        passphrase: '',
        group: defaultGroup,
        jumpHost: '',
        color: '#3b82f6'
      })
      setIsEditing(false)
      setCustomGroup(false)
      setIsOpen(true)
    }

    const handleEdit = (e: CustomEvent<ConnectionConfig>) => {
      setForm(e.detail)
      setActiveAuthTab(e.detail.authType === 'password' ? 'password' : 'key')
      setIsEditing(true)
      setCustomGroup(false)
      // If the key is not in savedKeys, we might want to show custom path, but wait, useMemo already aggregates it!
      setCustomKeyPath(false)
      setIsOpen(true)
    }

    window.addEventListener('connection:new', handleNew as EventListener)
    window.addEventListener('connection:edit', handleEdit as EventListener)

    return () => {
      window.removeEventListener('connection:new', handleNew as EventListener)
      window.removeEventListener('connection:edit', handleEdit as EventListener)
    }
  }, [])

  const handleSave = async () => {
    if (!form.name || !form.host || !form.username) return

    const connection: ConnectionConfig = {
      ...form,
      authType: activeAuthTab === 'password' ? 'password' : form.passphrase ? 'keyWithPassphrase' : 'key'
    }

    await window.api.config.saveConnection(connection)

    if (isEditing) {
      updateConnection(connection)
    } else {
      addConnection(connection)
    }

    setIsOpen(false)
  }

  const handleConnect = async () => {
    await handleSave()

    // Trigger connection
    const event = new CustomEvent('connection:open', { detail: form })
    window.dispatchEvent(event)
  }

  const handleSelectKeyFile = async () => {
    const result = await window.api.config.selectFile({
      filters: [
        { name: 'SSH Keys', extensions: ['pem', 'key', 'ppk', ''] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.success && !result.canceled && result.filePaths.length > 0) {
      const newPath = result.filePaths[0]
      setForm((prev) => ({ ...prev, privateKeyPath: newPath }))

      const currentSavedKeys = settings.savedKeys || []
      if (!currentSavedKeys.includes(newPath)) {
        setSettings({ savedKeys: [...currentSavedKeys, newPath] })
      }
      setCustomKeyPath(false)
    }
  }

  // Existing groups for dropdown
  const existingGroups = [...new Set(connections.map((c) => c.group || '默认分组'))]
  if (!existingGroups.includes('默认分组')) existingGroups.unshift('默认分组')
  const [customGroup, setCustomGroup] = useState(false)

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && setIsOpen(false)}>
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm dialog-overlay"
        onClick={() => setIsOpen(false)}
      />

      {/* Dialog */}
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[520px] max-h-[85vh] overflow-hidden dialog-content">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary/15 flex items-center justify-center">
              <Server className="w-4 h-4 text-primary" />
            </div>
            <h2 className="text-lg font-semibold">
              {isEditing ? '编辑连接' : '新建 SSH 连接'}
            </h2>
          </div>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1 hover:bg-accent rounded-md transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="px-5 py-4 space-y-4 overflow-y-auto max-h-[calc(85vh-130px)]">
          {/* Connection name & color */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5">连接名称</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="My Server"
                className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">颜色</label>
              <div className="flex gap-1.5 pt-1">
                {colorOptions.map((color) => (
                  <button
                    key={color}
                    onClick={() => setForm((prev) => ({ ...prev, color }))}
                    className={cn(
                      'w-6 h-6 rounded-full transition-transform',
                      form.color === color && 'ring-2 ring-offset-2 ring-offset-card ring-primary scale-110 shadow-[0_0_8px_var(--tw-ring-color)]'
                    )}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          </div>

          {/* Host & Port */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1.5">主机地址</label>
              <div className="relative">
                <Server className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <input
                  type="text"
                  value={form.host}
                  onChange={(e) => setForm((prev) => ({ ...prev, host: e.target.value }))}
                  placeholder="192.168.1.100 或 example.com"
                  className="w-full pl-9 pr-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div className="w-24">
              <label className="block text-sm font-medium mb-1.5">端口</label>
              <input
                type="number"
                value={form.port}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, port: parseInt(e.target.value) || 22 }))
                }
                className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <label className="block text-sm font-medium mb-1.5">用户名</label>
            <input
              type="text"
              value={form.username}
              onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
              placeholder="root"
              className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Auth type tabs */}
          <div>
            <label className="block text-sm font-medium mb-1.5">认证方式</label>
            <div className="flex bg-background border border-input rounded-lg p-0.5 mb-3">
              <button
                onClick={() => setActiveAuthTab('password')}
                className={cn(
                  'flex items-center gap-1.5 flex-1 justify-center py-1.5 rounded-md text-sm transition-colors',
                  activeAuthTab === 'password'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Lock className="w-3.5 h-3.5" />
                密码
              </button>
              <button
                onClick={() => setActiveAuthTab('key')}
                className={cn(
                  'flex items-center gap-1.5 flex-1 justify-center py-1.5 rounded-md text-sm transition-colors',
                  activeAuthTab === 'key'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Key className="w-3.5 h-3.5" />
                密钥
              </button>
            </div>

            {activeAuthTab === 'password' ? (
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={form.password || ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                  placeholder="输入密码"
                  className="w-full px-3 py-2 pr-10 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                >
                  {showPassword ? (
                    <EyeOff className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <Eye className="w-4 h-4 text-muted-foreground" />
                  )}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between items-center mb-1">
                    <label className="block text-xs text-muted-foreground">私钥文件</label>
                    {savedKeys.length > 0 && !customKeyPath && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          setSettings({ savedKeys: (settings.savedKeys || []).filter(k => k !== form.privateKeyPath) })
                          // if it was the last one, custom path will take over
                        }}
                        className="text-[10px] text-destructive hover:underline"
                        title="从存储记录中删除当前选中的密钥路径"
                      >
                        删除记录
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {customKeyPath || savedKeys.length === 0 ? (
                      <input
                        type="text"
                        value={form.privateKeyPath || ''}
                        onChange={(e) =>
                          setForm((prev) => ({ ...prev, privateKeyPath: e.target.value }))
                        }
                        placeholder="~/.ssh/id_rsa"
                        className="flex-1 px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
                      />
                    ) : (
                      <select
                        value={savedKeys.includes(form.privateKeyPath || '') ? (form.privateKeyPath || '') : '__custom__'}
                        onChange={(e) => {
                          if (e.target.value === '__custom__') {
                            setCustomKeyPath(true)
                            setForm((prev) => ({ ...prev, privateKeyPath: '' }))
                          } else {
                            setForm((prev) => ({ ...prev, privateKeyPath: e.target.value }))
                          }
                        }}
                        className="flex-1 px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring cursor-pointer"
                      >
                        {!form.privateKeyPath && <option value="" disabled>--- 请选择已保存的密钥 ---</option>}
                        {savedKeys.map((k) => (
                          <option key={k} value={k}>
                            {k.split(/[/\\]/).pop()} ({k})
                          </option>
                        ))}
                        <option value="__custom__">+ 手动输入路径或添加新文件...</option>
                      </select>
                    )}

                    {customKeyPath && savedKeys.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setCustomKeyPath(false)
                          if (!savedKeys.includes(form.privateKeyPath || '')) {
                            setForm((prev) => ({ ...prev, privateKeyPath: savedKeys[0] }))
                          }
                        }}
                        className="px-3 py-2 bg-accent hover:bg-accent/80 rounded-lg text-sm transition-colors text-muted-foreground hover:text-foreground"
                        title="取消手动输入"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}

                    <button
                      onClick={handleSelectKeyFile}
                      className="px-3 py-2 flex items-center gap-1.5 bg-accent hover:bg-accent/80 rounded-lg text-sm transition-colors whitespace-nowrap"
                      title="直接添加并选择私钥文件"
                    >
                      <FolderOpen className="w-4 h-4" />
                      <span className="hidden sm:inline">浏览</span>
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">
                    密钥密码短语（可选）
                  </label>
                  <input
                    type="password"
                    value={form.passphrase || ''}
                    onChange={(e) => setForm((prev) => ({ ...prev, passphrase: e.target.value }))}
                    placeholder="如果密钥有密码保护则填写"
                    className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Group */}
          <div>
            <label className="block text-sm font-medium mb-1.5">分组</label>
            {customGroup ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  autoFocus
                  value={form.group || ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, group: e.target.value }))}
                  placeholder="输入新分组名称"
                  className="flex-1 px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={() => setCustomGroup(false)}
                  className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground border border-input rounded-lg hover:bg-accent transition-colors"
                >
                  取消
                </button>
              </div>
            ) : (
              <select
                value={existingGroups.includes(form.group || '默认分组') ? (form.group || '默认分组') : '__custom__'}
                onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    setCustomGroup(true)
                    setForm((prev) => ({ ...prev, group: '' }))
                  } else {
                    setForm((prev) => ({ ...prev, group: e.target.value }))
                  }
                }}
                className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring cursor-pointer"
              >
                {existingGroups.map((g) => (
                  <option key={g} value={g}>{g}</option>
                ))}
                <option value="__custom__">+ 新建分组...</option>
              </select>
            )}
          </div>

          {/* Jump Host */}
          <div>
            <label className="block text-sm font-medium mb-1.5">跳板机（可选）</label>
            <input
              type="text"
              value={form.jumpHost || ''}
              onChange={(e) => setForm((prev) => ({ ...prev, jumpHost: e.target.value }))}
              placeholder="跳板机连接名称或ID"
              className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="text-xs text-muted-foreground mt-1">
              通过已保存的连接作为跳板机进行代理连接
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          <button
            onClick={() => setIsOpen(false)}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 text-sm bg-secondary text-secondary-foreground rounded-lg hover:bg-secondary/80 transition-colors"
          >
            保存
          </button>
          <button
            onClick={handleConnect}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors font-medium btn-glow"
          >
            保存并连接
          </button>
        </div>
      </div>
    </div>
  )
}
