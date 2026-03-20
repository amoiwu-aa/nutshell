import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  Sparkles, Terminal, GitBranch, Search, AlertCircle, AlertTriangle,
  List, X, Loader2, Server, FileCode, GitCompare
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { FileTree } from './FileTree'
import { EditorTabs, detectLang, type OpenFile } from './EditorTabs'
import { Breadcrumbs, OutlinePanel } from './Breadcrumbs'
import { DiffView } from './DiffView'
import { SearchPanel } from './SearchPanel'
import { ProblemsPanel, type Diagnostic } from './ProblemsPanel'
import { WorkspaceAI } from './WorkspaceAI'
import { Terminal as XTerminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import {
  registerLspProviders, disposeAllProviders,
  notifyFileOpen, notifyFileChange, notifyFileClose, notifyFileSave
} from '../../lib/LspProviderBridge'
import type * as monacoType from 'monaco-editor'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  attachPreferredRenderer,
  TERMINAL_UNICODE_VERSION
} from '../../lib/terminalRendering'
import {
  detectHeavyCliCommand,
  getTerminalInteractionProfileConfig,
  resolveRendererModeForProfile,
  type TerminalInteractionProfile
} from '../../lib/terminalProfiles'
import { registerOsc52ClipboardHandler } from '../../lib/terminalClipboard'

// ===== Cursor/VSCode Color Tokens =====
const C = {
  bg: '#1e1e1e',           // main editor background
  sidebarBg: '#252526',    // sidebar background
  activityBg: '#333333',   // activity bar background
  panelBg: '#1e1e1e',      // bottom panel background
  tabBg: '#2d2d2d',        // inactive tab
  tabActiveBg: '#1e1e1e',  // active tab (matches editor)
  tabBar: '#252526',       // tab bar background
  border: '#3c3c3c',       // subtle borders (match VS Code)
  statusBg: '#007acc',     // status bar (blue like Cursor)
  statusFg: '#ffffff',     // status bar text
  text: '#cccccc',         // primary text
  textDim: '#969696',      // secondary text
  textMuted: '#6e7681',    // muted text
  accent: '#007fd4',       // focus/accent blue
  hover: '#2a2d2e',        // hover background
  selected: '#094771',     // selected item
  error: '#f14c4c',
  warning: '#cca700',
  success: '#3fb950',
}

interface WorkspacePanelProps { sessionId: string; tabId: string; rootPath: string; isActive: boolean }
type SidebarView = 'files' | 'search' | 'outline' | 'git'
type BottomTab = 'terminal' | 'problems'

interface LspServerInfo {
  language: string; available: boolean; installHint: string; recommended: boolean; running: boolean; starting: boolean
}

