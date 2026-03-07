import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Container, Image, Play, Square, RefreshCw, Trash2, Terminal, FileText,
  Download, Upload, RotateCcw, Search, FolderOpen, ArrowUp, Home, ChevronRight,
  X, AlertCircle, Copy, Check, Plus, Network, Info, Settings, Layers, Save
} from 'lucide-react'
import { cn, formatBytes } from '../../lib/utils'

interface ContainerInfo { id: string; name: string; image: string; status: string; state: string; ports: string; created: string; size: string }
interface ImageInfo { id: string; repository: string; tag: string; size: string; created: string }
interface NetworkInfo { id: string; name: string; driver: string; scope: string }
interface ComposeProject { name: string; status: string; configFiles: string }

interface DockerPanelProps { sessionId: string; tabId: string }

export function DockerPanel({ sessionId, tabId }: DockerPanelProps) {
  const [activeView, setActiveView] = useState<'containers' | 'images' | 'networks' | 'compose'>('containers')
  const [containers, setContainers] = useState<ContainerInfo[]>([])
  const [images, setImages] = useState<ImageInfo[]>([])
  const [networks, setNetworks] = useState<NetworkInfo[]>([])
  const [composeProjects, setComposeProjects] = useState<ComposeProject[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [actionLoadingMap, setActionLoadingMap] = useState<Record<string, string>>({})

  // Log viewer state
  const [logViewer, setLogViewer] = useState<any>(null)
  const logPreRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (logPreRef.current && logViewer && !logViewer.loading) {
      logPreRef.current.scrollTop = logPreRef.current.scrollHeight
    }
  }, [logViewer?.logs, logViewer?.loading])
  // File browser state
  const [fileBrowser, setFileBrowser] = useState<any>(null)
  // Container detail state
  const [containerDetail, setContainerDetail] = useState<any>(null)
  const [detailTab, setDetailTab] = useState('info')
  // Compose editor
  const [composeEditor, setComposeEditor] = useState<{ filePath: string; projectName: string; content: string; loading: boolean; saving: boolean } | null>(null)
  // Create container dialog
  const [showCreateContainer, setShowCreateContainer] = useState(false)
  // Registry mirror dialog
  const [showRegistryMirrors, setShowRegistryMirrors] = useState(false)
  // Create network dialog
  const [showCreateNetwork, setShowCreateNetwork] = useState(false)
  // Pull image
  const [pullImageName, setPullImageName] = useState('')
  const [pulling, setPulling] = useState(false)
  // Top count for file browser
  const [topCount] = useState(10)

  const loadContainers = useCallback(async () => {
    setLoading(true); setError(null)
    try { const r = await window.api.docker.listContainers(sessionId); if (r.success) setContainers(r.containers); else setError(r.error) }
    catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [sessionId])

  const loadImages = useCallback(async () => {
    setLoading(true); setError(null)
    try { const r = await window.api.docker.listImages(sessionId); if (r.success) setImages(r.images); else setError(r.error) }
    catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [sessionId])

  const loadNetworks = useCallback(async () => {
    setLoading(true); setError(null)
    try { const r = await window.api.docker.listNetworks(sessionId); if (r.success) setNetworks(r.networks); else setError(r.error) }
    catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [sessionId])

  const loadCompose = useCallback(async () => {
    setLoading(true); setError(null)
    try { const r = await window.api.docker.listComposeProjects(sessionId); if (r.success) setComposeProjects(r.projects); else setError(r.error) }
    catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [sessionId])

  const openComposeEditor = async (projectName: string, filePath: string) => {
    setComposeEditor({ filePath, projectName, content: '', loading: true, saving: false })
    const r = await window.api.docker.getComposeFile(sessionId, filePath)
    setComposeEditor((p) => p ? { ...p, content: r.success ? r.content : `Error: ${r.error}`, loading: false } : null)
  }
  const saveComposeFile = async () => {
    if (!composeEditor) return
    setComposeEditor((p) => p ? { ...p, saving: true } : null)
    await window.api.docker.saveComposeFile(sessionId, composeEditor.filePath, composeEditor.content)
    setComposeEditor((p) => p ? { ...p, saving: false } : null)
  }

  useEffect(() => {
    if (activeView === 'containers') loadContainers()
    else if (activeView === 'images') loadImages()
    else if (activeView === 'networks') loadNetworks()
    else if (activeView === 'compose') loadCompose()
  }, [activeView])

  const handleContainerAction = async (containerId: string, action: string) => {
    setActionLoadingMap((p) => ({ ...p, [`container-${containerId}`]: action }))
    try { await window.api.docker.containerAction(sessionId, containerId, action) }
    finally {
      await loadContainers()
      setActionLoadingMap((p) => { const n = { ...p }; delete n[`container-${containerId}`]; return n })
    }
  }
  const handleViewLogs = async (containerId: string, name: string) => {
    setLogViewer({ containerId, name, logs: '', loading: true, tail: 500, since: '', until: '', searchText: '', matchCount: 0, matchIndex: 0 })
    const r = await window.api.docker.containerLogs(sessionId, containerId, { tail: 500 })
    setLogViewer((p: any) => p ? { ...p, logs: r.success ? r.logs : `Error: ${r.error}`, loading: false } : null)
  }
  const refreshLogs = async () => {
    if (!logViewer) return
    setLogViewer((p: any) => p ? { ...p, loading: true } : null)
    const opts: any = { tail: logViewer.tail }
    if (logViewer.since) opts.since = logViewer.since
    if (logViewer.until) opts.until = logViewer.until
    const r = await window.api.docker.containerLogs(sessionId, logViewer.containerId, opts)
    setLogViewer((p: any) => p ? { ...p, logs: r.success ? r.logs : `Error: ${r.error}`, loading: false } : null)
  }
  const handleExec = async (containerId: string) => {
    const r = await window.api.docker.containerExec(sessionId, containerId)
    if (r.success) window.dispatchEvent(new CustomEvent('docker:execTerminal', { detail: { sessionId: r.execSessionId, containerId } }))
  }
  const handleInspect = async (containerId: string) => {
    const r = await window.api.docker.inspectContainer(sessionId, containerId)
    if (r.success) { setContainerDetail(r.data); setDetailTab('info') }
  }

  // Container file browser
  const openFileBrowser = async (containerId: string, containerName: string, path: string = '/') => {
    setFileBrowser({ containerId, containerName, path, files: [], loading: true, error: null })
    try {
      const r = await window.api.docker.listContainerFiles(sessionId, containerId, path)
      if (r.success) setFileBrowser((p: any) => p ? { ...p, files: r.files, loading: false } : null)
      else setFileBrowser((p: any) => p ? { ...p, error: r.error, loading: false } : null)
    } catch (err: any) { setFileBrowser((p: any) => p ? { ...p, error: err.message, loading: false } : null) }
  }
  const navigateContainerDir = (dir: string) => {
    if (!fileBrowser) return
    const newPath = fileBrowser.path === '/' ? `/${dir}` : `${fileBrowser.path}/${dir}`
    openFileBrowser(fileBrowser.containerId, fileBrowser.containerName, newPath)
  }
  const containerFileUp = () => {
    if (!fileBrowser || fileBrowser.path === '/') return
    const parent = fileBrowser.path.split('/').slice(0, -1).join('/') || '/'
    openFileBrowser(fileBrowser.containerId, fileBrowser.containerName, parent)
  }
  const handleContainerFileUpload = async () => {
    if (!fileBrowser) return
    const result = await window.api.config.selectFile()
    if (result.success && !result.canceled && result.filePaths?.length > 0) {
      const localPath = result.filePaths[0]
      const filename = localPath.split(/[/\\]/).pop()
      const destPath = fileBrowser.path === '/' ? `/${filename}` : `${fileBrowser.path}/${filename}`
      setFileBrowser((p: any) => p ? { ...p, loading: true } : null)
      try { await window.api.docker.copyToContainer(sessionId, fileBrowser.containerId, localPath, destPath); openFileBrowser(fileBrowser.containerId, fileBrowser.containerName, fileBrowser.path) }
      catch { setFileBrowser((p: any) => p ? { ...p, loading: false, error: '上传失败' } : null) }
    }
  }
  const handleContainerFileDownload = async (filename: string) => {
    if (!fileBrowser) return
    const containerFilePath = fileBrowser.path === '/' ? `/${filename}` : `${fileBrowser.path}/${filename}`
    const result = await window.api.config.selectDirectory()
    if (result.success && !result.canceled && result.filePaths?.length > 0) {
      setFileBrowser((p: any) => p ? { ...p, loading: true } : null)
      try { await window.api.docker.copyFromContainer(sessionId, fileBrowser.containerId, containerFilePath, `${result.filePaths[0]}\\${filename}`); setFileBrowser((p: any) => p ? { ...p, loading: false } : null) }
      catch { setFileBrowser((p: any) => p ? { ...p, loading: false, error: '下载失败' } : null) }
    }
  }
  const handlePullImage = async () => {
    if (!pullImageName.trim()) return
    setPulling(true)
    await window.api.docker.pullImage(sessionId, pullImageName.trim())
    setPulling(false); setPullImageName(''); loadImages()
  }
  const handleRemoveImage = async (imageId: string) => {
    if (confirm('确定删除此镜像？')) {
      setActionLoadingMap((p) => ({ ...p, [`image-${imageId}`]: 'remove' }))
      try { await window.api.docker.removeImage(sessionId, imageId) }
      finally {
        await loadImages()
        setActionLoadingMap((p) => { const n = { ...p }; delete n[`image-${imageId}`]; return n })
      }
    }
  }
  const handleRemoveNetwork = async (networkId: string) => {
    if (confirm('确定删除此网络？')) {
      setActionLoadingMap((p) => ({ ...p, [`network-${networkId}`]: 'remove' }))
      try { await window.api.docker.removeNetwork(sessionId, networkId) }
      finally {
        await loadNetworks()
        setActionLoadingMap((p) => { const n = { ...p }; delete n[`network-${networkId}`]; return n })
      }
    }
  }
  const handleComposeAction = async (projectName: string, dir: string, action: string) => {
    setActionLoadingMap((p) => ({ ...p, [`compose-${projectName}`]: action }))
    try { await window.api.docker.composeAction(sessionId, dir, action) }
    finally {
      await loadCompose()
      setActionLoadingMap((p) => { const n = { ...p }; delete n[`compose-${projectName}`]; return n })
    }
  }

  const stateColor = (state: string) => state === 'running' ? 'text-green-500' : state === 'exited' ? 'text-red-500' : 'text-muted-foreground'

  const filtered = (items: any[]) => items.filter((i) =>
    !searchQuery || JSON.stringify(i).toLowerCase().includes(searchQuery.toLowerCase())
  )

  // Tab buttons
  const tabs = [
    { id: 'containers' as const, icon: Container, label: '容器' },
    { id: 'images' as const, icon: Image, label: '镜像' },
    { id: 'networks' as const, icon: Network, label: '网络' },
    { id: 'compose' as const, icon: Layers, label: 'Compose' }
  ]

  return (
    <div className="flex flex-col w-full h-full p-4 gap-3 select-text">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center bg-card border border-border rounded-lg p-0.5">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setActiveView(t.id)} className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors', activeView === t.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <t.icon className="w-3.5 h-3.5" />{t.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 px-2 py-1.5 bg-card border border-border rounded-lg">
            <Search className="w-3.5 h-3.5 text-muted-foreground" />
            <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} placeholder="搜索..." className="w-40 bg-transparent text-sm outline-none" />
          </div>
          {activeView === 'containers' && <button onClick={() => setShowCreateContainer(true)} className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary/90"><Plus className="w-3.5 h-3.5" />创建容器</button>}
          {activeView === 'images' && <button onClick={() => setShowRegistryMirrors(true)} className="p-1.5 bg-card border border-border rounded-lg hover:bg-accent" title="镜像源设置"><Settings className="w-4 h-4" /></button>}
          {activeView === 'networks' && <button onClick={() => setShowCreateNetwork(true)} className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm hover:bg-primary/90"><Plus className="w-3.5 h-3.5" />创建网络</button>}
          <button onClick={() => { if (activeView === 'containers') loadContainers(); else if (activeView === 'images') loadImages(); else if (activeView === 'networks') loadNetworks(); else loadCompose() }} className="p-1.5 bg-card border border-border rounded-lg hover:bg-accent">
            <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {error && <div className="px-4 py-3 bg-destructive/10 border border-destructive/30 rounded-lg text-sm text-destructive">{error}</div>}

      {/* Content */}
      <div className="flex-1 overflow-hidden bg-card border border-border rounded-lg">
        {/* CONTAINERS VIEW */}
        {activeView === 'containers' && (
          <div className="h-full overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card border-b border-border"><tr className="text-xs text-muted-foreground">
                <th className="text-left px-4 py-2.5 font-medium">名称</th>
                <th className="text-left px-4 py-2.5 font-medium">镜像</th>
                <th className="text-left px-4 py-2.5 font-medium">状态</th>
                <th className="text-left px-4 py-2.5 font-medium">端口</th>
                <th className="text-center px-4 py-2.5 font-medium w-56">操作</th>
              </tr></thead>
              <tbody>{filtered(containers).map((c) => (
                <tr key={c.id} className="border-b border-border/50 hover:bg-accent/50">
                  <td className="px-4 py-2.5">
                    <button onClick={() => handleInspect(c.id)} className="font-medium hover:text-primary transition-colors">{c.name}</button>
                    <div className="text-xs text-muted-foreground font-mono">{c.id.substring(0, 12)}</div>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{c.image}</td>
                  <td className="px-4 py-2.5"><span className={stateColor(c.state)}>{c.status}</span></td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono">{c.ports || '-'}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-center gap-1">
                      {c.state === 'running' ? (
                        <>
                          <button onClick={() => handleContainerAction(c.id, 'stop')} disabled={!!actionLoadingMap[`container-${c.id}`]} className="p-1.5 hover:bg-accent rounded disabled:opacity-50" title="停止">
                            {actionLoadingMap[`container-${c.id}`] === 'stop' ? <RefreshCw className="w-3.5 h-3.5 text-red-500 animate-spin" /> : <Square className="w-3.5 h-3.5 text-red-500" />}
                          </button>
                          <button onClick={() => handleContainerAction(c.id, 'restart')} disabled={!!actionLoadingMap[`container-${c.id}`]} className="p-1.5 hover:bg-accent rounded disabled:opacity-50" title="重启">
                            {actionLoadingMap[`container-${c.id}`] === 'restart' ? <RefreshCw className="w-3.5 h-3.5 text-yellow-500 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5 text-yellow-500" />}
                          </button>
                          <button onClick={() => handleExec(c.id)} className="p-1.5 hover:bg-accent rounded" title="终端"><Terminal className="w-3.5 h-3.5 text-primary" /></button>
                          <button onClick={() => openFileBrowser(c.id, c.name)} className="p-1.5 hover:bg-accent rounded" title="文件管理"><FolderOpen className="w-3.5 h-3.5 text-yellow-500" /></button>
                        </>
                      ) : (
                        <button onClick={() => handleContainerAction(c.id, 'start')} disabled={!!actionLoadingMap[`container-${c.id}`]} className="p-1.5 hover:bg-accent rounded disabled:opacity-50" title="启动">
                          {actionLoadingMap[`container-${c.id}`] === 'start' ? <RefreshCw className="w-3.5 h-3.5 text-green-500 animate-spin" /> : <Play className="w-3.5 h-3.5 text-green-500" />}
                        </button>
                      )}
                      <button onClick={() => handleInspect(c.id)} className="p-1.5 hover:bg-accent rounded" title="详情"><Info className="w-3.5 h-3.5" /></button>
                      <button onClick={() => handleViewLogs(c.id, c.name)} className="p-1.5 hover:bg-accent rounded" title="日志"><FileText className="w-3.5 h-3.5" /></button>
                      <button onClick={() => handleContainerAction(c.id, 'remove')} disabled={!!actionLoadingMap[`container-${c.id}`]} className="p-1.5 hover:bg-accent rounded disabled:opacity-50" title="删除">
                        {actionLoadingMap[`container-${c.id}`] === 'remove' ? <RefreshCw className="w-3.5 h-3.5 text-destructive animate-spin" /> : <Trash2 className="w-3.5 h-3.5 text-destructive" />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

        {/* IMAGES VIEW */}
        {activeView === 'images' && (
          <div className="h-full flex flex-col">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
              <input type="text" value={pullImageName} onChange={(e) => setPullImageName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handlePullImage()} placeholder="输入镜像名拉取，如 nginx:latest" className="flex-1 px-3 py-1.5 bg-background border border-input rounded-lg text-sm outline-none" />
              <button onClick={handlePullImage} disabled={pulling} className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-lg text-sm disabled:opacity-50"><Download className={cn('w-3.5 h-3.5', pulling && 'animate-bounce')} />{pulling ? '拉取中...' : '拉取'}</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card border-b border-border"><tr className="text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2.5 font-medium">仓库</th><th className="text-left px-4 py-2.5 font-medium">标签</th>
                  <th className="text-left px-4 py-2.5 font-medium">ID</th><th className="text-left px-4 py-2.5 font-medium">大小</th>
                  <th className="text-center px-4 py-2.5 font-medium w-20">操作</th>
                </tr></thead>
                <tbody>{filtered(images).map((i) => (
                  <tr key={i.id} className="border-b border-border/50 hover:bg-accent/50">
                    <td className="px-4 py-2.5 font-medium">{i.repository}</td>
                    <td className="px-4 py-2.5"><span className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-xs">{i.tag}</span></td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{i.id.substring(0, 12)}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{i.size}</td>
                    <td className="px-4 py-2.5 text-center">
                      <button onClick={() => handleRemoveImage(i.id)} disabled={!!actionLoadingMap[`image-${i.id}`]} className="p-1.5 hover:bg-accent rounded disabled:opacity-50">
                        {actionLoadingMap[`image-${i.id}`] === 'remove' ? <RefreshCw className="w-3.5 h-3.5 text-destructive animate-spin" /> : <Trash2 className="w-3.5 h-3.5 text-destructive" />}
                      </button>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}

        {/* NETWORKS VIEW */}
        {activeView === 'networks' && (
          <div className="h-full overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-card border-b border-border"><tr className="text-xs text-muted-foreground">
                <th className="text-left px-4 py-2.5 font-medium">名称</th><th className="text-left px-4 py-2.5 font-medium">驱动</th>
                <th className="text-left px-4 py-2.5 font-medium">范围</th><th className="text-left px-4 py-2.5 font-medium">ID</th>
                <th className="text-center px-4 py-2.5 font-medium w-20">操作</th>
              </tr></thead>
              <tbody>{filtered(networks).map((n) => (
                <tr key={n.id} className="border-b border-border/50 hover:bg-accent/50">
                  <td className="px-4 py-2.5 font-medium">{n.name}</td>
                  <td className="px-4 py-2.5"><span className="px-1.5 py-0.5 bg-secondary rounded text-xs">{n.driver}</span></td>
                  <td className="px-4 py-2.5 text-muted-foreground">{n.scope}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{n.id.substring(0, 12)}</td>
                  <td className="px-4 py-2.5 text-center">
                    {!['bridge', 'host', 'none'].includes(n.name) && (
                      <button onClick={() => handleRemoveNetwork(n.id)} disabled={!!actionLoadingMap[`network-${n.id}`]} className="p-1.5 hover:bg-accent rounded disabled:opacity-50">
                        {actionLoadingMap[`network-${n.id}`] === 'remove' ? <RefreshCw className="w-3.5 h-3.5 text-destructive animate-spin" /> : <Trash2 className="w-3.5 h-3.5 text-destructive" />}
                      </button>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}

        {/* COMPOSE VIEW */}
        {activeView === 'compose' && (
          <div className="h-full overflow-y-auto">
            {composeProjects.length === 0 ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">暂无 Compose 项目</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card border-b border-border"><tr className="text-xs text-muted-foreground">
                  <th className="text-left px-4 py-2.5 font-medium">项目</th><th className="text-left px-4 py-2.5 font-medium">状态</th>
                  <th className="text-left px-4 py-2.5 font-medium">配置文件</th><th className="text-center px-4 py-2.5 font-medium w-40">操作</th>
                </tr></thead>
                <tbody>{composeProjects.map((p) => {
                  const dir = p.configFiles ? p.configFiles.substring(0, p.configFiles.lastIndexOf('/')) : ''
                  return (
                    <tr key={p.name} className="border-b border-border/50 hover:bg-accent/50">
                      <td className="px-4 py-2.5 font-medium">{p.name}</td>
                      <td className="px-4 py-2.5"><span className={cn('text-xs', p.status.includes('running') ? 'text-green-500' : 'text-muted-foreground')}>{p.status}</span></td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground font-mono truncate max-w-[300px]">{p.configFiles}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-center gap-1">
                          <button onClick={() => handleComposeAction(p.name, dir, 'up')} disabled={!!actionLoadingMap[`compose-${p.name}`]} className="flex items-center justify-center w-12 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50">
                            {actionLoadingMap[`compose-${p.name}`] === 'up' ? <RefreshCw className="w-3 h-3 animate-spin mx-auto" /> : '启动'}
                          </button>
                          <button onClick={() => handleComposeAction(p.name, dir, 'down')} disabled={!!actionLoadingMap[`compose-${p.name}`]} className="flex items-center justify-center w-12 py-1 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50">
                            {actionLoadingMap[`compose-${p.name}`] === 'down' ? <RefreshCw className="w-3 h-3 animate-spin mx-auto" /> : '停止'}
                          </button>
                          <button onClick={() => handleComposeAction(p.name, dir, 'restart')} disabled={!!actionLoadingMap[`compose-${p.name}`]} className="flex items-center justify-center w-12 py-1 text-xs bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50">
                            {actionLoadingMap[`compose-${p.name}`] === 'restart' ? <RefreshCw className="w-3 h-3 animate-spin mx-auto" /> : '重启'}
                          </button>
                          <button onClick={() => openComposeEditor(p.name, p.configFiles)} className="flex items-center justify-center w-12 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90">
                            编辑
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}</tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* ===== MODALS ===== */}

      {/* Log Viewer — virtualized */}
      {logViewer && <VirtualLogViewer logViewer={logViewer} setLogViewer={setLogViewer} logPreRef={logPreRef} refreshLogs={refreshLogs} />}

      {/* Container Detail */}
      {containerDetail && <ContainerDetailModal
        sessionId={sessionId}
        detail={containerDetail}
        detailTab={detailTab}
        setDetailTab={setDetailTab}
        networks={networks}
        onClose={() => setContainerDetail(null)}
        onRefresh={async () => { const r = await window.api.docker.inspectContainer(sessionId, containerDetail.Id?.substring(0, 12)); if (r.success) setContainerDetail(r.data) }}
      />}

      {/* Create Container */}
      {showCreateContainer && <CreateContainerDialog sessionId={sessionId} images={images} networks={networks} onClose={() => setShowCreateContainer(false)} onCreated={() => { setShowCreateContainer(false); loadContainers() }} />}

      {/* Create Network */}
      {showCreateNetwork && <CreateNetworkDialog sessionId={sessionId} onClose={() => setShowCreateNetwork(false)} onCreated={() => { setShowCreateNetwork(false); loadNetworks() }} />}

      {/* Registry Mirrors */}
      {showRegistryMirrors && <RegistryMirrorsDialog sessionId={sessionId} onClose={() => setShowRegistryMirrors(false)} />}

      {/* Compose Editor */}
      {composeEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => { if (e.key === 'Escape') setComposeEditor(null); if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveComposeFile() } }}>
          <div className="absolute inset-0 bg-black/50 dialog-overlay" onClick={() => setComposeEditor(null)} />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[800px] overflow-hidden dialog-content flex flex-col" style={{ height: '90vh' }}>
            <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-medium">{composeEditor.projectName} - {composeEditor.filePath.split('/').pop()}</h3>
                <span className="text-xs text-muted-foreground font-mono">{composeEditor.filePath}</span>
              </div>
              <div className="flex items-center gap-1">
                <button onClick={saveComposeFile} disabled={composeEditor.saving} className="flex items-center gap-1 px-2.5 py-1 bg-primary text-primary-foreground rounded text-xs disabled:opacity-50 hover:bg-primary/90">
                  {composeEditor.saving ? '保存中...' : '保存 (Ctrl+S)'}
                </button>
                <button onClick={() => setComposeEditor(null)} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              {composeEditor.loading ? (
                <div className="flex items-center justify-center h-full"><RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" /></div>
              ) : (
                <textarea
                  value={composeEditor.content}
                  onChange={(e) => setComposeEditor((p) => p ? { ...p, content: e.target.value } : null)}
                  className="w-full h-full p-4 bg-[#0d1117] text-[#c9d1d9] font-mono text-xs outline-none resize-none leading-[1.5rem]"
                  style={{ tabSize: 2, userSelect: 'text' }}
                  spellCheck={false}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Container File Browser */}
      {fileBrowser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && setFileBrowser(null)}>
          <div className="absolute inset-0 bg-black/50 dialog-overlay" onClick={() => setFileBrowser(null)} />
          <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[700px] max-h-[80vh] overflow-hidden dialog-content flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
              <div className="flex items-center gap-2"><FolderOpen className="w-4 h-4 text-yellow-500" /><h3 className="text-sm font-medium">容器文件 - {fileBrowser.containerName}</h3></div>
              <div className="flex items-center gap-1">
                <button onClick={handleContainerFileUpload} className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"><Upload className="w-3 h-3" />上传</button>
                <button onClick={() => setFileBrowser(null)} className="p-1.5 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
              </div>
            </div>
            <div className="flex items-center gap-1 px-5 py-2 border-b border-border bg-card/50 shrink-0">
              <button onClick={containerFileUp} className="p-1 hover:bg-accent rounded"><ArrowUp className="w-3.5 h-3.5" /></button>
              <button onClick={() => openFileBrowser(fileBrowser.containerId, fileBrowser.containerName, '/')} className="hover:text-primary"><Home className="w-3.5 h-3.5" /></button>
              {fileBrowser.path.split('/').filter(Boolean).map((part: string, i: number, arr: string[]) => (
                <span key={i} className="flex items-center gap-0.5 text-sm"><ChevronRight className="w-3 h-3 text-muted-foreground" />
                  <button onClick={() => openFileBrowser(fileBrowser.containerId, fileBrowser.containerName, '/' + arr.slice(0, i + 1).join('/'))} className="hover:text-primary">{part}</button>
                </span>
              ))}
              <button onClick={() => openFileBrowser(fileBrowser.containerId, fileBrowser.containerName, fileBrowser.path)} className="ml-auto p-1 hover:bg-accent rounded"><RefreshCw className={cn('w-3.5 h-3.5', fileBrowser.loading && 'animate-spin')} /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-[300px] max-h-[calc(80vh-130px)]">
              {fileBrowser.loading ? <div className="flex items-center justify-center h-full"><RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" /></div>
                : fileBrowser.error ? <div className="flex flex-col items-center justify-center h-full p-4"><AlertCircle className="w-6 h-6 text-destructive mb-2" /><p className="text-xs text-destructive">{fileBrowser.error}</p></div>
                  : <table className="w-full text-sm"><thead className="sticky top-0 bg-card text-xs text-muted-foreground"><tr><th className="text-left px-4 py-1.5 font-medium">名称</th><th className="text-right px-4 py-1.5 font-medium w-20">大小</th><th className="text-center px-4 py-1.5 font-medium w-28">权限</th><th className="text-center px-4 py-1.5 font-medium w-16">操作</th></tr></thead>
                    <tbody>{fileBrowser.files.map((f: any) => (
                      <tr key={f.filename} onDoubleClick={() => f.isDirectory && navigateContainerDir(f.filename)} className="hover:bg-accent/50 cursor-pointer">
                        <td className="px-4 py-1.5 flex items-center gap-2">{f.isDirectory ? <FolderOpen className="w-4 h-4 text-yellow-500 shrink-0" /> : <FileText className="w-4 h-4 text-muted-foreground shrink-0" />}<span className="truncate">{f.filename}</span></td>
                        <td className="px-4 py-1.5 text-right text-xs text-muted-foreground">{f.isDirectory ? '-' : f.size}</td>
                        <td className="px-4 py-1.5 text-center font-mono text-xs text-muted-foreground">{f.permissions}</td>
                        <td className="px-4 py-1.5 text-center">{!f.isDirectory && <button onClick={() => handleContainerFileDownload(f.filename)} className="p-1 hover:bg-accent rounded"><Download className="w-3.5 h-3.5 text-primary" /></button>}</td>
                      </tr>
                    ))}{fileBrowser.files.length === 0 && <tr><td colSpan={4} className="text-center py-8 text-muted-foreground text-xs">空目录</td></tr>}</tbody>
                  </table>}
            </div>
            <div className="px-5 py-2 border-t border-border text-xs text-muted-foreground shrink-0">{fileBrowser.files.length} 个项目 | 容器: {fileBrowser.containerId?.substring(0, 12)}</div>
          </div>
        </div>
      )}
    </div>
  )
}

// ===== Virtualized Log Viewer =====
const LINE_HEIGHT = 16 // px per line (text-xs + mono)
const OVERSCAN = 30 // extra lines above/below viewport for smooth scrolling

function VirtualLogViewer({ logViewer, setLogViewer, logPreRef, refreshLogs }: {
  logViewer: any; setLogViewer: (fn: any) => void; logPreRef: React.RefObject<HTMLPreElement | null>; refreshLogs: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewHeight, setViewHeight] = useState(600)
  const [copied, setCopied] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)

  // Parse lines once
  const allLines = useMemo(() => logViewer.logs ? logViewer.logs.split('\n') : [], [logViewer.logs])
  const totalLineCount = allLines.length

  // Filter lines if search
  const displayLines = useMemo(() => {
    if (!logViewer.searchText) return allLines.map((text: string, idx: number) => ({ text, idx }))
    const esc = logViewer.searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rx = new RegExp(esc, 'gi')
    return allLines
      .map((text: string, idx: number) => ({ text, idx }))
      .filter((l: { text: string }) => rx.test(l.text))
  }, [allLines, logViewer.searchText])

  const lineCount = displayLines.length
  const totalHeight = lineCount * LINE_HEIGHT
  const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - OVERSCAN)
  const endIdx = Math.min(lineCount, Math.ceil((scrollTop + viewHeight) / LINE_HEIGHT) + OVERSCAN)
  const visibleSlice = displayLines.slice(startIdx, endIdx)

  // On mount + log change, auto-scroll to bottom
  useEffect(() => {
    if (!logViewer.loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logViewer.logs, logViewer.loading])

  // Track viewport size
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const handleScroll = useCallback(() => {
    if (scrollRef.current) setScrollTop(scrollRef.current.scrollTop)
  }, [])

  // Async copy — will not freeze UI
  const handleCopyAll = useCallback(async () => {
    try {
      const blob = new Blob([logViewer.logs], { type: 'text/plain' })
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })])
    } catch {
      // Fallback
      try { await navigator.clipboard.writeText(logViewer.logs) } catch { /* ignore */ }
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [logViewer.logs])

  // Copy selection
  const handleCopySelection = useCallback(() => {
    const sel = window.getSelection()?.toString()
    if (sel) {
      navigator.clipboard.writeText(sel)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }, [])

  // Select all log text
  const handleSelectAll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, [])

  // Save logs to local file via Blob download
  const handleSaveToFile = useCallback(() => {
    const blob = new Blob([logViewer.logs], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${logViewer.name}-logs.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [logViewer.logs, logViewer.name])

  // Right-click context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()

    // Adjust menu position to avoid overflow
    const menuWidth = 160
    const menuHeight = 160 // approximate height
    let x = e.clientX
    let y = e.clientY

    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 10
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 10
    }

    setCtxMenu({ x, y })
  }, [])

  // Render a single line (with highlight if searching)
  const renderLine = useCallback((line: { text: string; idx: number }) => {
    if (!logViewer.searchText) return line.text + '\n'
    const esc = logViewer.searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rx = new RegExp(`(${esc})`, 'gi')
    const parts = line.text.split(rx)
    return (
      <span key={line.idx}>
        {parts.map((p: string, j: number) =>
          rx.test(p) ? <mark key={j} className="bg-yellow-500/40 text-yellow-200">{p}</mark> : p
        )}{'\n'}
      </span>
    )
  }, [logViewer.searchText])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && setLogViewer(null)}>
      <div className="absolute inset-0 bg-black/50 dialog-overlay" onClick={() => setLogViewer(null)} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[900px] max-h-[85vh] overflow-hidden dialog-content flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-medium">容器日志 - {logViewer.name}</h3>
          <div className="flex items-center gap-1">
            <button onClick={handleSaveToFile} className="flex items-center gap-1 px-2 py-1 text-xs bg-secondary rounded hover:bg-secondary/80" title="保存到文件">
              <Save className="w-3 h-3" />保存
            </button>
            <button
              onClick={handleCopyAll}
              className={cn('flex items-center gap-1 px-2 py-1 text-xs rounded transition-all', copied ? 'bg-green-500/20 text-green-500' : 'bg-secondary hover:bg-secondary/80')}
            >
              {copied ? <><Check className="w-3 h-3" />已复制</> : <><Copy className="w-3 h-3" />复制全部</>}
            </button>
            <button onClick={() => setLogViewer(null)} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex items-center gap-2 px-5 py-2 border-b border-border shrink-0 flex-wrap">
          <select value={logViewer.tail} onChange={(e) => setLogViewer((p: any) => p ? { ...p, tail: e.target.value === 'all' ? 'all' : parseInt(e.target.value) } : null)} className="px-2 py-1 bg-background border border-input rounded text-xs outline-none">
            <option value={100}>100行</option><option value={500}>500行</option><option value={1000}>1000行</option><option value={5000}>5000行</option><option value={10000}>10000行</option><option value="all">全部</option>
          </select>
          <input type="datetime-local" value={logViewer.since} onChange={(e) => setLogViewer((p: any) => p ? { ...p, since: e.target.value } : null)} className="px-2 py-1 bg-background border border-input rounded text-xs outline-none" />
          <input type="datetime-local" value={logViewer.until} onChange={(e) => setLogViewer((p: any) => p ? { ...p, until: e.target.value } : null)} className="px-2 py-1 bg-background border border-input rounded text-xs outline-none" />
          <button onClick={refreshLogs} disabled={logViewer.loading} className="px-2 py-1 bg-primary text-primary-foreground rounded text-xs"><RefreshCw className={cn('w-3 h-3 inline', logViewer.loading && 'animate-spin')} /> 刷新</button>
        </div>
        <div className="flex items-center gap-2 px-5 py-1.5 border-b border-border shrink-0">
          <Search className="w-3.5 h-3.5 text-muted-foreground" />
          <input type="text" value={logViewer.searchText} onChange={(e) => setLogViewer((p: any) => p ? { ...p, searchText: e.target.value } : null)} placeholder="搜索日志..." className="flex-1 bg-background px-2 py-1 rounded text-xs outline-none border border-input" />
          {logViewer.searchText && <span className="text-xs text-muted-foreground">{displayLines.length} 条匹配</span>}
        </div>
        {/* Virtualized log content */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto min-h-[200px] bg-[#0d1117]"
          onScroll={handleScroll}
          style={{ userSelect: 'text' }}
          onContextMenu={handleContextMenu}
          onClick={() => setCtxMenu(null)}
        >
          {logViewer.loading ? (
            <div className="p-4 text-xs font-mono text-[#c9d1d9]">Loading...</div>
          ) : (
            <div style={{ height: totalHeight, position: 'relative' }}>
              <pre
                className="text-xs font-mono text-[#c9d1d9] whitespace-pre-wrap px-4 absolute left-0 right-0"
                style={{ top: startIdx * LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px` }}
              >
                {logViewer.searchText
                  ? visibleSlice.map((l: { text: string; idx: number }) => renderLine(l))
                  : visibleSlice.map((l: { text: string; idx: number }) => l.text + '\n').join('')
                }
              </pre>
            </div>
          )}
        </div>

        {/* Right-click context menu */}
        {ctxMenu && (
          <>
            <div className="fixed inset-0 z-[90]" onClick={() => setCtxMenu(null)} />
            <div
              className="fixed z-[100] bg-popover text-popover-foreground border border-border rounded-lg shadow-xl py-1 min-w-[160px] select-none"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
            >
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-accent hover:text-accent-foreground rounded transition-colors"
                onClick={() => { handleCopySelection(); setCtxMenu(null) }}
              >
                <Copy className="w-3.5 h-3.5 shrink-0" /> 复制选中
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-accent hover:text-accent-foreground rounded transition-colors"
                onClick={() => { handleCopyAll(); setCtxMenu(null) }}
              >
                <Copy className="w-3.5 h-3.5 shrink-0" /> 复制全部日志
              </button>
              <div className="border-t border-border/50 my-1" />
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-accent hover:text-accent-foreground rounded transition-colors"
                onClick={() => { handleSelectAll(); setCtxMenu(null) }}
              >
                <FileText className="w-3.5 h-3.5 shrink-0" /> 全选
              </button>
              <div className="border-t border-border/50 my-1" />
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-accent hover:text-accent-foreground rounded transition-colors"
                onClick={() => { handleSaveToFile(); setCtxMenu(null) }}
              >
                <Save className="w-3.5 h-3.5 shrink-0" /> 保存到文件
              </button>
            </div>
          </>
        )}

        <div className="px-5 py-1.5 border-t border-border text-[10px] text-muted-foreground shrink-0 flex justify-between">
          <span>共 {totalLineCount.toLocaleString()} 行{logViewer.searchText ? ` | 匹配 ${displayLines.length.toLocaleString()} 行` : ''} | {formatBytes(logViewer.logs.length)}</span>
          {totalLineCount > 10000 && <span className="text-green-500">✓ 虚拟滚动已启用</span>}
        </div>
      </div>
    </div>
  )
}

// ===== Create Container Dialog =====
function CreateContainerDialog({ sessionId, images, networks, onClose, onCreated }: { sessionId: string; images: any[]; networks: any[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ image: '', name: '', restartPolicy: 'no', network: '', ports: [''], volumes: [''], envVars: [''] })
  const [creating, setCreating] = useState(false)

  const update = (key: string, val: any) => setForm((p) => ({ ...p, [key]: val }))
  const updateList = (key: string, idx: number, val: string) => setForm((p) => { const arr = [...(p as any)[key]]; arr[idx] = val; return { ...p, [key]: arr } })
  const addToList = (key: string) => setForm((p) => ({ ...p, [key]: [...(p as any)[key], ''] }))

  const handleCreate = async () => {
    if (!form.image) return
    setCreating(true)
    await window.api.docker.createContainer(sessionId, {
      image: form.image, name: form.name || undefined, restartPolicy: form.restartPolicy,
      network: form.network || undefined,
      ports: form.ports.filter(Boolean), volumes: form.volumes.filter(Boolean), envVars: form.envVars.filter(Boolean)
    })
    setCreating(false); onCreated()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="absolute inset-0 bg-black/50 dialog-overlay" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[550px] max-h-[85vh] overflow-hidden dialog-content flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-medium">创建容器</h3>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div><label className="block text-xs font-medium mb-1">镜像 *</label>
            <input type="text" list="imgList" value={form.image} onChange={(e) => update('image', e.target.value)} placeholder="nginx:latest" className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none" />
            <datalist id="imgList">{images.map((i) => <option key={i.id} value={`${i.repository}:${i.tag}`} />)}</datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-medium mb-1">容器名</label><input type="text" value={form.name} onChange={(e) => update('name', e.target.value)} placeholder="可选" className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none" /></div>
            <div><label className="block text-xs font-medium mb-1">重启策略</label><select value={form.restartPolicy} onChange={(e) => update('restartPolicy', e.target.value)} className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none"><option value="no">no</option><option value="always">always</option><option value="unless-stopped">unless-stopped</option><option value="on-failure">on-failure</option></select></div>
          </div>
          <div><label className="block text-xs font-medium mb-1">网络</label><select value={form.network} onChange={(e) => update('network', e.target.value)} className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none"><option value="">默认</option>{networks.map((n) => <option key={n.id} value={n.name}>{n.name} ({n.driver})</option>)}</select></div>
          <div><label className="block text-xs font-medium mb-1">端口映射 (host:container)</label>
            {form.ports.map((p, i) => <input key={i} type="text" value={p} onChange={(e) => updateList('ports', i, e.target.value)} placeholder="8080:80" className="w-full mb-1 px-3 py-1.5 bg-background border border-input rounded text-xs outline-none font-mono" />)}
            <button onClick={() => addToList('ports')} className="text-xs text-primary hover:underline">+ 添加端口</button>
          </div>
          <div><label className="block text-xs font-medium mb-1">挂载卷 (host:container)</label>
            {form.volumes.map((v, i) => <input key={i} type="text" value={v} onChange={(e) => updateList('volumes', i, e.target.value)} placeholder="/data:/app/data" className="w-full mb-1 px-3 py-1.5 bg-background border border-input rounded text-xs outline-none font-mono" />)}
            <button onClick={() => addToList('volumes')} className="text-xs text-primary hover:underline">+ 添加挂载</button>
          </div>
          <div><label className="block text-xs font-medium mb-1">环境变量 (KEY=VALUE)</label>
            {form.envVars.map((e, i) => <input key={i} type="text" value={e} onChange={(ev) => updateList('envVars', i, ev.target.value)} placeholder="NODE_ENV=production" className="w-full mb-1 px-3 py-1.5 bg-background border border-input rounded text-xs outline-none font-mono" />)}
            <button onClick={() => addToList('envVars')} className="text-xs text-primary hover:underline">+ 添加变量</button>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border shrink-0">
          <button onClick={onClose} className="px-4 py-2 text-sm hover:bg-accent rounded-lg">取消</button>
          <button onClick={handleCreate} disabled={!form.image || creating} className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg disabled:opacity-50">{creating ? '创建中...' : '创建'}</button>
        </div>
      </div>
    </div>
  )
}

// ===== Create Network Dialog =====
function CreateNetworkDialog({ sessionId, onClose, onCreated }: { sessionId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [driver, setDriver] = useState('bridge')
  const [subnet, setSubnet] = useState('')

  const handleCreate = async () => {
    if (!name) return
    await window.api.docker.createNetwork(sessionId, name, driver, subnet || undefined)
    onCreated()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="absolute inset-0 bg-black/50 dialog-overlay" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[420px] dialog-content p-5">
        <h3 className="text-sm font-semibold mb-4">创建 Docker 网络</h3>
        <div className="space-y-3">
          <div><label className="block text-xs font-medium mb-1">网络名称 *</label><input type="text" value={name} onChange={(e) => setName(e.target.value)} className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none" /></div>
          <div><label className="block text-xs font-medium mb-1">驱动</label><select value={driver} onChange={(e) => setDriver(e.target.value)} className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none"><option value="bridge">bridge</option><option value="overlay">overlay</option><option value="macvlan">macvlan</option></select></div>
          <div><label className="block text-xs font-medium mb-1">子网 (可选)</label><input type="text" value={subnet} onChange={(e) => setSubnet(e.target.value)} placeholder="172.20.0.0/16" className="w-full px-3 py-2 bg-background border border-input rounded-lg text-sm outline-none font-mono" /></div>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm hover:bg-accent rounded-lg">取消</button>
          <button onClick={handleCreate} disabled={!name} className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg disabled:opacity-50">创建</button>
        </div>
      </div>
    </div>
  )
}

// ===== Registry Mirrors Dialog =====
function RegistryMirrorsDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [mirrors, setMirrors] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [newMirror, setNewMirror] = useState('')
  const [saving, setSaving] = useState(false)

  const presets = [
    { name: '阿里云', url: 'https://registry.cn-hangzhou.aliyuncs.com' },
    { name: '腾讯云', url: 'https://mirror.ccs.tencentyun.com' },
    { name: '中科大', url: 'https://docker.mirrors.ustc.edu.cn' },
    { name: '华为云', url: 'https://05f073ad3c0010ea0f4bc00b7105ec20.mirror.swr.myhuaweicloud.com' }
  ]

  useEffect(() => {
    window.api.docker.getRegistryMirrors(sessionId).then((r: any) => {
      if (r.success) setMirrors(r.mirrors)
      setLoading(false)
    })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    await window.api.docker.setRegistryMirrors(sessionId, mirrors)
    setSaving(false)
    alert('镜像源已保存。请在终端执行 sudo systemctl restart docker 使配置生效。')
  }

  const addMirror = (url: string) => {
    if (url && !mirrors.includes(url)) setMirrors([...mirrors, url])
    setNewMirror('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="absolute inset-0 bg-black/50 dialog-overlay" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[500px] dialog-content p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Docker 镜像源设置</h3>
          <button onClick={onClose} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
        </div>

        {loading ? <div className="text-center py-4 text-muted-foreground">加载中...</div> : (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium mb-2">当前镜像源</label>
              {mirrors.length === 0 ? <p className="text-xs text-muted-foreground">未配置镜像源</p> : (
                <div className="space-y-1">
                  {mirrors.map((m, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-background rounded border border-input text-xs font-mono">
                      <span className="flex-1 truncate">{m}</span>
                      <button onClick={() => setMirrors(mirrors.filter((_, j) => j !== i))} className="text-destructive hover:text-destructive/80"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">添加镜像源</label>
              <div className="flex gap-2">
                <input type="text" value={newMirror} onChange={(e) => setNewMirror(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addMirror(newMirror)} placeholder="https://..." className="flex-1 px-3 py-1.5 bg-background border border-input rounded text-xs outline-none font-mono" />
                <button onClick={() => addMirror(newMirror)} className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs">添加</button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">快速添加</label>
              <div className="flex flex-wrap gap-1">
                {presets.map((p) => (
                  <button key={p.name} onClick={() => addMirror(p.url)} disabled={mirrors.includes(p.url)}
                    className="px-2 py-1 text-xs bg-secondary rounded hover:bg-secondary/80 disabled:opacity-50">{p.name}</button>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-border">
              <button onClick={onClose} className="px-4 py-2 text-sm hover:bg-accent rounded-lg">取消</button>
              <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ===== Container Detail Modal =====
function ContainerDetailModal({ sessionId, detail, detailTab, setDetailTab, networks, onClose, onRefresh }: {
  sessionId: string; detail: any; detailTab: string; setDetailTab: (t: string) => void; networks: NetworkInfo[]; onClose: () => void; onRefresh: () => void
}) {
  const [joinNetworkId, setJoinNetworkId] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const containerId = detail.Id?.substring(0, 12) || ''
  const containerName = detail.Name?.replace(/^\//, '') || containerId
  const connectedNetworks = Object.keys(detail.NetworkSettings?.Networks || {})
  const availableNetworks = networks.filter((n) => !connectedNetworks.includes(n.name) && n.name !== 'host' && n.name !== 'none')

  const getCopyText = (): string => {
    if (detailTab === 'info') return [['ID', detail.Id], ['镜像', detail.Config?.Image], ['状态', detail.State?.Status], ['启动时间', detail.State?.StartedAt], ['重启策略', detail.HostConfig?.RestartPolicy?.Name]].map(([k, v]) => `${k}: ${v || '-'}`).join('\n')
    if (detailTab === 'network') return Object.entries(detail.NetworkSettings?.Networks || {}).map(([name, net]: [string, any]) => `网络: ${name}\n  IP: ${net.IPAddress}\n  网关: ${net.Gateway}\n  MAC: ${net.MacAddress}`).join('\n\n')
    if (detailTab === 'mounts') return (detail.Mounts || []).map((m: any) => `${m.Type}: ${m.Source} -> ${m.Destination} (${m.RW ? 'RW' : 'RO'})`).join('\n')
    if (detailTab === 'env') return (detail.Config?.Env || []).join('\n')
    if (detailTab === 'ports') return Object.entries(detail.NetworkSettings?.Ports || {}).map(([cp, bs]: [string, any]) => (bs || []).map((b: any) => `${cp} -> ${b.HostIp}:${b.HostPort}`).join('\n')).join('\n')
    return ''
  }
  const handleJoinNetwork = async () => { if (!joinNetworkId) return; setActionLoading(true); await window.api.docker.connectNetwork(sessionId, joinNetworkId, containerId); setJoinNetworkId(''); await onRefresh(); setActionLoading(false) }
  const handleLeaveNetwork = async (name: string) => { if (!confirm(`断开网络 "${name}"？`)) return; setActionLoading(true); await window.api.docker.disconnectNetwork(sessionId, name, containerId); await onRefresh(); setActionLoading(false) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="absolute inset-0 bg-black/50 dialog-overlay" onClick={onClose} />
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[800px] max-h-[80vh] overflow-hidden dialog-content flex flex-col" style={{ userSelect: 'text' }}>
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-medium">容器详情 - {containerName}</h3>
          <div className="flex items-center gap-1">
            <button onClick={() => navigator.clipboard.writeText(getCopyText())} className="flex items-center gap-1 px-2 py-1 text-xs bg-secondary rounded hover:bg-secondary/80"><Copy className="w-3 h-3" />复制当前页</button>
            <button onClick={() => navigator.clipboard.writeText(JSON.stringify(detail, null, 2))} className="flex items-center gap-1 px-2 py-1 text-xs bg-secondary rounded hover:bg-secondary/80"><Copy className="w-3 h-3" />复制JSON</button>
            <button onClick={onClose} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="flex border-b border-border shrink-0">
          {[['info', '基本信息'], ['network', '网络'], ['mounts', '挂载'], ['env', '环境变量'], ['ports', '端口映射']].map(([id, label]) => (
            <button key={id} onClick={() => setDetailTab(id)} className={cn('px-4 py-2 text-xs', detailTab === id ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-5 text-sm" onContextMenu={(e) => { const s = window.getSelection()?.toString(); if (s) { e.preventDefault(); navigator.clipboard.writeText(s) } }}>
          {detailTab === 'info' && (
            <div className="space-y-2 text-xs">
              {[['ID', detail.Id], ['镜像', detail.Config?.Image], ['状态', detail.State?.Status], ['启动时间', detail.State?.StartedAt], ['重启策略', detail.HostConfig?.RestartPolicy?.Name], ['平台', detail.Platform], ['驱动', detail.Driver]].map(([k, v]) => (
                <div key={k as string} className="flex items-center group"><span className="w-24 text-muted-foreground shrink-0">{k}</span><span className="font-mono flex-1">{v || '-'}</span>
                  <button onClick={() => navigator.clipboard.writeText(String(v || ''))} className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-accent rounded"><Copy className="w-3 h-3 text-muted-foreground" /></button></div>
              ))}
            </div>
          )}
          {detailTab === 'network' && (
            <div className="space-y-3">
              {Object.entries(detail.NetworkSettings?.Networks || {}).map(([name, net]: [string, any]) => (
                <div key={name} className="border border-border rounded-lg p-3 text-xs">
                  <div className="flex items-center justify-between mb-2"><span className="font-medium text-sm">{name}</span>
                    <button onClick={() => handleLeaveNetwork(name)} disabled={actionLoading} className="flex items-center gap-1 px-2 py-1 text-xs text-destructive bg-destructive/10 rounded hover:bg-destructive/20 disabled:opacity-50"><X className="w-3 h-3" />断开</button>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5 text-muted-foreground">
                    {[['IP', net.IPAddress], ['网关', net.Gateway], ['MAC', net.MacAddress], ['网络ID', net.NetworkID?.substring(0, 12)]].map(([l, v]) => (
                      <div key={l as string} className="flex items-center gap-1 group"><span>{l}: </span><span className="font-mono text-foreground">{v || '-'}</span>
                        <button onClick={() => navigator.clipboard.writeText(String(v || ''))} className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-accent rounded"><Copy className="w-2.5 h-2.5" /></button></div>
                    ))}
                  </div>
                </div>
              ))}
              {connectedNetworks.length === 0 && <p className="text-xs text-muted-foreground">未连接任何网络</p>}
              <div className="border border-dashed border-border rounded-lg p-3">
                <label className="block text-xs font-medium mb-2">加入网络</label>
                <div className="flex gap-2">
                  <select value={joinNetworkId} onChange={(e) => setJoinNetworkId(e.target.value)} className="flex-1 px-3 py-1.5 bg-background border border-input rounded text-xs outline-none">
                    <option value="">选择网络...</option>
                    {availableNetworks.map((n) => <option key={n.id} value={n.name}>{n.name} ({n.driver})</option>)}
                  </select>
                  <button onClick={handleJoinNetwork} disabled={!joinNetworkId || actionLoading} className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs disabled:opacity-50"><Plus className="w-3 h-3" />加入</button>
                </div>
                {availableNetworks.length === 0 && <p className="text-xs text-muted-foreground mt-1">没有可用网络，请先在网络页创建</p>}
              </div>
            </div>
          )}
          {detailTab === 'mounts' && (
            <table className="w-full text-xs"><thead className="text-muted-foreground"><tr><th className="text-left py-1">类型</th><th className="text-left py-1">源</th><th className="text-left py-1">目标</th><th className="text-left py-1">读写</th></tr></thead>
              <tbody>{(detail.Mounts || []).length === 0 ? <tr><td colSpan={4} className="py-4 text-center text-muted-foreground">无挂载</td></tr> : (detail.Mounts || []).map((m: any, i: number) => (
                <tr key={i} className="border-t border-border/50"><td className="py-1.5">{m.Type}</td><td className="py-1.5 font-mono text-muted-foreground break-all">{m.Source}</td><td className="py-1.5 font-mono">{m.Destination}</td><td className="py-1.5">{m.RW ? '读写' : '只读'}</td></tr>
              ))}</tbody>
            </table>
          )}
          {detailTab === 'env' && (
            <table className="w-full text-xs"><thead className="text-muted-foreground"><tr><th className="text-left py-1">变量</th><th className="text-left py-1">值</th><th className="w-8"></th></tr></thead>
              <tbody>{(detail.Config?.Env || []).map((e: string, i: number) => {
                const [k, ...v] = e.split('='); return (
                  <tr key={i} className="border-t border-border/50 group"><td className="py-1.5 font-mono font-medium">{k}</td><td className="py-1.5 font-mono text-muted-foreground break-all">{v.join('=')}</td>
                    <td><button onClick={() => navigator.clipboard.writeText(e)} className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-accent rounded"><Copy className="w-3 h-3" /></button></td></tr>
                )
              })}</tbody>
            </table>
          )}
          {detailTab === 'ports' && (
            <table className="w-full text-xs"><thead className="text-muted-foreground"><tr><th className="text-left py-1">容器端口</th><th className="text-left py-1">主机地址</th><th className="text-left py-1">主机端口</th></tr></thead>
              <tbody>{Object.entries(detail.NetworkSettings?.Ports || {}).map(([cp, bs]: [string, any]) => (bs || [{ HostIp: '-', HostPort: '-' }]).map((b: any, i: number) => (
                <tr key={`${cp}-${i}`} className="border-t border-border/50"><td className="py-1.5 font-mono">{cp}</td><td className="py-1.5 font-mono">{b.HostIp || '0.0.0.0'}</td><td className="py-1.5 font-mono font-medium">{b.HostPort || '-'}</td></tr>
              )))}</tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
