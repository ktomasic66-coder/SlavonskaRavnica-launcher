import { ipcMain } from 'electron'
import {
  getAllServers,
  getActiveServer,
  addServer,
  updateServer,
  deleteServer,
  setActiveServer,
  pingServer,
  upsertServersFromConfig
} from '../../../backend/services/server.service'
import { backendAuthService } from '../../../backend/services/backend-auth.service'
import { discordService } from '../../../backend/services/discord.service'
import { logService } from '../../../backend/services/log.service'
import { isBackendMode } from '../../../src/shared/app-config'
import type { IPCResponse, GameServer } from '../../../src/shared/types'

async function syncBackendServers(): Promise<void> {
  if (!isBackendMode()) return
  const token = discordService.loadSession()?.user.accessToken
  if (!token) return
  const servers = await backendAuthService.fetchConfig(token)
  upsertServersFromConfig(servers)
}

export function registerServerHandlers(): void {
  ipcMain.handle('servers:get-all', async (): Promise<IPCResponse<GameServer[]>> => {
    try {
      await syncBackendServers()
      const servers = getAllServers()
      return { success: true, data: servers }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Greška dohvaćanja servera'
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('servers:get-active', async (): Promise<IPCResponse<GameServer | null>> => {
    try {
      await syncBackendServers()
      const server = getActiveServer()
      return { success: true, data: server }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Greška dohvaćanja aktivnog servera'
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('servers:add', async (_event, data: Omit<GameServer, 'id' | 'createdAt' | 'updatedAt'>): Promise<IPCResponse<GameServer>> => {
    try {
      const server = addServer(data)
      return { success: true, data: server }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Greška dodavanja servera'
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('servers:update', async (_event, id: string, data: Partial<GameServer>): Promise<IPCResponse<GameServer>> => {
    try {
      let server = updateServer(id, data)
      if (isBackendMode()) {
        const token = discordService.loadSession()?.user.accessToken
        if (token) {
          await backendAuthService.saveServerConfig(token, id, server)
          const servers = await backendAuthService.fetchConfig(token)
          upsertServersFromConfig(servers)
          server = getAllServers().find((s) => s.id === id) || server
          logService.success('CONFIG', `Server spremljen na backend: ${server.name}`)
        }
      }
      return { success: true, data: server }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Greška ažuriranja servera'
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('servers:delete', async (_event, id: string): Promise<IPCResponse> => {
    try {
      deleteServer(id)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Greška brisanja servera'
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('servers:set-active', async (_event, id: string): Promise<IPCResponse> => {
    try {
      setActiveServer(id)
      return { success: true }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Greška postavljanja aktivnog servera'
      return { success: false, error: msg }
    }
  })

  ipcMain.handle('servers:ping', async (_event, id: string): Promise<IPCResponse> => {
    try {
      const servers = getAllServers()
      const server = servers.find((s) => s.id === id)
      if (!server) return { success: false, error: 'Server nije pronađen' }
      const result = await pingServer(server)
      return { success: true, data: result }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ping greška'
      return { success: false, error: msg }
    }
  })
}
