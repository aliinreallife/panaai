# PanaAI — Persian AI Credit Platform

## Quick start

```bash
npm install
cp .env.example .env              # set DATABASE_URL (local Postgres or Neon)
npm run db:push                   # create/update tables
npm run dev                       # http://localhost:3000
```

Full setup, test and hosting guide (local, **Vercel + Neon**, VPS): [docs/DEPLOY.md](docs/DEPLOY.md). All environment variables are listed in [.env.example](.env.example).

Scripts: `dev`, `build`, `start`, `typecheck`, `lint`, `db:push`, `test:rules`, `test:api` and `test:browser`. The test scripts need the app running on port 3000.

## Graphite & gold redesign

The interface follows the PanaAI visual reference: a dark-by-default graphite canvas, warm metallic-gold accents, compact icon navigation with keyboard-accessible labels, custom brand mark, gold bar chart, model-share progress bars, wallet waves, real wallet-event history and a quick-action area. The complete customer/admin interface also supports a warm accessible light theme. Theme is restored before paint to avoid a light-mode flash.

- Global command search: Ctrl/⌘+K, arrow-key selection, Enter and Escape. Search is limited to this user's pages, masked key names, orders and recent request metadata.
- All report cards, models, daily buckets, pagination and filtered CSV exports derive from the same ownership-scoped PostgreSQL usage metadata. No hardcoded model shares or synthetic previous-period comparison remain. Empty calendar days are zero-filled in Asia/Tehran; comparisons appear only when prior data exists.
- New sandbox accounts have 1,284 individual sample request records that reconcile to 7,520,000 consumed credits, the key totals and daily summaries. Existing accounts are not silently reseeded or financially modified.
- Usage filters and chart periods are bookmarkable; obsolete fetches are canceled. CSV exports up to 10,000 matching records, independent of the current page. Request details store metadata only.
- Interrupted orders resume from an account-scoped browser pointer. Starting a different order is explicit; existing quote/order snapshots remain immutable.
- Notification reads persist in PostgreSQL and survive refreshes/profile edits. Settings changes lock the current user row to avoid overwriting concurrent pricing/model preferences.
- Logout revokes the server-side session, not just UI state. The sandbox explains that re-entry creates a separate workspace; it does not pretend to provide real customer authentication.
- Wallet-lot nonnegativity/reservation bounds and nonnegative usage charges have PostgreSQL check constraints. Usage ownership/time/model and lot-expiration indexes support reporting.

Additional checks with a running preview: `node scripts/logic-check.mjs` and `node scripts/pana-ui-check.mjs`.

Embedded-session test: `TEST_BASE_URL=https://pana-preview.test TEST_PROXY_BASE_URL=http://localhost:3000 node scripts/embed-check.mjs`. This controlled HTTPS browser transport tests partitioned third-party cookies without bypassing a hosting platform's traffic-access gateway. Set only TEST_BASE_URL to test an openly reachable real HTTPS origin. Origin/CSRF rejection is verified independently by the smoke test.

## Functional sandbox

Next.js App Router, React, PostgreSQL and Drizzle. Persian RTL with a local variable Vazirmatn font, responsive navigation, light/dark/system appearance and Jalali display dates (Asia/Tehran).

## What runs

- An isolated, seven-day HttpOnly session per browser. Production-built sandbox cookies are explicitly Secure and Partitioned with SameSite=None, supporting embedded previews without sharing a session across different top-level sites. Mutations still enforce same-origin Origin/Sec-Fetch-Site checks. Local non-HTTPS development uses SameSite=Lax. Every initial balance, order and request is explicitly demo data; it has no monetary value.
- HSTS, nosniff, referrer/permissions policies and CSP. Sandbox embedding is permitted for the preview; `PLATFORM_MODE=live` additionally enforces frame-ancestors none and X-Frame-Options DENY.
- Persistent wallet lots and journal history, FEFO-ordered display, independent expiration and available/reserved/expiring totals.
- Server-calculated integer-rial quotes, floor rounding with BigInt, 15-minute validity and immutable order amount/credit snapshots. The sandbox's separate transfer deadline is 24 hours, a recommendation rather than approved policy.
- Package/custom purchases, image receipt submission, private authenticated previews, review states, correction requests and customer tracking. No gateway and no invented bank card.
- JPEG/PNG/WebP signature/decoder checks, 8 MiB streaming request cap, pixel/dimension limits, re-encoding, metadata stripping, AES-256-GCM encrypted receipt bytes in PostgreSQL and ownership checks. Admin receipt views are audited. Production object storage and malware scanning remain gates.
- Sandbox payment review: explicit independent-bank-verification simulation, exact amount, required reason, unique bank-reference fingerprint, row lock, transactional grant/lot/order/audit, paired journal entries and unique grant idempotency key. Repeated or concurrent approvals issue one grant. Wrong amount, late transfer and repeated image hashes require manual resolution. Image matches are signals, not proof.
- API key creation, one-time reveal, keyed HMAC verifier, named keys, budgets, model allowlists, rate settings, revocation and atomic rotation. Rotation preserves spending and restrictions. Full secrets are not returned by list routes.
- Usage metadata, interactive chart and accessible data-table alternative, filters, pagination and CSV export (formula cells escaped). Sample summaries are separate from the sample recent-event detail window.
- Persistent profile/notification settings, support/refund requests, manual FX versions, manual unverified provider observations, demo model catalog configuration, alert acknowledgment and immutable-through-application audit history.
- Demo-only one-time code simulation, two-minute expiry, single use, five verification attempts and resend throttling. No real SMS is sent; the demo code is intentionally displayed in the UI.

