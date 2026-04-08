import { ipcMain } from 'electron'
import { sshManager } from '../ssh/SSHManager'
import { configStore } from '../store/ConfigStore'
import { rustCoreService } from '../rust/RustCoreService'

const DEFAULT_SSH_TERM = 'xterm-256color'

export function registerSSHHandlers(): void {
  ipcMain.handle('ssh:connect', async (_event, config) => {
    try {
      const settings = configStore.getSettings()
      const useRustEngine = settings.useRustSshEngine === true

      if (useRustEngine && !config.jumpHost) {
        const sessionId = `rust-${config.id || crypto.randomUUID()}`
        await rustCoreService.connectSsh({
          sessionId,
          host: config.host,
          port: config.port,
          username: config.username,
          authType: config.authType,
          password: config.password,
          privateKeyPath: config.privateKeyPath,
          passphrase: config.passphrase,
          aiCompatibilityMode: config.aiCompatibilityMode
        })

        return { success: true, sessionId, engine: 'rust' }
      }

      const sessionId = await sshManager.connect(config)
      await sshManager.openShell(sessionId)
      return { success: true, sessionId, engine: 'node' }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('ssh:disconnect', async (_event, sessionId: string) => {
    try {
      const rustStatus = await rustCoreService.ping().then(() => true).catch(() => false)
      if (rustStatus) {
        await rustCoreService.disconnectSsh(sessionId).catch(() => {})
      }
      await sshManager.disconnect(sessionId).catch(() => {})
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.on('ssh:write', (_event, sessionId: string, data: string) => {
    // sshManager.write() handles both regular sessions and external shells
    // (docker exec, etc.), so try it first regardless of isConnected()
    if (sshManager.isConnected(sessionId) || sshManager.hasExternalShell(sessionId)) {
      sshManager.write(sessionId, data)
      return
    }
    rustCoreService.writeSsh(sessionId, data).catch(() => {})
  })

  ipcMain.on('ssh:resize', (_event, sessionId: string, cols: number, rows: number) => {
    if (sshManager.isConnected(sessionId)) {
      sshManager.resize(sessionId, cols, rows)
      return
    }
    if (sshManager.hasExternalShell(sessionId)) {
      sshManager.resizeExternal(sessionId, cols, rows)
      return
    }
    rustCoreService.resizeSsh(sessionId, cols, rows).catch(() => {})
  })

  ipcMain.handle('ssh:runDiagnostics', async (_event, sessionId: string) => {
    try {
      if (rustCoreService.hasSshSession(sessionId)) {
        const result = await rustCoreService.runCommand({
          sessionId,
          command: [
            "cat <<'NUTSHELL_DIAG' | sh",
            "printf '__NUTSHELL_TERM__\\n'",
            "printf '%s\\n' \"$TERM\"",
            "printf '__NUTSHELL_LOCALE__\\n'",
            "(locale 2>/dev/null || env | grep -E '^(LANG|LC_)=' 2>/dev/null || true)",
            "printf '__NUTSHELL_WIDTH__\\n'",
            "printf '%s\\n' '| hello | 中文宽度 | ⅠⅡⅢ | 🙂🚀 |'",
            "printf '__NUTSHELL_BOX__\\n'",
            "printf '%s\\n' '┌──────────┬────┐'",
            "printf '%s\\n' '│ 中文 🙂  │ OK │'",
            "printf '%s\\n' '└──────────┴────┘'",
            "printf '__NUTSHELL_EMOJI__\\n'",
            "printf '%s\\n' '🙂 🚀 🧠 ✅ 🔥'",
            "printf '__NUTSHELL_DONE__\\n'",
            'NUTSHELL_DIAG'
          ].join('\n'),
          timeoutMs: 15000,
          requireConfirmation: false
        })

        if (result.blocked) {
          throw new Error(result.reason || 'Remote diagnostics blocked')
        }

        const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '')
        const readSection = (name: string, nextName: string): string[] => {
          const startMarker = `__NUTSHELL_${name}__`
          const endMarker = `__NUTSHELL_${nextName}__`
          const start = output.indexOf(startMarker)
          const end = output.indexOf(endMarker)
          if (start === -1 || end === -1 || end <= start) {
            return []
          }

          return output
            .slice(start + startMarker.length, end)
            .replace(/^\r?\n/, '')
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
        }

        const term = readSection('TERM', 'LOCALE')[0] || ''
        const locale = readSection('LOCALE', 'WIDTH')
        const widthSample = readSection('WIDTH', 'BOX')[0] || ''
        const boxSample = readSection('BOX', 'EMOJI')
        const emojiSample = readSection('EMOJI', 'DONE')[0] || ''
        const expectedWidthSample = '| hello | 中文宽度 | ⅠⅡⅢ | 🙂🚀 |'
        const expectedBoxSample = ['┌──────────┬────┐', '│ 中文 🙂  │ OK │', '└──────────┴────┘']
        const expectedEmojiSample = '🙂 🚀 🧠 ✅ 🔥'

        return {
          success: true,
          result: {
            term,
            locale,
            widthSample,
            boxSample,
            emojiSample,
            rawOutput: output,
            checks: {
              termMatches: term === DEFAULT_SSH_TERM,
              localeUtf8: locale.some((line) => /utf-?8|c\.utf-?8/i.test(line)),
              widthMatches: widthSample === expectedWidthSample,
              boxMatches: JSON.stringify(boxSample) === JSON.stringify(expectedBoxSample),
              emojiMatches: emojiSample === expectedEmojiSample
            }
          }
        }
      }

      const result = await sshManager.runTerminalDiagnostics(sessionId)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })
}
