# Rust Migration Plan

## Goal

Introduce a Rust sidecar that incrementally replaces the Electron main-process SSH core without forcing a full UI rewrite.

## Current Scaffold

- `native/nutshell-core/` hosts the Rust sidecar crate.
- `src/main/rust/RustCoreService.ts` manages process startup, JSON-over-stdio RPC, and health checks.
- `src/main/ipc/rustCoreHandlers.ts` exposes readiness and migration-plan IPC endpoints.

## Phase 1

Build the SSH session minimum viable loop in Rust:

1. `ssh.connect`
2. `ssh.open_shell`
3. `ssh.write`
4. `ssh.resize`
5. streamed `ssh.data` / `ssh.close` / `ssh.error` events

## Phase 2

Move reconnection, shell diagnostics, and terminal environment setup into Rust.

Structured remote tools now available in the Rust core:

- `runCommand`
- `listDir`
- `readFile`
- `search`
- `writeFile`
- `statPath`
- `mkdir`
- `removePath`
- `movePath`
- `readMultipleFiles`
- `scanProject`
- `projectSummary`

## Phase 3

Port SFTP, port forwarding, and monitor sampling.

## Notes

- The current sidecar is intentionally a scaffold. It proves packaging, startup, health checks, and the IPC boundary before migrating the SSH transport.
- In development, the Electron main process will use `cargo run` if no debug binary exists yet.
