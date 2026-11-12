// Integration checks for reservations/settlement, provider state machine, RBAC + MFA,
// refunds, packages, suspension and Retry-After. Run against a running preview.
import assert from 'node:assert/strict';
import { elevateAdmin, totpAt } from './admin-auth.mjs';
const base = process.env.TEST_BASE_URL || 'http://localhost:3000';
const client = { cookie: '' };
async function call(c, path, body, method = body ? 'POST' : 'GET', extra = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(c?.cookie ? { cookie: c.cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie'); if (c && setCookie) c.cookie = setCookie.split(';')[0];
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data, headers: res.headers };
}
const pass = name => console.log(`PASS ${name}`);
const api = (path, body, method) => call(client, `/api/v1/${path}`, body, method);
const reason = 'Automated operations integration check.';

const boot = await api('bootstrap', undefined, 'POST'); assert.equal(boot.status, 200);
const { secret } = await elevateAdmin(client, call);
const reused = await api('admin/mfa/elevate', { code: totpAt(secret, Date.now() + 30000) }); assert.equal(reused.status, 400); assert.equal(reused.data.code, 'invalid_totp');
pass('TOTP codes are single use (replay rejected)');

// ---- Retry-After on rate limits
const otpAgain = await api('auth/otp/request', { phone: '09120000000' }); assert.equal(otpAgain.status, 429); assert.ok(Number(otpAgain.headers.get('retry-after')) > 0); assert.ok(otpAgain.data.retryAfter > 0);
pass('rate-limited responses carry Retry-After');

// ---- Concurrent reservations never exceed a key budget
const key = await api('keys', { name: 'Concurrency budget key', budget: 200000, rateLimit: 300, allowedModels: [] }); assert.equal(key.status, 201);
const auth = { authorization: `Bearer ${key.data.secret}` };
const before = (await api('data')).data;
const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => call(null, '/v1/chat/completions', { model: 'gpt-4o', max_tokens: 200, messages: [{ role: 'user', content: `concurrency ${i}` }] }, 'POST', auth)));
const ok = burst.filter(r => r.status === 200); const refused = burst.filter(r => r.status !== 200);
assert.ok(ok.length > 0); assert.ok(refused.every(r => r.status === 403 && r.data.error.code === 'key_budget_exceeded'), JSON.stringify(refused.map(r => r.data)));
const charged = ok.reduce((a, r) => a + r.data.usage.platform_credits, 0);
const afterBurst = (await api('data')).data;
const keyRow = afterBurst.keys.find(k => k.id === key.data.id);
assert.ok(keyRow.spent <= 200000); assert.equal(keyRow.spent, charged);
assert.equal(afterBurst.wallet.available, before.wallet.available - charged); assert.equal(afterBurst.wallet.reserved, 0);
pass(`30 concurrent requests: ${ok.length} settled, ${refused.length} refused, key budget never exceeded`);

// ---- Wallet cannot be overdrawn by concurrent requests
// Clear every soft earmark (test key + seeded budgeted keys) so the uncapped key owns the free pool.
for (const row of afterBurst.keys.filter(k => k.enabled && k.budget != null)) {
  const revoked = await api(`keys/${row.id}/revoke`, undefined, 'POST');
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
}
const afterRevoke = (await api('data')).data;
assert.equal(afterRevoke.wallet.allocated, 0, JSON.stringify(afterRevoke.wallet));
const drain = await api('admin/wallet/adjust', { amount: -(afterRevoke.wallet.available - 100000), reason }); assert.equal(drain.status, 200, JSON.stringify(drain.data));
const key2 = await api('keys', { name: 'Overdraw key', budget: null, rateLimit: 300, allowedModels: [] });
assert.equal(key2.status, 201, JSON.stringify(key2.data));
const auth2 = { authorization: `Bearer ${key2.data.secret}` };
const burst2 = await Promise.all(Array.from({ length: 20 }, (_, i) => call(null, '/v1/chat/completions', { model: 'gpt-4o', max_tokens: 200, messages: [{ role: 'user', content: `overdraw ${i}` }] }, 'POST', auth2)));
const ok2 = burst2.filter(r => r.status === 200);
const refused2 = burst2.filter(r => r.status !== 200);
assert.ok(ok2.length > 0, JSON.stringify(burst2.map(r => ({ status: r.status, code: r.data?.error?.code }))));
assert.ok(refused2.every(r =>
  (r.status === 402 && r.data.error?.code === 'insufficient_credits')
  || (r.status === 403 && r.data.error?.code === 'unallocated_exceeded')
), JSON.stringify(refused2.map(r => ({ status: r.status, code: r.data?.error?.code }))));
const charged2 = ok2.reduce((a, r) => a + r.data.usage.platform_credits, 0);
const drained = (await api('data')).data;
assert.equal(drained.wallet.available, 100000 - charged2); assert.ok(drained.wallet.available >= 0);
pass(`no overdraft: ${ok2.length} of 20 admitted with 100,000 credits available`);
const recon = await api('admin/wallet/reconcile', {}); assert.equal(recon.status, 200); assert.equal(recon.data.ok, true, JSON.stringify(recon.data));
pass('reconciliation: lots, reservations and journal balance');
await api('admin/wallet/adjust', { amount: 50000000, reason });