## Important boundaries

This is **not a production financial service** and does not claim the PRD's release gates are completed.

`PLATFORM_MODE` defaults to sandbox. Setting `PLATFORM_MODE=live` closes sandbox session creation, admin access and financial mutations. There is no fallback that silently grants real administrator privileges. In sandbox, admin mutations need demo OTP plus a real RFC 6238 TOTP step-up; live admin stays closed until real SMS is connected.

`GET /v1/models` authenticates platform keys and returns an empty verified model list. Generation endpoints return HTTP 503 `service_unavailable` with `Retry-After`. No prompt/response is persisted, forwarded or billed. Sample catalog names are not verified reseller API model IDs. Concurrent reservation/settlement, streaming reconciliation, provider-capacity admission and 365-day deletion jobs must be implemented and stress-tested against authoritative CVC metering before enabling live dispatch. Deliberately do not remove the fail-closed gate to expose unmetered traffic.

The `/admin` interface is a **sandbox operator for the current demo user's own records only**, not a production super-admin route. Other browsers' records are not visible. It only exists for staff roles: new sandbox workspaces are `customer` accounts and every `/api/v1/admin/*` route answers 404 for them. Set `SANDBOX_OPERATOR_ACCESS=true` (internal previews and tests only) to make new workspaces operators.

**Customer/supplier boundary.** Customers deal with panaAI as the provider. Customer pages, the customer data payload, `/v1` responses and errors never name the upstream supplier, its balance or a simulator; supplier details exist only in admin screens and admin API routes. `npm run test:boundary` enforces this.

## Runtime and secrets

See `.env.example` for the full list.

- `DATABASE_URL`: the PostgreSQL URL used by `src/db/index.ts`. On Neon, use the pooled (`-pooler`) string with `?sslmode=require`.
- `RECEIPT_ENCRYPTION_KEY`: 64 hex characters (a 32-byte AES key), server only. It encrypts receipts and TOTP secrets and keys the API-secret verifier. It is **required on Vercel/serverless**. Without it, a local or VPS sandbox creates `.private/sandbox.key` once, with mode 0600. Never rotate it once data exists.
- `PLATFORM_MODE`: `live` closes the sandbox mutation surface. Anything else keeps the isolated sandbox.
- `NEXT_PUBLIC_BRAND_NAME`: an optional brand label.
- Optional: `TELEGRAM_BOT_TOKEN`, `RESEND_API_KEY` + `ALERT_EMAIL_FROM` (alert channels), and `CVC_BALANCE_URL` + `CVC_API_KEY` (live mode balance source, endpoint unverified).

No external provider credential is guessed or used. There is no ZarinPal integration.

## Database

Schema: `src/db/schema.ts`. All application access is through Drizzle. To create or update the tables, run `npm run db:push`. It uses `DATABASE_URL_UNPOOLED` if that is set and `DATABASE_URL` otherwise. Configuration is in `drizzle.config.ts`.

Financial records are append-only through exposed application APIs; production hardening should additionally enforce database roles/triggers, backup/restore and retention policy. Financial corrections are not implemented as deletion or direct balance edits.

## Production

What is production-ready, what is still missing for a real launch and how to switch to `PLATFORM_MODE=live`: [docs/PRODUCTION.md](docs/PRODUCTION.md).

## Validation

CI runs typecheck, lint, the rules tests, a production build and every API/browser suite: `.github/workflows/ci.yml`.


- `npx next typegen`
- `npm exec tsc -- --noEmit --pretty false`
- `npm run build`
- managed build/start and `/api/health`
- with a running preview: `node scripts/smoke.mjs` (defaults to `http://localhost:3000`, override with `TEST_BASE_URL`)
- browser end-to-end flow and responsive screenshots: `node scripts/browser-check.mjs`
- automated light/dark WCAG checks: `node scripts/accessibility.mjs`
- browser tests require `npx playwright install --with-deps chromium` or `CHROMIUM_PATH`. Generated screenshots go to `artifacts/`, which git ignores.

The smoke test uses independent demo sessions and checks quote/order idempotency, no credits from receipts, private ACLs, concurrent approval, duplicate bank references, immutable quotes after FX changes, malformed receipts, one-time keys and revocation, paused generation, OTP replay prevention, settings and tickets. It does not claim to prove live CVC metering, real bank settlement, production MFA or jurisdictional compliance.

## PRD implementation status (this preview)

