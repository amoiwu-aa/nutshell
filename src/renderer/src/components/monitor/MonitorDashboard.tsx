import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Cpu, MemoryStick, HardDrive, Network, Activity, RefreshCw, Skull,
  ArrowUp, ArrowDown, Server, Monitor, Settings, X, Check,
  Zap, Thermometer, Search, Square, CheckSquare
} from 'lucide-react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Area, AreaChart
} from 'recharts'
import { cn, formatBytes, formatBytesPerSec } from '../../lib/utils'
import { useSettingsStore, type MonitorModules, defaultMonitorModules } from '../../stores/settingsStore'

interface DiskInfo { filesystem: string; mountPoint: string; used: number; total: number; percent: number }
interface TopProcess { pid: number; user: string; cpu: number; mem: number; rss: number; command: string }
interface GpuInfo { name: string; temperature: number; utilization: number; memoryUsed: number; memoryTotal: number; fanSpeed: number; powerDraw: number }
interface PortInfo { protocol: string; localAddr: string; port: number; pid: number; process: string; state: string }
interface MonitorData {
  cpu: number
  memory: { used: number; total: number; percent: number }
  swap: { used: number; total: number; percent: number }
  disks: DiskInfo[]
  network: { rx: number; tx: number; interfaces?: { name: string; rx: number; tx: number }[] }
  loadAvg: number[]
  uptime?: string
  topCpu: TopProcess[]
  topMem: TopProcess[]
  gpus: GpuInfo[]
  timestamp?: number
}
interface SystemInfo { hostname: string; os: string; kernel: string; cpuCores: number; arch: string }
interface ProcessInfo { pid: number; user: string; cpu: number; mem: number; vsz: number; rss: number; command: string }

interface MonitorDashboardProps { sessionId: string; tabId: string; isActive: boolean }

const MAX_DATA_POINTS = 60
type SortKey = 'pid' | 'user' | 'cpu' | 'mem' | 'rss' | 'command'
type SortDir = 'asc' | 'desc'
type PortSortKey = 'port' | 'pid' | 'process' | 'protocol'

const moduleLabels: Record<keyof MonitorModules, string> = {
  systemInfo: '系统信息', cpu: 'CPU 使用率', memory: '内存使用率',
  swap: '交换内存', disks: '磁盘分区', network: '网络流量',
  topCpu: 'CPU Top 5', topMem: '内存 Top 5', processes: '进程列表',
  gpu: 'GPU 显卡', ports: '端口占用'
}

