# CheapVibeCode reseller integration

PanaAI sits in front of CheapVibeCode (CVC). Customers never see CVC names, balances or keys.

## Credentials

| Env | Role |
|---|---|
| `CVC_BASE_URL` | API origin **without** `/v1` (default `https://ru.cheapvibecode.ru`) |
| `CVC_PRIMARY_API_KEY` | Reseller control plane: create/edit/transfer/delete delegated keys |
| `CVC_RUNTIME_API_KEY` | Delegated customer key: balance, models, runtime inference |

Legacy: `CVC_BALANCE_URL` + `CVC_API_KEY` still work as a balance override.

Never put the primary key in the browser, logs or customer responses. Redact `sk-cvc-…` to a short prefix in diagnostics.

## What is wired today

- `src/lib/cvc.ts` — URL helpers, balance/model parsers, `GET /v1/balance`, `GET /v1/models`, `POST /v1/keys`
- `src/lib/provider.ts` — live balance observation uses the client above
- Sandbox still uses the admin simulator
- Live **inference** in `gateway-handler.ts` remains fail-closed until metering is verified

## Architecture (MVP)

1. Customers buy **PanaAI internal credits**; FEFO lots and platform API keys stay local.
2. One platform CVC runtime key funds upstream capacity; coverage compares CVC balance to outstanding customer credits.
3. Optional later: map each PanaAI key to a CVC delegated key via `POST /v1/keys` (needs primary key).

## Still required before live dispatch

1. Written reseller authorization.
2. Confirm how CVC `cost_tokens` / balance tokens map to PanaAI credits (and model multipliers from `GET /v1/models` or public pricing).
3. A real (redacted) sample of `GET /v1/balance` and `GET /v1/models` JSON to lock the parsers.
4. Streaming + crash reconciliation against CVC usage logs before opening the fail-closed gate.
