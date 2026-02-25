import { sshManager } from '../ssh/SSHManager'
import { BrowserWindow } from 'electron'

// ===== Language Server Configuration =====
interface LspServerConfig {
  command: string
  checkCommand: string   // Command to check if installed
  installHint: string    // Instructions to install
  languages: string[]    // Monaco language IDs this server supports
  initOptions?: any
}

const LSP_SERVERS: Record<string, LspServerConfig> = {
  typescript: {
    command: 'typescript-language-server --stdio',
    checkCommand: 'which typescript-language-server 2>/dev/null',
    installHint: 'npm install -g typescript-language-server typescript',
    languages: ['typescript', 'javascript'],
    initOptions: { preferences: { includeCompletionsForModuleExports: true } }
  },
  python: {
    command: 'pyright-langserver --stdio',
    checkCommand: 'which pyright-langserver 2>/dev/null || which pyright 2>/dev/null',
    installHint: 'pip install pyright',
    languages: ['python'],
  },
  go: {
    command: 'gopls serve -rpc.trace',
    checkCommand: 'which gopls 2>/dev/null',
    installHint: 'go install golang.org/x/tools/gopls@latest',
    languages: ['go'],
  },
  rust: {
    command: 'rust-analyzer',
    checkCommand: 'which rust-analyzer 2>/dev/null',
    installHint: 'rustup component add rust-analyzer',
    languages: ['rust'],
  },
  clangd: {
    command: 'clangd',
    checkCommand: 'which clangd 2>/dev/null',
    installHint: 'apt install clangd 或 brew install llvm',
    languages: ['c', 'cpp'],
  }
}

// ===== JSON-RPC Message Parser =====
class JsonRpcParser {
  private buffer: string = ''
  private contentLength: number = -1

  feed(data: string): any[] {
    this.buffer += data
    const messages: any[] = []

    while (true) {
      if (this.contentLength === -1) {
        // Looking for Content-Length header
        const headerEnd = this.buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) break

        const header = this.buffer.substring(0, headerEnd)
        const match = header.match(/Content-Length:\s*(\d+)/i)
        if (!match) {
          // Skip malformed header
          this.buffer = this.buffer.substring(headerEnd + 4)
          continue
        }
        this.contentLength = parseInt(match[1])
        this.buffer = this.buffer.substring(headerEnd + 4)
      }

      if (this.contentLength === -1) break

      // Check if we have enough data for the body
      const bodyBytes = Buffer.byteLength(this.buffer, 'utf-8')
      if (bodyBytes < this.contentLength) break

      // Extract body based on byte length
      let consumed = 0
      let charCount = 0
      for (let i = 0; i < this.buffer.length; i++) {
        consumed += Buffer.byteLength(this.buffer[i], 'utf-8')
        charCount = i + 1
        if (consumed >= this.contentLength) break
      }

      const body = this.buffer.substring(0, charCount)
      this.buffer = this.buffer.substring(charCount)
      this.contentLength = -1

      try {
        messages.push(JSON.parse(body))
      } catch {
        // Skip invalid JSON
      }
    }

    return messages
  }
}