// ---- Provider state machine: grace → zero → resuming → healthy
assert.equal((await api('admin/provider/sync', {})).data.state, 'healthy');
const grace = await api('admin/provider/simulate', { balance: 0, reason }); assert.equal(grace.data.state, 'grace'); assert.ok(grace.data.graceUntil);
const inGrace = await call(null, '/v1/chat/completions', { model: 'gpt-4o', max_tokens: 50, messages: [{ role: 'user', content: 'grace' }] }, 'POST', auth2); assert.equal(inGrace.status, 200);
const systemBody = { transferHours: 24, graceMinutes: 0, lowBalanceCredits: 2000000, maxKeys: 20, creditsPerCvcToken: 1, creditsPerUsd: 20000000, upstreamTokensPerUsd: 25000000, cvcDelegatedTokenCap: 5000000, reason };
await api('admin/system', systemBody, 'PUT');
await api('admin/provider/simulate', { balance: 1000000000, reason });
await api('admin/provider/sync', {});
const zero = await api('admin/provider/simulate', { balance: 0, reason }); assert.equal(zero.data.state, 'zero');
const stopped = await call(null, '/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'zero' }] }, 'POST', auth2); assert.equal(stopped.status, 503); assert.equal(stopped.headers.get('retry-after'), '60');
const quoteWhileZero = await api('quotes', { amountToman: 90000 }); assert.equal(quoteWhileZero.status, 201);
const back = await api('admin/provider/simulate', { balance: 1000000000, reason }); assert.equal(back.data.state, 'resuming');
assert.equal((await api('admin/provider/sync', {})).data.state, 'healthy');
const outage = await api('admin/provider/simulate', { balance: null, outage: true, reason }); assert.equal(outage.data.state, 'unverified'); // grace is 0 minutes here
assert.equal((await call(null, '/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'stale' }] }, 'POST', auth2)).status, 503);
await api('admin/provider/simulate', { balance: 1000000000, reason }); await api('admin/provider/sync', {});
await api('admin/system', { ...systemBody, graceMinutes: 5 }, 'PUT');
const staleGrace = await api('admin/provider/simulate', { balance: null, outage: true, reason }); assert.equal(staleGrace.data.state, 'grace');
assert.equal((await api('admin/provider/sync', {})).data.state, 'grace');
assert.equal((await api('admin/provider/simulate', { balance: 1000000000, reason })).data.state, 'resuming'); assert.equal((await api('admin/provider/sync', {})).data.state, 'healthy');
const alerts = await api('admin/alerts'); assert.ok(alerts.data.alerts.some(a => a.kind === 'provider.zero' && a.deliveries[0].status === 'sent'));
await api('admin/channels', { telegram: true, telegramChatId: '-100123', email: true, emailTo: 'ops@example.com' }, 'PUT');
const test = await api('admin/alerts/test', {}); assert.deepEqual(test.data.deliveries.map(d => `${d.channel}:${d.status}`), ['dashboard:sent', 'telegram:not_configured', 'email:not_configured']);
pass('provider: grace admits, zero/stale stops API but not sales, fresh positive balance resumes, alerts recorded per channel');

// ---- RBAC
assert.equal((await api('admin/role', { role: 'viewer' })).status, 200);
const denied = await api('admin/system', { ...systemBody, graceMinutes: 5 }, 'PUT'); assert.equal(denied.status, 403); assert.equal(denied.data.code, 'forbidden_role');
assert.equal((await api('admin/provider')).status, 200);
assert.equal((await api('admin/role', { role: 'support' })).status, 200);
assert.equal((await api('admin/wallet/adjust', { amount: 1, reason })).status, 403);
assert.equal((await api('admin/role', { role: 'owner' })).status, 200);
assert.equal((await api('admin/unknown-route', {})).status, 404);
pass('RBAC enforced server-side for viewer/support; unknown admin routes denied');

// ---- Refunds
const order = boot.data.orders.find(o => o.state === 'approved_and_credited' && boot.data.lots.find(l => l.orderId === o.id && l.remaining > 9000000));
const refund = await api('refunds', { orderId: order.id, reason }); assert.equal(refund.status, 201, JSON.stringify(refund.data));
assert.equal((await api('refunds', { orderId: order.id, reason })).status, 409);
const preRefund = (await api('data')).data;
assert.equal((await api(`admin/refunds/${refund.data.id}/paid`, { note: reason, payoutReference: 'PAY-1234' })).status, 409);
assert.equal((await api(`admin/refunds/${refund.data.id}/approve`, { note: reason })).status, 200);
const postRefund = (await api('data')).data;
assert.equal(postRefund.wallet.available, preRefund.wallet.available - refund.data.credits);
assert.ok(postRefund.events.some(e => e.type === 'refund_reversal' && e.delta === -refund.data.credits));
assert.equal((await api(`admin/refunds/${refund.data.id}/paid`, { note: reason })).status, 400);
assert.equal((await api(`admin/refunds/${refund.data.id}/paid`, { note: reason, payoutReference: 'PAY-1234' })).data.state, 'paid');
assert.equal((await api('admin/wallet/reconcile', {})).data.ok, true);
pass('refund: request → approve (compensating reversal) → paid with payout reference');

// ---- Packages and system settings
assert.equal((await api('admin/packages', { label: 'خیلی بزرگ', subtitle: '', amountToman: 999999999, icon: 'zap', featured: false, active: true, sort: 9, reason })).status, 400);
assert.equal((await api('admin/packages', { label: 'ویژه', subtitle: 'آزمون', amountToman: 250000, icon: 'zap', featured: true, active: true, sort: 9, reason })).status, 200);
const withPkg = (await api('data')).data; assert.ok(withPkg.packages.some(p => p.label === 'ویژه' && p.featured)); assert.equal(withPkg.packages.filter(p => p.featured).length, 1);
await api('admin/system', { ...systemBody, transferHours: 6, graceMinutes: 5 }, 'PUT');
const q = await api('quotes', { amountToman: 90000 }); const o = await api('orders', { quoteId: q.data.id });
const hours = (new Date(o.data.transferDeadline) - new Date(o.data.createdAt)) / 3600000; assert.ok(Math.abs(hours - 6) < 0.01);
pass('admin-managed packages and transfer deadline apply to new orders');

// ---- Suspension
assert.equal((await api('admin/users/state', { state: 'suspended', reason })).status, 200);
assert.equal((await call(null, '/v1/chat/completions', { model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }, 'POST', auth2)).status, 403);
assert.equal((await api('quotes', { amountToman: 90000 })).data.code, 'account_suspended');
assert.equal((await api('admin/users/state', { state: 'active', reason })).status, 200);
assert.equal((await call(null, '/v1/chat/completions', { model: 'gpt-4o', max_tokens: 20, messages: [{ role: 'user', content: 'x' }] }, 'POST', auth2)).status, 200);
pass('suspension blocks API and new orders; reactivation restores them');
console.log('\nAll operations checks passed. Upstream responses are simulated; no real CVC, bank, SMS, Telegram or email traffic was sent.');
