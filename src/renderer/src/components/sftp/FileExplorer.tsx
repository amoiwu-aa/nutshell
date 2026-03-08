import { useState, useEffect, useCallback, useRef } from 'react'
import {
  FolderOpen,
  Upload,
  Download,
  RefreshCw,
  Home,
  ChevronRight,
  ArrowUp,
  Trash2,
  FolderPlus,
  FileText,
  HardDrive,
  AlertCircle
} from 'lucide-react'
import { cn, formatBytes, formatDate } from '../../lib/utils'
import { useTransferStore, type TransferItem } from '../../stores/transferStore'
import { useConnectionStore } from '../../stores/connectionStore'

// File extension → icon color mapping
const fileIconColor = (filename: string): string => {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  const colors: Record<string, string> = {
    js: '#f7df1e', ts: '#3178c6', jsx: '#61dafb', tsx: '#61dafb',
    py: '#3776ab', rb: '#cc342d', go: '#00add8', rs: '#dea584',
    java: '#ed8b00', kt: '#7f52ff', swift: '#fa7343', c: '#a8b9cc',
    cpp: '#00599c', h: '#a8b9cc', cs: '#239120', php: '#777bb4',
    html: '#e34f26', css: '#1572b6', scss: '#cf649a', less: '#1d365d',
    json: '#292929', yaml: '#cb171e', yml: '#cb171e', xml: '#f80',
    md: '#083fa1', txt: '#6b7280', log: '#6b7280',
    sh: '#4eaa25', bash: '#4eaa25', zsh: '#4eaa25',
    sql: '#e38c00', db: '#e38c00',
    png: '#a855f7', jpg: '#a855f7', jpeg: '#a855f7', gif: '#a855f7',
    svg: '#ffb13b', ico: '#a855f7', webp: '#a855f7',
    zip: '#f59e0b', tar: '#f59e0b', gz: '#f59e0b', rar: '#f59e0b',
    pdf: '#ef4444', doc: '#2b579a', docx: '#2b579a', xls: '#217346', xlsx: '#217346',
    conf: '#6b7280', cfg: '#6b7280', ini: '#6b7280', env: '#6b7280',
    docker: '#2496ed', dockerfile: '#2496ed',
    vue: '#42b883', svelte: '#ff3e00', astro: '#bc52ee',
  }
  return colors[ext] || '#9ca3af'
}

interface FileInfo {
  filename: string
  isDirectory: boolean
  size?: number
  mtime?: number
  permissions?: string
  path?: string
  longname?: string
}

interface FileExplorerProps {
  sessionId: string
  tabId: string
}

// ---------------------------------------------------------------
// FilePanel extracted OUTSIDE FileExplorer to prevent
// unmount/remount on parent re-render (which broke onDoubleClick)
// ---------------------------------------------------------------
interface FilePanelProps {
  title: string
  files: FileInfo[]
  loading: boolean
  error: string | null
  path: string
  selected: Set<string>
  isRemote: boolean
  dragOver?: boolean
  draggableFiles?: boolean
  onSelect: (filename: string, e: React.MouseEvent) => void
  onNavigate: (file: FileInfo) => void
  onUp: () => void
  onRefresh: () => void
  onMkdir?: () => void
  onDelete?: () => void
  onEditFile?: (filename: string) => void
  onDrop?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragEnter?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onFileDragStart?: (e: React.DragEvent, file: FileInfo) => void
  renderBreadcrumb: (path: string, isRemote: boolean) => React.ReactNode
  onNavigateTo: (path: string) => void
}

