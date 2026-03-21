import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { Search, X, ChevronUp, ChevronDown, SplitSquareHorizontal, Columns, Sparkles, Copy, ClipboardPaste, TextSelect, Eraser } from 'lucide-react'
import { AIAssistant } from './AIAssistant'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../stores/settingsStore'
import { useToast } from '../ui/Toast'
import {
  attachPreferredRenderer,
  formatRendererModeLabel,
  TERMINAL_UNICODE_VERSION
} from '../../lib/terminalRendering'
import {
  detectHeavyCliCommand,
  getTerminalInteractionProfileConfig,
  resolveRendererModeForProfile,
  type TerminalInteractionProfile
} from '../../lib/terminalProfiles'
import { registerOsc52ClipboardHandler } from '../../lib/terminalClipboard'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  sessionId: string
  tabId: string
  isActive: boolean
  engine?: 'node' | 'rust'
}

const terminalThemes: Record<string, any> = {
  default: {
    background: '#1e1e1e', foreground: '#e0e0e0', cursor: '#aeafad', cursorAccent: '#1e1e1e', selectionBackground: '#264f78',
    black: '#1e1e1e', red: '#f4a8a0', green: '#c3e88d', yellow: '#ffcb6b', blue: '#82aaff', magenta: '#c792ea', cyan: '#89ddff', white: '#e0e0e0',
    brightBlack: '#545454', brightRed: '#f4a8a0', brightGreen: '#c3e88d', brightYellow: '#ffcb6b', brightBlue: '#82aaff', brightMagenta: '#c792ea', brightCyan: '#89ddff', brightWhite: '#ffffff'
  },
  tokyoNight: {
    background: '#1a1b26', foreground: '#a9b1d6', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c',
    black: '#414868', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5',
    brightBlack: '#565f89', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#ffffff'
  },
  catppuccin: {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#45475a',
    black: '#585b70', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#cdd6f4',
    brightBlack: '#7f849c', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#ffffff'
  },
  monokai: {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822', selectionBackground: '#49483e',
    black: '#75715e', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
    brightBlack: '#90908a', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5'
  },
  dracula: {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
    black: '#6272a4', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#7082b4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff'
  },
  nord: {
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
    black: '#4c566a', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#616e88', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4'
  },
  solarized: {
    background: '#002b36', foreground: '#839496', cursor: '#839496', cursorAccent: '#002b36', selectionBackground: '#073642',
    black: '#586e75', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#657b83', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3'
  }
}

// Helper: extract visible text from xterm buffer
function getTerminalBufferContent(terminal: Terminal, lines: number = 50): string {
  const buf = terminal.buffer.active
  const totalRows = buf.length
  const startRow = Math.max(0, totalRows - lines)
  const result: string[] = []
  for (let i = startRow; i < totalRows; i++) {
    const line = buf.getLine(i)
    if (line) result.push(line.translateToString(true))
  }
  return result.join('\n')
}

function resolveTerminalVisualState(
  selectedTerminalTheme: string,
  colorTheme: string | undefined,
  frozenTheme: { terminalThemeId: string; useGlass: boolean } | null
) {
  const activeThemeId = frozenTheme?.terminalThemeId ?? selectedTerminalTheme
  const useGlass = frozenTheme ? frozenTheme.useGlass : colorTheme === 'theme-glass'
  const theme = terminalThemes[activeThemeId] || terminalThemes.default

  return {
    activeThemeId,
    useGlass,
    theme,
    termTheme: useGlass ? { ...theme, background: 'transparent' } : theme,
    containerBackground: useGlass ? 'rgba(15, 25, 45, 0.35)' : theme.background
  }
}

function dequeueOutputChunk(queue: string[], totalRef: { current: number }, maxBytes: number): string {
  if (queue.length === 0) return ''
  let remaining = maxBytes
  let output = ''

  while (queue.length > 0 && remaining > 0) {
    const head = queue[0]
    if (head.length <= remaining) {
      output += head
      remaining -= head.length
      totalRef.current -= head.length
      queue.shift()
    } else {
      output += head.slice(0, remaining)
      queue[0] = head.slice(remaining)
      totalRef.current -= remaining
      remaining = 0
    }
  }

  return output
}

