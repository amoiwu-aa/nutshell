import React from 'react'
import { Upload, Download, X, Check, RotateCcw, AlertCircle } from 'lucide-react'
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

  const percent = transfer.totalSize > 0
    ? Math.min(100, Math.round((transfer.transferredBytes / transfer.totalSize) * 100))
    : 0

  const handleCancel = async () => {
    await window.api.sftp.cancelTransfer(transfer.id)
    setStatus(transfer.id, 'cancelled')
  }

  const handleRetry = async (fromStart: boolean) => {
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

  return (
    <div className="px-3 py-2 border-b border-border/30 hover:bg-accent/30 transition-colors">
      {/* Top line: icon + filename + status info + actions */}
      <div className="flex items-center gap-2 mb-1">
        {/* Direction icon */}
        {transfer.direction === 'upload' ? (
          <Upload className="w-3.5 h-3.5 text-blue-400 shrink-0" />
        ) : (
          <Download className="w-3.5 h-3.5 text-green-400 shrink-0" />
        )}

        {/* Filename */}
        <span className="text-xs truncate flex-1" title={transfer.remotePath}>
          {transfer.filename}
        </span>

        {/* Status info */}
        {isActive && (
          <span className="text-[10px] text-muted-foreground shrink-0">
            {percent}% | {formatBytesPerSec(transfer.speed)} | ETA {formatETA(transfer.eta)}
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
            {transfer.error || transfer.status === 'cancelled' ? '已取消' : '失败'}
          </span>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          {isActive && (
            <button onClick={handleCancel} className="p-0.5 hover:bg-accent rounded transition-colors" title="取消">
              <X className="w-3 h-3 text-muted-foreground" />
            </button>
          )}
          {isFailed && (
            <>
              {transfer.resumable && (
                <button
                  onClick={() => handleRetry(false)}
                  className="p-0.5 hover:bg-accent rounded transition-colors"
                  title="断点续传"
                >
                  <RotateCcw className="w-3 h-3 text-primary" />
                </button>
              )}
              <button
                onClick={() => handleRetry(true)}
                className="p-0.5 hover:bg-accent rounded transition-colors"
                title="重新开始"
              >
                <AlertCircle className="w-3 h-3 text-muted-foreground" />
              </button>
            </>
          )}
          {(isCompleted || isFailed) && (
            <button
              onClick={() => removeTransfer(transfer.id)}
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
        <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
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
        <div className="h-1 bg-green-500/30 rounded-full overflow-hidden">
          <div className="h-full rounded-full bg-green-500" style={{ width: '100%' }} />
        </div>
      )}

      {/* Failed bar (partial red) */}
      {isFailed && percent > 0 && (
        <div className="h-1 bg-secondary rounded-full overflow-hidden">
          <div
            className="h-full rounded-full bg-destructive"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  )
})
