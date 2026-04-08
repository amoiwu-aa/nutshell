import { BrowserWindow } from 'electron'
import { sshManager } from '../ssh/SSHManager'
import { rustCoreService } from '../rust/RustCoreService'

export interface DiskInfo {
  filesystem: string
  mountPoint: string
  used: number
  total: number
  percent: number
}

export interface TopProcess {
  pid: number
  user: string
  cpu: number
  mem: number
  rss: number
  command: string
}

export interface GpuInfo {
  name: string
  temperature: number
  utilization: number
  memoryUsed: number
  memoryTotal: number
  fanSpeed: number
  powerDraw: number
}

export interface PortInfo {
  protocol: string
  localAddr: string
  port: number
  pid: number
  process: string
  state: string
}

export interface MonitorData {
  cpu: number
  memory: { used: number; total: number; percent: number }
  swap: { used: number; total: number; percent: number }
  disks: DiskInfo[]
  network: { rx: number; tx: number; interfaces: { name: string; rx: number; tx: number }[] }
  loadAvg: number[]
  uptime: string
  topCpu: TopProcess[]
  topMem: TopProcess[]
  gpus: GpuInfo[]
}

export interface SystemInfo {
  hostname: string
  os: string
  kernel: string
  cpuCores: number
  arch: string
}

export interface ProcessInfo {
  pid: number
  user: string
  cpu: number
  mem: number
  vsz: number
  rss: number
  command: string
}

export interface MonitorModules {
  systemInfo: boolean
  cpu: boolean
  memory: boolean
  swap: boolean
  disks: boolean
  network: boolean
  topCpu: boolean
  topMem: boolean
  processes: boolean
  gpu: boolean
  ports: boolean
}

const DEFAULT_MODULES: MonitorModules = {
  systemInfo: true, cpu: true, memory: true, swap: true,
  disks: true, network: true, topCpu: true, topMem: true,
  processes: true, gpu: true, ports: true
}

interface CpuSnapshot { total: number; idle: number }

interface RustMonitorSnapshot {
  serverTime: string
  cpu: string
  loadavg: string
  uptime: string
  memory: string
  network: string
}

// Cached slow-poll data (disks, GPU, ps aux) — re-running expensive commands every tick is wasteful
interface SlowCache {
  disks: DiskInfo[]
  topCpu: TopProcess[]
  topMem: TopProcess[]
  gpus: GpuInfo[]
}

class ServerMonitor {
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map()
  private prevNetworkStats: Map<string, { time: number; total: { rx: number; tx: number }; interfaces: Map<string, { rx: number; tx: number }> }> = new Map()
  private prevCpuStats: Map<string, CpuSnapshot> = new Map()
  private enabledModules: Map<string, MonitorModules> = new Map()
  private subscriberCounts: Map<string, number> = new Map()
  private startingSessions: Set<string> = new Set()
  private inFlightSessions: Set<string> = new Set()
  private consecutiveFailures: Map<string, number> = new Map()
  private readonly maxConsecutiveFailures = 3

  // Slow-poll cache: expensive commands (df, ps aux, nvidia-smi) run every Nth tick
  private slowCache: Map<string, SlowCache> = new Map()
  private tickCounters: Map<string, number> = new Map()
  private readonly slowPollInterval = 3 // run slow commands every 3rd tick (~9s at 3s interval)

