import { useEffect, useState, useCallback } from 'react'
import { TitleBar } from './components/layout/TitleBar'
import { Sidebar } from './components/layout/Sidebar'
import { TabBar } from './components/layout/TabBar'
import { StatusBar } from './components/layout/StatusBar'
import { ContentArea } from './components/layout/ContentArea'
import { ConnectionDialog } from './components/connection/ConnectionDialog'
import { SnippetManager } from './components/snippet/SnippetManager'
import { MonitorPanel } from './components/monitor/MonitorPanel'
import { BottomPanel } from './components/layout/BottomPanel'
import { ResizableDivider } from './components/layout/ResizableDivider'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { ScriptWorkshop } from './components/ai/ScriptWorkshop'
import { ToastProvider, useToast } from './components/ui/Toast'
import { useConnectionStore, type ConnectionConfig, type Tab } from './stores/connectionStore'
import { useSettingsStore } from './stores/settingsStore'
import { useTransferStore } from './stores/transferStore'
import { v4 as uuidv4 } from 'uuid'

function AppContent() {
  const {
    setConnections, addTab, tabs, activeTabId, updateTab,
    monitorPanelVisible, bottomPanelVisible, bottomPanelHeight,
    setBottomPanelHeight
  } = useConnectionStore()
  const { loadSettings, setSettings, setSettingsMemOnly } = useSettingsStore()
  const { toast } = useToast()
  const [showSnippets, setShowSnippets] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showScriptWorkshop, setShowScriptWorkshop] = useState(false)
  const [connecting, setConnecting] = useState(false)

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

  // Global transfer progress listener — throttled to avoid UI stutter
  useEffect(() => {
    const pending = new Map<string, { transferred: number; total: number }>()
    let rafId: number | null = null

    const flush = () => {
      rafId = null
      const store = useTransferStore.getState()
      pending.forEach(({ transferred, total }, id) => {
        store.updateProgress(id, transferred, total)
      })
      pending.clear()
    }

    const cleanup = window.api.sftp.onProgress((id: string, transferred: number, total: number) => {
      pending.set(id, { transferred, total })
      if (rafId === null) {
        rafId = requestAnimationFrame(flush)
      }
    })
    return () => {
      cleanup()
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

      setConnecting(true)
      try {
        const result = await window.api.ssh.connect(config)
        if (result.success) {
          const terminalTab: Tab = {
            id: tabId,
            connectionId: config.id,
            sessionId: result.sessionId,
            name: `${config.name} - 终端`,
            type: 'terminal',
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
    const handleDockerExecTerminal = (e: CustomEvent<{ sessionId: string; containerId: string }>) => {
      const { sessionId: execSessionId, containerId } = e.detail
      const shortId = containerId.substring(0, 12)
      addTab({
        id: uuidv4(),
        connectionId: '',
        sessionId: execSessionId,
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
    const handleOpenScriptWorkshop = () => setShowScriptWorkshop(true)
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

    window.addEventListener('connection:open', handleOpen as EventListener)
    window.addEventListener('connection:openSFTP', handleOpenSFTP as EventListener)
    window.addEventListener('connection:openMonitor', handleOpenMonitor as EventListener)
    window.addEventListener('connection:openDocker', handleOpenDocker as EventListener)
    window.addEventListener('docker:execTerminal', handleDockerExecTerminal as EventListener)
    window.addEventListener('app:openSnippets', handleOpenSnippets)
    window.addEventListener('app:openPortForward', handleOpenPortForward)
    window.addEventListener('app:openSettings', handleOpenSettings)
    window.addEventListener('app:openScriptWorkshop', handleOpenScriptWorkshop)
    window.addEventListener('app:toggleBottomPanel', handleToggleBottomPanel)
    window.addEventListener('app:toggleMonitorPanel', handleToggleMonitorPanel)
    window.addEventListener('app:openDetailedMonitor', handleOpenDetailedMonitor as EventListener)

    return () => {
      window.removeEventListener('connection:open', handleOpen as EventListener)
      window.removeEventListener('connection:openSFTP', handleOpenSFTP as EventListener)
      window.removeEventListener('connection:openMonitor', handleOpenMonitor as EventListener)
      window.removeEventListener('connection:openDocker', handleOpenDocker as EventListener)
      window.removeEventListener('docker:execTerminal', handleDockerExecTerminal as EventListener)
      window.removeEventListener('app:openSnippets', handleOpenSnippets)
      window.removeEventListener('app:openPortForward', handleOpenPortForward)
      window.removeEventListener('app:openSettings', handleOpenSettings)
      window.removeEventListener('app:openScriptWorkshop', handleOpenScriptWorkshop)
      window.removeEventListener('app:toggleBottomPanel', handleToggleBottomPanel)
      window.removeEventListener('app:toggleMonitorPanel', handleToggleMonitorPanel)
      window.removeEventListener('app:openDetailedMonitor', handleOpenDetailedMonitor as EventListener)
    }
  }, [addTab, toast])

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

  return (
    <div className="flex flex-col h-screen bg-background layout-no-select">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <ResizableDivider direction="vertical" onResize={handleSidebarResize} onResizeEnd={handleSidebarResizeEnd} />
        {activeTab && monitorPanelVisible && (
          <MonitorPanel key={activeTab.sessionId} sessionId={activeTab.sessionId} />
        )}
        <div className="flex flex-col flex-1 overflow-hidden">
          <TabBar />
          <div className="flex flex-col flex-1 overflow-hidden">
            <ContentArea />
            {activeTab && bottomPanelVisible && (
              <>
                <ResizableDivider direction="horizontal" onResize={handleBottomPanelResize} />
                <BottomPanel
                  sessionId={activeTab.sessionId}
                  height={bottomPanelHeight}
                  onExecute={handleCommandExecute}
                  onOpenManager={() => setShowSnippets(true)}
                />
              </>
            )}
          </div>
        </div>
      </div>
      <StatusBar />
      <ConnectionDialog />
      <SnippetManager
        isOpen={showSnippets}
        onClose={() => setShowSnippets(false)}
        onExecute={handleSnippetExecute}
      />
      <SettingsDialog isOpen={showSettings} onClose={() => setShowSettings(false)} />
      <ScriptWorkshop isOpen={showScriptWorkshop} onClose={() => setShowScriptWorkshop(false)} sessionId={activeTab?.sessionId} />

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

function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  )
}

export default App
