import { Terminal, Server, Shield, MonitorDot, Container } from 'lucide-react'

export function WelcomeScreen() {
  const handleNewConnection = () => {
    const event = new CustomEvent('connection:new')
    window.dispatchEvent(event)
  }

  return (
    <div className="flex-1 flex items-center justify-center bg-background">
      <div className="text-center max-w-lg">
        {/* Logo */}
        <div className="flex items-center justify-center mb-6">
          <div className="flex items-center justify-center w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20">
            <Terminal className="w-10 h-10 text-primary" />
          </div>
        </div>

        <h1 className="text-3xl font-bold text-foreground mb-2">SuperShell</h1>
        <p className="text-muted-foreground mb-8">
          高级 SSH 远程管理工具 - 更安全、更高效、更现代
        </p>

        {/* Quick start button */}
        <button
          onClick={handleNewConnection}
          className="inline-flex items-center gap-2 px-6 py-2.5 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors mb-10"
        >
          <Server className="w-4 h-4" />
          新建 SSH 连接
        </button>

        {/* Features */}
        <div className="grid grid-cols-2 gap-4 text-left">
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border">
            <Terminal className="w-5 h-5 text-primary mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-foreground">SSH 终端</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                完整终端模拟，多标签、分屏
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border">
            <MonitorDot className="w-5 h-5 text-green-500 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-foreground">服务器监控</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                CPU、内存、磁盘、网络实时图表
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border">
            <Shield className="w-5 h-5 text-yellow-500 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-foreground">安全加密</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                AES 加密存储密码和密钥
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 p-3 rounded-lg bg-card border border-border">
            <Container className="w-5 h-5 text-blue-400 mt-0.5 shrink-0" />
            <div>
              <h3 className="text-sm font-medium text-foreground">Docker 管理</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                容器管理、镜像操作、日志查看
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
