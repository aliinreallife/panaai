# Setup, run and deploy

This guide covers three ways to run PanaAI:

1. On your own computer, for development.
2. On Vercel with a Neon database, as a hosted demo.
3. On any Node server or VPS.

Read the "Before you deploy" box first.

> **Before you deploy.** The app runs in **sandbox mode** by default. Every visitor gets their own demo workspace with fake credits. The visitor also gets the admin screen for that workspace. Payments, SMS, the CVC provider and the AI responses are all simulated. That is fine for a public demo. Do not take real money with it. Setting `PLATFORM_MODE=live` closes the demo, but the real integrations (bank, SMS, CVC API) are not built yet. In live mode the site loads, but purchases, the admin area and the API stay shut.

---

## 1. Run locally

**You need:** Node.js 20 or newer (22 recommended), and PostgreSQL 14 or newer. You can install Postgres locally, run it in Docker, or use a free Neon database.

```bash
# 1. Get the code (unzip panaai-source.zip, then:)
cd app-src
npm install

# 2. Start a database (pick one)
docker run -d --name panaai-db -p 5432:5432 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=app_db postgres:16
#   ...or paste a Neon connection string into .env (see section 2)

# 3. Configure
cp .env.example .env          # edit DATABASE_URL if yours differs
# optional but recommended:
echo "RECEIPT_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> .env

# 4. Create the tables
npm run db:push

# 5. Run
npm run dev                   # development, http://localhost:3000
# or
npm run build && npm start    # production build
```

Open http://localhost:3000. A sandbox workspace is created automatically. New workspaces are **customer** accounts: they never see the admin console, the PRD page or anything about the upstream supplier. To test the admin console locally, start the server with `SANDBOX_OPERATOR_ACCESS=true`; new workspaces then own their own data and get `/admin`. Admin actions ask for a step-up check, and the sandbox shows the demo codes on screen. The PRD status page is at `/roadmap`. To confirm the app is up, open `/api/health`.

### Tests

Run these with the app running on port 3000:

```bash
npm run test:rules        # pure business rules, no server needed
npm run test:api          # smoke, logic, ops, privacy, review rules   (server with SANDBOX_OPERATOR_ACCESS=true)
npm run test:browser      # Playwright UI, accessibility and screenshots (server with SANDBOX_OPERATOR_ACCESS=true)
npm run test:boundary     # customers never see the supplier or admin  (server WITHOUT SANDBOX_OPERATOR_ACCESS)
```

CI (`.github/workflows/ci.yml`) runs all of these on every push and pull request: it builds once, starts an operator server on port 3000 and a customer server on port 3001, and runs each suite against the right one.

If the browser tests can't find Chromium, either run `npx playwright install chromium` or set `CHROMIUM_PATH=/path/to/chrome`.

The sandbox allows 30 new workspaces per IP per hour. Running every suite back to back can hit that limit. Wait, or restart the server, which resets the in-memory limiter.

---

## 2. Host on Vercel + Neon (recommended for a hosted demo)

Yes, this works, and the two services go together:

- **Vercel** runs the Next.js app.
- **Neon** is the PostgreSQL database.

Both have free tiers that are enough for a demo.

### Step 1: Put the code on GitHub

Vercel deploys from a Git repository. Create an empty **private** repo on github.com, then push the code to it:

```bash
cd app-src
git init   # skip if it is already a repo
git add -A && git commit -m "PanaAI"
git branch -M main
git remote add origin https://github.com/<you>/panaai.git
git push -u origin main
```

`.env` and `.private/` are in `.gitignore`, so secrets are not pushed.

The Vercel CLI is an alternative to GitHub: run `npx vercel` in the folder.

### Step 2: Create the Neon database

1. Sign up at https://neon.tech, then create a project. Pick the region closest to your Vercel region. Frankfurt (`eu-central-1`) is a good default for users in Iran and Europe.
2. Open **Connection details** and copy two connection strings:
   - **Pooled.** The host contains `-pooler`. This one goes into `DATABASE_URL` for the app.
   - **Direct.** This is the same string without `-pooler`. Use it once, to create the tables.

   Both strings must end with `?sslmode=require`.
3. From your computer, create the tables:

```bash
DATABASE_URL="postgresql://USER:PASS@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require" npm run db:push
```

Use the **direct** string in that command. Run it again whenever the schema in `src/db/schema.ts` changes.