function trimOutputQueue(queue: string[], totalRef: { current: number }, maxBytes: number): void {
  while (totalRef.current > maxBytes && queue.length > 0) {
    const head = queue[0]
    const overflow = totalRef.current - maxBytes
    if (head.length <= overflow) {
      totalRef.current -= head.length
      queue.shift()
    } else {
      queue[0] = head.slice(overflow)
      totalRef.current -= overflow
      break
    }
  }
}

// Single terminal instance component
function TerminalInstance({
  sessionId,
  isActive,
  engine,
  className,
  onTerminalRef
}: {
  sessionId: string
  isActive: boolean
  engine: 'node' | 'rust'
  className?: string
  onTerminalRef?: (ref: Terminal | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onTerminalRefRef = useRef(onTerminalRef)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const pendingOutputChunksRef = useRef<string[]>([])
  const pendingOutputBytesRef = useRef(0)
  const outputRafRef = useRef<number | null>(null)
  const isActiveRef = useRef(isActive)
  const isComposingRef = useRef(false)
  const rendererDisposeRef = useRef<(() => void) | null>(null)
  const osc52DisposeRef = useRef<(() => void) | null>(null)
  const [effectiveRenderer, setEffectiveRenderer] = useState<'dom' | 'webgl' | 'canvas'>('dom')
  const backpressureNotifiedRef = useRef(false)
  const interactionProfileRef = useRef<TerminalInteractionProfile>('default')
  const frozenThemeRef = useRef<{ terminalThemeId: string; useGlass: boolean } | null>(null)
  const selectedTerminalTheme = useSettingsStore((state) => state.settings.terminalTheme)
  const fontSize = useSettingsStore((state) => state.settings.fontSize)
  const fontFamily = useSettingsStore((state) => state.settings.fontFamily)
  const colorTheme = useSettingsStore((state) => (state.settings as any).colorTheme as string | undefined)
  const aiCompatibilityMode = useSettingsStore((state) => state.settings.aiCompatibilityMode)
  const terminalRenderer = useSettingsStore((state) => state.settings.terminalRenderer)
  const allowRemoteClipboardWrite = useSettingsStore((state) => state.settings.allowRemoteClipboardWrite)
  const currentProfile = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode)

  useEffect(() => {
    onTerminalRefRef.current = onTerminalRef
  }, [onTerminalRef])

  const writeClipboardText = useCallback((text: string) => {
    window.api.clipboard.writeText(text)
  }, [])

  const pasteToTerminal = useCallback((text: string) => {
    const terminal = terminalRef.current
    if (!terminal || !text) return
    terminal.clearSelection()
    terminal.focus()
    window.api.ssh.write(sessionId, text)
  }, [sessionId])

  useEffect(() => {
    isActiveRef.current = isActive
    if (!isActive) {
      if (outputRafRef.current !== null) {
        cancelAnimationFrame(outputRafRef.current)
        outputRafRef.current = null
      }
      return
    }
    if (terminalRef.current && pendingOutputChunksRef.current.length > 0 && outputRafRef.current === null) {
      outputRafRef.current = requestAnimationFrame(() => {
        outputRafRef.current = null
        if (!terminalRef.current || pendingOutputChunksRef.current.length === 0 || !isActiveRef.current) return
        const profile = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode)
        const chunk = dequeueOutputChunk(pendingOutputChunksRef.current, pendingOutputBytesRef, profile.chunkSize)
        if (!chunk) return
        terminalRef.current.write(chunk)
        if (pendingOutputChunksRef.current.length > 0) {
          outputRafRef.current = requestAnimationFrame(() => {
            outputRafRef.current = null
            if (!terminalRef.current || pendingOutputChunksRef.current.length === 0 || !isActiveRef.current) return
            const rest = dequeueOutputChunk(pendingOutputChunksRef.current, pendingOutputBytesRef, Number.MAX_SAFE_INTEGER)
            if (rest) terminalRef.current.write(rest)
          })
        }
      })
    }
  }, [isActive, aiCompatibilityMode])

  useEffect(() => {
    if (!containerRef.current) return

    const { termTheme } = resolveTerminalVisualState(selectedTerminalTheme, colorTheme, frozenThemeRef.current)

    const terminal = new Terminal({
      allowProposedApi: true,
      theme: termTheme,
      fontSize,
      fontFamily,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: currentProfile.scrollback,
      convertEol: !aiCompatibilityMode,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      minimumContrastRatio: 1,
      lineHeight: 1.15,
      letterSpacing: 0,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      smoothScrollDuration: 0,
      allowTransparency: true
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      // Prevent opening link when user is just selecting text to copy
      if (terminal.hasSelection()) return

      // Ensure http/https links open in system browser via Electron's shell
      if (uri.startsWith('http://') || uri.startsWith('https://')) {
        window.open(uri, '_blank')
      }
    })
    const searchAddon = new SearchAddon()

    terminal.loadAddon(fitAddon)
    terminal.loadAddon(unicode11Addon)
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(searchAddon)
    terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION

    osc52DisposeRef.current = registerOsc52ClipboardHandler(terminal, {
      enabled: allowRemoteClipboardWrite,
      onCopy: () => {
        setCtxMenu(null)
      }
    })

    terminal.open(containerRef.current)
    terminal.options.overviewRulerWidth = 0

    const textarea = terminal.textarea
    if (textarea) {
      textarea.style.zIndex = '1'
      textarea.setAttribute('lang', 'zh-CN')
      textarea.setAttribute('autocomplete', 'off')
      textarea.setAttribute('autocorrect', 'off')
      textarea.setAttribute('autocapitalize', 'off')
      textarea.setAttribute('spellcheck', 'false')
      const handleCompositionStart = () => { isComposingRef.current = true }
      const handleCompositionEnd = () => {
        isComposingRef.current = false
        requestAnimationFrame(() => terminal.focus())
      }
      textarea.addEventListener('compositionstart', handleCompositionStart)
      textarea.addEventListener('compositionend', handleCompositionEnd)
      ;(textarea as any).__nutshellCompositionCleanup = () => {
        textarea.removeEventListener('compositionstart', handleCompositionStart)
        textarea.removeEventListener('compositionend', handleCompositionEnd)
      }
    }

    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    // Expose terminal ref to parent
    onTerminalRefRef.current?.(terminal)
    terminal.focus()

    const pasteFromClipboard = () => {
      pasteToTerminal(window.api.clipboard.readText())
    }

    const preferredRenderer = colorTheme === 'theme-glass'
      ? 'canvas'
      : resolveRendererModeForProfile(terminalRenderer, interactionProfileRef.current)

    const switchInteractionProfile = (profile: TerminalInteractionProfile) => {
      if (interactionProfileRef.current === profile) return
      interactionProfileRef.current = profile
      backpressureNotifiedRef.current = false

      if (profile === 'heavy-cli' && !frozenThemeRef.current) {
        frozenThemeRef.current = {
          terminalThemeId: selectedTerminalTheme,
          useGlass: false
        }
      }

      const nextProfile = getTerminalInteractionProfileConfig(profile, aiCompatibilityMode)
      terminal.options.scrollback = nextProfile.scrollback
      fitAddonRef.current?.fit()

      if (rendererDisposeRef.current) {
        rendererDisposeRef.current()
        rendererDisposeRef.current = attachPreferredRenderer(
          terminal,
          colorTheme === 'theme-glass' ? 'canvas' : resolveRendererModeForProfile(terminalRenderer, profile),
          setEffectiveRenderer
        ).dispose
      }
    }

    // Copy/paste support
    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (isComposingRef.current || e.isComposing) return true
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        const selection = terminal.getSelection()
        if (selection) writeClipboardText(selection)
        return false
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'V') {
        pasteFromClipboard()
        return false
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
        pasteFromClipboard()
        return false
      }
      if (e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          writeClipboardText(selection)
          return false
        }
      }
      if (e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'v') {
        pasteFromClipboard()
        return false
      }
      if (e.shiftKey && e.key === 'Insert') {
        pasteFromClipboard()
        return false
      }
      // Ctrl+C with selection = copy (not SIGINT)
      if (e.ctrlKey && !e.shiftKey && e.key === 'c' && e.type === 'keydown') {
        const selection = terminal.getSelection()
        if (selection) {
          writeClipboardText(selection)
          return false
        }
      }
      return true
    })
    // Right-click opens context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    containerRef.current.addEventListener('contextmenu', handleContextMenu, true)

    const handlePasteEvent = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain')
      if (!text) return
      e.preventDefault()
      e.stopPropagation()
      pasteToTerminal(text)
    }
    containerRef.current.addEventListener('paste', handlePasteEvent, true)

    const flushBufferedOutput = () => {
      outputRafRef.current = null
      if (pendingOutputChunksRef.current.length === 0 || !isActiveRef.current) return

      const profile = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode)
      const chunk = dequeueOutputChunk(pendingOutputChunksRef.current, pendingOutputBytesRef, profile.chunkSize)
      if (!chunk) return
      terminal.write(chunk)

      if (pendingOutputChunksRef.current.length > 0) {
        outputRafRef.current = requestAnimationFrame(flushBufferedOutput)
      } else {
        backpressureNotifiedRef.current = false
      }
    }

    const queueOutput = (data: string) => {
      pendingOutputChunksRef.current.push(data)
      pendingOutputBytesRef.current += data.length

      const profile = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode)
      const maxPending = isActiveRef.current ? profile.maxPendingBytes : profile.maxPendingWhenHidden
      if (pendingOutputBytesRef.current > maxPending) {
        trimOutputQueue(pendingOutputChunksRef.current, pendingOutputBytesRef, maxPending)
        if (!backpressureNotifiedRef.current) {
          backpressureNotifiedRef.current = true
          const message = `\r\n\x1b[33m[终端输出过快，已保留最近 ${Math.round(maxPending / 1024)}KB 数据以保持界面稳定]\x1b[0m\r\n`
          pendingOutputChunksRef.current.unshift(message)
          pendingOutputBytesRef.current += message.length
        }
      }

      if (terminal.buffer.active.viewportY !== terminal.buffer.active.baseY) {
        return
      }
      if (isActiveRef.current && outputRafRef.current === null) {
        outputRafRef.current = requestAnimationFrame(flushBufferedOutput)
      }
    }

    const removeScrollListener = terminal.onScroll(() => {
      if (terminal.buffer.active.viewportY === terminal.buffer.active.baseY && pendingOutputChunksRef.current.length > 0 && outputRafRef.current === null) {
        outputRafRef.current = requestAnimationFrame(flushBufferedOutput)
      }
    })

    terminal.onData((data) => {
      if (detectHeavyCliCommand(data)) {
        switchInteractionProfile('heavy-cli')
      }
      window.api.ssh.write(sessionId, data)
    })

    let lastCols = 0, lastRows = 0
    terminal.onResize(({ cols, rows }) => {
      if (cols !== lastCols || rows !== lastRows) { lastCols = cols; lastRows = rows; window.api.ssh.resize(sessionId, cols, rows) }
    })

    const removeDataListener = window.api.ssh.onData((sid, data) => { if (sid === sessionId) queueOutput(data) })
    const removeCloseListener = window.api.ssh.onClose((sid) => { if (sid === sessionId) queueOutput('\r\n\x1b[31m[连接已断开]\x1b[0m\r\n') })
    const removeErrorListener = window.api.ssh.onError((sid, error) => { if (sid === sessionId) queueOutput(`\r\n\x1b[31m[错误: ${error}]\x1b[0m\r\n`) })
    const removeReconnectingListener = window.api.ssh.onReconnecting?.((sid, attempt) => { if (sid === sessionId) queueOutput(`\r\n\x1b[33m[正在重连... 第 ${attempt} 次尝试]\x1b[0m\r\n`) })
    const removeReconnectedListener = window.api.ssh.onReconnected?.((sid) => { if (sid === sessionId) queueOutput('\r\n\x1b[32m[重连成功]\x1b[0m\r\n') })

    let isDisposed = false
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (isDisposed) return
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (isDisposed) return
        try {
          const container = containerRef.current
          if (container && container.offsetWidth > 0 && container.offsetHeight > 0) fitAddon.fit()
        } catch { }
      }, 150)
    })
    resizeObserver.observe(containerRef.current)

    const currentContainer = containerRef.current
    const handleKeydown = (e: KeyboardEvent) => { if (e.ctrlKey && e.key === 'f') { e.preventDefault(); setShowSearch((prev) => !prev) } }
    currentContainer.addEventListener('keydown', handleKeydown)

    setTimeout(() => {
      if (isDisposed) return
      if (containerRef.current && containerRef.current.offsetWidth > 0) {
        try { fitAddon.fit() } catch { }

        // Safely enable Hardware Acceleration ONLY after terminal is fitted into DOM
        rendererDisposeRef.current = attachPreferredRenderer(
          terminal,
          preferredRenderer,
          setEffectiveRenderer
        ).dispose

        if (isDisposed) return
        const { cols, rows } = terminal; lastCols = cols; lastRows = rows; window.api.ssh.resize(sessionId, cols, rows)
      }
    }, 150)

    return () => {
      isDisposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      if (outputRafRef.current !== null) {
        cancelAnimationFrame(outputRafRef.current)
        outputRafRef.current = null
      }
      rendererDisposeRef.current?.()
      rendererDisposeRef.current = null
      osc52DisposeRef.current?.()
      osc52DisposeRef.current = null
      const textarea = terminal.textarea as (HTMLTextAreaElement & { __nutshellCompositionCleanup?: () => void }) | undefined
      textarea?.__nutshellCompositionCleanup?.()
      pendingOutputChunksRef.current = []
      pendingOutputBytesRef.current = 0
      onTerminalRefRef.current?.(null)
      removeDataListener(); removeCloseListener(); removeErrorListener()
      removeReconnectingListener?.(); removeReconnectedListener?.()
      removeScrollListener.dispose()
      resizeObserver.disconnect(); currentContainer.removeEventListener('keydown', handleKeydown); currentContainer.removeEventListener('contextmenu', handleContextMenu, true); currentContainer.removeEventListener('paste', handlePasteEvent, true)
      try { terminal.dispose() } catch { }
      terminalRef.current = null
    }
  }, [sessionId, aiCompatibilityMode, terminalRenderer, pasteToTerminal, writeClipboardText, allowRemoteClipboardWrite, colorTheme])

  useEffect(() => {
    const terminal = terminalRef.current
    // @ts-ignore
    if (!terminal || terminal._core?._isDisposed || (terminal as any)._isDisposed) return
    try {
      const { termTheme } = resolveTerminalVisualState(selectedTerminalTheme, colorTheme, frozenThemeRef.current)

      terminal.options.theme = termTheme
      terminal.options.fontSize = fontSize
      terminal.options.fontFamily = fontFamily
      terminal.options.scrollback = getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode).scrollback
      terminal.options.convertEol = !aiCompatibilityMode
      terminal.options.smoothScrollDuration = 0
      terminal.options.customGlyphs = true
      terminal.options.rescaleOverlappingGlyphs = true
      terminal.options.minimumContrastRatio = 1
      terminal.options.lineHeight = 1.15
      terminal.options.letterSpacing = 0
      fitAddonRef.current?.fit()
    } catch { }
  }, [selectedTerminalTheme, fontSize, fontFamily, colorTheme, aiCompatibilityMode])

  const handleSearch = useCallback(
    (direction: 'next' | 'prev') => {
      if (!searchAddonRef.current || !searchText) return
      if (direction === 'next') searchAddonRef.current.findNext(searchText)
      else searchAddonRef.current.findPrevious(searchText)
    },
    [searchText]
  )

  return (
    <div className={cn('flex flex-col relative min-h-0 overflow-hidden', className)} style={{
      backgroundColor: resolveTerminalVisualState(selectedTerminalTheme, colorTheme, frozenThemeRef.current).containerBackground
    }}>
      <div className="flex items-center justify-between gap-2 px-3 py-1 border-b border-border/60 bg-card/70 text-[11px] text-muted-foreground shrink-0">
        <span>{`引擎: ${engine === 'rust' ? 'Rust' : 'Node'} · 渲染器: ${formatRendererModeLabel(effectiveRenderer)}`}</span>
        <span>
          {getTerminalInteractionProfileConfig(interactionProfileRef.current, aiCompatibilityMode).label}
          {interactionProfileRef.current === 'heavy-cli' ? ' · 主题已锁定' : ''}
          {' · '}Unicode {TERMINAL_UNICODE_VERSION}
        </span>
      </div>
      {showSearch && (
        <div className="flex items-center gap-2 px-3 py-1.5 bg-card border-b border-border shrink-0">
          <Search className="w-4 h-4 text-muted-foreground" />
          <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(e.shiftKey ? 'prev' : 'next'); if (e.key === 'Escape') setShowSearch(false) }}
            placeholder="搜索..." className="flex-1 bg-background px-2 py-1 rounded text-sm outline-none border border-input focus:ring-1 focus:ring-ring" autoFocus />
          <button onClick={() => handleSearch('prev')} className="p-1 hover:bg-accent rounded"><ChevronUp className="w-4 h-4" /></button>
          <button onClick={() => handleSearch('next')} className="p-1 hover:bg-accent rounded"><ChevronDown className="w-4 h-4" /></button>
          <button onClick={() => setShowSearch(false)} className="p-1 hover:bg-accent rounded"><X className="w-4 h-4" /></button>
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden xterm-container" onClick={() => { setCtxMenu(null); terminalRef.current?.focus() }} />

      {/* Right-click context menu */}
      {
        ctxMenu && (
          <>
            <div className="fixed inset-0 z-[90]" onClick={() => { setCtxMenu(null); terminalRef.current?.focus() }} />
            <div
              className="context-menu fixed z-[100] bg-popover text-popover-foreground border border-border rounded-lg shadow-xl py-1 min-w-[140px] select-none"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
            >
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-popover-foreground hover:bg-accent hover:text-accent-foreground rounded transition-colors"
                onClick={() => {
                  const sel = terminalRef.current?.getSelection()
                  if (sel) {
                    writeClipboardText(sel)
                  }
                  setCtxMenu(null)
                  terminalRef.current?.focus()
                 }}
               >
                <Copy className="w-3.5 h-3.5 shrink-0" /> 复制
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-popover-foreground hover:bg-accent hover:text-accent-foreground rounded transition-colors"
                onClick={() => {
                  pasteToTerminal(window.api.clipboard.readText())
                  setCtxMenu(null)
                }}
              >
                <ClipboardPaste className="w-3.5 h-3.5 shrink-0" /> 粘贴
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-popover-foreground hover:bg-accent hover:text-accent-foreground rounded transition-colors"
                onClick={() => {
                  terminalRef.current?.selectAll()
                  setCtxMenu(null)
                  terminalRef.current?.focus()
                }}
              >
                <TextSelect className="w-3.5 h-3.5 shrink-0" /> 全选
              </button>
              <div className="border-t border-border/50 my-1" />
              <button
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left text-popover-foreground hover:bg-accent hover:text-accent-foreground rounded transition-colors"
                onClick={() => {
                  terminalRef.current?.clear()
                  setCtxMenu(null)
                  terminalRef.current?.focus()
                }}
              >
                <Eraser className="w-3.5 h-3.5 shrink-0" /> 清屏
              </button>
            </div>
          </>
        )
      }
    </div >
  )
}

