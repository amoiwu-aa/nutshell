import { useState, useEffect, useRef, useCallback } from 'react'
import { Save, X, FileText, WrapText, Search, Sparkles, Send, Copy, Play, Loader2, Code, HelpCircle, Wrench, Bug } from 'lucide-react'
import { cn } from '../../lib/utils'
import hljs from 'highlight.js/lib/core'

// Language loaders - lazy loaded on demand
const langLoaders: Record<string, () => Promise<any>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  bash: () => import('highlight.js/lib/languages/bash'),
  json: () => import('highlight.js/lib/languages/json'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  sql: () => import('highlight.js/lib/languages/sql'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  go: () => import('highlight.js/lib/languages/go'),
  java: () => import('highlight.js/lib/languages/java'),
  rust: () => import('highlight.js/lib/languages/rust'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  ini: () => import('highlight.js/lib/languages/ini'),
  php: () => import('highlight.js/lib/languages/php')
}

const loadedLangs = new Set<string>()

async function ensureLanguage(lang: string): Promise<boolean> {
  if (lang === 'plaintext' || loadedLangs.has(lang)) return loadedLangs.has(lang)
  const actualLang = lang === 'html' ? 'xml' : lang
  const loader = langLoaders[actualLang]
  if (!loader) return false
  try {
    const mod = await loader()
    hljs.registerLanguage(actualLang, mod.default)
    if (lang === 'html') hljs.registerLanguage('html', mod.default)
    loadedLangs.add(lang)
    loadedLangs.add(actualLang)
    return true
  } catch { return false }
}

interface FileEditorProps {
  sessionId: string
  filePath: string
  fileName: string
  onClose: () => void
}

function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const langMap: Record<string, string> = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python', rb: 'python',
    go: 'go', rs: 'rust', java: 'java',
    c: 'javascript', cpp: 'javascript', h: 'javascript',
    cs: 'javascript', php: 'php',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    yml: 'yaml', yaml: 'yaml',
    json: 'json', xml: 'xml', html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css',
    md: 'markdown', sql: 'sql',
    dockerfile: 'dockerfile', toml: 'ini', ini: 'ini',
    conf: 'nginx', cfg: 'ini', env: 'bash',
    nginx: 'nginx'
  }
  return langMap[ext || ''] || 'plaintext'
}

