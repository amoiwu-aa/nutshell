import { useState, useCallback, useRef } from 'react'
import {
  Search, Replace, ChevronDown, ChevronRight, File, Loader2,
  ToggleLeft, ToggleRight, ArrowDownUp, X, Check
} from 'lucide-react'
import { cn } from '../../lib/utils'

interface SearchResult {
  file: string
  line: number
  content: string
}

interface GroupedResult {
  file: string
  matches: Array<{ line: number; content: string }>
}

interface SearchPanelProps {
  sessionId: string
  rootPath: string
  onOpenFile: (path: string, line?: number) => void
}

export function SearchPanel({ sessionId, rootPath, onOpenFile }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [results, setResults] = useState<GroupedResult[]>([])
  const [loading, setLoading] = useState(false)
  const [totalMatches, setTotalMatches] = useState(0)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [replacing, setReplacing] = useState<string | null>(null)
  const queryRef = useRef<HTMLInputElement>(null)

  const handleSearch = useCallback(async () => {
    if (!query.trim()) { setResults([]); setTotalMatches(0); return }
    setLoading(true)
    try {
      // Build grep flags
      let flags = '-rn --include="*" -I'
      if (!caseSensitive) flags += ' -i'
      if (useRegex) flags += ' -E'

      const safeRoot = rootPath.replace(/"/g, '\\"')
      const safeQuery = query.replace(/"/g, '\\"').replace(/[`$]/g, '\\$&')

      const r = await window.api.workspace.agentRunCommand(
        sessionId, rootPath,
        `grep ${flags} "${safeQuery}" "${safeRoot}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=__pycache__ 2>/dev/null | head -300`
      )
      const output = r?.output || ''

      const rawResults: SearchResult[] = output.trim().split('\n').filter(Boolean).map((line: string) => {
        const match = line.match(/^(.+?):(\d+):(.*)$/)
        if (!match) return null
        return { file: match[1], line: parseInt(match[2]), content: match[3].trim() }
      }).filter(Boolean) as SearchResult[]

      // Group by file
      const groups = new Map<string, GroupedResult>()
      for (const sr of rawResults) {
        if (!groups.has(sr.file)) groups.set(sr.file, { file: sr.file, matches: [] })
        groups.get(sr.file)!.matches.push({ line: sr.line, content: sr.content })
      }

      const grouped = Array.from(groups.values())
      setResults(grouped)
      setTotalMatches(rawResults.length)
      // Expand all by default
      setExpandedFiles(new Set(grouped.map((g) => g.file)))
    } catch (err) {
      setResults([])
      setTotalMatches(0)
    }
    setLoading(false)
  }, [query, caseSensitive, useRegex, sessionId, rootPath])

  const handleReplaceInFile = useCallback(async (filePath: string) => {
    if (!query.trim() || !replaceText) return
    setReplacing(filePath)
    try {
      // Read file, replace, write back
      const readResult = await window.api.workspace.agentReadFile(sessionId, filePath)
      const content = readResult?.content || ''
      if (content) {
        let newContent: string
        if (useRegex) {
          const regex = new RegExp(query, caseSensitive ? 'g' : 'gi')
          newContent = content.replace(regex, replaceText)
        } else {
          if (caseSensitive) {
            newContent = content.split(query).join(replaceText)
          } else {
            const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
            newContent = content.replace(regex, replaceText)
          }
        }
        await window.api.workspace.agentWriteFile(sessionId, filePath, newContent)
        // Re-search after replace
        handleSearch()
      }
    } catch {}
    setReplacing(null)
  }, [query, replaceText, caseSensitive, useRegex, sessionId, handleSearch])

  const handleReplaceAll = useCallback(async () => {
    for (const group of results) {
      await handleReplaceInFile(group.file)
    }
  }, [results, handleReplaceInFile])

  const toggleExpanded = (file: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file); else next.add(file)
      return next
    })
  }

  // Highlight matches in content
  const highlightMatch = (content: string) => {
    if (!query.trim()) return content
    try {
      const regex = useRegex
        ? new RegExp(`(${query})`, caseSensitive ? 'g' : 'gi')
        : new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, caseSensitive ? 'g' : 'gi')
      const parts = content.split(regex)
      return parts.map((part, i) =>
        regex.test(part)
          ? <span key={i} className="bg-[#d29922] text-[#0d1117] rounded px-0.5">{part}</span>
          : <span key={i}>{part}</span>
      )
    } catch {
      return content
    }
  }

  const relPath = (p: string) => p.startsWith(rootPath) ? p.substring(rootPath.length).replace(/^\//, '') : p

  return (
    <div className="flex flex-col h-full text-xs">
      {/* Search input */}
      <div className="px-2 py-2 border-b border-[#21262d] space-y-1.5 shrink-0">
        <div className="flex items-center gap-1">
          <button onClick={() => setShowReplace(!showReplace)}
            className="p-0.5 hover:bg-[#21262d] rounded shrink-0">
            {showReplace ? <ChevronDown className="w-3.5 h-3.5 text-[#8b949e]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#8b949e]" />}
          </button>
          <div className="flex-1 flex items-center bg-[#0d1117] border border-[#30363d] rounded overflow-hidden focus-within:border-[#58a6ff]">
            <input
              ref={queryRef}
              type="text" value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder="搜索..."
              className="flex-1 px-2 py-1 bg-transparent outline-none text-xs text-[#c9d1d9] placeholder-[#484f58]"
            />
            <button onClick={() => setCaseSensitive(!caseSensitive)}
              className={cn('px-1 py-0.5 mx-0.5 rounded text-[10px] font-bold', caseSensitive ? 'bg-[#1f6feb33] text-[#58a6ff]' : 'text-[#484f58] hover:text-[#8b949e]')}
              title="区分大小写">Aa</button>
            <button onClick={() => setUseRegex(!useRegex)}
              className={cn('px-1 py-0.5 mr-1 rounded text-[10px] font-bold', useRegex ? 'bg-[#1f6feb33] text-[#58a6ff]' : 'text-[#484f58] hover:text-[#8b949e]')}
              title="正则表达式">.*</button>
          </div>
        </div>

        {/* Replace input */}
        {showReplace && (
          <div className="flex items-center gap-1 pl-5">
            <div className="flex-1 flex items-center bg-[#0d1117] border border-[#30363d] rounded overflow-hidden focus-within:border-[#58a6ff]">
              <input
                type="text" value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                placeholder="替换..."
                className="flex-1 px-2 py-1 bg-transparent outline-none text-xs text-[#c9d1d9] placeholder-[#484f58]"
              />
            </div>
            <button onClick={handleReplaceAll} disabled={results.length === 0 || !replaceText}
              className="px-1.5 py-1 bg-[#21262d] hover:bg-[#30363d] rounded text-[#c9d1d9] disabled:opacity-30"
              title="全部替换">
              <ArrowDownUp className="w-3 h-3" />
            </button>
          </div>
        )}

        {/* Results info */}
        {totalMatches > 0 && (
          <div className="text-[#8b949e] pl-5">
            {totalMatches} 个结果，{results.length} 个文件
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-[#8b949e]" />
            <span className="ml-2 text-[#8b949e]">搜索中...</span>
          </div>
        )}
        {!loading && results.length === 0 && query && (
          <div className="text-center py-6 text-[#484f58]">无结果</div>
        )}
        {results.map((group) => (
          <div key={group.file}>
            {/* File header */}
            <div className="flex items-center gap-1 px-2 py-1 hover:bg-[#161b22] cursor-pointer sticky top-0 bg-[#0d1117] z-10"
              onClick={() => toggleExpanded(group.file)}>
              {expandedFiles.has(group.file)
                ? <ChevronDown className="w-3 h-3 text-[#8b949e] shrink-0" />
                : <ChevronRight className="w-3 h-3 text-[#8b949e] shrink-0" />}
              <File className="w-3 h-3 text-[#8b949e] shrink-0" />
              <span className="truncate text-[#c9d1d9]">{relPath(group.file)}</span>
              <span className="ml-auto text-[#484f58] shrink-0 bg-[#21262d] rounded-full px-1.5">{group.matches.length}</span>
              {showReplace && replaceText && (
                <button onClick={(e) => { e.stopPropagation(); handleReplaceInFile(group.file) }}
                  disabled={replacing === group.file}
                  className="p-0.5 hover:bg-[#30363d] rounded shrink-0" title="替换此文件">
                  {replacing === group.file
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Check className="w-3 h-3 text-[#3fb950]" />}
                </button>
              )}
            </div>
            {/* Match lines */}
            {expandedFiles.has(group.file) && group.matches.map((m, i) => (
              <div key={i}
                onClick={() => onOpenFile(group.file, m.line)}
                className="flex items-start gap-2 px-2 pl-7 py-0.5 hover:bg-[#161b22] cursor-pointer">
                <span className="text-[#484f58] shrink-0 w-8 text-right">{m.line}</span>
                <span className="text-[#8b949e] truncate font-mono" style={{ userSelect: 'text' }}>
                  {highlightMatch(m.content)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
