import { useState, useEffect } from 'react'
import { Minus, Square, X, Copy, Terminal, Monitor, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

const sizePresets = [
  { label: '1024 x 768', w: 1024, h: 768 },
  { label: '1400 x 900', w: 1400, h: 900 },
  { label: '1600 x 1000', w: 1600, h: 1000 },
  { label: '1920 x 1080', w: 1920, h: 1080 }
]

export function TitleBar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const [showSizeMenu, setShowSizeMenu] = useState(false)

  useEffect(() => {
    const checkMaximized = async () => {
      const maximized = await window.api.window.isMaximized()
      setIsMaximized(maximized)
    }
    checkMaximized()
  }, [])

  const handleMinimize = () => window.api.window.minimize()
  const handleMaximize = () => {
    window.api.window.maximize()
    setIsMaximized(!isMaximized)
  }
  const handleClose = () => window.api.window.close()

  const handleSetSize = (w: number, h: number) => {
    window.api.window.setSize(w, h)
    setIsMaximized(false)
    setShowSizeMenu(false)
  }

  return (
    <>
      <div className="flex items-center h-9 bg-card border-b border-border drag-region shrink-0">
        {/* App icon and title */}
        <div className="flex items-center px-3 gap-2 no-drag">
          <Terminal className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Nutshell</span>
        </div>

        {/* Window size preset button */}
        <div className="relative no-drag">
          <button
            onClick={() => setShowSizeMenu(!showSizeMenu)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title="窗口大小预设"
          >
            <Monitor className="w-3 h-3" />
            <ChevronDown className="w-3 h-3" />
          </button>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Window controls */}
        <div className="flex items-center no-drag">
          <button
            onClick={handleMinimize}
            className="flex items-center justify-center w-12 h-9 hover:bg-accent transition-colors"
            title="最小化"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            onClick={handleMaximize}
            className="flex items-center justify-center w-12 h-9 hover:bg-accent transition-colors"
            title={isMaximized ? '还原' : '最大化'}
          >
            {isMaximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={handleClose}
            className="flex items-center justify-center w-12 h-9 hover:bg-destructive hover:text-destructive-foreground transition-colors"
            title="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Size preset dropdown */}
      {showSizeMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setShowSizeMenu(false)} />
          <div className="fixed z-50 bg-card border border-border rounded-md shadow-lg py-1 min-w-[140px] context-menu" style={{ left: 130, top: 32 }}>
            {sizePresets.map((p) => (
              <button
                key={p.label}
                onClick={() => handleSetSize(p.w, p.h)}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent transition-colors"
              >
                <Monitor className="w-3 h-3 text-muted-foreground" />
                {p.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  )
}
