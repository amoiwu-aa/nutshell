import { useState, useEffect, useCallback, useRef } from 'react'
import {
  FolderOpen, FileText, ArrowUp, RefreshCw, Home, ChevronRight, AlertCircle, Upload,
  Trash2, FolderPlus, Pencil, Download
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
  const dragCounterRef = useRef(0)

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

    let fileCount = 0
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
      const dest = `${remotePath}/${fileName}`
      const transferId = crypto.randomUUID()
      const item: TransferItem = {
        id: transferId, sessionId, direction: 'upload',
        localPath: filePath, remotePath: dest, filename: fileName,
        totalSize: file.size || 0, transferredBytes: 0,
        status: 'active', speed: 0, eta: 0,
        startedAt: Date.now(), resumable: false, resumeOffset: 0
      }
      useTransferStore.getState().addTransfer(item)
      fileCount++

      window.api.sftp.uploadWithId(sessionId, filePath, dest, transferId).then((result: any) => {
        if (result && !result.success) {
          useTransferStore.getState().setStatus(transferId, 'failed', result.error)
        } else {
          useTransferStore.getState().setStatus(transferId, 'completed')
        }
      }).catch((err: any) => {
        useTransferStore.getState().setStatus(transferId, 'failed', err?.message)
      })
    }
    if (fileCount > 0) {
      useConnectionStore.getState().setBottomPanelActiveTab('transfers')
      useConnectionStore.getState().setBottomPanelVisible(true)
      setUploadStatus(`${fileCount} 个文件开始上传`)
      setTimeout(() => { setUploadStatus(''); loadFiles(remotePath) }, 2000)
    }
  }, [sessionId, remotePath, loadFiles])

  // Context menu
  const handleContextMenu = useCallback((e: React.MouseEvent, file: FileInfo | null) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, file })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }))
  }, [])

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

  const handleDownload = useCallback(async (file: FileInfo) => {
    closeContextMenu()
    if (file.isDirectory) return
    const fullPath = remotePath === '/' ? `/${file.filename}` : `${remotePath}/${file.filename}`
    try {
      const result = await window.api.sftp.download(sessionId, fullPath, '')
      if (result && !result.success) {
        setUploadStatus(`下载失败: ${result.error || '未知错误'}`)
        setTimeout(() => setUploadStatus(''), 3000)
      }
    } catch (err: any) {
      setUploadStatus(`下载失败: ${err?.message || '未知错误'}`)
      setTimeout(() => setUploadStatus(''), 3000)
    }
  }, [sessionId, remotePath, closeContextMenu])

  const parts = remotePath.split('/').filter(Boolean)

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
    >
      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 shrink-0">
        <button onClick={handleUp} className="p-1 hover:bg-accent rounded transition-colors" title="上级目录">
          <ArrowUp className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => loadFiles(remotePath)} className="p-1 hover:bg-accent rounded transition-colors" title="刷新">
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
        </button>

        {/* Breadcrumb */}
        <div className="flex items-center gap-0.5 text-xs overflow-x-auto ml-1 flex-1">
          <button onClick={() => loadFiles('/')} className="hover:text-primary transition-colors shrink-0">
            <Home className="w-3.5 h-3.5" />
          </button>
          {parts.map((part, i) => (
            <span key={i} className="flex items-center gap-0.5 shrink-0">
              <ChevronRight className="w-3 h-3 text-muted-foreground" />
              <button
                onClick={() => loadFiles('/' + parts.slice(0, i + 1).join('/'))}
                className="hover:text-primary transition-colors"
              >
                {part}
              </button>
            </span>
          ))}
        </div>
      </div>

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
              {files.map((file) => (
                <tr
                  key={file.filename}
                  onDoubleClick={() => {
                    if (file.isDirectory) handleNavigate(file.filename)
                    else handleEditFile(file.filename)
                  }}
                  onContextMenu={(e) => handleContextMenu(e, file)}
                  className="file-row cursor-pointer transition-colors"
                >
                  <td className="px-2 py-0.5 flex items-center gap-1.5">
                    {file.isDirectory ? (
                      <FolderOpen className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate">{file.filename}</span>
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

      {/* Context menu */}
      {contextMenu.visible && (
        <>
          <div className="fixed inset-0 z-40" onClick={closeContextMenu} />
          <div
            className="fixed z-50 bg-card border border-border rounded-md shadow-lg py-1 min-w-[140px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.file && (
              <>
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
        </>
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
        {uploadStatus || `${files.length} 个项目`}
      </div>
    </div>
  )
}
