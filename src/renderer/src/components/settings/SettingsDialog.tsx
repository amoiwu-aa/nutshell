import { useState } from 'react'
import { X, Sun, Moon, Monitor, Type, Palette } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useSettingsStore } from '../../stores/settingsStore'
import { TerminalDiagnostics } from './TerminalDiagnostics'

const terminalRendererModes = [
  {
    id: 'auto',
    name: 'Auto',
    description: '优先使用 WebGL，失败时自动回退到 Canvas 或 DOM'
  },
  {
    id: 'webgl',
    name: 'WebGL',
    description: '性能最好，但个别显卡驱动下可能出现花屏或发虚'
  },
  {
    id: 'canvas',
    name: 'Canvas',
    description: '兼容性更稳，适合遇到渲染异常时手动避坑'
  }
] as const

interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  sessionId?: string
}

const terminalThemes = [
  { id: 'default', name: 'One Dark Pro', preview: '#1e1e1e', fg: '#e0e0e0' },
  { id: 'tokyoNight', name: 'Tokyo Night', preview: '#1a1b26', fg: '#a9b1d6' },
  { id: 'catppuccin', name: 'Catppuccin Mocha', preview: '#1e1e2e', fg: '#cdd6f4' },
  { id: 'monokai', name: 'Monokai', preview: '#272822', fg: '#f8f8f2' },
  { id: 'dracula', name: 'Dracula', preview: '#282a36', fg: '#f8f8f2' },
  { id: 'nord', name: 'Nord', preview: '#2e3440', fg: '#d8dee9' },
  { id: 'solarized', name: 'Solarized Dark', preview: '#002b36', fg: '#839496' }
]

const uiColorThemes = [
  { id: '', name: '默认蓝', accent: '#3b82f6', bg: '#0d1117', card: '#161b22' },
  { id: 'theme-midnight', name: '午夜蓝', accent: '#4d8eff', bg: '#0a0e1a', card: '#141c2e' },
  { id: 'theme-forest', name: '森林绿', accent: '#2dd4a0', bg: '#0a1410', card: '#122019' },
  { id: 'theme-rose', name: '玫瑰红', accent: '#f04080', bg: '#1a0a10', card: '#261019' },
  { id: 'theme-glass', name: '透明玻璃', accent: '#38bdf8', bg: 'linear-gradient(135deg, #0c1929, #1a1040)', card: 'rgba(15,25,45,0.5)' },
  { id: 'theme-sakura', name: '樱花粉', accent: '#c084fc', bg: '#140e1c', card: '#1e1628' },
  { id: 'theme-cyberpunk', name: '赛博朋克', accent: '#f97316', bg: '#0a0812', card: '#161218' }
]

const fontFamilies = [
  "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
  "'Cascadia Code', 'Fira Code', Consolas, monospace",
  "'Fira Code', Consolas, monospace",
  "Consolas, 'Courier New', monospace",
  "'Source Code Pro', monospace"
]

