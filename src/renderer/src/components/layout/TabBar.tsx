import { useState } from 'react'
import {
  X,
  Terminal,
  FolderOpen,
  Activity,
  Container,
  ArrowRightLeft,
  Code2,
  FileText,
  Plus,
  RotateCcw,
  Maximize2
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore, type Tab } from '../../stores/connectionStore'
import { v4 as uuidv4 } from 'uuid'

const tabIcons: Record<string, typeof Terminal> = {
  terminal: Terminal,
  sftp: FolderOpen,
  monitor: Activity,
  docker: Container,
  workspace: Code2,
  editor: FileText
}

const tabTypeLabels: Record<string, string> = {
  terminal: '终端',
  sftp: '文件管理',
  monitor: '监控',
  docker: 'Docker',
  workspace: '开发',
  editor: '编辑'
}

export function TabBar() {
  const tabs = useConnectionStore((state) => state.tabs)
  const activeTabId = useConnectionStore((state) => state.activeTabId)
  const setActiveTab = useConnectionStore((state) => state.setActiveTab)
  const removeTab = useConnectionStore((state) => state.removeTab)
  const addTab = useConnectionStore((state) => state.addTab)
  const connections = useConnectionStore((state) => state.connections)
  const [contextMenu, setContextMenu] = useState<{
    x: number | 'auto'
    y: number | 'auto'
    right: number | 'auto'
    bottom: number | 'auto'
    tab: Tab
  } | null>(null)
  const reconnectTab = async (tab: Tab) => {
    const conn = connections.find((c) => c.id === tab.connectionId)
    if (!conn) {
      setContextMenu(null)
      return
    }

    try {
      await window.api.ssh.disconnect(tab.sessionId).catch(() => {})
    } catch {
      // ignore disconnect failures
    }

    removeTab(tab.id)
    window.dispatchEvent(new CustomEvent('connection:open', { detail: conn }))
    setContextMenu(null)
  }

  const handleCloseTab = (e: React.MouseEvent, tabId: string) => {
    e.stopPropagation()
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) {
      // Only disconnect SSH when the LAST tab using this sessionId is closed
      const otherTabsWithSameSession = tabs.filter(
        (t) => t.id !== tabId && t.sessionId === tab.sessionId
      )
      if (otherTabsWithSameSession.length === 0) {
        // This is the last tab - safe to disconnect
        window.api.ssh.disconnect(tab.sessionId)
      }
      // For Docker exec tabs (sessionId starts with "docker-exec-"), always clean up
      if (tab.sessionId.startsWith('docker-exec-')) {
        window.api.ssh.disconnect(tab.sessionId)
      }
    }
    removeTab(tabId)
  }

  const handleContextMenu = (e: React.MouseEvent, tab: Tab) => {
    e.preventDefault()
    const x = e.clientX > window.innerWidth / 2 ? 'auto' : e.clientX
    const right = e.clientX > window.innerWidth / 2 ? window.innerWidth - e.clientX : 'auto'
    const y = e.clientY > window.innerHeight / 2 ? 'auto' : e.clientY
    const bottom = e.clientY > window.innerHeight / 2 ? window.innerHeight - e.clientY : 'auto'
    setContextMenu({ x, y, right, bottom, tab })
  }

  const openNewTab = (tab: Tab, type: 'sftp' | 'monitor' | 'docker') => {
    const conn = connections.find((c) => c.id === tab.connectionId)
    const name = conn ? conn.name : 'Unknown'

    const newTab: Tab = {
      id: uuidv4(),
      connectionId: tab.connectionId,
      sessionId: tab.sessionId,
      name: `${name} - ${tabTypeLabels[type]}`,
      type,
      connected: true
    }
    addTab(newTab)
    setContextMenu(null)
  }

  const handleOpenPortForward = () => {
    useConnectionStore.getState().setBottomPanelVisible(true)
    useConnectionStore.getState().setBottomPanelActiveTab('ports')
    setContextMenu(null)
  }

  if (tabs.length === 0) {
    return null
  }

  return (
    <>
      <div className="flex items-center h-9 bg-card border-b border-border shrink-0 overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tabIcons[tab.type] || Terminal
          const isActive = tab.id === activeTabId

          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              onContextMenu={(e) => handleContextMenu(e, tab)}
              className={cn(
                'flex items-center gap-1.5 px-3 h-full cursor-pointer border-r border-border text-sm transition-colors shrink-0 max-w-[200px] group',
                isActive
                  ? 'bg-background text-foreground tab-active-glow'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{tab.name}</span>
              <div
                className={cn(
                  'flex items-center justify-center w-4 h-4 rounded-sm transition-colors shrink-0',
                  isActive
                    ? 'hover:bg-muted'
                    : 'opacity-0 group-hover:opacity-100 hover:bg-muted'
                )}
              >
                <button
                  onClick={(e) => handleCloseTab(e, tab.id)}
                  className="flex items-center justify-center"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-[100] bg-card border border-border rounded-md shadow-lg py-1 min-w-[180px] max-h-[80vh] overflow-y-auto"
            style={{ left: contextMenu.x, top: contextMenu.y, right: contextMenu.right, bottom: contextMenu.bottom }}
          >
            <button
              onClick={() => openNewTab(contextMenu.tab, 'sftp')}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              打开文件管理
            </button>
            <button
              onClick={() => openNewTab(contextMenu.tab, 'docker')}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <Container className="w-3.5 h-3.5" />
              打开 Docker 管理
            </button>
            <div className="border-t border-border my-1" />
            <button
              onClick={() => reconnectTab(contextMenu.tab)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              重新连接
            </button>
            <button
              onClick={handleOpenPortForward}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              端口转发
            </button>
            {contextMenu.tab.type === 'terminal' && (
              <button
                onClick={() => {
                  setContextMenu(null)
                  window.dispatchEvent(new CustomEvent('app:toggleZenMode'))
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                专注模式
                <span className="ml-auto text-[10px] text-muted-foreground">F11</span>
              </button>
            )}
            <div className="border-t border-border my-1" />
            <button
              onClick={() => {
                handleCloseTab(
                  { stopPropagation: () => { } } as React.MouseEvent,
                  contextMenu.tab.id
                )
                setContextMenu(null)
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-destructive hover:bg-accent transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              关闭标签
            </button>
          </div>
        </>
      )}

    </>
  )
}