function FilePanel({
  title,
  files,
  loading,
  error,
  path,
  selected,
  isRemote,
  dragOver,
  onSelect,
  onNavigate,
  onUp,
  onRefresh,
  onMkdir,
  onDelete,
  onEditFile,
  onDrop,
  onDragOver,
  onDragEnter,
  onDragLeave,
  onFileDragStart,
  draggableFiles,
  renderBreadcrumb,
  onNavigateTo
}: FilePanelProps) {
  const [editingPath, setEditingPath] = useState<string | null>(null)
  const pathInputRef = useRef<HTMLInputElement>(null)

  const handlePathBarClick = () => {
    setEditingPath(path)
    // focus input on next tick after state update
    setTimeout(() => pathInputRef.current?.select(), 0)
  }

  const commitPath = () => {
    if (editingPath !== null && editingPath.trim()) {
      onNavigateTo(editingPath.trim())
    }
    setEditingPath(null)
  }
  return (
    <div
      className={cn(
        'flex flex-col flex-1 border rounded-lg overflow-hidden bg-background transition-colors',
        isRemote && dragOver ? 'border-primary border-2 bg-primary/5 shadow-[0_0_20px_hsl(var(--primary)/0.15)]' : 'border-border'
      )}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
    >
      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-2 bg-card border-b border-border">
        <div className="flex items-center gap-2"><div className="w-5 h-5 rounded-md bg-primary/15 flex items-center justify-center"><HardDrive className="w-3 h-3 text-primary" /></div><span className="text-sm font-semibold">{title}</span></div>
        <div className="flex items-center gap-1">
          <button onClick={onUp} className="p-1 hover:bg-accent rounded transition-colors" title="上级目录">
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button onClick={onRefresh} className="p-1 hover:bg-accent rounded transition-colors" title="刷新">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {isRemote && onMkdir && (
            <button onClick={onMkdir} className="p-1 hover:bg-accent rounded transition-colors" title="新建文件夹">
              <FolderPlus className="w-3.5 h-3.5" />
            </button>
          )}
          {isRemote && selected.size > 0 && onDelete && (
            <button onClick={onDelete} className="p-1 hover:bg-accent rounded transition-colors text-destructive" title="删除">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Path bar — click to edit, Enter to navigate */}
      <div className="px-2 py-1 border-b border-border bg-card/50">
        {editingPath !== null ? (
          <div className="flex items-center gap-1">
            <input
              ref={pathInputRef}
              type="text"
              value={editingPath}
              onChange={(e) => setEditingPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitPath()
                if (e.key === 'Escape') setEditingPath(null)
              }}
              onBlur={() => setEditingPath(null)}
              className="flex-1 px-2 py-0.5 bg-background border border-primary/60 rounded text-xs font-mono outline-none focus:ring-1 focus:ring-primary"
              autoFocus
            />
            <button
              onMouseDown={(e) => { e.preventDefault(); commitPath() }}
              className="px-2 py-0.5 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90 shrink-0"
            >
              跳转
            </button>
          </div>
        ) : (
          <button
            className="w-full text-left flex items-center gap-0.5 text-sm min-w-0 hover:bg-accent/40 rounded px-1 py-0.5 transition-colors group"
            onClick={handlePathBarClick}
            title="点击以手动输入路径">
            {renderBreadcrumb(path, isRemote)}
          </button>
        )}
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <AlertCircle className="w-6 h-6 text-destructive mb-2" />
            <p className="text-xs text-destructive text-center mb-2">{error}</p>
            <button
              onClick={onRefresh}
              className="px-3 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
            >
              重试
            </button>
          </div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-xs">空文件夹</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-muted-foreground text-xs">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">名称</th>
                <th className="text-right px-3 py-1.5 font-medium w-24">大小</th>
                <th className="text-right px-3 py-1.5 font-medium w-40">修改时间</th>
                {isRemote && (
                  <th className="text-center px-3 py-1.5 font-medium w-24">权限</th>
                )}
              </tr>
            </thead>
            <tbody>
              {files.map((file) => (
                <tr
                  key={file.filename}
                  onClick={(e) => onSelect(file.filename, e)}
                  onDoubleClick={() => {
                    if (file.isDirectory) {
                      onNavigate(file)
                    } else if (isRemote && onEditFile) {
                      onEditFile(file.filename)
                    }
                  }}
                  draggable={draggableFiles && !file.isDirectory ? true : undefined}
                  onDragStart={
                    draggableFiles && onFileDragStart && !file.isDirectory
                      ? (e) => onFileDragStart(e, file)
                      : undefined
                  }
                  className={cn(
                    'file-row cursor-pointer transition-colors',
                    selected.has(file.filename) && 'selected'
                  )}
                >
                  <td className="px-3 py-1 flex items-center gap-2">
                    {file.isDirectory ? (
                      <FolderOpen className="w-4 h-4 text-yellow-500 shrink-0" />
                    ) : (
                      <FileText className="w-4 h-4 shrink-0" style={{ color: fileIconColor(file.filename) }} />
                    )}
                    <span className="truncate">{file.filename}</span>
                  </td>
                  <td className="px-3 py-1 text-right text-muted-foreground">
                    {file.isDirectory ? '-' : formatBytes(file.size || 0)}
                  </td>
                  <td className="px-3 py-1 text-right text-muted-foreground">
                    {file.mtime ? formatDate(file.mtime) : '-'}
                  </td>
                  {isRemote && (
                    <td className="px-3 py-1 text-center text-muted-foreground font-mono text-xs">
                      {file.permissions || '-'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div className="px-3 py-1 border-t border-border text-xs text-muted-foreground bg-card">
        {files.length} 个项目 {selected.size > 0 && `| ${selected.size} 个已选择`}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------
// Main FileExplorer component
// ---------------------------------------------------------------
export function FileExplorer({ sessionId, tabId }: FileExplorerProps) {
  // Remote state
  const [remotePath, setRemotePath] = useState('/')
  const [remoteFiles, setRemoteFiles] = useState<FileInfo[]>([])
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)

  // Local state
  const [localPath, setLocalPath] = useState('')
  const [localFiles, setLocalFiles] = useState<FileInfo[]>([])
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  // Selection
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set())
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set())

  // Transfer status
  const [transferring, setTransferring] = useState(false)
  const [transferStatus, setTransferStatus] = useState('')

  // Drag and drop
  const [dragOverRemote, setDragOverRemote] = useState(false)
  const dragCounterRef = useRef(0)

  useEffect(() => {
    const initPaths = async () => {
      const homeDir = await window.api.sftp.getHomeDir()
      setLocalPath(homeDir)
      loadLocalFiles(homeDir)

      try {
        const remoteHome = await window.api.sftp.getRemoteHomeDir(sessionId)
        const startPath = remoteHome?.success && remoteHome.home ? remoteHome.home : '/'
        loadRemoteFiles(startPath)
      } catch {
        loadRemoteFiles('/')
      }
    }
    initPaths()
  }, [sessionId])

  const loadRemoteFiles = useCallback(
    async (path: string) => {
      setRemoteLoading(true)
      setRemoteError(null)
      try {
        const result = await window.api.sftp.list(sessionId, path)
        if (result.success) {
          setRemoteFiles(result.files)
          setRemotePath(path)
          setSelectedRemote(new Set())
        } else {
          setRemoteError(result.error || '无法加载远程文件列表')
          if (path !== '/') {
            try {
              const fallback = await window.api.sftp.list(sessionId, '/')
              if (fallback.success) {
                setRemoteFiles(fallback.files)
                setRemotePath('/')
                setRemoteError(null)
              }
            } catch {
              // ignore fallback failure
            }
          }
        }
      } catch (err: any) {
        setRemoteError(err?.message || '加载远程文件失败')
      }
      setRemoteLoading(false)
    },
    [sessionId]
  )

  const loadLocalFiles = useCallback(async (path: string) => {
    setLocalLoading(true)
    setLocalError(null)
    try {
      const result = await window.api.sftp.listLocal(path)
      if (result.success) {
        setLocalFiles(result.files)
        setLocalPath(path)
        setSelectedLocal(new Set())
      } else {
        setLocalError(result.error || '无法加载本地文件列表')
      }
    } catch (err: any) {
      setLocalError(err?.message || '加载本地文件失败')
    }
    setLocalLoading(false)
  }, [])

  const handleRemoteNavigate = useCallback(
    (filename: string) => {
      const newPath = remotePath === '/' ? `/${filename}` : `${remotePath}/${filename}`
      loadRemoteFiles(newPath)
    },
    [remotePath, loadRemoteFiles, sessionId]
  )

  const handleLocalNavigate = useCallback((file: FileInfo) => {
    if (file.path) {
      loadLocalFiles(file.path)
    }
  }, [loadLocalFiles])

  const handleRemoteUp = useCallback(() => {
    if (remotePath === '/') return
    const parent = remotePath.split('/').slice(0, -1).join('/') || '/'
    loadRemoteFiles(parent)
  }, [remotePath, loadRemoteFiles])

  const handleLocalUp = useCallback(() => {
    if (!localPath) return
    const normalized = localPath.replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)

    if (parts.length <= 1) return

    const parentParts = parts.slice(0, -1)
    const parent = parentParts.length === 1 ? parentParts[0] + '\\' : parentParts.join('\\')
    loadLocalFiles(parent)
  }, [localPath, loadLocalFiles])

  const startTrackedTransfer = useCallback((
    direction: 'upload' | 'download',
    lPath: string,
    rPath: string,
    filename: string,
    totalSize: number
  ) => {
    const transferId = crypto.randomUUID()
    const item: TransferItem = {
      id: transferId, sessionId, direction,
      localPath: lPath, remotePath: rPath, filename,
      totalSize, transferredBytes: 0,
      status: 'queued', speed: 0, eta: 0,
      startedAt: Date.now(), resumable: false, resumeOffset: 0
    }

    useConnectionStore.getState().setBottomPanelActiveTab('transfers')
    useConnectionStore.getState().setBottomPanelVisible(true)

    // Enqueue the transfer inside the store, which ensures max concurrency 1
    useTransferStore.getState().enqueueTransfer(item, () => {
      // The executor function that actually triggers the IPC when its turn arrives
      if (direction === 'upload') {
        return window.api.sftp.uploadWithId(sessionId, lPath, rPath, transferId)
      } else {
        return window.api.sftp.downloadWithId(sessionId, rPath, lPath, transferId)
      }
    })

    return transferId
  }, [sessionId])

  const handleUpload = async () => {
    if (selectedLocal.size === 0) return

    for (const filename of selectedLocal) {
      const localFile = localFiles.find((f) => f.filename === filename)
      if (localFile && !localFile.isDirectory) {
        const src = localFile.path || `${localPath}\\${filename}`
        const dest = `${remotePath}/${filename}`
        startTrackedTransfer('upload', src, dest, filename, localFile.size || 0)
      }
    }
    // Refresh remote files after a short delay
    setTimeout(() => loadRemoteFiles(remotePath), 1000)
  }

  const handleDownload = async () => {
    if (selectedRemote.size === 0) return

    for (const filename of selectedRemote) {
      const remoteFile = remoteFiles.find((f) => f.filename === filename)
      if (!remoteFile) continue
      const src = `${remotePath}/${filename}`
      const dest = `${localPath}\\${filename}`
      startTrackedTransfer('download', dest, src, remoteFile.isDirectory ? `📁 ${filename}` : filename, (remoteFile as any).attrs?.size || remoteFile.size || 0)
    }
    setTimeout(() => loadLocalFiles(localPath), 1000)
  }

  const handleRemoteDelete = useCallback(async () => {
    if (selectedRemote.size === 0) return
    for (const filename of selectedRemote) {
      try {
        await window.api.sftp.delete(sessionId, `${remotePath}/${filename}`)
      } catch {
        // continue
      }
    }
    loadRemoteFiles(remotePath)
  }, [selectedRemote, remotePath, sessionId, loadRemoteFiles])

  const handleRemoteMkdir = useCallback(async () => {
    const name = prompt('新建文件夹名称:')
    if (name) {
      await window.api.sftp.mkdir(sessionId, `${remotePath}/${name}`)
      loadRemoteFiles(remotePath)
    }
  }, [sessionId, remotePath, loadRemoteFiles])

  const handleEditFile = useCallback((filename: string) => {
    const fullPath = `${remotePath}/${filename}`
    const event = new CustomEvent('file:edit', {
      detail: { sessionId, path: fullPath, filename }
    })
    window.dispatchEvent(event)
  }, [remotePath, sessionId])

  const handleRemoteDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setDragOverRemote(false)

    // Internal panel-to-panel drag (from local file panel)
    const internalPaths = e.dataTransfer.getData('application/x-local-file-paths')
    if (internalPaths) {
      try {
        const paths: string[] = JSON.parse(internalPaths)
        if (paths.length > 0) {
          for (const filePath of paths) {
            const fileName = filePath.split(/[/\\]/).pop()
            if (fileName) {
              startTrackedTransfer('upload', filePath, `${remotePath}/${fileName}`, fileName, 0)
            }
          }
          setTimeout(() => loadRemoteFiles(remotePath), 1000)
          return
        }
      } catch {
        // JSON parse failed, fall through to external drop
      }
    }

    // External OS file drop (from Windows Explorer etc.)
    if (e.dataTransfer.files.length > 0) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const file = e.dataTransfer.files[i]
        let filePath = ''
        try {
          filePath = window.api.file?.getPathForFile?.(file) || (file as any).path || ''
        } catch {
          filePath = (file as any).path || ''
        }
        if (!filePath) continue
        const fileName = filePath.split(/[/\\]/).pop() || file.name
        startTrackedTransfer('upload', filePath, `${remotePath}/${fileName}`, fileName, file.size || 0)
      }
      setTimeout(() => loadRemoteFiles(remotePath), 1000)
    }
  }, [sessionId, remotePath, loadRemoteFiles, startTrackedTransfer])

  const handleRemoteDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleRemoteDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    setDragOverRemote(true)
  }, [])

  const handleRemoteDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setDragOverRemote(false)
    }
  }, [])

  const handleLocalDragStart = useCallback((e: React.DragEvent, file: FileInfo) => {
    // If dragged file is in selection, drag all selected; otherwise drag just this one
    const filesToDrag = selectedLocal.has(file.filename)
      ? [...selectedLocal].filter((name) => {
        const f = localFiles.find((lf) => lf.filename === name)
        return f && !f.isDirectory
      })
      : [file.filename]

    const paths = filesToDrag.map((filename) => {
      const f = localFiles.find((lf) => lf.filename === filename)
      return f?.path || `${localPath}\\${filename}`
    })

    e.dataTransfer.setData('application/x-local-file-paths', JSON.stringify(paths))
    e.dataTransfer.effectAllowed = 'copy'
  }, [localPath, selectedLocal, localFiles])

  const toggleRemoteSelect = useCallback((filename: string, e: React.MouseEvent) => {
    setSelectedRemote((prev) => {
      const next = new Set(e.ctrlKey ? prev : [])
      if (next.has(filename)) {
        next.delete(filename)
      } else {
        next.add(filename)
      }
      return next
    })
  }, [])

  const toggleLocalSelect = useCallback((filename: string, e: React.MouseEvent) => {
    setSelectedLocal((prev) => {
      const next = new Set(e.ctrlKey ? prev : [])
      if (next.has(filename)) {
        next.delete(filename)
      } else {
        next.add(filename)
      }
      return next
    })
  }, [])

  const renderBreadcrumb = useCallback((pathStr: string, isRemote: boolean) => {
    const parts = pathStr.split(isRemote ? '/' : /[/\\]/).filter(Boolean)
    return (
      <div className="flex items-center gap-0.5 text-sm overflow-x-auto">
        <button
          onClick={() => (isRemote ? loadRemoteFiles('/') : loadLocalFiles(parts[0] + '\\'))}
          className="hover:text-primary transition-colors shrink-0"
        >
          {isRemote ? <Home className="w-3.5 h-3.5" /> : <HardDrive className="w-3.5 h-3.5" />}
        </button>
        {parts.map((part, i) => (
          <span key={i} className="flex items-center gap-0.5 shrink-0">
            <ChevronRight className="w-3 h-3 text-muted-foreground" />
            <button
              onClick={() => {
                const target = isRemote
                  ? '/' + parts.slice(0, i + 1).join('/')
                  : parts.slice(0, i + 1).join('\\')
                isRemote ? loadRemoteFiles(target) : loadLocalFiles(target)
              }}
              className="hover:text-primary transition-colors"
            >
              {part}
            </button>
          </span>
        ))}
      </div>
    )
  }, [loadRemoteFiles, loadLocalFiles])

  const remoteOnNavigate = useCallback((file: FileInfo) => {
    handleRemoteNavigate(file.filename)
  }, [handleRemoteNavigate])

  const remoteOnRefresh = useCallback(() => {
    loadRemoteFiles(remotePath)
  }, [loadRemoteFiles, remotePath])

  const localOnRefresh = useCallback(() => {
    loadLocalFiles(localPath)
  }, [loadLocalFiles, localPath])

  return (
    <div className="flex flex-col w-full h-full p-2 gap-2">
      {/* Transfer toolbar */}
      <div className="flex items-center justify-center gap-2 shrink-0">
        <button
          onClick={handleUpload}
          disabled={selectedLocal.size === 0 || transferring}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-50 hover:bg-primary/90 transition-colors btn-glow"
        >
          <Upload className="w-3.5 h-3.5" />
          上传
        </button>
        <button
          onClick={handleDownload}
          disabled={selectedRemote.size === 0 || transferring}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-50 hover:bg-primary/90 transition-colors btn-glow"
        >
          <Download className="w-3.5 h-3.5" />
          下载
        </button>
        {transferStatus && (
          <span className="text-sm text-muted-foreground animate-pulse">{transferStatus}</span>
        )}
      </div>

      {/* Dual-pane file browser */}
      <div className="flex flex-1 gap-2 overflow-hidden">
        <FilePanel
          title="本地文件"
          files={localFiles}
          loading={localLoading}
          error={localError}
          path={localPath}
          selected={selectedLocal}
          isRemote={false}
          draggableFiles={true}
          onFileDragStart={handleLocalDragStart}
          onSelect={toggleLocalSelect}
          onNavigate={handleLocalNavigate}
          onUp={handleLocalUp}
          onRefresh={localOnRefresh}
          onNavigateTo={loadLocalFiles}
          renderBreadcrumb={renderBreadcrumb}
        />
        <FilePanel
          title="远程文件"
          files={remoteFiles}
          loading={remoteLoading}
          error={remoteError}
          path={remotePath}
          selected={selectedRemote}
          isRemote={true}
          dragOver={dragOverRemote}
          onSelect={toggleRemoteSelect}
          onNavigate={remoteOnNavigate}
          onUp={handleRemoteUp}
          onRefresh={remoteOnRefresh}
          onMkdir={handleRemoteMkdir}
          onDelete={handleRemoteDelete}
          onEditFile={handleEditFile}
          onDrop={handleRemoteDrop}
          onDragOver={handleRemoteDragOver}
          onDragEnter={handleRemoteDragEnter}
          onDragLeave={handleRemoteDragLeave}
          onNavigateTo={loadRemoteFiles}
          renderBreadcrumb={renderBreadcrumb}
        />
      </div>
    </div>
  )
}
