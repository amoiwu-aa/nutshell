import { describe, expect, it } from 'vitest'
import {
  detectHeavyCliCommand,
  detectHeavyCliOutput,
  detectShellPromptReturn,
  getTerminalInteractionProfileConfig,
  resolveRendererModeForProfile
} from './terminalProfiles'

describe('terminal interaction profiles', () => {
  it('detects heavy CLI commands through common wrappers', () => {
    expect(detectHeavyCliCommand('claude')).toBe(true)
    expect(detectHeavyCliCommand('sudo env FOO=bar npx codex')).toBe(true)
    expect(detectHeavyCliCommand('pnpm dlx opencode')).toBe(true)
    expect(detectHeavyCliCommand('npm run build')).toBe(false)
  })

  it('detects heavy CLI output without matching ordinary terminal text', () => {
    expect(detectHeavyCliOutput('Waiting for codex to start')).toBe(true)
    expect(detectHeavyCliOutput('npm run build\ncompleted')).toBe(false)
  })

  it('recognizes a returned shell prompt conservatively', () => {
    expect(detectShellPromptReturn('user@host:~$')).toBe(true)
    expect(detectShellPromptReturn('user@host:~$ claude is still running')).toBe(false)
    expect(detectShellPromptReturn('ordinary output')).toBe(false)
  })

  it('uses canvas for heavy CLI rendering and preserves the preferred mode otherwise', () => {
    expect(getTerminalInteractionProfileConfig('heavy-cli', false).rendererMode).toBe('canvas')
    expect(resolveRendererModeForProfile('webgl', 'default')).toBe('webgl')
    expect(resolveRendererModeForProfile('webgl', 'heavy-cli')).toBe('canvas')
  })
})