// Main panel with split support + AI assistant
export function TerminalPanel({ sessionId, tabId, isActive, engine = 'node' }: TerminalPanelProps) {
  const [splitMode, setSplitMode] = useState<'none' | 'horizontal' | 'vertical'>('none')
  const [showAI, setShowAI] = useState(false)
  const terminalInstanceRef = useRef<Terminal | null>(null)
  const { toast } = useToast()
  const handlePrimaryTerminalRef = useCallback((ref: Terminal | null) => {
    terminalInstanceRef.current = ref
  }, [])

  const handleSplit = (mode: 'horizontal' | 'vertical') => {
    toast('warning', '分屏共享同一终端会话', '像 opencode 这类重交互 CLI 在分屏下更容易卡顿；建议单窗口使用。', 5000)
    setSplitMode((prev) => (prev === mode ? 'none' : mode))
  }

  useEffect(() => {
    const handleFocus = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail?.tabId === tabId && terminalInstanceRef.current) {
        terminalInstanceRef.current.focus()
      }
    }
    window.addEventListener('terminal:focus', handleFocus)
    return () => window.removeEventListener('terminal:focus', handleFocus)
  }, [tabId])

  // Get terminal screen content for AI context
  const getTerminalContent = useCallback((): string => {
    if (terminalInstanceRef.current) {
      return getTerminalBufferContent(terminalInstanceRef.current, 50)
    }
    return ''
  }, [])

  // Execute command and capture output (for AI auto-mode)
  const executeAndCapture = useCallback((command: string): Promise<string> => {
    return new Promise((resolve) => {
      let output = ''
      let timer: ReturnType<typeof setTimeout>

      const removeListener = window.api.ssh.onData((sid, data) => {
        if (sid === sessionId) {
          output += data
          // Reset timer on each new data chunk (wait for output to settle)
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => {
            removeListener()
            // Strip ANSI escape codes for cleaner AI input
            const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '')
            resolve(clean)
          }, 2000) // 2 second settle time
        }
      })

      // Send command
      window.api.ssh.write(sessionId, command + '\n')

      // Absolute timeout fallback (8 seconds)
      setTimeout(() => {
        removeListener()
        if (timer) clearTimeout(timer)
        const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '')
        resolve(clean || '(无输出)')
      }, 8000)
    })
  }, [sessionId])

  // Simple insert (for confirm mode)
  const handleInsertCommand = useCallback((command: string) => {
    window.api.ssh.write(sessionId, command + '\n')
  }, [sessionId])

  return (
    <div className="flex w-full h-full min-h-0 overflow-hidden">
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center justify-end gap-1 px-2 py-1 bg-card border-b border-border shrink-0">
          <button onClick={() => handleSplit('vertical')} className={cn('p-1 rounded transition-colors', splitMode === 'vertical' ? 'bg-primary/20 text-primary' : 'hover:bg-accent text-muted-foreground')} title="垂直分屏">
            <Columns className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => handleSplit('horizontal')} className={cn('p-1 rounded transition-colors', splitMode === 'horizontal' ? 'bg-primary/20 text-primary' : 'hover:bg-accent text-muted-foreground')} title="水平分屏">
            <SplitSquareHorizontal className="w-3.5 h-3.5" />
          </button>
          <div className="w-px h-4 bg-border mx-0.5" />
          <button onClick={() => setShowAI(!showAI)} className={cn('p-1 rounded transition-colors', showAI ? 'bg-primary/20 text-primary' : 'hover:bg-accent text-muted-foreground')} title="AI 助手">
            <Sparkles className="w-3.5 h-3.5" />
          </button>
        </div>

        {splitMode === 'none' ? (
          <TerminalInstance sessionId={sessionId} isActive={isActive} engine={engine} className="flex-1" onTerminalRef={handlePrimaryTerminalRef} />
        ) : splitMode === 'vertical' ? (
          <div className="flex flex-1 overflow-hidden">
            <TerminalInstance sessionId={sessionId} isActive={isActive} engine={engine} className="flex-1 border-r border-border" onTerminalRef={handlePrimaryTerminalRef} />
            <TerminalInstance sessionId={sessionId} isActive={isActive} engine={engine} className="flex-1" />
          </div>
        ) : (
          <div className="flex flex-col flex-1 overflow-hidden">
            <TerminalInstance sessionId={sessionId} isActive={isActive} engine={engine} className="flex-1 border-b border-border" onTerminalRef={handlePrimaryTerminalRef} />
            <TerminalInstance sessionId={sessionId} isActive={isActive} engine={engine} className="flex-1" />
          </div>
        )}
      </div>

      {showAI && (
        <AIAssistant
          sessionId={sessionId}
          onInsertCommand={handleInsertCommand}
          onExecuteAndCapture={executeAndCapture}
          getTerminalContent={getTerminalContent}
          onClose={() => setShowAI(false)}
        />
      )}
    </div>
  )
}
