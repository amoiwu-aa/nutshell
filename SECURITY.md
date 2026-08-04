# Security Policy

## Supported versions

Nutshell is currently under active development. Security fixes are applied to the latest development branch first.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Use a private GitHub Security Advisory for this repository when available. If private advisories are unavailable, contact the maintainer through the GitHub profile and include only the minimum necessary reproduction details.

Please never include:

- SSH passwords or private keys
- API tokens or access tokens
- Real hostnames, IP addresses, or customer data
- Unredacted terminal logs

## Scope

Security reports are especially useful for:

- Credential exposure or encryption failures
- SSH host-key verification bypasses
- Renderer-to-main privilege escalation
- Shell injection through application-managed commands
- Path traversal in local or remote file operations
- Rust sidecar protocol or process-boundary issues
- Unsafe external URL handling
