// ============================================================
// SR Launcher V2 - Auth & Config backend
// Holds all secrets (Client Secret) server-side. Clients only know PUBLIC_URL.
// Role-based access + upload permissions, manageable from the launcher Admin page.
// ============================================================
const express = require('express')
const jwt = require('jsonwebtoken')
const fs = require('fs')
const path = require('path')

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

// Persistent role config. Set CONFIG_DIR to a Railway volume mount (e.g. /data)
// so changes survive redeploys; otherwise falls back to env defaults each deploy.
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname
const ROLES_FILE = path.join(CONFIG_DIR, 'roles.json')

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

const missing = ['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'JWT_SECRET', 'PUBLIC_URL']
  .filter((k) => !process.env[k])
if (missing.length) console.warn('⚠ Nedostaju env varijable:', missing.join(', '))

// In-memory pending logins keyed by state
const pending = new Map()
const PENDING_TTL = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of pending) if (now - v.createdAt > PENDING_TTL) pending.delete(k)
}, 60 * 1000).unref()

const redirectUri = () => `${PUBLIC_URL}/auth/callback`

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

app.get('/config', requireSession, (req, res) => {
  const hasRole = roleConfig.accessRoleIds.length === 0 ? true : !!req.user.hasRole
  if (!hasRole) return res.status(403).json({ error: 'no_role' })
  try {
    const servers = JSON.parse(fs.readFileSync(path.join(__dirname, 'servers.json'), 'utf8'))
    res.json({ servers })
  } catch (e) {
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
