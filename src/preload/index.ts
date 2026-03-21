import { clipboard, contextBridge, ipcRenderer, webUtils } from 'electron'

// Types for the API
export interface SSHConnectionConfig {
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
  aiCompatibilityMode?: boolean
}

export interface PortForwardRule {
  id: string
  connectionId: string
  type: 'local' | 'remote' | 'dynamic'
  localHost: string
  localPort: number
  remoteHost: string
  remotePort: number
  enabled: boolean
}

const api = {
  // Window controls
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    setSize: (width: number, height: number) => ipcRenderer.send('window:setSize', width, height)
  },

  // SSH operations
  ssh: {
    connect: (config: SSHConnectionConfig) => ipcRenderer.invoke('ssh:connect', config),
    disconnect: (sessionId: string) => ipcRenderer.invoke('ssh:disconnect', sessionId),
    runDiagnostics: (sessionId: string) => ipcRenderer.invoke('ssh:runDiagnostics', sessionId),
    write: (sessionId: string, data: string) => ipcRenderer.send('ssh:write', sessionId, data),
    resize: (sessionId: string, cols: number, rows: number) =>
      ipcRenderer.send('ssh:resize', sessionId, cols, rows),
    onData: (callback: (sessionId: string, data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: string) =>
        callback(sessionId, data)
      ipcRenderer.on('ssh:data', handler)
      return () => ipcRenderer.removeListener('ssh:data', handler)
    },
    onClose: (callback: (sessionId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string) =>
        callback(sessionId)
      ipcRenderer.on('ssh:close', handler)
      return () => ipcRenderer.removeListener('ssh:close', handler)
    },
    onError: (callback: (sessionId: string, error: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, error: string) =>
        callback(sessionId, error)
      ipcRenderer.on('ssh:error', handler)
      return () => ipcRenderer.removeListener('ssh:error', handler)
    },
    onReconnecting: (callback: (sessionId: string, attempt: number, delay: number) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        sessionId: string,
        attempt: number,
        delay: number
      ) => callback(sessionId, attempt, delay)
      ipcRenderer.on('ssh:reconnecting', handler)
      return () => ipcRenderer.removeListener('ssh:reconnecting', handler)
    },
    onReconnected: (callback: (sessionId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string) =>
        callback(sessionId)
      ipcRenderer.on('ssh:reconnected', handler)
      return () => ipcRenderer.removeListener('ssh:reconnected', handler)
    }
  },

  // SFTP operations
  sftp: {
    list: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:list', sessionId, remotePath),
    upload: (sessionId: string, localPath: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:upload', sessionId, localPath, remotePath),
    download: (sessionId: string, remotePath: string, localPath: string) =>
      ipcRenderer.invoke('sftp:download', sessionId, remotePath, localPath),
    mkdir: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:mkdir', sessionId, remotePath),
    delete: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:delete', sessionId, remotePath),
    rename: (sessionId: string, oldPath: string, newPath: string) =>
      ipcRenderer.invoke('sftp:rename', sessionId, oldPath, newPath),
    readFile: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:readFile', sessionId, remotePath),
    writeFile: (sessionId: string, remotePath: string, content: string) =>
      ipcRenderer.invoke('sftp:writeFile', sessionId, remotePath, content),
    stat: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:stat', sessionId, remotePath),
    chmod: (sessionId: string, remotePath: string, mode: string) =>
      ipcRenderer.invoke('sftp:chmod', sessionId, remotePath, mode),
    listLocal: (localPath: string) => ipcRenderer.invoke('sftp:listLocal', localPath),
    statLocal: (localPath: string) => ipcRenderer.invoke('sftp:statLocal', localPath),
    getHomeDir: () => ipcRenderer.invoke('sftp:getHomeDir'),
    getRemoteHomeDir: (sessionId: string) =>
      ipcRenderer.invoke('sftp:getRemoteHomeDir', sessionId),
    uploadWithId: (sessionId: string, localPath: string, remotePath: string, transferId: string, resumeOffset?: number) =>
      ipcRenderer.invoke('sftp:uploadWithId', sessionId, localPath, remotePath, transferId, resumeOffset),
    downloadWithId: (sessionId: string, remotePath: string, localPath: string, transferId: string, resumeOffset?: number) =>
      ipcRenderer.invoke('sftp:downloadWithId', sessionId, remotePath, localPath, transferId, resumeOffset),
    uploadDir: (sessionId: string, localPath: string, remotePath: string, transferId: string) =>
      ipcRenderer.invoke('sftp:uploadDir', sessionId, localPath, remotePath, transferId),
    downloadDir: (sessionId: string, remotePath: string, localPath: string, transferId: string) =>
      ipcRenderer.invoke('sftp:downloadDir', sessionId, remotePath, localPath, transferId),
    cancelTransfer: (transferId: string) =>
      ipcRenderer.invoke('sftp:cancelTransfer', transferId),
    skipFile: (transferId: string, fileIndex: number) =>
      ipcRenderer.invoke('sftp:skipFile', transferId, fileIndex),
    getRemoteFileSize: (sessionId: string, remotePath: string) =>
      ipcRenderer.invoke('sftp:getRemoteFileSize', sessionId, remotePath),
    selectDirectory: (title?: string) =>
      ipcRenderer.invoke('sftp:selectDirectory', title),
    onProgress: (callback: (id: string, transferred: number, total: number, currentFile?: string) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        id: string,
        transferred: number,
        total: number,
        currentFile?: string
      ) => callback(id, transferred, total, currentFile)
      ipcRenderer.on('sftp:progress', handler)
      return () => ipcRenderer.removeListener('sftp:progress', handler)
    },
    onDirFileList: (callback: (transferId: string, files: any[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, transferId: string, files: any[]) =>
        callback(transferId, files)
      ipcRenderer.on('sftp:dirFileList', handler)
      return () => ipcRenderer.removeListener('sftp:dirFileList', handler)
    },
    onFileStatus: (callback: (transferId: string, fileIndex: number, status: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, transferId: string, fileIndex: number, status: string) =>
        callback(transferId, fileIndex, status)
      ipcRenderer.on('sftp:fileStatus', handler)
      return () => ipcRenderer.removeListener('sftp:fileStatus', handler)
    }
  },

  // Monitor operations
  monitor: {
    start: (sessionId: string, interval?: number, modules?: any) =>
      ipcRenderer.invoke('monitor:start', sessionId, interval, modules),
    stop: (sessionId: string) => ipcRenderer.invoke('monitor:stop', sessionId),
    updateModules: (sessionId: string, modules: any) =>
      ipcRenderer.invoke('monitor:updateModules', sessionId, modules),
    getSystemInfo: (sessionId: string) =>
      ipcRenderer.invoke('monitor:getSystemInfo', sessionId),
    getProcesses: (sessionId: string) => ipcRenderer.invoke('monitor:getProcesses', sessionId),
    getListeningPorts: (sessionId: string) =>
      ipcRenderer.invoke('monitor:getListeningPorts', sessionId),
    killProcess: (sessionId: string, pid: number, signal?: number) =>
      ipcRenderer.invoke('monitor:killProcess', sessionId, pid, signal),
    killProcesses: (sessionId: string, pids: number[], signal?: number) =>
      ipcRenderer.invoke('monitor:killProcesses', sessionId, pids, signal),
    onData: (callback: (sessionId: string, data: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, data: any) =>
        callback(sessionId, data)
      ipcRenderer.on('monitor:data', handler)
      return () => ipcRenderer.removeListener('monitor:data', handler)
    },
    onError: (callback: (sessionId: string, message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, message: string) =>
        callback(sessionId, message)
      ipcRenderer.on('monitor:error', handler)
      return () => ipcRenderer.removeListener('monitor:error', handler)
    }
  },

  // System operations
  system: {
    openLocalFile: (path: string) => ipcRenderer.invoke('system:openLocalFile', path),
    showItemInFolder: (path: string) => ipcRenderer.invoke('system:showItemInFolder', path),
    watchLocalFile: (sessionId: string, localPath: string, remotePath: string) => ipcRenderer.invoke('system:watchLocalFile', sessionId, localPath, remotePath),
    unwatchLocalFile: (localPath: string) => ipcRenderer.invoke('system:unwatchLocalFile', localPath),
    getTempDir: () => ipcRenderer.invoke('system:getTempDir')
  },

  // Docker operations
  docker: {
    listContainers: (sessionId: string) =>
      ipcRenderer.invoke('docker:listContainers', sessionId),
    listImages: (sessionId: string) => ipcRenderer.invoke('docker:listImages', sessionId),
    containerAction: (sessionId: string, containerId: string, action: string) =>
      ipcRenderer.invoke('docker:containerAction', sessionId, containerId, action),
    containerLogs: (
      sessionId: string,
      containerId: string,
      options?: { tail?: number | 'all'; since?: string; until?: string }
    ) => ipcRenderer.invoke('docker:containerLogs', sessionId, containerId, options),
    containerExec: (sessionId: string, containerId: string) =>
      ipcRenderer.invoke('docker:containerExec', sessionId, containerId),
    pullImage: (sessionId: string, image: string) =>
      ipcRenderer.invoke('docker:pullImage', sessionId, image),
    removeImage: (sessionId: string, imageId: string) =>
      ipcRenderer.invoke('docker:removeImage', sessionId, imageId),
    listContainerFiles: (sessionId: string, containerId: string, path: string) =>
      ipcRenderer.invoke('docker:listContainerFiles', sessionId, containerId, path),
    copyToContainer: (
      sessionId: string,
      containerId: string,
      localPath: string,
      containerPath: string
    ) =>
      ipcRenderer.invoke(
        'docker:copyToContainer',
        sessionId,
        containerId,
        localPath,
        containerPath
      ),
    copyFromContainer: (
      sessionId: string,
      containerId: string,
      containerPath: string,
      localPath: string
    ) =>
      ipcRenderer.invoke(
        'docker:copyFromContainer',
        sessionId,
        containerId,
        containerPath,
        localPath
      ),
    onLogs: (callback: (containerId: string, data: string) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        containerId: string,
        data: string
      ) => callback(containerId, data)
      ipcRenderer.on('docker:logs', handler)
      return () => ipcRenderer.removeListener('docker:logs', handler)
    },
    // Inspect
    inspectContainer: (sessionId: string, containerId: string) =>
      ipcRenderer.invoke('docker:inspectContainer', sessionId, containerId),
    // Networks
    listNetworks: (sessionId: string) => ipcRenderer.invoke('docker:listNetworks', sessionId),
    createNetwork: (sessionId: string, name: string, driver: string, subnet?: string) =>
      ipcRenderer.invoke('docker:createNetwork', sessionId, name, driver, subnet),
    removeNetwork: (sessionId: string, networkId: string) =>
      ipcRenderer.invoke('docker:removeNetwork', sessionId, networkId),
    connectNetwork: (sessionId: string, networkId: string, containerId: string) =>
      ipcRenderer.invoke('docker:connectNetwork', sessionId, networkId, containerId),
    disconnectNetwork: (sessionId: string, networkId: string, containerId: string) =>
      ipcRenderer.invoke('docker:disconnectNetwork', sessionId, networkId, containerId),
    // Registry
    getRegistryMirrors: (sessionId: string) => ipcRenderer.invoke('docker:getRegistryMirrors', sessionId),
    setRegistryMirrors: (sessionId: string, mirrors: string[]) =>
      ipcRenderer.invoke('docker:setRegistryMirrors', sessionId, mirrors),
    // Compose
    listComposeProjects: (sessionId: string) => ipcRenderer.invoke('docker:listComposeProjects', sessionId),
    composeAction: (sessionId: string, dir: string, action: string) =>
      ipcRenderer.invoke('docker:composeAction', sessionId, dir, action),
    getComposeFile: (sessionId: string, path: string) =>
      ipcRenderer.invoke('docker:getComposeFile', sessionId, path),
    saveComposeFile: (sessionId: string, path: string, content: string) =>
      ipcRenderer.invoke('docker:saveComposeFile', sessionId, path, content),
    // Create container
    createContainer: (sessionId: string, options: any) =>
      ipcRenderer.invoke('docker:createContainer', sessionId, options)
  },

  // Port forwarding
  portForward: {
    create: (rule: PortForwardRule) => ipcRenderer.invoke('portForward:create', rule),
    remove: (ruleId: string) => ipcRenderer.invoke('portForward:remove', ruleId),
    list: (sessionId: string) => ipcRenderer.invoke('portForward:list', sessionId),
    onStatus: (callback: (ruleId: string, status: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, ruleId: string, status: string) =>
        callback(ruleId, status)
      ipcRenderer.on('portForward:status', handler)
      return () => ipcRenderer.removeListener('portForward:status', handler)
    }
  },

  // AI assistant
  ai: {
    chat: (messages: Array<{ role: string; content: string }>) =>
      ipcRenderer.invoke('ai:chat', messages),
    generateCommand: (description: string) =>
      ipcRenderer.invoke('ai:generateCommand', description),
    explainCommand: (command: string) =>
      ipcRenderer.invoke('ai:explainCommand', command),
    diagnoseError: (errorOutput: string) =>
      ipcRenderer.invoke('ai:diagnoseError', errorOutput),
    codeGenerate: (fileContent: string, language: string, instruction: string) =>
      ipcRenderer.invoke('ai:codeGenerate', fileContent, language, instruction),
    codeExplain: (code: string, language: string) =>
      ipcRenderer.invoke('ai:codeExplain', code, language),
    codeRefactor: (code: string, language: string, instruction: string) =>
      ipcRenderer.invoke('ai:codeRefactor', code, language, instruction),
    codeFix: (code: string, language: string, error: string) =>
      ipcRenderer.invoke('ai:codeFix', code, language, error),
    generateScript: (type: string, description: string) =>
      ipcRenderer.invoke('ai:generateScript', type, description),
    agentChat: (messages: any[], sessionId: string, rootPath: string, maxIterations?: number) =>
      ipcRenderer.invoke('ai:agentChat', messages, sessionId, rootPath, maxIterations),
    onToolCall: (callback: (name: string, args: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, name: string, args: any) => callback(name, args)
      ipcRenderer.on('ai:toolCall', handler)
      return () => ipcRenderer.removeListener('ai:toolCall', handler)
    }
  },

  // Workspace
  workspace: {
    listDirectory: (sessionId: string, path: string) =>
      ipcRenderer.invoke('workspace:listDirectory', sessionId, path),
    searchFiles: (sessionId: string, rootPath: string, query: string) =>
      ipcRenderer.invoke('workspace:searchFiles', sessionId, rootPath, query),
    searchFileNames: (sessionId: string, rootPath: string, pattern: string) =>
      ipcRenderer.invoke('workspace:searchFileNames', sessionId, rootPath, pattern),
    getGitStatus: (sessionId: string, rootPath: string) =>
      ipcRenderer.invoke('workspace:getGitStatus', sessionId, rootPath),
    getGitDiff: (sessionId: string, rootPath: string, file: string) =>
      ipcRenderer.invoke('workspace:getGitDiff', sessionId, rootPath, file),
    scanProject: (sessionId: string, rootPath: string) =>
      ipcRenderer.invoke('workspace:scanProject', sessionId, rootPath),
    readMultipleFiles: (sessionId: string, paths: string[]) =>
      ipcRenderer.invoke('workspace:readMultipleFiles', sessionId, paths),
    getProjectSummary: (sessionId: string, rootPath: string) =>
      ipcRenderer.invoke('workspace:getProjectSummary', sessionId, rootPath),
    agentReadFile: (sessionId: string, filePath: string) =>
      ipcRenderer.invoke('workspace:agentReadFile', sessionId, filePath),
    agentWriteFile: (sessionId: string, filePath: string, content: string) =>
      ipcRenderer.invoke('workspace:agentWriteFile', sessionId, filePath, content),
    agentRunCommand: (sessionId: string, rootPath: string, command: string) =>
      ipcRenderer.invoke('workspace:agentRunCommand', sessionId, rootPath, command)
  },

  // LSP (Language Server Protocol)
  lsp: {
    start: (sessionId: string, rootPath: string, language: string) =>
      ipcRenderer.invoke('lsp:start', sessionId, rootPath, language),
    stop: (sessionId: string, language: string) =>
      ipcRenderer.invoke('lsp:stop', sessionId, language),
    stopAll: (sessionId: string) =>
      ipcRenderer.invoke('lsp:stopAll', sessionId),
    request: (sessionId: string, language: string, method: string, params: any) =>
      ipcRenderer.invoke('lsp:request', sessionId, language, method, params),
    notify: (sessionId: string, language: string, method: string, params: any) =>
      ipcRenderer.invoke('lsp:notify', sessionId, language, method, params),
    checkAvailability: (sessionId: string, language: string) =>
      ipcRenderer.invoke('lsp:checkAvailability', sessionId, language),
    detectServers: (sessionId: string, rootPath: string) =>
      ipcRenderer.invoke('lsp:detectServers', sessionId, rootPath),
    getRunning: (sessionId: string) =>
      ipcRenderer.invoke('lsp:getRunning', sessionId),
    didOpen: (sessionId: string, language: string, uri: string, languageId: string, version: number, text: string) =>
      ipcRenderer.invoke('lsp:didOpen', sessionId, language, uri, languageId, version, text),
    didChange: (sessionId: string, language: string, uri: string, version: number, text: string) =>
      ipcRenderer.invoke('lsp:didChange', sessionId, language, uri, version, text),
    didClose: (sessionId: string, language: string, uri: string) =>
      ipcRenderer.invoke('lsp:didClose', sessionId, language, uri),
    didSave: (sessionId: string, language: string, uri: string, text: string) =>
      ipcRenderer.invoke('lsp:didSave', sessionId, language, uri, text),
    onDiagnostics: (callback: (sessionId: string, language: string, params: any) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, language: string, params: any) =>
        callback(sessionId, language, params)
      ipcRenderer.on('lsp:diagnostics', handler)
      return () => ipcRenderer.removeListener('lsp:diagnostics', handler)
    },
    onStatus: (callback: (sessionId: string, language: string, status: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, language: string, status: string) =>
        callback(sessionId, language, status)
      ipcRenderer.on('lsp:status', handler)
      return () => ipcRenderer.removeListener('lsp:status', handler)
    },
    onLog: (callback: (sessionId: string, language: string, message: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, sessionId: string, language: string, message: string) =>
        callback(sessionId, language, message)
      ipcRenderer.on('lsp:log', handler)
      return () => ipcRenderer.removeListener('lsp:log', handler)
    }
  },

  // File utilities (Electron 32+ requires webUtils for drag-drop file paths)
  file: {
    getPathForFile: (file: File): string => webUtils.getPathForFile(file)
  },

  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (text: string) => clipboard.writeText(text)
  },

  rustCore: {
    status: () => ipcRenderer.invoke('rustCore:status'),
    migrationPlan: () => ipcRenderer.invoke('rustCore:migrationPlan'),
    aiBlueprint: () => ipcRenderer.invoke('rustCore:aiBlueprint'),
    runCommand: (params: {
      sessionId: string
      command: string
      cwd?: string
      timeoutMs?: number
      env?: Array<{ key: string; value: string }>
    }) => ipcRenderer.invoke('rustCore:runCommand', params),
    listDir: (params: { sessionId: string; path: string }) => ipcRenderer.invoke('rustCore:listDir', params),
    readFile: (params: { sessionId: string; path: string; maxBytes?: number }) => ipcRenderer.invoke('rustCore:readFile', params),
    search: (params: { sessionId: string; rootPath: string; pattern: string; limit?: number }) => ipcRenderer.invoke('rustCore:search', params),
    writeFile: (params: { sessionId: string; path: string; content: string; createDirs?: boolean }) => ipcRenderer.invoke('rustCore:writeFile', params),
    statPath: (params: { sessionId: string; path: string }) => ipcRenderer.invoke('rustCore:statPath', params),
    mkdir: (params: { sessionId: string; path: string; recursive?: boolean }) => ipcRenderer.invoke('rustCore:mkdir', params),
    removePath: (params: { sessionId: string; path: string; recursive?: boolean }) => ipcRenderer.invoke('rustCore:removePath', params),
    movePath: (params: { sessionId: string; fromPath: string; toPath: string }) => ipcRenderer.invoke('rustCore:movePath', params),
    readMultipleFiles: (params: { sessionId: string; paths: string[]; maxBytesPerFile?: number }) => ipcRenderer.invoke('rustCore:readMultipleFiles', params),
    scanProject: (params: { sessionId: string; rootPath: string }) => ipcRenderer.invoke('rustCore:scanProject', params),
    projectSummary: (params: { sessionId: string; rootPath: string }) => ipcRenderer.invoke('rustCore:projectSummary', params)
  },

  // Config store
  config: {
    getConnections: () => ipcRenderer.invoke('config:getConnections'),
    saveConnection: (connection: SSHConnectionConfig) =>
      ipcRenderer.invoke('config:saveConnection', connection),
    deleteConnection: (id: string) => ipcRenderer.invoke('config:deleteConnection', id),
    getSnippets: () => ipcRenderer.invoke('config:getSnippets'),
    saveSnippet: (snippet: any) => ipcRenderer.invoke('config:saveSnippet', snippet),
    deleteSnippet: (id: string) => ipcRenderer.invoke('config:deleteSnippet', id),
    getSettings: () => ipcRenderer.invoke('config:getSettings'),
    saveSettings: (settings: any) => ipcRenderer.invoke('config:saveSettings', settings),
    selectFile: (options?: any) => ipcRenderer.invoke('config:selectFile', options),
    selectDirectory: () => ipcRenderer.invoke('config:selectDirectory'),
    importSnippets: (snippets: any[], mode: 'merge' | 'replace') =>
      ipcRenderer.invoke('config:importSnippets', snippets, mode),
    getSessionState: () => ipcRenderer.invoke('config:getSessionState'),
    saveSessionState: (state: any) => ipcRenderer.invoke('config:saveSessionState', state),
    getAIChatHistory: (workspacePath: string) => ipcRenderer.invoke('config:getAIChatHistory', workspacePath),
    saveAIChatHistory: (workspacePath: string, messages: any[]) => ipcRenderer.invoke('config:saveAIChatHistory', workspacePath, messages),
    getConversations: (workspacePath: string) => ipcRenderer.invoke('config:getConversations', workspacePath),
    getConversation: (workspacePath: string, convId: string) => ipcRenderer.invoke('config:getConversation', workspacePath, convId),
    saveConversation: (workspacePath: string, conversation: any) => ipcRenderer.invoke('config:saveConversation', workspacePath, conversation),
    deleteConversation: (workspacePath: string, convId: string) => ipcRenderer.invoke('config:deleteConversation', workspacePath, convId)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type API = typeof api
