import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Cpu, MemoryStick, HardDrive, Network, Activity, ArrowUp, ArrowDown,
  Server, Copy, ChevronLeft, ChevronRight as ChevronRightIcon, ExternalLink
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip,
  LineChart, Line
} from 'recharts'
import { cn, formatBytes, formatBytesPerSec } from '../../lib/utils'

interface MonitorData {
  cpu: number
  memory: { used: number; total: number; percent: number }
  swap: { used: number; total: number; percent: number }
  disks: { filesystem: string; mountPoint: string; used: number; total: number; percent: number }[]
  network: { rx: number; tx: number; interfaces?: { name: string; rx: number; tx: number }[] }
  loadAvg: number[]
  uptime?: string
  topCpu: { pid: number; user: string; cpu: number; mem: number; rss: number; command: string }[]
  topMem: { pid: number; user: string; cpu: number; mem: number; rss: number; command: string }[]
  timestamp?: number
}

interface SystemInfo {
  hostname: string; os: string; kernel: string; cpuCores: number; arch: string
}

interface MonitorPanelProps {
  sessionId: string
}

const MAX_DATA_POINTS = 60
const PANEL_MODULES = {
  systemInfo: true, cpu: true, memory: true, swap: true,
  disks: true, network: true, topCpu: true, topMem: true,
  processes: false, gpu: false, ports: false
}

