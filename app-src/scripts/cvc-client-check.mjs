// Unit checks for the CVC reseller client helpers (no network).
import assert from "node:assert/strict";
const c = await import("../src/lib/cvc.ts");
const pass = (n) => console.log(`PASS ${n}`);

assert.equal(c.CVC_DEFAULT_BASE_URL, "https://ru.cheapvibecode.ru");
assert.equal(c.cvcBalanceUrl({ baseUrl: "https://ru.cheapvibecode.ru", primaryKey: null, runtimeKey: "sk", legacyBalanceUrl: null, legacyApiKey: null }), "https://ru.cheapvibecode.ru/v1/balance");
assert.equal(c.cvcModelsUrl({ baseUrl: "https://cheapvibecode.ru", primaryKey: null, runtimeKey: "sk", legacyBalanceUrl: null, legacyApiKey: null }), "https://cheapvibecode.ru/v1/models");
assert.equal(c.cvcBalanceConfigured({ baseUrl: "x", primaryKey: null, runtimeKey: null, legacyBalanceUrl: null, legacyApiKey: null }), false);
assert.equal(c.cvcBalanceConfigured({ baseUrl: "x", primaryKey: "p", runtimeKey: "r", legacyBalanceUrl: null, legacyApiKey: null }), true);
assert.equal(c.cvcBalanceConfigured({ baseUrl: "x", primaryKey: null, runtimeKey: null, legacyBalanceUrl: "https://example.test/bal", legacyApiKey: "k" }), true);
const primaryOnly = c.cvcConfig({ CVC_PRIMARY_API_KEY: "sk-cvc-primary-only" });
assert.equal(primaryOnly.primaryKey, "sk-cvc-primary-only");
assert.equal(primaryOnly.runtimeKey, "sk-cvc-primary-only");
assert.equal(c.cvcBalanceConfigured(primaryOnly), true);
pass("CVC URL and config helpers");

assert.equal(c.parseCvcBalance({ balance: 1250000 }), 1250000);
assert.equal(c.parseCvcBalance({ tokens: 42 }), 42);
assert.equal(c.parseCvcBalance({ available_tokens: "99" }), 99);
assert.equal(c.parseCvcBalance({ balance: { tokens: 7 } }), 7);
assert.equal(c.parseCvcBalance({ data: { balance: 3 } }), 3);
assert.equal(c.parseCvcBalance({ balance: -1 }), null);
assert.equal(c.parseCvcBalance({ balance: 1.5 }), null);
assert.equal(c.parseCvcBalance({}), null);
pass("balance JSON shapes");

assert.deepEqual(c.parseCvcModels({ data: [{ id: "gpt-5.6-terra", multiplier: 1.2 }, { id: " " }, { foo: 1 }] }).map((m) => m.id), ["gpt-5.6-terra"]);
assert.equal(c.parseCvcModels({ models: [{ id: "claude-sonnet-5", base_multiplier: 3 }] })[0].base_multiplier, 3);
assert.deepEqual(c.parseCvcModels(null), []);
pass("model list parsing");

assert.equal(c.redactSecret("sk-cvc-plaintext-secret"), "sk-cvc-p…cret");
assert.equal(c.redactSecret("short"), "shor…");
assert.equal(c.redactSecret(null), null);

const cfg = c.cvcConfig({
  CVC_BASE_URL: "https://ru.cheapvibecode.ru/",
  CVC_RUNTIME_API_KEY: " sk-runtime ",
  CVC_PRIMARY_API_KEY: "",
});
assert.equal(cfg.baseUrl, "https://ru.cheapvibecode.ru");
assert.equal(cfg.runtimeKey, "sk-runtime");
assert.equal(cfg.primaryKey, null);
pass("env trimming and redaction");

console.log("All CVC client checks passed.");