export function MonitorDashboard({ sessionId, tabId, isActive }: MonitorDashboardProps) {
  const [currentData, setCurrentData] = useState<MonitorData | null>(null)
  const [history, setHistory] = useState<MonitorData[]>([])
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [processes, setProcesses] = useState<ProcessInfo[]>([])
  const [showProcesses, setShowProcesses] = useState(false)
  const [processSort, setProcessSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'cpu', dir: 'desc' })
  const [loadingProcesses, setLoadingProcesses] = useState(false)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const [showModuleSettings, setShowModuleSettings] = useState(false)

  // Ports
  const [ports, setPorts] = useState<PortInfo[]>([])
  const [showPorts, setShowPorts] = useState(false)
  const [loadingPorts, setLoadingPorts] = useState(false)
  const [portSearch, setPortSearch] = useState('')
  const [portSort, setPortSort] = useState<{ key: PortSortKey; dir: SortDir }>({ key: 'port', dir: 'asc' })

  // Network interface selection
  const [selectedInterface, setSelectedInterface] = useState<string>('all')

  // Top N count
  const [topCount, setTopCount] = useState(10)

  // Batch kill
  const [selectedPids, setSelectedPids] = useState<Set<number>>(new Set())
  const [killSignal, setKillSignal] = useState<9 | 15>(15)

  const monitorModules = useSettingsStore((state) => state.settings.monitorModules)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const mod = monitorModules || defaultMonitorModules

  const startMonitoring = useCallback(() => {
    setMonitorError(null)
    window.api.monitor.start(sessionId, 3000, mod)
    if (mod.systemInfo) {
      window.api.monitor.getSystemInfo(sessionId).then((r: any) => {
        if (r.success) setSysInfo(r.info)
      })
    }
  }, [sessionId, mod])

  const pendingDataRef = useRef<MonitorData | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isActive) return
    startMonitoring()
    const removeListener = window.api.monitor.onData((sid: string, data: any) => {
      if (sid !== sessionId) return
      const point = { ...data, timestamp: Date.now() }
      pendingDataRef.current = point

      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null
          const p = pendingDataRef.current
          if (!p) return
          pendingDataRef.current = null
          setMonitorError(null)
          setCurrentData(p)
          setHistory((prev) => {
            const next = prev.length >= MAX_DATA_POINTS ? prev.slice(1) : [...prev]
            next.push(p)
            return next
          })
        })
      }
    })
    return () => {
      removeListener()
      window.api.monitor.stop(sessionId)
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    }
  }, [sessionId, isActive, startMonitoring])

  useEffect(() => {
    if (!isActive) return
    window.api.monitor.updateModules?.(sessionId, mod)
  }, [mod, sessionId, isActive])

  const toggleModule = (key: keyof MonitorModules) => {
    setSettings({ monitorModules: { ...mod, [key]: !mod[key] } })
  }

  const loadProcesses = async () => {
    setLoadingProcesses(true)
    const result = await window.api.monitor.getProcesses(sessionId)
    if (result.success) setProcesses(result.processes)
    setLoadingProcesses(false)
  }

  const loadPorts = async () => {
    setLoadingPorts(true)
    const result = await window.api.monitor.getListeningPorts(sessionId)
    if (result.success) setPorts(result.ports)
    setLoadingPorts(false)
  }

  const handleKillProcess = async (pid: number, sig?: number) => {
    const sigNum = sig || killSignal
    const label = sigNum === 15 ? '优雅关闭(SIGTERM)' : '强制杀死(SIGKILL)'
    if (confirm(`确定要 ${label} 进程 ${pid} 吗？`)) {
      await window.api.monitor.killProcess(sessionId, pid, sigNum)
      loadProcesses()
    }
  }

  const handleBatchKill = async () => {
    if (selectedPids.size === 0) return
    const label = killSignal === 15 ? '优雅关闭(SIGTERM)' : '强制杀死(SIGKILL)'
    if (confirm(`确定要 ${label} 选中的 ${selectedPids.size} 个进程吗？`)) {
      await window.api.monitor.killProcesses(sessionId, Array.from(selectedPids), killSignal)
      setSelectedPids(new Set())
      loadProcesses()
    }
  }

  const togglePidSelect = (pid: number) => {
    setSelectedPids((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      return next
    })
  }

  useEffect(() => { if (showProcesses) loadProcesses() }, [showProcesses])
  useEffect(() => { if (showPorts) loadPorts() }, [showPorts])

  const toggleProcessSort = (key: SortKey) => {
    setProcessSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'desc' ? 'asc' : 'desc' }))
  }
  const togglePortSort = (key: PortSortKey) => {
    setPortSort((prev) => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }))
  }

  const sortedProcesses = useMemo(() => [...processes].sort((a, b) => {
    const { key, dir } = processSort
    const cmp = key === 'user' || key === 'command'
      ? (a[key] || '').localeCompare(b[key] || '')
      : (a[key] as number) - (b[key] as number)
    return dir === 'desc' ? -cmp : cmp
  }), [processes, processSort])

  const sortedPorts = useMemo(() => {
    const filtered = ports.filter((p) =>
      !portSearch || p.process.toLowerCase().includes(portSearch.toLowerCase()) ||
      p.localAddr.includes(portSearch) || String(p.port).includes(portSearch)
    )
    return [...filtered].sort((a, b) => {
      const { key, dir } = portSort
      const cmp = key === 'process' || key === 'protocol'
        ? (a[key] || '').localeCompare(b[key] || '')
        : (a[key] as number) - (b[key] as number)
      return dir === 'asc' ? cmp : -cmp
    })
  }, [ports, portSearch, portSort])

  const displayedNetwork = useMemo(() => {
    if (!currentData) return { rx: 0, tx: 0 }
    if (selectedInterface === 'all') return { rx: currentData.network.rx, tx: currentData.network.tx }
    const iface = currentData.network.interfaces?.find((i) => i.name === selectedInterface)
    return iface ? { rx: iface.rx, tx: iface.tx } : { rx: 0, tx: 0 }
  }, [currentData, selectedInterface])

  const chartData = useMemo(() => history.map((d, i) => {
    let networkRx = d.network.rx, networkTx = d.network.tx
    if (selectedInterface !== 'all') {
      const iface = d.network.interfaces?.find((f) => f.name === selectedInterface)
      networkRx = iface?.rx || 0
      networkTx = iface?.tx || 0
    }
    return { time: i, cpu: d.cpu, memory: d.memory.percent, networkRx, networkTx }
  }), [history, selectedInterface])

  const SortHeader = ({ label, sortKey, active, dir, onClick, className }: {
    label: string; sortKey: string; active: boolean; dir: SortDir; onClick: () => void; className?: string
  }) => (
    <th className={cn('px-3 py-2 font-medium cursor-pointer hover:text-foreground select-none', className)} onClick={onClick}>
      <span className="inline-flex items-center gap-0.5">{label}
        {active && (dir === 'desc' ? <ArrowDown className="w-3 h-3" /> : <ArrowUp className="w-3 h-3" />)}
      </span>
    </th>
  )

  if (!currentData) {
    return (
      <div className="flex items-center justify-center w-full h-full text-muted-foreground">
        <div className="text-center">
          {monitorError ? (
            <>
              <Activity className="w-8 h-8 mb-2 mx-auto text-destructive" />
              <p className="text-sm text-destructive mb-1">监控数据采集失败</p>
              <p className="text-xs text-muted-foreground mb-3 max-w-[300px]">{monitorError}</p>
              <button onClick={startMonitoring} className="px-4 py-1.5 text-xs bg-primary text-primary-foreground rounded-lg hover:bg-primary/90">
                <RefreshCw className="w-3 h-3 inline mr-1" /> 重试
              </button>
            </>
          ) : (
            <><Activity className="w-8 h-8 mb-2 mx-auto animate-pulse" /><p className="text-sm">正在收集监控数据...</p></>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full p-3 space-y-3 overflow-y-auto select-text">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2"><Monitor className="w-4 h-4 text-primary" /><h2 className="text-sm font-semibold">服务器监控</h2></div>
        <button onClick={() => setShowModuleSettings(!showModuleSettings)} className={cn('p-1.5 rounded transition-colors', showModuleSettings ? 'bg-primary/20 text-primary' : 'hover:bg-accent text-muted-foreground')} title="监控模块设置">
          <Settings className="w-4 h-4" />
        </button>
      </div>

      {/* Module settings */}
      {showModuleSettings && (
        <div className="bg-card border border-border rounded-lg p-4 animate-slide-up">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium">监控模块开关</h3>
            <button onClick={() => setShowModuleSettings(false)} className="p-1 hover:bg-accent rounded"><X className="w-3.5 h-3.5" /></button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(moduleLabels) as Array<keyof MonitorModules>).map((key) => (
              <label key={key} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-accent/50 cursor-pointer transition-colors">
                <div className={cn('w-4 h-4 rounded border flex items-center justify-center transition-colors', mod[key] ? 'bg-primary border-primary' : 'border-muted-foreground')}>
                  {mod[key] && <Check className="w-3 h-3 text-primary-foreground" />}
                </div>
                <input type="checkbox" checked={mod[key]} onChange={() => toggleModule(key)} className="sr-only" />
                <span className="text-xs">{moduleLabels[key]}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* System info */}
      {mod.systemInfo && sysInfo && (
        <div className="flex items-center gap-4 px-4 py-2.5 bg-card border border-border rounded-lg text-xs flex-wrap">
          <div className="flex items-center gap-1.5"><Server className="w-3.5 h-3.5 text-primary" /><span className="font-medium">{sysInfo.hostname}</span></div>
          <span className="text-muted-foreground">|</span><span>{sysInfo.os}</span>
          <span className="text-muted-foreground">|</span><span className="font-mono">{sysInfo.kernel}</span>
          <span className="text-muted-foreground">|</span><span>{sysInfo.cpuCores} 核 ({sysInfo.arch})</span>
          <span className="text-muted-foreground">|</span><span>运行: {currentData.uptime}</span>
        </div>
      )}

      {/* Gauge cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {mod.cpu && <GaugeCard icon={Cpu} label="CPU" value={`负载: ${currentData.loadAvg?.map((v) => v?.toFixed(2)).join(', ') || 'N/A'}`} percent={currentData.cpu} color="#3b82f6" />}
        {mod.memory && <GaugeCard icon={MemoryStick} label="内存" value={`${formatBytes(currentData.memory.used)} / ${formatBytes(currentData.memory.total)}`} percent={currentData.memory.percent} color="#10b981" />}
        {mod.swap && <GaugeCard icon={MemoryStick} label="Swap" value={currentData.swap.total > 0 ? `${formatBytes(currentData.swap.used)} / ${formatBytes(currentData.swap.total)}` : '未启用'} percent={currentData.swap.percent} color="#f97316" />}
        {mod.network && <GaugeCard icon={Network} label={`网络${selectedInterface !== 'all' ? ` (${selectedInterface})` : ''}`} value={`↓${formatBytesPerSec(displayedNetwork.rx)} ↑${formatBytesPerSec(displayedNetwork.tx)}`} percent={0} color="#8b5cf6" />}
      </div>

      {/* GPU */}
      {mod.gpu && currentData.gpus && currentData.gpus.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><Zap className="w-4 h-4 text-green-500" />GPU 显卡</h3>
          <div className="space-y-3">
            {currentData.gpus.map((gpu, i) => (
              <div key={i} className="border border-border rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">{gpu.name}</span>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><Thermometer className="w-3 h-3" />{gpu.temperature}°C</span>
                    <span>风扇 {gpu.fanSpeed}%</span>
                    <span>{gpu.powerDraw}W</span>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>GPU 利用率</span><span className="font-medium">{gpu.utilization}%</span></div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500 bg-green-500" style={{ width: `${gpu.utilization}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="flex justify-between text-xs mb-1"><span>显存</span><span className="font-medium">{gpu.memoryUsed}MB / {gpu.memoryTotal}MB</span></div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all duration-500 bg-blue-500" style={{ width: `${gpu.memoryTotal > 0 ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : 0}%` }} />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Disks */}
      {mod.disks && currentData.disks && currentData.disks.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2"><HardDrive className="w-4 h-4 text-yellow-500" />磁盘分区</h3>
          <div className="space-y-2">
            {currentData.disks.map((d, i) => (
              <div key={i} className="flex items-center gap-3 text-xs">
                <span className="font-mono w-24 truncate text-muted-foreground" title={d.filesystem}>{d.filesystem}</span>
                <span className="w-28 truncate font-medium" title={d.mountPoint}>{d.mountPoint}</span>
                <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.max(0, 100 - Math.min(d.percent, 100))}%`, backgroundColor: d.percent > 90 ? '#ef4444' : d.percent > 70 ? '#f59e0b' : '#10b981' }} />
                </div>
                <span className="w-12 text-right">{d.percent}%</span>
                <span className="w-36 text-right text-muted-foreground">剩余 {formatBytes(d.total - d.used)} / {formatBytes(d.total)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-2 gap-3">
        {mod.cpu && (
          <div className="bg-card border border-border rounded-lg p-3">
            <h3 className="text-xs font-medium mb-2">CPU 趋势</h3>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={chartData}>
                <defs><linearGradient id="cpuG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} /><stop offset="95%" stopColor="#3b82f6" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="time" hide /><YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }} formatter={(v: number) => [`${v}%`, 'CPU']} />
                <Area type="monotone" dataKey="cpu" stroke="#3b82f6" fill="url(#cpuG)" strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        {mod.memory && (
          <div className="bg-card border border-border rounded-lg p-3">
            <h3 className="text-xs font-medium mb-2">内存趋势</h3>
            <ResponsiveContainer width="100%" height={120}>
              <AreaChart data={chartData}>
                <defs><linearGradient id="memG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.3} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="time" hide /><YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} />
                <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }} formatter={(v: number) => [`${v}%`, '内存']} />
                <Area type="monotone" dataKey="memory" stroke="#10b981" fill="url(#memG)" strokeWidth={2} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        {mod.network && (
          <div className="bg-card border border-border rounded-lg p-3 col-span-2">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-medium">网络流量</h3>
                <select
                  value={selectedInterface}
                  onChange={(e) => setSelectedInterface(e.target.value)}
                  className="px-1.5 py-0.5 text-xs bg-background border border-input rounded outline-none cursor-pointer"
                >
                  <option value="all">全部</option>
                  {currentData.network.interfaces?.map((iface) => (
                    <option key={iface.name} value={iface.name}>{iface.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-3 text-xs font-mono">
                <span className="flex items-center gap-1 text-blue-400" style={{ minWidth: 80, justifyContent: 'flex-end' }}>
                  <ArrowDown className="w-3 h-3 shrink-0" />
                  {formatBytesPerSec(displayedNetwork.rx)}
                </span>
                <span className="flex items-center gap-1 text-yellow-400" style={{ minWidth: 80, justifyContent: 'flex-end' }}>
                  <ArrowUp className="w-3 h-3 shrink-0" />
                  {formatBytesPerSec(displayedNetwork.tx)}
                </span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="time" hide />
                <YAxis tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={(v) => formatBytes(v)} width={50} />
                <Tooltip contentStyle={{ backgroundColor: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }} formatter={(v: number, n: string) => [formatBytesPerSec(v), n === 'networkRx' ? '↓接收' : '↑发送']} />
                <Line type="monotone" dataKey="networkRx" stroke="#3b82f6" strokeWidth={2} dot={false} isAnimationActive={false} />
                <Line type="monotone" dataKey="networkTx" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* CPU Top N */}
      {mod.topCpu && currentData.topCpu?.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <div className="flex items-center gap-2"><Cpu className="w-3.5 h-3.5 text-blue-500" /><h3 className="text-sm font-medium">CPU 占用排行</h3></div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">显示</span>
              <select value={topCount} onChange={(e) => { const v = parseInt(e.target.value); setTopCount(v); window.api.monitor.updateModules?.(sessionId, { ...mod, topCount: v } as any) }}
                className="px-2 py-0.5 text-xs bg-background border border-input rounded outline-none">
                <option value={5}>5</option><option value={10}>10</option><option value={20}>20</option><option value={50}>50</option>
              </select>
              <span className="text-xs text-muted-foreground">个</span>
            </div>
          </div>
          <div className="max-h-[300px] overflow-auto">
            <table className="text-xs" style={{ minWidth: '700px', width: '100%' }}>
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium" style={{ width: 70 }}>PID</th>
                  <th className="text-left px-3 py-1.5 font-medium" style={{ width: 70 }}>用户</th>
                  <th className="text-right px-3 py-1.5 font-medium" style={{ width: 55 }}>CPU%</th>
                  <th className="text-right px-3 py-1.5 font-medium" style={{ width: 55 }}>内存%</th>
                  <th className="text-right px-3 py-1.5 font-medium" style={{ width: 75 }}>RSS</th>
                  <th className="text-left px-3 py-1.5 font-medium">命令</th>
                  <th className="text-center px-3 py-1.5 font-medium" style={{ width: 60 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {currentData.topCpu.map((p) => (
                  <tr key={p.pid} className="hover:bg-accent/50">
                    <td className="px-3 py-1 font-mono">{p.pid}</td>
                    <td className="px-3 py-1">{p.user}</td>
                    <td className="px-3 py-1 text-right"><span className={cn(p.cpu > 50 && 'text-yellow-500', p.cpu > 80 && 'text-destructive')}>{p.cpu.toFixed(1)}</span></td>
                    <td className="px-3 py-1 text-right">{p.mem.toFixed(1)}</td>
                    <td className="px-3 py-1 text-right text-muted-foreground">{formatBytes(p.rss)}</td>
                    <td className="px-3 py-1 font-mono break-all" title={p.command}>{p.command}</td>
                    <td className="px-3 py-1 text-center">
                      <div className="flex items-center justify-center gap-0.5">
                        <button onClick={() => handleKillProcess(p.pid, 15)} className="p-0.5 hover:bg-yellow-500/20 rounded" title="SIGTERM"><X className="w-3 h-3 text-yellow-500" /></button>
                        <button onClick={() => handleKillProcess(p.pid, 9)} className="p-0.5 hover:bg-destructive/20 rounded" title="SIGKILL"><Skull className="w-3 h-3 text-destructive" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Memory Top N */}
      {mod.topMem && currentData.topMem?.length > 0 && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
            <div className="flex items-center gap-2"><MemoryStick className="w-3.5 h-3.5 text-green-500" /><h3 className="text-sm font-medium">内存占用排行</h3></div>
          </div>
          <div className="max-h-[300px] overflow-auto">
            <table className="text-xs" style={{ minWidth: '700px', width: '100%' }}>
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-1.5 font-medium" style={{ width: 70 }}>PID</th>
                  <th className="text-left px-3 py-1.5 font-medium" style={{ width: 70 }}>用户</th>
                  <th className="text-right px-3 py-1.5 font-medium" style={{ width: 55 }}>内存%</th>
                  <th className="text-right px-3 py-1.5 font-medium" style={{ width: 55 }}>CPU%</th>
                  <th className="text-right px-3 py-1.5 font-medium" style={{ width: 75 }}>RSS</th>
                  <th className="text-left px-3 py-1.5 font-medium">命令</th>
                  <th className="text-center px-3 py-1.5 font-medium" style={{ width: 60 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {currentData.topMem.map((p) => (
                  <tr key={p.pid} className="hover:bg-accent/50">
                    <td className="px-3 py-1 font-mono">{p.pid}</td>
                    <td className="px-3 py-1">{p.user}</td>
                    <td className="px-3 py-1 text-right font-medium">{p.mem.toFixed(1)}</td>
                    <td className="px-3 py-1 text-right">{p.cpu.toFixed(1)}</td>
                    <td className="px-3 py-1 text-right text-muted-foreground">{formatBytes(p.rss)}</td>
                    <td className="px-3 py-1 font-mono break-all" title={p.command}>{p.command}</td>
                    <td className="px-3 py-1 text-center">
                      <div className="flex items-center justify-center gap-0.5">
                        <button onClick={() => handleKillProcess(p.pid, 15)} className="p-0.5 hover:bg-yellow-500/20 rounded" title="SIGTERM"><X className="w-3 h-3 text-yellow-500" /></button>
                        <button onClick={() => handleKillProcess(p.pid, 9)} className="p-0.5 hover:bg-destructive/20 rounded" title="SIGKILL"><Skull className="w-3 h-3 text-destructive" /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Port list */}
      {mod.ports && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2"><Network className="w-4 h-4 text-purple-500" /><h3 className="text-sm font-medium">端口占用</h3></div>
            <div className="flex items-center gap-2">
              <button onClick={() => { setShowPorts(!showPorts); if (!showPorts) loadPorts() }} className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors">{showPorts ? '隐藏' : '显示'}</button>
              {showPorts && <button onClick={loadPorts} className="p-1 hover:bg-accent rounded"><RefreshCw className={cn('w-3.5 h-3.5', loadingPorts && 'animate-spin')} /></button>}
            </div>
          </div>
          {showPorts && (
            <>
              <div className="flex items-center gap-2 px-4 py-2 border-b border-border">
                <Search className="w-3.5 h-3.5 text-muted-foreground" />
                <input type="text" value={portSearch} onChange={(e) => setPortSearch(e.target.value)} placeholder="搜索端口、进程名、地址..." className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{sortedPorts.length} 个端口</span>
              </div>
              <div className="max-h-[250px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr>
                      <SortHeader label="协议" sortKey="protocol" active={portSort.key === 'protocol'} dir={portSort.dir} onClick={() => togglePortSort('protocol')} className="text-left" />
                      <th className="text-left px-3 py-2 font-medium">地址</th>
                      <SortHeader label="端口" sortKey="port" active={portSort.key === 'port'} dir={portSort.dir} onClick={() => togglePortSort('port')} className="text-right" />
                      <SortHeader label="PID" sortKey="pid" active={portSort.key === 'pid'} dir={portSort.dir} onClick={() => togglePortSort('pid')} className="text-right" />
                      <SortHeader label="进程" sortKey="process" active={portSort.key === 'process'} dir={portSort.dir} onClick={() => togglePortSort('process')} className="text-left" />
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPorts.map((p, i) => (
                      <tr key={i} className="hover:bg-accent/50">
                        <td className="px-3 py-1 font-mono">{p.protocol}</td>
                        <td className="px-3 py-1 font-mono text-muted-foreground">{p.localAddr}</td>
                        <td className="px-3 py-1 text-right font-mono font-medium">{p.port}</td>
                        <td className="px-3 py-1 text-right font-mono text-muted-foreground">{p.pid || '-'}</td>
                        <td className="px-3 py-1">{p.process || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Process list */}
      {mod.processes && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2"><Activity className="w-4 h-4 text-primary" /><h3 className="text-sm font-medium">进程列表</h3></div>
            <div className="flex items-center gap-2">
              {showProcesses && selectedPids.size > 0 && (
                <>
                  <select value={killSignal} onChange={(e) => setKillSignal(parseInt(e.target.value) as 9 | 15)} className="px-2 py-1 text-xs bg-background border border-input rounded outline-none">
                    <option value={15}>SIGTERM (优雅)</option>
                    <option value={9}>SIGKILL (强制)</option>
                  </select>
                  <button onClick={handleBatchKill} className="px-2 py-1 text-xs bg-destructive text-destructive-foreground rounded hover:bg-destructive/90 transition-colors">
                    终止 {selectedPids.size} 个
                  </button>
                </>
              )}
              <button onClick={() => { setShowProcesses(!showProcesses); if (!showProcesses) loadProcesses() }} className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors">{showProcesses ? '隐藏' : '显示'}</button>
              {showProcesses && <button onClick={loadProcesses} className="p-1 hover:bg-accent rounded"><RefreshCw className={cn('w-3.5 h-3.5', loadingProcesses && 'animate-spin')} /></button>}
            </div>
          </div>
          {showProcesses && (
            <div className="max-h-[350px] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 w-8"><button onClick={() => { if (selectedPids.size === processes.length) setSelectedPids(new Set()); else setSelectedPids(new Set(processes.map(p => p.pid))) }} className="p-0.5 hover:bg-accent rounded">
                      {selectedPids.size === processes.length && processes.length > 0 ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5" />}
                    </button></th>
                    <SortHeader label="PID" sortKey="pid" active={processSort.key === 'pid'} dir={processSort.dir} onClick={() => toggleProcessSort('pid')} className="text-left" />
                    <SortHeader label="用户" sortKey="user" active={processSort.key === 'user'} dir={processSort.dir} onClick={() => toggleProcessSort('user')} className="text-left" />
                    <SortHeader label="CPU%" sortKey="cpu" active={processSort.key === 'cpu'} dir={processSort.dir} onClick={() => toggleProcessSort('cpu')} className="text-right" />
                    <SortHeader label="内存%" sortKey="mem" active={processSort.key === 'mem'} dir={processSort.dir} onClick={() => toggleProcessSort('mem')} className="text-right" />
                    <SortHeader label="RSS" sortKey="rss" active={processSort.key === 'rss'} dir={processSort.dir} onClick={() => toggleProcessSort('rss')} className="text-right" />
                    <SortHeader label="命令" sortKey="command" active={processSort.key === 'command'} dir={processSort.dir} onClick={() => toggleProcessSort('command')} className="text-left" />
                    <th className="text-center px-3 py-2 font-medium w-20">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedProcesses.map((proc) => (
                    <tr key={proc.pid} className="hover:bg-accent/50 transition-colors">
                      <td className="px-3 py-1.5"><button onClick={() => togglePidSelect(proc.pid)} className="p-0.5">
                        {selectedPids.has(proc.pid) ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5 text-muted-foreground" />}
                      </button></td>
                      <td className="px-3 py-1.5 font-mono">{proc.pid}</td>
                      <td className="px-3 py-1.5">{proc.user}</td>
                      <td className="px-3 py-1.5 text-right"><span className={cn(proc.cpu > 50 && 'text-yellow-500', proc.cpu > 80 && 'text-destructive')}>{proc.cpu.toFixed(1)}</span></td>
                      <td className="px-3 py-1.5 text-right">{proc.mem.toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{formatBytes(proc.rss * 1024)}</td>
                      <td className="px-3 py-1.5 max-w-[250px] truncate font-mono text-xs">{proc.command}</td>
                      <td className="px-3 py-1.5 text-center">
                        <div className="flex items-center justify-center gap-0.5">
                          <button onClick={() => handleKillProcess(proc.pid, 15)} className="p-1 hover:bg-yellow-500/20 rounded transition-colors" title="优雅关闭 (SIGTERM)">
                            <X className="w-3.5 h-3.5 text-yellow-500" />
                          </button>
                          <button onClick={() => handleKillProcess(proc.pid, 9)} className="p-1 hover:bg-destructive/20 rounded transition-colors" title="强制杀死 (SIGKILL)">
                            <Skull className="w-3.5 h-3.5 text-destructive" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const GaugeCard = React.memo(function GaugeCard({ icon: Icon, label, value, percent, color, details }: {
  icon: any; label: string; value: string; percent: number; color: string; details?: string
}) {
  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-1.5"><Icon className="w-3.5 h-3.5" style={{ color }} /><span className="text-xs font-medium">{label}</span></div>
      <div className="flex items-end gap-2 mb-1.5"><span className="text-xl font-bold" style={{ color }}>{percent}%</span><span className="text-xs text-muted-foreground mb-0.5">{value}</span></div>
      <div className="h-1.5 bg-secondary rounded-full overflow-hidden"><div className="h-full rounded-full transition-all duration-500" style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: color }} /></div>
      {details && <p className="text-xs text-muted-foreground mt-2">{details}</p>}
    </div>
  )
})