// ===== LSP Session =====
interface LspSession {
  sessionId: string      // SSH session ID
  language: string       // Server type key
  channelId: string      // SSH exec stream channel ID
  rootPath: string
  parser: JsonRpcParser
  requestId: number
  pendingRequests: Map<number, { resolve: (value: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>
  initialized: boolean
  capabilities: any
}

const LSP_REQUEST_TIMEOUT_MS = 15000

class LspManager {
  private sessions: Map<string, LspSession> = new Map()

  private getKey(sessionId: string, language: string): string {
    return `${sessionId}:${language}`
  }

  // ===== Check if language server is available =====
  async checkAvailability(sessionId: string, language: string): Promise<{ available: boolean; installHint: string }> {
    const config = LSP_SERVERS[language]
    if (!config) return { available: false, installHint: `不支持的语言服务器: ${language}` }

    try {
      const result = await sshManager.exec(sessionId, config.checkCommand, 5000)
      return { available: result.trim().length > 0, installHint: config.installHint }
    } catch {
      return { available: false, installHint: config.installHint }
    }
  }

  // ===== Detect project type and recommended servers =====
  async detectProjectServers(sessionId: string, rootPath: string): Promise<Array<{
    language: string; available: boolean; installHint: string; recommended: boolean
  }>> {
    const safeRoot = rootPath.replace(/"/g, '\\"')
    const results: Array<{ language: string; available: boolean; installHint: string; recommended: boolean }> = []

    // Detect project files
    try {
      const fileCheck = await sshManager.exec(sessionId,
        `ls "${safeRoot}/package.json" "${safeRoot}/tsconfig.json" "${safeRoot}/requirements.txt" ` +
        `"${safeRoot}/pyproject.toml" "${safeRoot}/go.mod" "${safeRoot}/Cargo.toml" ` +
        `"${safeRoot}/CMakeLists.txt" "${safeRoot}/Makefile" 2>/dev/null`, 5000)

      const files = fileCheck.trim().toLowerCase()
      const recommended = new Set<string>()

      if (files.includes('package.json') || files.includes('tsconfig.json')) recommended.add('typescript')
      if (files.includes('requirements.txt') || files.includes('pyproject.toml')) recommended.add('python')
      if (files.includes('go.mod')) recommended.add('go')
      if (files.includes('cargo.toml')) recommended.add('rust')
      if (files.includes('cmakelists.txt') || files.includes('makefile')) recommended.add('clangd')

      // Check availability for each
      for (const [lang, config] of Object.entries(LSP_SERVERS)) {
        const check = await this.checkAvailability(sessionId, lang)
        results.push({
          language: lang,
          available: check.available,
          installHint: check.installHint,
          recommended: recommended.has(lang)
        })
      }
    } catch {}

    return results
  }

  // ===== Start LSP server =====
  async start(sessionId: string, rootPath: string, language: string): Promise<{ success: boolean; error?: string }> {
    const key = this.getKey(sessionId, language)
    if (this.sessions.has(key)) {
      return { success: true } // Already running
    }

    const config = LSP_SERVERS[language]
    if (!config) return { success: false, error: `不支持的语言: ${language}` }

    // Check availability first
    const avail = await this.checkAvailability(sessionId, language)
    if (!avail.available) {
      return { success: false, error: `语言服务器未安装。安装命令: ${avail.installHint}` }
    }

    const parser = new JsonRpcParser()
    const session: LspSession = {
      sessionId, language, channelId: '', rootPath,
      parser, requestId: 0,
      pendingRequests: new Map(),
      initialized: false, capabilities: {}
    }

    try {
      // Start the language server via SSH exec stream
      const channelId = await sshManager.execStream(
        sessionId,
        config.command,
        // onData - parse LSP messages
        (data: string) => {
          const messages = parser.feed(data)
          for (const msg of messages) {
            this.handleServerMessage(key, msg)
          }
        },
        // onStderr - log but don't break
        (data: string) => {
          // LSP servers sometimes write diagnostics to stderr
          this.notifyLspLog(sessionId, language, data)
        },
        // onClose
        () => {
          this.cleanup(key)
          this.notifyLspStatus(sessionId, language, 'stopped')
        }
      )

      session.channelId = channelId
      this.sessions.set(key, session)

      // Initialize the LSP server
      await this.initialize(key, rootPath, config)
      this.notifyLspStatus(sessionId, language, 'running')

      return { success: true }
    } catch (err: any) {
      this.cleanup(key)
      return { success: false, error: err.message }
    }
  }

  // ===== Initialize handshake =====
  private async initialize(key: string, rootPath: string, config: LspServerConfig): Promise<void> {
    const session = this.sessions.get(key)
    if (!session) throw new Error('LSP session not found')

    // Send initialize request
    const initResult = await this.sendRequest(key, 'initialize', {
      processId: null,
      rootUri: `file://${rootPath}`,
      rootPath: rootPath,
      capabilities: {
        textDocument: {
          completion: {
            completionItem: {
              snippetSupport: true,
              commitCharactersSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
              deprecatedSupport: true,
              preselectSupport: true,
              labelDetailsSupport: true,
            },
            contextSupport: true,
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
          definition: { linkSupport: true },
          references: {},
          documentHighlight: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'source'] } } },
          codeLens: {},
          formatting: {},
          rangeFormatting: {},
          rename: { prepareSupport: true },
          publishDiagnostics: { relatedInformation: true, tagSupport: { valueSet: [1, 2] } },
        },
        workspace: {
          workspaceFolders: true,
          didChangeConfiguration: { dynamicRegistration: true },
          symbol: {},
        }
      },
      workspaceFolders: [{ uri: `file://${rootPath}`, name: rootPath.split('/').pop() || 'workspace' }],
      initializationOptions: config.initOptions || {},
    })

    session.capabilities = initResult?.capabilities || {}
    session.initialized = true

    // Send initialized notification
    this.sendNotification(key, 'initialized', {})
  }

