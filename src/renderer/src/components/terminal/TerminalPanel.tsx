import { useEffect, useRef, useCallback, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { CanvasAddon } from '@xterm/addon-canvas'
import { Search, X, ChevronUp, ChevronDown, SplitSquareHorizontal, Columns, Sparkles, Copy, ClipboardPaste, TextSelect, Eraser } from 'lucide-react'
import { AIAssistant } from './AIAssistant'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../stores/settingsStore'
import '@xterm/xterm/css/xterm.css'

interface TerminalPanelProps {
  sessionId: string
  tabId: string
  isActive: boolean
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

// Single terminal instance component
function TerminalInstance({
  sessionId,
  isActive,
  className,
  onTerminalRef
}: {
  sessionId: string
  isActive: boolean
  className?: string
  onTerminalRef?: (ref: Terminal | null) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [copyToast, setCopyToast] = useState(false)
  const copyToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingOutputRef = useRef('')
  const outputRafRef = useRef<number | null>(null)
  const isActiveRef = useRef(isActive)
  const selectedTerminalTheme = useSettingsStore((state) => state.settings.terminalTheme)
  const fontSize = useSettingsStore((state) => state.settings.fontSize)
  const fontFamily = useSettingsStore((state) => state.settings.fontFamily)
  const colorTheme = useSettingsStore((state) => (state.settings as any).colorTheme as string | undefined)

  const showCopyToast = useCallback(() => {
    setCopyToast(true)
    if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current)
    copyToastTimerRef.current = setTimeout(() => setCopyToast(false), 1200)
  }, [])

  useEffect(() => {
    isActiveRef.current = isActive
    if (!isActive) {
      if (outputRafRef.current !== null) {
        cancelAnimationFrame(outputRafRef.current)
        outputRafRef.current = null
      }
      return
    }
    if (terminalRef.current && pendingOutputRef.current && outputRafRef.current === null) {
      outputRafRef.current = requestAnimationFrame(() => {
        outputRafRef.current = null
        if (!terminalRef.current || !pendingOutputRef.current || !isActiveRef.current) return
        terminalRef.current.write(pendingOutputRef.current)
        pendingOutputRef.current = ''
      })
    }
  }, [isActive])

  useEffect(() => {
    if (!containerRef.current) return

    const theme = terminalThemes[selectedTerminalTheme] || terminalThemes.default
    const isGlass = document.documentElement.classList.contains('theme-glass')
    const termTheme = isGlass
      ? { ...theme, background: 'transparent' }
      : theme

    const terminal = new Terminal({
      theme: termTheme,
      fontSize,
      fontFamily,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      convertEol: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      allowTransparency: true
    })

    const fitAddon = new FitAddon()
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
    terminal.loadAddon(webLinksAddon)
    terminal.loadAddon(searchAddon)

    terminal.open(containerRef.current)

    fitAddon.fit()

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    searchAddonRef.current = searchAddon

    // Expose terminal ref to parent
    onTerminalRef?.(terminal)

    // Copy/paste support
    terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        const selection = terminal.getSelection()
        if (selection) navigator.clipboard.writeText(selection)
        return false
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'V') {
        navigator.clipboard.readText().then((text) => {
          if (text) window.api.ssh.write(sessionId, text)
        })
        return false
      }
      // Ctrl+C with selection = copy (not SIGINT)
      if (e.ctrlKey && !e.shiftKey && e.key === 'c' && e.type === 'keydown') {
        const selection = terminal.getSelection()
        if (selection) {
          navigator.clipboard.writeText(selection)
          terminal.clearSelection()
          showCopyToast()
          return false
        }
      }
      return true
    })

    // Right-click opens context menu
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      setCtxMenu({ x: e.clientX, y: e.clientY })
    }
    containerRef.current.addEventListener('contextmenu', handleContextMenu)

    const flushBufferedOutput = () => {
      outputRafRef.current = null
      if (!pendingOutputRef.current || !isActiveRef.current) return
      terminal.write(pendingOutputRef.current)
      pendingOutputRef.current = ''
    }

    const queueOutput = (data: string) => {
      pendingOutputRef.current += data
      if (isActiveRef.current && outputRafRef.current === null) {
        outputRafRef.current = requestAnimationFrame(flushBufferedOutput)
      }
    }

    // Copy on select (auto-copy when text is selected)
    terminal.onSelectionChange(() => {
      const selection = terminal.getSelection()
      if (selection) {
        navigator.clipboard.writeText(selection)
        showCopyToast()
      }
    })

    terminal.onData((data) => { window.api.ssh.write(sessionId, data) })

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
        try {
          const webglAddon = new WebglAddon()
          webglAddon.onContextLoss(() => webglAddon.dispose())
          terminal.loadAddon(webglAddon)
        } catch {
          try { terminal.loadAddon(new CanvasAddon()) } catch { }
        }

        if (isDisposed) return
        const { cols, rows } = terminal; lastCols = cols; lastRows = rows; window.api.ssh.resize(sessionId, cols, rows)
      }
    }, 150)

    return () => {
      isDisposed = true
      if (resizeTimer) clearTimeout(resizeTimer)
      if (copyToastTimerRef.current) clearTimeout(copyToastTimerRef.current)
      if (outputRafRef.current !== null) {
        cancelAnimationFrame(outputRafRef.current)
        outputRafRef.current = null
      }
      pendingOutputRef.current = ''
      onTerminalRef?.(null)
      removeDataListener(); removeCloseListener(); removeErrorListener()
      removeReconnectingListener?.(); removeReconnectedListener?.()
      resizeObserver.disconnect(); currentContainer.removeEventListener('keydown', handleKeydown); currentContainer.removeEventListener('contextmenu', handleContextMenu)
      try { terminal.dispose() } catch { }
      terminalRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    const terminal = terminalRef.current
    // @ts-ignore
    if (!terminal || terminal._core?._isDisposed || (terminal as any)._isDisposed) return
    try {
      const theme = terminalThemes[selectedTerminalTheme] || terminalThemes.default
      const isGlass = document.documentElement.classList.contains('theme-glass')
      const termTheme = isGlass
        ? { ...theme, background: 'transparent' }
        : theme

      terminal.options.theme = termTheme
      terminal.options.fontSize = fontSize
      terminal.options.fontFamily = fontFamily
      fitAddonRef.current?.fit()
    } catch { }
  }, [selectedTerminalTheme, fontSize, fontFamily, colorTheme])

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
      backgroundColor: colorTheme === 'theme-glass'
        ? 'rgba(15, 25, 45, 0.35)'
        : (terminalThemes[selectedTerminalTheme] || terminalThemes.default).background
    }}>
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
      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden xterm-container" onClick={() => setCtxMenu(null)} />

      {/* Copy toast */}
      {
        copyToast && (
          <div className="absolute top-2 right-2 px-2.5 py-1 bg-green-600 text-white text-xs rounded shadow-lg animate-in fade-in zoom-in duration-200 pointer-events-none">
            已复制
          </div>
        )
      }

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
                    navigator.clipboard.writeText(sel)
                    terminalRef.current?.clearSelection()
                    showCopyToast()
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
                  navigator.clipboard.readText().then((text) => {
                    if (text) window.api.ssh.write(sessionId, text)
                    terminalRef.current?.focus()
                  })
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
export function TerminalPanel({ sessionId, tabId, isActive }: TerminalPanelProps) {
  const [splitMode, setSplitMode] = useState<'none' | 'horizontal' | 'vertical'>('none')
  const [showAI, setShowAI] = useState(false)
  const terminalInstanceRef = useRef<Terminal | null>(null)

  const handleSplit = (mode: 'horizontal' | 'vertical') => {
    setSplitMode((prev) => (prev === mode ? 'none' : mode))
  }

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
          <TerminalInstance sessionId={sessionId} isActive={isActive} className="flex-1" onTerminalRef={(ref) => { terminalInstanceRef.current = ref }} />
        ) : splitMode === 'vertical' ? (
          <div className="flex flex-1 overflow-hidden">
            <TerminalInstance sessionId={sessionId} isActive={isActive} className="flex-1 border-r border-border" onTerminalRef={(ref) => { terminalInstanceRef.current = ref }} />
            <TerminalInstance sessionId={sessionId} isActive={isActive} className="flex-1" />
          </div>
        ) : (
          <div className="flex flex-col flex-1 overflow-hidden">
            <TerminalInstance sessionId={sessionId} isActive={isActive} className="flex-1 border-b border-border" onTerminalRef={(ref) => { terminalInstanceRef.current = ref }} />
            <TerminalInstance sessionId={sessionId} isActive={isActive} className="flex-1" />
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
