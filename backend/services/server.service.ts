import net from 'net'
import { getDb, generateId } from '../../database/database'
import { restApiService } from './rest-api.service'
import { ftpService } from './ftp.service'
import { sftpService } from './sftp.service'
import { logService } from './log.service'
import { resolveHost } from './net-util'
import { fsStatsService } from './fs-stats.service'
import type { GameServer, ServerPingResult, ServerStatus } from '../../src/shared/types'

function rowToServer(row: Record<string, unknown>): GameServer {
  return {
    id: row.id as string,
    name: row.name as string,
    ip: row.ip as string,
    port: row.port as number,
    status: row.status as ServerStatus,
    players: row.players as number,
    maxPlayers: row.max_players as number,
    map: row.map as string,
    version: row.version as string,
    ping: row.ping as number,
    isActive: (row.is_active as number) === 1,
    connectionType: row.connection_type as GameServer['connectionType'],
    ftpHost: row.ftp_host as string | undefined,
    ftpPort: row.ftp_port as number | undefined,
    ftpUsername: row.ftp_username as string | undefined,
    ftpPassword: row.ftp_password as string | undefined,
    ftpPath: row.ftp_path as string | undefined,
    sftpHost: row.sftp_host as string | undefined,
    sftpPort: row.sftp_port as number | undefined,
    sftpUsername: row.sftp_username as string | undefined,
    sftpPassword: row.sftp_password as string | undefined,
    sftpPath: row.sftp_path as string | undefined,
    apiUrl: row.api_url as string | undefined,
    apiKey: row.api_key as string | undefined,
    webStatsPort: row.web_stats_port as number | undefined,
    webApiCode: row.web_api_code as string | undefined,
    lastSync: row.last_sync as string | undefined,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string
  }
}

export function getAllServers(): GameServer[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM servers ORDER BY is_active DESC, name ASC').all()
  return (rows as Record<string, unknown>[]).map(rowToServer)
}

export function getActiveServer(): GameServer | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM servers WHERE is_active = 1 LIMIT 1').get()
  return row ? rowToServer(row as Record<string, unknown>) : null
}

export function addServer(data: Omit<GameServer, 'id' | 'createdAt' | 'updatedAt'>): GameServer {
  const db = getDb()
  const id = generateId()

  db.prepare(`
    INSERT INTO servers (
      id, name, ip, port, status, players, max_players, map, version, ping,
      is_active, connection_type,
      ftp_host, ftp_port, ftp_username, ftp_password, ftp_path,
      sftp_host, sftp_port, sftp_username, sftp_password, sftp_path,
      api_url, api_key, web_stats_port, web_api_code
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `).run(
    id, data.name, data.ip || '', data.port || 7777,
    data.status || 'unknown', data.players || 0, data.maxPlayers || 16,
    data.map || '', data.version || '', data.ping || 0,
    data.isActive ? 1 : 0, data.connectionType || 'ftp',
    data.ftpHost || '', data.ftpPort || 21,
    data.ftpUsername || '', data.ftpPassword || '', data.ftpPath || '/mods',
    data.sftpHost || '', data.sftpPort || 22,
    data.sftpUsername || '', data.sftpPassword || '', data.sftpPath || '/mods',
    data.apiUrl || '', data.apiKey || '',
    data.webStatsPort || 8080, data.webApiCode || ''
  )

  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id)
  logService.success('SERVERS', `Dodan server: ${data.name}`)
  return rowToServer(row as Record<string, unknown>)
}

