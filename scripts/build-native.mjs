import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const manifest = join(root, 'native', 'nutshell-core', 'Cargo.toml')
const binaryName = process.platform === 'win32' ? 'nutshell-core.exe' : 'nutshell-core'
const binary = join(root, 'native', 'nutshell-core', 'target', 'release', binaryName)

if (!existsSync(manifest)) {
  console.error(`Rust manifest not found: ${manifest}`)
  process.exit(1)
}

const command = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
const result = spawnSync(command, ['build', '--release', '--manifest-path', manifest], {
  cwd: root,
  stdio: 'inherit',
  shell: false
})

if (result.error) {
  console.error(`Failed to start Cargo: ${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
if (!existsSync(binary)) {
  console.error(`Rust sidecar binary was not produced: ${binary}`)
  process.exit(1)
}

console.log(`Rust sidecar ready: ${binary}`)
