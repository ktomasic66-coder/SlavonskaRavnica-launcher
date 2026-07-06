# SR Launcher Backend (Railway)

Mali auth + config servis. Drži sve tajne (Client Secret) server-side. Igrački launcher zna samo `PUBLIC_URL` ovog backenda.

## Što radi

- **OAuth token exchange** s Discordom (koristi Client Secret — nikad ne ide u .exe)
- **Provjera role** preko korisnikovog Discord tokena (`guilds.members.read`) — Bot Token nije potreban
- **Servira config servera** (`servers.json`) samo prijavljenim korisnicima s rolom

## Deploy na Railway (korak po korak)

1. **Push ovaj `server/` folder na GitHub** (ili kao zaseban repo, ili cijeli projekt).
2. Na [Railway](https://railway.app): **New Project → Deploy from GitHub repo** → odaberi repo.
3. Ako je `server/` u podfolderu, postavi **Root Directory = `server`** (Settings → Root Directory).
4. Railway automatski detektira Node i pokreće `npm start`.
5. U **Variables** dodaj (vidi `.env.example`):
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
   - `DISCORD_GUILD_ID`, `DISCORD_REQUIRED_ROLE_ID`
   - `JWT_SECRET` (dugi random string)
   - `PUBLIC_URL` (Railway URL, vidi korak 6) — **bez `/` na kraju**
6. **Generate Domain** (Settings → Networking) → dobiješ npr. `https://xxx.up.railway.app`. Stavi to u `PUBLIC_URL` i redeploy.
7. U [Discord Developer Portal](https://discord.com/developers/applications) → tvoja app → **OAuth2 → Redirects** dodaj:
   ```
   https://xxx.up.railway.app/auth/callback
   ```

## Provjera

Otvori `https://xxx.up.railway.app/health` → trebaš vidjeti `{"ok":true,...}`.

## Mijenjanje servera

Uredi `servers.json` i pushaj — Railway automatski redeploya, svi igrači dobiju novi config (bez novog .exe).

> **Napomena:** `webApiCode` u `servers.json` je read-only kod za statistiku (broj igrača/mapa) — nije osjetljiv. FTP lozinka se NE stavlja ovdje; igračima ne treba (modovi se skidaju s javnog linka).

## Endpointi

| Metoda | Putanja | Opis |
|--------|---------|------|
| GET | `/health` | Status |
| GET | `/auth/start?state=X` | Otvara se u browseru; redirecta na Discord |
| GET | `/auth/callback` | Discord redirecta ovdje (token exchange + role) |
| GET | `/auth/result?state=X` | Launcher povlači rezultat prijave |
| GET | `/auth/me` | Re-provjera sesije (Bearer token) |
| GET | `/config` | Config servera (Bearer token + rola) |
