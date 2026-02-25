import { useState, useEffect, useCallback, useRef } from 'react'
import { FolderOpen, Play, Edit, Plus, Copy, Variable, Code2, Trash2, FolderPlus, Pencil } from 'lucide-react'
import { cn } from '../../lib/utils'
import { v4 as uuidv4 } from 'uuid'
import type { Snippet } from './SnippetManager'

interface CommandPanelProps {
  onExecute: (command: string) => void
  onOpenManager: () => void
}

interface ContextMenu {
  x: number
  y: number
  type: 'category' | 'command' | 'blank'
  data?: string | Snippet
}

export function CommandPanel({ onExecute, onOpenManager }: CommandPanelProps) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string>('全部')
  const [selectedSnippet, setSelectedSnippet] = useState<Snippet | null>(null)
  const [variableDialog, setVariableDialog] = useState<Snippet | null>(null)
  const [variableValues, setVariableValues] = useState<Record<string, string>>({})
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null)
  const [renameDialog, setRenameDialog] = useState<{ oldName: string; newName: string } | null>(null)
  const [newGroupDialog, setNewGroupDialog] = useState<{ name: string } | null>(null)

  useEffect(() => { loadSnippets() }, [])

  useEffect(() => {
    const handleChanged = () => loadSnippets()
    window.addEventListener('snippets:changed', handleChanged)
    return () => window.removeEventListener('snippets:changed', handleChanged)
  }, [])

  // Close context menu on click outside
  useEffect(() => {
    const close = () => setContextMenu(null)
    if (contextMenu) {
      window.addEventListener('click', close)
      return () => window.removeEventListener('click', close)
    }
  }, [contextMenu])

  const loadSnippets = async () => {
    const result = await window.api.config.getSnippets()
    if (result.success) setSnippets(result.snippets)
  }

  const categories = [...new Set(snippets.map((s) => s.category || '未分类'))]

  const filteredSnippets = selectedCategory === '全部'
    ? snippets
    : snippets.filter((s) => (s.category || '未分类') === selectedCategory)

  const handleExecuteSnippet = useCallback((snippet: Snippet) => {
    if (snippet.variables && snippet.variables.length > 0) {
      const defaults: Record<string, string> = {}
      snippet.variables.forEach((v) => { defaults[v.name] = v.defaultValue })
      setVariableValues(defaults)
      setVariableDialog(snippet)
    } else {
      onExecute(snippet.command + '\n')
    }
  }, [onExecute])

  const handleExecuteWithVariables = () => {
    if (!variableDialog) return
    let command = variableDialog.command
    for (const [name, value] of Object.entries(variableValues)) {
      command = command.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), value)
    }
    onExecute(command + '\n')
    setVariableDialog(null)
  }

  const handleDeleteSnippet = async (id: string) => {
    await window.api.config.deleteSnippet(id)
    await loadSnippets()
    window.dispatchEvent(new CustomEvent('snippets:changed'))
    if (selectedSnippet?.id === id) setSelectedSnippet(null)
  }

  const handleRenameCategory = async () => {
    if (!renameDialog || !renameDialog.newName.trim()) return
    const toUpdate = snippets.filter((s) => (s.category || '未分类') === renameDialog.oldName)
    for (const s of toUpdate) {
      await window.api.config.saveSnippet({ ...s, category: renameDialog.newName.trim() })
    }
    await loadSnippets()
    window.dispatchEvent(new CustomEvent('snippets:changed'))
    setSelectedCategory(renameDialog.newName.trim())
    setRenameDialog(null)
  }

  const handleDeleteCategory = async (catName: string) => {
    const toDelete = snippets.filter((s) => (s.category || '未分类') === catName)
    if (toDelete.length > 0 && !confirm(`确定删除分组「${catName}」及其 ${toDelete.length} 条命令？`)) return
    for (const s of toDelete) {
      await window.api.config.deleteSnippet(s.id)
    }
    await loadSnippets()
    window.dispatchEvent(new CustomEvent('snippets:changed'))
    if (selectedCategory === catName) setSelectedCategory('全部')
  }

  const handleCreateGroup = async () => {
    if (!newGroupDialog || !newGroupDialog.name.trim()) return
    // Create a placeholder snippet in the new group
    const placeholder: Snippet = {
      id: uuidv4(),
      name: '示例命令',
      command: 'echo "Hello"',
      description: '',
      category: newGroupDialog.name.trim(),
      variables: []
    }
    await window.api.config.saveSnippet(placeholder)
    await loadSnippets()
    window.dispatchEvent(new CustomEvent('snippets:changed'))
    setSelectedCategory(newGroupDialog.name.trim())
    setNewGroupDialog(null)
  }

  const handleCategoryContextMenu = (e: React.MouseEvent, catName: string) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'category', data: catName })
  }

  const handleCommandContextMenu = (e: React.MouseEvent, snippet: Snippet) => {
    e.preventDefault()
    e.stopPropagation()
    setSelectedSnippet(snippet)
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'command', data: snippet })
  }

  const handleBlankContextMenu = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, type: 'blank' })
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: Categories + Command buttons */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Category folders */}
        <div
          className="flex items-center gap-1 px-2 py-1.5 border-b border-border/50 overflow-x-auto shrink-0"
          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, type: 'blank' }) }}
        >
          <button
            onClick={() => setSelectedCategory('全部')}
            className={cn(
              'flex items-center gap-1 px-2 py-0.5 rounded text-xs whitespace-nowrap transition-colors shrink-0',
              selectedCategory === '全部' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
            )}
          >
            <FolderOpen className="w-3 h-3" />
            全部
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              onContextMenu={(e) => handleCategoryContextMenu(e, cat)}
              className={cn(
                'flex items-center gap-1 px-2 py-0.5 rounded text-xs whitespace-nowrap transition-colors shrink-0',
                selectedCategory === cat ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
              )}
            >
              <FolderOpen className="w-3 h-3" />
              {cat}
            </button>
          ))}
        </div>

        {/* Command buttons */}
        <div className="flex-1 overflow-y-auto p-2" onContextMenu={handleBlankContextMenu}>
          {filteredSnippets.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
              <Code2 className="w-6 h-6 mb-1 opacity-50" />
              <p className="text-xs mb-1">暂无命令片段</p>
              <button onClick={onOpenManager} className="text-xs text-primary hover:underline">
                点击创建
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 content-start">
              {filteredSnippets.map((snippet) => (
                <button
                  key={snippet.id}
                  onClick={() => handleExecuteSnippet(snippet)}
                  onContextMenu={(e) => handleCommandContextMenu(e, snippet)}
                  title={`点击执行 | 右键更多操作\n${snippet.command}`}
                  className={cn(
                    'flex items-center gap-1 px-2.5 py-1.5 border rounded-md text-xs transition-colors',
                    selectedSnippet?.id === snippet.id
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background hover:border-primary/50 hover:bg-accent/50'
                  )}
                >
                  <span className="max-w-[140px] truncate">{snippet.name}</span>
                  {snippet.variables && snippet.variables.length > 0 && (
                    <Variable className="w-3 h-3 text-primary shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right: Command Editor */}
      <div className="w-[240px] border-l border-border flex flex-col shrink-0 bg-background/50">
        <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 shrink-0">
          <span className="text-xs font-medium text-muted-foreground">命令编辑器</span>
          <button
            onClick={onOpenManager}
            className="p-0.5 hover:bg-accent rounded transition-colors"
            title="管理命令片段"
          >
            <Plus className="w-3 h-3 text-muted-foreground" />
          </button>
        </div>

        {selectedSnippet ? (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="px-3 py-2 border-b border-border/50">
              <div className="flex items-center gap-1.5">
                <span className="px-1.5 py-0.5 bg-primary text-primary-foreground rounded text-[10px] font-medium">
                  {selectedSnippet.name}
                </span>
                {selectedSnippet.variables && selectedSnippet.variables.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">
                    {selectedSnippet.variables.length} 个变量
                  </span>
                )}
              </div>
              {selectedSnippet.description && (
                <p className="text-[10px] text-muted-foreground mt-1">{selectedSnippet.description}</p>
              )}
            </div>
            <div className="flex-1 overflow-auto px-3 py-2">
              <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all leading-relaxed">
                {selectedSnippet.command}
              </pre>
            </div>
            <div className="flex items-center gap-1.5 px-3 py-2 border-t border-border/50 shrink-0">
              <button
                onClick={() => handleExecuteSnippet(selectedSnippet)}
                className="flex items-center gap-1 px-2.5 py-1 bg-green-600 text-white rounded text-xs hover:bg-green-700 transition-colors"
              >
                <Play className="w-3 h-3" /> 执行
              </button>
              <button
                onClick={() => navigator.clipboard.writeText(selectedSnippet.command)}
                className="flex items-center gap-1 px-2 py-1 bg-secondary text-secondary-foreground rounded text-xs hover:bg-secondary/80 transition-colors"
              >
                <Copy className="w-3 h-3" /> 复制
              </button>
              <button
                onClick={onOpenManager}
                className="flex items-center gap-1 px-2 py-1 bg-secondary text-secondary-foreground rounded text-xs hover:bg-secondary/80 transition-colors"
              >
                <Edit className="w-3 h-3" /> 编辑
              </button>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <p className="text-xs">右键命令查看详情</p>
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenuPopup
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onNewGroup={() => { setContextMenu(null); setNewGroupDialog({ name: '' }) }}
          onRenameCategory={(name) => { setContextMenu(null); setRenameDialog({ oldName: name, newName: name }) }}
          onDeleteCategory={(name) => { setContextMenu(null); handleDeleteCategory(name) }}
          onExecuteSnippet={(s) => { setContextMenu(null); handleExecuteSnippet(s) }}
          onEditSnippet={() => { setContextMenu(null); onOpenManager() }}
          onCopySnippet={(s) => { setContextMenu(null); navigator.clipboard.writeText(s.command) }}
          onDeleteSnippet={(s) => { setContextMenu(null); handleDeleteSnippet(s.id) }}
        />
      )}

      {/* Rename category dialog */}
      {renameDialog && (
        <MiniDialog
          title="重命名分组"
          value={renameDialog.newName}
          onChange={(v) => setRenameDialog({ ...renameDialog, newName: v })}
          onConfirm={handleRenameCategory}
          onCancel={() => setRenameDialog(null)}
        />
      )}

      {/* New group dialog */}
      {newGroupDialog && (
        <MiniDialog
          title="新建分组"
          value={newGroupDialog.name}
          onChange={(v) => setNewGroupDialog({ name: v })}
          onConfirm={handleCreateGroup}
          onCancel={() => setNewGroupDialog(null)}
          placeholder="输入分组名称"
        />
      )}

      {/* Variable input dialog */}
      {variableDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => setVariableDialog(null)} />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[400px] p-5">
            <h3 className="text-sm font-semibold mb-4">输入变量值</h3>
            <div className="space-y-3">
              {variableDialog.variables?.map((v) => (
                <div key={v.name}>
                  <label className="block text-xs font-medium mb-1">{'${' + v.name + '}'}</label>
                  <input
                    type="text"
                    value={variableValues[v.name] || ''}
                    onChange={(e) => setVariableValues((prev) => ({ ...prev, [v.name]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleExecuteWithVariables() }}
                    className="w-full px-3 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setVariableDialog(null)} className="px-3 py-1.5 text-sm hover:bg-accent rounded-lg transition-colors">取消</button>
              <button onClick={handleExecuteWithVariables} className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">执行</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ---- Context Menu Popup ---- */
function ContextMenuPopup({ menu, onClose, onNewGroup, onRenameCategory, onDeleteCategory, onExecuteSnippet, onEditSnippet, onCopySnippet, onDeleteSnippet }: {
  menu: ContextMenu
  onClose: () => void
  onNewGroup: () => void
  onRenameCategory: (name: string) => void
  onDeleteCategory: (name: string) => void
  onExecuteSnippet: (s: Snippet) => void
  onEditSnippet: () => void
  onCopySnippet: (s: Snippet) => void
  onDeleteSnippet: (s: Snippet) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Adjust position to stay in viewport
  const style: React.CSSProperties = {
    position: 'fixed', left: menu.x, top: menu.y, zIndex: 100
  }

  const itemClass = 'flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-accent rounded transition-colors'
  const dangerClass = 'flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-destructive hover:bg-destructive/10 rounded transition-colors'

  return (
    <div ref={ref} style={style} className="bg-popover border border-border rounded-lg shadow-xl py-1 min-w-[150px]" onClick={(e) => e.stopPropagation()}>
      {menu.type === 'blank' && (
        <>
          <button className={itemClass} onClick={onNewGroup}>
            <FolderPlus className="w-3.5 h-3.5" /> 新建分组
          </button>
        </>
      )}
      {menu.type === 'category' && (
        <>
          <button className={itemClass} onClick={() => onRenameCategory(menu.data as string)}>
            <Pencil className="w-3.5 h-3.5" /> 重命名
          </button>
          <button className={dangerClass} onClick={() => onDeleteCategory(menu.data as string)}>
            <Trash2 className="w-3.5 h-3.5" /> 删除分组
          </button>
          <div className="border-t border-border/50 my-1" />
          <button className={itemClass} onClick={onNewGroup}>
            <FolderPlus className="w-3.5 h-3.5" /> 新建分组
          </button>
        </>
      )}
      {menu.type === 'command' && menu.data && typeof menu.data !== 'string' && (
        <>
          <button className={itemClass} onClick={() => onExecuteSnippet(menu.data as Snippet)}>
            <Play className="w-3.5 h-3.5" /> 执行
          </button>
          <button className={itemClass} onClick={() => onCopySnippet(menu.data as Snippet)}>
            <Copy className="w-3.5 h-3.5" /> 复制命令
          </button>
          <button className={itemClass} onClick={onEditSnippet}>
            <Edit className="w-3.5 h-3.5" /> 编辑
          </button>
          <div className="border-t border-border/50 my-1" />
          <button className={dangerClass} onClick={() => onDeleteSnippet(menu.data as Snippet)}>
            <Trash2 className="w-3.5 h-3.5" /> 删除
          </button>
        </>
      )}
    </div>
  )
}

/* ---- Mini Dialog for rename / new group ---- */
function MiniDialog({ title, value, onChange, onConfirm, onCancel, placeholder }: {
  title: string; value: string; onChange: (v: string) => void
  onConfirm: () => void; onCancel: () => void; placeholder?: string
}) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[320px] p-4">
        <h3 className="text-sm font-semibold mb-3">{title}</h3>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onConfirm() }}
          placeholder={placeholder}
          autoFocus
          className="w-full px-3 py-1.5 bg-background border border-input rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onCancel} className="px-3 py-1.5 text-xs hover:bg-accent rounded-lg transition-colors">取消</button>
          <button onClick={onConfirm} className="px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">确定</button>
        </div>
      </div>
    </div>
  )
}
