import { useState, useEffect, useCallback } from 'react'
import { GitCompare, Columns, AlignJustify, Loader2, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { MonacoDiffEditorWrapper, detectMonacoLang } from './MonacoEditorWrapper'

interface DiffViewProps {
  sessionId: string
  rootPath: string
  filePath: string
  currentContent: string
  onClose: () => void
}

export function DiffView({ sessionId, rootPath, filePath, currentContent, onClose }: DiffViewProps) {
  const [originalContent, setOriginalContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sideBySide, setSideBySide] = useState(true)

  const language = detectMonacoLang(filePath.split('/').pop() || '')
  const fileName = filePath.split('/').pop() || filePath

  // Fetch original (HEAD) version via git show
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')

    const fetchOriginal = async () => {
      try {
        // Get the file content at HEAD
        const relPath = filePath.startsWith(rootPath)
          ? filePath.substring(rootPath.length).replace(/^\//, '')
          : filePath
        const safeRoot = rootPath.replace(/"/g, '\\"')
        const safeFile = relPath.replace(/"/g, '\\"')
        const result = await window.api.workspace.agentRunCommand(
          sessionId, rootPath,
          `cd "${safeRoot}" && git show "HEAD:${safeFile}" 2>/dev/null`
        )
        if (!cancelled) {
          setOriginalContent(result?.output || '')
          setLoading(false)
        }
      } catch (err: any) {
        if (!cancelled) {
          setError('无法获取 Git 历史版本: ' + (err.message || ''))
          setOriginalContent('')
          setLoading(false)
        }
      }
    }

    fetchOriginal()
    return () => { cancelled = true }
  }, [sessionId, rootPath, filePath])

  return (
    <div className="flex flex-col h-full bg-[#0d1117]">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#010409] border-b border-[#21262d] shrink-0">
        <div className="flex items-center gap-2">
          <GitCompare className="w-3.5 h-3.5 text-[#d29922]" />
          <span className="text-xs text-[#c9d1d9]">{fileName}</span>
          <span className="text-xs text-[#484f58]">HEAD ↔ 工作区</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setSideBySide(true)}
            className={cn('p-1 rounded', sideBySide ? 'bg-[#1f6feb33] text-[#58a6ff]' : 'text-[#8b949e] hover:text-[#c9d1d9]')}
            title="并排对比">
            <Columns className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setSideBySide(false)}
            className={cn('p-1 rounded', !sideBySide ? 'bg-[#1f6feb33] text-[#58a6ff]' : 'text-[#8b949e] hover:text-[#c9d1d9]')}
            title="内联对比">
            <AlignJustify className="w-3.5 h-3.5" />
          </button>
          <button onClick={onClose} className="p-1 rounded text-[#8b949e] hover:text-[#c9d1d9] hover:bg-[#21262d]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Diff content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-[#8b949e]" />
          <span className="ml-2 text-xs text-[#8b949e]">加载对比...</span>
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-xs text-[#f85149]">{error}</div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <MonacoDiffEditorWrapper
            original={originalContent}
            modified={currentContent}
            language={language}
            renderSideBySide={sideBySide}
          />
        </div>
      )}
    </div>
  )
}
