import { BrowserWindow } from 'electron'
import { sshManager } from '../ssh/SSHManager'
import { sftpManager } from '../ssh/SFTPManager'
import { rustCoreService } from '../rust/RustCoreService'
import { rustRemoteFS } from '../rust/RustRemoteFS'
import * as path from 'path'

const SAFE_DOCKER_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/
const SAFE_IMAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.\-:/]*$/
const NETWORK_DRIVERS = ['bridge', 'host', 'overlay', 'macvlan', 'ipvlan', 'none']
const RESTART_POLICIES = /^(no|always|unless-stopped|on-failure(:\d+)?)$/

function validateDockerParam(value: string, pattern: RegExp, label: string): void {
  if (!value || !pattern.test(value)) {
    throw new Error(`Invalid ${label}: "${value}" contains disallowed characters`)
  }
}

function isRustSession(sessionId: string): boolean {
  return rustCoreService.hasSshSession(sessionId)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// Short, collision-resistant prefix for per-transfer temp file names.
function uniqueTempPrefix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

export interface NetworkInfo {
  id: string
  name: string
  driver: string
  scope: string
}

export interface DockerOverview {
  containers: ContainerInfo[]
  images: ImageInfo[]
  networks: NetworkInfo[]
}

// Centralized list commands so single-resource and batched `overview` calls
// always use identical formatting (and stay in sync).
const CMD_LIST_CONTAINERS =
  'docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.State}}|{{.Ports}}|{{.CreatedAt}}|{{.Size}}" 2>&1'
const CMD_LIST_IMAGES =
  'docker images --format "{{.ID}}|{{.Repository}}|{{.Tag}}|{{.Size}}|{{.CreatedAt}}" 2>&1'
const CMD_LIST_NETWORKS =
  'docker network ls --format "{{.ID}}|{{.Name}}|{{.Driver}}|{{.Scope}}" 2>&1'
// Marker used to split a single batched exec into per-resource sections.
const OVERVIEW_SEP = '__NUTSHELL_DOCKER_SEP__'

class DockerManager {
  private activeLogStreams = new Map<string, string>()

  private static dockerUnavailable(output: string): boolean {
    return output.includes('command not found') || output.includes('Cannot connect to the Docker daemon')
  }

  private parseContainers(output: string): ContainerInfo[] {
    return output.trim().split('\n').filter(Boolean).map((line) => {
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

  private parseImages(output: string): ImageInfo[] {
    return output.trim().split('\n').filter(Boolean).map((line) => {
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

  private parseNetworks(output: string): NetworkInfo[] {
    return output.trim().split('\n').filter(Boolean).map((line) => {
      const parts = line.split('|')
      return { id: parts[0] || '', name: parts[1] || '', driver: parts[2] || '', scope: parts[3] || '' }
    })
  }

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
      throw new Error(result.reason || 'Docker command blocked by Rust safety policy')
    }
    return [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? '\n' : '')
  }

  async listContainers(sessionId: string): Promise<ContainerInfo[]> {
    const output = await this.exec(sessionId, CMD_LIST_CONTAINERS)
    if (DockerManager.dockerUnavailable(output)) {
      throw new Error('Docker is not available on this server')
    }
    return this.parseContainers(output)
  }

  async listImages(sessionId: string): Promise<ImageInfo[]> {
    const output = await this.exec(sessionId, CMD_LIST_IMAGES)
    if (DockerManager.dockerUnavailable(output)) {
      throw new Error('Docker is not available on this server')
    }
    return this.parseImages(output)
  }

  /**
   * Fetch containers, images and networks in a single SSH/exec round-trip.
   * Collapses three sequential channel-opening commands into one, which both
   * speeds up first paint of the Docker panel and reduces SSH channel churn.
   */
  async getOverview(sessionId: string): Promise<DockerOverview> {
    const command = [CMD_LIST_CONTAINERS, CMD_LIST_IMAGES, CMD_LIST_NETWORKS].join(
      ` ; echo "${OVERVIEW_SEP}" ; `
    )
    const output = await this.exec(sessionId, command, 30000)
    if (DockerManager.dockerUnavailable(output)) {
      throw new Error('Docker is not available on this server')
    }
    const [containersPart = '', imagesPart = '', networksPart = ''] = output.split(OVERVIEW_SEP)
    return {
      containers: this.parseContainers(containersPart),
      images: this.parseImages(imagesPart),
      networks: this.parseNetworks(networksPart)
    }
  }

  async containerAction(sessionId: string, containerId: string, action: string): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    if (action.startsWith('exec|')) {
      // Keep everything after the marker: the command may itself contain '|'.
      const execCmd = action.slice('exec|'.length)
      return this.exec(sessionId, `docker exec -i ${shellQuote(containerId)} sh -c ${shellQuote(execCmd)} 2>&1`)
    }
    const validActions = ['start', 'stop', 'restart', 'remove', 'pause', 'unpause']
    if (!validActions.includes(action)) {
      throw new Error(`Invalid action: ${action}`)
    }
    const cmd = action === 'remove' ? `docker rm -f "${containerId}"` : `docker ${action} "${containerId}"`
    return this.exec(sessionId, `${cmd} 2>&1`)
  }

  async containerLogs(sessionId: string, containerId: string, options: { tail?: number | 'all'; since?: string; until?: string } = {}): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    const { tail = 500, since, until } = options
    let cmd = 'docker logs'
    if (tail !== 'all') {
      const tailNum = typeof tail === 'number' ? tail : 500
      if (!Number.isFinite(tailNum) || tailNum < 0) throw new Error('Invalid tail value')
      cmd += ` --tail ${tailNum}`
    }
    if (since) cmd += ` --since "${since.replace(/[^0-9T:\-Z.+]/g, '')}"`
    if (until) cmd += ` --until "${until.replace(/[^0-9T:\-Z.+]/g, '')}"`
    cmd += ` "${containerId}" 2>&1`
    return this.exec(sessionId, cmd, 60000)
  }

  async streamContainerLogs(_sessionId: string, _containerId: string): Promise<void> {
    if (!isRustSession(_sessionId)) {
      throw new Error('Streaming container logs is not implemented for the current backend')
    }

    const result = await rustCoreService.startDockerLogStream({
      sessionId: _sessionId,
      containerId: _containerId,
      tail: '200'
    })
    this.activeLogStreams.set(_containerId, result.streamId)
  }

  stopLogStream(_containerId: string): void {
    const streamId = this.activeLogStreams.get(_containerId)
    if (streamId) {
      this.activeLogStreams.delete(_containerId)
      rustCoreService.stopDockerLogStream(streamId).catch(() => {})
    }
  }

  async pullImage(sessionId: string, image: string): Promise<string> {
    validateDockerParam(image, SAFE_IMAGE_NAME, 'image name')
    return this.exec(sessionId, `docker pull "${image}" 2>&1`, 120000)
  }

  async removeImage(sessionId: string, imageId: string): Promise<string> {
    validateDockerParam(imageId, SAFE_DOCKER_ID, 'image ID')
    return this.exec(sessionId, `docker rmi "${imageId}" 2>&1`)
  }

  async containerExec(sessionId: string, containerId: string): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    if (isRustSession(sessionId)) {
      const result = await rustCoreService.startDockerExec(sessionId, containerId)
      return result.execSessionId
    }

    const execSessionId = `docker-exec-${containerId}-${Date.now()}`
    const client = sshManager.getClient(sessionId)
    if (!client) throw new Error('SSH session not found')

    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color' }, (err, stream) => {
        if (err) {
          reject(err)
          return
        }

        sshManager.registerExternalShell(execSessionId, stream)

        stream.on('error', (streamErr: Error) => {
          sshManager.closeExternalShell(execSessionId)
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('ssh:error', execSessionId, streamErr.message)
            win.webContents.send('ssh:close', execSessionId)
          }
        })

        stream.stderr?.on('error', () => {})
        stream.write(`docker exec -it "${containerId}" /bin/sh -c 'if command -v bash > /dev/null; then bash; else sh; fi'\n`)

        stream.on('data', (data: Buffer) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('ssh:data', execSessionId, data.toString('utf-8'))
          }
        })

        stream.on('close', () => {
          sshManager.closeExternalShell(execSessionId)
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('ssh:close', execSessionId)
          }
        })

        resolve(execSessionId)
      })
    })
  }

  async listContainerFiles(sessionId: string, containerId: string, containerPath: string): Promise<Array<{ filename: string; isDirectory: boolean; size: number; permissions: string; mtime: string }>> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    if (!containerPath || containerPath.includes('\0')) {
      throw new Error('Invalid container path')
    }

    const output = await this.exec(sessionId, `docker exec ${shellQuote(containerId)} ls -la --time-style=long-iso ${shellQuote(containerPath)} 2>&1`, 15000)

    if (output.includes('No such file or directory')) {
      throw new Error(`Path not found: ${containerPath}`)
    }
    if (output.includes('cannot access') || output.includes('Permission denied')) {
      throw new Error(`Permission denied: ${containerPath}`)
    }

    const files: Array<{ filename: string; isDirectory: boolean; size: number; permissions: string; mtime: string }> = []
    for (const line of output.trim().split('\n')) {
      if (line.startsWith('total ') || !line.trim()) continue
      const parts = line.split(/\s+/)
      if (parts.length < 8) continue
      const perms = parts[0]
      const filename = parts.slice(7).join(' ')
      if (filename === '.' || filename === '..') continue
      files.push({
        filename,
        isDirectory: perms.startsWith('d'),
        size: parseInt(parts[4]) || 0,
        permissions: perms,
        mtime: `${parts[5]} ${parts[6]}`
      })
    }

    files.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1
      if (!a.isDirectory && b.isDirectory) return 1
      return a.filename.localeCompare(b.filename)
    })

    return files
  }

  async copyToContainer(sessionId: string, containerId: string, localPath: string, containerPath: string): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    if (!containerPath || containerPath.includes('\0')) {
      throw new Error('Invalid container path')
    }

    const tempDir = '/tmp/nutshell-transfer'
    const filename = path.basename(localPath)
    // Unique prefix prevents concurrent transfers of same-named files from
    // clobbering each other's temp file.
    const remoteTempPath = `${tempDir}/${uniqueTempPrefix()}-${filename}`

    await this.exec(sessionId, `mkdir -p ${shellQuote(tempDir)}`)
    if (isRustSession(sessionId)) {
      await rustRemoteFS.upload(sessionId, localPath, remoteTempPath)
    } else {
      await sftpManager.upload(sessionId, localPath, remoteTempPath)
    }

    const result = await this.exec(sessionId, `docker cp ${shellQuote(remoteTempPath)} ${shellQuote(`${containerId}:${containerPath}`)} 2>&1`)
    await this.exec(sessionId, `rm -f ${shellQuote(remoteTempPath)}`)
    return result
  }

  async copyFromContainer(sessionId: string, containerId: string, containerPath: string, localPath: string): Promise<string> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    if (!containerPath || containerPath.includes('\0')) {
      throw new Error('Invalid container path')
    }

    const tempDir = '/tmp/nutshell-transfer'
    const filename = path.basename(containerPath)
    const remoteTempPath = `${tempDir}/${uniqueTempPrefix()}-${filename}`

    await this.exec(sessionId, `mkdir -p ${shellQuote(tempDir)}`)
    const result = await this.exec(sessionId, `docker cp ${shellQuote(`${containerId}:${containerPath}`)} ${shellQuote(remoteTempPath)} 2>&1`)
    if (result.includes('No such') || result.includes('Error')) {
      throw new Error(result.trim())
    }

    if (isRustSession(sessionId)) {
      await rustRemoteFS.download(sessionId, remoteTempPath, localPath)
    } else {
      await sftpManager.download(sessionId, remoteTempPath, localPath)
    }
    await this.exec(sessionId, `rm -f "${remoteTempPath}"`)
    return 'ok'
  }

  async inspectContainer(sessionId: string, containerId: string): Promise<any> {
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    const output = await this.exec(sessionId, `docker inspect "${containerId}" 2>&1`, 15000)
    try {
      const data = JSON.parse(output)
      return data[0] || {}
    } catch {
      throw new Error('Failed to parse container inspect data')
    }
  }

  async listNetworks(sessionId: string): Promise<NetworkInfo[]> {
    const output = await this.exec(sessionId, CMD_LIST_NETWORKS)
    if (DockerManager.dockerUnavailable(output)) throw new Error('Docker not available')
    return this.parseNetworks(output)
  }

  async createNetwork(sessionId: string, name: string, driver: string = 'bridge', subnet?: string): Promise<string> {
    validateDockerParam(name, SAFE_DOCKER_ID, 'network name')
    if (!NETWORK_DRIVERS.includes(driver)) {
      throw new Error(`Invalid network driver: "${driver}"`)
    }
    let cmd = `docker network create --driver ${shellQuote(driver)} `
    if (subnet) cmd += `--subnet ${shellQuote(subnet.replace(/[^0-9./]/g, ''))} `
    cmd += `${shellQuote(name)} 2>&1`
    return this.exec(sessionId, cmd)
  }

  async removeNetwork(sessionId: string, networkId: string): Promise<string> {
    validateDockerParam(networkId, SAFE_DOCKER_ID, 'network ID')
    return this.exec(sessionId, `docker network rm ${shellQuote(networkId)} 2>&1`)
  }

  async connectContainerToNetwork(sessionId: string, networkId: string, containerId: string): Promise<string> {
    validateDockerParam(networkId, SAFE_DOCKER_ID, 'network ID')
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    return this.exec(sessionId, `docker network connect "${networkId}" "${containerId}" 2>&1`)
  }

  async disconnectContainerFromNetwork(sessionId: string, networkId: string, containerId: string): Promise<string> {
    validateDockerParam(networkId, SAFE_DOCKER_ID, 'network ID')
    validateDockerParam(containerId, SAFE_DOCKER_ID, 'container ID')
    return this.exec(sessionId, `docker network disconnect "${networkId}" "${containerId}" 2>&1`)
  }

  async getRegistryMirrors(sessionId: string): Promise<string[]> {
    const output = await this.exec(sessionId, 'cat /etc/docker/daemon.json 2>/dev/null || echo "{}"')
    try {
      const config = JSON.parse(output.trim())
      return config['registry-mirrors'] || []
    } catch {
      return []
    }
  }

  async setRegistryMirrors(sessionId: string, mirrors: string[]): Promise<string> {
    const output = await this.exec(sessionId, 'cat /etc/docker/daemon.json 2>/dev/null || echo "{}"')
    let config: any = {}
    try { config = JSON.parse(output.trim()) } catch {}
    config['registry-mirrors'] = mirrors

    // Back up the existing daemon.json (if present) before overwriting, so a bad
    // merge or conflict with config-management can be rolled back.
    await this.exec(
      sessionId,
      `[ -f /etc/docker/daemon.json ] && sudo cp -a /etc/docker/daemon.json /etc/docker/daemon.json.nutshell.bak || true`,
      15000,
      true
    ).catch(() => { /* best-effort backup */ })

    return this.exec(sessionId, `echo ${shellQuote(JSON.stringify(config, null, 2))} | sudo tee /etc/docker/daemon.json 2>&1`, 30000, true)
  }

  async listComposeProjects(sessionId: string): Promise<any[]> {
    const output = await this.exec(sessionId, 'docker compose ls --format json 2>&1', 15000)
    if (output.includes('command not found') || output.includes('not a docker command')) {
      return []
    }

    try {
      const parsed = JSON.parse(output.trim())
      if (Array.isArray(parsed)) {
        return parsed.map((project: any) => ({
          name: project.Name || project.name || '',
          status: project.Status || project.status || '',
          configFiles: project.ConfigFiles || project.configFiles || ''
        }))
      }
    } catch {
      try {
        return output.trim().split('\n').filter(Boolean).map((line) => {
          const project = JSON.parse(line)
          return { name: project.Name || '', status: project.Status || '', configFiles: project.ConfigFiles || '' }
        })
      } catch {
        const lines = output.trim().split('\n')
        return lines.slice(1).filter((line) => line.trim()).map((line) => {
          const parts = line.split(/\s{2,}/)
          return { name: parts[0] || '', status: parts[1] || '', configFiles: parts[2] || '' }
        })
      }
    }

    return []
  }

  async composeAction(sessionId: string, projectDir: string, action: 'up' | 'down' | 'restart'): Promise<string> {
    const cmd = action === 'up'
      ? `cd ${shellQuote(projectDir)} && docker compose up -d 2>&1`
      : action === 'down'
        ? `cd ${shellQuote(projectDir)} && docker compose down 2>&1`
        : `cd ${shellQuote(projectDir)} && docker compose restart 2>&1`
    return this.exec(sessionId, cmd, 60000)
  }

  async getComposeFile(sessionId: string, filePath: string): Promise<string> {
    if (isRustSession(sessionId)) {
      return rustRemoteFS.readFile(sessionId, filePath)
    }
    return sshManager.exec(sessionId, `cat ${shellQuote(filePath)} 2>&1`, 10000)
  }

  async saveComposeFile(sessionId: string, filePath: string, content: string): Promise<string> {
    if (isRustSession(sessionId)) {
      await rustRemoteFS.writeFile(sessionId, filePath, content)
      return 'ok'
    }

    // base64 keeps the file content out of the shell entirely — a heredoc breaks
    // apart as soon as the content happens to contain the delimiter line.
    const encoded = Buffer.from(content, 'utf8').toString('base64')
    return sshManager.exec(
      sessionId,
      `printf '%s' ${shellQuote(encoded)} | base64 -d > ${shellQuote(filePath)}`,
      10000
    )
  }

  async createContainer(sessionId: string, options: { image: string; name?: string; ports?: string[]; volumes?: string[]; envVars?: string[]; network?: string; restartPolicy?: string }): Promise<string> {
    validateDockerParam(options.image, SAFE_IMAGE_NAME, 'image name')

    let cmd = 'docker run -d'
    if (options.name) { validateDockerParam(options.name, SAFE_DOCKER_ID, 'container name'); cmd += ` --name ${shellQuote(options.name)}` }
    if (options.restartPolicy) {
      if (!RESTART_POLICIES.test(options.restartPolicy)) {
        throw new Error(`Invalid restart policy: "${options.restartPolicy}"`)
      }
      cmd += ` --restart ${shellQuote(options.restartPolicy)}`
    }
    if (options.network) { validateDockerParam(options.network, SAFE_DOCKER_ID, 'network'); cmd += ` --network ${shellQuote(options.network)}` }
    for (const portMapping of options.ports || []) cmd += ` -p ${shellQuote(portMapping)}`
    for (const volume of options.volumes || []) cmd += ` -v ${shellQuote(volume)}`
    for (const envVar of options.envVars || []) cmd += ` -e ${shellQuote(envVar)}`
    cmd += ` ${shellQuote(options.image)} 2>&1`

    return this.exec(sessionId, cmd, 60000)
  }
}

export const dockerManager = new DockerManager()
