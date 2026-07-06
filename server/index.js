// ============================================================
// SR Launcher V2 - Auth & Config backend
// Holds all secrets (Client Secret) server-side. Clients only know PUBLIC_URL.
// Role-based access + upload permissions, manageable from the launcher Admin page.
// ============================================================
const express = require('express')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

const app = express()
app.use(express.json())
const PORT = process.env.PORT || 3000

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_GUILD_ID,
  DISCORD_REQUIRED_ROLE_ID,
  DISCORD_UPLOAD_ROLE_IDS,
  DISCORD_BOT_TOKEN,
  JWT_SECRET,
  PUBLIC_URL
} = process.env

const DISCORD_API = 'https://discord.com/api/v10'
const SCOPE = 'identify guilds.members.read'
const SESSION_TTL = '2d'
const DEFAULT_PUBLIC_URL = 'https://sr-launcher-backend.onrender.com'

// Persistent role config. Set CONFIG_DIR to a mounted persistent path if needed.
// so changes survive redeploys; otherwise falls back to env defaults each deploy.
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname
const ROLES_FILE = path.join(CONFIG_DIR, 'roles.json')
const SERVERS_FILE = path.join(__dirname, 'servers.json')
const DATABASE_URL = process.env.DATABASE_URL
const pgPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    })
  : null

const SERVER_COLUMNS = [
  'id',
  'name',
  'ip',
  'port',
  'max_players',
  'map',
  'version',
  'connection_type',
  'ftp_host',
  'ftp_port',
  'ftp_username',
  'ftp_password',
  'ftp_path',
  'sftp_host',
  'sftp_port',
  'sftp_username',
  'sftp_password',
  'sftp_path',
  'api_url',
  'api_key',
  'web_stats_port',
  'web_api_code'
]

const splitIds = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean)

function loadRoleConfig() {
  try {
    if (fs.existsSync(ROLES_FILE)) {
      const c = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'))
      return {
        accessRoleIds: Array.isArray(c.accessRoleIds) ? c.accessRoleIds : [],
        uploadRoleIds: Array.isArray(c.uploadRoleIds) ? c.uploadRoleIds : []
      }
    }
  } catch (e) {
    console.warn('roles.json read failed:', e.message)
  }
  return {
    accessRoleIds: splitIds(DISCORD_REQUIRED_ROLE_ID),
    uploadRoleIds: splitIds(DISCORD_UPLOAD_ROLE_IDS)
  }
}

function saveRoleConfig(cfg) {
  fs.writeFileSync(ROLES_FILE, JSON.stringify(cfg, null, 2))
}

let roleConfig = loadRoleConfig()
let serverDbReady = false

function toCamelServer(row) {
  return {
    id: row.id,
    name: row.name || '',
    ip: row.ip || '',
    port: Number(row.port || 7777),
    maxPlayers: Number(row.max_players || row.maxPlayers || 16),
    map: row.map || '',
    version: row.version || '',
    connectionType: row.connection_type || row.connectionType || 'ftp',
    ftpHost: row.ftp_host || row.ftpHost || '',
    ftpPort: Number(row.ftp_port || row.ftpPort || 21),
    ftpUsername: row.ftp_username || row.ftpUsername || '',
    ftpPassword: row.ftp_password || row.ftpPassword || '',
    ftpPath: row.ftp_path || row.ftpPath || '/mods',
    sftpHost: row.sftp_host || row.sftpHost || '',
    sftpPort: Number(row.sftp_port || row.sftpPort || 22),
    sftpUsername: row.sftp_username || row.sftpUsername || '',
    sftpPassword: row.sftp_password || row.sftpPassword || '',
    sftpPath: row.sftp_path || row.sftpPath || '/mods',
    apiUrl: row.api_url || row.apiUrl || '',
    apiKey: row.api_key || row.apiKey || '',
    webStatsPort: Number(row.web_stats_port || row.webStatsPort || 8080),
    webApiCode: row.web_api_code || row.webApiCode || ''
  }
}

