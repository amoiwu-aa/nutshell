import { ipcMain, shell } from 'electron'
import { sftpManager } from '../ssh/SFTPManager'
import os from 'os'
import type { FSWatcher } from 'chokidar'

const watchers = new Map<string, FSWatcher>()

export function registerSystemHandlers(): void {
    ipcMain.handle('system:openLocalFile', async (_event, filePath: string) => {
        try {
            const result = await shell.openPath(filePath)
            return { success: result === '', error: result || undefined }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })

    ipcMain.handle('system:getTempDir', () => {
        return os.tmpdir()
    })

    ipcMain.handle(
        'system:watchLocalFile',
        async (_event, sessionId: string, localPath: string, remotePath: string) => {
            try {
                // Stop any existing watcher for this path
                const existing = watchers.get(localPath)
                if (existing) {
                    await existing.close()
                    watchers.delete(localPath)
                }

                // Dynamic import to work around ESM-only restriction of chokidar v4
                const { default: chokidar } = await import('chokidar')

                let uploadTimeout: ReturnType<typeof setTimeout> | null = null

                const watcher = chokidar.watch(localPath, {
                    persistent: true,
                    awaitWriteFinish: {
                        stabilityThreshold: 1000,
                        pollInterval: 200
                    }
                })

                watcher.on('change', async () => {
                    if (uploadTimeout) clearTimeout(uploadTimeout)
                    uploadTimeout = setTimeout(async () => {
                        try {
                            console.log(`[FileSync] Detected change on ${localPath}, uploading to ${remotePath}...`)
                            const transferId = `sync_${Date.now()}`
                            await sftpManager.upload(sessionId, localPath, remotePath, transferId)
                            console.log(`[FileSync] Successfully uploaded ${localPath} → ${remotePath}`)
                        } catch (err) {
                            console.error('[FileSync] Upload error:', err)
                        }
                    }, 500)
                })

                watchers.set(localPath, watcher)
                return { success: true }
            } catch (error: any) {
                console.error('[FileSync] Watch error:', error)
                return { success: false, error: error.message }
            }
        }
    )

    ipcMain.handle('system:unwatchLocalFile', async (_event, localPath: string) => {
        try {
            const watcher = watchers.get(localPath)
            if (watcher) {
                await watcher.close()
                watchers.delete(localPath)
            }
            return { success: true }
        } catch (error: any) {
            return { success: false, error: error.message }
        }
    })
}
