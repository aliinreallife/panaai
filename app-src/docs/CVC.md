# CheapVibeCode reseller integration

PanaAI sits in front of CheapVibeCode (CVC). Customers never see CVC names, balances or keys.

## Credentials

| Env | Role |
|---|---|
| `CVC_BASE_URL` | API origin **without** `/v1` (default `https://ru.cheapvibecode.ru`) |
| `CVC_PRIMARY_API_KEY` | **One key is enough** — management, catalog (`/v1/models`), balance and runtime |
| `CVC_RUNTIME_API_KEY` | Optional later override if you split runtime from primary |

Legacy: `CVC_BALANCE_URL` + `CVC_API_KEY` still work as a balance override.

Never put the CVC key in the browser, logs or customer responses. Redact `sk-cvc-…` to a short prefix in diagnostics.

## What is wired today

- `src/lib/cvc.ts` — balance/models/keys + JSON proxy for chat/completions and responses
- `src/lib/provider.ts` — live balance observation
- `src/lib/gateway-handler.ts` — FEFO reserve → CVC proxy → settle from `cost_tokens × creditsPerCvcToken`
- **Platform-owned catalog** in `platform_state` (`src/lib/models.ts`): customers see PanaAI’s snapshot, not a live upstream dump on every page load
- Catalog refresh ~hourly on traffic (stale snapshot) + on admin sync + inside daily maintenance; `GET /api/cron/catalog` exists for Pro/external hourly cron (`CRON_SECRET`)
- After **2 consecutive sync failures**, operators get an alert (dashboard / Telegram / email channels)
- Daily cron `GET /api/cron/maintenance` at 03:00 UTC (needs `CRON_SECRET`; Hobby plan allows one run/day) releases stale reservations, purges old usage, and syncs the catalog
- Sandbox simulator remains the default; set `CVC_LIVE_DISPATCH=true` (or `PLATFORM_MODE=live` with a key) to proxy for real

## Architecture (MVP)

1. Customers buy **PanaAI internal credits**; FEFO lots, limits, unused balance and platform API keys stay local.
2. Creating (or rotating) a PanaAI platform API key in live mode **always mints a fresh** delegated CVC upstream key (so a new row appears in the CVC keys UI) and stores it encrypted in `platform_upstream_credentials`. The gateway uses the wallet’s latest credential on `/v1` chat; it mints on first use only if create-time provisioning was skipped (e.g. no `CVC_PRIMARY_API_KEY`).
3. `CVC_PRIMARY_API_KEY` is for **management** (mint delegated keys, catalog sync, platform balance/coverage). It is never used as the shared chat runtime key for all customers.
4. `system.creditsPerUsd` (default 20M) is the customer purchase rate. `system.upstreamTokensPerUsd` (default 25M) is admin-only wholesale. `system.creditsPerCvcToken` (default 1) converts upstream `cost_tokens` into customer credits.
5. Streaming (`stream: true`) is rejected until SSE settlement is implemented.

## Still required for a full commercial launch

1. Confirm live balance/meter on the reseller account and keep admin rates (`creditsPerUsd` / `upstreamTokensPerUsd`) aligned with invoices.
2. Real SMS login, bank destination, and staff accounts (see `docs/PRODUCTION.md`).
3. Optional: rotate/revoke delegated upstream keys from admin, streaming proxy, deeper crash reconciliation against `GET /v1/keys/logs`.
