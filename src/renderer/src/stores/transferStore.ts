import { create } from 'zustand'

export type TransferStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled'
export type TransferDirection = 'upload' | 'download'

export interface TransferItem {
  id: string
  sessionId: string
  direction: TransferDirection
  localPath: string
  remotePath: string
  filename: string
  totalSize: number
  transferredBytes: number
  status: TransferStatus
  speed: number
  eta: number
  error?: string
  startedAt: number
  completedAt?: number
  resumable: boolean
  resumeOffset: number
}

// Speed calculation state (outside Zustand to avoid unnecessary re-renders)
const progressTimestamps = new Map<string, { time: number; bytes: number }>()

function calculateSpeed(id: string, transferred: number): number {
  const now = Date.now()
  const prev = progressTimestamps.get(id)
  if (prev) {
    const timeDiff = (now - prev.time) / 1000
    if (timeDiff > 0.3) {
      const bytesDiff = transferred - prev.bytes
      const speed = Math.max(0, bytesDiff / timeDiff)
      progressTimestamps.set(id, { time: now, bytes: transferred })
      return speed
    }
    // Too soon, return previous speed from store
    return -1 // signal to keep existing speed
  }
  progressTimestamps.set(id, { time: now, bytes: transferred })
  return 0
}

interface TransferState {
  transfers: TransferItem[]
  addTransfer: (transfer: TransferItem) => void
  updateProgress: (id: string, transferred: number, total: number) => void
  setStatus: (id: string, status: TransferStatus, error?: string) => void
  removeTransfer: (id: string) => void
  clearCompleted: () => void
  getActiveCount: () => number
}

export const useTransferStore = create<TransferState>((set, get) => ({
  transfers: [],

  addTransfer: (transfer) => {
    progressTimestamps.delete(transfer.id)
    set((state) => ({
      transfers: [transfer, ...state.transfers]
    }))
  },

  updateProgress: (id, transferred, total) => {
    const speed = calculateSpeed(id, transferred)
    set((state) => ({
      transfers: state.transfers.map((t) => {
        if (t.id !== id) return t
        // Ignore progress updates for terminal states to prevent late IPC events from making them 'active' again
        if (t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled') return t

        const newSpeed = speed >= 0 ? speed : t.speed
        const remaining = total - transferred
        const eta = newSpeed > 0 ? remaining / newSpeed : 0
        return {
          ...t,
          transferredBytes: transferred,
          totalSize: total,
          speed: newSpeed,
          eta,
          status: 'active' as TransferStatus
        }
      })
    }))
  },

  setStatus: (id, status, error?) => {
    set((state) => ({
      transfers: state.transfers.map((t) => {
        if (t.id !== id) return t
        const updates: Partial<TransferItem> = { status, error }
        if (status === 'completed') {
          updates.completedAt = Date.now()
          updates.transferredBytes = t.totalSize
          updates.speed = 0
          updates.eta = 0
          progressTimestamps.delete(id)
          // Desktop notification
          try {
            const dirLabel = t.direction === 'upload' ? '上传' : '下载'
            new Notification(`${dirLabel}完成`, {
              body: t.filename,
              silent: false
            })
          } catch { /* notification not supported */ }
        }
        if (status === 'failed' || status === 'cancelled') {
          updates.resumable = t.transferredBytes > 0
          updates.speed = 0
          updates.eta = 0
          progressTimestamps.delete(id)
          // Desktop notification for failure
          if (status === 'failed') {
            try {
              const dirLabel = t.direction === 'upload' ? '上传' : '下载'
              new Notification(`${dirLabel}失败`, {
                body: `${t.filename}${error ? ' - ' + error : ''}`,
                silent: false
              })
            } catch { /* notification not supported */ }
          }
        }
        return { ...t, ...updates }
      })
    }))
  },

  removeTransfer: (id) => {
    progressTimestamps.delete(id)
    set((state) => ({
      transfers: state.transfers.filter((t) => t.id !== id)
    }))
  },

  clearCompleted: () => {
    set((state) => ({
      transfers: state.transfers.filter((t) => t.status !== 'completed')
    }))
  },

  getActiveCount: () => {
    return get().transfers.filter((t) => t.status === 'active').length
  }
}))
