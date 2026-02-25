import { useState, useEffect, useCallback, useMemo } from 'react'
import { ChevronRight, Hash, Box, Braces, Variable, Type, FileCode, List } from 'lucide-react'
import { cn } from '../../lib/utils'
import type * as monacoType from 'monaco-editor'

interface SymbolNode {
  name: string
  kind: monacoType.languages.SymbolKind
  range: { startLine: number; endLine: number }
  children: SymbolNode[]
}

interface BreadcrumbsProps {
  filePath: string | null
  rootPath: string
  editor: monacoType.editor.IStandaloneCodeEditor | null
}

// Map SymbolKind to icon
function SymbolIcon({ kind }: { kind: monacoType.languages.SymbolKind }) {
  // Using numeric values as they are stable across Monaco versions
  switch (kind) {
    case 5:  // Function
    case 6:  // Method
    case 9:  // Constructor
      return <Braces className="w-3 h-3 text-purple-400 shrink-0" />
    case 4:  // Class
    case 10: // Enum
    case 22: // Struct
      return <Box className="w-3 h-3 text-orange-400 shrink-0" />
    case 11: // Interface
      return <Type className="w-3 h-3 text-cyan-400 shrink-0" />
    case 12: // Variable
    case 13: // Constant
    case 7:  // Property
    case 8:  // Field
      return <Variable className="w-3 h-3 text-blue-400 shrink-0" />
    default:
      return <Hash className="w-3 h-3 text-muted-foreground shrink-0" />
  }
}

