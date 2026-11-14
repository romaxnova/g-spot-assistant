# Setup guide

Three parts, done once by the person who runs the server: deploy it (about 5 minutes), create a Google OAuth client (about 10 minutes, free), then link Google accounts and connect Claude (a few minutes).

Below, `YOUR-DOMAIN` is the server's public hostname (for example `g-spot-production-1234.up.railway.app`) and `you@gmail.com` the Google account that owns the setup. Once the server runs, its home page shows these addresses filled in.

| What | Value |
|---|---|
| Home page (shows what is left to set up) | `https://YOUR-DOMAIN/` |
| MCP endpoint (paste into Claude) | `https://YOUR-DOMAIN/mcp` |
| Google redirect URI (paste into Google Cloud) | `https://YOUR-DOMAIN/auth/google/callback` |
| Admin page | `https://YOUR-DOMAIN/admin` |

## 1. Deploy the server

Pick one way. Every way runs the same Docker image ([Dockerfile](../Dockerfile)) and keeps its data in one SQLite file under `/data`.

### Railway, from the repository

1. On [railway.com](https://railway.com): **New project** → **Deploy from GitHub repo** → this repository (or your fork of it). Railway builds the Dockerfile by itself.
2. Right-click the service → **Attach volume** → mount path `/data`. Without a volume every deploy starts from scratch; the server says so on its home page.
3. Service **Settings** → **Networking** → **Generate domain**, port `8080`. This is `YOUR-DOMAIN`.
4. Service **Settings** → **Deploy** → **Healthcheck path** `/healthz` (a new deploy only takes over once it answers).
5. Service **Variables**:
   - `OWNER_EMAILS` = `you@gmail.com` (several owners: comma-separated)
   - `TOKEN_ENCRYPTION_KEY` = the output of `openssl rand -base64 32` (or `npm run generate-secrets`). Keep a copy somewhere safe: without it the stored accounts cannot be read.
   - `PORT` = `8080`
   - `DEFAULT_TIMEZONE` = your IANA zone, for example `Europe/Paris` (default `UTC`)

   `BASE_URL` and `DATA_DIR` are not needed: the server finds its domain and the volume by itself. The Google variables come in part 2.
6. Open `https://YOUR-DOMAIN/`: it shows the remaining steps.

Railway's Hobby plan (about $5 a month) covers this service.

### Docker, on any machine

```bash
git clone https://github.com/romaxnova/g-spot-assistant.git
cd g-spot-assistant
cp .env.example .env    # set BASE_URL, OWNER_EMAILS, TOKEN_ENCRYPTION_KEY (openssl rand -base64 32), DEFAULT_TIMEZONE
docker compose up -d
```

The server listens on port 8080 and keeps its data in the `g-spot-data` volume. Claude only connects to `https` addresses, so put the server behind a reverse proxy with a certificate, for example [Caddy](https://caddyserver.com) with a two-line `Caddyfile`:

```
assistant.example.com {
  reverse_proxy localhost:8080
}
```

or behind a tunnel (Cloudflare Tunnel, Tailscale Funnel). `BASE_URL` is that public `https` address. Updates: `git pull && docker compose up -d --build`.

## 2. Google Cloud (about 10 minutes)

Each copy of the server has its own Google OAuth client, in a Google Cloud project you own. It is free.

1. Open <https://console.cloud.google.com/> signed in as **you@gmail.com**.
2. Project picker (top bar) → **New project** → any name → **Create**, then select it.
3. Enable the four APIs. Open each link and click **Enable**:
   - Gmail API: <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
   - Google Calendar API: <https://console.cloud.google.com/apis/library/calendar-json.googleapis.com>
   - Google Sheets API: <https://console.cloud.google.com/apis/library/sheets.googleapis.com>
   - Google Drive API: <https://console.cloud.google.com/apis/library/drive.googleapis.com>
4. Consent screen: <https://console.cloud.google.com/auth/overview> → **Get started**.
   - App name: anything, for example `G-Spot Assistant`. User support email: your address.
   - Audience: **External**. Contact email: your address. Agree, **Create**.
   - Branding page (<https://console.cloud.google.com/auth/branding>): do not upload a logo (a logo forces Google's verification). Fill in:
     - Application home page: `https://YOUR-DOMAIN/`
     - Application privacy policy link: `https://YOUR-DOMAIN/privacy`
     - Application terms of service link: `https://YOUR-DOMAIN/terms`
     - Authorized domain 1: `YOUR-DOMAIN`
     - Developer contact email: your address. **Save**.
5. Publish it: <https://console.cloud.google.com/auth/audience> → **Publish app** → **Confirm**. The status must read **In production**. Do **not** submit it for verification: the "unverified app" warning is expected for an app only you and the people you invite use.
   - If it stays in **Testing**, Google expires every refresh token after 7 days and the accounts keep asking to be re-linked.
6. OAuth client: <https://console.cloud.google.com/auth/clients> → **Create client**.
   - Application type: **Web application**. Name: anything.
   - Authorized redirect URIs → **Add URI**: `https://YOUR-DOMAIN/auth/google/callback`
   - **Create**. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and the **Client secret** (starts with `GOCSPX-`).
7. Put them in the server's variables as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (on Railway, deploy the change when it asks; with Docker, edit `.env` and run `docker compose up -d`). Open `https://YOUR-DOMAIN/`: the setup steps are gone.

## 3. Link the Google accounts

1. Open `https://YOUR-DOMAIN/admin` → **Sign in with Google** → choose you@gmail.com. (This step only asks Google for your email, so no warning appears yet.)
2. Under **Link an account**, pick a short alias (for example `me`, `work`, `partner`), tick the services that account should grant, and choose who signs in:
   - *I sign in to that Google account now*: you complete Google's consent screen in this browser.
   - *Create an invite link*: a single-use link (valid 7 days) for the account's owner to open on their own device. Optionally restrict it to one expected email.
   Google shows *"Google hasn't verified this app"*: click **Advanced** → **Go to … (unsafe)**. This is the expected screen for a personal app; each account owner sees it once per link. On the consent screen keep every checkbox ticked and click **Continue**.
3. The admin page lists each linked account with a green **ok** badge and the services it grants.

## 4. Connect your AI client

### claude.ai (web, desktop and mobile apps)

1. <https://claude.ai/settings/connectors> → **Add custom connector**.
2. Name: anything, for example `G-Spot Assistant`. Remote MCP server URL: `https://YOUR-DOMAIN/mcp`. Leave the OAuth client fields empty. **Add**.
3. Click **Connect**. You are sent to the server, sign in with Google if asked, and see the **Authorize Claude** page. Click **Approve**.
4. Open the connector's tool settings and set these tools to **Ask** (they send, delete or share): `gmail_send`, `gmail_reply`, `gmail_forward`, `gmail_send_draft`, `gmail_schedule_send`, `gmail_delete_draft`, `gmail_trash`, `calendar_delete_event`, `calendar_respond`, `drive_share`, `drive_trash`.
5. Turn off the official Gmail, Google Calendar and Google Drive connectors so the tool names do not overlap.
6. The connector now also works in the Claude mobile apps and Claude Desktop, with your computer off. In a new chat, open the tools menu and make sure the connector is switched on.

### Claude Code

```bash
claude mcp add --transport http g-spot https://YOUR-DOMAIN/mcp
```

Then run `/mcp` in Claude Code and sign in: the browser opens the server's sign-in and **Authorize** pages.

### ChatGPT (not tested yet)

ChatGPT's developer mode takes custom MCP servers with OAuth. Create an app with the MCP server URL `https://YOUR-DOMAIN/mcp` and OAuth authentication, and when ChatGPT offers a choice, pick **dynamic client registration** (DCR): this server only accepts client metadata documents from Claude. ChatGPT's callback addresses (`https://chatgpt.com/connector/oauth/…` and the older `https://chatgpt.com/connector_platform_oauth_redirect`) are allowed already. Connecting then goes through the same sign-in and **Authorize** pages. This has not been tried yet: please report how it goes.

## 5. Try it

Ask Claude: *"List my Google accounts"*, then *"Anything unread across all inboxes?"* and *"What is on my calendars today?"*.

## 6. Day-to-day

- **An account says "needs re-link"**: open the admin page and click **Re-link**. This happens after a password change, when access is revoked at Google, or if the consent screen was still in Testing mode.
- **Add or remove an account**: admin page. Unlinking revokes the grant at Google as well.
- **Lost phone or suspicious activity**: admin page → **Disconnect all Claude sessions**, then reconnect from Claude.
- **Rotate the encryption key or the Google client secret**: see the README, section *Operations*.
- **Logs**: Railway → service → **Logs**, or `docker compose logs`. Logs never contain tokens, email or file content.