export function WorkspacePanel({ sessionId, tabId, rootPath, isActive }: WorkspacePanelProps) {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activeFile, setActiveFile] = useState<string | null>(null)
  const [diffFile, setDiffFile] = useState<string | null>(null)
  const [showAI, setShowAI] = useState(false)
  const [sidebarView, setSidebarView] = useState<SidebarView>('files')
  const [showSidebar, setShowSidebar] = useState(true)
  const [showBottom, setShowBottom] = useState(true) // default open
  const [bottomTab, setBottomTab] = useState<BottomTab>('terminal')
  const [bottomHeight, setBottomHeight] = useState(220)
  const [gitBranch, setGitBranch] = useState('')
  const [gitChanges, setGitChanges] = useState<Map<string, string>>(new Map())
  const [cursorLine, setCursorLine] = useState(1)
  const [cursorCol, setCursorCol] = useState(1)
  const openFilesRef = useRef<OpenFile[]>([])
  const activeFileRef = useRef<string | null>(null)
  const diffFileRef = useRef<string | null>(null)
  const editorRef = useRef<monacoType.editor.IStandaloneCodeEditor | null>(null)
  const [lspServers, setLspServers] = useState<LspServerInfo[]>([])
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])

  useEffect(() => { openFilesRef.current = openFiles }, [openFiles])
  useEffect(() => { activeFileRef.current = activeFile }, [activeFile])
  useEffect(() => { diffFileRef.current = diffFile }, [diffFile])

  // ===== Git =====
  const loadGitStatus = useCallback(async () => {
    try {
      const r = await window.api.workspace.getGitStatus(sessionId, rootPath)
      if (r.success && r.git.isRepo) {
        setGitBranch(r.git.branch)
        const map = new Map<string, string>()
        for (const c of r.git.changes) map.set(c.file, c.status)
        setGitChanges(map)
      }
    } catch {}
  }, [sessionId, rootPath])
  useEffect(() => {
    if (!isActive) return
    loadGitStatus()
  }, [loadGitStatus, isActive])

  // ===== LSP =====
  useEffect(() => {
    const detectLsp = async () => {
      try {
        const r = await window.api.lsp.detectServers(sessionId, rootPath)
        if (r.success && r.servers) {
          setLspServers(r.servers.map((s: any) => ({ ...s, running: false, starting: false })))
          for (const s of r.servers) {
            if (s.recommended && s.available) startLspServer(s.language)
          }
        }
      } catch {}
    }
    detectLsp()

    const removeDiag = window.api.lsp.onDiagnostics((sid: string, lang: string, params: any) => {
      if (sid !== sessionId) return
      const filePath = (params.uri || '').replace('file://', '')
      const newDiags: Diagnostic[] = (params.diagnostics || []).map((d: any) => ({
        file: filePath, line: (d.range?.start?.line || 0) + 1, column: (d.range?.start?.character || 0) + 1,
        endLine: (d.range?.end?.line || 0) + 1, endColumn: (d.range?.end?.character || 0) + 1,
        message: d.message || '', severity: d.severity === 1 ? 'error' : d.severity === 2 ? 'warning' : 'info',
        source: d.source || `lsp:${lang}`,
      }))
      setDiagnostics((prev) => [...prev.filter((d) => d.file !== filePath || !d.source.startsWith('lsp:')), ...newDiags])
    })
    const removeStatus = window.api.lsp.onStatus((sid: string, lang: string, status: string) => {
      if (sid !== sessionId) return
      setLspServers((prev) => prev.map((s) => s.language === lang ? { ...s, running: status === 'running', starting: false } : s))
    })
    return () => { removeDiag(); removeStatus(); disposeAllProviders(); window.api.lsp.stopAll(sessionId).catch(() => {}) }
  }, [sessionId, rootPath])

  const startLspServer = useCallback(async (language: string) => {
    setLspServers((prev) => prev.map((s) => s.language === language ? { ...s, starting: true } : s))
    try {
      const r = await window.api.lsp.start(sessionId, rootPath, language)
      if (r.success) {
        const langMap: Record<string, string[]> = { typescript: ['typescript', 'javascript'], python: ['python'], go: ['go'], rust: ['rust'], clangd: ['c', 'cpp'] }
        for (const lid of (langMap[language] || [])) registerLspProviders({ sessionId, rootPath }, lid)
        setLspServers((prev) => prev.map((s) => s.language === language ? { ...s, running: true, starting: false } : s))
      } else {
        setLspServers((prev) => prev.map((s) => s.language === language ? { ...s, starting: false } : s))
      }
    } catch { setLspServers((prev) => prev.map((s) => s.language === language ? { ...s, starting: false } : s)) }
  }, [sessionId, rootPath])

  // ===== File ops =====
  const handleFileOpen = useCallback(async (filePath: string, line?: number) => {
    setDiffFile(null)
    const existing = openFilesRef.current.find((f) => f.path === filePath)
    if (existing) {
      setActiveFile(filePath)
      if (line && editorRef.current) setTimeout(() => { editorRef.current?.revealLineInCenter(line!); editorRef.current?.setPosition({ lineNumber: line!, column: 1 }) }, 100)
      return
    }
    const name = filePath.split('/').pop() || filePath
    const language = detectLang(name)
    setOpenFiles((prev) => [...prev, { path: filePath, name, content: '', originalContent: '', modified: false, loading: true, language }])
    setActiveFile(filePath)
    try {
      const r = await window.api.sftp.readFile(sessionId, filePath)
      if (r.success) { setOpenFiles((prev) => prev.map((f) => f.path === filePath ? { ...f, content: r.content, originalContent: r.content, loading: false } : f)); notifyFileOpen(sessionId, filePath, language, r.content) }
      else setOpenFiles((prev) => prev.map((f) => f.path === filePath ? { ...f, content: `// Error: ${r.error}`, loading: false } : f))
    } catch (err: any) { setOpenFiles((prev) => prev.map((f) => f.path === filePath ? { ...f, content: `// Error: ${err.message}`, loading: false } : f)) }
    if (line) setTimeout(() => { editorRef.current?.revealLineInCenter(line); editorRef.current?.setPosition({ lineNumber: line, column: 1 }) }, 300)
  }, [sessionId])

  const handleFileClose = useCallback((filePath: string) => {
    const currentOpenFiles = openFilesRef.current
    const file = currentOpenFiles.find((f) => f.path === filePath)
    if (file?.modified && !confirm(`${file.name} 有未保存的更改，确定关闭？`)) return
    if (file) notifyFileClose(sessionId, filePath, file.language)
    setOpenFiles((prev) => prev.filter((f) => f.path !== filePath))
    if (activeFileRef.current === filePath) { const remaining = currentOpenFiles.filter((f) => f.path !== filePath); setActiveFile(remaining.length > 0 ? remaining[remaining.length - 1].path : null) }
    if (diffFileRef.current === filePath) setDiffFile(null)
  }, [sessionId])

  const handleContentChange = useCallback((filePath: string, content: string) => {
    setOpenFiles((prev) => prev.map((f) => f.path === filePath ? { ...f, content, modified: content !== f.originalContent } : f))
    const file = openFilesRef.current.find((f) => f.path === filePath)
    if (file) notifyFileChange(sessionId, filePath, file.language, content)
  }, [sessionId])

  const handleSave = useCallback(async (filePath: string) => {
    const file = openFilesRef.current.find((f) => f.path === filePath)
    if (!file) return
    try {
      const r = await window.api.sftp.writeFile(sessionId, filePath, file.content)
      if (r.success) { setOpenFiles((prev) => prev.map((f) => f.path === filePath ? { ...f, originalContent: f.content, modified: false } : f)); notifyFileSave(sessionId, filePath, file.language, file.content); loadGitStatus() }
    } catch {}
  }, [sessionId, loadGitStatus])

  const handleWriteFile = useCallback(async (filePath: string, content: string) => {
    await window.api.sftp.writeFile(sessionId, filePath, content)
    const existing = openFilesRef.current.find((f) => f.path === filePath)
    if (existing) setOpenFiles((prev) => prev.map((f) => f.path === filePath ? { ...f, content, originalContent: content, modified: false } : f))
  }, [sessionId])

  const handleExecuteCommand = useCallback((cmd: string) => { window.api.ssh.write(sessionId, cmd + '\n') }, [sessionId])
  const handleCursorChange = useCallback((line: number, col: number) => { setCursorLine(line); setCursorCol(col) }, [])
  const handleEditorReady = useCallback((editor: monacoType.editor.IStandaloneCodeEditor) => { editorRef.current = editor }, [])

  const currentFile = useMemo(() => openFiles.find((f) => f.path === activeFile) || null, [openFiles, activeFile])
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warningCount = diagnostics.filter((d) => d.severity === 'warning').length
  const runningLsp = lspServers.filter((s) => s.running).length

  // Resize
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); resizeRef.current = { startY: e.clientY, startHeight: bottomHeight }
    const handleMove = (ev: MouseEvent) => { if (!resizeRef.current) return; setBottomHeight(Math.max(80, Math.min(500, resizeRef.current.startHeight + (resizeRef.current.startY - ev.clientY)))) }
    const handleUp = () => { resizeRef.current = null; document.removeEventListener('mousemove', handleMove); document.removeEventListener('mouseup', handleUp) }
    document.addEventListener('mousemove', handleMove); document.addEventListener('mouseup', handleUp)
  }, [bottomHeight])

  const activityItems: Array<{ id: SidebarView; icon: any; label: string; badge: number }> = [
    { id: 'files', icon: FileCode, label: '资源管理器', badge: 0 },
    { id: 'search', icon: Search, label: '搜索', badge: 0 },
    { id: 'outline', icon: List, label: '大纲', badge: 0 },
    { id: 'git', icon: GitBranch, label: 'Git', badge: gitChanges.size },
  ]

  return (
    <div className="flex flex-col w-full h-full" style={{ background: C.bg }}>
      <div className="flex flex-1 overflow-hidden">
        {/* === Activity Bar === */}
        <div className="flex flex-col items-center w-[48px] shrink-0 py-1" style={{ background: C.activityBg, borderRight: `1px solid ${C.border}` }}>
          {activityItems.map((item) => {
            const active = sidebarView === item.id && showSidebar
            return (
              <button key={item.id} title={item.label}
                onClick={() => { if (active) setShowSidebar(false); else { setSidebarView(item.id); setShowSidebar(true) } }}
                className="relative w-[48px] h-[48px] flex items-center justify-center transition-colors"
                style={{
                  color: active ? '#ffffff' : '#858585',
                  borderLeft: active ? '2px solid #ffffff' : '2px solid transparent',
                  background: active ? 'transparent' : 'transparent',
                }}>
                <item.icon className="w-[22px] h-[22px]" />
                {item.badge > 0 && (
                  <span className="absolute top-2 right-1.5 min-w-[16px] h-[16px] bg-[#007acc] text-white rounded-full text-[10px] flex items-center justify-center font-bold px-1">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </button>
            )
          })}

          <div className="flex-1" />

          <button onClick={() => setShowAI(!showAI)} title="AI 助手"
            className="w-[48px] h-[48px] flex items-center justify-center transition-colors"
            style={{ color: showAI ? '#ffffff' : '#858585', borderLeft: showAI ? '2px solid #ffffff' : '2px solid transparent' }}>
            <Sparkles className="w-[22px] h-[22px]" />
          </button>

          <button title={`LSP: ${runningLsp} 运行中`}
            className="w-[48px] h-[48px] flex items-center justify-center mb-1"
            style={{ color: runningLsp > 0 ? C.success : '#858585' }}>
            <Server className="w-[18px] h-[18px]" />
          </button>
        </div>

        {/* === Sidebar === */}
        {showSidebar && (
          <div className="w-[260px] shrink-0 flex flex-col overflow-hidden" style={{ background: C.sidebarBg, borderRight: `1px solid ${C.border}` }}>
            <div className="flex items-center h-[35px] px-4 shrink-0">
              <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#bbbbbb' }}>
                {sidebarView === 'files' ? '资源管理器' : sidebarView === 'search' ? '搜索' : sidebarView === 'outline' ? '大纲' : 'Git 更改'}
              </span>
            </div>
            <div className="flex-1 overflow-hidden">
              {sidebarView === 'files' && (
                <div className="flex flex-col h-full">
                  <div className="flex-1 overflow-y-auto">
                    <FileTree sessionId={sessionId} rootPath={rootPath} gitChanges={gitChanges} onFileOpen={(p) => handleFileOpen(p)} onRefresh={loadGitStatus} />
                  </div>
                  {lspServers.filter((s) => s.recommended || s.available).length > 0 && (
                    <div style={{ borderTop: `1px solid ${C.border}` }} className="shrink-0 py-1">
                      <div className="px-4 py-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#bbbbbb' }}>语言服务器</div>
                      {lspServers.filter((s) => s.recommended || s.available).map((s) => (
                        <div key={s.language} className="flex items-center gap-2 px-4 py-1 text-[13px]" style={{ color: C.text }}>
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.running ? C.success : s.available ? '#858585' : C.error }} />
                          <span className="capitalize">{s.language}</span>
                          {!s.running && s.available && (
                            <button onClick={() => startLspServer(s.language)} disabled={s.starting} className="ml-auto text-[12px] hover:underline" style={{ color: C.accent }}>
                              {s.starting ? <Loader2 className="w-3 h-3 animate-spin" /> : '启动'}
                            </button>
                          )}
                          {!s.available && <span className="ml-auto text-[11px]" style={{ color: '#858585' }} title={s.installHint}>未安装</span>}
                          {s.running && <span className="ml-auto text-[11px]" style={{ color: C.success }}>运行中</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {sidebarView === 'search' && <SearchPanel sessionId={sessionId} rootPath={rootPath} onOpenFile={handleFileOpen} />}
              {sidebarView === 'outline' && <OutlinePanel editor={editorRef.current} />}
              {sidebarView === 'git' && (
                <GitChangesPanel sessionId={sessionId} rootPath={rootPath} gitChanges={gitChanges}
                  onOpenFile={handleFileOpen} onOpenDiff={(path) => { setDiffFile(path); handleFileOpen(path) }} />
              )}
            </div>
          </div>
        )}

        {/* === Center: Editor + Bottom === */}
        <div className="flex flex-col flex-1 overflow-hidden">
          <Breadcrumbs filePath={activeFile} rootPath={rootPath} editor={editorRef.current} />

          <div className="flex-1 overflow-hidden">
            {diffFile && currentFile ? (
              <DiffView sessionId={sessionId} rootPath={rootPath} filePath={diffFile} currentContent={currentFile.content} onClose={() => setDiffFile(null)} />
            ) : (
              <EditorTabs sessionId={sessionId} openFiles={openFiles} activeFile={activeFile}
                onActivate={setActiveFile} onClose={handleFileClose} onContentChange={handleContentChange}
                onSave={handleSave} onCursorChange={handleCursorChange} onEditorReady={handleEditorReady} />
            )}
          </div>

          {/* Bottom Panel */}
          {showBottom && (
            <>
              <div onMouseDown={handleResizeStart} className="h-[2px] cursor-ns-resize shrink-0"
                style={{ background: C.border }} onMouseOver={(e) => (e.currentTarget.style.background = C.accent)}
                onMouseOut={(e) => (e.currentTarget.style.background = C.border)} />

              <div className="shrink-0 flex flex-col" style={{ height: bottomHeight, background: C.panelBg, borderTop: `1px solid ${C.border}` }}>
                <div className="flex items-center h-[35px] px-3 shrink-0 gap-0.5" style={{ borderBottom: `1px solid ${C.border}` }}>
                  {([
                    { id: 'terminal' as BottomTab, label: '终端', icon: Terminal, badge: '' },
                    { id: 'problems' as BottomTab, label: '问题', icon: AlertCircle, badge: errorCount + warningCount > 0 ? `${errorCount + warningCount}` : '' },
                  ]).map((tab) => (
                    <button key={tab.id} onClick={() => setBottomTab(tab.id)}
                      className="flex items-center gap-1.5 px-3 h-[35px] text-[13px] transition-colors relative"
                      style={{ color: bottomTab === tab.id ? '#ffffff' : '#969696', borderBottom: bottomTab === tab.id ? '1px solid #ffffff' : '1px solid transparent' }}>
                      <tab.icon className="w-[14px] h-[14px]" />
                      {tab.label}
                      {tab.badge && <span className="ml-0.5 px-1.5 rounded-full text-[11px] font-medium" style={{ background: tab.id === 'problems' && errorCount > 0 ? '#5a1d1d' : '#3c3c3c', color: errorCount > 0 ? C.error : C.text }}>{tab.badge}</span>}
                    </button>
                  ))}
                  <div className="flex-1" />
                  <button onClick={() => setShowBottom(false)} className="p-1.5 rounded hover:bg-[#2a2d2e]" style={{ color: '#969696' }}>
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  {bottomTab === 'terminal' && <WorkspaceTerminal sessionId={sessionId} rootPath={rootPath} isActive={isActive && showBottom && bottomTab === 'terminal'} />}
                  {bottomTab === 'problems' && <ProblemsPanel diagnostics={diagnostics} onOpenFile={handleFileOpen} />}
                </div>
              </div>
            </>
          )}
        </div>

        {/* === AI Panel === */}
        {showAI && (
          <WorkspaceAI sessionId={sessionId} rootPath={rootPath}
            currentFile={currentFile ? { path: currentFile.path, content: currentFile.content, language: currentFile.language } : null}
            onInsertCode={(code) => { if (currentFile) handleContentChange(currentFile.path, currentFile.content + '\n' + code) }}
            onExecuteCommand={handleExecuteCommand} onOpenFile={(p) => handleFileOpen(p)} onWriteFile={handleWriteFile}
            onReviewDiff={(path, original, modified) => {
              const lang = detectLang(path.split('/').pop() || '')
              setDiffFile(null) // clear old diff
              // Use a special diff review state
              setDiffFile(path)
              // Open the file in editor first
              handleFileOpen(path).then(() => setDiffFile(path))
            }}
            onClose={() => setShowAI(false)} />
        )}
      </div>

      {/* === Status Bar (Cursor blue) === */}
      <div className="flex items-center h-[25px] px-3 shrink-0 select-none text-[12px]"
        style={{ background: C.statusBg, color: C.statusFg }}>
        <div className="flex items-center gap-3">
          {gitBranch && (
            <span className="flex items-center gap-1 opacity-90">
              <GitBranch className="w-3.5 h-3.5" />
              {gitBranch}
              {gitChanges.size > 0 && <span className="opacity-70">*{gitChanges.size}</span>}
            </span>
          )}
          <button onClick={() => { setShowBottom(true); setBottomTab('problems') }} className="flex items-center gap-1 opacity-90 hover:opacity-100">
            {errorCount > 0 && <><AlertCircle className="w-3.5 h-3.5" />{errorCount}</>}
            {warningCount > 0 && <><AlertTriangle className="w-3.5 h-3.5 ml-0.5" />{warningCount}</>}
            {errorCount === 0 && warningCount === 0 && <><AlertCircle className="w-3.5 h-3.5" />0</>}
          </button>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-4 opacity-90">
          <button onClick={() => { setShowBottom(!showBottom); setBottomTab('terminal') }} className="flex items-center gap-1 hover:opacity-100">
            <Terminal className="w-3.5 h-3.5" /> 终端
          </button>
          <span>行 {cursorLine}, 列 {cursorCol}</span>
          {currentFile && <span className="capitalize">{currentFile.language}</span>}
          {runningLsp > 0 && <span className="flex items-center gap-1"><Server className="w-3.5 h-3.5" /> LSP</span>}
          <span>UTF-8</span>
        </div>
      </div>
    </div>
  )
}

// ===== Git Changes Panel =====
function GitChangesPanel({ sessionId, rootPath, gitChanges, onOpenFile, onOpenDiff }: {
  sessionId: string; rootPath: string; gitChanges: Map<string, string>
  onOpenFile: (path: string) => void; onOpenDiff: (path: string) => void
}) {
  const entries = useMemo(() => Array.from(gitChanges.entries()), [gitChanges])
  if (entries.length === 0) return <div className="p-6 text-center" style={{ color: '#6e7681', fontSize: 13 }}>无更改</div>

  return (
    <div className="py-1">
      {entries.map(([file, status]) => (
        <div key={file} className="flex items-center gap-2 px-4 h-[22px] hover:bg-[#2a2d2e] cursor-pointer group" onClick={() => onOpenFile(`${rootPath}/${file}`)}>
          <span className="w-5 text-center font-mono shrink-0 text-[12px]" style={{
            color: status === 'M' || status === 'MM' ? '#e2c08d' : status === 'A' || status === '??' ? '#73c991' : status === 'D' ? '#c74e39' : '#969696'
          }}>{status}</span>
          <span className="truncate text-[13px]" style={{ color: '#cccccc' }}>{file}</span>
          <button onClick={(e) => { e.stopPropagation(); onOpenDiff(`${rootPath}/${file}`) }}
            className="ml-auto opacity-0 group-hover:opacity-100 p-0.5 hover:bg-[#3c3c3c] rounded" title="查看更改">
            <GitCompare className="w-4 h-4" style={{ color: '#e2c08d' }} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ===== Integrated Terminal =====
function WorkspaceTerminal({ sessionId, rootPath, isActive }: { sessionId: string; rootPath: string; isActive: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const rendererDisposeRef = useRef<(() => void) | null>(null)
  const osc52DisposeRef = useRef<(() => void) | null>(null)
  const cdSentRef = useRef(false)
  const isActiveRef = useRef(isActive)
  const pendingOutputRef = useRef('')
  const outputRafRef = useRef<number | null>(null)
  const backpressureNotifiedRef = useRef(false)
  const interactionProfileRef = useRef<TerminalInteractionProfile>('default')
  const frozenThemeRef = useRef(false)
  const fontSize = useSettingsStore((state) => state.settings.fontSize)
  const fontFamily = useSettingsStore((state) => state.settings.fontFamily)
  const aiCompatibilityMode = useSettingsStore((state) => state.settings.aiCompatibilityMode)
  const terminalRenderer = useSettingsStore((state) => state.settings.terminalRenderer)
  const allowRemoteClipboardWrite = useSettingsStore((state) => state.settings.allowRemoteClipboardWrite)
  const currentProfile = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode)

  const pasteToTerminal = useCallback((text: string) => {
    const term = termRef.current
    if (!term || !text) return
    term.clearSelection()
    term.focus()
    window.api.ssh.write(sessionId, text)
  }, [sessionId])

  useEffect(() => {
    isActiveRef.current = isActive
    if (!isActive) {
      if (outputRafRef.current !== null) {
        cancelAnimationFrame(outputRafRef.current)
        outputRafRef.current = null
      }
      return
    }
    if (termRef.current && pendingOutputRef.current && outputRafRef.current === null) {
      outputRafRef.current = requestAnimationFrame(() => {
        outputRafRef.current = null
        if (!termRef.current || !pendingOutputRef.current || !isActiveRef.current) return
        termRef.current.write(pendingOutputRef.current)
        pendingOutputRef.current = ''
      })
    }
  }, [isActive])

  useEffect(() => {
    if (!containerRef.current || termRef.current) return
    const currentContainer = containerRef.current
    const term = new XTerminal({
      allowProposedApi: true,
      theme: {
        background: '#1e1e1e', foreground: '#cccccc', cursor: '#aeafad',
        selectionBackground: '#264f78', selectionForeground: '#ffffff',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
        blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
        brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
        brightCyan: '#29b8db', brightWhite: '#e5e5e5',
      },
      fontSize,
      fontFamily,
      cursorBlink: true,
      scrollback: currentProfile.scrollback,
      convertEol: !aiCompatibilityMode,
      rightClickSelectsWord: false,
      lineHeight: 1.15,
      letterSpacing: 0,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      minimumContrastRatio: 1,
    })
    const fit = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(unicode11Addon)
    term.unicode.activeVersion = TERMINAL_UNICODE_VERSION
    term.open(containerRef.current)
    fit.fit()
    termRef.current = term
    fitAddonRef.current = fit

    osc52DisposeRef.current = registerOsc52ClipboardHandler(term, {
      enabled: allowRemoteClipboardWrite
    })

    const pasteFromClipboard = () => {
      pasteToTerminal(window.api.clipboard.readText())
    }

    const switchInteractionProfile = (profile: TerminalInteractionProfile) => {
      if (interactionProfileRef.current === profile) return
      interactionProfileRef.current = profile
      backpressureNotifiedRef.current = false
      if (profile === 'heavy-cli') {
        frozenThemeRef.current = true
      }

      const nextProfile = getTerminalInteractionProfileConfig(profile, aiCompatibilityMode)
      term.options.scrollback = nextProfile.scrollback
      fitAddonRef.current?.fit()

      if (rendererDisposeRef.current) {
        rendererDisposeRef.current()
        rendererDisposeRef.current = attachPreferredRenderer(
          term,
          resolveRendererModeForProfile(terminalRenderer, profile),
          undefined
        ).dispose
      }
    }

    const copyText = (text: string) => {
      window.api.clipboard.writeText(text)
    }

    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') { const s = term.getSelection(); if (s) copyText(s); return false }
      if (e.ctrlKey && e.shiftKey && e.key === 'V') { pasteFromClipboard(); return false }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') { pasteFromClipboard(); return false }
      if (e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'c') { const s = term.getSelection(); if (s) { copyText(s); return false } }
      if (e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'v') { pasteFromClipboard(); return false }
      if (e.shiftKey && e.key === 'Insert') { pasteFromClipboard(); return false }
      return true
    })
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }
    currentContainer.addEventListener('contextmenu', handleContextMenu, true)

    const handlePasteEvent = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()
      e.stopPropagation()
      pasteToTerminal(text)
    }
    currentContainer.addEventListener('paste', handlePasteEvent, true)

    const flushOutput = () => {
      outputRafRef.current = null
      if (!pendingOutputRef.current || !isActiveRef.current) return

      const profile = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode)
      const chunk = pendingOutputRef.current.slice(0, profile.chunkSize)
      pendingOutputRef.current = pendingOutputRef.current.slice(chunk.length)
      term.write(chunk)

      if (pendingOutputRef.current) {
        outputRafRef.current = requestAnimationFrame(flushOutput)
      } else {
        backpressureNotifiedRef.current = false
      }
    }
    const queueOutput = (data: string) => {
      pendingOutputRef.current += data

      const profile = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode)
      const maxPending = isActiveRef.current ? profile.maxPendingBytes : profile.maxPendingWhenHidden
      if (pendingOutputRef.current.length > maxPending) {
        pendingOutputRef.current = pendingOutputRef.current.slice(-maxPending)
        if (!backpressureNotifiedRef.current) {
          backpressureNotifiedRef.current = true
          pendingOutputRef.current = `\r\n\x1b[33m[终端输出过快，已裁剪旧输出以保持工作区终端稳定]\x1b[0m\r\n` + pendingOutputRef.current
        }
      }

      if (isActiveRef.current && outputRafRef.current === null) {
        outputRafRef.current = requestAnimationFrame(flushOutput)
      }
    }

    term.onData((data) => {
      if (detectHeavyCliCommand(data)) {
        switchInteractionProfile('heavy-cli')
      }
      window.api.ssh.write(sessionId, data)
    })
    const removeData = window.api.ssh.onData((sid: string, data: string) => { if (sid === sessionId) queueOutput(data) })

    if (!cdSentRef.current) {
      cdSentRef.current = true
      const safeRoot = rootPath.replace(/'/g, "'\\''")
      setTimeout(() => window.api.ssh.write(sessionId, `cd '${safeRoot}' && clear\n`), 200)
    }

    let debounceTimer: any
    const ro = new ResizeObserver(() => {
      clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { try { if (containerRef.current && containerRef.current.offsetWidth > 0) fit.fit() } catch {} }, 100)
    })
    ro.observe(containerRef.current)

    setTimeout(() => {
      if (!termRef.current) return
      rendererDisposeRef.current = attachPreferredRenderer(
        term,
        resolveRendererModeForProfile(terminalRenderer, interactionProfileRef.current),
        undefined
      ).dispose
      try { fit.fit() } catch { }
    }, 100)

    return () => {
      removeData()
      ro.disconnect()
      clearTimeout(debounceTimer)
      if (outputRafRef.current !== null) cancelAnimationFrame(outputRafRef.current)
      pendingOutputRef.current = ''
      rendererDisposeRef.current?.()
      rendererDisposeRef.current = null
      osc52DisposeRef.current?.()
      osc52DisposeRef.current = null
      fitAddonRef.current = null
      currentContainer.removeEventListener('paste', handlePasteEvent, true)
      currentContainer.removeEventListener('contextmenu', handleContextMenu, true)
      term.dispose()
      termRef.current = null
    }
  }, [sessionId, rootPath, fontSize, fontFamily, aiCompatibilityMode, terminalRenderer, pasteToTerminal, allowRemoteClipboardWrite])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    try {
      term.options.fontSize = fontSize
      term.options.fontFamily = fontFamily
      term.options.scrollback = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode).scrollback
      term.options.convertEol = !aiCompatibilityMode
      term.options.customGlyphs = true
      term.options.rescaleOverlappingGlyphs = true
      term.options.minimumContrastRatio = 1
      term.options.lineHeight = 1.15
      term.options.letterSpacing = 0
      fitAddonRef.current?.fit()
    } catch { }
  }, [fontSize, fontFamily, aiCompatibilityMode])

  useEffect(() => {
    if (!isActive) return
    if (!termRef.current) return
    if (termRef.current && termRef.current.element && termRef.current.element.clientWidth > 0) {
      termRef.current.focus()
    }
  }, [isActive])

  return <div ref={containerRef} className="w-full h-full" style={{ minHeight: 0, userSelect: 'text' }} />
}