function sanitizeServer(input, fallbackId) {
  const id = String(input.id || fallbackId || '').trim()
  if (!id) throw new Error('missing_id')
  return {
    id,
    name: String(input.name || '').trim(),
    ip: String(input.ip || '').trim(),
    port: Number(input.port || 7777),
    max_players: Number(input.maxPlayers || input.max_players || 16),
    map: String(input.map || '').trim(),
    version: String(input.version || '').trim(),
    connection_type: ['ftp', 'sftp', 'rest'].includes(input.connectionType || input.connection_type)
      ? String(input.connectionType || input.connection_type)
      : 'ftp',
    ftp_host: String(input.ftpHost || input.ftp_host || '').trim(),
    ftp_port: Number(input.ftpPort || input.ftp_port || 21),
    ftp_username: String(input.ftpUsername || input.ftp_username || '').trim(),
    ftp_password: String(input.ftpPassword || input.ftp_password || ''),
    ftp_path: String(input.ftpPath || input.ftp_path || '/mods').trim(),
    sftp_host: String(input.sftpHost || input.sftp_host || '').trim(),
    sftp_port: Number(input.sftpPort || input.sftp_port || 22),
    sftp_username: String(input.sftpUsername || input.sftp_username || '').trim(),
    sftp_password: String(input.sftpPassword || input.sftp_password || ''),
    sftp_path: String(input.sftpPath || input.sftp_path || '/mods').trim(),
    api_url: String(input.apiUrl || input.api_url || '').trim(),
    api_key: String(input.apiKey || input.api_key || ''),
    web_stats_port: Number(input.webStatsPort || input.web_stats_port || 8080),
    web_api_code: String(input.webApiCode || input.web_api_code || '').trim()
  }
}

function readServersFile() {
  return JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8')).map(toCamelServer)
}

function writeServersFile(servers) {
  fs.writeFileSync(SERVERS_FILE, JSON.stringify(servers, null, 2))
}