export function SettingsDialog({ isOpen, onClose, sessionId }: SettingsDialogProps) {
  const settings = useSettingsStore((state) => state.settings)
  const setSettings = useSettingsStore((state) => state.setSettings)
  const setSettingsMemOnly = useSettingsStore((state) => state.setSettingsMemOnly)
  const [activeSection, setActiveSection] = useState('appearance')

  const handleThemeChange = (theme: 'dark' | 'light' | 'system') => {
    setSettings({ theme })
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else if (theme === 'light') {
      document.documentElement.classList.remove('dark')
    } else {
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      if (isDark) {
        document.documentElement.classList.add('dark')
      } else {
        document.documentElement.classList.remove('dark')
      }
    }
  }

  const handleColorThemeChange = (themeClass: string) => {
    // Remove all color theme classes
    uiColorThemes.forEach((t) => {
      if (t.id) document.documentElement.classList.remove(t.id)
    })
    // Apply new one
    if (themeClass) {
      document.documentElement.classList.add(themeClass)
    }
    setSettings({ colorTheme: themeClass } as any)
  }

  // Apply saved color theme on mount
  const colorTheme = (settings as any).colorTheme || ''

  const handleSidebarWidthChange = (value: number) => {
    setSettingsMemOnly({ sidebarWidth: value })
  }

  const handleSidebarWidthCommit = () => {
    setSettings({ sidebarWidth: settings.sidebarWidth })
  }

  const handleFontSizeChange = (value: number) => {
    setSettingsMemOnly({ fontSize: value })
  }

  const handleFontSizeCommit = () => {
    setSettings({ fontSize: settings.fontSize })
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm dialog-overlay" onClick={onClose} />

      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-[650px] max-h-[80vh] overflow-hidden dialog-content">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">设置</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-accent rounded-md transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex h-[500px]">
          {/* Section nav */}
          <div className="w-40 bg-card border-r border-border p-2 shrink-0">
            {[
              { id: 'appearance', label: '外观', icon: Palette },
              { id: 'terminal', label: '终端', icon: Type },
              { id: 'about', label: '关于', icon: Monitor }
            ].map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm transition-colors mb-1',
                  activeSection === section.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <section.icon className="w-4 h-4" />
                {section.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-5">
            {activeSection === 'appearance' && (
              <div className="space-y-6">
                {/* Theme */}
                <div>
                  <h3 className="text-sm font-medium mb-3">主题模式</h3>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { id: 'light', label: '浅色', icon: Sun },
                      { id: 'dark', label: '深色', icon: Moon },
                      { id: 'system', label: '跟随系统', icon: Monitor }
                    ].map((option) => (
                      <button
                        key={option.id}
                        onClick={() => handleThemeChange(option.id as any)}
                        className={cn(
                          'flex flex-col items-center gap-2 p-4 border rounded-lg transition-colors',
                          settings.theme === option.id
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        )}
                      >
                        <option.icon className="w-6 h-6" />
                        <span className="text-sm">{option.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* UI Color Theme */}
                <div>
                  <h3 className="text-sm font-medium mb-3">主题配色</h3>
                  <div className="grid grid-cols-4 gap-2">
                    {uiColorThemes.map((ct) => (
                      <button
                        key={ct.id}
                        onClick={() => handleColorThemeChange(ct.id)}
                        className={cn(
                          'flex flex-col items-center gap-1.5 p-2 border rounded-xl text-sm transition-all',
                          colorTheme === ct.id
                            ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                            : 'border-border hover:border-primary/50 hover:scale-[1.02]'
                        )}
                      >
                        {/* Mini UI preview */}
                        <div className="w-full h-14 rounded-lg overflow-hidden relative" style={{ background: ct.bg }}>
                          {/* Mini sidebar */}
                          <div className="absolute left-0 top-0 bottom-0 w-[30%] border-r" style={{ background: ct.card, borderColor: ct.accent + '20' }}>
                            <div className="mt-2 mx-1 h-1 rounded-full" style={{ background: ct.accent, opacity: 0.7 }} />
                            <div className="mt-1.5 mx-1 h-1 rounded-full bg-white/10" />
                            <div className="mt-1 mx-1 h-1 rounded-full bg-white/10" />
                          </div>
                          {/* Mini content */}
                          <div className="absolute left-[32%] top-1 right-1 bottom-1 rounded" style={{ background: ct.card, opacity: 0.6 }}>
                            <div className="mt-1.5 mx-1.5 h-1 w-[60%] rounded-full bg-white/15" />
                            <div className="mt-1 mx-1.5 h-1 w-[40%] rounded-full bg-white/10" />
                          </div>
                          {/* Accent dot */}
                          <div className="absolute bottom-1 right-1.5 w-2 h-2 rounded-full" style={{ background: ct.accent, boxShadow: '0 0 6px ' + ct.accent + '60' }} />
                        </div>
                        <span className="text-[10px] text-muted-foreground">{ct.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Sidebar width */}
                <div>
                  <h3 className="text-sm font-medium mb-3">
                    侧边栏宽度: {settings.sidebarWidth}px
                  </h3>
                  <input
                    type="range"
                    min={200}
                    max={400}
                    value={settings.sidebarWidth}
                    onChange={(e) => handleSidebarWidthChange(parseInt(e.target.value))}
                    onPointerUp={handleSidebarWidthCommit}
                    onKeyUp={handleSidebarWidthCommit}
                    className="w-full"
                  />
                </div>
              </div>
            )}

            {activeSection === 'terminal' && (
              <div className="space-y-6">
                {/* Font size */}
                <div>
                  <h3 className="text-sm font-medium mb-3">
                    字体大小: {settings.fontSize}px
                  </h3>
                  <input
                    type="range"
                    min={10}
                    max={24}
                    value={settings.fontSize}
                    onChange={(e) => handleFontSizeChange(parseInt(e.target.value))}
                    onPointerUp={handleFontSizeCommit}
                    onKeyUp={handleFontSizeCommit}
                    className="w-full"
                  />
                </div>

                {/* Font family */}
                <div>
                  <h3 className="text-sm font-medium mb-3">字体</h3>
                  <div className="space-y-2">
                    {fontFamilies.map((font) => (
                      <button
                        key={font}
                        onClick={() => setSettings({ fontFamily: font })}
                        className={cn(
                          'block w-full text-left px-3 py-2 border rounded-lg text-sm transition-colors',
                          settings.fontFamily === font
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        )}
                        style={{ fontFamily: font }}
                      >
                        {font.split("'")[1] || font.split(',')[0]} - Hello World 你好世界 01234
                      </button>
                    ))}
                  </div>
                </div>

                {/* Terminal theme */}
                <div>
                  <h3 className="text-sm font-medium mb-3">终端配色</h3>
                  <div className="grid grid-cols-2 gap-2">
                    {terminalThemes.map((theme) => (
                      <button
                        key={theme.id}
                        onClick={() => setSettings({ terminalTheme: theme.id })}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2 border rounded-lg text-sm transition-colors',
                          settings.terminalTheme === theme.id
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        )}
                      >
                        <div
                          className="w-8 h-8 rounded border border-border flex items-center justify-center"
                          style={{ backgroundColor: theme.preview }}
                        >
                          <span style={{ color: theme.fg, fontSize: '10px', fontWeight: 600 }}>Aa</span>
                        </div>
                        <span>{theme.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium mb-3">终端渲染器</h3>
                  <div className="space-y-2">
                    {terminalRendererModes.map((mode) => (
                      <button
                        key={mode.id}
                        onClick={() => setSettings({ terminalRenderer: mode.id })}
                        className={cn(
                          'block w-full rounded-xl border p-3 text-left transition-colors',
                          settings.terminalRenderer === mode.id
                            ? 'border-primary bg-primary/5'
                            : 'border-border hover:border-primary/50'
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium">{mode.name}</div>
                            <div className="mt-1 text-xs leading-5 text-muted-foreground">{mode.description}</div>
                          </div>
                          <div
                            className={cn(
                              'h-2.5 w-2.5 shrink-0 rounded-full',
                              settings.terminalRenderer === mode.id ? 'bg-primary shadow-[0_0_10px_currentColor]' : 'bg-muted-foreground/30'
                            )}
                          />
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="text-sm font-medium mb-3">兼容模式</h3>
                  <button
                    onClick={() => setSettings({ aiCompatibilityMode: !settings.aiCompatibilityMode })}
                    className={cn(
                      'w-full rounded-xl border p-4 text-left transition-colors',
                      settings.aiCompatibilityMode
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium">AI/TUI 终端兼容模式</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          优化 `claude code`、`codex`、`opencode`、`vim`、`htop` 这类重交互终端工具的显示和输入行为。
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          会为新建 SSH 会话启用更兼容的 PTY 和终端设置；已打开的会话重连后生效。
                        </p>
                      </div>
                      <div
                        className={cn(
                          'mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors',
                          settings.aiCompatibilityMode
                            ? 'border-primary bg-primary'
                            : 'border-border bg-muted'
                        )}
                      >
                        <span
                          className={cn(
                            'm-[2px] h-5 w-5 rounded-full bg-white transition-transform',
                            settings.aiCompatibilityMode ? 'translate-x-5' : 'translate-x-0'
                          )}
                        />
                      </div>
                    </div>
                  </button>
                </div>

                <div>
                  <h3 className="text-sm font-medium mb-3">远程剪贴板</h3>
                  <button
                    onClick={() => setSettings({ allowRemoteClipboardWrite: !settings.allowRemoteClipboardWrite })}
                    className={cn(
                      'w-full rounded-xl border p-4 text-left transition-colors',
                      settings.allowRemoteClipboardWrite
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium">允许远程程序写入本地剪贴板</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          支持 `opencode`、`claude`、`codex` 等终端工具通过 OSC 52 真正复制内容到本机剪贴板。
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          关闭后，远程程序仍可能提示复制成功，但不会真正写入本地系统剪贴板。
                        </p>
                      </div>
                      <div
                        className={cn(
                          'mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors',
                          settings.allowRemoteClipboardWrite
                            ? 'border-primary bg-primary'
                            : 'border-border bg-muted'
                        )}
                      >
                        <span
                          className={cn(
                            'm-[2px] h-5 w-5 rounded-full bg-white transition-transform',
                            settings.allowRemoteClipboardWrite ? 'translate-x-5' : 'translate-x-0'
                          )}
                        />
                      </div>
                    </div>
                  </button>
                </div>

                <div>
                  <h3 className="text-sm font-medium mb-3">Rust SSH 引擎</h3>
                  <button
                    onClick={() => setSettings({ useRustSshEngine: !settings.useRustSshEngine })}
                    className={cn(
                      'w-full rounded-xl border p-4 text-left transition-colors',
                      settings.useRustSshEngine
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:border-primary/50'
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium">使用 Rust SSH 引擎</div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">
                          新建 SSH 连接默认使用 Rust sidecar 建立会话与远程能力，Node `ssh2` 作为兼容回退路径保留。
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          关闭后，新建连接会退回到 Node `ssh2` 实现。
                        </p>
                      </div>
                      <div
                        className={cn(
                          'mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full border transition-colors',
                          settings.useRustSshEngine
                            ? 'border-primary bg-primary'
                            : 'border-border bg-muted'
                        )}
                      >
                        <span
                          className={cn(
                            'm-[2px] h-5 w-5 rounded-full bg-white transition-transform',
                            settings.useRustSshEngine ? 'translate-x-5' : 'translate-x-0'
                          )}
                        />
                      </div>
                    </div>
                  </button>
                </div>

                <TerminalDiagnostics sessionId={sessionId} />
              </div>
            )}

            {activeSection === 'about' && (
              <div className="space-y-6">
                <div className="text-center py-6">
                  <h3 className="text-2xl font-bold mb-1">Nutshell</h3>
                  <p className="text-muted-foreground mb-1">版本 1.0.1</p>
                  <p className="text-sm text-muted-foreground">
                    高级 SSH 远程管理工具
                  </p>
                </div>

                <div className="space-y-3 text-sm">
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">作者</span>
                    <span className="font-medium">吴翔</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">框架</span>
                    <span>Electron + React + TypeScript</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">UI</span>
                    <span>Tailwind CSS + shadcn/ui</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">终端</span>
                    <span>xterm.js</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">SSH</span>
                    <span>ssh2 (Node.js)</span>
                  </div>
                  <div className="flex justify-between py-2 border-b border-border">
                    <span className="text-muted-foreground">加密</span>
                    <span>AES-256-CBC</span>
                  </div>
                </div>

                <p className="text-xs text-center text-muted-foreground mt-6">
                  Copyright © {new Date().getFullYear()} 吴翔. All Rights Reserved.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