  async start(sessionId: string, intervalMs: number = 3000, modules?: MonitorModules): Promise<void> {
    const subscriberCount = this.subscriberCounts.get(sessionId) || 0
    this.subscriberCounts.set(sessionId, subscriberCount + 1)
    this.enabledModules.set(sessionId, modules || DEFAULT_MODULES)

    if (subscriberCount > 0 && (this.intervals.has(sessionId) || this.startingSessions.has(sessionId))) {
      return
    }
    this.startingSessions.add(sessionId)

    try {
      await this.collectAndSend(sessionId)
      this.consecutiveFailures.set(sessionId, 0)
    } catch (err: any) {
      const failures = (this.consecutiveFailures.get(sessionId) || 0) + 1
      this.consecutiveFailures.set(sessionId, failures)
      this.notifyError(sessionId, err?.message || 'Failed to collect initial data')
      if (failures >= this.maxConsecutiveFailures) {
        this.stop(sessionId, true)
      }
    }

    if ((this.subscriberCounts.get(sessionId) || 0) <= 0) {
      this.startingSessions.delete(sessionId)
      return
    }

    if (this.intervals.has(sessionId)) {
      this.startingSessions.delete(sessionId)
      return
    }

    const timer = setInterval(async () => {
      if (this.inFlightSessions.has(sessionId)) return
      this.inFlightSessions.add(sessionId)
      try {
        await this.collectAndSend(sessionId)
        this.consecutiveFailures.set(sessionId, 0)
      } catch (error: any) {
        const failures = (this.consecutiveFailures.get(sessionId) || 0) + 1
        this.consecutiveFailures.set(sessionId, failures)
        this.notifyError(sessionId, error?.message || '监控采集失败')
        if (failures >= this.maxConsecutiveFailures) {
          this.stop(sessionId, true)
        }
      } finally {
        this.inFlightSessions.delete(sessionId)
      }
    }, intervalMs)

    this.intervals.set(sessionId, timer)
    this.startingSessions.delete(sessionId)
  }

  updateModules(sessionId: string, modules: MonitorModules): void {
    this.enabledModules.set(sessionId, modules)
  }

  stop(sessionId: string, force: boolean = false): void {
    if (!force) {
      const subscriberCount = this.subscriberCounts.get(sessionId) || 0
      if (subscriberCount > 1) {
        this.subscriberCounts.set(sessionId, subscriberCount - 1)
        return
      }
    }
    this.subscriberCounts.delete(sessionId)
    this.stopTracking(sessionId)
  }

  private stopTracking(sessionId: string): void {
    const timer = this.intervals.get(sessionId)
    if (timer) {
      clearInterval(timer)
      this.intervals.delete(sessionId)
    }
    this.startingSessions.delete(sessionId)
    this.inFlightSessions.delete(sessionId)
    this.consecutiveFailures.delete(sessionId)
    this.prevNetworkStats.delete(sessionId)
    this.prevCpuStats.delete(sessionId)
    this.enabledModules.delete(sessionId)
    this.slowCache.delete(sessionId)
    this.tickCounters.delete(sessionId)
  }

  private async exec(sessionId: string, command: string, timeoutMs: number = 15000): Promise<string> {
    if (sshManager.isConnected(sessionId)) {
      return sshManager.exec(sessionId, command, timeoutMs)
    }

    if (!rustCoreService.hasSshSession(sessionId)) {
      throw new Error('Session not connected')
    }

    const result = await rustCoreService.runCommand({
      sessionId,
      command,
      timeoutMs,
      requireConfirmation: true
    })

    if (result.blocked) {
      throw new Error(result.reason || '命令执行被安全策略阻止')
    }

    return [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '')
  }

