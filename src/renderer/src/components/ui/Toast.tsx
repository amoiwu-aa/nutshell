import { useState, useEffect, useCallback, createContext, useContext } from 'react'
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { cn } from '../../lib/utils'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface ToastMessage {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number
}

interface ToastContextType {
  toast: (type: ToastType, title: string, message?: string, duration?: number) => void
}

const ToastContext = createContext<ToastContextType>({
  toast: () => {}
})

export function useToast() {
  return useContext(ToastContext)
}

const icons: Record<ToastType, typeof CheckCircle> = {
  success: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info
}

const colors: Record<ToastType, string> = {
  success: 'border-green-500/50 bg-green-500/10',
  error: 'border-destructive/50 bg-destructive/10',
  warning: 'border-yellow-500/50 bg-yellow-500/10',
  info: 'border-primary/50 bg-primary/10'
}

const iconColors: Record<ToastType, string> = {
  success: 'text-green-500',
  error: 'text-destructive',
  warning: 'text-yellow-500',
  info: 'text-primary'
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([])

  const addToast = useCallback(
    (type: ToastType, title: string, message?: string, duration: number = 4000) => {
      const id = `${Date.now()}-${Math.random()}`
      setToasts((prev) => [...prev, { id, type, title, message, duration }])
    },
    []
  )

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      <div className="fixed bottom-8 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onClose={() => removeToast(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)

  const Icon = icons[toast.type]

  useEffect(() => {
    // Enter animation
    requestAnimationFrame(() => setVisible(true))

    // Auto dismiss
    const timer = setTimeout(() => {
      setExiting(true)
      setTimeout(onClose, 300)
    }, toast.duration || 4000)

    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      className={cn(
        'pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg backdrop-blur-sm min-w-[300px] max-w-[420px] transition-all duration-300',
        colors[toast.type],
        visible && !exiting ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-8'
      )}
    >
      <Icon className={cn('w-5 h-5 shrink-0 mt-0.5', iconColors[toast.type])} />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">{toast.title}</p>
        {toast.message && (
          <p className="text-xs text-muted-foreground mt-0.5 break-words">{toast.message}</p>
        )}
      </div>
      <button
        onClick={() => {
          setExiting(true)
          setTimeout(onClose, 300)
        }}
        className="shrink-0 p-0.5 hover:bg-accent rounded transition-colors"
      >
        <X className="w-3.5 h-3.5 text-muted-foreground" />
      </button>
    </div>
  )
}
