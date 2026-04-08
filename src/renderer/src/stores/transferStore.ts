import { create } from 'zustand'

const TRANSFER_HISTORY_STORAGE_KEY = 'nutshell-transfer-history'
const MAX_TRANSFER_HISTORY = 200

export type TransferStatus = 'queued' | 'active' | 'completed' | 'failed' | 'cancelled'
export type TransferDirection = 'upload' | 'download'

export interface SubFileItem {
  index: number
  filename: string
  remotePath: string
  size: number
  status: 'queued' | 'active' | 'completed' | 'failed' | 'skipped'
}

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
  currentFile?: string
  error?: string
  startedAt: number
  completedAt?: number
  resumable: boolean
  resumeOffset: number
  subFiles?: SubFileItem[]
}

// Speed calculation state (outside Zustand to avoid unnecessary re-renders)
const progressTimestamps = new Map<string, { time: number; bytes: number }>()

function calculateSpeed(id: string, transferred: number): number {
  const now = Date.now()
  const prev = progressTimestamps.get(id)
  if (prev) {
    const timeDiff = (now - prev.time) / 1000
    if (timeDiff > 0.1) {
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
  enqueueTransfer: (transfer: TransferItem, executor: () => Promise<any>) => void
  updateProgress: (id: string, transferred: number, total: number, currentFile?: string) => void
  setStatus: (id: string, status: TransferStatus, error?: string) => void
  removeTransfer: (id: string) => void
  clearCompleted: () => void
  getActiveCount: () => number
  setSubFiles: (transferId: string, files: SubFileItem[]) => void
  setSubFileStatus: (transferId: string, fileIndex: number, status: string) => void
  setSubFileStatusBatch: (transferId: string, updates: { fileIndex: number; status: string }[]) => void
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

function loadTransferHistory(): TransferItem[] {
  if (!canUseStorage()) return []
  try {
    const raw = window.localStorage.getItem(TRANSFER_HISTORY_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((item) => ({
      ...item,
      speed: 0,
      eta: 0,
      status: item.status === 'active' || item.status === 'queued' ? 'failed' : item.status,
      error: item.status === 'active' || item.status === 'queued' ? '应用重启前传输中断' : item.error,
      resumable: item.status === 'active' || item.status === 'queued' ? item.transferredBytes > 0 : item.resumable
    })) as TransferItem[]
  } catch {
    return []
  }
}

let _persistTimer: ReturnType<typeof setTimeout> | null = null

function persistTransferHistory(transfers: TransferItem[]): void {
  if (!canUseStorage()) return
  if (_persistTimer) return // already scheduled
  _persistTimer = setTimeout(() => {
    _persistTimer = null
    try {
      // Read latest state at flush time, not at schedule time
      const latest = useTransferStore.getState().transfers
      const sanitized = latest
        .slice(0, MAX_TRANSFER_HISTORY)
        .map((t) => ({
          ...t,
          speed: 0,
          eta: 0,
          // Strip sub-files from persistence to reduce storage size
          subFiles: undefined
        }))
      window.localStorage.setItem(TRANSFER_HISTORY_STORAGE_KEY, JSON.stringify(sanitized))
    } catch {
      // ignore storage errors
    }
  }, 2000)
}

function persistTransferHistoryImmediate(transfers: TransferItem[]): void {
  if (!canUseStorage()) return
  if (_persistTimer) {
    clearTimeout(_persistTimer)
    _persistTimer = null
  }
  try {
    const sanitized = transfers
      .slice(0, MAX_TRANSFER_HISTORY)
      .map((t) => ({
        ...t,
        speed: 0,
        eta: 0,
        subFiles: undefined
      }))
    window.localStorage.setItem(TRANSFER_HISTORY_STORAGE_KEY, JSON.stringify(sanitized))
  } catch {
    // ignore storage errors
  }
}

const transferExecutors = new Map<string, () => Promise<any>>()

let isProcessingQueue = false
const MAX_CONCURRENT = 1

async function processQueue() {
  if (isProcessingQueue) return
  isProcessingQueue = true

  try {
    const store = useTransferStore.getState()
    const activeCount = store.transfers.filter((t: TransferItem) => t.status === 'active').length

    if (activeCount >= MAX_CONCURRENT) {
      isProcessingQueue = false
      return // Wait for current ones to finish
    }

    const nextTasks = store.transfers.filter((t: TransferItem) => t.status === 'queued')
    if (nextTasks.length === 0) {
      isProcessingQueue = false
      return
    }

    // Determine how many we can start right now
    const toStart = nextTasks.slice(0, MAX_CONCURRENT - activeCount)

    for (const task of toStart) {
      const executor = transferExecutors.get(task.id)
      if (!executor) continue

      store.setStatus(task.id, 'active')

      executor()
        .then((result: any) => {
          if (result && !result.success) {
            useTransferStore.getState().setStatus(task.id, 'failed', result.error)
          } else {
            useTransferStore.getState().setStatus(task.id, 'completed')
          }
        })
        .catch((err: any) => {
          useTransferStore.getState().setStatus(task.id, 'failed', err?.message)
        })
        .finally(() => {
          transferExecutors.delete(task.id)
          // Free to process next in queue after a slight delay
          setTimeout(() => {
            processQueue()
          }, 500)
        })
    }
  } finally {
    isProcessingQueue = false
  }
}

export const useTransferStore = create<TransferState>((set, get) => ({
  transfers: loadTransferHistory(),

  addTransfer: (transfer) => {
    progressTimestamps.delete(transfer.id)
    set((state) => {
      const transfers = [transfer, ...state.transfers].slice(0, MAX_TRANSFER_HISTORY)
      persistTransferHistory(transfers)
      return { transfers }
    })
  },

  enqueueTransfer: (transfer, executor) => {
    transferExecutors.set(transfer.id, executor)
    get().addTransfer({ ...transfer, status: 'queued' })
    processQueue()
  },

  updateProgress: (id, transferred, total, currentFile?) => {
    const speed = calculateSpeed(id, transferred)
    set((state) => {
      const transfers = state.transfers.map((t) => {
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
          currentFile: currentFile || t.currentFile,
          status: 'active' as TransferStatus
        }
      })
      persistTransferHistory(transfers)
      return { transfers }
    })
  },

  setStatus: (id, status, error?) => {
    set((state) => {
      const transfers = state.transfers.map((t) => {
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
      persistTransferHistoryImmediate(transfers)
      return { transfers }
    })
  },

  removeTransfer: (id) => {
    progressTimestamps.delete(id)
    set((state) => {
      const transfers = state.transfers.filter((t) => t.id !== id)
      persistTransferHistoryImmediate(transfers)
      return { transfers }
    })
  },

  clearCompleted: () => {
    set((state) => {
      const transfers = state.transfers.filter((t) => t.status !== 'completed')
      persistTransferHistoryImmediate(transfers)
      return { transfers }
    })
  },

  getActiveCount: () => {
    return get().transfers.filter((t) => t.status === 'active').length
  },

  setSubFiles: (transferId, files) => {
    set((state) => {
      const transfers = state.transfers.map((t) =>
        t.id === transferId ? { ...t, subFiles: files } : t
      )
      // No persist needed — sub-files are transient UI state
      return { transfers }
    })
  },

  setSubFileStatus: (transferId, fileIndex, status) => {
    set((state) => {
      const transfers = state.transfers.map((t) => {
        if (t.id !== transferId || !t.subFiles) return t
        const newSubFiles = t.subFiles.map((sf) =>
          sf.index === fileIndex ? { ...sf, status: status as SubFileItem['status'] } : sf
        )
        return { ...t, subFiles: newSubFiles }
      })
      // No persist needed — sub-file status is transient UI state
      return { transfers }
    })
  },

  setSubFileStatusBatch: (transferId: string, updates: { fileIndex: number; status: string }[]) => {
    set((state) => {
      const transfers = state.transfers.map((t) => {
        if (t.id !== transferId || !t.subFiles) return t
        const updateMap = new Map(updates.map(u => [u.fileIndex, u.status]))
        const newSubFiles = t.subFiles.map((sf) => {
          const newStatus = updateMap.get(sf.index)
          return newStatus ? { ...sf, status: newStatus as SubFileItem['status'] } : sf
        })
        return { ...t, subFiles: newSubFiles }
      })
      return { transfers }
    })
  }
}))
