import { ArrowUpDown, Trash2 } from 'lucide-react'
import { useTransferStore } from '../../stores/transferStore'
import { TransferRow } from './TransferRow'

export function TransferPanel() {
  const transfers = useTransferStore((s) => s.transfers)
  const clearCompleted = useTransferStore((s) => s.clearCompleted)

  const activeCount = transfers.filter((t) => t.status === 'active').length
  const completedCount = transfers.filter((t) => t.status === 'completed').length

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 shrink-0">
        <span className="text-[10px] text-muted-foreground">
          {activeCount > 0 ? `${activeCount} 个传输中` : '无活动传输'}
          {completedCount > 0 && ` | ${completedCount} 个已完成`}
        </span>
        {completedCount > 0 && (
          <button
            onClick={clearCompleted}
            className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <Trash2 className="w-2.5 h-2.5" />
            清除已完成
          </button>
        )}
      </div>

      {/* Transfer list */}
      <div className="flex-1 overflow-y-auto">
        {transfers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <ArrowUpDown className="w-6 h-6 mb-1 opacity-50" />
            <p className="text-xs">暂无传输任务</p>
            <p className="text-[10px] mt-0.5">拖拽文件到文件面板即可开始上传</p>
          </div>
        ) : (
          transfers.map((transfer) => (
            <TransferRow key={transfer.id} transfer={transfer} />
          ))
        )}
      </div>
    </div>
  )
}
