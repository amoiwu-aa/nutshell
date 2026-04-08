import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/globals.css'

class RootErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[renderer:root-error-boundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ height: '100vh', background: '#0b1220', color: '#e5e7eb', padding: 24, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', overflow: 'auto' }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 12 }}>Renderer 启动失败</h1>
          <p style={{ marginBottom: 16, color: '#9ca3af' }}>应用没有正常渲染。请把下面错误信息发给我。</p>
          <pre style={{ whiteSpace: 'pre-wrap', background: '#111827', padding: 16, borderRadius: 8, color: '#fca5a5' }}>
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}

window.addEventListener('error', (event) => {
  console.error('[renderer:window-error]', event.error || event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer:unhandledrejection]', event.reason)
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <RootErrorBoundary>
    <App />
  </RootErrorBoundary>
)
