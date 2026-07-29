import { useState, useMemo } from 'react'
import {
  Plus,
  Server,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Settings,
  PanelLeftClose,
  PanelLeft,
  Search,
  Code2,
  Activity,
  Trash2,
  Edit,
  MoreVertical,
  Container,
  ArrowRightLeft,
  Terminal
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore, type ConnectionConfig } from '../../stores/connectionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { v4 as uuidv4 } from 'uuid'

export function Sidebar() {
  const connections = useConnectionStore((state) => state.connections)
  const sidebarCollapsed = useConnectionStore((state) => state.sidebarCollapsed)
  const setSidebarCollapsed = useConnectionStore((state) => state.setSidebarCollapsed)
  const removeConnection = useConnectionStore((state) => state.removeConnection)
  const updateConnection = useConnectionStore((state) => state.updateConnection)

  const settings = useSettingsStore((state) => state.settings)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['default']))
  const [searchQuery, setSearchQuery] = useState('')
  const [contextMenu, setContextMenu] = useState<{
    x: number | 'auto'
    y: number | 'auto'
    right: number | 'auto'
    bottom: number | 'auto'
    connection: ConnectionConfig
  } | null>(null)
  const [groupContextMenu, setGroupContextMenu] = useState<{
    x: number | 'auto'
    y: number | 'auto'
    right: number | 'auto'
    bottom: number | 'auto'
    groupName: string
  } | null>(null)
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')

  // Group connections (memoized)
  const groups = useMemo(() => connections.reduce(
    (acc, conn) => {
      const group = conn.group || '默认分组'
      if (!acc[group]) acc[group] = []
      acc[group].push(conn)
      return acc
    },
    {} as Record<string, ConnectionConfig[]>
  ), [connections])

  // Filter connections (memoized)
  const filteredGroups = useMemo(() => searchQuery
    ? Object.fromEntries(
      Object.entries(groups)
        .map(([group, conns]) => [
          group,
          conns.filter(
            (c) =>
              c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
              c.host.toLowerCase().includes(searchQuery.toLowerCase())
          )
        ])
        .filter(([, conns]) => (conns as ConnectionConfig[]).length > 0)
    )
    : groups, [groups, searchQuery])

  const toggleGroup = (group: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  const handleConnect = (connection: ConnectionConfig) => {
    const event = new CustomEvent('connection:open', { detail: connection })
    window.dispatchEvent(event)
  }

  const handleNewConnection = () => {
    const event = new CustomEvent('connection:new')
    window.dispatchEvent(event)
  }

  const handleNewConnectionInGroup = (groupName: string) => {
    const event = new CustomEvent('connection:new', { detail: { group: groupName } })
    window.dispatchEvent(event)
    setGroupContextMenu(null)
  }

  const handleEditConnection = (connection: ConnectionConfig) => {
    const event = new CustomEvent('connection:edit', { detail: connection })
    window.dispatchEvent(event)
    setContextMenu(null)
  }

  const handleDeleteConnection = async (id: string) => {
    await window.api.config.deleteConnection(id)
    removeConnection(id)
    setContextMenu(null)
  }

  // Open a panel tab for a connection — reuses existing session if already connected
  const openPanelForConnection = (
    conn: ConnectionConfig,
    type: 'sftp' | 'monitor' | 'docker' | 'workspace' | 'portforward'
  ) => {
    setContextMenu(null)
    const store = useConnectionStore.getState()
    // Find an existing terminal session for this connection
    const existingTab = store.tabs.find(
      (t) => t.connectionId === conn.id && t.type === 'terminal' && t.connected
    )
    if (!existingTab) {
      // Trigger a regular connection first, then signal which panel to open after
      window.dispatchEvent(new CustomEvent('connection:open', { detail: conn }))
      return
    }
    if (type === 'portforward') {
      store.setBottomPanelVisible(true)
      store.setBottomPanelActiveTab('ports')
      return
    }
    const labelMap: Record<string, string> = {
      sftp: '文件管理', monitor: '监控', docker: 'Docker', workspace: '开发'
    }
    useConnectionStore.getState().addTab({
      id: uuidv4(),
      connectionId: conn.id,
      sessionId: existingTab.sessionId,
      name: `${conn.name} - ${labelMap[type]}`,
      type: type as any,
      connected: true
    })
  }

  const handleContextMenu = (e: React.MouseEvent, connection: ConnectionConfig) => {
    e.preventDefault()
    const x = e.clientX > window.innerWidth / 2 ? 'auto' : e.clientX
    const right = e.clientX > window.innerWidth / 2 ? window.innerWidth - e.clientX : 'auto'
    const y = e.clientY > window.innerHeight / 2 ? 'auto' : e.clientY
    // Add 10px to mouse y so menu appears to grow directly upwards from the cursor without covering it completely
    const bottom = e.clientY > window.innerHeight / 2 ? window.innerHeight - e.clientY : 'auto'
    
    setContextMenu({ x, y, right, bottom, connection })
  }

  const handleGroupContextMenu = (e: React.MouseEvent, groupName: string) => {
    e.preventDefault()
    e.stopPropagation()
    const x = e.clientX > window.innerWidth / 2 ? 'auto' : e.clientX
    const right = e.clientX > window.innerWidth / 2 ? window.innerWidth - e.clientX : 'auto'
    const y = e.clientY > window.innerHeight / 2 ? 'auto' : e.clientY
    const bottom = e.clientY > window.innerHeight / 2 ? window.innerHeight - e.clientY : 'auto'
    
    setGroupContextMenu({ x, y, right, bottom, groupName })
  }

  const handleRenameGroup = async (oldName: string, newName: string) => {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === oldName) {
      setEditingGroup(null)
      return
    }
    const affected = connections.filter((c) => (c.group || '默认分组') === oldName)
    for (const conn of affected) {
      const updated = { ...conn, group: trimmed }
      updateConnection(updated)
      await window.api.config.saveConnection(updated)
    }
    setEditingGroup(null)
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      next.delete(oldName)
      next.add(trimmed)
      return next
    })
  }

  const handleDeleteGroup = async (groupName: string) => {
    const affected = connections.filter((c) => (c.group || '默认分组') === groupName)
    for (const conn of affected) {
      const updated = { ...conn, group: '默认分组' }
      updateConnection(updated)
      await window.api.config.saveConnection(updated)
    }
    setGroupContextMenu(null)
  }

  if (sidebarCollapsed) {
    return (
      <div className="flex flex-col items-center w-12 bg-card border-r border-border py-2 gap-2">
        <button
          onClick={() => setSidebarCollapsed(false)}
          className="p-2 hover:bg-accent rounded-md transition-colors"
          title="展开侧边栏"
        >
          <PanelLeft className="w-4 h-4 text-muted-foreground" />
        </button>
        <button
          onClick={handleNewConnection}
          className="p-2 hover:bg-accent rounded-md transition-colors"
          title="新建连接"
        >
          <Plus className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>
    )
  }

  return (
    <>
      <div
        className="flex flex-col bg-card border-r border-border sidebar-transition shrink-0"
        style={{ width: settings.sidebarWidth }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <span className="text-sm font-medium text-muted-foreground">连接管理</span>
          <div className="flex items-center gap-1">
            <button
              onClick={handleNewConnection}
              className="p-1.5 hover:bg-accent rounded-md transition-colors"
              title="新建连接"
            >
              <Plus className="w-4 h-4 text-muted-foreground" />
            </button>
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="p-1.5 hover:bg-accent rounded-md transition-colors"
              title="收起侧边栏"
            >
              <PanelLeftClose className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <div className="flex items-center gap-2 px-2 py-1.5 bg-background rounded-md border border-input">
            <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              type="text"
              placeholder="搜索连接..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Connection list */}
        <div className="flex-1 overflow-y-auto px-1">
          {Object.entries(filteredGroups).map(([group, conns]) => (
            <div key={group} className="mb-1">
              <button
                onClick={() => toggleGroup(group)}
                onContextMenu={(e) => handleGroupContextMenu(e, group)}
                className="flex items-center gap-1.5 w-full px-2 py-1.5 hover:bg-accent rounded-lg text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 transition-colors"
              >
                {expandedGroups.has(group) ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
                <FolderOpen className="w-3.5 h-3.5" />
                {editingGroup === group ? (
                  <input
                    autoFocus
                    type="text"
                    value={editingGroupName}
                    onChange={(e) => setEditingGroupName(e.target.value)}
                    onBlur={() => handleRenameGroup(group, editingGroupName)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleRenameGroup(group, editingGroupName)
                      if (e.key === 'Escape') setEditingGroup(null)
                      e.stopPropagation()
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="ml-1 flex-1 bg-background border border-input rounded px-1 text-sm outline-none focus:ring-1 focus:ring-ring"
                  />
                ) : (
                  <span className="ml-1">{group}</span>
                )}
                <span className="ml-auto text-xs">
                  {(conns as ConnectionConfig[]).length}
                </span>
              </button>

              {expandedGroups.has(group) && (
                <div className="ml-2">
                  {(conns as ConnectionConfig[]).map((conn) => (
                    <button
                      key={conn.id}
                      onDoubleClick={() => handleConnect(conn)}
                      onContextMenu={(e) => handleContextMenu(e, conn)}
                      className="flex items-center gap-2 w-full px-2 py-1.5 hover:bg-accent rounded-md text-sm transition-colors group sidebar-item"
                      title={`${conn.host}:${conn.port} - 双击连接`}
                    >
                      <div className="w-0.5 h-6 rounded-full shrink-0" style={{ background: conn.color || 'hsl(var(--primary))' }} />
                      <div className="flex flex-col items-start overflow-hidden flex-1">
                        <span className="text-foreground truncate w-full text-left">
                          {conn.name}
                        </span>
                        <span className="text-xs text-muted-foreground truncate w-full text-left">
                          {conn.username}@{conn.host}
                        </span>
                      </div>
                      <div
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:bg-background rounded"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleContextMenu(e, conn)
                        }}
                      >
                        <MoreVertical className="w-3.5 h-3.5 text-muted-foreground" />
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          {Object.keys(filteredGroups).length === 0 && (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Server className="w-8 h-8 mb-2 opacity-50" />
              <p className="text-sm">
                {searchQuery ? '没有找到匹配的连接' : '暂无连接'}
              </p>
              {!searchQuery && (
                <button
                  onClick={handleNewConnection}
                  className="mt-2 text-sm text-primary hover:underline"
                >
                  创建第一个连接
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-3 py-2 border-t border-border/50">
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                const event = new CustomEvent('app:toggleBottomPanel')
                window.dispatchEvent(event)
              }}
              className="p-1.5 hover:bg-accent rounded-md transition-colors"
              title="底部面板（命令/文件）"
              aria-label="底部面板"
            >
              <Code2 className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <button
            onClick={() => {
              const event = new CustomEvent('app:openSettings')
              window.dispatchEvent(event)
            }}
            className="p-1.5 hover:bg-accent rounded-md transition-colors"
            title="设置"
            aria-label="应用设置"
          >
            <Settings className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} onKeyDown={(e) => e.key === 'Escape' && setContextMenu(null)} />
          <div
            className="fixed z-[100] bg-popover text-popover-foreground border border-border rounded-md shadow-lg py-1 min-w-[180px] context-menu select-none max-h-[80vh] overflow-y-auto"
            style={{ left: contextMenu.x, top: contextMenu.y, right: contextMenu.right, bottom: contextMenu.bottom }}
            role="menu"
            aria-label="连接操作菜单"
          >
            {/* — 连接 — */}
            <button
              role="menuitem"
              onClick={() => {
                handleConnect(contextMenu.connection)
                setContextMenu(null)
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Terminal className="w-3.5 h-3.5 shrink-0" />
              连接终端
            </button>

            <div className="border-t border-border/50 my-1" role="separator" />

            {/* — 功能面板 — */}
            <button
              role="menuitem"
              onClick={() => openPanelForConnection(contextMenu.connection, 'sftp')}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5 shrink-0" />
              打开文件管理
            </button>
            <button
              role="menuitem"
              onClick={() => openPanelForConnection(contextMenu.connection, 'monitor')}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Activity className="w-3.5 h-3.5 shrink-0" />
              服务器监控
            </button>
            <button
              role="menuitem"
              onClick={() => openPanelForConnection(contextMenu.connection, 'docker')}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Container className="w-3.5 h-3.5 shrink-0" />
              Docker 管理
            </button>
            <button
              role="menuitem"
              onClick={() => openPanelForConnection(contextMenu.connection, 'workspace')}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Code2 className="w-3.5 h-3.5 shrink-0" />
              开发工作区
            </button>
            <button
              role="menuitem"
              onClick={() => openPanelForConnection(contextMenu.connection, 'portforward')}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <ArrowRightLeft className="w-3.5 h-3.5 shrink-0" />
              端口转发
            </button>

            <div className="border-t border-border my-1" role="separator" />

            {/* — 管理 — */}
            <button
              role="menuitem"
              onClick={() => handleEditConnection(contextMenu.connection)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              <Edit className="w-3.5 h-3.5 shrink-0" />
              编辑
            </button>
            <button
              role="menuitem"
              onClick={() => handleDeleteConnection(contextMenu.connection.id)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-destructive hover:bg-accent transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              删除
            </button>
          </div>
        </>
      )}

      {/* Group context menu */}
      {groupContextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setGroupContextMenu(null)} onKeyDown={(e) => e.key === 'Escape' && setGroupContextMenu(null)} />
          <div
            className="fixed z-[100] bg-card border border-border rounded-md shadow-lg py-1 min-w-[160px] context-menu max-h-[80vh] overflow-y-auto"
            style={{ left: groupContextMenu.x, top: groupContextMenu.y, right: groupContextMenu.right, bottom: groupContextMenu.bottom }}
            role="menu"
            aria-label="分组操作菜单"
          >
            <button
              role="menuitem"
              onClick={() => handleNewConnectionInGroup(groupContextMenu.groupName)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              在此分组新建连接
            </button>
            <div className="border-t border-border/50 my-1" role="separator" />
            <button
              role="menuitem"
              onClick={() => {
                setEditingGroup(groupContextMenu.groupName)
                setEditingGroupName(groupContextMenu.groupName)
                setGroupContextMenu(null)
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <Edit className="w-3.5 h-3.5" />
              重命名分组
            </button>
            {groupContextMenu.groupName !== '默认分组' && (
              <>
                <div className="border-t border-border my-1" role="separator" />
                <button
                  role="menuitem"
                  onClick={() => handleDeleteGroup(groupContextMenu.groupName)}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-destructive hover:bg-accent transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  删除分组
                </button>
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}
