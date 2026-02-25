import { useState, useCallback, useRef, useEffect } from 'react'
import {
  ChevronRight, ChevronDown, File, Folder, FolderOpen, RefreshCw, Search,
  Plus, FolderPlus, Trash2, Pencil, Copy, Upload, Download, MoreHorizontal, X
} from 'lucide-react'
import { cn } from '../../lib/utils'

interface FileEntry {
  name: string; path: string; isDirectory: boolean; size: number; permissions: string; mtime: string; gitStatus?: string
}

interface FileTreeProps {
  sessionId: string
  rootPath: string
  gitChanges?: Map<string, string>
  onFileOpen: (filePath: string) => void
  onRefresh: () => void
}

function getFileColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  const colors: Record<string, string> = {
    ts: '#519aba', tsx: '#519aba', js: '#cbcb41', jsx: '#cbcb41',
    py: '#3572a5', go: '#00add8', rs: '#dea584', java: '#cc3e44',
    json: '#cbcb41', yml: '#cb4b16', yaml: '#cb4b16', md: '#808080',
    sh: '#4eaa25', bash: '#4eaa25', css: '#563d7c', html: '#e34c26',
    vue: '#41b883', sql: '#e38c00', dockerfile: '#384d54', xml: '#e37933',
    toml: '#9c4121', conf: '#6d8086', ini: '#6d8086', env: '#6d8086',
    rb: '#cc342d', php: '#4f5d95', c: '#555555', cpp: '#f34b7d', h: '#555555',
  }
  return colors[ext || ''] || '#8b949e'
}

function gitStatusColor(status: string): string {
  if (status === 'M' || status === 'MM') return '#e2c08d'
  if (status === 'A' || status === '??') return '#73c991'
  if (status === 'D') return '#c74e39'
  return ''
}

// ===== Context Menu =====
interface ContextMenuState {
  x: number; y: number; entry: FileEntry | null; parentPath: string
}

function TreeNode({ entry, sessionId, depth, gitChanges, onFileOpen, onContextMenu, reloadKey }: {
  entry: FileEntry; sessionId: string; depth: number; gitChanges?: Map<string, string>
  onFileOpen: (path: string) => void; onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void
  reloadKey: number
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)

  const loadChildren = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.api.workspace.listDirectory(sessionId, entry.path)
      if (r.success) setChildren(r.entries)
    } catch {}
    setLoading(false)
  }, [sessionId, entry.path])

  const toggle = async () => {
    if (!entry.isDirectory) { onFileOpen(entry.path); return }
    if (expanded) { setExpanded(false); return }
    await loadChildren()
    setExpanded(true)
  }

  // Reload children when reloadKey changes (after CRUD operations)
  useEffect(() => {
    if (expanded && reloadKey > 0) loadChildren()
  }, [reloadKey])

  const gitStatus = gitChanges?.get(entry.name) || gitChanges?.get(entry.path) || ''
  const statusClr = gitStatusColor(gitStatus)

  return (
    <div>
      <div onClick={toggle} onContextMenu={(e) => onContextMenu(e, entry)}
        className="flex items-center gap-1 h-[22px] cursor-pointer hover:bg-[#2a2d2e] transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px`, color: statusClr || '#cccccc' }}
        title={entry.path}>
        {entry.isDirectory ? (
          <>
            {loading ? <RefreshCw className="w-4 h-4 animate-spin shrink-0 opacity-50" /> :
              expanded ? <ChevronDown className="w-4 h-4 shrink-0 opacity-60" /> : <ChevronRight className="w-4 h-4 shrink-0 opacity-60" />}
            {expanded
              ? <FolderOpen className="w-4 h-4 shrink-0" style={{ color: '#dcb67a' }} />
              : <Folder className="w-4 h-4 shrink-0" style={{ color: '#dcb67a' }} />}
          </>
        ) : (
          <>
            <span className="w-4 shrink-0" />
            <File className="w-4 h-4 shrink-0" style={{ color: getFileColor(entry.name) }} />
          </>
        )}
        <span className="truncate text-[13px] leading-[22px]">{entry.name}</span>
        {gitStatus && <span className="ml-auto pr-2 text-[11px] opacity-60 shrink-0 font-mono">{gitStatus}</span>}
      </div>
      {expanded && children.map((child) => (
        <TreeNode key={child.path} entry={child} sessionId={sessionId} depth={depth + 1}
          gitChanges={gitChanges} onFileOpen={onFileOpen} onContextMenu={onContextMenu} reloadKey={reloadKey} />
      ))}
    </div>
  )
}

