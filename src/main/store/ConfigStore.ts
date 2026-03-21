import Store from 'electron-store'
import * as crypto from 'crypto'
import * as os from 'os'

// Generate a machine-specific key instead of hardcoding
function getMachineKey(): string {
  const machineInfo = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.userInfo().username,
    os.homedir()
  ].join('|')
  return crypto.createHash('sha256').update(machineInfo).digest('hex')
}

interface ConnectionConfig {
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

interface Snippet {
  id: string
  name: string
  command: string
  description?: string
  category?: string
  variables?: { name: string; defaultValue: string }[]
}

interface MonitorModules {
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

interface AppSettings {
  theme: 'dark' | 'light' | 'system'
  fontSize: number
  fontFamily: string
  terminalTheme: string
  terminalRenderer: 'auto' | 'webgl' | 'canvas'
  aiCompatibilityMode: boolean
  allowRemoteClipboardWrite: boolean
  useRustSshEngine: boolean
  language: string
  sidebarWidth: number
  autoReconnect: boolean
  maxReconnectAttempts: number
  monitorModules: MonitorModules
  ai: {
    provider: string
    apiKey: string
    apiUrl: string
    model: string
    maxTokens?: number  // For custom provider
  }
}

interface SessionState {
  tabs: Array<{
    connectionId: string
    name: string
    type: string
  }>
}

export interface ChatConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Array<{ role: string; content: string; timestamp: number }>
}

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}

interface StoreSchema {
  connections: ConnectionConfig[]
  snippets: Snippet[]
  settings: AppSettings
  encryptionSalt: string
  sessionState: SessionState
  aiChatHistory: Record<string, ChatConversation[]>
  windowBounds: WindowBounds
}

const defaultMonitorModules: MonitorModules = {
  systemInfo: true, cpu: true, memory: true, swap: true,
  disks: true, network: true, topCpu: true, topMem: true,
  processes: true, gpu: true, ports: true
}

const defaultSettings: AppSettings = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
  terminalTheme: 'default',
  terminalRenderer: 'auto',
  aiCompatibilityMode: false,
  allowRemoteClipboardWrite: true,
  useRustSshEngine: false,
  language: 'zh-CN',
  sidebarWidth: 260,
  autoReconnect: true,
  maxReconnectAttempts: 5,
  monitorModules: defaultMonitorModules,
  ai: { provider: 'openai', apiKey: '', apiUrl: '', model: '' }
}

