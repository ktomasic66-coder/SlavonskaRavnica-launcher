import { shell } from 'electron'
import crypto from 'crypto'
import axios from 'axios'
import { BACKEND_URL } from '../../src/shared/app-config'
import { logService } from './log.service'
import type { DiscordUser, GameServer } from '../../src/shared/types'

interface BackendProfile {
  id: string
  username: string
  avatar: string | null
  globalName: string | null
  hasRole: boolean
  canUpload?: boolean
}

export interface GuildRole {
  id: string
  name: string
  color: number
}

export interface RoleConfig {
  accessRoleIds: string[]
  uploadRoleIds: string[]
}

interface BackendConfigServer {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class BackendAuthService {
  /**
   * Opens the Discord login in the browser (via the backend) and polls the
   * backend for the result. The backend performs the token exchange + role
   * check, so no secrets ever touch the client.
   */
  async login(): Promise<{ user: DiscordUser; hasRole: boolean; canUpload: boolean }> {
    const base = BACKEND_URL.replace(/\/$/, '')
    const state = crypto.randomUUID()

    logService.info('AUTH', 'Pokrenuta Discord prijava (backend)')
    await shell.openExternal(`${base}/auth/start?state=${encodeURIComponent(state)}`)

    const deadline = Date.now() + 5 * 60 * 1000
    while (Date.now() < deadline) {
      await sleep(2000)
      try {
        const res = await axios.get(`${base}/auth/result?state=${encodeURIComponent(state)}`, {
          timeout: 8000,
          validateStatus: () => true
        })
        if (res.status === 404) continue
        if (res.data?.pending) continue
        if (res.data?.token && res.data?.user) {
          return this.toSession(res.data.user as BackendProfile, res.data.token as string)
        }
      } catch {
        // network hiccup - keep polling
      }
    }
    throw new Error('Prijava je istekla (5 min). Pokušaj ponovno.')
  }

  /** Re-checks an existing backend session token (role may have changed). */
  async verify(token: string): Promise<{ user: DiscordUser; hasRole: boolean; canUpload: boolean } | null> {
    const base = BACKEND_URL.replace(/\/$/, '')
    try {
      const res = await axios.get(`${base}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000,
        validateStatus: () => true
      })
      if (res.status !== 200 || !res.data?.user) return null
      return this.toSession(res.data.user as BackendProfile, token)
    } catch {
      return null
    }
  }

  async getRoles(token: string): Promise<GuildRole[]> {
    const base = BACKEND_URL.replace(/\/$/, '')
    const res = await axios.get(`${base}/admin/roles`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000,
      validateStatus: () => true
    })
    if (res.status !== 200) {
      throw new Error(res.data?.error === 'no_bot_token' ? 'Backend nema Bot Token (dodaj DISCORD_BOT_TOKEN u backend env varijable)' : 'Ne mogu dohvatiti role')
    }
    return (res.data?.roles ?? []) as GuildRole[]
  }

  async getRoleConfig(token: string): Promise<RoleConfig> {
    const base = BACKEND_URL.replace(/\/$/, '')
    const res = await axios.get(`${base}/admin/config`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    })
    return res.data as RoleConfig
  }

  async saveRoleConfig(token: string, config: RoleConfig): Promise<RoleConfig> {
    const base = BACKEND_URL.replace(/\/$/, '')
    const res = await axios.post(`${base}/admin/config`, config, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    })
    return res.data.config as RoleConfig
  }

  /** Fetches the server configuration the admin manages on the backend. */
  async fetchConfig(token: string): Promise<BackendConfigServer[]> {
    const base = BACKEND_URL.replace(/\/$/, '')
    try {
      const res = await axios.get(`${base}/config`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 8000
      })
      const servers = (res.data?.servers ?? []) as BackendConfigServer[]
      logService.success('CONFIG', `Učitano ${servers.length} servera s backenda`)
      return servers
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'greška'
      logService.warning('CONFIG', `Ne mogu dohvatiti config s backenda: ${msg}`)
      return []
    }
  }

  async saveServerConfig(token: string, id: string, server: Partial<GameServer>): Promise<BackendConfigServer> {
    const base = BACKEND_URL.replace(/\/$/, '')
    const res = await axios.put(`${base}/admin/servers/${encodeURIComponent(id)}`, server, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10000
    })
    return res.data.server as BackendConfigServer
  }

  private toSession(profile: BackendProfile, token: string): { user: DiscordUser; hasRole: boolean; canUpload: boolean } {
    // The backend JWT is stored where the Discord access token used to live.
    const user: DiscordUser = {
      id: profile.id,
      username: profile.username,
      discriminator: '0',
      avatar: profile.avatar ?? undefined,
      globalName: profile.globalName ?? undefined,
      accessToken: token,
      refreshToken: '',
      expiresAt: this.decodeExp(token)
    }
    return { user, hasRole: profile.hasRole, canUpload: !!profile.canUpload }
  }

  private decodeExp(jwtToken: string): number {
    try {
      const payload = JSON.parse(Buffer.from(jwtToken.split('.')[1], 'base64').toString('utf8'))
      return payload.exp ? payload.exp * 1000 : Date.now() + 2 * 24 * 60 * 60 * 1000
    } catch {
      return Date.now() + 2 * 24 * 60 * 60 * 1000
    }
  }
}

export const backendAuthService = new BackendAuthService()
