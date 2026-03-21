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
  Plus
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
  const [workspaceDialog, setWorkspaceDialog] = useState<{ tab: Tab } | null>(null)
  const [workspacePath, setWorkspacePath] = useState('/root')

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
            <button
              onClick={() => {
                setWorkspaceDialog({ tab: contextMenu.tab })
                setWorkspacePath('/root')
                setContextMenu(null)
              }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <Code2 className="w-3.5 h-3.5" />
              打开开发工作区
            </button>
            <div className="border-t border-border my-1" />
            <button
              onClick={handleOpenPortForward}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm hover:bg-accent transition-colors"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              端口转发
            </button>
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

      {/* Workspace directory browser dialog */}
      {workspaceDialog && <DirBrowserDialog
        sessionId={workspaceDialog.tab.sessionId}
        onSelect={(path) => {
          const conn = connections.find((c) => c.id === workspaceDialog.tab.connectionId)
          addTab({
            id: uuidv4(), connectionId: workspaceDialog.tab.connectionId, sessionId: workspaceDialog.tab.sessionId,
            name: `${conn?.name || 'Dev'} - ${path.split('/').pop()}`, type: 'workspace', connected: true, workspacePath: path
          })
          setWorkspaceDialog(null)
        }}
        onClose={() => setWorkspaceDialog(null)}
      />}
    </>
  )
}

// Remote directory browser component
function DirBrowserDialog({ sessionId, onSelect, onClose }: { sessionId: string; onSelect: (path: string) => void; onClose: () => void }) {
  const [currentPath, setCurrentPath] = useState('/')
  const [entries, setEntries] = useState<Array<{ name: string; path: string; isDirectory: boolean }>>([])
  const [loading, setLoading] = useState(false)
  const [manualPath, setManualPath] = useState('')

  const loadDir = async (dirPath: string) => {
    setLoading(true)
    try {
      const r = await window.api.workspace.listDirectory(sessionId, dirPath)
      if (r.success) {
        setEntries(r.entries.filter((e: any) => e.isDirectory))
        setCurrentPath(dirPath)
        setManualPath(dirPath)
      }
    } catch { }
    setLoading(false)
  }

  useState(() => { loadDir('/') })

  const goUp = () => {
    if (currentPath === '/') return
    const parent = currentPath.split('/').slice(0, -1).join('/') || '/'
    loadDir(parent)
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50 dialog-overlay" onClick={onClose} />
      <div className="fixed z-50 top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-card border border-border rounded-xl shadow-2xl w-[500px] dialog-content flex flex-col" style={{ height: '60vh' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-semibold">选择项目目录</h3>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
        </div>
        {/* Path input */}
        <div className="flex items-center gap-2 px-5 py-2 border-b border-border shrink-0">
          <button onClick={goUp} className="p-1 hover:bg-accent rounded shrink-0"><ArrowRightLeft className="w-3.5 h-3.5" /></button>
          <input type="text" value={manualPath} onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') loadDir(manualPath) }}
            className="flex-1 px-2 py-1 bg-background border border-input rounded text-xs outline-none font-mono" />
          <button onClick={() => loadDir(manualPath)} className="px-2 py-1 bg-secondary rounded text-xs hover:bg-secondary/80">跳转</button>
        </div>
        {/* Directory list */}
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {loading ? <div className="flex items-center justify-center h-full"><span className="text-xs text-muted-foreground">加载中...</span></div> :
            entries.length === 0 ? <div className="flex items-center justify-center h-full"><span className="text-xs text-muted-foreground">无子目录</span></div> :
              entries.map((e) => (
                <button key={e.path} onDoubleClick={() => loadDir(e.path)} onClick={() => setManualPath(e.path)}
                  className={cn('flex items-center gap-2 w-full px-3 py-1.5 rounded text-xs hover:bg-accent/50 transition-colors',
                    manualPath === e.path && 'bg-accent')}>
                  <FolderOpen className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                  <span className="truncate">{e.name}</span>
                </button>
              ))
          }
        </div>
        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border shrink-0">
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[250px]">{manualPath}</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm hover:bg-accent rounded-lg">取消</button>
            <button onClick={() => onSelect(manualPath || currentPath)} disabled={!manualPath}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg disabled:opacity-50 hover:bg-primary/90">打开</button>
          </div>
        </div>
      </div>
    </>
  )
}