You can also connect Neon from inside Vercel: Project → Storage → Neon. That route creates `DATABASE_URL` and `DATABASE_URL_UNPOOLED` for you.

### Step 3: Import into Vercel

1. Go to https://vercel.com/new and import the GitHub repo. Vercel detects Next.js automatically, so leave the build settings at their defaults.
2. Under **Environment Variables**, add the variables in the table below. Then press **Deploy**.

| Variable | Required | Value |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** string with `?sslmode=require` |
| `RECEIPT_ENCRYPTION_KEY` | **yes on Vercel** | output of `openssl rand -hex 32` (64 hex characters) |
| `PLATFORM_MODE` | no | `sandbox` (default) for the demo, `live` for the real launch (see docs/PRODUCTION.md) |
| `SANDBOX_OPERATOR_ACCESS` | no | leave unset in any deployment customers can open. `true` gives every new sandbox workspace the admin console |
| `LOG_LEVEL` | no | `debug`, `info` (production default), `warn` or `error` |
| `NEXT_PUBLIC_BRAND_NAME` | no | label shown in the UI |
| `TELEGRAM_BOT_TOKEN` | no | for Telegram alerts |
| `RESEND_API_KEY`, `ALERT_EMAIL_FROM` | no | for e-mail alerts through Resend |
| `CVC_BASE_URL` | no | reseller API origin without `/v1` (default `https://ru.cheapvibecode.ru`) |
| `CVC_PRIMARY_API_KEY` | no | reseller control-plane key (create/edit/transfer keys); server only |
| `CVC_RUNTIME_API_KEY` | no | delegated key for balance/models; required for live upstream sync |
| `CVC_BALANCE_URL`, `CVC_API_KEY` | no | legacy balance override; prefer `CVC_BASE_URL` + `CVC_RUNTIME_API_KEY` |

The app validates its environment at startup (`src/lib/env.ts`). A production server with a missing or malformed required variable refuses to start and prints exactly which variable is wrong, instead of failing on the first request.

`RECEIPT_ENCRYPTION_KEY` encrypts receipts and TOTP secrets, and it signs API-key hashes. Store it somewhere safe, such as a password manager, and **never change it** once data exists. If it changes, existing API keys, receipts and authenticator enrolments stop working. On Vercel the app refuses to start receipts, keys or MFA without it, because Vercel has no disk on which to keep a generated key.

### Step 4: Check it

Open `https://<your-project>.vercel.app/api/health`. It should return OK. Then open the home page and start a demo workspace.

### Things to know on Vercel

- **Receipt image size.** Vercel limits a request body to about **4.5 MB**, and the app allows up to 8 MB. A receipt photo larger than 4.5 MB is rejected by Vercel before it reaches the app. Phone screenshots are normally well under that.
- **Rate limits are per instance.** The limiters (OTP resend, sandbox creation, API keys) are in memory, so each serverless instance counts separately. That is acceptable for a demo. Production needs a shared store such as Upstash Redis.
- **Stale reservations.** API reservations left by crashed requests are released when an admin presses Reconcile. There is no background job yet.
- **Region.** Set the Vercel function region (Project → Settings → Functions) to the same region as Neon. A mismatch adds latency to every query.
- **Public demo.** In sandbox mode, anyone with the link can create a customer workspace with sample data. They cannot reach `/admin`. Use Vercel's Deployment Protection (password or Vercel login) if you want to restrict access.
- **Logs.** Server logs are one JSON object per line (`level`, `event`, `time`, ...), so Vercel's log search and any log drain can filter on `event`. Unhandled server errors are logged as `request.unhandled_error` with the route and error digest; the digest is also shown to the user on the error page.

---

## 3. Any Node server or VPS

```bash
npm ci && npm run build
DATABASE_URL=... RECEIPT_ENCRYPTION_KEY=... npm start   # listens on PORT (default 3000)
```

Put it behind nginx or Caddy for HTTPS. Without `RECEIPT_ENCRYPTION_KEY`, sandbox mode writes a key to `.private/sandbox.key`. Keep that folder on persistent storage and back it up. On a VPS the 8 MB receipt limit applies in full, and the in-memory rate limits work as intended because there is only one process.

---

## Database changes

The schema lives in `src/db/schema.ts`. `npm run db:push` compares that schema with the database and applies the difference. It reads `DATABASE_URL_UNPOOLED` if that variable is set, and `DATABASE_URL` otherwise. If a change would drop a column or a table, it asks before doing it. Add `-- --force` only on a throwaway database.
