import { useEffect, Component, type ReactNode } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'
import { v4 as uuidv4 } from 'uuid'

// Error boundary for workspace panel
class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 20, color: '#f14c4c', background: '#1e1e1e', height: '100%', fontFamily: 'monospace', fontSize: 14 }}>
        <h2>工作区加载失败</h2>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#cccccc', marginTop: 10 }}>{this.state.error.message}</pre>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#6e7681', marginTop: 10, fontSize: 12 }}>{this.state.error.stack}</pre>
      </div>
    )
    return this.props.children
  }
}
import { Suspense, lazy } from 'react'

const TerminalPanel = lazy(() => import('../terminal/TerminalPanel').then(m => ({ default: m.TerminalPanel })))
const FileExplorer = lazy(() => import('../sftp/FileExplorer').then(m => ({ default: m.FileExplorer })))
const FileEditor = lazy(() => import('../sftp/FileEditor').then(m => ({ default: m.FileEditor })))
const MonitorDashboard = lazy(() => import('../monitor/MonitorDashboard').then(m => ({ default: m.MonitorDashboard })))
const DockerPanel = lazy(() => import('../docker/DockerPanel').then(m => ({ default: m.DockerPanel })))
const WorkspacePanel = lazy(() => import('../workspace/WorkspacePanel').then(m => ({ default: m.WorkspacePanel })))

import { WelcomeScreen } from './WelcomeScreen'

// Simple loading fallback
function LoadingFallback({ name }: { name: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background/50">
      <div className="flex flex-col items-center gap-3">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <span className="text-xs text-muted-foreground">加载 {name}...</span>
      </div>
    </div>
  )
}

interface EditingFile {
  sessionId: string
  path: string
  filename: string
}

export function ContentArea() {
  const tabs = useConnectionStore((state) => state.tabs)
  const activeTabId = useConnectionStore((state) => state.activeTabId)
  const addTab = useConnectionStore((state) => state.addTab)
  const removeTab = useConnectionStore((state) => state.removeTab)
  const activeTab = tabs.find((t) => t.id === activeTabId)

  // file:edit → open as a dedicated editor tab instead of an overlay
  useEffect(() => {
    const handleFileEdit = (e: CustomEvent<EditingFile>) => {
      const { sessionId, path, filename } = e.detail
      // Re-activate existing editor tab for the same file if already open
      const store = useConnectionStore.getState()
      const existing = store.tabs.find(
        (t) => t.type === 'editor' && t.filePath === path && t.sessionId === sessionId
      )
      if (existing) {
        store.setActiveTab(existing.id)
        return
      }
      addTab({
        id: uuidv4(),
        connectionId: '',
        sessionId,
        name: filename,
        type: 'editor',
        filePath: path,
        fileName: filename,
        connected: true
      })
    }

    window.addEventListener('file:edit', handleFileEdit as EventListener)
    return () => window.removeEventListener('file:edit', handleFileEdit as EventListener)
  }, [addTab])

  if (!activeTab) {
    return <WelcomeScreen />
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden relative">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId
        return (
        <div
          key={tab.id}
          className="absolute inset-0 flex flex-col overflow-hidden"
          style={{ display: isActive ? 'flex' : 'none' }}
        >
          <Suspense fallback={<LoadingFallback name="终端" />}>
            {tab.type === 'terminal' && (
              <TerminalPanel sessionId={tab.sessionId} tabId={tab.id} isActive={isActive} engine={tab.engine || 'node'} />
            )}
          </Suspense>
          <Suspense fallback={<LoadingFallback name="文件管理器" />}>
            {tab.type === 'sftp' && (
              <FileExplorer sessionId={tab.sessionId} tabId={tab.id} />
            )}
            {tab.type === 'editor' && tab.filePath && tab.fileName && (
              <FileEditor
                sessionId={tab.sessionId}
                filePath={tab.filePath}
                fileName={tab.fileName}
                onClose={() => removeTab(tab.id)}
              />
            )}
          </Suspense>
          <Suspense fallback={<LoadingFallback name="监控" />}>
            {tab.type === 'monitor' && (
              <MonitorDashboard sessionId={tab.sessionId} tabId={tab.id} isActive={isActive} />
            )}
          </Suspense>
          <Suspense fallback={<LoadingFallback name="Docker" />}>
            {tab.type === 'docker' && (
              <DockerPanel sessionId={tab.sessionId} tabId={tab.id} />
            )}
          </Suspense>
          <Suspense fallback={<LoadingFallback name="工作区" />}>
            {tab.type === 'workspace' && tab.workspacePath && (
              <WorkspaceErrorBoundary>
                <WorkspacePanel sessionId={tab.sessionId} tabId={tab.id} rootPath={tab.workspacePath} isActive={isActive} />
              </WorkspaceErrorBoundary>
            )}
          </Suspense>
        </div>
        )
      })}
    </div>
  )
}
