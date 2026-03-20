import type { TerminalRendererMode } from './terminalRendering'

export type TerminalInteractionProfile = 'default' | 'heavy-cli'

export interface TerminalInteractionProfileConfig {
  id: TerminalInteractionProfile
  label: string
  description: string
  scrollback: number
  chunkSize: number
  maxPendingBytes: number
  maxPendingWhenHidden: number
  rendererMode: TerminalRendererMode | null
}

export function getTerminalInteractionProfileConfig(
  profile: TerminalInteractionProfile,
  aiCompatibilityMode: boolean
): TerminalInteractionProfileConfig {
  if (profile === 'heavy-cli') {
    return {
      id: profile,
      label: '重交互 CLI',
      description: '为 opencode / claude / codex 这类持续刷新的终端工具优化稳定性',
      scrollback: 3000,
      chunkSize: 8192,
      maxPendingBytes: 384 * 1024,
      maxPendingWhenHidden: 96 * 1024,
      rendererMode: 'canvas'
    }
  }

  return {
    id: profile,
    label: '默认',
    description: '常规终端配置',
    scrollback: aiCompatibilityMode ? 3000 : 10000,
    chunkSize: 16384,
    maxPendingBytes: 512 * 1024,
    maxPendingWhenHidden: 128 * 1024,
    rendererMode: null
  }
}

export function resolveRendererModeForProfile(
  preferredRenderer: TerminalRendererMode,
  profile: TerminalInteractionProfile
): TerminalRendererMode {
  const profileConfig = getTerminalInteractionProfileConfig(profile, false)
  return profileConfig.rendererMode ?? preferredRenderer
}

export function detectHeavyCliCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false

  let index = 0
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase()

    if (token === 'sudo' || token === 'env' || token === 'command' || token === 'time' || token === 'nohup') {
      index += 1
      continue
    }

    if (token.includes('=')) {
      index += 1
      continue
    }

    if (token === 'npx' || token === 'bunx') {
      index += 1
      continue
    }

    if (token === 'pnpm' && tokens[index + 1]?.toLowerCase() === 'dlx') {
      index += 2
      continue
    }

    return token === 'opencode' || token === 'codex' || token === 'claude'
  }

  return false
}
