import fs from 'fs'
import path from 'path'
import axios from 'axios'
import { BrowserWindow } from 'electron'
import { getDb, generateId } from '../../database/database'
import { ftpService } from './ftp.service'
import { sftpService } from './sftp.service'
import { modSyncService } from './mod-sync.service'
import { logService } from './log.service'
import { sanitizeHost } from './net-util'
import type {
  GameServer,
  Mod,
  DownloadItem,
  DownloadProgress,
  AppSettings
} from '../../src/shared/types'

const MAX_CONCURRENT = 3
const MOVE_RETRY_DELAYS_MS = [250, 500, 1000, 2000]

export class DownloadService {
  private queue: DownloadItem[] = []
  private active = new Map<string, AbortController>()

  async downloadMod(
    mod: Mod,
    server: GameServer,
    settings: AppSettings
  ): Promise<void> {
    const existing = this.queue.find((d) => d.modId === mod.id)
    if (existing && (existing.status === 'downloading' || existing.status === 'pending')) return

    const item: DownloadItem = {
      id: generateId(),
      modId: mod.id,
      fileName: mod.fileName,
      serverId: server.id,
      totalSize: mod.serverSize || 0,
      downloadedSize: 0,
      speed: 0,
      eta: 0,
      status: 'pending',
      progress: 0,
      startedAt: new Date().toISOString()
    }

    this.queue.push(item)
    this.saveDownload(item)
    this.broadcastQueue()
    this.processQueue(server, settings)
  }

  async downloadMultiple(
    mods: Mod[],
    server: GameServer,
    settings: AppSettings
  ): Promise<void> {
    for (const mod of mods) {
      await this.downloadMod(mod, server, settings)
    }
  }

  private async processQueue(server: GameServer, settings: AppSettings): Promise<void> {
    const pending = this.queue.filter((d) => d.status === 'pending')
    const activeCount = this.queue.filter((d) => d.status === 'downloading').length

    const slots = MAX_CONCURRENT - activeCount
    const toStart = pending.slice(0, slots)

    for (const item of toStart) {
      this.executeDownload(item, server, settings)
    }
  }

  private async executeDownload(
    item: DownloadItem,
    server: GameServer,
    settings: AppSettings
  ): Promise<void> {
    const modsFolder = settings.modsFolder
    const localPath = path.join(modsFolder, item.fileName)
    const tempPath = `${localPath}.tmp`

    item.status = 'downloading'
    item.startedAt = new Date().toISOString()
    this.updateDownload(item)
    this.broadcastQueue()

    logService.info('DOWNLOAD', `Preuzimanje: ${item.fileName}`)

    const controller = new AbortController()
    this.active.set(item.id, controller)

    let speedInterval: NodeJS.Timeout | null = null
    let lastBytes = 0
    let lastTime = Date.now()

    const updateProgress = (downloaded: number, total: number): void => {
      item.downloadedSize = downloaded
      item.totalSize = total || item.totalSize

      const now = Date.now()
      const elapsed = (now - lastTime) / 1000
      if (elapsed >= 0.5) {
        const bytes = downloaded - lastBytes
        item.speed = Math.round(bytes / elapsed)
        item.eta = item.speed > 0 ? Math.round((total - downloaded) / item.speed) : 0
        lastBytes = downloaded
        lastTime = now
      }

      item.progress = total > 0 ? (downloaded / total) * 100 : 0
      this.broadcastProgress(item)
    }

    try {
      const mod = this.getModById(item.modId)
      const serverPath = mod?.serverPath || ''

      if (serverPath.startsWith('http://') || serverPath.startsWith('https://')) {
        // FS25 web feed (or REST) direct HTTP download. Try stored and authenticated variants.
        await this.downloadViaHttpWithFallbacks(
          this.getHttpDownloadUrls(serverPath, item.fileName, server),
          tempPath,
          server.apiKey,
          updateProgress,
          controller.signal
        )
      } else if (server.connectionType === 'rest' && server.apiUrl) {
        await this.downloadViaHttp(
          `${server.apiUrl}/api/mods/download/${encodeURIComponent(item.fileName)}`,
          tempPath,
          server.apiKey,
          updateProgress,
          controller.signal
        )
      } else if (server.connectionType === 'ftp') {
        if (!serverPath) throw new Error('Server path nije dostupan')
        await ftpService.downloadFile(server, serverPath, tempPath, updateProgress)
      } else if (server.connectionType === 'sftp') {
        if (!serverPath) throw new Error('Server path nije dostupan')
        await sftpService.downloadFile(server, serverPath, tempPath, updateProgress)
      }

      // Verify download integrity
      item.status = 'verifying'
      this.broadcastProgress(item)

      const verifyMod = this.getModById(item.modId)
      const serverHash = verifyMod?.serverHash
      if (serverHash && serverHash.length === 64) {
        // Real reproducible SHA256 (custom REST server) - full checksum validation
        const localHash = await modSyncService.calculateHash(tempPath, 'sha256')
        if (localHash.toLowerCase() !== serverHash.toLowerCase()) {
          fs.unlinkSync(tempPath)
          throw new Error(`Checksum neispravan: ${item.fileName}`)
        }
      } else {
        // FS25 feed hash isn't a reproducible file hash; do a basic sanity check:
        // file must be a non-empty ZIP (PK magic bytes).
        const stat = fs.statSync(tempPath)
        const fd = fs.openSync(tempPath, 'r')
        const magic = Buffer.alloc(2)
        fs.readSync(fd, magic, 0, 2, 0)
        fs.closeSync(fd)
        if (stat.size === 0 || magic[0] !== 0x50 || magic[1] !== 0x4b) {
          fs.unlinkSync(tempPath)
          throw new Error(`Neispravan ili prazan zip: ${item.fileName}`)
        }
      }

      await this.moveDownloadedFile(tempPath, localPath)

      // Remember the server content hash we just downloaded, so this mod is
      // considered in-sync until the server changes it again.
      if (verifyMod?.serverHash) {
        modSyncService.setKnownHash(item.serverId, item.fileName, verifyMod.serverHash)
      }

      item.status = 'completed'
      item.progress = 100
      item.downloadedSize = item.totalSize
      item.completedAt = new Date().toISOString()
      this.updateDownload(item)
      this.broadcastQueue()
      this.active.delete(item.id)
      this.processQueue(server, settings)

      logService.success('DOWNLOAD', `Preuzeto: ${item.fileName}`)
    } catch (err) {
      if (fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath) } catch { /* ignore */ }
      }

