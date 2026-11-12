# Production readiness

This page says what is ready, what is not, and the exact steps for a real launch.
Short version: the code is hardened and safe to host, but **real customers cannot sign up or pay yet**,
because SMS login, bank payments and the upstream API are not connected. The app does not fake any of them.

## What is in place

| Area | Status |
|---|---|
| Environment validation | `src/lib/env.ts`, run at startup by `src/instrumentation.ts`. A production server with a missing or malformed variable refuses to start and names the variable. Launch warnings (sandbox mode, operator access) are logged at startup. |
| Security headers | `next.config.ts`: strict same-origin CSP, HSTS (2 years, preload), nosniff, referrer and permissions policies, COOP/CORP, no `X-Powered-By`. Live mode also forbids framing. API routes are `no-store`. |
| Demo data | Sample balances, orders, keys and usage are only created by sandbox workspaces. In `PLATFORM_MODE=live` sandbox creation is closed, sandbox sessions are ignored and sandbox API keys are rejected, so no demo data can reach a live user. Keys are `sk_test_…` in sandbox and `sk_live_…` in live mode. |
| Customer/supplier boundary | Customers never see the upstream supplier. Customer UI, the customer data payload, `/v1` responses and error codes (`service_unavailable`) are supplier-neutral. Supplier state, balance and sync exist only in admin screens and admin routes. `npm run test:boundary` checks every customer page, the status dialog, the payload and `/v1`. |
| Admin isolation | Only staff roles (`owner`, `finance`, `support`, `viewer`) have an admin surface. Customers get 404 from every `/api/v1/admin/*` route (including the role switcher) and see no admin or PRD links. Admin mutations still need OTP + TOTP step-up. |
| Errors and logging | JSON-line logger (`src/lib/logger.ts`) with secret redaction. `onRequestError` logs every unhandled server error with route and digest. Persian error, global-error and 404 pages show a support code instead of a stack trace. |
| CI | `.github/workflows/ci.yml`: typecheck, lint, rules tests, production build, API suites, browser and accessibility suites, and the customer-boundary check, against a real Postgres. |

## What is still needed before real customers

These are business integrations and decisions. Each one needs an account, a contract or a credential that only you can provide.

1. **Real login.** An Iranian SMS provider (for example Kavenegar or SMS.ir) for OTP codes, plus a real sign-up flow that creates `demo = false` users with role `customer`. Today the only way into the app is an anonymous sandbox workspace.
2. **Staff accounts.** A way to create real `owner`/`finance`/`support` users (seed script or invite flow) with SMS OTP + TOTP. Today staff roles only exist in sandbox workspaces with `SANDBOX_OPERATOR_ACCESS=true`.
3. **Payments.** The verified destination bank account/card shown to customers, a statement reconciliation process (or an IPG such as ZarinPal/IDPay with webhook verification), and approved refund and transfer-deadline terms.
4. **Upstream API.** The written reseller agreement; `CVC_BASE_URL` (default `https://ru.cheapvibecode.ru`); `CVC_PRIMARY_API_KEY` (control plane) and `CVC_RUNTIME_API_KEY` (balance/models/dispatch). The client in `src/lib/cvc.ts` already calls `GET /v1/balance` and `GET /v1/models`. Still needed: confirm token↔credit mapping and multipliers, then replace the sandbox response in `src/lib/gateway-handler.ts` step 4 with real dispatch, streaming and crash reconciliation. Keep the fail-closed gate until metering matches CVC `cost_tokens`.
5. **Pricing source.** A trusted FX source and an approved package/price list (today: manual admin values).
6. **Storage.** Private object storage with malware scanning for receipts, and the legal retention period for receipts and financial records.
7. **Shared rate limiting and jobs.** Rate-limit buckets are in Postgres today; add a scheduled job (Vercel Cron) for releasing stale reservations, expiring lots and deleting usage metadata older than 365 days.
8. **Operations.** Backups and a tested restore on Neon, an error-alerting destination (Vercel log drain or Sentry), a custom domain, and turning off Vercel Authentication for that domain.
9. **Legal and content.** Terms of service, privacy policy, refund policy, support hours and contact channel.
10. **Code follow-ups.** CSP nonces instead of `'unsafe-inline'` scripts; fix the React Compiler lint warnings (`npm run lint`) and turn those rules back into errors; manual screen-reader testing.

## Going live (after the list above)

1. Set `PLATFORM_MODE=live` and remove `SANDBOX_OPERATOR_ACCESS` in Vercel → Settings → Environment Variables (Production).
2. Make sure `RECEIPT_ENCRYPTION_KEY` is set and backed up. Never change it after data exists.
3. Run `npm run db:push` against the production database for any schema change (see DEPLOY.md, "Database changes").
4. Redeploy. The startup log must show `"event":"startup"` with `"mode":"live"` and no `startup.warning` you did not expect.
5. Check `/api/health`, then sign in as a real customer and as staff, and confirm a customer gets 404 on `/admin`.

Until all of that is done, keep the hosted app in `sandbox` mode (the default) and treat it as a demo.
