import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerSSHHandlers } from './ipc/sshHandlers'
import { registerSFTPHandlers } from './ipc/sftpHandlers'
import { registerMonitorHandlers } from './ipc/monitorHandlers'
import { registerDockerHandlers } from './ipc/dockerHandlers'
import { registerConfigHandlers } from './ipc/configHandlers'
import { registerPortForwardHandlers } from './ipc/portForwardHandlers'
import { registerAIHandlers } from './ipc/aiHandlers'
import { registerWorkspaceHandlers } from './ipc/workspaceHandlers'
import { registerLspHandlers } from './ipc/lspHandlers'
import { registerSystemHandlers } from './ipc/systemHandlers'
import { sshManager } from './ssh/SSHManager'
import { serverMonitor } from './monitor/ServerMonitor'
import { configStore } from './store/ConfigStore'

// Prevent uncaught exceptions from crashing the app (e.g., ssh2 socket errors)
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message)
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const savedBounds = configStore.getWindowBounds()

  mainWindow = new BrowserWindow({
    width: savedBounds.width,
    height: savedBounds.height,
    x: savedBounds.x,
    y: savedBounds.y,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (savedBounds.isMaximized) {
    mainWindow.maximize()
  }

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // Save window bounds on move/resize (debounced)
  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (!mainWindow) return
      const isMaximized = mainWindow.isMaximized()
      if (!isMaximized) {
        const bounds = mainWindow.getBounds()
        configStore.saveWindowBounds({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized: false
        })
      } else {
        // Only update maximized flag, keep the last normal bounds
        const current = configStore.getWindowBounds()
        configStore.saveWindowBounds({ ...current, isMaximized: true })
      }
    }, 500)
  }
  mainWindow.on('resize', saveBounds)
  mainWindow.on('move', saveBounds)
  mainWindow.on('maximize', saveBounds)
  mainWindow.on('unmaximize', saveBounds)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Window control IPC handlers
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized())
  ipcMain.on('window:setSize', (_event, width: number, height: number) => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize()
      mainWindow.setSize(width, height)
      mainWindow.center()
    }
  })
}

// Cleanup all resources before quitting
async function cleanupBeforeQuit(): Promise<void> {
  try {
    serverMonitor.stopAll()
    await sshManager.disconnectAll()
  } catch {
    // Ignore cleanup errors on exit
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.supershell.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Register all IPC handlers
  registerSSHHandlers()
  registerSFTPHandlers()
  registerMonitorHandlers()
  registerDockerHandlers()
  registerConfigHandlers()
  registerPortForwardHandlers()
  registerAIHandlers()
  registerWorkspaceHandlers()
  registerLspHandlers()
  registerSystemHandlers()

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async (e) => {
  e.preventDefault()
  await cleanupBeforeQuit()
  app.exit(0)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    cleanupBeforeQuit().then(() => app.quit())
  }
})
