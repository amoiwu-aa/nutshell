import { useEffect, useState, useCallback, useMemo } from 'react'
import { TitleBar } from './components/layout/TitleBar'
import { Sidebar } from './components/layout/Sidebar'
import { TabBar } from './components/layout/TabBar'
import { StatusBar } from './components/layout/StatusBar'
import { ContentArea } from './components/layout/ContentArea'
import { Suspense, lazy } from 'react'
import { ResizableDivider } from './components/layout/ResizableDivider'
import { Maximize2, Minimize2 } from 'lucide-react'

const ConnectionDialog = lazy(() => import('./components/connection/ConnectionDialog').then(m => ({ default: m.ConnectionDialog })))
const SnippetManager = lazy(() => import('./components/snippet/SnippetManager').then(m => ({ default: m.SnippetManager })))
const MonitorPanel = lazy(() => import('./components/monitor/MonitorPanel').then(m => ({ default: m.MonitorPanel })))
const BottomPanel = lazy(() => import('./components/layout/BottomPanel').then(m => ({ default: m.BottomPanel })))
const SettingsDialog = lazy(() => import('./components/settings/SettingsDialog').then(m => ({ default: m.SettingsDialog })))

import { ToastProvider, useToast } from './components/ui/Toast'
import { useConnectionStore, type ConnectionConfig, type Tab } from './stores/connectionStore'
import { useSettingsStore } from './stores/settingsStore'
import { useTransferStore } from './stores/transferStore'
import { v4 as uuidv4 } from 'uuid'