async function initServerDb() {
  if (!pgPool || serverDbReady) return
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS launcher_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ip TEXT DEFAULT '',
      port INTEGER DEFAULT 7777,
      max_players INTEGER DEFAULT 16,
      map TEXT DEFAULT '',
      version TEXT DEFAULT '',
      connection_type TEXT DEFAULT 'ftp',
      ftp_host TEXT DEFAULT '',
      ftp_port INTEGER DEFAULT 21,
      ftp_username TEXT DEFAULT '',
      ftp_password TEXT DEFAULT '',
      ftp_path TEXT DEFAULT '/mods',
      sftp_host TEXT DEFAULT '',
      sftp_port INTEGER DEFAULT 22,
      sftp_username TEXT DEFAULT '',
      sftp_password TEXT DEFAULT '',
      sftp_path TEXT DEFAULT '/mods',
      api_url TEXT DEFAULT '',
      api_key TEXT DEFAULT '',
      web_stats_port INTEGER DEFAULT 8080,
      web_api_code TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `)

  const count = await pgPool.query('SELECT COUNT(*)::int AS count FROM launcher_servers')
  if (count.rows[0]?.count === 0 && fs.existsSync(SERVERS_FILE)) {
    for (const server of readServersFile()) {
      const clean = sanitizeServer(server, server.id)
      const values = SERVER_COLUMNS.map((column) => clean[column])
      const placeholders = SERVER_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')
      await pgPool.query(
        `INSERT INTO launcher_servers (${SERVER_COLUMNS.join(', ')}) VALUES (${placeholders})`,
        values
      )
    }
  }
  serverDbReady = true
}

async function getServerConfigs() {
  if (!pgPool) return readServersFile()
  await initServerDb()
  const result = await pgPool.query('SELECT * FROM launcher_servers ORDER BY name ASC')
  return result.rows.map(toCamelServer)
}

async function upsertServerConfig(id, data) {
  const server = sanitizeServer(data, id)
  if (!pgPool) {
    const servers = readServersFile()
    const idx = servers.findIndex((s) => s.id === server.id)
    const camel = toCamelServer(server)
    if (idx >= 0) servers[idx] = camel
    else servers.push(camel)
    writeServersFile(servers)
    return camel
  }

  await initServerDb()
  const columns = SERVER_COLUMNS
  const values = columns.map((column) => server[column])
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
  const updates = columns
    .filter((column) => column !== 'id')
    .map((column) => `${column} = EXCLUDED.${column}`)
    .concat('updated_at = now()')
    .join(', ')
  const result = await pgPool.query(
    `INSERT INTO launcher_servers (${columns.join(', ')})
     VALUES (${placeholders})
     ON CONFLICT (id) DO UPDATE SET ${updates}
     RETURNING *`,
    values
  )
  return toCamelServer(result.rows[0])
}

function normalizePublicUrl(value) {
  const raw = String(value || DEFAULT_PUBLIC_URL).trim().replace(/\/+$/, '')
  return /^https?:\/\/[^/]+/i.test(raw) ? raw : ''
}

const publicUrl = normalizePublicUrl(PUBLIC_URL)

const missing = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'JWT_SECRET']
  .filter((k) => !process.env[k])
if (!publicUrl) missing.push('PUBLIC_URL')
if (missing.length) console.warn('⚠ Nedostaju env varijable:', missing.join(', '))

// In-memory pending logins keyed by state
const pending = new Map()
const PENDING_TTL = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL) pending.delete(k)
}, 60 * 1000).unref()

const redirectUri = () => `${publicUrl}/auth/callback`

app.get('/health', (_req, res) => res.json({ ok: true, service: 'sr-launcher-backend' }))

app.get('/auth/start', (req, res) => {
  const state = String(req.query.state || '')
  if (!state) return res.status(400).send('missing state')
  pending.set(state, { createdAt: Date.now(), result: null })
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    state,
    prompt: 'consent'
  })
  res.redirect(`${DISCORD_API}/oauth2/authorize?${params}`)
})

app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query
  const entry = state ? pending.get(String(state)) : null

  if (error) return res.send(htmlPage(false, 'Prijava je otkazana.'))
  if (!code || !entry) return res.send(htmlPage(false, 'Nevažeća ili istekla prijava. Pokušaj ponovno.'))

  try {
    const tokenRes = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: redirectUri()
      })
    })
    const token = await tokenRes.json()
    if (!token.access_token) throw new Error('token exchange failed')

    const userRes = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    })
    const user = await userRes.json()

    let userRoles = []
    const memberRes = await fetch(`${DISCORD_API}/users/@me/guilds/${DISCORD_GUILD_ID}/member`, {
      headers: { Authorization: `Bearer ${token.access_token}` }
    })
    if (memberRes.ok) {
      const member = await memberRes.json()
      userRoles = Array.isArray(member.roles) ? member.roles : []
    }

    const isMember = memberRes.ok
    const hasRole = roleConfig.accessRoleIds.length === 0
      ? isMember
      : roleConfig.accessRoleIds.some((r) => userRoles.includes(r))
    const canUpload = roleConfig.uploadRoleIds.some((r) => userRoles.includes(r))

    const profile = {
      id: user.id,
      username: user.username,
      avatar: user.avatar || null,
      globalName: user.global_name || null,
      hasRole,
      canUpload
    }
    const sessionToken = jwt.sign(profile, JWT_SECRET, { expiresIn: SESSION_TTL })
    entry.result = { user: profile, hasRole, canUpload, token: sessionToken }

    res.send(htmlPage(hasRole, hasRole
      ? 'Prijava uspješna! Možeš se vratiti u launcher.'
      : 'Prijavljen si, ali nemaš potrebnu Discord ulogu.'))
  } catch (e) {
    console.error('callback error:', e)
    res.send(htmlPage(false, 'Greška pri prijavi. Pokušaj ponovno.'))
  }
})

app.get('/auth/result', (req, res) => {
  const entry = req.query.state ? pending.get(String(req.query.state)) : null
  if (!entry) return res.status(404).json({ error: 'unknown_state' })
  if (!entry.result) return res.json({ pending: true })
  const result = entry.result
  pending.delete(String(req.query.state))
  res.json(result)
})

function requireSession(req, res, next) {
  const header = req.headers.authorization || ''
  const tok = header.startsWith('Bearer ') ? header.slice(7) : ''
  try {
    req.user = jwt.verify(tok, JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'unauthorized' })
  }
}

app.get('/auth/me', requireSession, (req, res) => {
  const hasRole = roleConfig.accessRoleIds.length === 0 ? true : !!req.user.hasRole
  const canUpload = !!req.user.canUpload
  res.json({ user: req.user, hasRole, canUpload })
})

app.get('/config', requireSession, async (req, res) => {
  const hasRole = roleConfig.accessRoleIds.length === 0 ? true : !!req.user.hasRole
  if (!hasRole) return res.status(403).json({ error: 'no_role' })
  try {
    const servers = await getServerConfigs()
    res.json({ servers })
  } catch (e) {
    console.error('config read failed:', e.message)
    res.status(500).json({ error: 'config_read_failed' })
  }
})

// ---- Admin: role management (only users with an upload/admin role) ----
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.canUpload) return res.status(403).json({ error: 'no_admin' })
  next()
}

app.get('/admin/roles', requireSession, requireAdmin, async (_req, res) => {
  if (!DISCORD_BOT_TOKEN) return res.status(500).json({ error: 'no_bot_token' })
  try {
    const r = await fetch(`${DISCORD_API}/guilds/${DISCORD_GUILD_ID}/roles`, {
      headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` }
    })
    if (!r.ok) return res.status(502).json({ error: 'discord_error' })
    const roles = await r.json()
    res.json({
      roles: roles
        .filter((role) => role.name !== '@everyone')
        .sort((a, b) => b.position - a.position)
        .map((role) => ({ id: role.id, name: role.name, color: role.color }))
    })
  } catch (e) {
    res.status(502).json({ error: 'discord_error' })
  }
})

