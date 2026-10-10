# Deploying to Render

There are two ways to run this on Render.

- **Option A: Blueprint (recommended).** One click creates a web service and a PostgreSQL database. Demo data loads automatically and persists. This takes about 10 minutes.
- **Option B: quick throwaway demo.** A single web service with no database. The demo data is rebuilt on every restart or deploy. This takes about 5 minutes.

Both options deploy as a **demo** (the `/demo` guide, `demo1234` accounts and sample data). To deploy for real use instead, see "Going from demo to real use" at the end.

## 0. Prerequisites

- A GitHub (or GitLab/Bitbucket) account and a free Render account at https://render.com. Sign in to Render with GitHub so it can see your repositories.
- The code pushed to a repository. From the project folder:

```bash
git add -A
git commit -m "Volunteer attendance & event access"
# create an empty repo on GitHub first (no README), then:
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `node_modules/`, `dist/`, `.data/` and `.env`.

## Option A: Blueprint (web service + PostgreSQL)

1. In Render, click **New → Blueprint**.
2. Pick your repository. Render reads [`render.yaml`](render.yaml) and shows two resources:
   - **attendance**, a Node web service on the free plan in Singapore;
   - **attendance-db**, a PostgreSQL database on the free plan in Singapore.
3. Click **Apply**. Render then does the following:
   - creates the database and connects it (`DATABASE_URL`);
   - generates `JWT_SECRET` and `CREDENTIAL_ENCRYPTION_KEY`;
   - builds with `npm ci --include=dev && npm run build`;
   - starts with `npm start`, which applies the database migrations and loads the demo data on first boot.
4. Wait until the service shows **Live**. The first build takes about 3–5 minutes, and the log ends with `Demo data loaded. Guide: https://<name>.onrender.com/demo`.
5. Open **`https://<name>.onrender.com/demo`**. It offers three short laptop + phone demos (Weekly check-in, Planned visits, Surprise visits) plus the detailed guide at `/demo/full`. Every account uses the password `demo1234`.

You don't need to set `PUBLIC_BASE_URL`. The app uses Render's `RENDER_EXTERNAL_URL` automatically, so the venue QR codes and passes point at your `onrender.com` address and work from any phone.

## Option B: quick throwaway demo (no database)

1. Click **New → Web Service** and pick the repository.
2. Fill in the settings:
   - **Runtime:** Node.
   - **Build command:** `npm ci --include=dev && npm run build`.
   - **Start command:** `npm start`.
   - **Instance type:** Free.
   - **Region:** Singapore, or whichever is closest to you.
3. Under **Environment variables**, add:

   | Key | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `NODE_VERSION` | `20` |
   | `DEMO_MODE` | `true` |
   | `ALLOW_DEMO_IN_PRODUCTION` | `true` |
   | `JWT_SECRET` | click **Generate** |
   | `CREDENTIAL_ENCRYPTION_KEY` | click **Generate** |

4. Click **Create Web Service**, wait for **Live**, then open `https://<name>.onrender.com/demo`.

Without `DATABASE_URL` the app uses its embedded database on the instance's temporary disk. Every deploy or restart starts a fresh demo. On the free plan, that includes waking up after the service has been idle.

## Before you present

- **Wake the service.** Free web services sleep after about 15 minutes without traffic, and the first request then takes about a minute. Open the site a few minutes before you start.
- **Refresh the demo times.** On `/demo`, press **Refresh demo times** in the *Reset* section. Today's sessions and the events then move around the current time.
- **Full reset.** Open `https://<name>.onrender.com/demo`, click **Reset demo data** (in "Start fresh"), and confirm. It takes about 10–30 seconds. It deletes everything done during demos, reloads the original demo data (including any changes to the demo data in a newly deployed version), and signs the laptop back in as the demo administrator. Phones must sign in again afterwards. The button exists only in demo mode and only an administrator can use it.

  *Fallback if the site won't start:* in Render, open the database → **Connect** → **External Connection**, run the PSQL command, then run `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`. Then, in the web service, click **Manual Deploy → Restart service**. For Option B, a restart alone is a full reset.
- **Email.** In demo mode, emails are not sent. Pass emails and verification codes appear in the guide's **Email outbox**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails with `tsc: not found` or `vite: not found` | The build command must include `--include=dev`, because `NODE_ENV=production` otherwise skips build tools. |
| Log shows `DEMO_MODE exposes demo credentials…` | Add `ALLOW_DEMO_IN_PRODUCTION=true`, or remove `DEMO_MODE` for a real deployment. |
| Log shows `DATABASE_URL is required in production` | Either add a database (Option A), or turn on demo mode (Option B). |
| QR codes point at `localhost` | Remove any `PUBLIC_BASE_URL` you set by hand, or set it to your `https://…onrender.com` URL. |
| `/demo` says "Demo mode is off" | `DEMO_MODE` is not `true` on the service. |
| Free database expired | Free Render PostgreSQL databases expire after 30 days. Upgrade the database, or recreate it from the Blueprint. |

## Going from demo to real use

1. In the web service's **Environment**, delete `DEMO_MODE` and `ALLOW_DEMO_IN_PRODUCTION`.
2. Add `SMTP_URL` (for example `smtps://user:pass@smtp.yourprovider.com:465`) and `MAIL_FROM`.
3. Start from a clean database. Either create a new Render PostgreSQL database and point `DATABASE_URL` at it, or run the `DROP SCHEMA` reset above.
4. Create the first administrator. Open the web service → **Shell** (paid instances), or run it locally against the database's *External* URL:

   ```bash
   DATABASE_URL="<external connection string>" npm run create-admin -- --email you@org.org --name "Your Name" --password "a-long-password"
   ```

5. Optionally add a custom domain (**Settings → Custom Domains**). Then set `PUBLIC_BASE_URL=https://attendance.yourorg.org` and reprint the venue QR codes and passes.
6. Use paid plans for real events: a free web service sleeps, and a free database expires.