export function MonitorPanel({ sessionId }: MonitorPanelProps) {
  const [currentData, setCurrentData] = useState<MonitorData | null>(null)
  const [history, setHistory] = useState<MonitorData[]>([])
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null)
  const [processTab, setProcessTab] = useState<'mem' | 'cpu'>('mem')
  const [collapsed, setCollapsed] = useState(false)
  const [selectedInterface, setSelectedInterface] = useState<string>('all')

  // Buffer to batch monitor updates per animation frame
  const pendingDataRef = useRef<MonitorData | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    window.api.monitor.start(sessionId, 3000, PANEL_MODULES)
    window.api.monitor.getSystemInfo(sessionId).then((r: any) => {
      if (r.success) setSysInfo(r.info)
    })

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
  }, [sessionId])

  const displayedNetwork = useMemo(() => {
    if (!currentData) return { rx: 0, tx: 0 }
    if (selectedInterface === 'all') return { rx: currentData.network.rx, tx: currentData.network.tx }
    const iface = currentData.network.interfaces?.find((i) => i.name === selectedInterface)
    return iface ? { rx: iface.rx, tx: iface.tx } : { rx: 0, tx: 0 }
  }, [currentData, selectedInterface])

  const chartData = useMemo(() => history.map((d, i) => {
    if (selectedInterface === 'all') {
      return { time: i, networkRx: d.network.rx, networkTx: d.network.tx }
    }
    const iface = d.network.interfaces?.find((f) => f.name === selectedInterface)
    return { time: i, networkRx: iface?.rx || 0, networkTx: iface?.tx || 0 }
  }), [history, selectedInterface])

  const handleCopyIP = useCallback(() => {
    if (sysInfo?.hostname) {
      navigator.clipboard.writeText(sysInfo.hostname)
    }
  }, [sysInfo])

  const handleOpenDetailed = useCallback(() => {
    window.dispatchEvent(new CustomEvent('app:openDetailedMonitor', {
      detail: { sessionId }
    }))
  }, [sessionId])

  if (collapsed) {
    return (
      <div className="flex flex-col items-center w-8 bg-card border-r border-border py-2 shrink-0">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1 hover:bg-accent rounded transition-colors"
          title="展开监控面板"
        >
          <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
        </button>
        <div className="mt-2 writing-mode-vertical text-xs text-muted-foreground select-none"
             style={{ writingMode: 'vertical-rl' }}>
          监控
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col w-[280px] bg-card border-r border-border shrink-0 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Activity className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-medium">服务器监控</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button onClick={handleOpenDetailed} className="p-1 hover:bg-accent rounded transition-colors" title="更多详情">
            <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
          <button onClick={() => setCollapsed(true)} className="p-1 hover:bg-accent rounded transition-colors" title="收起">
            <ChevronLeft className="w-3.5 h-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3">
        {/* Loading state */}
        {!currentData && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Activity className="w-6 h-6 mb-2 animate-pulse" />
            <p className="text-xs">正在收集数据...</p>
          </div>
        )}

        {currentData && (
          <>
            {/* System Info */}
            {sysInfo && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Server className="w-3 h-3 text-primary" />
                    <span className="text-xs font-medium truncate">{sysInfo.hostname}</span>
                  </div>
                  <button onClick={handleCopyIP} className="p-0.5 hover:bg-accent rounded" title="复制">
                    <Copy className="w-3 h-3 text-muted-foreground" />
                  </button>
                </div>
                <div className="text-[10px] text-muted-foreground leading-relaxed">
                  {sysInfo.os} | {sysInfo.cpuCores}核 {sysInfo.arch}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  运行 {currentData.uptime} | 负载 {currentData.loadAvg?.map(v => v?.toFixed(2)).join(', ')}
                </div>
              </div>
            )}

            {/* CPU Bar */}
            <MetricBar
              icon={Cpu}
              label="CPU"
              percent={currentData.cpu}
              detail={`${currentData.cpu}%`}
              color="#3b82f6"
            />

            {/* Memory Bar */}
            <MetricBar
              icon={MemoryStick}
              label="内存"
              percent={currentData.memory.percent}
              detail={`${formatBytes(currentData.memory.used)} / ${formatBytes(currentData.memory.total)}`}
              color="#10b981"
            />

            {/* Swap Bar */}
            <MetricBar
              icon={MemoryStick}
              label="交换"
              percent={currentData.swap.percent}
              detail={currentData.swap.total > 0
                ? `${formatBytes(currentData.swap.used)} / ${formatBytes(currentData.swap.total)}`
                : '未启用'
              }
              color="#f97316"
            />

            {/* Process Tabs */}
            <div>
              <div className="flex items-center gap-0.5 mb-1.5">
                <button
                  onClick={() => setProcessTab('mem')}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] transition-colors',
                    processTab === 'mem' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  )}
                >
                  内存
                </button>
                <button
                  onClick={() => setProcessTab('cpu')}
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] transition-colors',
                    processTab === 'cpu' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
                  )}
                >
                  CPU
                </button>
              </div>
              <div className="max-h-[140px] overflow-y-auto">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-card text-muted-foreground">
                    <tr>
                      <th className="text-right px-1 py-0.5 font-medium w-12">
                        {processTab === 'mem' ? '内存' : 'CPU'}
                      </th>
                      <th className="text-right px-1 py-0.5 font-medium w-10">
                        {processTab === 'mem' ? 'CPU' : '内存'}
                      </th>
                      <th className="text-left px-1 py-0.5 font-medium">进程</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(processTab === 'mem' ? currentData.topMem : currentData.topCpu)?.slice(0, 8).map((p) => (
                      <tr key={p.pid} className="hover:bg-accent/50">
                        <td className="px-1 py-0.5 text-right font-mono">
                          {processTab === 'mem' ? `${formatBytes(p.rss)}` : `${p.cpu.toFixed(1)}`}
                        </td>
                        <td className="px-1 py-0.5 text-right font-mono text-muted-foreground">
                          {processTab === 'mem' ? p.cpu.toFixed(1) : p.mem.toFixed(1)}
                        </td>
                        <td className="px-1 py-0.5 truncate max-w-[140px]" title={p.command}>
                          {p.command}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Network */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1">
                  <Network className="w-3 h-3 text-purple-500" />
                  <span className="text-[10px] font-medium">网络</span>
                  <select
                    value={selectedInterface}
                    onChange={(e) => setSelectedInterface(e.target.value)}
                    className="ml-1 px-1 py-0 text-[10px] bg-background border border-input rounded outline-none cursor-pointer"
                    style={{ width: 64 }}
                  >
                    <option value="all">全部</option>
                    {currentData.network.interfaces?.map((iface) => (
                      <option key={iface.name} value={iface.name}>{iface.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-1 text-[10px] font-mono">
                  <span className="flex items-center gap-0.5 text-blue-400" style={{ minWidth: 62, justifyContent: 'flex-end' }}>
                    <ArrowDown className="w-2.5 h-2.5 shrink-0" />
                    {formatBytesPerSec(displayedNetwork.rx)}
                  </span>
                  <span className="flex items-center gap-0.5 text-yellow-400" style={{ minWidth: 62, justifyContent: 'flex-end' }}>
                    <ArrowUp className="w-2.5 h-2.5 shrink-0" />
                    {formatBytesPerSec(displayedNetwork.tx)}
                  </span>
                </div>
              </div>
              <div style={{ height: 70 }}>
                {chartData.length > 1 ? (
                  <ResponsiveContainer width="100%" height={70}>
                    <LineChart data={chartData}>
                      <XAxis dataKey="time" hide />
                      <YAxis
                        tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }}
                        tickFormatter={(v) => formatBytes(v)}
                        width={48}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: '6px',
                          fontSize: '10px',
                          padding: '4px 8px'
                        }}
                        formatter={(v: number, n: string) => [
                          formatBytesPerSec(v),
                          n === 'networkRx' ? '↓接收' : '↑发送'
                        ]}
                      />
                      <Line type="monotone" dataKey="networkRx" stroke="#3b82f6" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="networkTx" stroke="#f59e0b" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex items-center justify-center h-full text-[10px] text-muted-foreground">
                    等待数据...
                  </div>
                )}
              </div>
            </div>

            {/* Disks */}
            {currentData.disks && currentData.disks.length > 0 && (
              <div>
                <div className="flex items-center gap-1 mb-1.5">
                  <HardDrive className="w-3 h-3 text-yellow-500" />
                  <span className="text-[10px] font-medium">磁盘</span>
                </div>
                <div className="space-y-1.5 max-h-[120px] overflow-y-auto">
                  {currentData.disks.map((d, i) => (
                    <div key={i} className="text-[10px]">
                      <div className="flex items-center justify-between mb-0.5">
                        <span className="truncate max-w-[120px]" title={d.mountPoint}>{d.mountPoint}</span>
                        <span className="text-muted-foreground shrink-0 ml-1">
                          {formatBytes(d.used)}/{formatBytes(d.total)}
                        </span>
                      </div>
                      <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{
                            width: `${Math.min(d.percent, 100)}%`,
                            backgroundColor: d.percent > 90 ? '#ef4444' : d.percent > 70 ? '#f59e0b' : '#10b981'
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function MetricBar({ icon: Icon, label, percent, detail, color }: {
  icon: any; label: string; percent: number; detail: string; color: string
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-0.5">
        <div className="flex items-center gap-1">
          <Icon className="w-3 h-3" style={{ color }} />
          <span className="text-[10px] font-medium">{label}</span>
        </div>
        <span className="text-[10px] font-mono font-bold" style={{ color }}>{percent}%</span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden mb-0.5">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: color }}
        />
      </div>
      <div className="text-[10px] text-muted-foreground">{detail}</div>
    </div>
  )
}
