import { BrowserWindow } from 'electron'
import { sshManager } from '../ssh/SSHManager'
import { sftpManager } from '../ssh/SFTPManager'
import * as path from 'path'

// --- Input sanitization to prevent command injection ---
const SAFE_DOCKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/
const SAFE_IMAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.\-:/]*$/
const SAFE_PATH = /^[a-zA-Z0-9/_.\-\s]+$/

function validateDockerParam(value: string, pattern: RegExp, label: string): void {
  if (!value || !pattern.test(value)) {
    throw new Error(`Invalid ${label}: "${value}" contains disallowed characters`)
  }
}

function validateNumeric(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${label}: must be a positive number`)
  }
}

export interface ContainerInfo {
  id: string
  name: string
  image: string
  status: string
  state: string
  ports: string
  created: string
  size: string
}

export interface ImageInfo {
  id: string
  repository: string
  tag: string
  size: string
  created: string
}

class DockerManager {
  private logStreams: Map<string, boolean> = new Map() // track active log streams

  async listContainers(sessionId: string): Promise<ContainerInfo[]> {
    const output = await sshManager.exec(
      sessionId,
      'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}|{{.CreatedAt}}|{{.Size}}" 2>&1'
    )

    if (output.includes('command not found') || output.includes('Cannot connect')) {
      throw new Error('Docker is not available on this server')
    }

    const lines = output.trim().split('\n').filter(Boolean)
    return lines.map((line) => {
      const parts = line.split('|')
      return {
        id: parts[0] || '',
        name: parts[1] || '',
        image: parts[2] || '',
        status: parts[3] || '',
        state: parts[4] || '',
        ports: parts[5] || '',
        created: parts[6] || '',
        size: parts[7] || ''
      }
    })
  }

  async listImages(sessionId: string): Promise<ImageInfo[]> {
    const output = await sshManager.exec(
      sessionId,
      'docker images --format "{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedAt}}" 2>&1'
    )

    if (output.includes('command not found')) {
      throw new Error('Docker is not available on this server')
    }

    const lines = output.trim().split('\n').filter(Boolean)
    return lines.map((line) => {
      const parts = line.split('|')
      return {
        id: parts[0] || '',
        repository: parts[1] || '',
        tag: parts[2] || '',
        size: parts[3] || '',
        created: parts[4] || ''
      }
    })
  }

  async containerAction(
    sessionId: string,
    containerId: string,
    action: 'start' | 'stop' | 'restart' | 'remove' | 'pause' | 'unpause'
  ): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')

    const validActions = ['start', 'stop', 'restart', 'remove', 'pause', 'unpause']
    if (!validActions.includes(action)) {
      throw new Error(`Invalid action: ${action}`)
    }

    const cmd =
      action === 'remove'
        ? `docker rm -f "${containerId}"`
        : `docker ${action} "${containerId}"`

    return sshManager.exec(sessionId, `${cmd} 2>&1`)
  }

  async containerLogs(
    sessionId: string,
    containerId: string,
    options: { tail?: number | 'all'; since?: string; until?: string } = {}
  ): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')

    const { tail = 500, since, until } = options

    let cmd = 'docker logs'

    if (tail === 'all') {
      // No --tail flag means all logs
    } else {
      const tailNum = typeof tail === 'number' ? tail : 500
      if (!Number.isFinite(tailNum) || tailNum < 0) throw new Error('Invalid tail value')
      cmd += ` --tail ${tailNum}`
    }

    // Validate and add time range - only allow ISO date-like strings
    if (since) {
      const safeSince = since.replace(/[^0-9T:\-Z.+]/g, '')
      cmd += ` --since "${safeSince}"`
    }
    if (until) {
      const safeUntil = until.replace(/[^0-9T:\-Z.+]/g, '')
      cmd += ` --until "${safeUntil}"`
    }

    cmd += ` "${containerId}" 2>&1`

    return sshManager.exec(sessionId, cmd, 60000) // 60s timeout for large logs
  }

  async streamContainerLogs(sessionId: string, containerId: string): Promise<void> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')

    const client = sshManager.getClient(sessionId)
    if (!client) throw new Error('SSH session not found')

    // Stop existing stream
    this.logStreams.set(containerId, false)

    this.logStreams.set(containerId, true)

    client.exec(`docker logs -f --tail 100 "${containerId}" 2>&1`, (err, stream) => {
      if (err) return

      // Isolate stream errors from the SSH client
      stream.on('error', () => {
        this.logStreams.delete(containerId)
        stream.removeAllListeners()
      })

      stream.on('data', (data: Buffer) => {
        if (!this.logStreams.get(containerId)) {
          stream.destroy()
          return
        }
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('docker:logs', containerId, data.toString())
        }
      })

      stream.on('close', () => {
        this.logStreams.delete(containerId)
        stream.removeAllListeners()
      })
    })
  }

  stopLogStream(containerId: string): void {
    this.logStreams.set(containerId, false)
  }

  async pullImage(sessionId: string, image: string): Promise<string> {
    validateDockerParam(image, SAFE_IMAGE_NAME, 'image name')
    return sshManager.exec(sessionId, `docker pull "${image}" 2>&1`, 120000) // 2 min timeout for pull
  }

  async removeImage(sessionId: string, imageId: string): Promise<string> {
    validateDockerParam(imageId, SAFE_DOCKER_ID, 'image ID')
    return sshManager.exec(sessionId, `docker rmi "${imageId}" 2>&1`)
  }

  async containerExec(sessionId: string, containerId: string): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')

    const execSessionId = `docker-exec-${containerId}-${Date.now()}`

    const client = sshManager.getClient(sessionId)
    if (!client) throw new Error('SSH session not found')

    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          reject(err)
          return
        }

        // Register this stream so ssh.write(execSessionId, ...) works from frontend
        sshManager.registerExternalShell(execSessionId, stream)

        // CRITICAL: Capture stream-level errors to prevent them from
        // bubbling up to the SSH client and disconnecting the main session.
        stream.on('error', (streamErr: Error) => {
          // Silently handle - only clean up this exec stream, not the SSH session
          sshManager.closeExternalShell(execSessionId)
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('ssh:error', execSessionId, streamErr.message)
            win.webContents.send('ssh:close', execSessionId)
          }
        })

        // Also catch stderr independently to avoid unhandled error events
        stream.stderr?.on('error', () => { /* swallow stderr pipe errors */ })

        // Send the docker exec command into the shell
        stream.write(`docker exec -it "${containerId}" /bin/sh -c 'if command -v bash > /dev/null; then bash; else sh; fi'\n`)

        // Forward data to frontend using the execSessionId
        stream.on('data', (data: Buffer) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('ssh:data', execSessionId, data.toString('utf-8'))
          }
        })

        stream.on('close', () => {
          // Only clean up this external shell - do NOT touch the main SSH session
          sshManager.closeExternalShell(execSessionId)
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('ssh:close', execSessionId)
          }
        })

        resolve(execSessionId)
      })
    })
  }

  // --- Container file operations ---

  async listContainerFiles(
    sessionId: string,
    containerId: string,
    containerPath: string
  ): Promise<Array<{
    filename: string
    isDirectory: boolean
    size: number
    permissions: string
    mtime: string
  }>> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    if (!containerPath || containerPath.includes('\0')) {
      throw new Error('Invalid container path')
    }

    // Use docker exec ls -la to list files inside container
    const safePath = containerPath.replace(/"/g, '\\"')
    const output = await sshManager.exec(
      sessionId,
      `docker exec "${containerId}" ls -la --time-style=long-iso "${safePath}" 2>&1`,
      15000
    )

    if (output.includes('No such file or directory')) {
      throw new Error(`Path not found: ${containerPath}`)
    }
    if (output.includes('cannot access') || output.includes('Permission denied')) {
      throw new Error(`Permission denied: ${containerPath}`)
    }

    const lines = output.trim().split('\n')
    const files: Array<{
      filename: string
      isDirectory: boolean
      size: number
      permissions: string
      mtime: string
    }> = []

    for (const line of lines) {
      // Skip total line and . / ..
      if (line.startsWith('total ') || !line.trim()) continue

      // Parse ls -la output: permissions links owner group size date time name
      const parts = line.split(/\s+/)
      if (parts.length < 8) continue

      const perms = parts[0]
      const filename = parts.slice(7).join(' ')
      if (filename === '.' || filename === '..') continue

      const isDirectory = perms.startsWith('d')
      const size = parseInt(parts[4]) || 0
      const mtime = `${parts[5]} ${parts[6]}`

      files.push({
        filename,
        isDirectory,
        size,
        permissions: perms,
        mtime
      })
    }

    // Sort: directories first
    files.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.filename.localeCompare(b.filename)
    })

    return files
  }

  async copyToContainer(
    sessionId: string,
    containerId: string,
    localPath: string,
    containerPath: string
  ): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    if (!containerPath || containerPath.includes('\0')) {
      throw new Error('Invalid container path')
    }

    // Step 1: Upload local file to remote server temp directory via SFTP
    const tempDir = '/tmp/supershell-transfer'
    const filename = path.basename(localPath)
    const remoteTempPath = `${tempDir}/${filename}`

    await sshManager.exec(sessionId, `mkdir -p "${tempDir}"`)
    await sftpManager.upload(sessionId, localPath, remoteTempPath)

    // Step 2: docker cp from remote temp to container
    const safeContainerPath = containerPath.replace(/"/g, '\\"')
    const result = await sshManager.exec(
      sessionId,
      `docker cp "${remoteTempPath}" "${containerId}:${safeContainerPath}" 2>&1`
    )

    // Step 3: Clean up temp file
    await sshManager.exec(sessionId, `rm -f "${remoteTempPath}"`)

    return result
  }

  async copyFromContainer(
    sessionId: string,
    containerId: string,
    containerPath: string,
    localPath: string
  ): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    if (!containerPath || containerPath.includes('\0')) {
      throw new Error('Invalid container path')
    }

    // Step 1: docker cp from container to remote server temp
    const tempDir = '/tmp/supershell-transfer'
    const filename = path.basename(containerPath)
    const remoteTempPath = `${tempDir}/${filename}`

    await sshManager.exec(sessionId, `mkdir -p "${tempDir}"`)

    const safeContainerPath = containerPath.replace(/"/g, '\\"')
    const result = await sshManager.exec(
      sessionId,
      `docker cp "${containerId}:${safeContainerPath}" "${remoteTempPath}" 2>&1`
    )

    if (result.includes('No such') || result.includes('Error')) {
      throw new Error(result.trim())
    }

    // Step 2: Download from remote temp to local via SFTP
    await sftpManager.download(sessionId, remoteTempPath, localPath)

    // Step 3: Clean up temp file
    await sshManager.exec(sessionId, `rm -f "${remoteTempPath}"`)

    return 'ok'
  }

  // ========== CONTAINER INSPECT ==========
  async inspectContainer(sessionId: string, containerId: string): Promise<any> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    const output = await sshManager.exec(sessionId, `docker inspect "${containerId}" 2>&1`, 15000)
    try {
      const data = JSON.parse(output)
      return data[0] || {}
    } catch {
      throw new Error('Failed to parse container inspect data')
    }
  }

  // ========== NETWORK MANAGEMENT ==========
  async listNetworks(sessionId: string): Promise<any[]> {
    const output = await sshManager.exec(sessionId,
      'docker network ls --format "{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}" 2>&1')
    if (output.includes('command not found')) throw new Error('Docker not available')
    return output.trim().split('\n').filter(Boolean).map((line) => {
      const p = line.split('|')
      return { id: p[0]||'', name: p[1]||'', driver: p[2]||'', scope: p[3]||'' }
    })
  }

  async createNetwork(sessionId: string, name: string, driver: string = 'bridge', subnet?: string): Promise<string> {
    validateDockerParam(name, SAFE_DOCKER_ID, 'network name')
    let cmd = `docker network create --driver "${driver}" `
    if (subnet) { cmd += `--subnet "${subnet.replace(/[^0-9./]/g, '')}" ` }
    cmd += `"${name}" 2>&1`
    return sshManager.exec(sessionId, cmd)
  }

  async removeNetwork(sessionId: string, networkId: string): Promise<string> {
    validateDockerParam(networkId, SAFE_DOCKER_ID, 'network ID')
    return sshManager.exec(sessionId, `docker network rm "${networkId}" 2>&1`)
  }

  async connectContainerToNetwork(sessionId: string, networkId: string, containerId: string): Promise<string> {
    validateDockerParam(networkId, SAFE_DOCKER_ID, 'network ID')
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    return sshManager.exec(sessionId, `docker network connect "${networkId}" "${containerId}" 2>&1`)
  }

  async disconnectContainerFromNetwork(sessionId: string, networkId: string, containerId: string): Promise<string> {
    validateDockerParam(networkId, SAFE_DOCKER_ID, 'network ID')
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    return sshManager.exec(sessionId, `docker network disconnect "${networkId}" "${containerId}" 2>&1`)
  }

  // ========== REGISTRY MIRRORS ==========
  async getRegistryMirrors(sessionId: string): Promise<string[]> {
    const output = await sshManager.exec(sessionId,
      'cat /etc/docker/daemon.json 2>/dev/null || echo "{}"')
    try {
      const config = JSON.parse(output.trim())
      return config['registry-mirrors'] || []
    } catch { return [] }
  }

  async setRegistryMirrors(sessionId: string, mirrors: string[]): Promise<string> {
    // Read existing config, update mirrors, write back
    const output = await sshManager.exec(sessionId, 'cat /etc/docker/daemon.json 2>/dev/null || echo "{}"')
    let config: any = {}
    try { config = JSON.parse(output.trim()) } catch {}
    config['registry-mirrors'] = mirrors

    const json = JSON.stringify(config, null, 2).replace(/'/g, "'\\''")
    const result = await sshManager.exec(sessionId,
      `echo '${json}' | sudo tee /etc/docker/daemon.json 2>&1`)
    return result
  }

  // ========== DOCKER COMPOSE ==========
  async listComposeProjects(sessionId: string): Promise<any[]> {
    // Try JSON format first (most reliable)
    const output = await sshManager.exec(sessionId,
      'docker compose ls --format json 2>&1', 15000)
    if (output.includes('command not found') || output.includes('not a docker command')) {
      return []
    }

    // Try parsing as JSON array
    try {
      const parsed = JSON.parse(output.trim())
      if (Array.isArray(parsed)) {
        return parsed.map((p: any) => ({
          name: p.Name || p.name || '',
          status: p.Status || p.status || '',
          configFiles: p.ConfigFiles || p.configFiles || ''
        }))
      }
    } catch {
      // JSON parse failed, try parsing as JSON-lines (one JSON per line)
      try {
        return output.trim().split('\n').filter(Boolean).map((line) => {
          const p = JSON.parse(line)
          return { name: p.Name || '', status: p.Status || '', configFiles: p.ConfigFiles || '' }
        })
      } catch {
        // Fall back to table parsing
        const lines = output.trim().split('\n')
        return lines.slice(1).filter((l) => l.trim()).map((line) => {
          const parts = line.split(/\s{2,}/)
          return { name: parts[0]||'', status: parts[1]||'', configFiles: parts[2]||'' }
        })
      }
    }

    return []
  }

  async composeAction(sessionId: string, projectDir: string, action: 'up' | 'down' | 'restart'): Promise<string> {
    const safeDir = projectDir.replace(/"/g, '\\"')
    const cmd = action === 'up'
      ? `cd "${safeDir}" && docker compose up -d 2>&1`
      : action === 'down'
        ? `cd "${safeDir}" && docker compose down 2>&1`
        : `cd "${safeDir}" && docker compose restart 2>&1`
    return sshManager.exec(sessionId, cmd, 60000)
  }

  async getComposeFile(sessionId: string, filePath: string): Promise<string> {
    const safePath = filePath.replace(/"/g, '\\"')
    return sshManager.exec(sessionId, `cat "${safePath}" 2>&1`, 10000)
  }

  async saveComposeFile(sessionId: string, filePath: string, content: string): Promise<string> {
    const safePath = filePath.replace(/"/g, '\\"')
    // Use heredoc to write file content safely
    const escaped = content.replace(/\\/g, '\\\\').replace(/'/g, "'\\''")
    return sshManager.exec(sessionId, `cat > "${safePath}" << 'SUPERSHELL_EOF'\n${content}\nSUPERSHELL_EOF`, 10000)
  }

  // ========== CREATE CONTAINER ==========
  async createContainer(sessionId: string, options: {
    image: string; name?: string; ports?: string[]; volumes?: string[];
    envVars?: string[]; network?: string; restartPolicy?: string;
  }): Promise<string> {
    validateDockerParam(options.image, SAFE_IMAGE_NAME, 'image name')

    let cmd = 'docker run -d'
    if (options.name) { validateDockerParam(options.name, SAFE_DOCKER_ID, 'container name'); cmd += ` --name "${options.name}"` }
    if (options.restartPolicy) { cmd += ` --restart "${options.restartPolicy}"` }
    if (options.network) { validateDockerParam(options.network, SAFE_DOCKER_ID, 'network'); cmd += ` --network "${options.network}"` }
    for (const p of options.ports || []) { cmd += ` -p "${p.replace(/"/g, '')}"` }
    for (const v of options.volumes || []) { cmd += ` -v "${v.replace(/"/g, '')}"` }
    for (const e of options.envVars || []) { cmd += ` -e "${e.replace(/"/g, '')}"` }
    cmd += ` "${options.image}" 2>&1`

    return sshManager.exec(sessionId, cmd, 60000)
  }
}

export const dockerManager = new DockerManager()
