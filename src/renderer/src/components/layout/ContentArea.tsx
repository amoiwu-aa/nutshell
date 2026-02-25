import { useState, useEffect, Component, type ReactNode } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'

// Error boundary for workspace panel
class WorkspaceErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) return (
      <div style={{padding:20,color:'#f14c4c',background:'#1e1e1e',height:'100%',fontFamily:'monospace',fontSize:14}}>
        <h2>工作区加载失败</h2>
        <pre style={{whiteSpace:'pre-wrap',color:'#cccccc',marginTop:10}}>{this.state.error.message}</pre>
        <pre style={{whiteSpace:'pre-wrap',color:'#6e7681',marginTop:10,fontSize:12}}>{this.state.error.stack}</pre>
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
  const { tabs, activeTabId } = useConnectionStore()
  const activeTab = tabs.find((t) => t.id === activeTabId)
  const [editingFile, setEditingFile] = useState<EditingFile | null>(null)

  useEffect(() => {
    const handleFileEdit = (e: CustomEvent<EditingFile>) => {
      setEditingFile(e.detail)
    }

    window.addEventListener('file:edit', handleFileEdit as EventListener)
    return () => {
      window.removeEventListener('file:edit', handleFileEdit as EventListener)
    }
  }, [])

  if (!activeTab && !editingFile) {
    return <WelcomeScreen />
  }

  // FIXED: Render tabs AND editor as siblings using display toggle,
  // instead of conditionally unmounting tabs (which destroyed terminal history)
  return (
    <div className="flex-1 min-h-0 overflow-hidden relative">
      {/* File editor overlay - shown on top when editing */}
      {editingFile && (
        <div className="absolute inset-0 z-10">
          <FileEditor
            sessionId={editingFile.sessionId}
            filePath={editingFile.path}
            fileName={editingFile.filename}
            onClose={() => setEditingFile(null)}
          />
        </div>
      )}

      {/* Tabs - always rendered, hidden behind editor when editing */}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className="absolute inset-0"
          style={{ display: !editingFile && tab.id === activeTabId ? 'flex' : 'none' }}
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
        </div>
      ))}
    </div>
  )
}
