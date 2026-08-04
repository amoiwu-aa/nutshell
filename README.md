# Nutshell - 高级 SSH 远程管理工具

一个使用 Electron + React + TypeScript 构建的现代化 SSH 远程管理工具，比 FinalShell 更安全、更高效、更美观。

## 功能特性

- **SSH 终端** - 基于 xterm.js 的完整终端模拟，支持 256 色/真彩色、多标签页
- **SFTP 文件管理** - 双栏文件浏览器（本地+远程），支持上传/下载/在线编辑
- **服务器监控** - CPU、内存、磁盘、网络实时图表 + 进程管理
- **Docker 管理** - 容器管理、镜像操作、日志查看、容器终端
- **端口转发** - 本地/远程/动态(SOCKS5)端口转发，可视化规则管理
- **远程工作区** - 远程文件树、全文搜索、Git 状态与 diff、Monaco 编辑器
- **命令片段** - 常用命令保存、变量模板、批量执行、导入导出
- **密钥管理** - 密码/密钥认证、跳板机支持
- **主机密钥校验** - 首次连接记录指纹，变更时中断连接以防中间人攻击
- **安全存储** - AES-256-CBC 加密存储密码和密钥
- **双引擎** - Node (ssh2) 与 Rust (russh) 内核可切换，后者用于高速 SFTP 传输
- **主题切换** - 亮色/暗色/跟随系统，多种终端配色方案

## 技术栈

| 模块 | 技术 |
|------|------|
| 框架 | Electron 33 |
| 前端 | React 19 + TypeScript |
| 构建 | Vite + electron-vite |
| UI | Tailwind CSS + shadcn/ui |
| 终端 | xterm.js |
| 编辑器 | Monaco Editor |
| SSH | ssh2 (Node.js) + russh (Rust sidecar) |
| 图表 | Recharts |
| 存储 | electron-store (AES 加密) |
| 打包 | electron-builder |

## 开始使用

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建生产版本

```bash
npm run build
```

### 打包为安装程序

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

## 使用说明

1. 启动后点击「新建 SSH 连接」创建服务器连接
2. 双击连接列表中的服务器即可开启 SSH 终端
3. 在标签页上右键可以打开：文件管理、服务器监控、Docker 管理
4. 左下角可以访问命令片段管理和应用设置

## 项目结构

```
native/
└── nutshell-core/           # Rust sidecar (russh + russh-sftp)

src/
├── main/                    # Electron 主进程
│   ├── ssh/                 # SSH/SFTP/端口转发/主机密钥/连接调优
│   ├── monitor/             # 服务器监控采集
│   ├── docker/              # Docker 远程管理
│   ├── workspace/           # 远程工作区（浏览、搜索、git）
│   ├── rust/                # Rust 内核进程管理与远程文件系统
│   ├── store/               # 加密配置存储
│   └── ipc/                 # IPC 通信处理
├── preload/                 # 安全桥接层
└── renderer/                # React 前端 UI
    ├── components/
    │   ├── layout/          # 布局组件
    │   ├── terminal/        # 终端组件
    │   ├── sftp/            # 文件管理组件
    │   ├── monitor/         # 监控仪表盘
    │   ├── docker/          # Docker 面板
    │   ├── workspace/       # 远程工作区与编辑器
    │   ├── snippet/         # 命令片段管理
    │   ├── portforward/     # 端口转发
    │   ├── transfer/        # 传输队列
    │   ├── connection/      # 连接管理
    │   └── settings/        # 设置面板
    └── stores/              # 状态管理 (Zustand)
```

## License

MIT