export function FileEditor({ sessionId, filePath, fileName, onClose }: FileEditorProps) {
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [modified, setModified] = useState(false)
  const [lineCount, setLineCount] = useState(0)
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 })
  const [wordWrap, setWordWrap] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [searchText, setSearchText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const highlightRef = useRef<HTMLPreElement>(null)
  const lineNumberRef = useRef<HTMLDivElement>(null)
  const [showAI, setShowAI] = useState(false)
  const [aiInput, setAiInput] = useState('')
  const [aiResult, setAiResult] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiMode, setAiMode] = useState<'generate' | 'explain' | 'refactor' | 'fix'>('generate')

  const language = detectLanguage(fileName)

  useEffect(() => {
    loadFile()
  }, [sessionId, filePath])

  // Update syntax highlight when content changes (lazy load language)
  useEffect(() => {
    if (!highlightRef.current || !content) return
    const doHighlight = async () => {
      const lang = language === 'plaintext' ? undefined : language
      if (lang) {
        const loaded = await ensureLanguage(lang)
        if (loaded && highlightRef.current) {
          try {
            highlightRef.current.innerHTML = hljs.highlight(content, { language: lang }).value
            return
          } catch { /* fall through */ }
        }
      }
      if (highlightRef.current) highlightRef.current.textContent = content
    }
    doHighlight()
  }, [content, language])

  const loadFile = async () => {
    setLoading(true)
    try {
      const result = await window.api.sftp.readFile(sessionId, filePath)
      if (result.success) {
        setContent(result.content)
        setOriginalContent(result.content)
        setLineCount(result.content.split('\n').length)
      }
    } catch (err) {
      console.error('Failed to load file:', err)
    }
    setLoading(false)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const result = await window.api.sftp.writeFile(sessionId, filePath, content)
      if (result.success) {
        setOriginalContent(content)
        setModified(false)
      }
    } catch (err) {
      console.error('Failed to save file:', err)
    }
    setSaving(false)
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setContent(value)
    setModified(value !== originalContent)
    setLineCount(value.split('\n').length)
  }

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault()
        handleSave()
      }
      if (e.ctrlKey && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        const textarea = textareaRef.current
        if (textarea) {
          const start = textarea.selectionStart
          const end = textarea.selectionEnd
          const newValue = content.substring(0, start) + '  ' + content.substring(end)
          setContent(newValue)
          setModified(newValue !== originalContent)
          setTimeout(() => {
            textarea.selectionStart = textarea.selectionEnd = start + 2
          }, 0)
        }
      }
    },
    [content, originalContent]
  )

  const handleScroll = () => {
    if (textareaRef.current) {
      if (lineNumberRef.current) {
        lineNumberRef.current.scrollTop = textareaRef.current.scrollTop
      }
      if (highlightRef.current) {
        highlightRef.current.scrollTop = textareaRef.current.scrollTop
        highlightRef.current.scrollLeft = textareaRef.current.scrollLeft
      }
    }
  }

  const handleSelect = () => {
    if (textareaRef.current) {
      const pos = textareaRef.current.selectionStart
      const lines = content.substring(0, pos).split('\n')
      setCursorPos({
        line: lines.length,
        col: (lines[lines.length - 1]?.length || 0) + 1
      })
    }
  }

  const handleSearchNext = () => {
    if (!searchText || !textareaRef.current) return
    const textarea = textareaRef.current
    const start = textarea.selectionEnd
    const index = content.indexOf(searchText, start)
    if (index >= 0) {
      textarea.focus()
      textarea.setSelectionRange(index, index + searchText.length)
    } else {
      const wrapIndex = content.indexOf(searchText)
      if (wrapIndex >= 0) {
        textarea.focus()
        textarea.setSelectionRange(wrapIndex, wrapIndex + searchText.length)
      }
    }
  }

  const getSelectedText = (): string => {
    if (!textareaRef.current) return ''
    const { selectionStart, selectionEnd } = textareaRef.current
    return content.substring(selectionStart, selectionEnd)
  }

  const handleAIAction = async () => {
    if (aiLoading) return
    setAiLoading(true); setAiResult('')
    const selected = getSelectedText()
    try {
      let r: any
      if (aiMode === 'generate') {
        r = await window.api.ai.codeGenerate(content, language, aiInput || '根据上下文续写代码')
      } else if (aiMode === 'explain') {
        r = await window.api.ai.codeExplain(selected || content.substring(0, 2000), language)
      } else if (aiMode === 'refactor') {
        r = await window.api.ai.codeRefactor(selected || content, language, aiInput || '')
      } else if (aiMode === 'fix') {
        r = await window.api.ai.codeFix(selected || content, language, aiInput || '')
      }
      setAiResult(r?.success ? r.content : `错误: ${r?.error}`)
    } catch (err: any) { setAiResult(`请求失败: ${err.message}`) }
    setAiLoading(false)
  }

  const extractCodeFromResult = (text: string): string => {
    const match = text.match(/```[\w]*\n?([\s\S]*?)```/)
    return match ? match[1].trim() : ''
  }

  const insertAtCursor = (code: string) => {
    if (!textareaRef.current) return
    const ta = textareaRef.current
    const start = ta.selectionStart
    const newContent = content.substring(0, start) + code + content.substring(start)
    setContent(newContent); setModified(true); setLineCount(newContent.split('\n').length)
  }

  const replaceSelection = (code: string) => {
    if (!textareaRef.current) return
    const ta = textareaRef.current
    const newContent = content.substring(0, ta.selectionStart) + code + content.substring(ta.selectionEnd)
    setContent(newContent); setModified(true); setLineCount(newContent.split('\n').length)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-background">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">加载中...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full bg-background" onKeyDown={(e) => { if (e.key === 'Escape' && !showAI) onClose(); if (e.ctrlKey && e.key === 'k') { e.preventDefault(); setShowAI(!showAI) } }}>
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-card border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">{fileName}</span>
          <span className="text-xs text-muted-foreground font-mono truncate max-w-[300px]">{filePath}</span>
          {modified && (
            <span className="w-2 h-2 rounded-full bg-yellow-500" title="未保存的更改" />
          )}
          <span className="text-xs px-1.5 py-0.5 bg-secondary rounded text-secondary-foreground">
            {language}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSearch(!showSearch)}
            className="p-1.5 hover:bg-accent rounded transition-colors"
            title="搜索 (Ctrl+F)"
            aria-label="搜索"
          >
            <Search className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setWordWrap(!wordWrap)}
            className={cn(
              'p-1.5 rounded transition-colors',
              wordWrap ? 'bg-primary/20 text-primary' : 'hover:bg-accent'
            )}
            title="自动换行"
            aria-label="自动换行"
          >
            <WrapText className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleSave}
            disabled={!modified || saving}
            className="flex items-center gap-1 px-2.5 py-1 bg-primary text-primary-foreground rounded text-xs disabled:opacity-50 hover:bg-primary/90 transition-colors"
            aria-label="保存"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? '保存中...' : '保存'}
          </button>
          <div className="w-px h-4 bg-border mx-0.5" />
          <button onClick={() => setShowAI(!showAI)} className={cn('p-1.5 rounded transition-colors', showAI ? 'bg-primary/20 text-primary' : 'hover:bg-accent')} title="AI 助手 (Ctrl+K)">
            <Sparkles className="w-3.5 h-3.5" />
          </button>
          <button onClick={onClose} className="p-1.5 hover:bg-accent rounded transition-colors" title="关闭" aria-label="关闭编辑器">
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-card border-b border-border shrink-0 animate-slide-up">
          <input
            type="text"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSearchNext()
              if (e.key === 'Escape') setShowSearch(false)
            }}
            placeholder="搜索..."
            className="w-60 px-2 py-1 bg-background border border-input rounded text-sm outline-none focus:ring-1 focus:ring-ring"
            autoFocus
          />
          <button onClick={handleSearchNext} className="px-2 py-1 text-xs bg-secondary rounded hover:bg-secondary/80 transition-colors">
            下一个
          </button>
          <button onClick={() => setShowSearch(false)} className="p-1 hover:bg-accent rounded" aria-label="关闭搜索">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Editor area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Line numbers */}
        <div
          ref={lineNumberRef}
          className="flex flex-col items-end px-3 py-2 bg-card border-r border-border text-xs text-muted-foreground font-mono select-none overflow-hidden shrink-0"
          style={{ minWidth: '50px' }}
        >
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i + 1} className="leading-[1.5rem]">
              {i + 1}
            </div>
          ))}
        </div>

        {/* Code area with syntax highlighting overlay */}
        <div className="relative flex-1 overflow-hidden">
          {/* Highlighted code (visual layer) */}
          <pre
            ref={highlightRef}
            className={cn(
              'absolute inset-0 p-2 font-mono text-sm leading-[1.5rem] pointer-events-none overflow-hidden m-0',
              wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre'
            )}
            style={{ tabSize: 2, color: '#c9d1d9', background: '#0d1117' }}
            aria-hidden="true"
          />

          {/* Textarea (input layer - transparent text) */}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onScroll={handleScroll}
            onClick={handleSelect}
            onKeyUp={handleSelect}
            className={cn(
              'absolute inset-0 w-full h-full p-2 font-mono text-sm outline-none resize-none leading-[1.5rem] caret-white',
              wordWrap ? 'whitespace-pre-wrap' : 'whitespace-pre overflow-auto'
            )}
            style={{
              tabSize: 2,
              color: 'transparent',
              background: 'transparent',
              caretColor: '#58a6ff'
            }}
            spellCheck={false}
          />
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-1 bg-card border-t border-border text-xs text-muted-foreground shrink-0">
        <div className="flex items-center gap-3">
          <span>行 {cursorPos.line}, 列 {cursorPos.col}</span>
          <span>{lineCount} 行</span>
          <span>{content.length} 字符</span>
        </div>
        <div className="flex items-center gap-3">
          <span>UTF-8</span>
          <span>{language.toUpperCase()}</span>
          {modified && <span className="text-yellow-500">已修改</span>}
        </div>
      </div>
    </div>

    {/* AI Sidebar */}
    {showAI && (
      <div className="flex flex-col w-[320px] bg-card border-l border-border shrink-0 h-full">
        <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
          <div className="flex items-center gap-2"><Sparkles className="w-4 h-4 text-primary" /><span className="text-sm font-medium">AI 代码助手</span></div>
          <button onClick={() => setShowAI(false)} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
        </div>

        {/* Mode buttons */}
        <div className="grid grid-cols-4 gap-1 px-2 py-2 border-b border-border shrink-0">
          {([
            { id: 'generate' as const, icon: Code, label: '生成' },
            { id: 'explain' as const, icon: HelpCircle, label: '解释' },
            { id: 'refactor' as const, icon: Wrench, label: '重构' },
            { id: 'fix' as const, icon: Bug, label: '修复' }
          ]).map((m) => (
            <button key={m.id} onClick={() => setAiMode(m.id)}
              className={cn('flex flex-col items-center gap-0.5 py-1.5 rounded text-xs transition-colors',
                aiMode === m.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground hover:bg-secondary/80')}>
              <m.icon className="w-3.5 h-3.5" />{m.label}
            </button>
          ))}
        </div>

        <div className="px-3 py-2 text-xs text-muted-foreground border-b border-border shrink-0">
          {aiMode === 'generate' && '输入描述，AI 将生成代码'}
          {aiMode === 'explain' && '选中代码后点发送，AI 将解释'}
          {aiMode === 'refactor' && '选中代码，输入重构要求（可选）'}
          {aiMode === 'fix' && '选中有问题的代码，输入错误信息（可选）'}
        </div>

        {/* Input */}
        <div className="px-3 py-2 border-b border-border shrink-0">
          <div className="flex gap-2">
            <textarea value={aiInput} onChange={(e) => setAiInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAIAction() } }}
              placeholder={aiMode === 'explain' ? '选中代码后直接发送' : '输入描述或要求...'}
              rows={2} className="flex-1 px-2 py-1.5 bg-background border border-input rounded-lg text-xs outline-none resize-none" disabled={aiLoading} />
            <button onClick={handleAIAction} disabled={aiLoading} className="self-end p-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50 hover:bg-primary/90">
              {aiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Result */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {aiResult ? (
            <div className="text-xs space-y-2">
              {aiResult.split(/(```[\s\S]*?```)/g).map((part, i) => {
                const codeMatch = part.match(/```[\w]*\n?([\s\S]*?)```/)
                if (codeMatch) {
                  const code = codeMatch[1].trim()
                  return (
                    <div key={i} className="rounded-lg overflow-hidden border border-border">
                      <div className="flex items-center justify-between px-3 py-1 bg-card text-xs text-muted-foreground">
                        <span>代码</span>
                        <div className="flex items-center gap-1">
                          <button onClick={() => navigator.clipboard.writeText(code)} className="p-0.5 hover:bg-accent rounded" title="复制"><Copy className="w-3 h-3" /></button>
                          <button onClick={() => insertAtCursor(code)} className="px-1.5 py-0.5 bg-green-600 text-white rounded text-xs hover:bg-green-700">插入</button>
                          {getSelectedText() && <button onClick={() => replaceSelection(code)} className="px-1.5 py-0.5 bg-primary text-primary-foreground rounded text-xs hover:bg-primary/90">替换</button>}
                        </div>
                      </div>
                      <pre className="px-3 py-2 text-xs font-mono bg-[#0d1117] text-[#c9d1d9] overflow-x-auto" style={{userSelect:'text'}}>{code}</pre>
                    </div>
                  )
                }
                return <span key={i} className="whitespace-pre-wrap" style={{userSelect:'text'}}>{part}</span>
              })}
            </div>
          ) : !aiLoading ? (
            <div className="text-center py-6 text-muted-foreground">
              <Sparkles className="w-6 h-6 mx-auto mb-2 opacity-30" />
              <p className="text-xs">选择模式后输入描述</p>
              <p className="text-xs mt-1 opacity-60">Ctrl+K 打开/关闭 AI</p>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="w-3 h-3 animate-spin" />AI 思考中...</div>
          )}
        </div>
      </div>
    )}
    </div>
  )
}