  private async collectAndSend(sessionId: string): Promise<void> {
    if (!sshManager.isConnected(sessionId) && !rustCoreService.hasSshSession(sessionId)) {
      this.stop(sessionId, true)
      return
    }

    const data = await this.collectData(sessionId)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('monitor:data', sessionId, data)
    }
  }

  /**
   * Check if slow (expensive) commands should run this tick.
   * Slow commands: df, ps aux, nvidia-smi — run every Nth tick.
   * On the first tick (no cache), always run slow commands.
   */
  private shouldRunSlowCommands(sessionId: string): boolean {
    const tick = (this.tickCounters.get(sessionId) || 0) + 1
    this.tickCounters.set(sessionId, tick)
    // First tick or every Nth tick
    return !this.slowCache.has(sessionId) || tick % this.slowPollInterval === 0
  }

  // --- Shared parsing helpers ---

  private parseCpu(cpuLine: string, sessionId: string): number {
    const cpuValues = cpuLine.replace(/^cpu\s+/, '').split(/\s+/).map(Number)
    const cpuTotal = cpuValues.reduce((a, b) => a + (isNaN(b) ? 0 : b), 0)
    const cpuIdle = cpuValues[3] || 0

    let cpuPercent = 0
    const prevCpu = this.prevCpuStats.get(sessionId)
    if (prevCpu) {
      const totalDelta = cpuTotal - prevCpu.total
      const idleDelta = cpuIdle - prevCpu.idle
      if (totalDelta > 0) {
        cpuPercent = Math.round(((totalDelta - idleDelta) / totalDelta) * 100)
        cpuPercent = Math.max(0, Math.min(100, cpuPercent))
      }
    }
    this.prevCpuStats.set(sessionId, { total: cpuTotal, idle: cpuIdle })
    return cpuPercent
  }

  private parseMemory(memOutput: string): { memUsed: number; memTotal: number; memPercent: number; swapUsed: number; swapTotal: number; swapPercent: number } {
    let memUsed = 0, memTotal = 0, memPercent = 0
    let swapUsed = 0, swapTotal = 0, swapPercent = 0
    if (!memOutput) return { memUsed, memTotal, memPercent, swapUsed, swapTotal, swapPercent }

    if (memOutput.includes('MemTotal:')) {
      let memFree = 0, memAvailable = 0, buffers = 0, cached = 0, swapFree = 0
      for (const line of memOutput.split('\n')) {
        const [key, valStr] = line.split(':').map((s: string) => s.trim())
        if (!valStr) continue
        const val = parseInt(valStr) * 1024
        const k = key.toLowerCase()
        if (k === 'memtotal') memTotal = val
        else if (k === 'memfree') memFree = val
        else if (k === 'memavailable') memAvailable = val
        else if (k === 'buffers') buffers = val
        else if (k === 'cached') cached = val
        else if (k === 'swaptotal') swapTotal = val
        else if (k === 'swapfree') swapFree = val
      }
      memUsed = memAvailable > 0 ? memTotal - memAvailable : Math.max(0, memTotal - memFree - buffers - cached)
      memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0
      swapUsed = Math.max(0, swapTotal - swapFree)
      swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0
    } else {
      const isBytes = memOutput.includes('-b') || memOutput.includes('bytes')
      const mult = isBytes ? 1 : 1024
      for (const line of memOutput.split('\n')) {
        const cols = line.split(/\s+/)
        if (/^mem:?/i.test(cols[0])) {
          memTotal = (parseInt(cols[1]) || 0) * mult
          memUsed = (parseInt(cols[2]) || 0) * mult
          memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0
        } else if (/^swap:?/i.test(cols[0])) {
          swapTotal = (parseInt(cols[1]) || 0) * mult
          swapUsed = (parseInt(cols[2]) || 0) * mult
          swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0
        }
      }
    }
    return { memUsed, memTotal, memPercent, swapUsed, swapTotal, swapPercent }
  }

  private parseDisks(disksOutput: string): DiskInfo[] {
    const disks: DiskInfo[] = []
    if (!disksOutput) return disks
    for (const line of disksOutput.split('\n')) {
      if (!line.trim()) continue
      const cols = line.split(/\s+/)
      if (cols.length >= 6) {
        const dTotal = parseInt(cols[1]) || 0
        const dUsed = parseInt(cols[2]) || 0
        disks.push({
          filesystem: cols[0], mountPoint: cols[5],
          used: dUsed, total: dTotal,
          percent: dTotal > 0 ? Math.round((dUsed / dTotal) * 100) : 0
        })
      }
    }
    return disks
  }

  private parseProcesses(raw: string): TopProcess[] {
    if (!raw) return []
    return raw.split('\n').slice(1).filter((l) => l.trim()).map((l) => {
      const p = l.split(/\s+/)
      return { pid: parseInt(p[1]) || 0, user: p[0] || '', cpu: parseFloat(p[2]) || 0, mem: parseFloat(p[3]) || 0, rss: (parseInt(p[5]) || 0) * 1024, command: p.slice(10).join(' ') }
    })
  }

  private parseGpus(gpuOutput: string): GpuInfo[] {
    const gpus: GpuInfo[] = []
    if (!gpuOutput) return gpus
    for (const line of gpuOutput.split('\n')) {
      if (!line.trim()) continue
      const cols = line.split(',').map((s) => s.trim())
      if (cols.length >= 7) {
        gpus.push({
          name: cols[0],
          temperature: parseFloat(cols[1]) || 0,
          utilization: parseFloat(cols[2]) || 0,
          memoryUsed: parseFloat(cols[3]) || 0,
          memoryTotal: parseFloat(cols[4]) || 0,
          fanSpeed: parseFloat(cols[5]) || 0,
          powerDraw: parseFloat(cols[6]) || 0
        })
      }
    }
    return gpus
  }

  private parseNetwork(netOutput: string, serverTime: number, sessionId: string): { rxRate: number; txRate: number; interfaceRates: { name: string; rx: number; tx: number }[] } {
    let rxRate = 0, txRate = 0
    const interfaceRates: { name: string; rx: number; tx: number }[] = []
    if (!netOutput) return { rxRate, txRate, interfaceRates }

    const prevStats = this.prevNetworkStats.get(sessionId)
    const timeDiff = prevStats ? (serverTime - prevStats.time) : 0

    let totalRx = 0, totalTx = 0
    const currentInterfaces = new Map<string, { rx: number; tx: number }>()

    for (const line of netOutput.split('\n')) {
      const cols = line.trim().split(/\s+/)
      if (cols.length >= 3) {
        const name = cols[0]
        const rx = parseInt(cols[1]) || 0
        const tx = parseInt(cols[2]) || 0
        currentInterfaces.set(name, { rx, tx })

        const isVirtual = /^(docker|veth|br-|cali|flannel|cni|virbr|lxc)/i.test(name)
        if (!isVirtual) {
          totalRx += rx
          totalTx += tx
        }

        if (prevStats && timeDiff > 0.1) {
          const prevIface = prevStats.interfaces.get(name)
          if (prevIface) {
            interfaceRates.push({
              name,
              rx: Math.max(0, (rx - prevIface.rx) / timeDiff),
              tx: Math.max(0, (tx - prevIface.tx) / timeDiff)
            })
          } else {
            interfaceRates.push({ name, rx: 0, tx: 0 })
          }
        } else {
          interfaceRates.push({ name, rx: 0, tx: 0 })
        }
      }
    }

    if (prevStats && timeDiff > 0.1) {
      rxRate = Math.max(0, (totalRx - prevStats.total.rx) / timeDiff)
      txRate = Math.max(0, (totalTx - prevStats.total.tx) / timeDiff)
    }

    this.prevNetworkStats.set(sessionId, {
      time: serverTime,
      total: { rx: totalRx, tx: totalTx },
      interfaces: currentInterfaces
    })

    return { rxRate, txRate, interfaceRates }
  }

  private parseNetworkRaw(netOutput: string, serverTime: number, sessionId: string): { rxRate: number; txRate: number; interfaceRates: { name: string; rx: number; tx: number }[] } {
    let rxRate = 0, txRate = 0
    const interfaceRates: { name: string; rx: number; tx: number }[] = []
    if (!netOutput) return { rxRate, txRate, interfaceRates }

    const prevStats = this.prevNetworkStats.get(sessionId)
    const timeDiff = prevStats ? (serverTime - prevStats.time) : 0

    let totalRx = 0, totalTx = 0
    const currentInterfaces = new Map<string, { rx: number; tx: number }>()

    for (const line of netOutput.split('\n').slice(2)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('lo:')) continue
      const cols = trimmed.replace(':', ' ').split(/\s+/)
      if (cols.length >= 10) {
        const name = cols[0]
        const rx = parseInt(cols[1]) || 0
        const tx = parseInt(cols[9]) || 0
        currentInterfaces.set(name, { rx, tx })

        const isVirtual = /^(docker|veth|br-|cali|flannel|cni|virbr|lxc)/i.test(name)
        if (!isVirtual) {
          totalRx += rx
          totalTx += tx
        }

        if (prevStats && timeDiff > 0.1) {
          const prevIface = prevStats.interfaces.get(name)
          if (prevIface) {
            interfaceRates.push({
              name,
              rx: Math.max(0, (rx - prevIface.rx) / timeDiff),
              tx: Math.max(0, (tx - prevIface.tx) / timeDiff)
            })
          } else {
            interfaceRates.push({ name, rx: 0, tx: 0 })
          }
        } else {
          interfaceRates.push({ name, rx: 0, tx: 0 })
        }
      }
    }

    if (prevStats && timeDiff > 0.1) {
      rxRate = Math.max(0, (totalRx - prevStats.total.rx) / timeDiff)
      txRate = Math.max(0, (totalTx - prevStats.total.tx) / timeDiff)
    }

    this.prevNetworkStats.set(sessionId, {
      time: serverTime,
      total: { rx: totalRx, tx: totalTx },
      interfaces: currentInterfaces
    })

    return { rxRate, txRate, interfaceRates }
  }

  // --- Main collection ---

  private async collectData(sessionId: string): Promise<MonitorData> {
    const mod = this.enabledModules.get(sessionId) || DEFAULT_MODULES

    if (rustCoreService.hasSshSession(sessionId)) {
      try {
        return await this.collectDataViaRustSnapshot(sessionId, mod)
      } catch {
        // Fall back to command-based collection below
      }
    }

    const runSlow = this.shouldRunSlowCommands(sessionId)
    const needTopProcesses = mod.topCpu || mod.topMem

    // === Build Fast Metrics Batch (lightweight reads, <20ms each) ===
    const fastCommands: string[] = []
    const fastCmdMap: string[] = []

    fastCommands.push(`cat /proc/uptime`)
    fastCmdMap.push('serverTime')
    fastCommands.push(`grep 'cpu ' /proc/stat`)
    fastCmdMap.push('cpu')
    fastCommands.push(`cat /proc/loadavg`)
    fastCmdMap.push('loadavg')
    fastCommands.push(`uptime -p 2>/dev/null || uptime`)
    fastCmdMap.push('uptime')

    if (mod.memory || mod.swap) {
      fastCommands.push(`cat /proc/meminfo 2>/dev/null || free -b 2>/dev/null || free 2>/dev/null`)
      fastCmdMap.push('memory')
    }

    if (mod.network) {
      fastCommands.push(`awk 'NR>2 && $1!~"lo:" {gsub(/:/, "", $1); print $1, $2, $10}' /proc/net/dev`)
      fastCmdMap.push('network')
    }

    const fastCombined = fastCommands.join(' ; echo "---SEP---" ; ')
    const fastPromise = this.exec(sessionId, fastCombined)

    // === Trigger Slow Metrics Background Batch (~300-800ms) ===
    if (runSlow) {
      const slowCommands: string[] = []
      const slowCmdMap: string[] = []

      if (mod.disks) {
        slowCommands.push(`df -B1 -x tmpfs -x devtmpfs -x overlay 2>/dev/null | tail -n +2`)
        slowCmdMap.push('disks')
      }

      if (needTopProcesses) {
        const topN = (mod as any).topCount || 10
        const fetchCount = Math.max(topN * 2, 50) + 1
        slowCommands.push(`ps aux --sort=-%cpu | head -${fetchCount}`)
        slowCmdMap.push('psUnified')
      }

      if (mod.gpu) {
        slowCommands.push(`nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw --format=csv,noheader,nounits 2>/dev/null || echo ""`)
        slowCmdMap.push('gpu')
      }

      if (slowCommands.length > 0) {
        const slowCombined = slowCommands.join(' ; echo "---SEP---" ; ')
        // Fire and forget (it will update cache) - fast ticks don't block
        this.exec(sessionId, slowCombined).then((slowOutput) => {
          const parts = slowOutput.split('---SEP---').map((s) => s.trim())
          const getPart = (name: string): string => {
            const idx = slowCmdMap.indexOf(name)
            return idx >= 0 ? (parts[idx] || '') : ''
          }
          const allProcs = this.parseProcesses(getPart('psUnified'))
          const topN = (mod as any).topCount || 10
          
          this.slowCache.set(sessionId, {
            disks: this.parseDisks(getPart('disks')),
            topCpu: needTopProcesses ? [...allProcs].sort((a, b) => b.cpu - a.cpu).slice(0, topN) : [],
            topMem: needTopProcesses ? [...allProcs].sort((a, b) => b.mem - a.mem).slice(0, topN) : [],
            gpus: this.parseGpus(getPart('gpu'))
          })
          
          // Optionally push cache immediately
          if (this.subscriberCounts.get(sessionId) && this.subscriberCounts.get(sessionId)! > 0) {
            this.sendCurrentCacheState(sessionId, mod)
          }
        }).catch(() => {})
      }
    }

    // Await fast metrics
    const fastOutput = await fastPromise
    const fastParts = fastOutput.split('---SEP---').map((s) => s.trim())
    const getFastPart = (name: string): string => {
      const idx = fastCmdMap.indexOf(name)
      return idx >= 0 ? (fastParts[idx] || '') : ''
    }

    // --- Parse fast metrics ---
    const cpuPercent = this.parseCpu(getFastPart('cpu'), sessionId)
    const mem = this.parseMemory(getFastPart('memory'))
    const serverTimeOutput = getFastPart('serverTime')
    const serverTime = parseFloat(serverTimeOutput.split(/\s+/)[0]) || (Date.now() / 1000)
    const net = this.parseNetwork(getFastPart('network'), serverTime, sessionId)

    const loadLine = getFastPart('loadavg')
    const loadParts = loadLine.split(/\s+/)
    const loadAvg = loadParts.slice(0, 3).map((v: string) => { const n = parseFloat(v); return isNaN(n) ? 0 : n })
    const uptime = getFastPart('uptime') || 'unknown'

    // Save fast attributes context so `sendCurrentCacheState` can reuse it for live push
    this.latestFastContext.set(sessionId, {
      cpu: cpuPercent,
      memory: { used: mem.memUsed, total: mem.memTotal, percent: mem.memPercent },
      swap: { used: mem.swapUsed, total: mem.swapTotal, percent: mem.swapPercent },
      network: { rx: net.rxRate, tx: net.txRate, interfaces: net.interfaceRates },
      loadAvg,
      uptime
    })

    const cached = this.slowCache.get(sessionId) || { disks: [], topCpu: [], topMem: [], gpus: [] }

    return {
      ...this.latestFastContext.get(sessionId)!,
      disks: cached.disks,
      topCpu: cached.topCpu,
      topMem: cached.topMem,
      gpus: cached.gpus
    }
  }

  // Used by Rust path and async Slow commands update
  private latestFastContext: Map<string, Omit<MonitorData, 'disks'|'topCpu'|'topMem'|'gpus'>> = new Map()

  private sendCurrentCacheState(sessionId: string, mod: MonitorModules) {
    const fast = this.latestFastContext.get(sessionId)
    if (!fast) return
    const cached = this.slowCache.get(sessionId) || { disks: [], topCpu: [], topMem: [], gpus: [] }
    const data: MonitorData = {
      ...fast,
      disks: cached.disks,
      topCpu: cached.topCpu,
      topMem: cached.topMem,
      gpus: cached.gpus
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('monitor:data', sessionId, data)
    }
  }

  private async collectDataViaRustSnapshot(sessionId: string, mod: MonitorModules): Promise<MonitorData> {
    const runSlow = this.shouldRunSlowCommands(sessionId)
    const needTopProcesses = mod.topCpu || mod.topMem

    const snapshot = await rustCoreService.monitorSnapshot({ sessionId })

    // --- Parse fast metrics from snapshot ---
    const cpuPercent = mod.cpu ? this.parseCpu(snapshot.cpu || '', sessionId) : 0
    const mem = this.parseMemory(snapshot.memory || '')
    const serverTime = parseFloat((snapshot.serverTime || '').split(/\s+/)[0]) || (Date.now() / 1000)
    const net = mod.network
      ? this.parseNetworkRaw(snapshot.network || '', serverTime, sessionId)
      : { rxRate: 0, txRate: 0, interfaceRates: [] as { name: string; rx: number; tx: number }[] }

    const loadParts = (snapshot.loadavg || '').split(/\s+/)
    const loadAvg = loadParts.slice(0, 3).map((v: string) => { const n = parseFloat(v); return isNaN(n) ? 0 : n })
    const uptime = snapshot.uptime || 'unknown'

    // --- Slow commands via SSH exec (only on slow-poll ticks, asynchronous) ---
    if (runSlow) {
      const commands: string[] = []
      const cmdMap: string[] = []

      if (mod.disks) {
        commands.push(`df -B1 -x tmpfs -x devtmpfs -x overlay 2>/dev/null | tail -n +2`)
        cmdMap.push('disks')
      }

      if (needTopProcesses) {
        const topN = (mod as any).topCount || 10
        const fetchCount = Math.max(topN * 2, 50) + 1
        commands.push(`ps aux --sort=-%cpu | head -${fetchCount}`)
        cmdMap.push('psUnified')
      }

      if (mod.gpu) {
        commands.push(`nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw --format=csv,noheader,nounits 2>/dev/null || echo ""`)
        cmdMap.push('gpu')
      }

      if (commands.length > 0) {
        this.exec(sessionId, commands.join(' ; echo "---SEP---" ; ')).then((fallbackOutput) => {
          const parts = fallbackOutput.split('---SEP---').map((s) => s.trim())
          const getPart = (name: string): string => {
            const idx = cmdMap.indexOf(name)
            return idx >= 0 ? (parts[idx] || '') : ''
          }

          const topN = (mod as any).topCount || 10
          const allProcs = this.parseProcesses(getPart('psUnified'))

          this.slowCache.set(sessionId, {
            disks: this.parseDisks(getPart('disks')),
            topCpu: needTopProcesses ? [...allProcs].sort((a, b) => b.cpu - a.cpu).slice(0, topN) : [],
            topMem: needTopProcesses ? [...allProcs].sort((a, b) => b.mem - a.mem).slice(0, topN) : [],
            gpus: this.parseGpus(getPart('gpu'))
          })
          
          if (this.subscriberCounts.get(sessionId) && this.subscriberCounts.get(sessionId)! > 0) {
            this.sendCurrentCacheState(sessionId, mod)
          }
        }).catch(() => {})
      }
    }

    this.latestFastContext.set(sessionId, {
      cpu: cpuPercent,
      memory: mod.memory ? { used: mem.memUsed, total: mem.memTotal, percent: mem.memPercent } : { used: 0, total: 0, percent: 0 },
      swap: mod.swap ? { used: mem.swapUsed, total: mem.swapTotal, percent: mem.swapPercent } : { used: 0, total: 0, percent: 0 },
      network: { rx: net.rxRate, tx: net.txRate, interfaces: net.interfaceRates },
      loadAvg,
      uptime
    })

    const cached = this.slowCache.get(sessionId) || { disks: [], topCpu: [], topMem: [], gpus: [] }

    return {
      ...this.latestFastContext.get(sessionId)!,
      disks: cached.disks,
      topCpu: cached.topCpu,
      topMem: cached.topMem,
      gpus: cached.gpus
    }
  }

  async getSystemInfo(sessionId: string): Promise<SystemInfo> {
    const cmd = [
      `hostname`,
      `cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || echo "Linux"`,
      `uname -sr`, `nproc`, `uname -m`
    ].join(' ; echo "---SEP---" ; ')
    const output = await this.exec(sessionId, cmd, 10000)
    const parts = output.split('---SEP---').map((s) => s.trim())
    return {
      hostname: parts[0] || 'unknown', os: parts[1] || 'Linux',
      kernel: parts[2] || 'unknown', cpuCores: parseInt(parts[3]) || 1, arch: parts[4] || 'unknown'
    }
  }

  async getProcesses(sessionId: string): Promise<ProcessInfo[]> {
    const output = await this.exec(sessionId, 'ps aux --sort=-%cpu | head -51')
    return output.trim().split('\n').slice(1)
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const p = l.split(/\s+/)
        return { pid: parseInt(p[1]) || 0, user: p[0] || '', cpu: parseFloat(p[2]) || 0, mem: parseFloat(p[3]) || 0, vsz: parseInt(p[4]) || 0, rss: parseInt(p[5]) || 0, command: p.slice(10).join(' ') }
      })
  }

  async getListeningPorts(sessionId: string): Promise<PortInfo[]> {
    // Try ss first, fall back to netstat
    const output = await this.exec(sessionId, `ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null`, 15000)
    const lines = output.trim().split('\n')
    const ports: PortInfo[] = []

    for (const line of lines) {
      // Skip headers
      if (/^State|^Proto|^Netid/.test(line) || !line.trim()) continue

      const cols = line.split(/\s+/).filter(Boolean)

      if (cols.length >= 5) {
        let protocol = '', localAddr = '', port = 0, pid = 0, process = '', state = ''

        if (cols[0] === 'LISTEN' || cols[0] === 'UNCONN') {
          // ss format
          state = cols[0]
          const addrPort = cols[3] || ''
          const lastColon = addrPort.lastIndexOf(':')
          localAddr = addrPort
          port = parseInt(addrPort.substring(lastColon + 1)) || 0
          protocol = addrPort.includes('[') ? 'tcp6' : 'tcp'
          const procMatch = (cols[5] || cols[4] || '').match(/\("([^"]+)",pid=(\d+)/)
          if (procMatch) {
            process = procMatch[1]
            pid = parseInt(procMatch[2]) || 0
          }
        } else if (/^tcp/.test(cols[0])) {
          // netstat format
          protocol = cols[0]
          localAddr = cols[3] || ''
          const lastColon = localAddr.lastIndexOf(':')
          port = parseInt(localAddr.substring(lastColon + 1)) || 0
          state = cols[5] || ''
          const pidProg = cols[6] || ''
          const pidMatch = pidProg.match(/^(\d+)\/(.+)$/)
          if (pidMatch) {
            pid = parseInt(pidMatch[1]) || 0
            process = pidMatch[2]
          }
        } else {
          continue
        }

        if (port > 0) {
          ports.push({ protocol, localAddr, port, pid, process, state })
        }
      }
    }

    // Sort by port number
    ports.sort((a, b) => a.port - b.port)
    return ports
  }

  async killProcess(sessionId: string, pid: number, signal: number = 9): Promise<string> {
    if (!Number.isFinite(pid) || pid <= 0) throw new Error('Invalid PID')
    if (signal !== 9 && signal !== 15) throw new Error('Invalid signal, use 9 (SIGKILL) or 15 (SIGTERM)')
    return this.exec(sessionId, `kill -${signal} ${pid} 2>&1`)
  }

  async killProcesses(sessionId: string, pids: number[], signal: number = 9): Promise<string> {
    const validPids = pids.filter((p) => Number.isFinite(p) && p > 0)
    if (validPids.length === 0) throw new Error('No valid PIDs')
    if (signal !== 9 && signal !== 15) throw new Error('Invalid signal')
    return this.exec(sessionId, `kill -${signal} ${validPids.join(' ')} 2>&1`)
  }

  stopAll(): void {
    for (const [id] of this.intervals) { this.stop(id, true) }
  }

  private notifyError(sessionId: string, message: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('monitor:error', sessionId, message)
    }
  }

  isUsingNodeSsh(sessionId: string): boolean {
    return sshManager.isConnected(sessionId)
  }
}

export const serverMonitor = new ServerMonitor()
