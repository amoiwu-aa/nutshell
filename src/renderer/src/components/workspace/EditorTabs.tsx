import { useRef, useCallback, useEffect, useMemo } from 'react'
import { X, Loader2, Circle, Code2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MonacoEditorWrapper, detectMonacoLang } from './MonacoEditorWrapper'
import type * as monacoType from 'monaco-editor'

export interface OpenFile {
  path: string; name: string; content: string; originalContent: string
  modified: boolean; loading: boolean; language: string
}

interface EditorTabsProps {
  sessionId: string; openFiles: OpenFile[]; activeFile: string | null
  onActivate: (path: string) => void; onClose: (path: string) => void
  onContentChange: (path: string, content: string) => void; onSave: (path: string) => void
  onCursorChange?: (line: number, col: number) => void
  onEditorReady?: (editor: monacoType.editor.IStandaloneCodeEditor) => void
}

export function detectLang(name: string): string { return detectMonacoLang(name) }

function getFileIconColor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  const c: Record<string, string> = {
    ts: '#519aba', tsx: '#519aba', js: '#cbcb41', jsx: '#cbcb41', py: '#3572a5', go: '#00add8',
    rs: '#dea584', java: '#cc3e44', json: '#cbcb41', yml: '#cb4b16', yaml: '#cb4b16', md: '#808080',
    sh: '#4eaa25', css: '#563d7c', html: '#e34c26', vue: '#41b883', sql: '#e38c00',
  }
  return c[ext || ''] || '#808080'
}

export function EditorTabs({ sessionId, openFiles, activeFile, onActivate, onClose, onContentChange, onSave, onCursorChange, onEditorReady }: EditorTabsProps) {
  const tabBarRef = useRef<HTMLDivElement>(null)
  const current = useMemo(() => openFiles.find((f) => f.path === activeFile), [openFiles, activeFile])
  const handleChange = useCallback((val: string) => { if (current) onContentChange(current.path, val) }, [current, onContentChange])
  const handleSave = useCallback(() => { if (activeFile) onSave(activeFile) }, [activeFile, onSave])

  useEffect(() => {
    if (!tabBarRef.current || !activeFile) return
    const el = tabBarRef.current.querySelector(`[data-path="${CSS.escape(activeFile)}"]`) as HTMLElement
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [activeFile])

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar - VS Code style */}
      <div ref={tabBarRef} className="flex items-center h-[35px] shrink-0 overflow-x-auto"
        style={{ background: '#252526', scrollbarWidth: 'thin' }}>
        {openFiles.map((f) => {
          const isActive = f.path === activeFile
          return (
            <div key={f.path} data-path={f.path}
              onClick={() => onActivate(f.path)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); onClose(f.path) } }}
              className="flex items-center gap-1.5 px-3 h-[35px] cursor-pointer shrink-0 max-w-[200px] group relative"
              style={{
                background: isActive ? '#1e1e1e' : '#2d2d2d',
                color: isActive ? '#ffffff' : '#969696',
                borderRight: '1px solid #252526',
              }}>
              {/* Top accent for active tab */}
              {isActive && <div className="absolute top-0 left-0 right-0 h-[1px]" style={{ background: '#007acc' }} />}
              {/* File icon */}
              <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ background: getFileIconColor(f.name) }} />
              <span className="truncate select-none text-[13px]">{f.name}</span>
              {f.modified && <Circle className="w-[8px] h-[8px] shrink-0 fill-current" style={{ color: '#e2c08d' }} />}
              <button onClick={(e) => { e.stopPropagation(); onClose(f.path) }}
                className={cn('shrink-0 p-0.5 rounded', isActive ? 'opacity-60 hover:opacity-100 hover:bg-[#3c3c3c]' : 'opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-[#3c3c3c]')}>
                <X className="w-[14px] h-[14px]" />
              </button>
            </div>
          )
        })}
      </div>

      {/* Editor */}
      {current ? (
        current.loading ? (
          <div className="flex-1 flex items-center justify-center" style={{ background: '#1e1e1e' }}>
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: '#969696' }} />
            <span className="ml-2 text-[14px]" style={{ color: '#969696' }}>加载中...</span>
          </div>
        ) : (
          <div className="flex-1 overflow-hidden">
            <MonacoEditorWrapper value={current.content} language={current.language}
              onChange={handleChange} onSave={handleSave} onCursorChange={onCursorChange} onEditorReady={onEditorReady} />
          </div>
        )
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center select-none" style={{ background: '#1e1e1e' }}>
          <Code2 className="w-16 h-16 mb-4" style={{ color: '#3c3c3c' }} />
          <p className="text-[16px] mb-1" style={{ color: '#6e7681' }}>打开文件开始编辑</p>
          <p className="text-[13px]" style={{ color: '#484f58' }}>从左侧文件树选择文件</p>
        </div>
      )}
    </div>
  )
}
