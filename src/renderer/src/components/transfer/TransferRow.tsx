import React, { useState, useCallback, useRef } from 'react'
import { Upload, Download, X, Check, RotateCcw, AlertCircle, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react'
import { formatBytes, formatBytesPerSec } from '../../lib/utils'
import { useTransferStore, type TransferItem } from '../../stores/transferStore'

function formatETA(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return '--:--'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDuration(startMs: number, endMs: number): string {
  const seconds = Math.floor((endMs - startMs) / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

interface TransferRowProps {
  transfer: TransferItem
}

export const TransferRow = React.memo(function TransferRow({ transfer }: TransferRowProps) {
  const setStatus = useTransferStore((s) => s.setStatus)
  const removeTransfer = useTransferStore((s) => s.removeTransfer)

  const [expanded, setExpanded] = useState(false)

  const percent = transfer.totalSize > 0
    ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalSize) * 100))
    : 0

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await window.api.sftp.cancelTransfer(transfer.id)
    setStatus(transfer.id, 'cancelled')
  }

  const handleRetry = async (fromStart: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    let resumeOffset = 0
    if (!fromStart && transfer.transferredBytes > 0) {
      if (transfer.direction === 'upload') {
        const result = await window.api.sftp.getRemoteFileSize(transfer.sessionId, transfer.remotePath)
        if (result.success) resumeOffset = result.size
      } else {
        resumeOffset = transfer.transferredBytes
      }
    }

    setStatus(transfer.id, 'active')

    const apiCall = transfer.direction === 'upload'
      ? window.api.sftp.uploadWithId(transfer.sessionId, transfer.localPath, transfer.remotePath, transfer.id, resumeOffset)
      : window.api.sftp.downloadWithId(transfer.sessionId, transfer.remotePath, transfer.localPath, transfer.id, resumeOffset)

    apiCall.then((result: any) => {
      if (result && !result.success) {
        setStatus(transfer.id, 'failed', result.error || 'Unknown error')
      } else {
        setStatus(transfer.id, 'completed')
      }
    }).catch((err: any) => {
      setStatus(transfer.id, 'failed', err?.message || 'Unknown error')
    })
  }

  const isActive = transfer.status === 'active'
  const isCompleted = transfer.status === 'completed'
  const isFailed = transfer.status === 'failed' || transfer.status === 'cancelled'
  const isQueued = transfer.status === 'queued'

  const hasSubFiles = transfer.subFiles && transfer.subFiles.length > 0

  return (
    <div className="px-3 py-2 border-b border-border/30 hover:bg-accent/30 transition-colors">
      {/* Top line: icon + filename + status info + actions */}
      <div
        className={`flex items-center gap-2 mb-1 ${hasSubFiles ? 'cursor-pointer select-none' : ''}`}
        onClick={() => hasSubFiles && setExpanded(!expanded)}
      >
        {/* Expand toggle */}
        {hasSubFiles ? (
          expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        ) : null}

        {/* Direction icon */}
        {!hasSubFiles && (
          transfer.direction === 'upload' ? (
            <Upload className="w-3.5 h-3.5 text-blue-400 shrink-0" />
          ) : (
            <Download className="w-3.5 h-3.5 text-green-400 shrink-0" />
          )
        )}

        {/* Filename */}
        <span className="text-xs truncate flex-1" title={transfer.remotePath}>
          {transfer.filename}
          {transfer.currentFile && !expanded && (
            <span className="ml-2 pr-1 text-[10px] text-muted-foreground" title={transfer.currentFile}>
              ({transfer.currentFile})
            </span>
          )}
        </span>

        {/* Status info */}
        {isActive && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {percent}% | {formatBytesPerSec(transfer.speed)} | ETA {formatETA(transfer.eta)}
          </span>
        )}
        {isQueued && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            排队中...
          </span>
        )}
        {isCompleted && (
          <span className="flex items-center gap-1 text-[10px] text-green-500 shrink-0">
            <Check className="w-3 h-3" />
            {formatBytes(transfer.totalSize)}
            {transfer.completedAt && ` | ${formatDuration(transfer.startedAt, transfer.completedAt)}`}
          </span>
        )}
        {isFailed && (
          <span className="text-[10px] text-destructive shrink-0 max-w-[160px] truncate" title={transfer.error}>
            {transfer.error ? transfer.error : transfer.status === 'cancelled' ? '已取消' : '失败'}
          </span>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          {(isActive || isQueued) && (
            <button onClick={handleCancel} className="p-0.5 hover:bg-accent rounded transition-colors" title="取消">
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          )}
          {isFailed && (
            <>
              {transfer.resumable && (
                <button
                  onClick={(e) => handleRetry(false, e)}
                  className="p-0.5 hover:bg-accent rounded transition-colors"
                  title="断点续传"
                >
                  <RotateCcw className="w-3 h-3 text-primary" />
                </button>
              )}
              <button
                onClick={(e) => handleRetry(true, e)}
                className="p-0.5 hover:bg-accent rounded transition-colors"
                title="重新开始"
              >
                <AlertCircle className="w-3 h-3 text-muted-foreground" />
              </button>
            </>
          )}
          {isCompleted && transfer.direction === 'download' && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                window.api.system.showItemInFolder(transfer.localPath)
              }}
              className="p-0.5 hover:bg-accent rounded transition-colors"
              title="打开所在文件夹"
            >
              <FolderOpen className="w-3 h-3 text-primary" />
            </button>
          )}
          {(isCompleted || isFailed) && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                removeTransfer(transfer.id)
              }}
              className="p-0.5 hover:bg-accent rounded transition-colors"
              title="移除"
            >
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Progress bar (only for active/queued) */}
      {(isActive || transfer.status === 'queued') && (
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden mt-1.5 mb-1">
          <div
            className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${percent}%`,
              backgroundColor: transfer.direction === 'upload' ? '#3b82f6' : '#10b981'
            }}
          />
        </div>
      )}

      {/* Completed bar (full green) */}
      {isCompleted && (
        <div className="h-1 bg-green-500/30 rounded-full overflow-hidden mt-1 mb-1">
          <div className="h-full rounded-full bg-green-500" style={{ width: '100%' }} />
        </div>
      )}

      {/* Failed bar (partial red) */}
      {isFailed && percent > 0 && (
        <div className="h-1 bg-secondary rounded-full overflow-hidden mt-1 mb-1">
          <div
            className="h-full rounded-full bg-destructive"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {/* Sub-files drop down */}
      {expanded && hasSubFiles && (
        <SubFileList transfer={transfer} />
      )}
    </div>
  )
})

/** Sub-file list with batch selection support */
function SubFileList({ transfer }: { transfer: TransferItem }) {
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const lastClickedIdx = useRef<number | null>(null)

  // Only queued files can be selected for skipping
  const queuedIndices = transfer.subFiles!
    .filter(sf => sf.status === 'queued')
    .map(sf => sf.index)

  const handleRowClick = useCallback((sfIndex: number, e: React.MouseEvent) => {
    e.stopPropagation()
    // Only allow selecting queued files
    const sf = transfer.subFiles!.find(f => f.index === sfIndex)
    if (!sf || sf.status !== 'queued') return

    setSelected(prev => {
      const next = new Set(prev)

      if (e.shiftKey && lastClickedIdx.current !== null) {
        // Range select: from lastClicked to current
        const from = lastClickedIdx.current
        const to = sfIndex
        const lo = Math.min(from, to)
        const hi = Math.max(from, to)
        for (const idx of queuedIndices) {
          if (idx >= lo && idx <= hi) {
            next.add(idx)
          }
        }
      } else {
        // Toggle single
        if (next.has(sfIndex)) {
          next.delete(sfIndex)
        } else {
          next.add(sfIndex)
        }
      }

      lastClickedIdx.current = sfIndex
      return next
    })
  }, [transfer.subFiles, queuedIndices])

  const handleBatchSkip = useCallback(() => {
    const store = useTransferStore.getState()
    selected.forEach(idx => {
      window.api.sftp.skipFile(transfer.id, idx)
      store.setSubFileStatus(transfer.id, idx, 'skipped')
    })
    setSelected(new Set())
  }, [selected, transfer.id])

  const handleSelectAllQueued = useCallback(() => {
    setSelected(new Set(queuedIndices))
  }, [queuedIndices])

  const completedCount = transfer.subFiles!.filter(f => f.status === 'completed').length
  const skippedCount = transfer.subFiles!.filter(f => f.status === 'skipped').length

  return (
    <div className="mt-2 pl-4 pr-1 max-h-[200px] overflow-y-auto space-y-0.5">
      {/* Header with stats and batch actions */}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground pb-1 border-b border-border/20 mb-1">
        <span>
          共 {transfer.subFiles!.length} 个文件
          {completedCount > 0 && (
            <span className="text-green-500 ml-2">✓ {completedCount}</span>
          )}
          {skippedCount > 0 && (
            <span className="text-yellow-500 ml-2">⊘ {skippedCount} 已跳过</span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <span className="text-primary">已选 {selected.size} 项</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleBatchSkip() }}
                className="px-1.5 py-0.5 bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30 rounded transition-colors"
                title="跳过选中文件"
              >
                批量跳过
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); setSelected(new Set()) }}
                className="px-1.5 py-0.5 hover:bg-accent rounded transition-colors"
                title="取消选择"
              >
                取消
              </button>
            </>
          )}
          {selected.size === 0 && queuedIndices.length > 1 && (
            <button
              onClick={(e) => { e.stopPropagation(); handleSelectAllQueued() }}
              className="px-1.5 py-0.5 hover:bg-accent rounded transition-colors"
              title="全选等待中的文件"
            >
              全选等待
            </button>
          )}
        </div>
      </div>

      {/* File rows */}
      {transfer.subFiles!.map((sf) => {
        const isSFActive = sf.status === 'active'
        const isSFCompleted = sf.status === 'completed'
        const isSFQueued = sf.status === 'queued'
        const isSFFailed = sf.status === 'failed'
        const isSFSkipped = sf.status === 'skipped'
        const isSelected = selected.has(sf.index)

        return (
          <div
            key={sf.index}
            onClick={(e) => handleRowClick(sf.index, e)}
            className={`flex items-center text-[10px] rounded px-2 py-1 transition-colors ${isSelected ? 'bg-primary/15 ring-1 ring-primary/40' :
                isSFActive ? 'bg-blue-500/10 text-blue-300' :
                  isSFCompleted ? 'bg-green-500/5 text-muted-foreground' :
                    isSFSkipped ? 'bg-yellow-500/5 text-muted-foreground line-through opacity-50' :
                      isSFFailed ? 'bg-red-500/10 text-destructive' :
                        'bg-accent/20 text-muted-foreground'
              } ${isSFQueued ? 'cursor-pointer hover:bg-accent/40' : ''}`}
          >
            {/* Checkbox / Status dot */}
            {isSFQueued ? (
              <span className={`w-3 h-3 rounded border shrink-0 mr-2 flex items-center justify-center ${isSelected ? 'border-primary bg-primary/20' : 'border-muted-foreground/30'
                }`}>
                {isSelected && <Check className="w-2 h-2 text-primary" />}
              </span>
            ) : (
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 mr-2 ${isSFActive ? 'bg-blue-400 animate-pulse' :
                  isSFCompleted ? 'bg-green-500' :
                    isSFSkipped ? 'bg-yellow-500' :
                      isSFFailed ? 'bg-red-500' :
                        'bg-muted-foreground/30'
                }`} />
            )}

            {/* Filename */}
            <span className="truncate flex-1" title={sf.remotePath}>{sf.filename}</span>

            {/* Size */}
            <span className="shrink-0 ml-2 tabular-nums">{formatBytes(sf.size)}</span>

            {/* Status label */}
            <span className="w-14 text-right shrink-0 ml-2">
              {isSFActive && <span className="text-blue-400">下载中</span>}
              {isSFCompleted && <span className="text-green-500">已完成</span>}
              {isSFQueued && <span>等待中</span>}
              {isSFFailed && <span className="text-destructive">失败</span>}
              {isSFSkipped && <span className="text-yellow-500">已跳过</span>}
            </span>

            {/* Action: Skip button for queued files */}
            <div className="w-5 shrink-0 ml-1 flex justify-center">
              {isSFQueued && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    window.api.sftp.skipFile(transfer.id, sf.index)
                    useTransferStore.getState().setSubFileStatus(transfer.id, sf.index, 'skipped')
                    setSelected(prev => { const n = new Set(prev); n.delete(sf.index); return n })
                  }}
                  className="p-0.5 hover:bg-accent rounded transition-colors"
                  title="跳过此文件"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
