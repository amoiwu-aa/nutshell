# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev          # Start dev mode with hot reload (electron-vite dev)
npm run build        # Production build (electron-vite build)
npm run build:win    # Build Windows installer (NSIS + portable)
npm run build:mac    # Build macOS installer
npm run build:linux  # Build Linux installer
```

No test runner or linter is configured.

## Architecture

Nutshell is an Electron 33 + React 19 + TypeScript SSH remote management tool. It follows the standard Electron three-process model:

### Process Boundaries

- **Main process** (`src/main/`): Node.js runtime with full system access. Manages SSH connections, SFTP transfers, server monitoring, Docker, AI services, LSP servers, and encrypted config storage.
- **Preload** (`src/preload/index.ts`): The single bridge between main and renderer. Exposes `window.api` via `contextBridge.exposeInMainWorld()`. All IPC channels are defined here — this is the source of truth for what the renderer can do.
- **Renderer** (`src/renderer/src/`): React 19 SPA with Tailwind CSS. No Node.js access; communicates exclusively through `window.api`.

### IPC Pattern

Two patterns used throughout:

1. **Request-response**: `ipcRenderer.invoke()` → `ipcMain.handle()` (async, returns Promise)
2. **Event streaming**: `ipcRenderer.on()` ← `mainWindow.webContents.send()` (for real-time data like terminal output, monitor metrics, transfer progress)

IPC handlers are organized per-feature in `src/main/ipc/` (e.g., `sshHandlers.ts`, `dockerHandlers.ts`). Each handler file exports a `register*Handlers()` function called from `src/main/index.ts`.

### Main Process Services

| Service | File | Purpose |
|---------|------|---------|
| SSHManager | `src/main/ssh/SSHManager.ts` | ssh2 connections, shell sessions, auto-reconnect with exponential backoff |
| SFTPManager | `src/main/ssh/SFTPManager.ts` | File transfers with resumable uploads/downloads and progress events |
| PortForwardManager | `src/main/ssh/PortForward.ts` | Local/remote/dynamic (SOCKS5) port forwarding via SSH tunnels |
| ServerMonitor | `src/main/monitor/ServerMonitor.ts` | Polls remote servers for CPU/memory/disk/network/process metrics |
| DockerManager | `src/main/docker/DockerManager.ts` | Docker CLI commands executed over SSH (containers, images, compose, networks) |
| AIService | `src/main/ai/AIService.ts` | OpenAI/Claude/DeepSeek API integration for command generation and code assistance |
| LspManager | `src/main/lsp/LspManager.ts` | Spawns remote language servers via SSH, JSON-RPC 2.0 protocol |
| WorkspaceService | `src/main/workspace/WorkspaceService.ts` | Remote file browsing, grep search, git status/diff |
| ConfigStore | `src/main/store/ConfigStore.ts` | electron-store with AES-256-CBC encryption (machine-specific key) |

### Renderer Structure

- **State management**: Zustand 5.0 stores in `src/renderer/src/stores/`
  - `connectionStore.ts` — connections, tabs, layout state
  - `settingsStore.ts` — theme, fonts, monitor module toggles
  - `transferStore.ts` — SFTP transfer queue with speed/ETA calculation
- **Layout**: Custom frameless window with `TitleBar`, `Sidebar`, `TabBar`, `ContentArea`, `BottomPanel`, `StatusBar` in `components/layout/`
- **Feature panels**: `components/terminal/`, `components/sftp/`, `components/monitor/`, `components/docker/`, `components/workspace/`, `components/portforward/`
- **Terminal**: xterm.js 5.5 with fit, search, unicode11, web-links addons
- **Editor**: Monaco Editor 0.55 with remote LSP integration via `lib/LspProviderBridge.ts`

### Path Aliases

- `@main/*` → `src/main/*` (main process)
- `@renderer/*` → `src/renderer/src/*` (renderer)

## Critical Patterns

### Zustand: Never Return Objects from Selectors

`Object.is` comparison fails for new object literals, causing infinite re-render loops:

```typescript
// WRONG — creates new object every render, triggers infinite loop
useStore(s => ({ a: s.a, b: s.b }))

// CORRECT — use separate primitive selectors
const a = useStore(s => s.a)
const b = useStore(s => s.b)

// CORRECT — if you must return an object, use shallow equality
import { shallow } from 'zustand/shallow'
useStore(s => ({ a: s.a, b: s.b }), shallow)
```

### High-Frequency IPC Batching

Terminal data, monitor metrics, and transfer progress arrive at high frequency. Always batch with `requestAnimationFrame` to prevent UI stutter:

```typescript
// Batch SSH data updates
let pending = ''
window.api.ssh.onData((id, data) => {
  pending += data
  requestAnimationFrame(() => {
    terminal.write(pending)
    pending = ''
  })
})
```

### Recharts Real-Time Charts

Always disable animations on charts that update in real-time:
```tsx
<LineChart><Line isAnimationActive={false} /></LineChart>
```

### Component State Preservation

Use CSS `hidden` class instead of conditional rendering (`{show && <Component/>}`) to keep components mounted and preserve their state (terminal sessions, editor content, etc.).

### Electron 33 File Path

`File.path` was removed in Electron 32+. Use the preload bridge:
```typescript
const path = window.api.file.getPathForFile(file)
```

### Adding a New IPC Feature

1. Add methods to `api` object in `src/preload/index.ts`
2. Create handler file `src/main/ipc/myFeatureHandlers.ts` with `registerMyFeatureHandlers()`
3. Call the register function from `src/main/index.ts`
4. Access from renderer via `window.api.myFeature.method()`

### Security

- Docker commands validated with regex to prevent injection
- SSH credentials encrypted at rest (AES-256-CBC, machine-specific key)
- Context isolation enabled, node integration disabled
- All renderer↔main communication through preload bridge only
