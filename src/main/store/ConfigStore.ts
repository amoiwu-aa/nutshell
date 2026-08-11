import Store from 'electron-store'
import { safeStorage } from 'electron'
import * as crypto from 'crypto'
import * as os from 'os'
import { CredentialCipher } from './credentialCipher'

// Machine-specific key material instead of a hardcoded secret.
//
// `hostname` is deliberately excluded: renaming the machine used to make every
// stored credential undecryptable. Records written before that change carry no
// version prefix and are still read with the legacy key, then re-encrypted.
function getMachineKey(includeHostname: boolean): string {
  const machineInfo = [
    ...(includeHostname ? [os.hostname()] : []),
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
  // --- Connection tuning (optional; see src/main/ssh/connectionTuning.ts) ---
  keepaliveIntervalMs?: number
  keepaliveCountMax?: number
  readyTimeoutMs?: number
  execTimeoutMs?: number
  reconnectBaseDelayMs?: number
  reconnectMaxDelayMs?: number
  monitorModules: MonitorModules
}

interface SessionState {
  tabs: Array<{
    connectionId: string
    name: string
    type: string
  }>
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
  useRustSshEngine: true,
  language: 'zh-CN',
  sidebarWidth: 260,
  autoReconnect: true,
  // 0 => retry indefinitely with capped backoff (see connectionTuning.ts)
  maxReconnectAttempts: 0,
  keepaliveIntervalMs: 15000,
  keepaliveCountMax: 6,
  readyTimeoutMs: 30000,
  execTimeoutMs: 30000,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 15000,
  monitorModules: defaultMonitorModules
}

class ConfigStore {
  private store: Store<StoreSchema>
  private cipher: CredentialCipher

  constructor() {
    this.store = new Store<StoreSchema>({
      name: 'nutshell-config',
      defaults: {
        connections: [],
        snippets: [],
        settings: defaultSettings,
        encryptionSalt: '',
        sessionState: { tabs: [] },
        windowBounds: { width: 1920, height: 1080, isMaximized: false }
      }
    })

    // Generate or load per-installation salt
    let salt = this.store.get('encryptionSalt', '')
    if (!salt) {
      salt = crypto.randomBytes(32).toString('hex')
      this.store.set('encryptionSalt', salt)
    }

    // configStore is constructed at module load, before app ready, but
    // safeStorage must not be used until after ready. The cipher only calls
    // into safeStorage from encrypt/decrypt, which are first reached via IPC
    // handlers — always post-ready.
    this.cipher = new CredentialCipher(
      safeStorage,
      crypto.scryptSync(getMachineKey(false), salt, 32).toString('hex'),
      crypto.scryptSync(getMachineKey(true), salt, 32).toString('hex')
    )
  }

  // --- Connections ---
  getConnections(): ConnectionConfig[] {
    const connections = this.store.get('connections', [])
    const decrypted = connections.map((conn) => ({
      ...conn,
      password: conn.password ? this.cipher.decrypt(conn.password) : undefined,
      passphrase: conn.passphrase ? this.cipher.decrypt(conn.passphrase) : undefined
    }))

    const hasOutdatedRecords = connections.some(
      (conn) =>
        (conn.password && !this.cipher.isPreferredFormat(conn.password)) ||
        (conn.passphrase && !this.cipher.isPreferredFormat(conn.passphrase))
    )
    if (hasOutdatedRecords) {
      this.store.set(
        'connections',
        connections.map((conn, index) => ({
          ...conn,
          // Keep the original ciphertext where it couldn't be read: restoring
          // the old hostname (or the OS keychain) is then still able to
          // recover it.
          password: decrypted[index].password
            ? this.cipher.encrypt(decrypted[index].password!)
            : conn.password,
          passphrase: decrypted[index].passphrase
            ? this.cipher.encrypt(decrypted[index].passphrase!)
            : conn.passphrase
        }))
      )
    }

    return decrypted
  }

  saveConnection(connection: ConnectionConfig): void {
    const connections = this.store.get('connections', [])
    const encrypted = {
      ...connection,
      password: connection.password ? this.cipher.encrypt(connection.password) : undefined,
      passphrase: connection.passphrase ? this.cipher.encrypt(connection.passphrase) : undefined
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
}

export const configStore = new ConfigStore()
