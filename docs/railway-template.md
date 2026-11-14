# Publishing the Railway template (maintainer notes)

A Railway template turns the setup into one click: Railway asks the person deploying for their email, generates the encryption key, attaches the volume and gives the service a domain. It is created once, in the Railway dashboard, from the public repository.

1. Railway → workspace **Templates** → **New Template**.
2. **Add** → **GitHub repo** → `https://github.com/romaxnova/g-spot-assistant`. Railway builds the repository's `Dockerfile`.
3. **Variables** of the service:

   | Variable | Value | Note |
   |---|---|---|
   | `OWNER_EMAILS` | *(empty: the person deploying fills it in)* | Google account(s) allowed to sign in, comma-separated |
   | `TOKEN_ENCRYPTION_KEY` | `${{secret(64, "abcdef0123456789")}}` | a new random key for each deployment |
   | `PORT` | `8080` | |
   | `DEFAULT_TIMEZONE` | `UTC` | editable, e.g. `Europe/Paris` |
   | `GOOGLE_CLIENT_ID` | *(empty, optional)* | set after deploying, from Google Cloud |
   | `GOOGLE_CLIENT_SECRET` | *(empty, optional)* | same |

   No `BASE_URL` or `DATA_DIR`: the server reads `RAILWAY_PUBLIC_DOMAIN` and `RAILWAY_VOLUME_MOUNT_PATH`.
4. **Settings**: public networking over HTTP on port `8080`; healthcheck path `/healthz`; restart policy *On failure*.
5. Right-click the service → **Attach volume** → mount path `/data`.
6. **Create Template**, copy its URL, and add the button to the top of the README:

   ```markdown
   [![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/TEMPLATE-CODE)
   ```

   and a "Railway, one click" section at the top of part 1 of `docs/SETUP.md`: click the button, enter your email, deploy, then open the service's domain and follow the home page.
7. Optionally **Publish** it to Railway's marketplace: open-source templates with an active community can earn a share of what their deployments spend.

After deploying, the person opens the service's domain: the home page lists the Google Cloud steps with their own addresses filled in.
