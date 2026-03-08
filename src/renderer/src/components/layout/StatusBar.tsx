import { Wifi, WifiOff, Clock, ArrowUp, ArrowDown } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useTransferStore } from '../../stores/transferStore'

export function StatusBar() {
  const { tabs, activeTabId, setBottomPanelActiveTab, setBottomPanelVisible } = useConnectionStore()
  // Use separate primitive selectors to avoid new-object infinite loop
  const uploadCount = useTransferStore((s) => {
    let count = 0
    for (const t of s.transfers) if (t.status === 'active' && t.direction === 'upload') count++
    return count
  })
  const downloadCount = useTransferStore((s) => {
    let count = 0
    for (const t of s.transfers) if (t.status === 'active' && t.direction === 'download') count++
    return count
  })
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const activeTab = tabs.find((t) => t.id === activeTabId)
  const connectedCount = tabs.filter((t) => t.connected).length
  const hasActiveTransfers = uploadCount > 0 || downloadCount > 0

  const handleTransferClick = () => {
    setBottomPanelActiveTab('transfers')
    setBottomPanelVisible(true)
  }

  return (
    <div className="flex items-center justify-between h-6 px-3 bg-card border-t border-border text-xs text-muted-foreground shrink-0">
      <div className="flex items-center gap-3">
        {activeTab ? (
          <div className="flex items-center gap-1.5">
            {activeTab.connected ? (
              <span className="status-dot-connected mr-1" />
            ) : (
              <WifiOff className="w-3 h-3 text-destructive" />
            )}
            <span>{activeTab.connected ? '已连接' : '已断开'}</span>
            <span className="text-muted-foreground/60">|</span>
            <span>{activeTab.name}</span>
          </div>
        ) : (
          <span>就绪</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {hasActiveTransfers && (
          <button
            onClick={handleTransferClick}
            className="flex items-center gap-1.5 hover:text-foreground transition-colors"
          >
            {uploadCount > 0 && (
              <span className="flex items-center gap-0.5 text-blue-400">
                <ArrowUp className="w-2.5 h-2.5" />
                {uploadCount}
              </span>
            )}
            {downloadCount > 0 && (
              <span className="flex items-center gap-0.5 text-green-400">
                <ArrowDown className="w-2.5 h-2.5" />
                {downloadCount}
              </span>
            )}
          </button>
        )}
        <span>
          活跃连接: {connectedCount}/{tabs.length}
        </span>
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          <span>{time.toLocaleTimeString('zh-CN')}</span>
        </div>
      </div>
    </div>
  )
}
