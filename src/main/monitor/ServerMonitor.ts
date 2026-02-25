import { BrowserWindow } from 'electron'
import { sshManager } from '../ssh/SSHManager'

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

class ServerMonitor {
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map()
  private prevNetworkStats: Map<string, { time: number; total: { rx: number; tx: number }; interfaces: Map<string, { rx: number; tx: number }> }> = new Map()
  private prevCpuStats: Map<string, CpuSnapshot> = new Map()
  private enabledModules: Map<string, MonitorModules> = new Map()

  async start(sessionId: string, intervalMs: number = 3000, modules?: MonitorModules): Promise<void> {
    this.stop(sessionId)
    this.enabledModules.set(sessionId, modules || DEFAULT_MODULES)

    try {
      await this.collectAndSend(sessionId)
    } catch (err: any) {
      this.notifyError(sessionId, err?.message || 'Failed to collect initial data')
    }

    const timer = setInterval(async () => {
      try {
        await this.collectAndSend(sessionId)
      } catch {
        this.stop(sessionId)
      }
    }, intervalMs)

    this.intervals.set(sessionId, timer)
  }

  updateModules(sessionId: string, modules: MonitorModules): void {
    this.enabledModules.set(sessionId, modules)
  }

  stop(sessionId: string): void {
    const timer = this.intervals.get(sessionId)
    if (timer) {
      clearInterval(timer)
      this.intervals.delete(sessionId)
    }
    this.prevNetworkStats.delete(sessionId)
    this.prevCpuStats.delete(sessionId)
    this.enabledModules.delete(sessionId)
  }

