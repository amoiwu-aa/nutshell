import { create } from 'zustand'

export interface ConnectionConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: 'password' | 'key' | 'keyWithPassphrase'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  group?: string
  jumpHost?: string
  color?: string
  lastConnected?: number
}

export interface Tab {
  id: string
  connectionId: string
  sessionId: string
  parentSessionId?: string
  name: string
  type: 'terminal' | 'sftp' | 'monitor' | 'docker' | 'workspace' | 'editor'
  engine?: 'node' | 'rust'
  workspacePath?: string
  filePath?: string
  fileName?: string
  dockerContainerId?: string
  connected: boolean
}

interface ConnectionState {
  connections: ConnectionConfig[]
  tabs: Tab[]
  activeTabId: string | null
  sidebarCollapsed: boolean
  monitorPanelVisible: boolean
  bottomPanelVisible: boolean
  bottomPanelHeight: number
  bottomPanelActiveTab: 'files' | 'commands' | 'transfers' | 'ports'
  zenMode: boolean

  // Actions
  setConnections: (connections: ConnectionConfig[]) => void
  addConnection: (connection: ConnectionConfig) => void
  updateConnection: (connection: ConnectionConfig) => void
  removeConnection: (id: string) => void

  addTab: (tab: Tab) => void
  removeTab: (id: string) => void
  setActiveTab: (id: string) => void
  updateTab: (id: string, updates: Partial<Tab>) => void

  setSidebarCollapsed: (collapsed: boolean) => void
  setMonitorPanelVisible: (visible: boolean) => void
  setBottomPanelVisible: (visible: boolean) => void
  setBottomPanelHeight: (height: number) => void
  setBottomPanelActiveTab: (tab: 'files' | 'commands' | 'transfers' | 'ports') => void
  setZenMode: (zen: boolean) => void
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  connections: [],
  tabs: [],
  activeTabId: null,
  sidebarCollapsed: false,
  monitorPanelVisible: true,
  bottomPanelVisible: true,
  bottomPanelHeight: 350,
  bottomPanelActiveTab: 'commands',
  zenMode: false,

  setConnections: (connections) => set({ connections }),

  addConnection: (connection) =>
    set((state) => ({
      connections: [...state.connections, connection]
    })),

  updateConnection: (connection) =>
    set((state) => ({
      connections: state.connections.map((c) => (c.id === connection.id ? connection : c))
    })),

  removeConnection: (id) =>
    set((state) => ({
      connections: state.connections.filter((c) => c.id !== id)
    })),

  addTab: (tab) =>
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: tab.id
    })),

  removeTab: (id) =>
    set((state) => {
      const newTabs = state.tabs.filter((t) => t.id !== id)
      let newActiveId = state.activeTabId
      if (state.activeTabId === id) {
        newActiveId = newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null
      }
      return { tabs: newTabs, activeTabId: newActiveId }
    }),

  setActiveTab: (id) => set({ activeTabId: id }),

  updateTab: (id, updates) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t))
    })),

  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
  setMonitorPanelVisible: (visible) => set({ monitorPanelVisible: visible }),
  setBottomPanelVisible: (visible) => set({ bottomPanelVisible: visible }),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: height }),
  setBottomPanelActiveTab: (tab) => set({ bottomPanelActiveTab: tab }),
  setZenMode: (zen) => set({ zenMode: zen })
}))
