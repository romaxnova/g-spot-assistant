# Security

G-Spot Assistant holds the keys to people's mailboxes, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Please do not open a public issue, and do not include real mail, tokens or personal data in the report: a description and a way to reproduce it with test data are enough.

This is a project maintained in spare time: expect an answer within a week. Fixes go to the latest version on `main`; older versions get no separate fixes.

## How it is built

Each copy is run by its owner for themselves and the Google accounts they link. The design choices that matter for security:

- **Network**: the server talks to Google's APIs and nothing else, apart from fetching Claude's client metadata document from `claude.ai` (`CIMD_ALLOWED_HOSTS`). No telemetry, no update check.
- **At rest**: Google refresh tokens, tracked follow-ups, the list of sensitive contacts and files staged from the chat are encrypted with AES-256-GCM, with keys derived from `TOKEN_ENCRYPTION_KEY`, which lives only in the environment. Claude's tokens, sessions and invite links are stored as SHA-256 hashes. No email, event, sheet or file content is stored otherwise.
- **Logs**: method, path, status, duration, tool name, account alias, MCP method names. Never tokens, secrets, email or file content, or email addresses of other people.
- **Access**: every MCP call needs a bearer token issued only after an owner (`OWNER_EMAILS`) signed in with Google and approved a consent page. OAuth 2.1 with mandatory PKCE, pinned redirect URIs, single-use states and codes, rotating refresh tokens with reuse detection, `resource`-bound tokens.
- **Browser pages**: no JavaScript, a strict Content-Security-Policy, HSTS, `X-Frame-Options: DENY`, same-origin checks on every form, `HttpOnly; Secure; SameSite=Lax` cookies, rate limits.
- **Untrusted files**: PDFs are parsed in a worker thread with memory and time limits; Office files go through a ZIP reader with size limits.
- **Sending**: mail to sensitive contacts is held as a draft until the user approved the reviewed text; scheduled mail is never sent twice.

## Running a copy safely

- Turn on two-factor authentication on the hosting account (Railway, your server) and on the owner's Google account: whoever reads the server's variables can decrypt its data.
- Keep `OWNER_EMAILS` to the people who should drive Claude with these accounts.
- Keep the Google consent screen **In production** (Testing mode expires tokens after 7 days) and do not share the OAuth client.
- In Claude, set the tools that send, delete or share to **Ask**.
- Rotate `TOKEN_ENCRYPTION_KEY` or the Google client secret if you think they leaked (see the README, *Operations*), and use **Disconnect all Claude sessions** on the admin page if a device is lost.
- Update regularly: `git pull && docker compose up -d --build`, or redeploy the latest version on Railway.
