import { useState, useEffect, useRef } from 'react'
import { Save, X, FileText, WrapText, Search, Sparkles, Send, Copy, Loader2, Code, HelpCircle, Wrench, Bug, AlertCircle, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MonacoEditorWrapper, detectMonacoLang, monaco } from '../workspace/MonacoEditorWrapper'

interface FileEditorProps {
  sessionId: string
  filePath: string
  fileName: string
  onClose: () => void
}

function isBinaryFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase()
  const binaryExts = [
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico',
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2',
    'exe', 'dll', 'so', 'dylib', 'iso', 'bin', 'dmg',
    'mp3', 'mp4', 'wav', 'avi', 'mkv'
  ]
  return binaryExts.includes(ext || '')
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
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [showAI, setShowAI] = useState(false)
  const [aiInput, setAiInput] = useState('')
  const [aiResult, setAiResult] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiMode, setAiMode] = useState<'generate' | 'explain' | 'refactor' | 'fix'>('generate')

  // Save handler needs a ref so Monaco's Ctrl+S command (bound once) sees current state.
  const saveRef = useRef<() => void>(() => {})

  // Binary file editing states
  const [isBinaryMode, setIsBinaryMode] = useState(false)
  const [binarySyncStatus, setBinarySyncStatus] = useState('')
  const localWatchPathRef = useRef<string>('')

  const language = detectMonacoLang(fileName)

  useEffect(() => {
    return () => {
      if (localWatchPathRef.current) {
        window.api.system.unwatchLocalFile(localWatchPathRef.current)
      }
    }
  }, [])

  useEffect(() => {
    loadFile()
  }, [sessionId, filePath])

  const loadFile = async () => {
    setLoading(true)
    if (isBinaryFile(fileName)) {
      setIsBinaryMode(true)
      try {
        setBinarySyncStatus('正在下载文件到本地...')
        const tempDir = await window.api.system.getTempDir()
        const uniqueId = Date.now().toString()
        const dotIndex = fileName.lastIndexOf('.')
        const ext = dotIndex !== -1 ? fileName.substring(dotIndex) : ''
        const baseName = dotIndex !== -1 ? fileName.substring(0, dotIndex) : fileName
        const localPath = `${tempDir}\\${baseName}_${uniqueId}${ext}`

        const dlResult = await window.api.sftp.download(sessionId, filePath, localPath)
        if (dlResult && !dlResult.success) {
          throw new Error(dlResult.error || '下载失败')
        }

        localWatchPathRef.current = localPath
        setBinarySyncStatus('正在唤起本地应用并建立监控...')

        await window.api.system.openLocalFile(localPath)
        await window.api.system.watchLocalFile(sessionId, localPath, filePath)

        setBinarySyncStatus('正在后台静默监视文件变动并提供同步功能(Ctrl+S即可生效)...')
      } catch (err: any) {
        setBinarySyncStatus(`打开失败: ${err.message}`)
      }
      setLoading(false)
      return
    }

    try {
      const result = await window.api.sftp.readFile(sessionId, filePath)
      if (result.success) {
        setContent(result.content)
        setOriginalContent(result.content)
        setLineCount(result.content.split('\n').length)
      } else {
        console.error('Failed to load text file:', result.error)
      }
    } catch (err) {
      console.error('Failed to load text file:', err)
    }
    setLoading(false)
  }

  const handleSave = async () => {
    if (saving) return
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
  saveRef.current = handleSave

  const handleEditorChange = (value: string) => {
    setContent(value)
    setLineCount(value.split('\n').length || 1)
  }

  // Compute modified flag reactively so post-save originalContent changes are honored
  // (handleEditorChange is captured once by Monaco and can't close over latest originalContent)
  useEffect(() => {
    setModified(content !== originalContent)
  }, [content, originalContent])

  const handleEditorReady = (editor: monaco.editor.IStandaloneCodeEditor) => {
    editorRef.current = editor
    editor.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
    // Ctrl+K toggles AI sidebar (overrides Monaco default which opens quick command)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      setShowAI((prev) => !prev)
    })
  }

  // Keep Monaco wordWrap in sync with toolbar toggle
  useEffect(() => {
    editorRef.current?.updateOptions({ wordWrap: wordWrap ? 'on' : 'off' })
  }, [wordWrap])

  const handleOpenFind = () => {
    const ed = editorRef.current
    if (!ed) return
    ed.focus()
    ed.getAction('actions.find')?.run()
  }

  const getSelectedText = (): string => {
    const ed = editorRef.current
    if (!ed) return ''
    const selection = ed.getSelection()
    const model = ed.getModel()
    if (!selection || !model || selection.isEmpty()) return ''
    return model.getValueInRange(selection)
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

  const insertAtCursor = (code: string) => {
    const ed = editorRef.current
    if (!ed) return
    const pos = ed.getPosition()
    if (!pos) return
    ed.executeEdits('ai-insert', [{
      range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
      text: code,
      forceMoveMarkers: true
    }])
    ed.focus()
  }

  const replaceSelection = (code: string) => {
    const ed = editorRef.current
    if (!ed) return
    const selection = ed.getSelection()
    if (!selection) return
    ed.executeEdits('ai-replace', [{
      range: selection,
      text: code,
      forceMoveMarkers: true
    }])
    ed.focus()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-background relative">
        <button onClick={onClose} className="absolute top-4 right-4 p-2 hover:bg-accent rounded" title="关闭"><X className="w-5 h-5" /></button>
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-muted-foreground">加载中...</span>
        </div>
      </div>
    )
  }

  if (isBinaryMode) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-background relative">
        <button onClick={onClose} className="absolute top-4 right-4 p-2 hover:bg-accent rounded transition-colors" title="关闭">
          <X className="w-5 h-5" />
        </button>
        <FileText className="w-16 h-16 text-primary mb-4 opacity-80" />
        <h3 className="text-lg font-medium mb-2">{fileName}</h3>
        <p className="text-sm text-muted-foreground mb-6 max-w-md text-center leading-relaxed">
          这是一个非文本文件，已启用<span className="text-primary font-medium">【本地应用唤醒】</span>功能。<br />
          您在 Word / Excel 等应用中每点击一次保存，程序都会自动为您同步到服务器。
        </p>
        <div className="flex items-center gap-2 px-4 py-2 bg-secondary/30 text-secondary-foreground rounded-lg max-w-lg border border-border">
          {binarySyncStatus.includes('失败') ? (
            <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
          ) : binarySyncStatus.includes('后台静默监视') ? (
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
          ) : (
            <RefreshCw className="w-4 h-4 animate-spin text-primary shrink-0" />
          )}
          <span className="text-sm">{binarySyncStatus}</span>
        </div>
        <div className="mt-8 text-xs text-muted-foreground opacity-60">
          关闭此标签页将停止同步。
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex h-full bg-background"
      onKeyDown={(e) => {
        // Escape closes editor when AI sidebar is not absorbing it
        if (e.key === 'Escape' && !showAI) onClose()
        // Ctrl+K from anywhere (including AI sidebar inputs) toggles AI
        if (e.ctrlKey && e.key === 'k') { e.preventDefault(); setShowAI((p) => !p) }
      }}
    >
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
              onClick={handleOpenFind}
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

        {/* Editor area */}
        <div className="flex-1 overflow-hidden">
          <MonacoEditorWrapper
            value={content}
            language={language}
            onChange={handleEditorChange}
            onSave={() => saveRef.current()}
            onCursorChange={(line, col) => setCursorPos({ line, col })}
            onEditorReady={handleEditorReady}
          />
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
                        <pre className="px-3 py-2 text-xs font-mono bg-[#0d1117] text-[#c9d1d9] overflow-x-auto" style={{ userSelect: 'text' }}>{code}</pre>
                      </div>
                    )
                  }
                  return <span key={i} className="whitespace-pre-wrap" style={{ userSelect: 'text' }}>{part}</span>
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
