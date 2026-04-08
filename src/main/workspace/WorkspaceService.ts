import { sshManager } from '../ssh/SSHManager'
import { sftpManager } from '../ssh/SFTPManager'
import { rustCoreService } from '../rust/RustCoreService'
import { rustRemoteFS } from '../rust/RustRemoteFS'

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
  permissions: string
  mtime: string
  gitStatus?: string
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

function isRustSession(sessionId: string): boolean {
  return rustCoreService.hasSshSession(sessionId)
}

function stripCommandChaining(command: string): string {
  const trimmed = command.trim()
  const cdPrefix = /^cd\s+(['"])(.*?)\1\s*&&\s*/
  return trimmed.replace(cdPrefix, '')
}

function unwrapCommandOutput(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return ''

  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object' && 'stdout' in parsed) {
      const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : ''
      const stderr = typeof parsed.stderr === 'string' ? parsed.stderr : ''
      return [stdout, stderr].filter(Boolean).join(stdout && stderr ? '\n' : '')
    }
  } catch {
    // Plain output; return as-is.
  }

  return output
}

function formatMtime(value: number): string {
  if (!value) return ''
  const dt = new Date(value * 1000)
  const yyyy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  const hh = String(dt.getHours()).padStart(2, '0')
  const mi = String(dt.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

class WorkspaceService {
  private async exec(sessionId: string, command: string, timeoutMs: number = 30000, requireConfirmation: boolean = false): Promise<string> {
    if (!isRustSession(sessionId)) {
      return sshManager.exec(sessionId, command, timeoutMs)
    }

    const result = await rustCoreService.runCommand({
      sessionId,
      command,
      timeoutMs,
      requireConfirmation
    })

    if (result.blocked) {
      throw new Error(result.reason || 'Command blocked by Rust safety policy')
    }
    if ((result.exitCode ?? 0) !== 0 && result.stderr.trim()) {
      return [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '')
    }
    return [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '')
  }

  async listDirectory(sessionId: string, dirPath: string): Promise<FileEntry[]> {
    if (!isRustSession(sessionId)) {
      const safePath = dirPath.replace(/"/g, '\\"')
      const output = await sshManager.exec(
        sessionId,
        `ls -la --time-style=long-iso "${safePath}" 2>/dev/null | tail -n +2`,
        10000
      )

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
        entries.push({
          name,
          path: `${dirPath}/${name}`.replace(/\/+/g, '/'),
          isDirectory: perms.startsWith('d'),
          size,
          permissions: perms,
          mtime
        })
      }

      entries.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1
        if (!a.isDirectory && b.isDirectory) return 1
        return a.name.localeCompare(b.name)
      })
      return entries
    }

    const result = await rustCoreService.listDir({ sessionId, path: dirPath })
    return (result.entries || []).map((entry: any) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDir === true,
      size: Number(entry.size || 0),
      permissions: typeof entry.mode === 'string' ? entry.mode : '',
      mtime: formatMtime(Number(entry.mtime || 0))
    }))
  }

  async searchFiles(sessionId: string, rootPath: string, query: string): Promise<SearchResult[]> {
    if (!query.trim()) return []

    if (!isRustSession(sessionId)) {
      const safeRoot = rootPath.replace(/"/g, '\\"')
      const safeQuery = query.replace(/"/g, '\\"').replace(/[`$]/g, '\\$&')
      const output = await sshManager.exec(
        sessionId,
        `grep -rn --include='*' -I "${safeQuery}" "${safeRoot}" 2>/dev/null | head -100`,
        15000
      )

      return output.trim().split('\n').filter(Boolean).map((line) => {
        const match = line.match(/^(.+?):(\d+):(.*)$/)
        if (!match) return null
        return { file: match[1], line: parseInt(match[2]), content: match[3].trim() }
      }).filter(Boolean) as SearchResult[]
    }

    const result = await rustCoreService.search({ sessionId, rootPath, pattern: query, limit: 100 })
    return (result.matches || []).map((match: any) => ({
      file: String(match.path || ''),
      line: Number(match.line || 0),
      content: String(match.preview || '')
    }))
  }

  async searchFileNames(sessionId: string, rootPath: string, pattern: string): Promise<string[]> {
    if (!pattern.trim()) return []
    const command = `find ${shellQuote(rootPath)} -maxdepth 5 -name ${shellQuote(`*${pattern}*`)} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -50`
    const output = await this.exec(sessionId, command, 10000)
    return unwrapCommandOutput(output).trim().split('\n').filter(Boolean)
  }

  async getGitStatus(sessionId: string, rootPath: string): Promise<GitInfo> {
    const gitCheck = await this.exec(sessionId, `cd ${shellQuote(rootPath)} && git rev-parse --is-inside-work-tree 2>&1`, 10000)
    if (!unwrapCommandOutput(gitCheck).trim().includes('true')) {
      return { branch: '', changes: [], isRepo: false }
    }

    const branchOutput = await this.exec(sessionId, `cd ${shellQuote(rootPath)} && git branch --show-current 2>/dev/null`, 10000)
    const statusOutput = await this.exec(sessionId, `cd ${shellQuote(rootPath)} && git status --porcelain 2>/dev/null`, 10000)
    const rawBranch = unwrapCommandOutput(branchOutput)
    const rawStatus = unwrapCommandOutput(statusOutput)

    const changes = rawStatus.trim().split('\n').filter(Boolean).map((line) => ({
      status: line.substring(0, 2).trim(),
      file: line.substring(3)
    }))

    return { branch: rawBranch.trim(), changes, isRepo: true }
  }

  async getGitDiff(sessionId: string, rootPath: string, file: string): Promise<string> {
    if (!isRustSession(sessionId)) {
      return this.exec(sessionId, `cd ${shellQuote(rootPath)} && git diff ${shellQuote(file)} 2>/dev/null`, 10000)
    }

    const result = await rustCoreService.runCommand({
      sessionId,
      cwd: rootPath,
      command: `git diff ${shellQuote(file)} 2>/dev/null`,
      timeoutMs: 10000,
      requireConfirmation: false
    })
    if (result.blocked) {
      throw new Error(result.reason || 'Command blocked by Rust safety policy')
    }
    return unwrapCommandOutput([result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : ''))
  }

  async scanProject(sessionId: string, rootPath: string): Promise<string[]> {
    if (!isRustSession(sessionId)) {
      const safeRoot = rootPath.replace(/"/g, '\\"')
      const output = await sshManager.exec(
        sessionId,
        `find "${safeRoot}" -maxdepth 4 -type f ` +
        `-not -path "*/.git/*" -not -path "*/node_modules/*" -not -path "*/__pycache__/*" ` +
        `-not -path "*/dist/*" -not -path "*/build/*" -not -path "*/.next/*" ` +
        `-not -path "*/.venv/*" -not -path "*/vendor/*" -not -name "*.pyc" ` +
        `-not -name "*.min.js" -not -name "*.min.css" -not -name "*.map" ` +
        `2>/dev/null | head -500`,
        15000
      )
      return unwrapCommandOutput(output).trim().split('\n').filter(Boolean)
    }

    const result = await rustCoreService.scanProject({ sessionId, rootPath })
    return result.files || []
  }

  async readMultipleFiles(sessionId: string, paths: string[]): Promise<Array<{ path: string; content: string; error?: string }>> {
    if (!isRustSession(sessionId)) {
      const results: Array<{ path: string; content: string; error?: string }> = []
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

    const result = await rustCoreService.readMultipleFiles({ sessionId, paths, maxBytesPerFile: 128 * 1024 })
    return result.results || []
  }

  async getProjectSummary(sessionId: string, rootPath: string): Promise<string> {
    if (!isRustSession(sessionId)) {
      const safeRoot = rootPath.replace(/"/g, '\\"')
      const tree = await sshManager.exec(
        sessionId,
        `find "${safeRoot}" -maxdepth 3 -not -path "*/.git/*" -not -path "*/node_modules/*" ` +
        `-not -path "*/__pycache__/*" -not -path "*/dist/*" 2>/dev/null | head -200 | ` +
        `sed "s|${safeRoot}/||"`,
        10000
      )

      const keyFiles = ['package.json', 'Makefile', 'Dockerfile', 'docker-compose.yml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'README.md', '.env.example', 'tsconfig.json', 'pyproject.toml']
      let summary = `Project root: ${rootPath}\n\nTree:\n${unwrapCommandOutput(tree).trim()}\n`
      for (const keyFile of keyFiles) {
        try {
          const content = await sshManager.exec(sessionId, `cat "${safeRoot}/${keyFile}" 2>/dev/null | head -50`)
          if (content.trim()) {
            summary += `\n--- ${keyFile} ---\n${unwrapCommandOutput(content).trim()}\n`
          }
        } catch {
          // skip
        }
      }
      return summary.substring(0, 8000)
    }

    const result = await rustCoreService.projectSummary({ sessionId, rootPath })
    return result.summary || ''
  }

  async writeFile(sessionId: string, filePath: string, content: string): Promise<void> {
    if (isRustSession(sessionId)) {
      await rustRemoteFS.writeFile(sessionId, filePath, content)
      return
    }
    await sftpManager.writeFile(sessionId, filePath, content)
  }

  async readFile(sessionId: string, filePath: string): Promise<string> {
    if (isRustSession(sessionId)) {
      return rustRemoteFS.readFile(sessionId, filePath)
    }
    return sftpManager.readFile(sessionId, filePath)
  }

  async runCommand(sessionId: string, rootPath: string, command: string): Promise<string> {
    if (!isRustSession(sessionId)) {
      const safeRoot = rootPath.replace(/"/g, '\\"')
      return sshManager.exec(sessionId, `cd "${safeRoot}" && ${command} 2>&1`, 30000)
    }

    const normalizedCommand = stripCommandChaining(command)

    const result = await rustCoreService.runCommand({
      sessionId,
      cwd: rootPath,
      command: normalizedCommand,
      timeoutMs: 30000,
      requireConfirmation: false
    })

    if (result.blocked) {
      throw new Error(result.reason || 'Command blocked by Rust safety policy')
    }

    return unwrapCommandOutput([result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : ''))
  }
}

export const workspaceService = new WorkspaceService()
