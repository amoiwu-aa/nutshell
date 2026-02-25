import { create } from 'zustand'

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

export const defaultMonitorModules: MonitorModules = {
  systemInfo: true, cpu: true, memory: true, swap: true,
  disks: true, network: true, topCpu: true, topMem: true,
  processes: true, gpu: true, ports: true
}

export interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  fontSize: number
  fontFamily: string
  terminalTheme: string
  language: string
  sidebarWidth: number
  monitorModules: MonitorModules
}

interface SettingsState {
  settings: AppSettings
  setSettings: (settings: Partial<AppSettings>) => void
  loadSettings: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: {
    theme: 'dark',
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
    terminalTheme: 'default',
    language: 'zh-CN',
    sidebarWidth: 260,
    monitorModules: defaultMonitorModules
  },

  setSettings: (newSettings) =>
    set((state) => {
      const updated = { ...state.settings, ...newSettings }
      window.api.config.saveSettings(updated)
      return { settings: updated }
    }),

  loadSettings: async () => {
    const result = await window.api.config.getSettings()
    if (result.success) {
      // Ensure monitorModules has defaults for any missing keys
      const settings = {
        ...result.settings,
        monitorModules: { ...defaultMonitorModules, ...result.settings.monitorModules }
      }
      set({ settings })

      if (settings.theme === 'dark') {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }

      // Apply saved color theme
      const ct = (settings as any).colorTheme
      if (ct) {
        document.documentElement.classList.add(ct)
      }
    }
  }
}))
