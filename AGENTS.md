# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev          # Start dev mode with hot reload (electron-vite dev)
npm run build        # Production build (electron-vite build)
npm run build:win    # Build Windows installer (NSIS + portable)
npm run build:mac    # Build macOS installer
npm run build:linux  # Build Linux installer
npm run typecheck    # tsc over tsconfig.web.json and tsconfig.node.json
npm run lint         # ESLint 10 over src and tests (config: eslint.config.mjs)
npm test             # vitest run — *.test.ts files co-located with source
```

Tests use Vitest (`*.test.ts` files placed next to the source they cover); linting uses ESLint 10 (flat config in `eslint.config.mjs`). CI (`.github/workflows/ci.yml`) runs typecheck → lint → test → `cargo check` → build.

## Architecture

Nutshell is an Electron 33 + React 19 + TypeScript SSH remote management tool. It follows the standard Electron three-process model:

### Process Boundaries

- **Main process** (`src/main/`): Node.js runtime with full system access. Manages SSH connections, SFTP transfers, server monitoring, Docker, encrypted config storage, and the Rust sidecar.
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
| WorkspaceService | `src/main/workspace/WorkspaceService.ts` | Remote file browsing, grep search, git status/diff |
| RustCoreService | `src/main/rust/RustCoreService.ts` | Supervises the Rust sidecar: JSON-over-stdio RPC, crash recovery, session restore |
| RustRemoteFS | `src/main/rust/RustRemoteFS.ts` | Remote filesystem operations routed through the Rust core |
| KnownHosts | `src/main/ssh/KnownHosts.ts` | Trust-on-first-use host key store, shared by both SSH engines |
| ConfigStore | `src/main/store/ConfigStore.ts` | electron-store with AES-256-CBC encryption (machine-derived key + per-install salt) |

### Dual SSH Engine Routing

- `settings.useRustSshEngine` defaults to `true`.
- On `ssh:connect` (`src/main/ipc/sshHandlers.ts`), connections without a `jumpHost` are handled by the Rust sidecar (session ids prefixed `rust-`); connections with a jump host fall back to the Node ssh2 engine (`SSHManager`).
- Downstream services (`WorkspaceService`, `DockerManager`, SFTP handlers, `ServerMonitor`, port forwarding) pick their implementation per session id by asking `rustCoreService` (e.g. `hasSshSession()`).
- Most features therefore have two parallel implementations — one Node, one Rust. When changing behavior, consider (and test) both code paths.

### Renderer Structure

- **State management**: Zustand 5.0 stores in `src/renderer/src/stores/`
  - `connectionStore.ts` — connections, tabs, layout state
  - `settingsStore.ts` — theme, fonts, monitor module toggles
  - `transferStore.ts` — SFTP transfer queue with speed/ETA calculation
- **Layout**: Custom frameless window with `TitleBar`, `Sidebar`, `TabBar`, `ContentArea`, `BottomPanel`, `StatusBar` in `components/layout/`
- **Feature panels**: `components/terminal/`, `components/sftp/`, `components/monitor/`, `components/docker/`, `components/workspace/`, `components/portforward/`
- **Terminal**: xterm.js 5.5 with fit, search, unicode11, web-links addons
- **Editor**: Monaco Editor 0.55, configured in `lib/monacoSetup.ts`

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

**Never interpolate a value into a remote shell command.** `DockerManager` and
`WorkspaceService` each export a `shellQuote()` — use it for every path, name and
argument. Escaping double quotes is not enough: `$(...)` and backticks are still
evaluated inside them, and remote filenames are attacker-controlled. Where an
SFTP equivalent exists, prefer it over shelling out — `sftpManager.deleteFile()`
already removes directories recursively, so there is never a reason to run
`rm -rf`.

- Container IDs, image names, restart policies and network drivers are checked
  against allowlists before being used in a command
- Host keys are verified on every connection against `known_hosts.json` in
  userData; both engines share the store (`src/main/ssh/KnownHosts.ts`)
- SSH credentials are encrypted at rest (AES-256-CBC, machine-derived key plus a
  per-install salt). The crypto helpers must not swallow errors — returning the
  input on failure writes plaintext to disk, or sends ciphertext as a password
- Only http(s) URLs are handed to `shell.openExternal`
- Context isolation enabled, node integration disabled
- All renderer↔main communication through preload bridge only