export function updateServer(id: string, data: Partial<GameServer>): GameServer {
  const db = getDb()

  const fields: string[] = []
  const values: unknown[] = []

  const fieldMap: Record<string, string> = {
    name: 'name', ip: 'ip', port: 'port', status: 'status',
    players: 'players', maxPlayers: 'max_players', map: 'map',
    version: 'version', ping: 'ping', isActive: 'is_active',
    connectionType: 'connection_type',
    ftpHost: 'ftp_host', ftpPort: 'ftp_port',
    ftpUsername: 'ftp_username', ftpPassword: 'ftp_password', ftpPath: 'ftp_path',
    sftpHost: 'sftp_host', sftpPort: 'sftp_port',
    sftpUsername: 'sftp_username', sftpPassword: 'sftp_password', sftpPath: 'sftp_path',
    apiUrl: 'api_url', apiKey: 'api_key',
    webStatsPort: 'web_stats_port', webApiCode: 'web_api_code'
  }

  for (const [key, dbCol] of Object.entries(fieldMap)) {
    if (key in data) {
      fields.push(`${dbCol} = ?`)
      let val = (data as Record<string, unknown>)[key]
      if (key === 'isActive') val = val ? 1 : 0
      values.push(val)
    }
  }

  if (fields.length === 0) {
    const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id)
    return rowToServer(row as Record<string, unknown>)
  }

  fields.push("updated_at = datetime('now')")
  values.push(id)

  db.prepare(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`).run(...values)

  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(id)
  return rowToServer(row as Record<string, unknown>)
}

export function deleteServer(id: string): void {
  const db = getDb()
  db.prepare('DELETE FROM servers WHERE id = ?').run(id)
  logService.info('SERVERS', `Obrisan server ID: ${id}`)
}

interface ConfigServer {
  id: string
  name: string
  ip: string
  port: number
  maxPlayers: number
  map?: string
  version?: string
  connectionType: 'ftp' | 'sftp' | 'rest'
  ftpHost?: string
  ftpPort?: number
  ftpUsername?: string
  ftpPassword?: string
  ftpPath?: string
  sftpHost?: string
  sftpPort?: number
  sftpUsername?: string
  sftpPassword?: string
  sftpPath?: string
  apiUrl?: string
  apiKey?: string
  webStatsPort: number
  webApiCode: string
}

/**
 * Upserts servers delivered by the backend /config endpoint (zero-config mode).
 * Keyed by the backend's server id, so re-fetching won't create duplicates and
 * lets the admin change server details centrally. Only non-secret fields are set.
 */
export function upsertServersFromConfig(servers: ConfigServer[]): void {
  if (!servers.length) return
  const db = getDb()
  const existsStmt = db.prepare('SELECT id FROM servers WHERE id = ?')
  const insertStmt = db.prepare(`
    INSERT INTO servers (
      id, name, ip, port, max_players, map, version, connection_type,
      ftp_host, ftp_port, ftp_username, ftp_password, ftp_path,
      sftp_host, sftp_port, sftp_username, sftp_password, sftp_path,
      api_url, api_key, web_stats_port, web_api_code, is_active
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `)
  const updateStmt = db.prepare(`
    UPDATE servers SET
      name = ?, ip = ?, port = ?, max_players = ?, map = ?, version = ?, connection_type = ?,
      ftp_host = ?, ftp_port = ?, ftp_username = ?, ftp_password = ?, ftp_path = ?,
      sftp_host = ?, sftp_port = ?, sftp_username = ?, sftp_password = ?, sftp_path = ?,
      api_url = ?, api_key = ?, web_stats_port = ?, web_api_code = ?, updated_at = datetime('now')
    WHERE id = ?
  `)

  const tx = db.transaction((items: ConfigServer[]) => {
    for (const s of items) {
      const exists = existsStmt.get(s.id)
      if (exists) {
        updateStmt.run(
          s.name, s.ip, s.port, s.maxPlayers, s.map || '', s.version || '', s.connectionType,
          s.ftpHost || '', s.ftpPort || 21, s.ftpUsername || '', s.ftpPassword || '', s.ftpPath || '/mods',
          s.sftpHost || '', s.sftpPort || 22, s.sftpUsername || '', s.sftpPassword || '', s.sftpPath || '/mods',
          s.apiUrl || '', s.apiKey || '', s.webStatsPort || 8080, s.webApiCode || '', s.id
        )
      } else {
        insertStmt.run(
          s.id, s.name, s.ip, s.port, s.maxPlayers, s.map || '', s.version || '', s.connectionType,
          s.ftpHost || '', s.ftpPort || 21, s.ftpUsername || '', s.ftpPassword || '', s.ftpPath || '/mods',
          s.sftpHost || '', s.sftpPort || 22, s.sftpUsername || '', s.sftpPassword || '', s.sftpPath || '/mods',
          s.apiUrl || '', s.apiKey || '', s.webStatsPort || 8080, s.webApiCode || ''
        )
      }
    }
    // Make the local server list match the backend exactly: remove any servers
    // not in the config (e.g. manually-added duplicates). Safe because we only
    // get here with a non-empty config (a failed fetch returns []).
    const keepIds = items.map((s) => s.id)
    const placeholders = keepIds.map(() => '?').join(',')
    db.prepare(`DELETE FROM servers WHERE id NOT IN (${placeholders})`).run(...keepIds)
  })
  tx(servers)

  // Ensure one server is active
  const active = db.prepare('SELECT id FROM servers WHERE is_active = 1').get()
  if (!active && servers[0]) {
    setActiveServer(servers[0].id)
  }

  logService.success('CONFIG', `Sinkronizirano ${servers.length} servera iz configa`)
}

export function setActiveServer(id: string): void {
  const db = getDb()
  db.prepare('UPDATE servers SET is_active = 0').run()
  db.prepare("UPDATE servers SET is_active = 1, updated_at = datetime('now') WHERE id = ?").run(id)
  const server = db.prepare('SELECT name FROM servers WHERE id = ?').get(id) as { name: string } | undefined
  logService.info('SERVERS', `Aktivan server: ${server?.name || id}`)
}

export async function pingServer(server: GameServer): Promise<ServerPingResult> {
  try {
    // Best source: FS25 dedicated server web stats feed (live players/map/version)
    if (server.webStatsPort && server.webApiCode) {
      const stats = await fsStatsService.fetchStats(server)
      if (stats) {
        updateServerStatus(server.id, stats)
        return stats
      }
    }

    if (server.connectionType === 'rest' && server.apiUrl) {
      const result = await restApiService.pingServer(server)
      updateServerStatus(server.id, result)
      return result
    }

    // TCP ping for FTP/SFTP.
    // NOTE: FS25 game port is UDP and can't be TCP-pinged, so we check the
    // FTP/SFTP control port (TCP, same machine) as a reliable "server box up" signal.
    // Host is the clean IP (resilient to a full ftp:// URL pasted in the host field).
    const customHost = server.connectionType === 'ftp' ? server.ftpHost : server.sftpHost
    // Prefer the clean game IP field; fall back to a sanitized custom host.
    const host = server.ip ? server.ip : resolveHost(customHost, '')
    const port = server.connectionType === 'ftp'
      ? (server.ftpPort || 21)
      : (server.sftpPort || 22)

    const ping = await tcpPing(host, port)
    const result: ServerPingResult = { online: ping >= 0, ping }
    updateServerStatus(server.id, result)
    return result
  } catch {
    const result: ServerPingResult = { online: false, ping: -1 }
    updateServerStatus(server.id, result)
    return result
  }
}

function tcpPing(host: string, port: number, timeout = 3000): Promise<number> {
  return new Promise((resolve) => {
    const start = Date.now()
    const socket = new net.Socket()

    socket.setTimeout(timeout)
    socket.connect(port, host, () => {
      const ping = Date.now() - start
      socket.destroy()
      resolve(ping)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(-1)
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(-1)
    })
  })
}

function updateServerStatus(id: string, result: ServerPingResult): void {
  const db = getDb()
  const updates: Record<string, unknown> = {
    status: result.online ? 'online' : 'offline',
    ping: result.ping
  }

  if (result.players !== undefined) updates.players = result.players
  if (result.maxPlayers !== undefined) updates.max_players = result.maxPlayers
  if (result.map) updates.map = result.map
  if (result.version) updates.version = result.version

  const fields = Object.entries(updates)
    .map(([k]) => `${k} = ?`)
    .join(', ')

  db.prepare(`UPDATE servers SET ${fields}, updated_at = datetime('now') WHERE id = ?`)
    .run(...Object.values(updates), id)
}
