# Contributing

Thanks for considering a contribution to Nutshell.

## Before opening an issue

- Search existing issues first.
- Confirm the issue is reproducible on the latest `rust-upgrade` branch.
- Remove passwords, private keys, hostnames, IP addresses, and tokens from logs.

## Development setup

```bash
npm install
npm run dev
```

For Rust changes:

```bash
cargo check --manifest-path native/nutshell-core/Cargo.toml
npm run native:build
```

Before opening a pull request, run:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Pull requests

Keep pull requests focused. Explain:

- What changed and why.
- Which process boundary or IPC contract is affected.
- How the change was tested.
- Any platform-specific limitations.

Do not commit generated directories such as `node_modules/`, `out/`, `dist/`, or Rust `target/`.
