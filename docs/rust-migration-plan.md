# Rust Migration Plan

> **Status update (2026-08-12):** This plan has been largely executed; the sidecar is no longer a scaffold. `native/nutshell-core/src/main.rs` (~2,100 lines) now implements SSH connect/write/resize with streamed data/close/error events, a full remote-file toolset (list, read/write including binary variants, stat, mkdir, remove, move, chmod, search, multi-file read, project scan/summary), port forwarding (create/remove/list), docker exec and log streaming, native upload/download with cancellation, monitor snapshots, and command risk assessment (`assess_command_risk`). Phases 1 and 3 are complete; Phase 2 is complete except SSH auto-reconnect, which still lives in the Node `SSHManager`. Connections with a jump host also still use the Node ssh2 engine.

## Goal

Introduce a Rust sidecar that incrementally replaces the Electron main-process SSH core without forcing a full UI rewrite.

## Current Components

- `native/nutshell-core/` hosts the Rust sidecar crate.
- `src/main/rust/RustCoreService.ts` manages process startup, JSON-over-stdio RPC, and health checks.
- `src/main/ipc/rustCoreHandlers.ts` exposes readiness and migration-plan IPC endpoints.

## Phase 1 (completed)

Build the SSH session minimum viable loop in Rust:

1. `ssh.connect`
2. `ssh.open_shell`
3. `ssh.write`
4. `ssh.resize`
5. streamed `ssh.data` / `ssh.close` / `ssh.error` events

In the final implementation the shell is opened as part of `ssh.connect`; there is no separate `ssh.open_shell` method.

## Phase 2 (completed except auto-reconnect)

Move reconnection, shell diagnostics, and terminal environment setup into Rust.

Terminal environment setup (PTY request plus `TERM`/`COLORTERM`/`TERM_PROGRAM` env) is done in Rust, and diagnostics run through the Rust `runCommand` tool. SSH auto-reconnect remains in the Node `SSHManager`.

Structured remote tools now available in the Rust core:

- `runCommand`
- `listDir`
- `readFile`
- `readBinaryFile`
- `search`
- `writeFile`
- `writeBinaryFile`
- `statPath`
- `mkdir`
- `removePath`
- `movePath`
- `chmodPath`
- `readMultipleFiles`
- `scanProject`
- `projectSummary`

## Phase 3 (completed)

Port SFTP, port forwarding, and monitor sampling.

Implemented as `ssh.portForward.create/remove/list`, the `tool.*` file operations plus `tool.nativeUpload` / `tool.nativeDownload` / `tool.cancelNativeTransfer` for transfers, and `tool.monitorSnapshot` for monitor sampling.

## Notes

- The sidecar has grown well beyond its original scaffold role: it now carries the SSH transport, remote tooling, file transfers, port forwarding, and monitoring for connections without a jump host, while the Node ssh2 engine still handles jump-host connections and auto-reconnect.
- In development, the Electron main process will use `cargo run` if no debug binary exists yet.
