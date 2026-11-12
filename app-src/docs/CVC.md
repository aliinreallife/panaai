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
- Admin **بررسی دوباره وضعیت** also syncs `GET /v1/models` into `cvc:catalog`
- Daily cron `GET /api/cron/maintenance` at 03:00 UTC (needs `CRON_SECRET`; Hobby plan allows one run/day) releases stale reservations and deletes usage metadata older than 365 days
- Sandbox simulator remains the default; set `CVC_LIVE_DISPATCH=true` (or `PLATFORM_MODE=live` with a key) to proxy for real

## Architecture (MVP)

1. Customers buy **PanaAI internal credits**; FEFO lots and platform API keys stay local.
2. One platform CVC key funds upstream capacity; coverage compares CVC balance to outstanding customer credits.
3. `system.creditsPerCvcToken` (default 1) converts CVC billed tokens into internal credits.
4. Streaming (`stream: true`) is rejected until SSE settlement is implemented.

## Still required for a full commercial launch

1. Written reseller authorization and confirmed markup (`creditsPerCvcToken` / package FX).
2. Real SMS login, bank destination, and staff accounts (see `docs/PRODUCTION.md`).
3. Optional: streaming proxy + deeper crash reconciliation against `GET /v1/keys/logs`.