class ConfigStore {
  private store: Store<StoreSchema>
  private encryptionKey: string

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'nutshell-config',
      defaults: {
        connections: [],
        snippets: [],
        settings: defaultSettings,
        encryptionSalt: '',
        sessionState: { tabs: [] },
        aiChatHistory: {},
        windowBounds: { width: 1920, height: 1080, isMaximized: false }
      }
    })

    // Generate or load per-installation salt
    let salt = this.store.get('encryptionSalt', '')
    if (!salt) {
      salt = crypto.randomBytes(32).toString('hex')
      this.store.set('encryptionSalt', salt)
    }

    // Derive key from machine info + stored salt
    const machineKey = getMachineKey()
    this.encryptionKey = crypto.scryptSync(machineKey, salt, 32).toString('hex')
  }

  // --- Connections ---
  getConnections(): ConnectionConfig[] {
    const connections = this.store.get('connections', [])
    return connections.map((conn) => ({
      ...conn,
      password: conn.password ? this.decrypt(conn.password) : undefined,
      passphrase: conn.passphrase ? this.decrypt(conn.passphrase) : undefined
    }))
  }

  saveConnection(connection: ConnectionConfig): void {
    const connections = this.store.get('connections', [])
    const encrypted = {
      ...connection,
      password: connection.password ? this.encrypt(connection.password) : undefined,
      passphrase: connection.passphrase ? this.encrypt(connection.passphrase) : undefined
    }

    const index = connections.findIndex((c) => c.id === connection.id)
    if (index >= 0) {
      connections[index] = encrypted
    } else {
      connections.push(encrypted)
    }

    this.store.set('connections', connections)
  }

  deleteConnection(id: string): void {
    const connections = this.store.get('connections', [])
    this.store.set(
      'connections',
      connections.filter((c) => c.id !== id)
    )
  }

  // --- Snippets ---
  getSnippets(): Snippet[] {
    return this.store.get('snippets', [])
  }

  saveSnippet(snippet: Snippet): void {
    const snippets = this.store.get('snippets', [])
    const index = snippets.findIndex((s) => s.id === snippet.id)
    if (index >= 0) {
      snippets[index] = snippet
    } else {
      snippets.push(snippet)
    }
    this.store.set('snippets', snippets)
  }

  deleteSnippet(id: string): void {
    const snippets = this.store.get('snippets', [])
    this.store.set(
      'snippets',
      snippets.filter((s) => s.id !== id)
    )
  }

  importSnippets(newSnippets: Snippet[], mode: 'merge' | 'replace'): void {
    if (mode === 'replace') {
      this.store.set('snippets', newSnippets)
    } else {
      const existing = this.store.get('snippets', [])
      const merged = [...existing]
      for (const s of newSnippets) {
        const idx = merged.findIndex((e) => e.id === s.id)
        if (idx >= 0) {
          merged[idx] = s
        } else {
          merged.push(s)
        }
      }
      this.store.set('snippets', merged)
    }
  }

  // --- Settings ---
  getSettings(): AppSettings {
    return { ...defaultSettings, ...this.store.get('settings', defaultSettings) }
  }

  saveSettings(settings: Partial<AppSettings>): void {
    const current = this.getSettings()
    this.store.set('settings', { ...current, ...settings })
  }

  // --- Window bounds ---
  getWindowBounds(): WindowBounds {
    return this.store.get('windowBounds', { width: 1920, height: 1080, isMaximized: false })
  }

  saveWindowBounds(bounds: WindowBounds): void {
    this.store.set('windowBounds', bounds)
  }

  // --- Session persistence ---
  getSessionState(): SessionState {
    return this.store.get('sessionState', { tabs: [] })
  }

  saveSessionState(state: SessionState): void {
    this.store.set('sessionState', state)
  }

  // --- AI Chat Conversations ---
  getConversations(workspacePath: string): Omit<ChatConversation, 'messages'>[] {
    const all = this.store.get('aiChatHistory', {}) as Record<string, ChatConversation[]>
    const convs = all[workspacePath] || []
    return convs.map(({ messages, ...rest }) => rest).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getConversation(workspacePath: string, convId: string): ChatConversation | null {
    const all = this.store.get('aiChatHistory', {}) as Record<string, ChatConversation[]>
    const convs = all[workspacePath] || []
    return convs.find((c) => c.id === convId) || null
  }

  saveConversation(workspacePath: string, conversation: ChatConversation): void {
    const all = this.store.get('aiChatHistory', {}) as Record<string, ChatConversation[]>
    const convs = all[workspacePath] || []
    const idx = convs.findIndex((c) => c.id === conversation.id)
    // Keep messages limited
    conversation.messages = conversation.messages.slice(-200)
    if (idx >= 0) { convs[idx] = conversation } else { convs.push(conversation) }
    all[workspacePath] = convs
    this.store.set('aiChatHistory', all)
  }

  deleteConversation(workspacePath: string, convId: string): void {
    const all = this.store.get('aiChatHistory', {}) as Record<string, ChatConversation[]>
    const convs = all[workspacePath] || []
    all[workspacePath] = convs.filter((c) => c.id !== convId)
    this.store.set('aiChatHistory', all)
  }

  // Legacy compatibility
  getAIChatHistory(workspacePath: string): Array<{ role: string; content: string; timestamp: number }> {
    const all = this.store.get('aiChatHistory', {}) as any
    const data = all[workspacePath]
    if (Array.isArray(data) && data.length > 0 && !data[0]?.id) return data // old flat format
    return []
  }

  saveAIChatHistory(workspacePath: string, messages: Array<{ role: string; content: string; timestamp: number }>): void {
    // No-op for legacy, new code uses saveConversation
  }

  // --- Encryption helpers ---
  private encrypt(text: string): string {
    try {
      const key = Buffer.from(this.encryptionKey, 'hex')
      const iv = crypto.randomBytes(16)
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
      let encrypted = cipher.update(text, 'utf8', 'hex')
      encrypted += cipher.final('hex')
      return iv.toString('hex') + ':' + encrypted
    } catch {
      return text
    }
  }

  private decrypt(text: string): string {
    try {
      const [ivHex, encrypted] = text.split(':')
      if (!ivHex || !encrypted) return text

      const key = Buffer.from(this.encryptionKey, 'hex')
      const iv = Buffer.from(ivHex, 'hex')
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')
      return decrypted
    } catch {
      return text
    }
  }
}

export const configStore = new ConfigStore()
