# Publishing the Railway template (maintainer notes)

A Railway template turns "start your server" into one button: Railway asks the person for their email address, generates the encryption key, attaches the storage and gives the server its address. It is created once, in the Railway dashboard, from the public repository. Railway offers no way to create it from outside the dashboard.

1. Railway → workspace **Templates** → **New Template**.
2. **Add** → **GitHub repo** → `https://github.com/romaxnova/g-spot-assistant`. Railway builds the repository's `Dockerfile`.
3. **Variables** of the service. The description is what the person reads on the deploy form:

   | Variable | Value | Description to enter |
   |---|---|---|
   | `OWNER_EMAILS` | *(empty: the person fills it in)* | Your Google email address: the only one allowed to sign in to this server. Several: separate them with commas. |
   | `TOKEN_ENCRYPTION_KEY` | `${{secret(64, "abcdef0123456789")}}` | Generated for you. Keeps your Google sign-ins encrypted. |
   | `DEFAULT_TIMEZONE` | `UTC` | Your time zone, for example Europe/Paris or America/New_York. |
   | `PORT` | `8080` | Leave as it is. |
   | `GOOGLE_CLIENT_ID` | *(empty, optional)* | Leave empty for now: your server's page explains how to get it. |
   | `GOOGLE_CLIENT_SECRET` | *(empty, optional)* | Leave empty for now: your server's page explains how to get it. |

   No `BASE_URL` or `DATA_DIR`: the server reads `RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_VOLUME_MOUNT_PATH`.
4. **Settings**: public networking over HTTP on port `8080`; healthcheck path `/healthz`; restart policy *On failure*.
5. Right-click the service → **Attach volume** → mount path `/data`.
6. **Create Template** and copy its link (`https://railway.com/deploy/…`).
7. In the README, replace step 1 of "Set it up" with the button:

   ```markdown
   1. **Start your server.** Click the button, type your email address, and deploy.

      [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/TEMPLATE-CODE)
   ```

   and add a "Railway, one click" section at the top of part 1 of `docs/SETUP.md`.
8. Optionally **Publish** it to Railway's marketplace: open-source templates can earn a share of what their deployments spend.

Shortcut for steps 2 to 5: with the new, empty template open in the dashboard, Railway's built-in assistant can fill it in when given this list.