export function FileTree({ sessionId, rootPath, gitChanges, onFileOpen, onRefresh }: FileTreeProps) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<string[]>([])
  const [reloadKey, setReloadKey] = useState(0)

  // Context menu
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null)

  // Inline input for new file/folder/rename
  const [inlineInput, setInlineInput] = useState<{ type: 'newFile' | 'newFolder' | 'rename'; parentPath: string; oldName?: string } | null>(null)
  const [inlineValue, setInlineValue] = useState('')
  const inlineRef = useRef<HTMLInputElement>(null)

  const loadRoot = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.api.workspace.listDirectory(sessionId, rootPath)
      if (r.success) setEntries(r.entries)
    } catch {}
    setLoading(false)
  }, [sessionId, rootPath])

  useState(() => { loadRoot() })

  // Close context menu on click outside
  useEffect(() => {
    const handler = () => setCtxMenu(null)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [])

  // Focus inline input
  useEffect(() => {
    if (inlineInput && inlineRef.current) {
      inlineRef.current.focus()
      if (inlineInput.type === 'rename') inlineRef.current.select()
    }
  }, [inlineInput])

  const triggerReload = () => { setReloadKey((k) => k + 1); loadRoot(); onRefresh() }

  // Upload uses native file dialog (Electron's dialog.showOpenDialog) - most reliable
  const [uploading, setUploading] = useState(false)

  const handleSearch = async () => {
    if (!searchQuery.trim()) return
    const r = await window.api.workspace.searchFileNames(sessionId, rootPath, searchQuery)
    if (r.success) setSearchResults(r.files)
  }

  // ===== Context Menu handler =====
  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault(); e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY, entry, parentPath: entry.isDirectory ? entry.path : entry.path.substring(0, entry.path.lastIndexOf('/')) })
  }, [])

  // Right-click on empty area
  const handleEmptyContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, entry: null, parentPath: rootPath })
  }, [rootPath])

  // ===== CRUD Operations =====
  const handleNewFile = (parentPath: string) => {
    setCtxMenu(null)
    setInlineInput({ type: 'newFile', parentPath })
    setInlineValue('')
  }

  const handleNewFolder = (parentPath: string) => {
    setCtxMenu(null)
    setInlineInput({ type: 'newFolder', parentPath })
    setInlineValue('')
  }

  const handleRename = (entry: FileEntry) => {
    setCtxMenu(null)
    const parentPath = entry.path.substring(0, entry.path.lastIndexOf('/'))
    setInlineInput({ type: 'rename', parentPath, oldName: entry.name })
    setInlineValue(entry.name)
  }

  const handleDelete = async (entry: FileEntry) => {
    setCtxMenu(null)
    if (!confirm(`确定删除 ${entry.name}？${entry.isDirectory ? '（目录将被递归删除）' : ''}`)) return
    try {
      if (entry.isDirectory) {
        await window.api.workspace.agentRunCommand(sessionId, rootPath, `rm -rf "${entry.path.replace(/"/g, '\\"')}"`)
      } else {
        await window.api.sftp.delete(sessionId, entry.path)
      }
      triggerReload()
    } catch {}
  }

  const handleCopyPath = (entry: FileEntry) => {
    setCtxMenu(null)
    navigator.clipboard.writeText(entry.path)
  }

  const handleUpload = async (parentPath: string) => {
    setCtxMenu(null)
    try {
      const result = await window.api.config.selectFile({ properties: ['openFile', 'multiSelections'] })
      if (result.success && !result.canceled && result.filePaths?.length > 0) {
        setUploading(true)
        for (const localPath of result.filePaths) {
          const fileName = localPath.replace(/\\/g, '/').split('/').pop() || 'file'
          const remotePath = `${parentPath}/${fileName}`
          await window.api.sftp.upload(sessionId, localPath, remotePath)
        }
        setUploading(false)
        triggerReload()
      }
    } catch { setUploading(false) }
  }

  const handleDownload = async (entry: FileEntry) => {
    setCtxMenu(null)
    try {
      const result = await window.api.config.selectDirectory()
      if (result.success && !result.canceled && result.filePaths?.length > 0) {
        const localDir = result.filePaths[0]
        const localPath = `${localDir}/${entry.name}`.replace(/\\/g, '/')
        await window.api.sftp.download(sessionId, entry.path, localPath)
      }
    } catch {}
  }

  const handleInlineSubmit = async () => {
    if (!inlineInput || !inlineValue.trim()) { setInlineInput(null); return }
    const name = inlineValue.trim()
    try {
      if (inlineInput.type === 'newFile') {
        const path = `${inlineInput.parentPath}/${name}`
        await window.api.sftp.writeFile(sessionId, path, '')
        triggerReload()
        onFileOpen(path)
      } else if (inlineInput.type === 'newFolder') {
        await window.api.sftp.mkdir(sessionId, `${inlineInput.parentPath}/${name}`)
        triggerReload()
      } else if (inlineInput.type === 'rename' && inlineInput.oldName) {
        const oldPath = `${inlineInput.parentPath}/${inlineInput.oldName}`
        const newPath = `${inlineInput.parentPath}/${name}`
        await window.api.sftp.rename(sessionId, oldPath, newPath)
        triggerReload()
      }
    } catch {}
    setInlineInput(null)
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 h-[28px] shrink-0">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[#bbbbbb]"
          title={rootPath}>{rootPath.split('/').pop() || rootPath}</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => handleNewFile(rootPath)} className="p-1 rounded hover:bg-[#2a2d2e]" title="新建文件">
            <Plus className="w-3.5 h-3.5 text-[#cccccc]" />
          </button>
          <button onClick={() => handleNewFolder(rootPath)} className="p-1 rounded hover:bg-[#2a2d2e]" title="新建文件夹">
            <FolderPlus className="w-3.5 h-3.5 text-[#cccccc]" />
          </button>
          <button onClick={() => handleUpload(rootPath)} className="p-1 rounded hover:bg-[#2a2d2e]" title="上传文件">
            <Upload className="w-3.5 h-3.5 text-[#cccccc]" />
          </button>
          <button onClick={() => setSearchMode(!searchMode)}
            className={cn('p-1 rounded hover:bg-[#2a2d2e]', searchMode && 'bg-[#2a2d2e]')}>
            <Search className="w-3.5 h-3.5 text-[#cccccc]" />
          </button>
          <button onClick={triggerReload} className="p-1 rounded hover:bg-[#2a2d2e]">
            <RefreshCw className={cn('w-3.5 h-3.5 text-[#cccccc]', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Search */}
      {searchMode && (
        <div className="px-2 pb-1.5 shrink-0">
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="搜索文件名..."
            className="w-full px-2 py-1 bg-[#3c3c3c] border border-[#3c3c3c] focus:border-[#007fd4] rounded text-[13px] text-[#cccccc] outline-none placeholder-[#6e7681]" />
          {searchResults.length > 0 && (
            <div className="mt-1 max-h-[200px] overflow-y-auto">
              {searchResults.map((f) => (
                <div key={f} onClick={() => onFileOpen(f)}
                  className="flex items-center gap-1.5 h-[22px] px-2 cursor-pointer hover:bg-[#2a2d2e] rounded text-[13px] text-[#cccccc]">
                  <File className="w-3.5 h-3.5 shrink-0 text-[#8b949e]" />
                  <span className="truncate">{f.replace(rootPath + '/', '')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Inline input (new file/folder/rename) */}
      {inlineInput && (
        <div className="px-2 pb-1 shrink-0">
          <div className="flex items-center gap-1">
            {inlineInput.type === 'newFolder' ? <FolderPlus className="w-3.5 h-3.5 text-[#dcb67a] shrink-0" /> :
              inlineInput.type === 'rename' ? <Pencil className="w-3.5 h-3.5 text-[#969696] shrink-0" /> :
              <Plus className="w-3.5 h-3.5 text-[#969696] shrink-0" />}
            <input ref={inlineRef} type="text" value={inlineValue}
              onChange={(e) => setInlineValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleInlineSubmit(); if (e.key === 'Escape') setInlineInput(null) }}
              onBlur={handleInlineSubmit}
              placeholder={inlineInput.type === 'newFile' ? '文件名' : inlineInput.type === 'newFolder' ? '文件夹名' : '新名称'}
              className="flex-1 px-1.5 py-0.5 bg-[#3c3c3c] border border-[#007fd4] rounded text-[13px] text-[#cccccc] outline-none" />
          </div>
        </div>
      )}

      {/* Upload indicator */}
      {uploading && (
        <div className="flex items-center gap-2 px-3 py-1.5 shrink-0 text-[12px]" style={{ background: '#007acc22', color: '#007acc' }}>
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />上传中...
        </div>
      )}

      {/* Tree */}
      <div className="flex-1 overflow-y-auto relative" onContextMenu={handleEmptyContextMenu}>
        {entries.map((entry) => (
          <TreeNode key={entry.path} entry={entry} sessionId={sessionId} depth={0}
            gitChanges={gitChanges} onFileOpen={onFileOpen} onContextMenu={handleContextMenu} reloadKey={reloadKey} />
        ))}
        {entries.length === 0 && !loading && (
          <p className="text-[13px] text-[#6e7681] text-center py-8">空目录</p>
        )}
      </div>

      {/* Context Menu */}
      {ctxMenu && (
        <div className="fixed z-[100] rounded shadow-xl py-1 min-w-[180px]"
          style={{ left: ctxMenu.x, top: ctxMenu.y, background: '#252526', border: '1px solid #3c3c3c' }}
          onClick={(e) => e.stopPropagation()}>
          {/* New file/folder */}
          <button onClick={() => handleNewFile(ctxMenu.entry?.isDirectory ? ctxMenu.entry.path : ctxMenu.parentPath)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[#094771]" style={{ color: '#cccccc' }}>
            <Plus className="w-3.5 h-3.5" />新建文件
          </button>
          <button onClick={() => handleNewFolder(ctxMenu.entry?.isDirectory ? ctxMenu.entry.path : ctxMenu.parentPath)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[#094771]" style={{ color: '#cccccc' }}>
            <FolderPlus className="w-3.5 h-3.5" />新建文件夹
          </button>

          <div className="my-1" style={{ borderTop: '1px solid #3c3c3c' }} />

          {/* Upload */}
          <button onClick={() => handleUpload(ctxMenu.entry?.isDirectory ? ctxMenu.entry.path : ctxMenu.parentPath)}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[#094771]" style={{ color: '#cccccc' }}>
            <Upload className="w-3.5 h-3.5" />上传文件到此处
          </button>

          {/* Download (only for files) */}
          {ctxMenu.entry && !ctxMenu.entry.isDirectory && (
            <button onClick={() => handleDownload(ctxMenu.entry!)}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[#094771]" style={{ color: '#cccccc' }}>
              <Download className="w-3.5 h-3.5" />下载到本地
            </button>
          )}

          {ctxMenu.entry && (
            <>
              <div className="my-1" style={{ borderTop: '1px solid #3c3c3c' }} />

              {/* Rename */}
              <button onClick={() => handleRename(ctxMenu.entry!)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[#094771]" style={{ color: '#cccccc' }}>
                <Pencil className="w-3.5 h-3.5" />重命名
              </button>

              {/* Copy path */}
              <button onClick={() => handleCopyPath(ctxMenu.entry!)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[#094771]" style={{ color: '#cccccc' }}>
                <Copy className="w-3.5 h-3.5" />复制路径
              </button>

              <div className="my-1" style={{ borderTop: '1px solid #3c3c3c' }} />

              {/* Delete */}
              <button onClick={() => handleDelete(ctxMenu.entry!)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[#094771]" style={{ color: '#f85149' }}>
                <Trash2 className="w-3.5 h-3.5" />删除
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
