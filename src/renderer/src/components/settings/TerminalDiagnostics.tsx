
import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { CheckCircle2, ClipboardCopy, Loader2, Play, XCircle } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { useSettingsStore } from '../../stores/settingsStore'
import {
  attachPreferredRenderer,
  buildTerminalDiagnosticsText,
  DEFAULT_SSH_TERM,
  formatRendererModeLabel,
  getTerminalEnvironment,
  TERMINAL_DIAGNOSTIC_THEME,
  TERMINAL_UNICODE_VERSION,
  type ActiveTerminalRendererMode
} from '../../lib/terminalRendering'

interface RemoteDiagnosticsResult {
  term: string
  locale: string[]
  widthSample: string
  boxSample: string[]
  emojiSample: string
  rawOutput: string
  checks: {
    termMatches: boolean
    localeUtf8: boolean
    widthMatches: boolean
    boxMatches: boolean
    emojiMatches: boolean
  }
}

interface TerminalDiagnosticsProps {
  sessionId?: string
}

export function TerminalDiagnostics({ sessionId }: TerminalDiagnosticsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const rendererDisposeRef = useRef<(() => void) | null>(null)
  const fontSize = useSettingsStore((state) => state.settings.fontSize)
  const fontFamily = useSettingsStore((state) => state.settings.fontFamily)
  const terminalRenderer = useSettingsStore((state) => state.settings.terminalRenderer)
  const aiCompatibilityMode = useSettingsStore((state) => state.settings.aiCompatibilityMode)
  const [effectiveRenderer, setEffectiveRenderer] = useState<ActiveTerminalRendererMode>('dom')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle')
  const [remoteDiagnostics, setRemoteDiagnostics] = useState<RemoteDiagnosticsResult | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState<string | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      allowProposedApi: true,
      theme: TERMINAL_DIAGNOSTIC_THEME,
      fontSize,
      fontFamily,
      convertEol: !aiCompatibilityMode,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorInactiveStyle: 'none',
      disableStdin: true,
      scrollback: 200,
      lineHeight: 1.15,
      letterSpacing: 0,
      customGlyphs: true,
      rescaleOverlappingGlyphs: true,
      minimumContrastRatio: 1,
      allowTransparency: true
    })

    const fitAddon = new FitAddon()
    const unicode11Addon = new Unicode11Addon()
    terminal.loadAddon(fitAddon)
    terminal.loadAddon(unicode11Addon)
    terminal.unicode.activeVersion = TERMINAL_UNICODE_VERSION
    terminal.open(containerRef.current)
    try { safeTerminalFit(terminalRef.current || terminal, fitAddon, containerRef.current || terminal.element || null) } catch { }

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    return () => {
      rendererDisposeRef.current?.()
      rendererDisposeRef.current = null
      fitAddonRef.current = null
      try {
        terminal.dispose()
      } catch {
        // ignore terminal disposal errors
      }
      terminalRef.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.options.fontSize = fontSize
    terminal.options.fontFamily = fontFamily
    terminal.options.convertEol = !aiCompatibilityMode
    terminal.options.customGlyphs = true
    terminal.options.rescaleOverlappingGlyphs = true
    terminal.options.minimumContrastRatio = 1
    terminal.options.lineHeight = 1.15
    terminal.options.letterSpacing = 0
    try { safeTerminalFit(terminalRef.current, fitAddonRef.current, containerRef.current || (terminalRef.current?.element) || null) } catch { }
  }, [fontSize, fontFamily, aiCompatibilityMode])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    rendererDisposeRef.current?.()
    rendererDisposeRef.current = attachPreferredRenderer(terminal, terminalRenderer, setEffectiveRenderer).dispose
    try { safeTerminalFit(terminalRef.current, fitAddonRef.current, containerRef.current || (terminalRef.current?.element) || null) } catch { }

    return () => {
      rendererDisposeRef.current?.()
      rendererDisposeRef.current = null
    }
  }, [terminalRenderer])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return

    terminal.reset()
    terminal.write(
      buildTerminalDiagnosticsText({
        rendererPreference: terminalRenderer,
        effectiveRenderer,
        aiCompatibilityMode
      })
    )
    try { safeTerminalFit(terminalRef.current, fitAddonRef.current, containerRef.current || (terminalRef.current?.element) || null) } catch { }
  }, [terminalRenderer, effectiveRenderer, aiCompatibilityMode])

  const envEntries = getTerminalEnvironment(aiCompatibilityMode)
  const localDiagnosticsText = useMemo(
    () => buildTerminalDiagnosticsText({
      rendererPreference: terminalRenderer,
      effectiveRenderer,
      aiCompatibilityMode
    }),
    [terminalRenderer, effectiveRenderer, aiCompatibilityMode]
  )

  const remoteCheckItems = remoteDiagnostics
    ? [
        { label: 'TERM 匹配', passed: remoteDiagnostics.checks.termMatches },
        { label: 'UTF-8 locale', passed: remoteDiagnostics.checks.localeUtf8 },
        { label: '宽字符样本', passed: remoteDiagnostics.checks.widthMatches },
        { label: 'Box drawing', passed: remoteDiagnostics.checks.boxMatches },
        { label: 'Emoji 样本', passed: remoteDiagnostics.checks.emojiMatches }
      ]
    : []

  const handleCopyDiagnostics = async () => {
    const remoteText = remoteDiagnostics
      ? [
          '',
          '--- Remote diagnostics ---',
          `TERM: ${remoteDiagnostics.term || '(empty)'}`,
          `locale: ${remoteDiagnostics.locale.join(' | ') || '(empty)'}`,
          `width: ${remoteDiagnostics.widthSample || '(empty)'}`,
          `box: ${remoteDiagnostics.boxSample.join(' / ') || '(empty)'}`,
          `emoji: ${remoteDiagnostics.emojiSample || '(empty)'}`,
          `checks: ${remoteCheckItems.map((item) => `${item.label}=${item.passed ? 'ok' : 'fail'}`).join(', ')}`
        ].join('\n')
      : ''

    await navigator.clipboard.writeText(localDiagnosticsText.replace(/\r/g, '') + remoteText)
    setCopyStatus('copied')
    window.setTimeout(() => setCopyStatus('idle'), 1500)
  }

  const handleRunRemoteDiagnostics = async () => {
    if (!sessionId || remoteLoading) return
    setRemoteLoading(true)
    setRemoteError(null)
    try {
      const result = await window.api.ssh.runDiagnostics(sessionId)
      if (!result.success) {
        throw new Error(result.error || 'Remote diagnostics failed')
      }
      setRemoteDiagnostics(result.result)
    } catch (error: any) {
      setRemoteDiagnostics(null)
      setRemoteError(error.message || 'Remote diagnostics failed')
    } finally {
      setRemoteLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium mb-1">终端诊断</h3>
          <p className="text-xs text-muted-foreground">
            用当前字体、兼容模式和渲染器偏好预览 Unicode、box drawing、emoji 和 powerline 字符效果。
          </p>
        </div>
        <button
          onClick={handleCopyDiagnostics}
          className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:border-primary/50 hover:bg-accent"
        >
          <ClipboardCopy className="h-3.5 w-3.5" />
          {copyStatus === 'copied' ? '已复制' : '复制诊断结果'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <InfoCard label="TERM" value={DEFAULT_SSH_TERM} />
        <InfoCard label="Unicode" value={`v${TERMINAL_UNICODE_VERSION}`} />
        <InfoCard label="渲染器偏好" value={formatRendererModeLabel(terminalRenderer)} />
        <InfoCard label="预览实际渲染器" value={formatRendererModeLabel(effectiveRenderer)} />
      </div>

      <div className="rounded-xl border border-border bg-background/60 p-3">
        <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>环境变量预览</span>
          <span>{aiCompatibilityMode ? '兼容模式已开启' : '兼容模式未开启'}</span>
        </div>
        <div className="rounded-lg bg-card p-3 font-mono text-xs leading-6">
          {envEntries.map(({ key, value }) => (
            <div key={key}>
              <span className="text-muted-foreground">{key}</span>
              <span className="mx-2 text-muted-foreground">=</span>
              <span>{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border overflow-hidden bg-black/30">
        <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
          <span>渲染预览</span>
          <span>如果边框断裂、emoji 偏移或字符发虚，可以切换渲染器模式再观察。</span>
        </div>
        <div ref={containerRef} className="xterm-container h-[260px]" />
      </div>

      <div className="rounded-xl border border-border bg-secondary/40 p-3 text-xs leading-5 text-muted-foreground">
        <div>远程验证命令:</div>
        <div className="mt-1 rounded bg-background px-2 py-1 font-mono text-foreground">
          echo $TERM && printf '中文 🙂 ┌─┐\n'
        </div>
      </div>

      <div className="rounded-xl border border-border bg-background/60 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm font-medium">远程终端诊断</div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              直接在当前 SSH 会话上执行 `echo $TERM`、`locale` 和 `printf` 样本，并自动比对关键结果。
            </p>
          </div>
          <button
            onClick={handleRunRemoteDiagnostics}
            disabled={!sessionId || remoteLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-1.5 text-xs transition-colors hover:border-primary/50 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {remoteLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {remoteLoading ? '诊断中...' : '运行远程诊断'}
          </button>
        </div>

        {!sessionId && (
          <div className="mt-3 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            当前没有关联 SSH 会话；在真实终端标签页里打开设置时，这里会显示远程诊断按钮。
          </div>
        )}

        {remoteError && (
          <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
            远程诊断失败：{remoteError}
          </div>
        )}

        {remoteDiagnostics && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <InfoCard label="远程 TERM" value={remoteDiagnostics.term || '(empty)'} />
              <InfoCard label="Locale 检测" value={remoteDiagnostics.checks.localeUtf8 ? 'UTF-8' : 'Non UTF-8'} />
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              {remoteCheckItems.map((item) => (
                <div key={item.label} className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                  {item.passed ? (
                    <CheckCircle2 className="h-4 w-4 text-green-400" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-400" />
                  )}
                  <span>{item.label}</span>
                </div>
              ))}
            </div>

            <div className="rounded-lg bg-card p-3 font-mono text-xs leading-6">
              <div><span className="text-muted-foreground">locale</span></div>
              {remoteDiagnostics.locale.length > 0 ? remoteDiagnostics.locale.map((line, index) => (
                <div key={`${line}-${index}`}>{line}</div>
              )) : <div>(empty)</div>}
              <div className="mt-3 text-muted-foreground">width</div>
              <div>{remoteDiagnostics.widthSample || '(empty)'}</div>
              <div className="mt-3 text-muted-foreground">box</div>
              {remoteDiagnostics.boxSample.map((line, index) => (
                <div key={`${line}-${index}`}>{line}</div>
              ))}
              <div className="mt-3 text-muted-foreground">emoji</div>
              <div>{remoteDiagnostics.emojiSample || '(empty)'}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background/60 p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-sm text-foreground">{value}</div>
    </div>
  )
}