app.get('/admin/config', requireSession, requireAdmin, (_req, res) => {
  res.json(roleConfig)
})

app.post('/admin/config', requireSession, requireAdmin, (req, res) => {
  const accessRoleIds = Array.isArray(req.body.accessRoleIds) ? req.body.accessRoleIds.filter(Boolean) : []
  const uploadRoleIds = Array.isArray(req.body.uploadRoleIds) ? req.body.uploadRoleIds.filter(Boolean) : []
  roleConfig = { accessRoleIds, uploadRoleIds }
  try {
    saveRoleConfig(roleConfig)
  } catch (e) {
    console.error('save roles failed:', e.message)
    return res.status(500).json({ error: 'save_failed', persisted: false, config: roleConfig })
  }
  res.json({ ok: true, config: roleConfig })
})

app.put('/admin/servers/:id', requireSession, requireAdmin, async (req, res) => {
  try {
    const server = await upsertServerConfig(req.params.id, { ...req.body, id: req.params.id })
    res.json({ ok: true, server })
  } catch (e) {
    console.error('save server failed:', e.message)
    res.status(500).json({ error: 'server_save_failed' })
  }
})

app.listen(PORT, () => console.log(`SR Launcher backend sluša na portu ${PORT} (config: ${CONFIG_DIR})`))

function htmlPage(ok, message) {
  const color = ok ? '#22c55e' : '#ef4444'
  const icon = ok ? '✓' : '✗'
  return `<!DOCTYPE html><html lang="hr"><head><meta charset="UTF-8">
<title>SR Launcher - Prijava</title><style>
body{background:#0a0a0a;color:#fff;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:40px;border:1px solid ${color};border-radius:16px;max-width:420px}
.icon{font-size:64px;color:${color};margin-bottom:16px}h2{color:${color};margin:0 0 12px}p{color:#888;margin:0}
</style></head><body><div class="box"><div class="icon">${icon}</div>
<h2>${ok ? 'Uspjeh' : 'Obavijest'}</h2><p>${message}</p>
<p style="margin-top:20px;font-size:12px;">Možeš zatvoriti ovaj prozor.</p></div></body></html>`
}