export function Breadcrumbs({ filePath, rootPath, editor }: BreadcrumbsProps) {
  const [symbols, setSymbols] = useState<SymbolNode[]>([])
  const [currentSymbol, setCurrentSymbol] = useState<string>('')
  const [showDropdown, setShowDropdown] = useState<number | null>(null)

  // Parse file path into segments
  const pathSegments = useMemo(() => {
    if (!filePath) return []
    const relative = filePath.startsWith(rootPath)
      ? filePath.substring(rootPath.length).replace(/^\//, '')
      : filePath
    return relative.split('/').filter(Boolean)
  }, [filePath, rootPath])

  // Get symbols from Monaco model
  useEffect(() => {
    if (!editor) { setSymbols([]); return }
    const model = editor.getModel()
    if (!model) { setSymbols([]); return }

    // Simple symbol extraction from text content
    const extractSymbols = (): SymbolNode[] => {
      const text = model.getValue()
      const lines = text.split('\n')
      const found: SymbolNode[] = []

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Function/method patterns
        let match = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|def|func)\s+(\w+)/i)
        if (match) { found.push({ name: match[1], kind: 5, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        // Arrow functions / const fn
        match = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/)
        if (match) { found.push({ name: match[1], kind: 5, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        // Class
        match = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/)
        if (match) { found.push({ name: match[1], kind: 4, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        // Interface / type
        match = line.match(/^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/)
        if (match) { found.push({ name: match[1], kind: 11, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        // Struct (Go/Rust)
        match = line.match(/^\s*(?:pub\s+)?(?:type\s+(\w+)\s+struct|struct\s+(\w+))/)
        if (match) { found.push({ name: match[1] || match[2], kind: 22, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        // Python class
        match = line.match(/^class\s+(\w+)/)
        if (match) { found.push({ name: match[1], kind: 4, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
      }
      return found
    }

    setSymbols(extractSymbols())
    const disposable = model.onDidChangeContent(() => setSymbols(extractSymbols()))
    return () => disposable.dispose()
  }, [editor])

  // Track current cursor position to highlight active symbol
  useEffect(() => {
    if (!editor) return
    const disposable = editor.onDidChangeCursorPosition((e) => {
      const line = e.position.lineNumber
      let active = ''
      for (const s of symbols) {
        if (s.range.startLine <= line) active = s.name
      }
      setCurrentSymbol(active)
    })
    return () => disposable.dispose()
  }, [editor, symbols])

  const goToSymbol = useCallback((line: number) => {
    if (!editor) return
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
    setShowDropdown(null)
  }, [editor])

  if (!filePath) return null

  return (
    <div className="flex items-center h-[22px] px-3 text-[12px] overflow-x-auto shrink-0 select-none"
      style={{ background: '#252526', borderBottom: '1px solid #3c3c3c', color: '#969696', scrollbarWidth: 'none' }}>
      <span className="hover:text-[#cccccc] cursor-pointer shrink-0">
        {rootPath.split('/').pop() || rootPath}
      </span>

      {pathSegments.map((seg, i) => (
        <span key={i} className="flex items-center shrink-0">
          <ChevronRight className="w-3 h-3 mx-0.5 opacity-50" />
          <span className={cn('hover:text-[#cccccc] cursor-pointer', i === pathSegments.length - 1 && 'text-[#cccccc]')}>{seg}</span>
        </span>
      ))}

      {currentSymbol && (
        <span className="flex items-center shrink-0 relative">
          <ChevronRight className="w-3 h-3 mx-0.5 opacity-50" />
          <button onClick={() => setShowDropdown(showDropdown === -1 ? null : -1)}
            className="flex items-center gap-1 hover:text-[#cccccc]" style={{ color: '#d4b37b' }}>
            <Braces className="w-3 h-3" />
            {currentSymbol}
          </button>
          {showDropdown === -1 && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(null)} />
              <div className="absolute left-0 top-full mt-1 z-50 rounded shadow-xl py-1 min-w-[220px] max-h-[300px] overflow-y-auto"
                style={{ background: '#252526', border: '1px solid #3c3c3c' }}>
                {symbols.map((s, i) => (
                  <button key={i} onClick={() => goToSymbol(s.range.startLine)}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-[13px] hover:bg-[#094771] transition-colors"
                    style={{ color: s.name === currentSymbol ? '#ffffff' : '#cccccc' }}>
                    <SymbolIcon kind={s.kind} />
                    <span className="truncate">{s.name}</span>
                    <span className="ml-auto shrink-0" style={{ color: '#6e7681' }}>:{s.range.startLine}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </span>
      )}
    </div>
  )
}

// ===== Symbol Outline Panel for sidebar =====
interface OutlinePanelProps {
  editor: monacoType.editor.IStandaloneCodeEditor | null
}

export function OutlinePanel({ editor }: OutlinePanelProps) {
  const [symbols, setSymbols] = useState<SymbolNode[]>([])
  const [currentLine, setCurrentLine] = useState(0)

  useEffect(() => {
    if (!editor) { setSymbols([]); return }
    const model = editor.getModel()
    if (!model) { setSymbols([]); return }

    const extract = (): SymbolNode[] => {
      const text = model.getValue()
      const lines = text.split('\n')
      const found: SymbolNode[] = []
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        let match = line.match(/^\s*(?:export\s+)?(?:async\s+)?(?:function|def|func)\s+(\w+)/i)
        if (match) { found.push({ name: match[1], kind: 5, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        match = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/)
        if (match) { found.push({ name: match[1], kind: 5, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        match = line.match(/^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/)
        if (match) { found.push({ name: match[1], kind: 4, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        match = line.match(/^\s*(?:export\s+)?(?:interface|type)\s+(\w+)/)
        if (match) { found.push({ name: match[1], kind: 11, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
        match = line.match(/^class\s+(\w+)/)
        if (match) { found.push({ name: match[1], kind: 4, range: { startLine: i + 1, endLine: i + 1 }, children: [] }); continue }
      }
      return found
    }
    setSymbols(extract())
    const d = model.onDidChangeContent(() => setSymbols(extract()))
    return () => d.dispose()
  }, [editor])

  useEffect(() => {
    if (!editor) return
    const d = editor.onDidChangeCursorPosition((e) => setCurrentLine(e.position.lineNumber))
    return () => d.dispose()
  }, [editor])

  const goTo = useCallback((line: number) => {
    if (!editor) return
    editor.revealLineInCenter(line)
    editor.setPosition({ lineNumber: line, column: 1 })
    editor.focus()
  }, [editor])

  if (symbols.length === 0) {
    return <div className="p-3 text-xs text-[#484f58] text-center">无符号</div>
  }

  return (
    <div className="py-1">
      {symbols.map((s, i) => {
        const isActive = (() => {
          const next = symbols[i + 1]
          return currentLine >= s.range.startLine && (!next || currentLine < next.range.startLine)
        })()
        return (
          <button key={i} onClick={() => goTo(s.range.startLine)}
            className={cn(
              'flex items-center gap-2 w-full px-3 py-1 text-xs hover:bg-[#1f6feb22] transition-colors',
              isActive && 'bg-[#1f6feb22] text-[#c9d1d9] border-l-2 border-[#58a6ff]'
            )}>
            <SymbolIcon kind={s.kind} />
            <span className="truncate">{s.name}</span>
            <span className="ml-auto text-[#484f58] shrink-0">{s.range.startLine}</span>
          </button>
        )
      })}
    </div>
  )
}
