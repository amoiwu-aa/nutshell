## Summary

<!-- What changed and why? -->

## Scope

- [ ] Main process
- [ ] Preload / IPC
- [ ] Renderer
- [ ] Rust sidecar
- [ ] Documentation

## Validation

- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `cargo check --manifest-path native/nutshell-core/Cargo.toml` (if Rust-related)

## Security and privacy

- [ ] No credentials, private keys, tokens, or real host data are included.
- [ ] Remote paths and command arguments are validated appropriately.
- [ ] Any new IPC surface is exposed through the preload bridge only.
