# Production readiness

This page says what is ready, what is not, and the exact steps for a real launch.
Short version: the code is hardened and safe to host, but **real customers cannot sign up or pay yet**,
because SMS login, bank payments and the upstream API are not connected. The app does not fake any of them.

## What is in place

| Area | Status |
|---|---|
| Environment validation | `src/lib/env.ts`, run at startup by `src/instrumentation.ts`. A production server with a missing or malformed variable refuses to start and names the variable. Launch warnings (sandbox mode, operator access) are logged at startup. |
| Security headers | `next.config.ts`: strict same-origin CSP, HSTS (2 years, preload), nosniff, referrer and permissions policies, COOP/CORP, no `X-Powered-By`. Live mode also forbids framing. API routes are `no-store`. |
| Demo data | New sandbox workspaces are empty by default (no fake wallet, keys, or usage). Sample data is seeded only when `SANDBOX_SEED_DEMO=true` (CI/tests). In `PLATFORM_MODE=live` sandbox creation is closed, sandbox sessions are ignored and sandbox API keys are rejected. Platform keys use the `pana-…` prefix. |
| Customer/supplier boundary | Customers never see the upstream supplier. Customer UI, the customer data payload, `/v1` responses and error codes (`service_unavailable`) are supplier-neutral. Supplier state, balance and sync exist only in admin screens and admin routes. `npm run test:boundary` checks every customer page, the status dialog, the payload and `/v1`. |
| Admin isolation | Only staff roles (`owner`, `finance`, `support`, `viewer`) have an admin surface. Customers get 404 from every `/api/v1/admin/*` route (including the role switcher) and see no admin or PRD links. Admin mutations need phone OTP elevation; TOTP is optional until enrolled. |
| Errors and logging | JSON-line logger (`src/lib/logger.ts`) with secret redaction. `onRequestError` logs every unhandled server error with route and digest. Persian error, global-error and 404 pages show a support code instead of a stack trace. |
| CI | `.github/workflows/ci.yml`: typecheck, lint, rules tests, production build, API suites, browser and accessibility suites, and the customer-boundary check, against a real Postgres. |

## What is still needed before real customers

These are business integrations and decisions. Each one needs an account, a contract or a credential that only you can provide.

1. **Real login.** Kavenegar Verify Lookup is wired (`KAVENEGAR_API_KEY` + `KAVENEGAR_OTP_TEMPLATE`); set both and create the template with `%token` in the Kavenegar panel. Still needed: a real sign-up flow that creates `demo = false` users with role `customer`. Today the primary path is an anonymous sandbox workspace.
2. **Staff accounts.** OTP on configured admin phones (`ADMIN_PHONES`, default `09203050405` and `09225006434`) promotes the workspace to `owner`. Still useful: invite flow for finance/support and TOTP enrollment for each staff member.
3. **Payments.** Destination card defaults to `6219861917179755` and is editable in admin → system (stored in `platform_state`). Still needed: ownership verification of that account, statement reconciliation (or an IPG such as ZarinPal/IDPay with webhook verification), and approved refund and transfer-deadline terms.
4. **Upstream API.** Reseller contract is in place. Set `CVC_BASE_URL` + `CVC_PRIMARY_API_KEY` and enable `CVC_LIVE_DISPATCH=true` (or `PLATFORM_MODE=live`). Balance/models sync and non-streaming live dispatch are implemented. Streaming and deeper crash reconciliation against upstream usage logs are still open.
5. **Pricing.** Customer rate defaults to **20M credits / $1**; wholesale defaults to **25M tokens / $1** (admin-only, never shown to customers). Both are editable in admin → system. **FX** defaults to **275,000 تومان / USD** (stored as `2,750,000` ریال, platform-wide in `platform_state`); change anytime in admin → pricing. No market feed required for launch.
6. **Storage.** Private object storage with malware scanning for receipts, and the legal retention period for receipts and financial records.
7. **Shared rate limiting and jobs.** Rate-limit buckets are in Postgres. Daily Vercel Cron (03:00 UTC) hits `/api/cron/maintenance` when `CRON_SECRET` is set (stale reservation release + 365-day usage metadata deletion; Hobby allows one cron run/day). Distributed abuse controls (e.g. Redis) are still optional hardening.
8. **Operations.** Backups and a tested restore on Neon, an error-alerting destination (Vercel log drain or Sentry), a custom domain, and turning off Vercel Authentication for that domain.
9. **Legal and content.** Terms of service, privacy policy, refund policy, support hours and contact channel.
10. **Code follow-ups.** CSP nonces instead of `'unsafe-inline'` scripts; fix the React Compiler lint warnings (`npm run lint`) and turn those rules back into errors; manual screen-reader testing.

## Going live (after the list above)

1. Set `PLATFORM_MODE=live` and remove `SANDBOX_OPERATOR_ACCESS` / `SANDBOX_SEED_DEMO` in Vercel → Settings → Environment Variables (Production).
2. Make sure `RECEIPT_ENCRYPTION_KEY`, Kavenegar (`KAVENEGAR_API_KEY` + `KAVENEGAR_OTP_TEMPLATE`), and CVC keys are set.
3. Run `npm run db:push` against the production database for any schema change (see DEPLOY.md, "Database changes").
4. Redeploy. The startup log must show `"event":"startup"` with `"mode":"live"` and no unexpected `startup.warning`.
5. Clear old sandbox cookies, open the site, verify phone with an admin number (`09203050405` / `09225006434`) to become owner, enroll TOTP, then confirm a normal customer gets 404 on `/admin`.

Live mode requires phone OTP to enter (no anonymous guest accounts). Staff phones become owner after OTP. Purchases/keys/admin work for signed-in users; staff see a platform-wide payment queue. Keep FX and destination card set in admin.
