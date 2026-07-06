# SR Launcher Backend (Render)

Mali auth + config servis. Drzi sve tajne server-side. Igracki launcher zna samo javni `PUBLIC_URL` ovog backenda.

## Sto radi

- OAuth token exchange s Discordom
- Provjera Discord role preko korisnikovog tokena
- Servira centralni config servera iz Render Postgres baze
- Admin iz launchera moze spremiti izmjene servera/FTP podataka na backend

## Deploy na Render

1. Napravi Render **Web Service** iz GitHub repo-a.
2. Postavi:
   ```text
   Root Directory: server
   Build Command: npm install
   Start Command: npm start
   ```
3. U **Environment** dodaj:
   ```text
   DISCORD_CLIENT_ID
   DISCORD_CLIENT_SECRET
   DISCORD_GUILD_ID
   DISCORD_REQUIRED_ROLE_ID
   DISCORD_BOT_TOKEN
   JWT_SECRET
   PUBLIC_URL=https://sr-launcher-backend.onrender.com
   DATABASE_URL=<Internal Database URL iz Render Postgres baze>
   ```
4. U Discord Developer Portal dodaj redirect:
   ```text
   https://sr-launcher-backend.onrender.com/auth/callback
   ```

## Provjera

Otvori:

```text
https://sr-launcher-backend.onrender.com/health
```

Trebas vidjeti JSON odgovor s `ok: true`.

## Mijenjanje servera i FTP podataka

Kad je `DATABASE_URL` postavljen, backend automatski napravi tablicu `launcher_servers`.
Prvi put ce napuniti bazu iz `servers.json` ako je tablica prazna.

Admin u launcheru otvori **Serveri > Uredi Server**, promijeni IP, port, FTP host,
FTP username/password, remote path ili Web API code i klikne **Spremi Izmjene**.
Launcher salje izmjenu na backend, backend je sprema u Postgres, a drugi korisnici
dobiju novi config kad se launcher prijavi/provjeri sesiju ili kad se osvjezi lista servera.

Ako `DATABASE_URL` nije postavljen, backend se vraca na stari fallback i cita/pise `servers.json`.
