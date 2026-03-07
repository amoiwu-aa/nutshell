import { useState, useEffect } from 'react'
import {
  X,
  Plus,
  Play,
  Edit,
  Trash2,
  Code2,
  FolderOpen,
  Search,
  Copy,
  Download,
  Upload,
  Variable
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { v4 as uuidv4 } from 'uuid'

export interface Snippet {
  id: string
  name: string
  command: string
  description?: string
  category?: string
  variables?: { name: string; defaultValue: string }[]
}

interface SnippetManagerProps {
  isOpen: boolean
  onClose: () => void
  onExecute: (command: string) => void
}

export function SnippetManager({ isOpen, onClose, onExecute }: SnippetManagerProps) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null)
  const [editingSnippet, setEditingSnippet] = useState<Snippet | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [variableValues, setVariableValues] = useState<Record<string, string>>({})
  const [showVariableDialog, setShowVariableDialog] = useState<Snippet | null>(null)

  useEffect(() => {
    if (isOpen) loadSnippets()
  }, [isOpen])

  const loadSnippets = async () => {
    const result = await window.api.config.getSnippets()
    if (result.success) {
      setSnippets(result.snippets)
    }
  }

  const handleSave = async (snippet: Snippet) => {
    await window.api.config.saveSnippet(snippet)
    await loadSnippets()
    window.dispatchEvent(new CustomEvent('snippets:changed'))
    setShowEditor(false)
    setEditingSnippet(null)
  }

  const handleDelete = async (id: string) => {
    if (confirm('确定要删除此命令片段吗？')) {
      await window.api.config.deleteSnippet(id)
      await loadSnippets()
      window.dispatchEvent(new CustomEvent('snippets:changed'))
    }
  }

  const handleExecute = (snippet: Snippet) => {
    if (snippet.variables && snippet.variables.length > 0) {
      // Show variable input dialog
      const defaults: Record<string, string> = {}
      snippet.variables.forEach((v) => {
        defaults[v.name] = v.defaultValue
      })
      setVariableValues(defaults)
      setShowVariableDialog(snippet)
    } else {
      onExecute(snippet.command + '\n')
    }
  }

  const handleExecuteWithVariables = () => {
    if (!showVariableDialog) return

    let command = showVariableDialog.command
    for (const [name, value] of Object.entries(variableValues)) {
      command = command.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), value)
    }
    onExecute(command + '\n')
    setShowVariableDialog(null)
  }

  const handleExport = () => {
    const data = JSON.stringify(snippets, null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nutshell-snippets.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImport = async () => {
    const result = await window.api.config.selectFile({
      filters: [{ name: 'JSON Files', extensions: ['json'] }]
    })
    if (result.success && !result.canceled && result.filePaths?.length > 0) {
      try {
        const response = await fetch(`file://${result.filePaths[0]}`)
        const text = await response.text()
        const imported = JSON.parse(text)
        if (Array.isArray(imported)) {
          const mode = confirm('是否合并到现有片段？\n\n确定 = 合并\n取消 = 替换全部') ? 'merge' : 'replace'
          await window.api.config.importSnippets(imported, mode as 'merge' | 'replace')
          await loadSnippets()
          window.dispatchEvent(new CustomEvent('snippets:changed'))
        }
      } catch {
        // Import failed silently
      }
    }
  }

  const categories = [...new Set(snippets.map((s) => s.category || '未分类'))]

  const filteredSnippets = snippets.filter((s) => {
    const matchesSearch =
      !searchQuery ||
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.command.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesCategory =
      !selectedCategory || (s.category || '未分类') === selectedCategory
    return matchesSearch && matchesCategory
  })

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[700px] max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Code2 className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">命令片段管理</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleImport}
              className="p-1.5 hover:bg-accent rounded-md transition-colors"
              title="导入"
            >
              <Upload className="w-4 h-4" />
            </button>
            <button
              onClick={handleExport}
              className="p-1.5 hover:bg-accent rounded-md transition-colors"
              title="导出"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={() => {
                setEditingSnippet({
                  id: uuidv4(),
                  name: '',
                  command: '',
                  description: '',
                  category: '未分类',
                  variables: []
                })
                setShowEditor(true)
              }}
              className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary/90 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              新建
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-accent rounded-md transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Search & Categories */}
        <div className="px-5 py-3 border-b border-border space-y-2">
          <div className="flex items-center gap-2 px-2 py-1.5 bg-background rounded-md border border-input">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="搜索命令片段..."
              className="w-full bg-transparent text-sm outline-none"
            />
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => setSelectedCategory(null)}
              className={cn(
                'px-2 py-0.5 rounded text-xs transition-colors',
                !selectedCategory
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
              )}
            >
              全部
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setSelectedCategory(cat)}
                className={cn(
                  'px-2 py-0.5 rounded text-xs transition-colors',
                  selectedCategory === cat
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        {/* Snippet list */}
        <div className="overflow-y-auto max-h-[calc(80vh-200px)]">
          {filteredSnippets.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Code2 className="w-8 h-8 mb-2 opacity-50" />
              <p className="text-sm">暂无命令片段</p>
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {filteredSnippets.map((snippet) => (
                <div
                  key={snippet.id}
                  className="bg-background border border-border rounded-lg p-3 hover:border-primary/50 transition-colors"
                >
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="text-sm font-medium">{snippet.name}</h4>
                      {snippet.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {snippet.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {snippet.variables && snippet.variables.length > 0 && (
                        <span className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-xs">
                          <Variable className="w-3 h-3 inline" /> {snippet.variables.length} 变量
                        </span>
                      )}
                    </div>
                  </div>

                  <pre className="bg-card px-3 py-2 rounded text-xs font-mono text-muted-foreground overflow-x-auto mb-2">
                    {snippet.command}
                  </pre>

                  <div className="flex items-center justify-between">
                    <span className="px-1.5 py-0.5 bg-secondary text-secondary-foreground rounded text-xs">
                      {snippet.category || '未分类'}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleExecute(snippet)}
                        className="flex items-center gap-1 px-2 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 transition-colors"
                      >
                        <Play className="w-3 h-3" />
                        执行
                      </button>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(snippet.command)
                        }}
                        className="p-1 hover:bg-accent rounded transition-colors"
                        title="复制"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          setEditingSnippet(snippet)
                          setShowEditor(true)
                        }}
                        className="p-1 hover:bg-accent rounded transition-colors"
                        title="编辑"
                      >
                        <Edit className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(snippet.id)}
                        className="p-1 hover:bg-accent rounded transition-colors text-destructive"
                        title="删除"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Snippet editor dialog */}
      {showEditor && editingSnippet && (
        <SnippetEditor
          snippet={editingSnippet}
          onSave={handleSave}
          onClose={() => {
            setShowEditor(false)
            setEditingSnippet(null)
          }}
        />
      )}

      {/* Variable input dialog */}
      {showVariableDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setShowVariableDialog(null)}
          />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[400px] p-5">
            <h3 className="text-sm font-semibold mb-4">输入变量值</h3>
            <div className="space-y-3">
              {showVariableDialog.variables?.map((v) => (
                <div key={v.name}>
                  <label className="block text-xs font-medium mb-1">
                    ${'{'}
                    {v.name}
                    {'}'}
                  </label>
                  <input
                    type="text"
                    value={variableValues[v.name] || ''}
                    onChange={(e) =>
                      setVariableValues((prev) => ({ ...prev, [v.name]: e.target.value }))
                    }
                    className="w-full px-3 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setShowVariableDialog(null)}
                className="px-3 py-1.5 text-sm hover:bg-accent rounded-lg transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleExecuteWithVariables}
                className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
              >
                执行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SnippetEditor({
  snippet,
  onSave,
  onClose
}: {
  snippet: Snippet
  onSave: (snippet: Snippet) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<Snippet>(snippet)
  const [newVarName, setNewVarName] = useState('')
  const [newVarDefault, setNewVarDefault] = useState('')

  const addVariable = () => {
    if (!newVarName.trim()) return
    setForm((prev) => ({
      ...prev,
      variables: [
        ...(prev.variables || []),
        { name: newVarName.trim(), defaultValue: newVarDefault }
      ]
    }))
    setNewVarName('')
    setNewVarDefault('')
  }

  const removeVariable = (index: number) => {
    setForm((prev) => ({
      ...prev,
      variables: prev.variables?.filter((_, i) => i !== index) || []
    }))
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[500px] max-h-[80vh] overflow-auto p-5">
        <h3 className="text-lg font-semibold mb-4">
          {snippet.name ? '编辑命令片段' : '新建命令片段'}
        </h3>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">名称</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">命令</label>
            <textarea
              value={form.command}
              onChange={(e) => setForm((prev) => ({ ...prev, command: e.target.value }))}
              rows={4}
              className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring font-mono"
              placeholder='例如: docker restart ${container_name}'
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">描述</label>
            <input
              type="text"
              value={form.description || ''}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">分类</label>
            <input
              type="text"
              value={form.category || ''}
              onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
              placeholder="未分类"
              className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {/* Variables */}
          <div>
            <label className="block text-sm font-medium mb-1">变量模板</label>
            {form.variables && form.variables.length > 0 && (
              <div className="space-y-1 mb-2">
                {form.variables.map((v, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-2 py-1 bg-background rounded text-xs"
                  >
                    <span className="font-mono text-primary">${'{' + v.name + '}'}</span>
                    <span className="text-muted-foreground">默认: {v.defaultValue || '(空)'}</span>
                    <button
                      onClick={() => removeVariable(i)}
                      className="ml-auto text-destructive hover:text-destructive"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={newVarName}
                onChange={(e) => setNewVarName(e.target.value)}
                placeholder="变量名"
                className="flex-1 px-2 py-1.5 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <input
                type="text"
                value={newVarDefault}
                onChange={(e) => setNewVarDefault(e.target.value)}
                placeholder="默认值"
                className="flex-1 px-2 py-1.5 bg-background border border-input rounded text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <button
                onClick={addVariable}
                className="px-2 py-1.5 bg-secondary text-secondary-foreground rounded text-xs hover:bg-secondary/80 transition-colors"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm hover:bg-accent rounded-lg transition-colors"
          >
            取消
          </button>
          <button
            onClick={() => onSave(form)}
            disabled={!form.name || !form.command}
            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
