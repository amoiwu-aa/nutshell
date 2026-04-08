import { ipcMain } from 'electron'
import { dockerManager } from '../docker/DockerManager'

export function registerDockerHandlers(): void {
  ipcMain.handle('docker:listContainers', async (_event, sessionId: string) => {
    try {
      const containers = await dockerManager.listContainers(sessionId)
      return { success: true, containers }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('docker:listImages', async (_event, sessionId: string) => {
    try {
      const images = await dockerManager.listImages(sessionId)
      return { success: true, images }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'docker:containerAction',
    async (_event, sessionId: string, containerId: string, action: string) => {
      try {
        const result = await dockerManager.containerAction(sessionId, containerId, action as any)
        return { success: true, result }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle(
    'docker:containerLogs',
    async (_event, sessionId: string, containerId: string, options?: any) => {
      try {
        const logs = await dockerManager.containerLogs(sessionId, containerId, options || {})
        return { success: true, logs }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle('docker:startLogStream', async (_event, sessionId: string, containerId: string) => {
    try {
      await dockerManager.streamContainerLogs(sessionId, containerId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('docker:stopLogStream', async (_event, containerId: string) => {
    try {
      dockerManager.stopLogStream(containerId)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'docker:containerExec',
    async (_event, sessionId: string, containerId: string) => {
      try {
        const execSessionId = await dockerManager.containerExec(sessionId, containerId)
        return { success: true, execSessionId }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle('docker:pullImage', async (_event, sessionId: string, image: string) => {
    try {
      const result = await dockerManager.pullImage(sessionId, image)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle('docker:removeImage', async (_event, sessionId: string, imageId: string) => {
    try {
      const result = await dockerManager.removeImage(sessionId, imageId)
      return { success: true, result }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  ipcMain.handle(
    'docker:listContainerFiles',
    async (_event, sessionId: string, containerId: string, containerPath: string) => {
      try {
        const files = await dockerManager.listContainerFiles(sessionId, containerId, containerPath)
        return { success: true, files }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle(
    'docker:copyToContainer',
    async (
      _event,
      sessionId: string,
      containerId: string,
      localPath: string,
      containerPath: string
    ) => {
      try {
        const result = await dockerManager.copyToContainer(
          sessionId,
          containerId,
          localPath,
          containerPath
        )
        return { success: true, result }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  ipcMain.handle(
    'docker:copyFromContainer',
    async (
      _event,
      sessionId: string,
      containerId: string,
      containerPath: string,
      localPath: string
    ) => {
      try {
        const result = await dockerManager.copyFromContainer(
          sessionId,
          containerId,
          containerPath,
          localPath
        )
        return { success: true, result }
      } catch (error: any) {
        return { success: false, error: error.message }
      }
    }
  )

  // Container inspect
  ipcMain.handle('docker:inspectContainer', async (_event, sessionId: string, containerId: string) => {
    try { return { success: true, data: await dockerManager.inspectContainer(sessionId, containerId) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  // Network management
  ipcMain.handle('docker:listNetworks', async (_event, sessionId: string) => {
    try { return { success: true, networks: await dockerManager.listNetworks(sessionId) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('docker:createNetwork', async (_event, sessionId: string, name: string, driver: string, subnet?: string) => {
    try { return { success: true, result: await dockerManager.createNetwork(sessionId, name, driver, subnet) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('docker:removeNetwork', async (_event, sessionId: string, networkId: string) => {
    try { return { success: true, result: await dockerManager.removeNetwork(sessionId, networkId) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('docker:connectNetwork', async (_event, sessionId: string, networkId: string, containerId: string) => {
    try { return { success: true, result: await dockerManager.connectContainerToNetwork(sessionId, networkId, containerId) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('docker:disconnectNetwork', async (_event, sessionId: string, networkId: string, containerId: string) => {
    try { return { success: true, result: await dockerManager.disconnectContainerFromNetwork(sessionId, networkId, containerId) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  // Registry mirrors
  ipcMain.handle('docker:getRegistryMirrors', async (_event, sessionId: string) => {
    try { return { success: true, mirrors: await dockerManager.getRegistryMirrors(sessionId) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('docker:setRegistryMirrors', async (_event, sessionId: string, mirrors: string[]) => {
    try { return { success: true, result: await dockerManager.setRegistryMirrors(sessionId, mirrors) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  // Compose
  ipcMain.handle('docker:listComposeProjects', async (_event, sessionId: string) => {
    try { return { success: true, projects: await dockerManager.listComposeProjects(sessionId) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('docker:composeAction', async (_event, sessionId: string, dir: string, action: string) => {
    try { return { success: true, result: await dockerManager.composeAction(sessionId, dir, action as any) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('docker:getComposeFile', async (_event, sessionId: string, path: string) => {
    try { return { success: true, content: await dockerManager.getComposeFile(sessionId, path) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
  ipcMain.handle('docker:saveComposeFile', async (_event, sessionId: string, path: string, content: string) => {
    try { return { success: true, result: await dockerManager.saveComposeFile(sessionId, path, content) } }
    catch (e: any) { return { success: false, error: e.message } }
  })

  // Create container
  ipcMain.handle('docker:createContainer', async (_event, sessionId: string, options: any) => {
    try { return { success: true, result: await dockerManager.createContainer(sessionId, options) } }
    catch (e: any) { return { success: false, error: e.message } }
  })
}