  // ===== Send JSON-RPC request (with response) =====
  async sendRequest(key: string, method: string, params: any): Promise<any> {
    const session = this.sessions.get(key)
    if (!session) throw new Error('LSP session not found')

    session.requestId++
    const id = session.requestId

    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    const encoded = `Content-Length: ${Buffer.byteLength(message, 'utf-8')}\r\n\r\n${message}`

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pendingRequests.delete(id)
        reject(new Error(`LSP request timeout: ${method}`))
      }, LSP_REQUEST_TIMEOUT_MS)

      session.pendingRequests.set(id, { resolve, reject, timer })

      if (!sshManager.writeLspChannel(session.channelId, encoded)) {
        clearTimeout(timer)
        session.pendingRequests.delete(id)
        reject(new Error('LSP channel write failed'))
      }
    })
  }

  // ===== Send JSON-RPC notification (no response) =====
  sendNotification(key: string, method: string, params: any): void {
    const session = this.sessions.get(key)
    if (!session) return

    const message = JSON.stringify({ jsonrpc: '2.0', method, params })
    const encoded = `Content-Length: ${Buffer.byteLength(message, 'utf-8')}\r\n\r\n${message}`
    sshManager.writeLspChannel(session.channelId, encoded)
  }

  // ===== Handle message from language server =====
  private handleServerMessage(key: string, msg: any): void {
    const session = this.sessions.get(key)
    if (!session) return

    if (msg.id !== undefined && msg.id !== null) {
      // Response to a request
      const pending = session.pendingRequests.get(msg.id)
      if (pending) {
        clearTimeout(pending.timer)
        session.pendingRequests.delete(msg.id)
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'LSP error'))
        } else {
          pending.resolve(msg.result)
        }
      }
    } else if (msg.method) {
      // Server notification or request
      this.handleServerNotification(session, msg.method, msg.params)
    }
  }

  // ===== Handle server-initiated notifications =====
  private handleServerNotification(session: LspSession, method: string, params: any): void {
    switch (method) {
      case 'textDocument/publishDiagnostics':
        this.notifyDiagnostics(session.sessionId, session.language, params)
        break
      case 'window/logMessage':
      case 'window/showMessage':
        this.notifyLspLog(session.sessionId, session.language, params?.message || '')
        break
      // Ignore other notifications
    }
  }

  // ===== Public API for IPC handlers =====

  async request(sessionId: string, language: string, method: string, params: any): Promise<any> {
    const key = this.getKey(sessionId, language)
    const session = this.sessions.get(key)
    if (!session) throw new Error(`LSP server not running for ${language}`)
    if (!session.initialized && method !== 'initialize') throw new Error('LSP not initialized yet')
    return this.sendRequest(key, method, params)
  }

  notify(sessionId: string, language: string, method: string, params: any): void {
    const key = this.getKey(sessionId, language)
    this.sendNotification(key, method, params)
  }

  async stop(sessionId: string, language: string): Promise<void> {
    const key = this.getKey(sessionId, language)
    const session = this.sessions.get(key)
    if (!session) return

    try {
      // Send shutdown request
      await this.sendRequest(key, 'shutdown', null).catch(() => {})
      // Send exit notification
      this.sendNotification(key, 'exit', null)
    } catch {}

    // Close the channel
    sshManager.closeLspChannel(session.channelId)
    this.cleanup(key)
  }

  stopAll(sessionId: string): void {
    for (const [key, session] of this.sessions.entries()) {
      if (session.sessionId === sessionId) {
        try {
          sshManager.closeLspChannel(session.channelId)
        } catch {}
        this.cleanup(key)
      }
    }
  }

  isRunning(sessionId: string, language: string): boolean {
    return this.sessions.has(this.getKey(sessionId, language))
  }

  getRunningServers(sessionId: string): string[] {
    const result: string[] = []
    for (const [key, session] of this.sessions.entries()) {
      if (session.sessionId === sessionId) result.push(session.language)
    }
    return result
  }

  // ===== File sync notifications =====
  didOpen(sessionId: string, language: string, uri: string, languageId: string, version: number, text: string): void {
    const key = this.getKey(sessionId, language)
    this.sendNotification(key, 'textDocument/didOpen', {
      textDocument: { uri, languageId, version, text }
    })
  }

  didChange(sessionId: string, language: string, uri: string, version: number, text: string): void {
    const key = this.getKey(sessionId, language)
    this.sendNotification(key, 'textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }]
    })
  }

  didClose(sessionId: string, language: string, uri: string): void {
    const key = this.getKey(sessionId, language)
    this.sendNotification(key, 'textDocument/didClose', {
      textDocument: { uri }
    })
  }

  didSave(sessionId: string, language: string, uri: string, text: string): void {
    const key = this.getKey(sessionId, language)
    this.sendNotification(key, 'textDocument/didSave', {
      textDocument: { uri },
      text
    })
  }

  // ===== Cleanup =====
  private cleanup(key: string): void {
    const session = this.sessions.get(key)
    if (session) {
      for (const [, pending] of session.pendingRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error('LSP session closed'))
      }
      session.pendingRequests.clear()
    }
    this.sessions.delete(key)
  }

  // ===== Notifications to renderer =====
  private notifyDiagnostics(sessionId: string, language: string, params: any): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('lsp:diagnostics', sessionId, language, params)
    }
  }

  private notifyLspStatus(sessionId: string, language: string, status: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('lsp:status', sessionId, language, status)
    }
  }

  private notifyLspLog(sessionId: string, language: string, message: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('lsp:log', sessionId, language, message)
    }
  }
}

export const lspManager = new LspManager()
