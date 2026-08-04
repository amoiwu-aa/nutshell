# Architecture

## Process boundaries

Nutshell uses Electron's three-process model:

- **Main process** (`src/main/`) owns SSH connections, SFTP transfers, monitoring, Docker, port forwarding, configuration storage, and the Rust sidecar.
- **Preload** (`src/preload/`) is the only renderer bridge. It exposes `window.api` through `contextBridge`.
- **Renderer** (`src/renderer/src/`) is a React SPA with no direct Node.js access.

## IPC

Request/response operations use `ipcRenderer.invoke()` and `ipcMain.handle()`. High-frequency data such as terminal output, monitor metrics, and transfer progress is streamed as events and batched in the renderer where appropriate.

IPC handlers are grouped by feature in `src/main/ipc/`:

- `sshHandlers.ts`
- `sftpHandlers.ts`
- `monitorHandlers.ts`
- `dockerHandlers.ts`
- `portForwardHandlers.ts`
- `workspaceHandlers.ts`
- `rustCoreHandlers.ts`
- `configHandlers.ts`

## Service layer

The main process keeps transport and feature logic outside the IPC handlers:

- `SSHManager` manages Node.js SSH sessions and interactive shells.
- `SFTPManager` manages standard SFTP operations and transfer queues.
- `ServerMonitor` batches remote metric collection and maintains monitoring state.
- `DockerManager` validates Docker arguments and executes remote Docker operations.
- `WorkspaceService` provides remote browsing, search, Git integration, and file access.
- `ConfigStore` persists encrypted connection and application configuration.
- `RustCoreService` supervises the Rust process and handles framed JSON RPC.
- `RustRemoteFS` routes native filesystem and transfer operations to the Rust core.

## Rust sidecar

`native/nutshell-core/` is a standalone Rust binary using `russh` and `russh-sftp`. The Node main process launches it as a child process and communicates through framed JSON over stdio. The sidecar is built by `scripts/build-native.mjs` and copied into packaged application resources by electron-builder.

## Security boundaries

Remote output, filenames, Docker metadata, and editor content are treated as untrusted. Application-managed command arguments are validated and quoted, and SFTP APIs are preferred when a shell command is not required. Credentials stay in the main process and are persisted through the encrypted configuration store.
