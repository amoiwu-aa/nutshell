import { useState, useCallback } from 'react'
import { FolderOpen, Code2, Send, ChevronDown, ArrowUpDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTransferStore } from '../../stores/transferStore'
import { MiniFileExplorer } from '../sftp/MiniFileExplorer'
import { CommandPanel } from '../snippet/CommandPanel'
import { TransferPanel } from '../transfer/TransferPanel'

interface BottomPanelProps {
  sessionId: string
  height: number
  onExecute: (command: string) => void
  onOpenManager: () => void
}

export function BottomPanel({ sessionId, height, onExecute, onOpenManager }: BottomPanelProps) {
  const { bottomPanelActiveTab, setBottomPanelActiveTab, tabs } = useConnectionStore()
  const activeTransferCount = useTransferStore((s) => {
    let count = 0
    for (const t of s.transfers) if (t.status === 'active') count++
    return count
  })
  const [sendTarget, setSendTarget] = useState<'current' | 'all' | string>('current')
  const [commandInput, setCommandInput] = useState('')
  const [showTargetMenu, setShowTargetMenu] = useState(false)

  const terminalTabs = tabs.filter((t) => t.type === 'terminal' && t.connected)

  const handleSend = useCallback(() => {
    if (!commandInput.trim()) return
    const cmd = commandInput + '\n'
    if (sendTarget === 'all') {
      terminalTabs.forEach((t) => window.api.ssh.write(t.sessionId, cmd))
    } else if (sendTarget === 'current') {
      onExecute(cmd)
    } else {
      window.api.ssh.write(sendTarget, cmd)
    }
    setCommandInput('')
  }, [commandInput, sendTarget, terminalTabs, onExecute])

  const getTargetLabel = () => {
    if (sendTarget === 'current') return '当前会话'
    if (sendTarget === 'all') return '所有会话'
    const tab = tabs.find((t) => t.sessionId === sendTarget)
    return tab?.name || sendTarget
  }

  return (
    <div className="flex flex-col bg-card border-t border-border overflow-hidden shrink-0" style={{ height, minHeight: 80 }}>
      {/* Tab bar */}
      <div className="flex items-center border-b border-border/50 shrink-0">
        <button
          onClick={() => setBottomPanelActiveTab('files')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2',
            bottomPanelActiveTab === 'files'
              ? 'text-primary border-primary'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
          )}
        >
          <FolderOpen className="w-3.5 h-3.5" />
          文件
        </button>
        <button
          onClick={() => setBottomPanelActiveTab('commands')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2',
            bottomPanelActiveTab === 'commands'
              ? 'text-primary border-primary'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
          )}
        >
          <Code2 className="w-3.5 h-3.5" />
          命令
        </button>
        <button
          onClick={() => setBottomPanelActiveTab('transfers')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2',
            bottomPanelActiveTab === 'transfers'
              ? 'text-primary border-primary'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
          )}
        >
          <ArrowUpDown className="w-3.5 h-3.5" />
          传输
          {activeTransferCount > 0 && (
            <span className="px-1 py-0 bg-primary text-primary-foreground rounded-full text-[9px] leading-tight font-bold">
              {activeTransferCount}
            </span>
          )}
        </button>
      </div>

      {/* Tab content — all panels stay mounted, inactive ones hidden via CSS */}
      <div className="flex-1 overflow-hidden relative">
        <div className={cn('absolute inset-0', bottomPanelActiveTab !== 'files' && 'hidden')}>
          <MiniFileExplorer sessionId={sessionId} />
        </div>
        <div className={cn('absolute inset-0', bottomPanelActiveTab !== 'commands' && 'hidden')}>
          <CommandPanel onExecute={onExecute} onOpenManager={onOpenManager} />
        </div>
        <div className={cn('absolute inset-0', bottomPanelActiveTab !== 'transfers' && 'hidden')}>
          <TransferPanel />
        </div>
      </div>

      {/* Send bar */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-t border-border/50 shrink-0 bg-background/50">
        <span className="text-[10px] text-muted-foreground shrink-0">发送到</span>
        <div className="relative">
          <button
            onClick={() => setShowTargetMenu(!showTargetMenu)}
            className="flex items-center gap-1 px-2 py-0.5 bg-secondary rounded text-xs hover:bg-secondary/80 transition-colors"
          >
            <span className="max-w-[100px] truncate">{getTargetLabel()}</span>
            <ChevronDown className="w-3 h-3" />
          </button>
          {showTargetMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowTargetMenu(false)} />
              <div className="absolute bottom-full left-0 mb-1 z-50 bg-card border border-border rounded-md shadow-lg py-1 min-w-[160px]">
                <button
                  onClick={() => { setSendTarget('current'); setShowTargetMenu(false) }}
                  className={cn('w-full px-3 py-1 text-xs text-left hover:bg-accent transition-colors', sendTarget === 'current' && 'text-primary')}
                >
                  当前会话
                </button>
                <button
                  onClick={() => { setSendTarget('all'); setShowTargetMenu(false) }}
                  className={cn('w-full px-3 py-1 text-xs text-left hover:bg-accent transition-colors', sendTarget === 'all' && 'text-primary')}
                >
                  所有会话
                </button>
                {terminalTabs.length > 0 && <div className="border-t border-border my-0.5" />}
                {terminalTabs.map((t) => (
                  <button
                    key={t.sessionId}
                    onClick={() => { setSendTarget(t.sessionId); setShowTargetMenu(false) }}
                    className={cn('w-full px-3 py-1 text-xs text-left hover:bg-accent transition-colors truncate', sendTarget === t.sessionId && 'text-primary')}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <input
          type="text"
          value={commandInput}
          onChange={(e) => setCommandInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSend() }}
          placeholder="输入命令..."
          className="flex-1 px-2 py-0.5 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={handleSend}
          className="flex items-center gap-1 px-2.5 py-0.5 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90 transition-colors shrink-0"
        >
          <Send className="w-3 h-3" />
          发送
        </button>
      </div>
    </div>
  )
}
