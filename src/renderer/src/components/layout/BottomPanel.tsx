import { FolderOpen, Code2, ArrowUpDown, ArrowRightLeft } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTransferStore } from '../../stores/transferStore'
import { MiniFileExplorer } from '../sftp/MiniFileExplorer'
import { CommandPanel } from '../snippet/CommandPanel'
import { TransferPanel } from '../transfer/TransferPanel'
import { PortForwardPanel } from '../portforward/PortForwardPanel'

interface BottomPanelProps {
  sessionId: string
  height: number
  onExecute: (command: string) => void
  onOpenManager: () => void
}

export function BottomPanel({ sessionId, height, onExecute, onOpenManager }: BottomPanelProps) {
  const bottomPanelActiveTab = useConnectionStore((state) => state.bottomPanelActiveTab)
  const setBottomPanelActiveTab = useConnectionStore((state) => state.setBottomPanelActiveTab)
  const activeTransferCount = useTransferStore((s) => {
    let count = 0
    for (const t of s.transfers) if (t.status === 'active') count++
    return count
  })

  return (
    <div
      className="flex flex-col bg-card border-t border-border shrink-0 overflow-hidden"
      style={{ height: height > 0 ? height : 0, minHeight: height > 0 ? 80 : 0 }}
    >
      {/* Tab bar */}
      <div className="flex items-center border-b border-border/50 shrink-0">
        <button
          onClick={() => setBottomPanelActiveTab('files')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2',
            bottomPanelActiveTab === 'files'
              ? 'text-primary border-primary tab-active-glow'
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
              ? 'text-primary border-primary tab-active-glow'
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
              ? 'text-primary border-primary tab-active-glow'
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
        <button
          onClick={() => setBottomPanelActiveTab('ports')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors border-b-2',
            bottomPanelActiveTab === 'ports'
              ? 'text-primary border-primary tab-active-glow'
              : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50'
          )}
        >
          <ArrowRightLeft className="w-3.5 h-3.5" />
          端口
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
        <div className={cn('absolute inset-0', bottomPanelActiveTab !== 'ports' && 'hidden')}>
          <PortForwardPanel sessionId={sessionId} />
        </div>
      </div>

    </div>
  )
}
