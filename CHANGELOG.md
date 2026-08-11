# Changelog

All notable changes to Nutshell are documented here.

## [1.0.4]

- Fixed remote port forwarding rules cross-wiring each other's connections and never releasing the server-side listener on removal.
- Fixed main-process crashes from unhandled socket errors in local, remote, and dynamic port forwarding.
- Added IPv6 support and protocol-compliant error replies to the dynamic SOCKS5 proxy.
- Applied the Rust engine's command risk policy to workspace commands on ssh2 (jump-host) sessions.
- Upgraded saved-credential encryption to OS-backed safeStorage with an AES-256-GCM fallback; existing records migrate automatically.
- Added Docker container log streaming for ssh2 (jump-host) sessions.
- Added unit tests for SOCKS5 parsing, command risk assessment, and credential encryption.
- Updated contributor docs to match the configured toolchain and dual-engine routing.

## [1.0.3]

- Added repository-wide TypeScript, ESLint, Vitest, and Rust checks.
- Added GitHub Actions quality and platform packaging workflows.
- Added automatic Rust sidecar builds for packaging.
- Improved terminal renderer lifecycle safety and shell prompt detection.
- Continued SSH host-key, credential-storage, shell-quoting, and remote-file safety work.

## [1.0.2]

- Current development baseline for the Electron SSH remote management application.
- Includes terminal, SFTP, monitoring, Docker, port forwarding, remote workspace, snippets, and Rust sidecar integration.
