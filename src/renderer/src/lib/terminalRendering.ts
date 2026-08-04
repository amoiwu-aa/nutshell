import { CanvasAddon } from '@xterm/addon-canvas'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

export type TerminalRendererMode = 'auto' | 'webgl' | 'canvas'
export type ActiveTerminalRendererMode = 'dom' | 'webgl' | 'canvas'

export const DEFAULT_SSH_TERM = 'xterm-256color'
export const TERMINAL_UNICODE_VERSION = '11'

/**
 * Fit the terminal to its container, tolerating the states where xterm cannot
 * measure yet.
 *
 * `_renderService.dimensions` is a getter that throws before a renderer addon
 * (WebGL/Canvas/DOM) has attached, and fitting a zero-sized container yields NaN
 * dimensions, so both are checked before calling through.
 */
export function safeTerminalFit(
  terminal: Terminal | null | undefined,
  addon: { fit?: () => void } | null | undefined,
  container: HTMLElement | null
): void {
  if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) return

  const renderService = (terminal as unknown as { _core?: { _renderService?: { _renderer?: { value?: unknown } } } })
    ?._core?._renderService
  if (!renderService?._renderer?.value) return

  try {
    addon?.fit?.()
  } catch {
    // A fit racing with teardown is harmless; the next resize corrects it.
  }
}

export const TERMINAL_DIAGNOSTIC_THEME = {
  background: '#111827',
  foreground: '#e5e7eb',
  cursor: '#93c5fd',
  cursorAccent: '#111827',
  selectionBackground: '#1d4ed8',
  black: '#111827',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e7eb',
  brightBlack: '#6b7280',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f9fafb'
}

export interface TerminalRendererAttachment {
  dispose: () => void
  getMode: () => ActiveTerminalRendererMode
}

export function formatRendererModeLabel(mode: TerminalRendererMode | ActiveTerminalRendererMode): string {
  switch (mode) {
    case 'auto':
      return 'Auto'
    case 'webgl':
      return 'WebGL'
    case 'canvas':
      return 'Canvas'
    default:
      return 'DOM'
  }
}

export function getTerminalEnvironment(aiCompatibilityMode: boolean): Array<{ key: string; value: string }> {
  const entries = [{ key: 'TERM', value: DEFAULT_SSH_TERM }]
  if (aiCompatibilityMode) {
    entries.push(
      { key: 'COLORTERM', value: 'truecolor' },
      { key: 'TERM_PROGRAM', value: 'Nutshell' },
      { key: 'TERM_PROGRAM_VERSION', value: '1.0.1' },
      { key: 'INSIDE_NUTSHELL', value: '1' },
      { key: 'FORCE_COLOR', value: '1' }
    )
  }
  return entries
}

export function attachPreferredRenderer(
  terminal: Terminal,
  preferredMode: TerminalRendererMode,
  onModeChange?: (mode: ActiveTerminalRendererMode) => void
): TerminalRendererAttachment {
  let webglAddon: WebglAddon | null = null
  let canvasAddon: CanvasAddon | null = null
  let currentMode: ActiveTerminalRendererMode = 'dom'

  const setMode = (mode: ActiveTerminalRendererMode) => {
    currentMode = mode
    onModeChange?.(mode)
  }

  const loadCanvas = (): boolean => {
    try {
      canvasAddon = new CanvasAddon()
      terminal.loadAddon(canvasAddon)
      setMode('canvas')
      return true
    } catch {
      canvasAddon = null
      return false
    }
  }

  const loadWebgl = (): boolean => {
    try {
      webglAddon = new WebglAddon()
      webglAddon.onContextLoss(() => {
        try {
          webglAddon?.dispose()
        } catch {
          // ignore renderer disposal errors
        }
        webglAddon = null
        if (!loadCanvas()) {
          setMode('dom')
        }
      })
      terminal.loadAddon(webglAddon)
      setMode('webgl')
      return true
    } catch {
      webglAddon = null
      return false
    }
  }

  if (preferredMode === 'webgl') {
    if (!loadWebgl() && !loadCanvas()) {
      setMode('dom')
    }
  } else if (preferredMode === 'canvas') {
    if (!loadCanvas()) {
      setMode('dom')
    }
  } else if (!loadWebgl() && !loadCanvas()) {
    setMode('dom')
  }

  return {
    dispose: () => {
      try {
        webglAddon?.dispose()
      } catch {
        // ignore renderer disposal errors
      }
      try {
        canvasAddon?.dispose()
      } catch {
        // ignore renderer disposal errors
      }
      webglAddon = null
      canvasAddon = null
    },
    getMode: () => currentMode
  }
}

export function buildTerminalDiagnosticsText(options: {
  rendererPreference: TerminalRendererMode
  effectiveRenderer: ActiveTerminalRendererMode
  aiCompatibilityMode: boolean
}): string {
  const envText = getTerminalEnvironment(options.aiCompatibilityMode)
    .map(({ key, value }) => `  ${key}=${value}`)
    .join('\r\n')

  return [
    '\x1b[1;36mNutshell Terminal Diagnostics\x1b[0m',
    '',
    `Renderer preference : ${formatRendererModeLabel(options.rendererPreference)}`,
    `Preview renderer    : ${formatRendererModeLabel(options.effectiveRenderer)}`,
    `Unicode engine      : ${TERMINAL_UNICODE_VERSION}`,
    '',
    'Shell environment',
    envText,
    '',
    'Unicode width',
    '  ASCII : | hello | 12345 |',
    '  CJK   : | 中文宽度 | 全角ＡＢＣ |',
    '  Ambig : | I II III | ⅠⅡⅢ | ←→ Ωβ |',
    '',
    'Box drawing',
    '  ┌────────────────────┬────────────┐',
    '  │ single line box    │ aligned?   │',
    '  ├────────────────────┼────────────┤',
    '  │ double ╔═╗ ╚═╝     │ mixed OK?  │',
    '  └────────────────────┴────────────┘',
    '',
    'Emoji',
    '  🙂 🚀 🧠 ✅ 🔥 👩‍💻 👨‍👩‍👧‍👦',
    '',
    'Powerline / Nerd Font',
    '    git  main  ',
    '',
    'Tip: if boxes break or emoji shifts, switch renderer mode or font.'
  ].join('\r\n')
}
