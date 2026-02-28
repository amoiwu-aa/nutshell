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
import { TerminalPanel } from '../terminal/TerminalPanel'
import { FileExplorer } from '../sftp/FileExplorer'
import { FileEditor } from '../sftp/FileEditor'
import { MonitorDashboard } from '../monitor/MonitorDashboard'
import { DockerPanel } from '../docker/DockerPanel'
import { WorkspacePanel } from '../workspace/WorkspacePanel'
import { WelcomeScreen } from './WelcomeScreen'

interface EditingFile {
  sessionId: string
  path: string
  filename: string
}

export function ContentArea() {
  const { tabs, activeTabId, addTab, removeTab } = useConnectionStore()
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
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="absolute inset-0 flex flex-col overflow-hidden"
          style={{ display: tab.id === activeTabId ? 'flex' : 'none' }}
        >
          {tab.type === 'terminal' && (
            <TerminalPanel sessionId={tab.sessionId} tabId={tab.id} />
          )}
          {tab.type === 'sftp' && (
            <FileExplorer sessionId={tab.sessionId} tabId={tab.id} />
          )}
          {tab.type === 'monitor' && (
            <MonitorDashboard sessionId={tab.sessionId} tabId={tab.id} />
          )}
          {tab.type === 'docker' && (
            <DockerPanel sessionId={tab.sessionId} tabId={tab.id} />
          )}
          {tab.type === 'workspace' && tab.workspacePath && (
            <WorkspaceErrorBoundary>
              <WorkspacePanel sessionId={tab.sessionId} tabId={tab.id} rootPath={tab.workspacePath} />
            </WorkspaceErrorBoundary>
          )}
          {tab.type === 'editor' && tab.filePath && tab.fileName && (
            <FileEditor
              sessionId={tab.sessionId}
              filePath={tab.filePath}
              fileName={tab.fileName}
              onClose={() => removeTab(tab.id)}
            />
          )}
        </div>
      ))}
    </div>
  )
}