  private async collectAndSend(sessionId: string): Promise<void> {
    if (!sshManager.isConnected(sessionId)) {
      this.stop(sessionId)
      return
    }

    const data = await this.collectData(sessionId)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('monitor:data', sessionId, data)
    }
  }

  private async collectData(sessionId: string): Promise<MonitorData> {
    const mod = this.enabledModules.get(sessionId) || DEFAULT_MODULES

    const commands: string[] = []
    const cmdMap: string[] = []

    // Core metrics (always)
    commands.push(`grep 'cpu ' /proc/stat`)
    cmdMap.push('cpu')
    commands.push(`cat /proc/loadavg`)
    cmdMap.push('loadavg')
    commands.push(`uptime -p 2>/dev/null || uptime`)
    cmdMap.push('uptime')

    if (mod.memory || mod.swap) {
      commands.push(`free -b`)
      cmdMap.push('free')
    }

    if (mod.disks) {
      commands.push(`df -B1 -x tmpfs -x devtmpfs -x overlay 2>/dev/null | tail -n +2`)
      cmdMap.push('disks')
    }

    if (mod.network) {
      commands.push(`awk 'NR>2 && $1!~"lo:" {gsub(/:/, "", $1); print $1, $2, $10}' /proc/net/dev`)
      cmdMap.push('network')
    }

    if (mod.topCpu) {
      const topN = (mod as any).topCount || 10
      commands.push(`ps aux --sort=-%cpu | head -${topN + 1}`)
      cmdMap.push('topCpu')
    }

    if (mod.topMem) {
      const topN = (mod as any).topCount || 10
      commands.push(`ps aux --sort=-%mem | head -${topN + 1}`)
      cmdMap.push('topMem')
    }

    // GPU (nvidia-smi, silent fail if not available)
    if (mod.gpu) {
      commands.push(`nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw --format=csv,noheader,nounits 2>/dev/null || echo ""`)
      cmdMap.push('gpu')
    }

    const combined = commands.join(' ; echo "---SEP---" ; ')
    const output = await sshManager.exec(sessionId, combined)
    const parts = output.split('---SEP---').map((s) => s.trim())

    const getPart = (name: string): string => {
      const idx = cmdMap.indexOf(name)
      return idx >= 0 ? (parts[idx] || '') : ''
    }

    // --- CPU ---
    const cpuLine = getPart('cpu')
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

    // --- Memory + Swap ---
    let memUsed = 0, memTotal = 0, memPercent = 0
    let swapUsed = 0, swapTotal = 0, swapPercent = 0
    const freeOutput = getPart('free')
    if (freeOutput) {
      for (const line of freeOutput.split('\n')) {
        const cols = line.split(/\s+/)
        if (/mem/i.test(cols[0])) {
          memTotal = parseInt(cols[1]) || 0
          memUsed = parseInt(cols[2]) || 0
          memPercent = memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0
        } else if (/swap/i.test(cols[0])) {
          swapTotal = parseInt(cols[1]) || 0
          swapUsed = parseInt(cols[2]) || 0
          swapPercent = swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0
        }
      }
    }

    // --- Disks ---
    const disks: DiskInfo[] = []
    const disksOutput = getPart('disks')
    if (disksOutput) {
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
    }

    // --- Network (per-interface) ---
    let rxRate = 0, txRate = 0
    const interfaceRates: { name: string; rx: number; tx: number }[] = []
    const netOutput = getPart('network')
    if (netOutput) {
      const now = Date.now()
      const prevStats = this.prevNetworkStats.get(sessionId)
      const timeDiff = prevStats ? (now - prevStats.time) / 1000 : 0

      let totalRx = 0, totalTx = 0
      const currentInterfaces = new Map<string, { rx: number; tx: number }>()

      for (const line of netOutput.split('\n')) {
        const cols = line.trim().split(/\s+/)
        if (cols.length >= 3) {
          const name = cols[0]
          const rx = parseInt(cols[1]) || 0
          const tx = parseInt(cols[2]) || 0
          currentInterfaces.set(name, { rx, tx })
          totalRx += rx
          totalTx += tx

          if (prevStats && timeDiff > 0) {
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

      if (prevStats && timeDiff > 0) {
        rxRate = Math.max(0, (totalRx - prevStats.total.rx) / timeDiff)
        txRate = Math.max(0, (totalTx - prevStats.total.tx) / timeDiff)
      }

      this.prevNetworkStats.set(sessionId, {
        time: now,
        total: { rx: totalRx, tx: totalTx },
        interfaces: currentInterfaces
      })
    }

    // --- Load Average ---
    const loadLine = getPart('loadavg')
    const loadParts = loadLine.split(/\s+/)
    const loadAvg = loadParts.slice(0, 3).map((v) => { const n = parseFloat(v); return isNaN(n) ? 0 : n })

    // --- Uptime ---
    const uptime = getPart('uptime') || 'unknown'

    // --- Top processes ---
    const parseTopProcesses = (raw: string): TopProcess[] => {
      if (!raw) return []
      return raw.split('\n').slice(1).filter((l) => l.trim()).map((l) => {
        const p = l.split(/\s+/)
        return { pid: parseInt(p[1]) || 0, user: p[0] || '', cpu: parseFloat(p[2]) || 0, mem: parseFloat(p[3]) || 0, rss: (parseInt(p[5]) || 0) * 1024, command: p.slice(10).join(' ') }
      })
    }

    // --- GPU ---
    const gpus: GpuInfo[] = []
    const gpuOutput = getPart('gpu')
    if (gpuOutput) {
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
    }

    return {
      cpu: cpuPercent,
      memory: { used: memUsed, total: memTotal, percent: memPercent },
      swap: { used: swapUsed, total: swapTotal, percent: swapPercent },
      disks, network: { rx: rxRate, tx: txRate, interfaces: interfaceRates }, loadAvg, uptime,
      topCpu: parseTopProcesses(getPart('topCpu')),
      topMem: parseTopProcesses(getPart('topMem')),
      gpus
    }
  }

  async getSystemInfo(sessionId: string): Promise<SystemInfo> {
    const cmd = [
      `hostname`,
      `cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || echo "Linux"`,
      `uname -sr`, `nproc`, `uname -m`
    ].join(' ; echo "---SEP---" ; ')
    const output = await sshManager.exec(sessionId, cmd, 10000)
    const parts = output.split('---SEP---').map((s) => s.trim())
    return {
      hostname: parts[0] || 'unknown', os: parts[1] || 'Linux',
      kernel: parts[2] || 'unknown', cpuCores: parseInt(parts[3]) || 1, arch: parts[4] || 'unknown'
    }
  }

  async getProcesses(sessionId: string): Promise<ProcessInfo[]> {
    const output = await sshManager.exec(sessionId, 'ps aux --sort=-%cpu | head -51')
    return output.trim().split('\n').slice(1)
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const p = l.split(/\s+/)
        return { pid: parseInt(p[1]) || 0, user: p[0] || '', cpu: parseFloat(p[2]) || 0, mem: parseFloat(p[3]) || 0, vsz: parseInt(p[4]) || 0, rss: parseInt(p[5]) || 0, command: p.slice(10).join(' ') }
      })
  }

  async getListeningPorts(sessionId: string): Promise<PortInfo[]> {
    // Try ss first, fall back to netstat
    const output = await sshManager.exec(sessionId, `ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null`, 15000)
    const lines = output.trim().split('\n')
    const ports: PortInfo[] = []

    for (const line of lines) {
      // Skip headers
      if (/^State|^Proto|^Netid/.test(line) || !line.trim()) continue

      // ss format: State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
      // netstat format: Proto Recv-Q Send-Q Local Address Foreign Address State PID/Program
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
          // Parse process from "users:(("sshd",pid=1234,fd=3))"
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
    return sshManager.exec(sessionId, `kill -${signal} ${pid} 2>&1`)
  }

  async killProcesses(sessionId: string, pids: number[], signal: number = 9): Promise<string> {
    const validPids = pids.filter((p) => Number.isFinite(p) && p > 0)
    if (validPids.length === 0) throw new Error('No valid PIDs')
    if (signal !== 9 && signal !== 15) throw new Error('Invalid signal')
    return sshManager.exec(sessionId, `kill -${signal} ${validPids.join(' ')} 2>&1`)
  }

  stopAll(): void {
    for (const [id] of this.intervals) { this.stop(id) }
  }

  private notifyError(sessionId: string, message: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('monitor:error', sessionId, message)
    }
  }
}

export const serverMonitor = new ServerMonitor()
