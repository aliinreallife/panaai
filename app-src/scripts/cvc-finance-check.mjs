// Soft-allocation + CVC sizing/finance regression checks (no live network required).
import assert from "node:assert/strict";

const r = await import("../src/lib/rules.ts");
const c = await import("../src/lib/cvc.ts");
const pass = (n) => console.log(`PASS ${n}`);

const settings = { ...r.SYSTEM_DEFAULTS };
assert.ok(settings.cvcDelegatedTokenCap >= 100_000_000, "default CVC safety cap should cover large wallets");

// --- Soft-allocation scenario the product must never break ---
// Wallet 20M → capped 5M → unallocated 15M
// Spend 1M on capped → available 19M, unallocated still 15M
// Revoke capped → unallocated 19M (shared must rise ~+4M after remote delete)
{
  let available = 20_000_000;
  const keys = [];
  const snapshot = () => {
    const allocated = r.sumKeyAllocations(keys);
    return { available, allocated, unallocated: r.unallocatedCredits(available, allocated) };
  };

  keys.push({ budget: 5_000_000, spent: 0, enabled: true });
  let pool = snapshot();
  assert.equal(pool.allocated, 5_000_000);
  assert.equal(pool.unallocated, 15_000_000);
  assert.equal(r.desiredSharedTokenLimit(pool.unallocated, 0, settings), 15_000_000);

  // Spend 1M against the capped key (wallet FEFO).
  available -= 1_000_000;
  keys[0].spent = 1_000_000;
  pool = snapshot();
  assert.equal(pool.available, 19_000_000);
  assert.equal(pool.allocated, 4_000_000);
  assert.equal(pool.unallocated, 15_000_000);
  assert.equal(r.desiredSharedTokenLimit(pool.unallocated, 0, settings), 15_000_000);

  // Revoke capped key → frees remaining earmark; uncapped pool rises 15 → 19.
  keys[0].enabled = false;
  pool = snapshot();
  assert.equal(pool.allocated, 0);
  assert.equal(pool.unallocated, 19_000_000);
  assert.equal(r.desiredSharedTokenLimit(pool.unallocated, 0, settings), 19_000_000);
  // If shared already used 2M tokens, lifetime becomes used + remaining.
  assert.equal(r.desiredSharedTokenLimit(pool.unallocated, 2_000_000, settings), 21_000_000);
  pass("20M wallet → capped 5M → spend 1M → revoke raises unallocated 15→19");
}

// Capped lifetime is absolute budget — never tokensUsed + budget after spend.
assert.equal(r.desiredCappedTokenLimit(5_000_000, 0, settings), 5_000_000);
assert.equal(r.desiredCappedTokenLimit(5_000_000, 1_000_000, settings), 5_000_000);
assert.equal(r.desiredCappedTokenLimit(5_000_000, 5_000_000, settings), 5_000_001);
pass("capped CVC limit stays absolute after spend (no over-issue)");

// Large uncapped pool is no longer crushed by the old 5M default.
assert.equal(r.resolveCvcTokenLimit(20_000_000, settings), 20_000_000);
assert.equal(r.resolveCvcTokenLimit(80_000_000, settings), 80_000_000);
assert.equal(r.resolveCvcTokenLimit(null, settings), settings.cvcDelegatedTokenCap);
pass("shared/uncapped sizing tracks wallet up to safety ceiling");

// Concurrent earmark identity: two capped creates cannot exceed available.
{
  const available = 10_000_000;
  const first = { budget: 6_000_000, spent: 0, enabled: true };
  const freeAfterFirst = r.unallocatedCredits(available, r.sumKeyAllocations([first]));
  assert.equal(freeAfterFirst, 4_000_000);
  assert.ok(7_000_000 > freeAfterFirst, "second 7M budget must be rejected");
  pass("allocation identity blocks oversubscribe");
}

// Remote revoke must free CVC capacity before shared may grow (no double-issue).
assert.equal(r.remoteRevokeFreesUpstreamPool("deleted"), true);
assert.equal(r.remoteRevokeFreesUpstreamPool("missing"), true);
assert.equal(r.remoteRevokeFreesUpstreamPool("skipped"), true);
assert.equal(r.remoteRevokeFreesUpstreamPool("frozen"), false);
assert.equal(r.remoteRevokeFreesUpstreamPool("failed"), false);
pass("shared grow gated on remote capped delete");

// Creating a second capped key shrinks the shared pool target.
{
  const available = 20_000_000;
  const keys = [
    { budget: 5_000_000, spent: 0, enabled: true },
    { budget: null, spent: 0, enabled: true },
  ];
  assert.equal(r.desiredSharedTokenLimit(r.unallocatedCredits(available, r.sumKeyAllocations(keys)), 0, settings), 15_000_000);
  keys.push({ budget: 3_000_000, spent: 0, enabled: true });
  assert.equal(r.desiredSharedTokenLimit(r.unallocatedCredits(available, r.sumKeyAllocations(keys)), 0, settings), 12_000_000);
  pass("extra capped earmark shrinks shared target");
}

// --- Mocked CVC control-plane: create + delete payloads ---
const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ url: String(url), method: init.method || "GET", body });
  if (String(url).endsWith("/v1/keys") && init.method === "POST") {
    return {
      ok: true,
      status: 201,
      json: async () => ({ key: "sk-cvc-test-created-key-abcdefghijklmnopqrstuvwxyz", meta: { id: "ck_1", token_limit: body.token_limit, tokens_used: 0 } }),
      text: async () => "",
    };
  }
  if (String(url).endsWith("/v1/keys/edit") && init.method === "POST") {
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: body.delete ? "deleted" : "ok", meta: { token_limit: body.token_limit ?? 0, tokens_used: 0 } }),
      text: async () => "",
    };
  }
  return { ok: false, status: 500, json: async () => ({}), text: async () => "unexpected" };
};

try {
  const cfg = {
    baseUrl: "https://cvc.test",
    primaryKey: "sk-cvc-primary",
    runtimeKey: "sk-cvc-primary",
    legacyBalanceUrl: null,
    legacyApiKey: null,
  };
  const minted = await c.createDelegatedKey({ name: "pana-shared-demo", token_limit: 19_000_000 }, cfg);
  assert.equal(minted.ok, true);
  assert.equal(minted.data.key.startsWith("sk-cvc-"), true);
  assert.equal(calls.at(-1).body.token_limit, 19_000_000);
  assert.equal(calls.at(-1).body.token_limit == null, false);

  const deleted = await c.editDelegatedKey({ key: minted.data.key, delete: true }, cfg);
  assert.equal(deleted.ok, true);
  assert.equal(calls.at(-1).body.delete, true);
  assert.equal(Object.keys(calls.at(-1).body).includes("additional_tokens"), false);

  const grown = await c.editDelegatedKey({ key: minted.data.key, additional_tokens: 4_000_000 }, cfg);
  assert.equal(grown.ok, true);
  assert.equal(calls.at(-1).body.additional_tokens, 4_000_000);

  const shrunk = await c.editDelegatedKey({ key: minted.data.key, token_limit: 15_000_000 }, cfg);
  assert.equal(shrunk.ok, true);
  assert.equal(calls.at(-1).body.token_limit, 15_000_000);
  pass("CVC create / delete / additional_tokens / token_limit edit payloads");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("All CVC finance checks passed.");
