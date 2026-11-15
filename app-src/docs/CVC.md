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
2. Upstream CVC credentials (`platform_upstream_key_creds`):
   - **Budgeted (capped) PanaAI key** → its **own** delegated CVC key with `token_limit` from that budget (hard-capped by `system.cvcDelegatedTokenCap`).
   - **No-budget PanaAI keys** of the same user → **one shared** CVC key sized to **unallocated** credits.
   - Usage/analytics still log the **PanaAI key name**, so uncapped keys stay distinguishable in our UI.
   - Rotate only replaces the PanaAI secret (capped CVC row is relinked). Top-up / create / revoke / budget changes sync the **shared** CVC limit: grow via `additional_tokens`, shrink via `token_limit`. Legacy unlimited shared keys (missing local `tokenLimit`, or CVC `unlimited_token_limit`) are **reminted** with a hard cap; remint **aborts** (rolls back the new mint) unless the old remote key is deleted — so we never intentionally leave two active shared keys. If CVC’s panel still shows a reminted `previousPrefix`, delete that orphan manually and keep the active shared prefix.
   - Revoke (or cap→uncapped) **deletes** the capped CVC key remotely (falls back to `active: false`). Shared only **grows** after a successful remote delete (frozen/failed revoke never raises shared — avoids double-issuing against CVC primary).
   - **Never mint unlimited** CVC keys — size follows wallet/budget with a high safety ceiling (`cvcDelegatedTokenCap`, default 100M).
3. `CVC_PRIMARY_API_KEY` is for **management** (mint delegated keys, catalog sync, platform balance/coverage). It is never used as the shared chat runtime key for all customers.
4. `system.creditsPerUsd` (default 20M) is the customer purchase rate. `system.upstreamTokensPerUsd` (default 25M) is admin-only wholesale. `system.creditsPerCvcToken` (default 1) converts upstream `cost_tokens` into customer credits. `system.cvcDelegatedTokenCap` is a safety ceiling, not the normal sizing rule.
5. Streaming (`stream: true`) is rejected until SSE settlement is implemented.
6. Admin **financial audit** (`POST admin/wallet/financial-audit`) returns a clear PASS/FAIL per separated bucket so fishy mismatches stand out: soft allocation identity, spend↔usage, FEFO lots/holds, journal, approved orders↔lots, refund reversals, and CVC shape. It only releases stale holds; it does not auto-correct balances.

## Soft-allocation example (must stay true)

Wallet available **20M**. Create capped budget **5M** → unallocated **15M** (shared CVC sized ~15M). Spend **1M** on the capped key → available **19M**, unallocated still **15M**. Revoke the capped key → unallocated **19M** and shared CVC rises by ~4M (after remote delete of the capped CVC).

## Operator drill (button)

Admin → مالی → **آزمون کلی CVC**: creates A (capped 5M), B (uncapped), C (capped 2M), mints CVC keys, runs a tiny live `"hi"` on A (real `cost_tokens`, not a fake 1M debit), removes C, revokes A, then shows a checklist with real `pana-…` / CVC prefixes. After the run only shared B should remain on CVC (A/C are deleted by design). Automated asserts: `scripts/cvc-finance-check.mjs`.

### Drill expectations (verified live)

| Check | Expect |
|---|---|
| Spend | Tiny real `"hi"` credits (e.g. ~39), **never** a fake 1M debit |
| A / C on CVC | Minted mid-run, then **deleted** — do not expect them after the checklist finishes |
| B on CVC | Shared uncapped key stays; may be `new=false` if reused |
| Shared `tokenLimit` | Numeric, ≥ final unallocated. Blank `—` meant sync failed |
| Pass bar | 10/10 (includes orphan-hint row after remint) |

### Live findings (keep these true)

1. **`unlimited_token_limit`** — CVC rejects absolute `token_limit` edits on legacy unlimited shared keys. Fix path: **remint** a capped shared key (`syncSharedUncappedLimit` → `remintSharedUncapped`). Grow afterward uses `additional_tokens` only.
2. **Two shared keys on the CVC panel** — remint creates a new prefix and records `meta.previousPrefix`. If the panel still lists the old key, **keep the active shared** (Token B / current prefix, limit ≈ unallocated) and **manually delete** `previousPrefix`. Remint now aborts + rolls back the new mint if the old key cannot be deleted.
3. **Soft-allocation identity** — capped spend does not shrink unallocated; revoking capped keys after remote delete raises unallocated and the shared limit.
4. **Production** — `PLATFORM_MODE=live` on `panaai-psi.vercel.app`; schema defaults are non-demo (`name=کاربر`, `demo=false`, `role=customer`).

## Panacode connect (PanaAI half)

Merged on master: `/connect/panacode` + `POST /api/v1/connect/panacode/*` (session → attach → complete → loopback `code` → `exchange` for `pana-…` secret). Desktop companion is the Panacode fork of OpenCode (`arashmakkyy/panacode`); it must use **separate** config/data dirs from upstream OpenCode (e.g. `~/.panacode`, not `~/.opencode`).

## Still required for a full commercial launch

1. Confirm live balance/meter on the reseller account and keep admin rates (`creditsPerUsd` / `upstreamTokensPerUsd`) aligned with invoices.
2. Real SMS login, bank destination, and staff accounts (see `docs/PRODUCTION.md`).
3. Optional: streaming proxy, deeper crash reconciliation against `GET /v1/keys/logs`, and operator retry queue when a remote CVC edit fails.
4. Ship installable **Panacode** builds (CLI/desktop) with path isolation from OpenCode + Sign in with PanaAI against production.
