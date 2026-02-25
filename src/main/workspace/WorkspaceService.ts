import { sshManager } from '../ssh/SSHManager'
import { sftpManager } from '../ssh/SFTPManager'

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  permissions: string
  mtime: string
  gitStatus?: string // M, A, D, ?, etc.
}

export interface GitInfo {
  branch: string
  changes: Array<{ status: string; file: string }>
  isRepo: boolean
}

export interface SearchResult {
  file: string
  line: number
  content: string
}

class WorkspaceService {
  async listDirectory(sessionId: string, dirPath: string): Promise<FileEntry[]> {
    const safePath = dirPath.replace(/"/g, '\\"')
    const output = await sshManager.exec(sessionId,
      `ls -la --time-style=long-iso "${safePath}" 2>/dev/null | tail -n +2`, 10000)

    const entries: FileEntry[] = []
    for (const line of output.trim().split('\n')) {
      if (!line.trim()) continue
      const parts = line.split(/\s+/)
      if (parts.length < 8) continue
      const perms = parts[0]
      const size = parseInt(parts[4]) || 0
      const mtime = `${parts[5]} ${parts[6]}`
      const name = parts.slice(7).join(' ')
      if (name === '.' || name === '..') continue
      const isDir = perms.startsWith('d')
      entries.push({
        name, path: `${dirPath}/${name}`.replace(/\/+/g, '/'),
        isDirectory: isDir, size, permissions: perms, mtime
      })
    }

    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.name.localeCompare(b.name)
    })
    return entries
  }

  async searchFiles(sessionId: string, rootPath: string, query: string): Promise<SearchResult[]> {
    if (!query.trim()) return []
    const safeRoot = rootPath.replace(/"/g, '\\"')
    const safeQuery = query.replace(/"/g, '\\"').replace(/[`$]/g, '\\$&')
    const output = await sshManager.exec(sessionId,
      `grep -rn --include='*' -I "${safeQuery}" "${safeRoot}" 2>/dev/null | head -100`, 15000)

    return output.trim().split('\n').filter(Boolean).map((line) => {
      const match = line.match(/^(.+?):(\d+):(.*)$/)
      if (!match) return null
      return { file: match[1], line: parseInt(match[2]), content: match[3].trim() }
    }).filter(Boolean) as SearchResult[]
  }

  async searchFileNames(sessionId: string, rootPath: string, pattern: string): Promise<string[]> {
    if (!pattern.trim()) return []
    const safeRoot = rootPath.replace(/"/g, '\\"')
    const safePattern = pattern.replace(/"/g, '\\"')
    const output = await sshManager.exec(sessionId,
      `find "${safeRoot}" -maxdepth 5 -name "*${safePattern}*" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -50`, 10000)
    return output.trim().split('\n').filter(Boolean)
  }

  async getGitStatus(sessionId: string, rootPath: string): Promise<GitInfo> {
    const safeRoot = rootPath.replace(/"/g, '\\"')
    // Check if it's a git repo
    const gitCheck = await sshManager.exec(sessionId, `cd "${safeRoot}" && git rev-parse --is-inside-work-tree 2>&1`)
    if (!gitCheck.trim().includes('true')) {
      return { branch: '', changes: [], isRepo: false }
    }

    const branchOutput = await sshManager.exec(sessionId, `cd "${safeRoot}" && git branch --show-current 2>/dev/null`)
    const statusOutput = await sshManager.exec(sessionId, `cd "${safeRoot}" && git status --porcelain 2>/dev/null`)

    const changes = statusOutput.trim().split('\n').filter(Boolean).map((line) => ({
      status: line.substring(0, 2).trim(),
      file: line.substring(3)
    }))

    return { branch: branchOutput.trim(), changes, isRepo: true }
  }

  async getGitDiff(sessionId: string, rootPath: string, file: string): Promise<string> {
    const safeRoot = rootPath.replace(/"/g, '\\"')
    const safeFile = file.replace(/"/g, '\\"')
    return sshManager.exec(sessionId, `cd "${safeRoot}" && git diff "${safeFile}" 2>/dev/null`, 10000)
  }
  // ===== Project Scanning =====
  async scanProject(sessionId: string, rootPath: string): Promise<string[]> {
    const safeRoot = rootPath.replace(/"/g, '\\"')
    const output = await sshManager.exec(sessionId,
      `find "${safeRoot}" -maxdepth 4 -type f ` +
      `-not -path "*/.git/*" -not -path "*/node_modules/*" -not -path "*/__pycache__/*" ` +
      `-not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" ` +
      `-not -path "*/.venv/*" -not -path "*/vendor/*" -not -name "*.pyc" ` +
      `-not -name "*.min.js" -not -name "*.min.css" -not -name "*.map" ` +
      `2>/dev/null | head -500`, 15000)
    return output.trim().split('\n').filter(Boolean)
  }

  async readMultipleFiles(sessionId: string, paths: string[]): Promise<Array<{ path: string; content: string; error?: string }>> {
    const results: Array<{ path: string; content: string; error?: string }> = []
    // Read files in parallel batches of 5
    for (let i = 0; i < paths.length; i += 5) {
      const batch = paths.slice(i, i + 5)
      const promises = batch.map(async (filePath) => {
        try {
          const content = await sftpManager.readFile(sessionId, filePath)
          return { path: filePath, content }
        } catch (err: any) {
          return { path: filePath, content: '', error: err.message }
        }
      })
      results.push(...await Promise.all(promises))
    }
    return results
  }

  async getProjectSummary(sessionId: string, rootPath: string): Promise<string> {
    const safeRoot = rootPath.replace(/"/g, '\\"')

    // Get directory tree (compact)
    const tree = await sshManager.exec(sessionId,
      `find "${safeRoot}" -maxdepth 3 -not -path "*/.git/*" -not -path "*/node_modules/*" ` +
      `-not -path "*/__pycache__/*" -not -path "*/dist/*" 2>/dev/null | head -200 | ` +
      `sed "s|${safeRoot}/||"`, 10000)

    // Read key config files
    const keyFiles = ['package.json', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'requirements.txt',
      'go.mod', 'Cargo.toml', 'pom.xml', 'README.md', '.env.example', 'tsconfig.json', 'pyproject.toml']

    let summary = `项目目录: ${rootPath}\n\n目录结构:\n${tree.trim()}\n`

    for (const kf of keyFiles) {
      try {
        const content = await sshManager.exec(sessionId, `cat "${safeRoot}/${kf}" 2>/dev/null | head -50`)
        if (content.trim()) {
          summary += `\n--- ${kf} ---\n${content.trim()}\n`
        }
      } catch { /* skip */ }
    }

    return summary.substring(0, 8000) // Limit context size
  }

  async writeFile(sessionId: string, filePath: string, content: string): Promise<void> {
    await sftpManager.writeFile(sessionId, filePath, content)
  }

  async readFile(sessionId: string, filePath: string): Promise<string> {
    return sftpManager.readFile(sessionId, filePath)
  }

  async runCommand(sessionId: string, rootPath: string, command: string): Promise<string> {
    const safeRoot = rootPath.replace(/"/g, '\\"')
    return sshManager.exec(sessionId, `cd "${safeRoot}" && ${command} 2>&1`, 30000)
  }
}

export const workspaceService = new WorkspaceService()