**Improved in this iteration:** The Persian RTL analytics page now has four server-derived KPIs, daily chart with a keyboard-accessible focus state and an accessible daily data-table alternative, model and API-key breakdowns, 7/30/90-day filters, status/search filters, pagination and matching CSV export. Its selectors are keyboard-operable and have consistent light/dark styling; remaining native selects have matching visual treatment. The wallet separately shows credits expiring in 7 and 30 days. All quote previews use integer BigInt arithmetic and the quote displays its own locked FX rate. Duplicate receipt images are flagged across sandbox accounts, and verified bank references cannot be allocated twice across accounts. A review denial or request for more information needs a reason code, a private operator note and a separate customer-safe message. Customer data no longer includes private audit details; the scoped sandbox operator uses a separate audit endpoint. The provider-unverified warning is visible on the overview as well as before purchase.

**Still sandbox-only:** The named brand shown here is a configurable UI placeholder, not an approved commercial identity. Demo OTP codes are displayed on screen, not sent by SMS. The admin screen is a sandbox operator of their own isolated demo account, not an MFA-protected production super-admin. Manual FX is a demo override, not an automatically validated market source. Card details are deliberately absent, no real transfers can be made, and admin bank verification is an explicitly labelled simulation. Demo model names and usage metadata are not evidence of supported CVC endpoints or charges. The provider proxy fails closed and does not debit wallet credits, forward prompts or claim verified CVC capacity.

**Required before production:** written reseller authorization and authoritative CVC endpoint/rate/meter/balance verification; robust FEFO row-lock reservations and crash/stream reconciliation; real SMS OTP plus admin OTP/TOTP and RBAC; verified bank destination and independent statement reconciliation; FX source/freshness and versioned package configuration; object storage, scanning and legal receipt retention; explicit transfer-deadline/refund/credit-start policies; provider sync/grace/zero/resume state machine, coverage alerts and channels; retention jobs for detailed usage metadata at 365 days; backup and audit hardening; accounting/legal review and assistive-technology testing. None of these are presented as live.

## Before accepting real money or API traffic

1. Retain a separate CVC agreement authorizing public proxy/resale; public terms prohibit it absent an overriding agreement. Confirm cost multipliers, charged units, balance endpoint and supported paths.
2. Configure and verify the bank recipient identity; approve legal/refund terms, card-transfer reconciliation, approval discipline, transfer deadline and credit validity start.
3. Choose trusted FX and Iranian SMS vendors, connect authenticated delivery and implement real session rotation and TOTP step-up.
4. Provision private encrypted object storage, malware scanning, production ingress limits, distributed abuse controls, job/reconciliation workers, secure audit roles, notification channels, backups and restore drills.
5. Implement and test FEFO reservation/settlement with exact-once reconciliation, conservative request bounds and verified provider capacity before dispatch.
6. Finalize 365-day metadata cleanup, lawful financial/receipt retention, provider privacy disclosures, support hours, recognized revenue accounting and accessibility/security review.

Research references: CVC official website and public offer (`https://cheapvibecode.ru/en`, `/en/offer`), OWASP File Upload Cheat Sheet. Public consumer pricing and claims are not evidence of private reseller terms.

## Operations layer (this iteration)

- **Wallet reservations** (`src/lib/wallet.ts`): every API call reserves its worst-case cost FEFO across unexpired lots with row locks (user → key → lots), settles exactly once with the actual cost, and releases on failure. Key budgets count held reservations. `admin/wallet/reconcile` releases holds older than 5 minutes and verifies lots, reservations and journal balance.
- **Simulated gateway** (`src/lib/gateway-handler.ts`): `/v1/models`, `/v1/chat/completions`, `/v1/responses` work in sandbox with simulated responses; content is never stored. `PLATFORM_MODE=live` still fails closed.
- **Provider state machine** (`src/lib/rules.ts`, `src/lib/provider.ts`): healthy / low / grace / zero / paused / resuming / unverified, with coverage tiers 100/75/25/0. Zero or stale balance gets one bounded grace window (system setting, default 5 min). Zero stops API admission but never sales. Sandbox balance comes from an admin simulator; live mode needs `CVC_BALANCE_URL` + `CVC_API_KEY` (endpoint shape unverified).
- **Admin security** (`src/lib/security.ts`, `src/lib/totp.ts`): roles owner / finance / support / viewer checked server-side per route; every admin mutation needs a session elevated with demo OTP + real RFC 6238 TOTP (replay-protected, locks after 5 failures, 15 minutes).
- **Alerts**: stored per account with per-channel delivery results. Telegram needs `TELEGRAM_BOT_TOKEN`; email (Resend) needs `RESEND_API_KEY` and `ALERT_EMAIL_FROM`.
- **Refunds, packages, users, system settings**: refund request → approve (compensating reversal of unconsumed credits) → paid with payout reference; admin-managed purchase packages; account suspension; audited credit adjustments; transfer deadline, grace minutes, low-balance threshold and key limit settings.

Extra checks: `node scripts/rules-check.mjs` (no server needed), `node scripts/ops-check.mjs`, and `CHROMIUM_PATH=/path/to/chrome node scripts/browser-check.mjs` (screenshots in `artifacts/`). Admin flows in the scripts use `scripts/admin-auth.mjs`. Sandbox creation is limited to 30 per IP per hour, so running every suite back to back from one machine can hit that limit.