      const msg = err instanceof Error ? err.message : 'Greška pri preuzimanju'

      if (msg.includes('abort') || msg.includes('cancel')) {
        item.status = 'paused'
        logService.warning('DOWNLOAD', `Preuzimanje pausirano: ${item.fileName}`)
      } else {
        item.status = 'error'
        item.error = msg
        logService.error('DOWNLOAD', `Greška preuzimanja ${item.fileName}: ${msg}`)
      }

      this.updateDownload(item)
      this.broadcastQueue()
      this.active.delete(item.id)
      this.processQueue(server, settings)
    }
  }

  private async downloadViaHttp(
    url: string,
    localPath: string,
    apiKey: string | undefined,
    onProgress: (downloaded: number, total: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    const res = await axios.get<NodeJS.ReadableStream>(url, {
      responseType: 'stream',
      signal: signal as AbortSignal,
      headers: apiKey ? { 'X-API-Key': apiKey, Authorization: `Bearer ${apiKey}` } : {}
    })

    const totalHeader = res.headers['content-length']
    const total = parseInt(Array.isArray(totalHeader) ? totalHeader[0] : String(totalHeader || '0'), 10)
    let downloaded = 0

    return new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(localPath)

      res.data.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        onProgress(downloaded, total)
      })

      res.data.pipe(writer)
      writer.on('finish', resolve)
      writer.on('error', reject)
      res.data.on('error', reject)
    })
  }

  private async moveDownloadedFile(tempPath: string, localPath: string): Promise<void> {
    const retryableCodes = new Set(['EPERM', 'EACCES', 'EBUSY'])
    let lastError: unknown

    for (let attempt = 0; attempt <= MOVE_RETRY_DELAYS_MS.length; attempt++) {
      try {
        fs.renameSync(tempPath, localPath)
        return
      } catch (err) {
        lastError = err
        const code = (err as NodeJS.ErrnoException).code
        if (!code || !retryableCodes.has(code) || attempt === MOVE_RETRY_DELAYS_MS.length) break
        await this.sleep(MOVE_RETRY_DELAYS_MS[attempt])
      }
    }

    try {
      fs.copyFileSync(tempPath, localPath)
      fs.unlinkSync(tempPath)
      return
    } catch (copyErr) {
      const original = lastError instanceof Error ? lastError.message : String(lastError)
      const fallback = copyErr instanceof Error ? copyErr.message : String(copyErr)
      throw new Error(`Ne mogu spremiti mod u mods folder. Zatvori igru/OneDrive sync i probaj opet. Rename: ${original}; Copy: ${fallback}`)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private async downloadViaHttpWithFallbacks(
    urls: string[],
    localPath: string,
    apiKey: string | undefined,
    onProgress: (downloaded: number, total: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    let lastError: unknown
    for (const url of urls) {
      try {
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath)
        await this.downloadViaHttp(url, localPath, apiKey, onProgress, signal)
        return
      } catch (err) {
        lastError = err
      }
    }
    throw lastError instanceof Error ? lastError : new Error('HTTP download nije uspio')
  }

  private getHttpDownloadUrls(serverPath: string, fileName: string, server: GameServer): string[] {
    const urls = new Set<string>([serverPath])
    const code = (server.webApiCode || '').trim()

    if (code && !serverPath.includes('code=')) {
      const sep = serverPath.includes('?') ? '&' : '?'
      urls.add(`${serverPath}${sep}code=${encodeURIComponent(code)}`)
    }

    if (server.webStatsPort && code) {
      const host = server.ip || sanitizeHost(server.ftpHost)
      const port = server.webStatsPort || 8080
      urls.add(`http://${host}:${port}/mods/${encodeURIComponent(fileName)}?code=${encodeURIComponent(code)}`)
    }

    return [...urls]
  }

  pauseDownload(id: string): void {
    const controller = this.active.get(id)
    if (controller) {
      controller.abort()
    }
  }

  resumeDownload(id: string, server: GameServer, settings: AppSettings): void {
    const item = this.queue.find((d) => d.id === id)
    if (!item) return
    item.status = 'pending'
    item.error = undefined
    this.updateDownload(item)
    this.broadcastQueue()
    this.processQueue(server, settings)
  }

  cancelDownload(id: string): void {
    const controller = this.active.get(id)
    if (controller) controller.abort()

    const idx = this.queue.findIndex((d) => d.id === id)
    if (idx !== -1) this.queue.splice(idx, 1)

    const db = getDb()
    db.prepare('DELETE FROM downloads WHERE id = ?').run(id)
    this.broadcastQueue()
  }

  getQueue(): DownloadItem[] {
    return [...this.queue]
  }

  private getModById(modId: string): Mod | null {
    const db = getDb()
    const row = db.prepare('SELECT * FROM mods WHERE id = ?').get(modId) as Record<string, unknown> | undefined
    if (!row) return null
    return {
      id: row.id as string,
      serverId: row.server_id as string,
      name: row.name as string,
      fileName: row.file_name as string,
      localVersion: row.local_version as string | undefined,
      serverVersion: row.server_version as string | undefined,
      localHash: row.local_hash as string | undefined,
      serverHash: row.server_hash as string | undefined,
      localSize: row.local_size as number | undefined,
      serverSize: row.server_size as number | undefined,
      status: row.status as Mod['status'],
      localPath: row.local_path as string | undefined,
      serverPath: row.server_path as string | undefined,
      lastModified: row.last_modified as string | undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    }
  }

  private saveDownload(item: DownloadItem): void {
    const db = getDb()
    db.prepare(`
      INSERT OR REPLACE INTO downloads (
        id, mod_id, file_name, server_id, total_size, downloaded_size,
        speed, eta, status, progress, error, started_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      item.id, item.modId, item.fileName, item.serverId,
      item.totalSize, item.downloadedSize, item.speed, item.eta,
      item.status, item.progress, item.error ?? null, item.startedAt ?? null
    )
  }

  private updateDownload(item: DownloadItem): void {
    const db = getDb()
    db.prepare(`
      UPDATE downloads SET
        status = ?, progress = ?, downloaded_size = ?, speed = ?,
        eta = ?, error = ?, completed_at = ?
      WHERE id = ?
    `).run(
      item.status, item.progress, item.downloadedSize, item.speed,
      item.eta, item.error ?? null, item.completedAt ?? null, item.id
    )
  }

  private broadcastQueue(): void {
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('download:queue-update', this.queue)
    })
  }

  private broadcastProgress(item: DownloadItem): void {
    const progress: DownloadProgress = {
      id: item.id,
      downloadedSize: item.downloadedSize,
      totalSize: item.totalSize,
      speed: item.speed,
      eta: item.eta,
      progress: item.progress,
      status: item.status
    }
    BrowserWindow.getAllWindows().forEach((win) => {
      win.webContents.send('download:progress', progress)
    })
  }
}

export const downloadService = new DownloadService()
