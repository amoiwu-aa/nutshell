import { useRef, useEffect, useState } from 'react'
import { monaco } from '../../lib/monacoSetup'

// Use VS Code's built-in dark theme - just override background to match our panel
const SUPERSHELL_THEME: monaco.editor.IStandaloneThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#1e1e1e',
  }
}

// Language mapping from file extension to Monaco language ID
const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  py: 'python', go: 'go', rs: 'rust', java: 'java',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  json: 'json', jsonc: 'json',
  yml: 'yaml', yaml: 'yaml',
  xml: 'xml', html: 'html', htm: 'html', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  md: 'markdown', markdown: 'markdown',
  sql: 'sql',
  dockerfile: 'dockerfile',
  ini: 'ini', toml: 'ini', conf: 'ini',
  php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  r: 'r',
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  graphql: 'graphql', gql: 'graphql',
  proto: 'protobuf',
  makefile: 'shell',
}

export function detectMonacoLang(filename: string): string {
  const name = filename.toLowerCase()
  if (name === 'makefile' || name === 'gnumakefile') return 'shell'
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === '.gitignore' || name === '.dockerignore') return 'plaintext'
  if (name === '.env' || name.startsWith('.env.')) return 'shell'
  const ext = name.split('.').pop() || ''
  return LANG_MAP[ext] || 'plaintext'
}

// Register theme once
let themeRegistered = false
function ensureTheme() {
  if (!themeRegistered) {
    monaco.editor.defineTheme('supershell-dark', SUPERSHELL_THEME)
    themeRegistered = true
  }
}

interface MonacoEditorWrapperProps {
  value: string
  language: string
  readOnly?: boolean
  onChange?: (value: string) => void
  onSave?: () => void
  onCursorChange?: (line: number, col: number) => void
  onEditorReady?: (editor: monaco.editor.IStandaloneCodeEditor) => void
}

export function MonacoEditorWrapper({
  value, language, readOnly = false, onChange, onSave, onCursorChange, onEditorReady
}: MonacoEditorWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const valueRef = useRef(value)
  const [ready, setReady] = useState(false)

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return
    ensureTheme()

    const editor = monaco.editor.create(containerRef.current, {
      value,
      language,
      theme: 'supershell-dark',
      readOnly,
      automaticLayout: true,
      minimap: { enabled: true, scale: 1, showSlider: 'mouseover' },
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
      fontLigatures: true,
      lineNumbers: 'on',
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      tabSize: 2,
      insertSpaces: true,
      folding: true,
      foldingStrategy: 'indentation',
      showFoldingControls: 'mouseover',
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      smoothScrolling: true,
      padding: { top: 8, bottom: 8 },
      suggest: {
        showMethods: true,
        showFunctions: true,
        showConstructors: true,
        showFields: true,
        showVariables: true,
        showClasses: true,
        showStructs: true,
        showInterfaces: true,
        showModules: true,
        showProperties: true,
        showEvents: true,
        showOperators: true,
        showUnits: true,
        showValues: true,
        showConstants: true,
        showEnums: true,
        showEnumMembers: true,
        showKeywords: true,
        showWords: true,
        showColors: true,
        showFiles: true,
        showReferences: true,
        showFolders: true,
        showTypeParameters: true,
        showSnippets: true,
        preview: true,
        detailsVisible: true,
      },
      quickSuggestions: { other: true, comments: false, strings: true },
      parameterHints: { enabled: true },
      hover: { enabled: true, delay: 300 },
      links: true,
      colorDecorators: true,
      renderWhitespace: 'selection',
      matchBrackets: 'always',
      occurrencesHighlight: 'singleFile',
      stickyScroll: { enabled: true },
      inlayHints: { enabled: 'on' },
      unicodeHighlight: { ambiguousCharacters: false },
      overviewRulerLanes: 3,
    })

    editorRef.current = editor
    valueRef.current = value

    // Content change
    const contentDisposable = editor.onDidChangeModelContent(() => {
      const newVal = editor.getValue()
      valueRef.current = newVal
      onChange?.(newVal)
    })

    // Cursor position
    const cursorDisposable = editor.onDidChangeCursorPosition((e) => {
      onCursorChange?.(e.position.lineNumber, e.position.column)
    })

    // Ctrl+S to save
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      onSave?.()
    })

    onEditorReady?.(editor)
    setReady(true)

    return () => {
      contentDisposable.dispose()
      cursorDisposable.dispose()
      editor.dispose()
      editorRef.current = null
    }
  }, []) // Only mount once

  // Update value from external
  useEffect(() => {
    if (!editorRef.current) return
    if (value !== valueRef.current) {
      const editor = editorRef.current
      const pos = editor.getPosition()
      editor.setValue(value)
      if (pos) editor.setPosition(pos)
      valueRef.current = value
    }
  }, [value])

  // Update language
  useEffect(() => {
    if (!editorRef.current) return
    const model = editorRef.current.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, language)
    }
  }, [language])

  // Update readOnly
  useEffect(() => {
    if (!editorRef.current) return
    editorRef.current.updateOptions({ readOnly })
  }, [readOnly])

  return (
    <div ref={containerRef} className="w-full h-full" style={{ minHeight: 0 }} />
  )
}

// ===== Diff Editor =====
interface MonacoDiffEditorProps {
  original: string
  modified: string
  language: string
  renderSideBySide?: boolean
}

export function MonacoDiffEditorWrapper({ original, modified, language, renderSideBySide = true }: MonacoDiffEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    ensureTheme()

    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: 'supershell-dark',
      readOnly: true,
      automaticLayout: true,
      renderSideBySide,
      minimap: { enabled: false },
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace",
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      originalEditable: false,
    })

    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)

    diffEditor.setModel({ original: originalModel, modified: modifiedModel })
    editorRef.current = diffEditor

    return () => {
      diffEditor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      editorRef.current = null
    }
  }, [])

  // Update content
  useEffect(() => {
    if (!editorRef.current) return
    const model = editorRef.current.getModel()
    if (model) {
      model.original.setValue(original)
      model.modified.setValue(modified)
    }
  }, [original, modified])

  return (
    <div ref={containerRef} className="w-full h-full" style={{ minHeight: 0 }} />
  )
}

// Export Monaco for LSP bridge usage
export { monaco }
