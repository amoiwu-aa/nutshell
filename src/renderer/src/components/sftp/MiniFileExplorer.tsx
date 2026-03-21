import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  FolderOpen, FileText, ArrowUp, RefreshCw, Home, ChevronRight, AlertCircle, Upload,
  Trash2, FolderPlus, Pencil, Download, Copy, ClipboardCopy, Search, X, Terminal
} from 'lucide-react'
import { cn, formatBytes, formatDate } from '../../lib/utils'
import { useTransferStore, type TransferItem } from '../../stores/transferStore'
import { useConnectionStore } from '../../stores/connectionStore'

interface FileInfo {
  filename: string
  isDirectory: boolean
  size?: number
  mtime?: number
  permissions?: string
  path?: string
}

interface ContextMenuState {
  visible: boolean
  x: number
  y: number
  file: FileInfo | null
}

interface MiniFileExplorerProps {
  sessionId: string
}

export function MiniFileExplorer({ sessionId }: MiniFileExplorerProps) {
  const [remotePath, setRemotePath] = useState('/')
  const [files, setFiles] = useState<FileInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [uploadStatus, setUploadStatus] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ visible: false, x: 0, y: 0, file: null })
  const [renameDialog, setRenameDialog] = useState<{ file: FileInfo; newName: string } | null>(null)
  const [mkdirDialog, setMkdirDialog] = useState<{ name: string } | null>(null)
  const [editingPath, setEditingPath] = useState(false)
  const [pathInput, setPathInput] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [searchText, setSearchText] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const lastClickedIndexRef = useRef<number>(-1)
  const pathInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const dragCounterRef = useRef(0)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const result = await window.api.sftp.getRemoteHomeDir(sessionId)
        const startPath = result?.success && result.home ? result.home : '/'
        loadFiles(startPath)
      } catch {
        loadFiles('/')
      }
    }
    init()
  }, [sessionId])

  const loadFiles = useCallback(async (path: string) => {
    setLoading(true)
    setError(null)
    setSelectedFiles(new Set())
    lastClickedIndexRef.current = -1
    try {
      const result = await window.api.sftp.list(sessionId, path)
      if (result.success) {
        setFiles(result.files)
        setRemotePath(path)
      } else {
        setError(result.error || '无法加载文件列表')
      }
    } catch (err: any) {
      setError(err?.message || '加载失败')
    }
    setLoading(false)
  }, [sessionId])

  const handleNavigate = useCallback((filename: string) => {
    const newPath = remotePath === '/' ? `/${filename}` : `${remotePath}/${filename}`
    loadFiles(newPath)
  }, [remotePath, loadFiles])

  const handleUp = useCallback(() => {
    if (remotePath === '/') return
    const parent = remotePath.split('/').slice(0, -1).join('/') || '/'
    loadFiles(parent)
  }, [remotePath, loadFiles])

  const handleEditFile = useCallback((filename: string) => {
    const fullPath = `${remotePath}/${filename}`
    window.dispatchEvent(new CustomEvent('file:edit', {
      detail: { sessionId, path: fullPath, filename }
    }))
  }, [remotePath, sessionId])

  // Drag-and-drop upload
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setDragOver(false)

    if (e.dataTransfer.files.length === 0) return

    // Extract file info synchronously because DataTransfer.files object gets wiped by the browser upon the first 'await'
    const droppedFiles = Array.from(e.dataTransfer.files).map(file => {
      let filePath = ''
      try {
        filePath = window.api.file?.getPathForFile?.(file) || (file as any).path || ''
      } catch {
        filePath = (file as any).path || ''
      }
      return { file, filePath, fileName: filePath.split(/[/\\]/).pop() || file.name, size: file.size || 0 }
    })

    let fileCount = 0
    let skippedDirCount = 0
    for (const dropItem of droppedFiles) {
      const { file, filePath, fileName } = dropItem
      if (!filePath) continue

      let localSize = dropItem.size
      let isDirectory = false
      let resolvedLocalMeta = false

      try {
        const statLocal = window.api.sftp.statLocal
        if (typeof statLocal === 'function') {
          const localStat = await statLocal(filePath)
          if (localStat?.success && localStat.exists) {
            localSize = localStat.size || localSize
            isDirectory = !!localStat.isDirectory
            resolvedLocalMeta = true
          }
        }

        if (!resolvedLocalMeta) {
          const parentPath = filePath.replace(/[\\/][^\\/]+$/, '')
          const filename = filePath.split(/[/\\]/).pop()
          if (parentPath && filename) {
            const localList = await window.api.sftp.listLocal(parentPath)
            if (localList?.success) {
              const localEntry = localList.files?.find((entry: any) => entry.filename === filename)
              if (localEntry) {
                localSize = localEntry.size || localSize
                isDirectory = !!localEntry.isDirectory
              }
            }
          }
        }
      } catch {
        // Fallback to browser-provided file metadata only
      }

      const dest = `${remotePath}/${fileName}`
      const transferId = crypto.randomUUID()

      if (isDirectory) {
        const item: TransferItem = {
          id: transferId, sessionId, direction: 'upload',
          localPath: filePath, remotePath: dest, filename: `📁 ${fileName}`,
          totalSize: 0, transferredBytes: 0,
          status: 'queued', speed: 0, eta: 0,
          startedAt: Date.now(), resumable: false, resumeOffset: 0
        }
        useTransferStore.getState().enqueueTransfer(item, () => {
          return window.api.sftp.uploadDir(sessionId, filePath, dest, transferId)
        })
      } else {
        const item: TransferItem = {
          id: transferId, sessionId, direction: 'upload',
          localPath: filePath, remotePath: dest, filename: fileName,
          totalSize: localSize, transferredBytes: 0,
          status: 'queued', speed: 0, eta: 0,
          startedAt: Date.now(), resumable: false, resumeOffset: 0
        }
        useTransferStore.getState().enqueueTransfer(item, () => {
          return window.api.sftp.uploadWithId(sessionId, filePath, dest, transferId)
        })
      }

      fileCount++
    }
    if (fileCount > 0) {
      useConnectionStore.getState().setBottomPanelActiveTab('transfers')
      useConnectionStore.getState().setBottomPanelVisible(true)
      setUploadStatus(`${fileCount} 个文件/文件夹开始上传`)
      setTimeout(() => { setUploadStatus(''); loadFiles(remotePath) }, 2000)
    }
  }, [sessionId, remotePath, loadFiles])

  // File selection
  const handleFileClick = useCallback((e: React.MouseEvent, file: FileInfo, index: number) => {
    e.stopPropagation()
    setSelectedFiles(prev => {
      const next = new Set(prev)
      if (e.shiftKey && lastClickedIndexRef.current >= 0) {
        // Range select
        const start = Math.min(lastClickedIndexRef.current, index)
        const end = Math.max(lastClickedIndexRef.current, index)
        for (let i = start; i <= end; i++) {
          next.add(files[i].filename)
        }
      } else if (e.ctrlKey || e.metaKey) {
        // Toggle individual
        if (next.has(file.filename)) next.delete(file.filename)
        else next.add(file.filename)
      } else {
        // Single select
        next.clear()
        next.add(file.filename)
      }
      return next
    })
    lastClickedIndexRef.current = index
  }, [files])

  // Context menu
  const handleContextMenu = useCallback((e: React.MouseEvent, file: FileInfo | null) => {
    e.preventDefault()
    e.stopPropagation()
    // If right-clicking a file that's not already selected, select just that file
    if (file && !selectedFiles.has(file.filename)) {
      setSelectedFiles(new Set([file.filename]))
    }
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, file })
  }, [selectedFiles])

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [])

  const handleOpenInTerminal = useCallback((targetFile: FileInfo | null) => {
    closeContextMenu()
    let targetPath = remotePath
    if (targetFile && targetFile.isDirectory) {
      targetPath = remotePath === '/' ? `/${targetFile.filename}` : `${remotePath}/${targetFile.filename}`
    }
    
    window.api.ssh.write(sessionId, `cd "${targetPath}"\r`)
    
    // Switch the main workspace tab to the terminal tab
    const state = useConnectionStore.getState()
    const terminalTab = state.tabs.find(t => t.sessionId === sessionId && t.type === 'terminal')
    
    if (terminalTab) {
      state.setActiveTab(terminalTab.id)
      // Tell terminal to auto-focus immediately
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent('terminal:focus', { detail: { tabId: terminalTab.id } }))
      }, 100)
    }
  }, [sessionId, remotePath, closeContextMenu])

  // Auto-adjust menu position when it overflows viewport
  useEffect(() => {
    if (!contextMenu.visible || !ctxMenuRef.current) return
    const el = ctxMenuRef.current
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    let newX = contextMenu.x
    let newY = contextMenu.y
    if (rect.right > vw) newX = vw - rect.width - 4
    if (rect.bottom > vh) newY = vh - rect.height - 4
    if (newX < 0) newX = 4
    if (newY < 0) newY = 4
    if (newX !== contextMenu.x || newY !== contextMenu.y) {
      el.style.left = `${newX}px`
      el.style.top = `${newY}px`
    }
  }, [contextMenu.visible, contextMenu.x, contextMenu.y])

  useEffect(() => {
    if (contextMenu.visible) {
      const handler = () => closeContextMenu()
      window.addEventListener('click', handler)
      return () => window.removeEventListener('click', handler)
    }
  }, [contextMenu.visible, closeContextMenu])

  const handleDelete = useCallback(async (file: FileInfo) => {
    closeContextMenu()
    const fullPath = remotePath === '/' ? `/${file.filename}` : `${remotePath}/${file.filename}`
    const confirmMsg = file.isDirectory
      ? `确定删除文件夹 "${file.filename}" 及其所有内容？`
      : `确定删除文件 "${file.filename}"？`
    if (!confirm(confirmMsg)) return
    try {
      const result = await window.api.sftp.delete(sessionId, fullPath)
      if (result && !result.success) {
        alert(`删除失败: ${result.error || '未知错误'}`)
      } else {
        loadFiles(remotePath)
      }
    } catch (err: any) {
      alert(`删除失败: ${err?.message || '未知错误'}`)
    }
  }, [sessionId, remotePath, loadFiles, closeContextMenu])

  const handleRename = useCallback(async () => {
    if (!renameDialog) return
    const newName = renameDialog.newName.trim()
    if (!newName || newName === renameDialog.file.filename) {
      setRenameDialog(null)
      return
    }
    const oldPath = remotePath === '/' ? `/${renameDialog.file.filename}` : `${remotePath}/${renameDialog.file.filename}`
    const newPath = remotePath === '/' ? `/${newName}` : `${remotePath}/${newName}`
    try {
      const result = await window.api.sftp.rename(sessionId, oldPath, newPath)
      if (result && !result.success) {
        alert(`重命名失败: ${result.error || '未知错误'}`)
      } else {
        loadFiles(remotePath)
      }
    } catch (err: any) {
      alert(`重命名失败: ${err?.message || '未知错误'}`)
    }
    setRenameDialog(null)
  }, [renameDialog, sessionId, remotePath, loadFiles])

  const handleMkdir = useCallback(async () => {
    if (!mkdirDialog) return
    const name = mkdirDialog.name.trim()
    if (!name) {
      setMkdirDialog(null)
      return
    }
    const fullPath = remotePath === '/' ? `/${name}` : `${remotePath}/${name}`
    try {
      const result = await window.api.sftp.mkdir(sessionId, fullPath)
      if (result && !result.success) {
        alert(`创建失败: ${result.error || '未知错误'}`)
      } else {
        loadFiles(remotePath)
      }
    } catch (err: any) {
      alert(`创建失败: ${err?.message || '未知错误'}`)
    }
    setMkdirDialog(null)
  }, [mkdirDialog, sessionId, remotePath, loadFiles])

  const startTrackedDownload = useCallback((file: FileInfo, targetDir: string) => {
    const fullPath = remotePath === '/' ? `/${file.filename}` : `${remotePath}/${file.filename}`
    const localDest = `${targetDir}\\${file.filename}`
    const transferId = crypto.randomUUID()
    const item: TransferItem = {
      id: transferId, sessionId, direction: 'download',
      localPath: localDest, remotePath: fullPath, filename: file.isDirectory ? `📁 ${file.filename}` : file.filename,
      totalSize: file.size || 0, transferredBytes: 0,
      status: 'queued', speed: 0, eta: 0,
      startedAt: Date.now(), resumable: false, resumeOffset: 0
    }

    // Enqueue the download
    useTransferStore.getState().enqueueTransfer(item, () => {
      if (file.isDirectory) {
        return window.api.sftp.downloadDir(sessionId, fullPath, localDest, transferId)
      } else {
        return window.api.sftp.downloadWithId(sessionId, fullPath, localDest, transferId)
      }
    })
  }, [sessionId, remotePath])

  const handleDownloadSingle = useCallback(async (file: FileInfo) => {
    closeContextMenu()
    const dirResult = await window.api.sftp.selectDirectory('选择下载保存目录')
    if (!dirResult?.success || !dirResult.path) return
    startTrackedDownload(file, dirResult.path)
    useConnectionStore.getState().setBottomPanelActiveTab('transfers')
    useConnectionStore.getState().setBottomPanelVisible(true)
  }, [closeContextMenu, startTrackedDownload])

  const handleDownloadSelected = useCallback(async () => {
    closeContextMenu()
    const itemsToDownload = files.filter(f => selectedFiles.has(f.filename))
    if (itemsToDownload.length === 0) return
    const dirResult = await window.api.sftp.selectDirectory('选择下载保存目录')
    if (!dirResult?.success || !dirResult.path) return
    for (const file of itemsToDownload) {
      startTrackedDownload(file, dirResult.path)
    }
    useConnectionStore.getState().setBottomPanelActiveTab('transfers')
    useConnectionStore.getState().setBottomPanelVisible(true)
    setUploadStatus(`${itemsToDownload.length} 个项目开始下载`)
    setTimeout(() => setUploadStatus(''), 2000)
  }, [closeContextMenu, files, selectedFiles, startTrackedDownload])

  const parts = remotePath.split('/').filter(Boolean)

  // Filter files by search text
  const filteredFiles = searchText
    ? files.filter(f => f.filename.toLowerCase().includes(searchText.toLowerCase()))
    : files

  // Ctrl+F shortcut
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === 'f') {
      e.preventDefault()
      setShowSearch(true)
      setTimeout(() => searchInputRef.current?.focus(), 0)
    }
    if (e.key === 'Escape' && showSearch) {
      setShowSearch(false)
      setSearchText('')
    }
  }, [showSearch])

  return (
    <div
      className={cn(
        'flex flex-col h-full overflow-hidden transition-colors',
        dragOver && 'ring-2 ring-primary ring-inset bg-primary/5'
      )}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 shrink-0">
        <button onClick={handleUp} className="p-1 hover:bg-accent rounded transition-colors" title="上级目录">
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => loadFiles(remotePath)} className="p-1 hover:bg-accent rounded transition-colors" title="刷新">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>

        {/* Breadcrumb / Editable path */}
        {editingPath ? (
          <input
            ref={pathInputRef}
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const target = pathInput.trim() || '/'
                setEditingPath(false)
                loadFiles(target)
              } else if (e.key === 'Escape') {
                setEditingPath(false)
              }
            }}
            onBlur={() => setEditingPath(false)}
            className="flex-1 ml-1 px-1.5 py-0.5 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring font-mono"
          />
        ) : (
          <div
            className="flex items-center gap-0.5 text-xs overflow-x-auto ml-1 flex-1 cursor-text rounded px-1 py-0.5 hover:bg-accent/30 transition-colors"
            onClick={() => {
              setPathInput(remotePath)
              setEditingPath(true)
              setTimeout(() => {
                pathInputRef.current?.focus()
                pathInputRef.current?.select()
              }, 0)
            }}
          >
            <button onClick={(e) => { e.stopPropagation(); loadFiles('/') }} className="hover:text-primary transition-colors shrink-0">
              <Home className="w-3.5 h-3.5" />
            </button>
            {parts.map((part, i) => (
              <span key={i} className="flex items-center gap-0.5 shrink-0">
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
                <button
                  onClick={(e) => { e.stopPropagation(); loadFiles('/' + parts.slice(0, i + 1).join('/')) }}
                  className="hover:text-primary transition-colors"
                >
                  {part}
                </button>
              </span>
            ))}
          </div>
        )}
        <button
          onClick={() => {
            setShowSearch(s => !s)
            if (!showSearch) setTimeout(() => searchInputRef.current?.focus(), 0)
            else setSearchText('')
          }}
          className={cn('p-1 rounded transition-colors shrink-0', showSearch ? 'bg-primary/20 text-primary' : 'hover:bg-accent')}
          title="搜索 (Ctrl+F)"
        >
          <Search className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 shrink-0 bg-card">
          <Search className="w-3 h-3 text-muted-foreground shrink-0" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setShowSearch(false)
                setSearchText('')
              }
            }}
            placeholder="过滤文件名..."
            className="flex-1 px-1.5 py-0.5 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring"
          />
          {searchText && (
            <span className="text-[10px] text-muted-foreground shrink-0">{filteredFiles.length}/{files.length}</span>
          )}
          <button
            onClick={() => { setShowSearch(false); setSearchText('') }}
            className="p-0.5 hover:bg-accent rounded shrink-0"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* File list */}
      <div className="flex-1 overflow-y-auto relative" onContextMenu={(e) => handleContextMenu(e, null)}>
        {/* Drag overlay */}
        {dragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-primary/10 pointer-events-none">
            <div className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg shadow-lg">
              <Upload className="w-4 h-4" />
              <span className="text-xs font-medium">拖放文件到此处上传</span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
            <AlertCircle className="w-5 h-5 text-destructive mb-1" />
            <p className="text-xs text-destructive text-center mb-2">{error}</p>
            <button onClick={() => loadFiles(remotePath)} className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90">
              重试
            </button>
          </div>
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-xs">空文件夹 - 可拖拽文件到此上传</p>
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground text-[10px]">
              <tr>
                <th className="text-left px-2 py-1 font-medium">名称</th>
                <th className="text-right px-2 py-1 font-medium w-20">大小</th>
                <th className="text-right px-2 py-1 font-medium w-32">修改时间</th>
                <th className="text-center px-2 py-1 font-medium w-16">权限</th>
              </tr>
            </thead>
            <tbody>
              {filteredFiles.map((file, index) => (
                <tr
                  key={file.filename}
                  onClick={(e) => handleFileClick(e, file, index)}
                  onDoubleClick={() => {
                    if (file.isDirectory) handleNavigate(file.filename)
                    else handleEditFile(file.filename)
                  }}
                  onContextMenu={(e) => handleContextMenu(e, file)}
                  className={cn(
                    'file-row cursor-pointer transition-colors',
                    selectedFiles.has(file.filename) && 'selected'
                  )}
                >
                  <td className="px-2 py-0.5 flex items-center gap-1.5">
                    {file.isDirectory ? (
                      <FolderOpen className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate">{searchText ? (() => {
                      const idx = file.filename.toLowerCase().indexOf(searchText.toLowerCase())
                      if (idx === -1) return file.filename
                      return <>{file.filename.substring(0, idx)}<mark className="bg-yellow-500/40 text-yellow-200 rounded-sm">{file.filename.substring(idx, idx + searchText.length)}</mark>{file.filename.substring(idx + searchText.length)}</>
                    })() : file.filename}</span>
                  </td>
                  <td className="px-2 py-0.5 text-right text-muted-foreground">
                    {file.isDirectory ? '-' : formatBytes(file.size || 0)}
                  </td>
                  <td className="px-2 py-0.5 text-right text-muted-foreground">
                    {file.mtime ? formatDate(file.mtime) : '-'}
                  </td>
                  <td className="px-2 py-0.5 text-center text-muted-foreground font-mono text-[10px]">
                    {file.permissions || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Context menu — rendered via Portal to escape overflow:hidden clipping */}
      {contextMenu.visible && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={closeContextMenu} />
          <div
            ref={ctxMenuRef}
            className="fixed z-[9999] bg-card border border-border rounded-md shadow-lg py-1 min-w-[140px] context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.file && (
              <>
                <button
                  onClick={() => {
                    const fullPath = remotePath === '/' ? `/${contextMenu.file!.filename}` : `${remotePath}/${contextMenu.file!.filename}`
                    navigator.clipboard.writeText(fullPath)
                    closeContextMenu()
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                >
                  <Copy className="w-3 h-3" />
                  复制路径
                </button>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(contextMenu.file!.filename)
                    closeContextMenu()
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                >
                  <ClipboardCopy className="w-3 h-3" />
                  复制文件名
                </button>
                <div className="border-t border-border my-0.5" />
                <button
                  onClick={() => handleOpenInTerminal(contextMenu.file!)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors text-primary"
                >
                  <Terminal className="w-3 h-3" />
                  在终端中打开目录
                </button>
                <div className="border-t border-border my-0.5" />
                {/* Download single file or folder */}
                <button
                  onClick={() => handleDownloadSingle(contextMenu.file!)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                >
                  <Download className="w-3 h-3" />
                  下载{contextMenu.file.isDirectory ? '文件夹' : ''}
                </button>
                {/* Download all selected items (shown when multiple selected) */}
                {selectedFiles.size > 1 && (
                  <button
                    onClick={handleDownloadSelected}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors text-primary"
                  >
                    <Download className="w-3 h-3" />
                    下载选中 ({selectedFiles.size} 个项目)
                  </button>
                )}
                <div className="border-t border-border my-0.5" />
                <button
                  onClick={() => {
                    closeContextMenu()
                    setRenameDialog({ file: contextMenu.file!, newName: contextMenu.file!.filename })
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                  重命名
                </button>
                <button
                  onClick={() => handleDelete(contextMenu.file!)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors text-destructive"
                >
                  <Trash2 className="w-3 h-3" />
                  删除
                </button>
                {!contextMenu.file.isDirectory && (
                  <button
                    onClick={() => {
                      closeContextMenu()
                      handleEditFile(contextMenu.file!.filename)
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                  >
                    <FileText className="w-3 h-3" />
                    编辑
                  </button>
                )}
                <div className="border-t border-border my-0.5" />
              </>
            )}
            {!contextMenu.file && (
              <>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(remotePath)
                    closeContextMenu()
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
                >
                  <Copy className="w-3 h-3" />
                  复制当前路径
                </button>
                <button
                  onClick={() => handleOpenInTerminal(null)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors text-primary"
                >
                  <Terminal className="w-3 h-3" />
                  在终端中打开当前目录
                </button>
                {/* Batch download from background (no specific file right-clicked) */}
                {selectedFiles.size > 0 && (
                  <button
                    onClick={handleDownloadSelected}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors text-primary"
                  >
                    <Download className="w-3 h-3" />
                    下载选中 ({[...selectedFiles].filter(n => { const f = files.find(ff => ff.filename === n); return f && !f.isDirectory }).length} 个文件)
                  </button>
                )}
                <div className="border-t border-border my-0.5" />
              </>
            )}
            <button
              onClick={() => {
                closeContextMenu()
                setMkdirDialog({ name: '' })
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
            >
              <FolderPlus className="w-3 h-3" />
              新建文件夹
            </button>
            <button
              onClick={() => {
                closeContextMenu()
                loadFiles(remotePath)
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent transition-colors"
            >
              <RefreshCw className="w-3 h-3" />
              刷新
            </button>
          </div>
        </>,
        document.body
      )}

      {/* Rename dialog */}
      {renameDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setRenameDialog(null)} />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[340px] p-4">
            <h3 className="text-sm font-semibold mb-3">重命名</h3>
            <input
              type="text"
              value={renameDialog.newName}
              onChange={(e) => setRenameDialog((prev) => prev ? { ...prev, newName: e.target.value } : null)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename() }}
              autoFocus
              className="w-full px-3 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setRenameDialog(null)} className="px-3 py-1.5 text-sm hover:bg-accent rounded-lg transition-colors">取消</button>
              <button onClick={handleRename} className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* Mkdir dialog */}
      {mkdirDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setMkdirDialog(null)} />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[340px] p-4">
            <h3 className="text-sm font-semibold mb-3">新建文件夹</h3>
            <input
              type="text"
              value={mkdirDialog.name}
              onChange={(e) => setMkdirDialog((prev) => prev ? { ...prev, name: e.target.value } : null)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleMkdir() }}
              placeholder="文件夹名称"
              autoFocus
              className="w-full px-3 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setMkdirDialog(null)} className="px-3 py-1.5 text-sm hover:bg-accent rounded-lg transition-colors">取消</button>
              <button onClick={handleMkdir} className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">创建</button>
            </div>
          </div>
        </div>
      )}

      {/* Status */}
      <div className="px-2 py-0.5 border-t border-border/50 text-[10px] text-muted-foreground shrink-0">
        {uploadStatus || `${searchText ? `${filteredFiles.length}/${files.length}` : files.length} 个项目${selectedFiles.size > 0 ? ` | ${selectedFiles.size} 个已选择` : ''}`}
      </div>
    </div>
  )
}