function AppContent() {
  const setConnections = useConnectionStore((state) => state.setConnections)
  const addTab = useConnectionStore((state) => state.addTab)
  const tabs = useConnectionStore((state) => state.tabs)
  const activeTabId = useConnectionStore((state) => state.activeTabId)
  const monitorPanelVisible = useConnectionStore((state) => state.monitorPanelVisible)
  const bottomPanelVisible = useConnectionStore((state) => state.bottomPanelVisible)
  const bottomPanelHeight = useConnectionStore((state) => state.bottomPanelHeight)
  const setBottomPanelHeight = useConnectionStore((state) => state.setBottomPanelHeight)
  const loadSettings = useSettingsStore((state) => state.loadSettings)
  const settingsLoaded = useSettingsStore((state) => state.loaded)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const setSettingsMemOnly = useSettingsStore((state) => state.setSettingsMemOnly)
  const aiCompatibilityMode = useSettingsStore((state) => state.settings.aiCompatibilityMode)
  const { toast } = useToast()
  const [showSnippets, setShowSnippets] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const zenMode = useConnectionStore((state) => state.zenMode)
  const setZenMode = useConnectionStore((state) => state.setZenMode)
  const [zenHintVisible, setZenHintVisible] = useState(false)

  const handleSidebarResize = useCallback(
    (delta: number) => {
      const current = useSettingsStore.getState().settings.sidebarWidth
      const newWidth = Math.max(160, Math.min(480, current + delta))
      // Memory-only update during drag — no IPC overhead, no stutter
      setSettingsMemOnly({ sidebarWidth: newWidth })
    },
    [setSettingsMemOnly]
  )

  const handleSidebarResizeEnd = useCallback(() => {
    // Persist to disk only once when drag ends
    const finalWidth = useSettingsStore.getState().settings.sidebarWidth
    setSettings({ sidebarWidth: finalWidth })
  }, [setSettings])

  // Prevent Electron default drag-drop navigation
  useEffect(() => {
    const prevent = (e: DragEvent) => { e.preventDefault() }
    document.addEventListener('dragover', prevent)
    document.addEventListener('drop', prevent)
    return () => { document.removeEventListener('dragover', prevent); document.removeEventListener('drop', prevent) }
  }, [])

  // Zen mode keyboard shortcut (F11) and custom event
  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault()
        const next = !useConnectionStore.getState().zenMode
        setZenMode(next)
        if (next) { setZenHintVisible(true); setTimeout(() => setZenHintVisible(false), 3000) }
      }
      // Escape exits zen mode
      if (e.key === 'Escape' && useConnectionStore.getState().zenMode) {
        setZenMode(false)
      }
      // Ctrl+Tab / Ctrl+Shift+Tab cycles tabs (works in any mode but especially useful in zen)
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const store = useConnectionStore.getState()
        const { tabs: allTabs, activeTabId: currentId } = store
        if (allTabs.length <= 1) return
        const idx = allTabs.findIndex((t) => t.id === currentId)
        const nextIdx = e.shiftKey
          ? (idx - 1 + allTabs.length) % allTabs.length
          : (idx + 1) % allTabs.length
        store.setActiveTab(allTabs[nextIdx].id)
      }
    }
    const handleToggleZen = () => {
      const next = !useConnectionStore.getState().zenMode
      setZenMode(next)
      if (next) { setZenHintVisible(true); setTimeout(() => setZenHintVisible(false), 3000) }
    }
    document.addEventListener('keydown', handleKeydown)
    window.addEventListener('app:toggleZenMode', handleToggleZen)
    return () => {
      document.removeEventListener('keydown', handleKeydown)
      window.removeEventListener('app:toggleZenMode', handleToggleZen)
    }
  }, [setZenMode])

  // Global transfer progress listener — throttled to avoid UI stutter
  useEffect(() => {
    const pending = new Map<string, { transferred: number; total: number; currentFile?: string }>()
    let rafId: number | null = null

    const flush = () => {
      rafId = null
      const store = useTransferStore.getState()
      pending.forEach(({ transferred, total, currentFile }, id) => {
        store.updateProgress(id, transferred, total, currentFile)
      })
      pending.clear()
    }

    const cleanupProgress = window.api.sftp.onProgress((id: string, transferred: number, total: number, currentFile?: string) => {
      pending.set(id, { transferred, total, currentFile })
      if (rafId === null) {
        rafId = requestAnimationFrame(flush)
      }
    })

    const cleanupDirFileList = window.api.sftp.onDirFileList((transferId: string, files: any[]) => {
      useTransferStore.getState().setSubFiles(transferId, files)
    })

    const cleanupFileStatus = window.api.sftp.onFileStatus((transferId: string, fileIndex: number, status: string) => {
      useTransferStore.getState().setSubFileStatus(transferId, fileIndex, status)
    })

    const cleanupFileStatusBatch = window.api.sftp.onFileStatusBatch((batch: { id: string; fileIdx: number; status: string }[]) => {
      const store = useTransferStore.getState()
      // Group by transfer id for efficient batch update
      const byTransfer = new Map<string, { fileIndex: number; status: string }[]>()
      for (const item of batch) {
        if (!byTransfer.has(item.id)) byTransfer.set(item.id, [])
        byTransfer.get(item.id)!.push({ fileIndex: item.fileIdx, status: item.status })
      }
      for (const [transferId, updates] of byTransfer) {
        store.setSubFileStatusBatch(transferId, updates)
      }
    })

    return () => {
      cleanupProgress()
      cleanupDirFileList()
      cleanupFileStatus()
      cleanupFileStatusBatch()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      await loadSettings()
      const result = await window.api.config.getConnections()
      if (result.success) {
        setConnections(result.connections)
      }
    }
    init()
  }, [])

  // SSH reconnection events — use store.getState() to avoid re-registering on tabs change
  useEffect(() => {
    const removeReconnecting = window.api.ssh.onReconnecting?.((sessionId, attempt, delay) => {
      toast('warning', '正在重连...', `第 ${attempt} 次尝试，${Math.round(delay / 1000)}秒后重试`)
      const store = useConnectionStore.getState()
      for (const tab of store.tabs) {
        if (tab.sessionId === sessionId) {
          store.updateTab(tab.id, { connected: false })
        }
      }
    })

    const removeReconnected = window.api.ssh.onReconnected?.((sessionId) => {
      toast('success', '重连成功', '已恢复连接')
      const store = useConnectionStore.getState()
      for (const tab of store.tabs) {
        if (tab.sessionId === sessionId) {
          store.updateTab(tab.id, { connected: true })
        }
      }
    })

    return () => {
      removeReconnecting?.()
      removeReconnected?.()
    }
  }, [toast])

  // Handle connection open event
  useEffect(() => {
    const handleOpen = async (e: CustomEvent<ConnectionConfig>) => {
      const config = e.detail
      const tabId = uuidv4()
      const sessionId = uuidv4()

      setConnecting(true)
      try {
        const result = await window.api.ssh.connect({ ...config, id: sessionId, aiCompatibilityMode })
        if (result.success) {
          const terminalTab: Tab = {
            id: tabId,
            connectionId: config.id,
            sessionId: result.sessionId,
            name: `${config.name} - 终端`,
            type: 'terminal',
            engine: result.engine || 'node',
            connected: true
          }
          addTab(terminalTab)
          toast('success', '连接成功', `已连接到 ${config.host}`)

          config.lastConnected = Date.now()
          await window.api.config.saveConnection(config)
        } else {
          toast('error', '连接失败', result.error)
        }
      } catch (err: any) {
        toast('error', '连接错误', err.message)
      }
      setConnecting(false)
    }

    const handleOpenSFTP = (e: CustomEvent<{ config: ConnectionConfig; sessionId: string }>) => {
      const { config, sessionId } = e.detail
      addTab({
        id: uuidv4(),
        connectionId: config.id,
        sessionId,
        name: `${config.name} - 文件`,
        type: 'sftp',
        connected: true
      })
    }

    const handleOpenMonitor = (e: CustomEvent<{ config: ConnectionConfig; sessionId: string }>) => {
      const { config, sessionId } = e.detail
      addTab({
        id: uuidv4(),
        connectionId: config.id,
        sessionId,
        name: `${config.name} - 监控`,
        type: 'monitor',
        connected: true
      })
    }

    const handleOpenDocker = (e: CustomEvent<{ config: ConnectionConfig; sessionId: string }>) => {
      const { config, sessionId } = e.detail
      addTab({
        id: uuidv4(),
        connectionId: config.id,
        sessionId,
        name: `${config.name} - Docker`,
        type: 'docker',
        connected: true
      })
    }

    // Docker exec terminal - creates a new terminal tab for docker container shell
    const handleDockerExecTerminal = (e: CustomEvent<{ sessionId: string; containerId: string; parentSessionId?: string }>) => {
      const { sessionId: execSessionId, containerId, parentSessionId } = e.detail
      const shortId = containerId.substring(0, 12)
      addTab({
        id: uuidv4(),
        connectionId: '',
        sessionId: execSessionId,
        parentSessionId: parentSessionId || '',
        name: `Docker: ${shortId}`,
        type: 'terminal',
        connected: true
      })
      toast('success', 'Docker 终端已打开', `容器 ${shortId}`)
    }

    const handleOpenSnippets = () => setShowSnippets(true)
    const handleOpenPortForward = () => {
      useConnectionStore.getState().setBottomPanelVisible(true)
      useConnectionStore.getState().setBottomPanelActiveTab('ports')
    }
    const handleOpenSettings = () => setShowSettings(true)
    const handleToggleBottomPanel = () => {
      const current = useConnectionStore.getState().bottomPanelVisible
      useConnectionStore.getState().setBottomPanelVisible(!current)
    }
    const handleToggleMonitorPanel = () => {
      const current = useConnectionStore.getState().monitorPanelVisible
      useConnectionStore.getState().setMonitorPanelVisible(!current)
    }
    const handleOpenDetailedMonitor = (e: CustomEvent<{ sessionId: string }>) => {
      const { sessionId } = e.detail
      const store = useConnectionStore.getState()
      const existingTab = store.tabs.find((t) => t.sessionId === sessionId)
      if (!existingTab) return
      const conn = store.connections.find((c) => c.id === existingTab.connectionId)
      const name = conn?.name || 'Server'
      addTab({
        id: uuidv4(),
        connectionId: existingTab.connectionId,
        sessionId,
        name: `${name} - 监控`,
        type: 'monitor',
        connected: true
      })
    }

    window.addEventListener('connection:open', handleOpen as unknown as EventListener)
    window.addEventListener('connection:openSFTP', handleOpenSFTP as unknown as EventListener)
    window.addEventListener('connection:openMonitor', handleOpenMonitor as unknown as EventListener)
    window.addEventListener('connection:openDocker', handleOpenDocker as unknown as EventListener)
    window.addEventListener('docker:execTerminal', handleDockerExecTerminal as unknown as EventListener)
    window.addEventListener('app:openSnippets', handleOpenSnippets)
    window.addEventListener('app:openPortForward', handleOpenPortForward)
    window.addEventListener('app:openSettings', handleOpenSettings)
    window.addEventListener('app:toggleBottomPanel', handleToggleBottomPanel)
    window.addEventListener('app:toggleMonitorPanel', handleToggleMonitorPanel)
    window.addEventListener('app:openDetailedMonitor', handleOpenDetailedMonitor as unknown as EventListener)

    return () => {
      window.removeEventListener('connection:open', handleOpen as unknown as EventListener)
      window.removeEventListener('connection:openSFTP', handleOpenSFTP as unknown as EventListener)
      window.removeEventListener('connection:openMonitor', handleOpenMonitor as unknown as EventListener)
      window.removeEventListener('connection:openDocker', handleOpenDocker as unknown as EventListener)
      window.removeEventListener('docker:execTerminal', handleDockerExecTerminal as unknown as EventListener)
      window.removeEventListener('app:openSnippets', handleOpenSnippets)
      window.removeEventListener('app:openPortForward', handleOpenPortForward)
      window.removeEventListener('app:openSettings', handleOpenSettings)
      window.removeEventListener('app:toggleBottomPanel', handleToggleBottomPanel)
      window.removeEventListener('app:toggleMonitorPanel', handleToggleMonitorPanel)
      window.removeEventListener('app:openDetailedMonitor', handleOpenDetailedMonitor as unknown as EventListener)
    }
  }, [addTab, aiCompatibilityMode, toast])

  const handleSnippetExecute = useCallback(
    (command: string) => {
      const activeTab = tabs.find((t) => t.id === activeTabId && t.type === 'terminal')
      if (activeTab) {
        window.api.ssh.write(activeTab.sessionId, command)
        toast('success', '命令已发送')
      } else {
        toast('warning', '无活动终端', '请先打开一个终端标签页')
      }
      setShowSnippets(false)
    },
    [tabs, activeTabId, toast]
  )

  const handleCommandExecute = useCallback(
    (command: string) => {
      const active = tabs.find((t) => t.id === activeTabId && t.type === 'terminal')
      if (active) {
        window.api.ssh.write(active.sessionId, command)
        toast('success', '命令已发送')
      } else {
        toast('warning', '无活动终端', '请先打开一个终端标签页')
      }
    },
    [tabs, activeTabId, toast]
  )

  const handleBottomPanelResize = useCallback(
    (delta: number) => {
      const current = useConnectionStore.getState().bottomPanelHeight
      const newHeight = Math.max(120, Math.min(600, current - delta))
      setBottomPanelHeight(newHeight)
    },
    [setBottomPanelHeight]
  )

  const activeTab = tabs.find((t) => t.id === activeTabId)

  // 当前活跃标签对应的物理服务器 sessionId
  const activePhysicalSession = activeTab?.parentSessionId || activeTab?.sessionId
  const uniqueSessions = useMemo(() => {
    const map = new Map<string, string>()
    tabs.forEach((t) => {
      // Docker 子终端有 parentSessionId，监控应挂载到父级物理服务器
      const physicalSession = t.parentSessionId || t.sessionId
      if(t.type !== 'monitor' && physicalSession) {
        map.set(physicalSession, physicalSession)
      }
    })
    return Array.from(map.values())
  }, [tabs])

  if (!settingsLoaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-muted-foreground">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card/80 px-5 py-3 shadow-lg">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <span className="text-sm">正在加载界面设置...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-background layout-no-select">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        {!zenMode && <Sidebar />}
        {!zenMode && <ResizableDivider direction="vertical" onResize={handleSidebarResize} onResizeEnd={handleSidebarResizeEnd} />}
        {!zenMode && monitorPanelVisible && uniqueSessions.length > 0 && (
          <Suspense fallback={null}>
            {uniqueSessions.map((sessionId) => (
              <div key={`monitor-${sessionId}`} className={activePhysicalSession === sessionId ? 'flex h-full shrink-0' : 'hidden'}>
                <MonitorPanel sessionId={sessionId} />
              </div>
            ))}
          </Suspense>
        )}
        <div className="flex flex-col flex-1 overflow-hidden">
          {!zenMode && <TabBar />}
          <div className="flex flex-col flex-1 overflow-hidden">
            <ContentArea />
            {!zenMode && activeTab && bottomPanelVisible && (
              <ResizableDivider direction="horizontal" onResize={handleBottomPanelResize} />
            )}
            {!zenMode && uniqueSessions.length > 0 && (
              <Suspense fallback={null}>
                {uniqueSessions.map((sessionId) => (
                  <div key={`bottom-${sessionId}`} className={activePhysicalSession === sessionId ? 'flex flex-col shrink-0' : 'hidden'}>
                    <BottomPanel
                      sessionId={sessionId}
                      height={bottomPanelVisible ? bottomPanelHeight : 0}
                      onExecute={handleCommandExecute}
                      onOpenManager={() => setShowSnippets(true)}
                    />
                  </div>
                ))}
              </Suspense>
            )}
          </div>
        </div>
      </div>
      {!zenMode && <StatusBar />}
      {/* Zen mode: mini tab bar + controls (hover to reveal at top) */}
      {zenMode && tabs.length > 0 && (
        <div
          className="fixed top-9 left-0 right-0 z-[200] flex items-center justify-center"
          style={{ pointerEvents: 'none' }}
        >
          <div
            className="flex items-center gap-1 bg-card/95 backdrop-blur-md px-2 py-1 rounded-b-xl border border-t-0 border-border/40 shadow-xl transition-all duration-200 opacity-0 hover:opacity-100"
            style={{ pointerEvents: 'auto' }}
            onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
            onMouseLeave={(e) => e.currentTarget.style.opacity = '0'}
          >
            {tabs.map((tab) => {
              const isActive = tab.id === activeTabId
              return (
                <button
                  key={tab.id}
                  onClick={() => useConnectionStore.getState().setActiveTab(tab.id)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all truncate max-w-[140px] ${
                    isActive
                      ? 'bg-primary/15 text-primary border border-primary/25 shadow-sm'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                  }`}
                  title={tab.name}
                >
                  {tab.name}
                </button>
              )
            })}
            <div className="w-px h-4 bg-border/40 mx-1" />
            <button
              onClick={() => setZenMode(false)}
              className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              title="退出专注模式 (Esc)"
            >
              <Minimize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Zen mode floating hint (auto-dismiss) */}
      {zenMode && zenHintVisible && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[200] flex items-center gap-2 bg-card/90 backdrop-blur-sm px-4 py-1.5 rounded-full border border-border/50 shadow-lg text-xs text-muted-foreground animate-in fade-in">
          <Maximize2 className="w-3 h-3" />
          <span>专注模式 · 顶部悬停切换标签 · <kbd className="px-1.5 py-0.5 bg-secondary rounded text-[10px] font-mono">Esc</kbd> 退出</span>
        </div>
      )}

      <Suspense fallback={null}>
        <ConnectionDialog />
        {showSnippets && (
          <SnippetManager
            isOpen={showSnippets}
            onClose={() => setShowSnippets(false)}
            onExecute={handleSnippetExecute}
          />
        )}
        {showSettings && (
          <SettingsDialog isOpen={showSettings} onClose={() => setShowSettings(false)} sessionId={activeTab?.sessionId} />
        )}
      </Suspense>

      {/* Non-blocking connecting indicator */}
      {connecting && (
        <div className="fixed bottom-10 right-4 z-[200] flex items-center gap-3 bg-card px-5 py-3 rounded-xl border border-border shadow-2xl">
          <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-medium">正在连接...</span>
        </div>
      )}
    </div>
  )
}

import { Component, ReactNode, ErrorInfo } from 'react'

class GlobalErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; errorInfo: ErrorInfo | null }> {
  state: { error: Error | null; errorInfo: ErrorInfo | null } = { error: null, errorInfo: null }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    this.setState({ error, errorInfo })
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 20, color: 'red', background: '#1e1e1e', height: '100vh', overflow: 'auto', zIndex: 99999, position: 'relative' }}>
          <h2>React Application Crash</h2>
          <pre style={{ whiteSpace: 'pre-wrap', marginTop: 10 }}>{this.state.error.toString()}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#888', marginTop: 10 }}>{this.state.errorInfo?.componentStack}</pre>
        </div>
      )
    }
    return this.props.children
  }
}

function App() {
  return (
    <GlobalErrorBoundary>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </GlobalErrorBoundary>
  )
}

export default App
