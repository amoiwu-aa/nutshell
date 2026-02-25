import { useCallback, useRef } from 'react'
import { cn } from '../../lib/utils'

interface ResizableDividerProps {
  direction: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
  onResizeEnd?: () => void
  className?: string
}

export function ResizableDivider({ direction, onResize, onResizeEnd, className }: ResizableDividerProps) {
  const startPos = useRef(0)
  const dragging = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startPos.current = direction === 'horizontal' ? e.clientY : e.clientX
    document.body.classList.add(direction === 'horizontal' ? 'resizing-h' : 'resizing-v')

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const current = direction === 'horizontal' ? ev.clientY : ev.clientX
      const delta = current - startPos.current
      startPos.current = current
      onResize(delta)
    }

    const handleMouseUp = () => {
      dragging.current = false
      document.body.classList.remove('resizing-h', 'resizing-v')
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      onResizeEnd?.()
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
  }, [direction, onResize, onResizeEnd])

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        'shrink-0 transition-colors hover:bg-primary/30',
        direction === 'horizontal'
          ? 'h-1 cursor-row-resize w-full'
          : 'w-1 cursor-col-resize h-full',
        className
      )}
    />
  )
}
