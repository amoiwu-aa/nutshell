import { useState, useEffect, useCallback, useMemo } from 'react'
import { AlertCircle, AlertTriangle, Info, ChevronDown, ChevronRight, File, RefreshCw } from 'lucide-react'
import { cn } from '../../lib/utils'
import { monaco } from '../../lib/monacoSetup'

export interface Diagnostic {
  file: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  message: string
  severity: 'error' | 'warning' | 'info' | 'hint'
  source: string  // 'monaco' | 'lsp' | 'lint'
}

interface ProblemsPanelProps {
  diagnostics: Diagnostic[]
  onOpenFile: (path: string, line?: number) => void
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2, hint: 3 }

function SeverityIcon({ severity }: { severity: Diagnostic['severity'] }) {
  switch (severity) {
    case 'error': return <AlertCircle className="w-3.5 h-3.5 text-[#f85149] shrink-0" />
    case 'warning': return <AlertTriangle className="w-3.5 h-3.5 text-[#d29922] shrink-0" />
    case 'info': return <Info className="w-3.5 h-3.5 text-[#58a6ff] shrink-0" />
    default: return <Info className="w-3.5 h-3.5 text-[#484f58] shrink-0" />
  }
}

export function ProblemsPanel({ diagnostics, onOpenFile }: ProblemsPanelProps) {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all')

  // Group and filter diagnostics
  const { grouped, counts } = useMemo(() => {
    const filtered = filter === 'all'
      ? diagnostics
      : diagnostics.filter((d) => d.severity === filter)

    // Sort by severity then line
    const sorted = [...filtered].sort((a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.line - b.line
    )

    const groups = new Map<string, Diagnostic[]>()
    for (const d of sorted) {
      if (!groups.has(d.file)) groups.set(d.file, [])
      groups.get(d.file)!.push(d)
    }

    return {
      grouped: Array.from(groups.entries()),
      counts: {
        error: diagnostics.filter((d) => d.severity === 'error').length,
        warning: diagnostics.filter((d) => d.severity === 'warning').length,
        info: diagnostics.filter((d) => d.severity === 'info' || d.severity === 'hint').length,
      }
    }
  }, [diagnostics, filter])

  // Auto-expand all
  useEffect(() => {
    setExpandedFiles(new Set(grouped.map(([f]) => f)))
  }, [grouped])

  const toggleFile = (file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file); else next.add(file)
      return next
    })
  }

  const relPath = (p: string) => {
    const parts = p.split('/')
    return parts.length > 2 ? parts.slice(-2).join('/') : p
  }

  return (
    <div className="flex flex-col h-full text-xs">
      {/* Filter bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[#21262d] shrink-0">
        <button onClick={() => setFilter('all')}
          className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded', filter === 'all' ? 'bg-[#21262d] text-[#c9d1d9]' : 'text-[#8b949e] hover:text-[#c9d1d9]')}>
          全部 <span className="bg-[#30363d] rounded px-1">{diagnostics.length}</span>
        </button>
        <button onClick={() => setFilter('error')}
          className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded', filter === 'error' ? 'bg-[#21262d] text-[#f85149]' : 'text-[#8b949e] hover:text-[#c9d1d9]')}>
          <AlertCircle className="w-3 h-3" /> {counts.error}
        </button>
        <button onClick={() => setFilter('warning')}
          className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded', filter === 'warning' ? 'bg-[#21262d] text-[#d29922]' : 'text-[#8b949e] hover:text-[#c9d1d9]')}>
          <AlertTriangle className="w-3 h-3" /> {counts.warning}
        </button>
      </div>

      {/* Problem list */}
      <div className="flex-1 overflow-y-auto">
        {grouped.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-[#484f58]">
            <AlertCircle className="w-6 h-6 mb-2 opacity-30" />
            <span>无问题</span>
          </div>
        )}
        {grouped.map(([file, diags]) => (
          <div key={file}>
            <div onClick={() => toggleFile(file)}
              className="flex items-center gap-1.5 px-2 py-1 hover:bg-[#161b22] cursor-pointer sticky top-0 bg-[#0d1117] z-10">
              {expandedFiles.has(file)
                ? <ChevronDown className="w-3 h-3 text-[#8b949e] shrink-0" />
                : <ChevronRight className="w-3 h-3 text-[#8b949e] shrink-0" />}
              <File className="w-3 h-3 text-[#8b949e] shrink-0" />
              <span className="truncate text-[#c9d1d9]">{relPath(file)}</span>
              <span className="ml-auto text-[#484f58] shrink-0 bg-[#21262d] rounded-full px-1.5">{diags.length}</span>
            </div>
            {expandedFiles.has(file) && diags.map((d, i) => (
              <div key={i}
                onClick={() => onOpenFile(d.file, d.line)}
                className="flex items-start gap-2 px-2 pl-7 py-1 hover:bg-[#161b22] cursor-pointer">
                <SeverityIcon severity={d.severity} />
                <span className="flex-1 text-[#c9d1d9]" style={{ userSelect: 'text' }}>{d.message}</span>
                <span className="text-[#484f58] shrink-0">[{d.source}]</span>
                <span className="text-[#484f58] shrink-0">{d.line}:{d.column}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ===== Utility to extract Monaco markers as diagnostics =====
export function getMonacoDiagnostics(): Diagnostic[] {
  const markers = monaco.editor.getModelMarkers({})
  return markers.map((m) => ({
    file: m.resource.path || m.resource.toString(),
    line: m.startLineNumber,
    column: m.startColumn,
    endLine: m.endLineNumber,
    endColumn: m.endColumn,
    message: m.message,
    severity: m.severity === 8 ? 'error' : m.severity === 4 ? 'warning' : m.severity === 2 ? 'info' : 'hint',
    source: m.source || 'monaco'
  }))
}
