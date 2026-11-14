// Customers must never see the upstream supplier: no supplier name, "upstream", simulator wording,
// provider state/balance, or admin surface in customer pages, customer API payloads or the public /v1 API.
// Run against a server WITHOUT SANDBOX_OPERATOR_ACCESS (the default). With operator access it only checks /v1.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const root = process.env.TEST_BASE_URL || 'http://localhost:3000';
const FORBIDDEN = /\bcvc\b|upstream|supplier|simulat|sandbox[-_ ]simulator|تأمین‌کننده|تامین‌کننده|تأمین کننده|شبیه‌ساز|شبیه‌سازی|بالادست|"provider"/i;
const leak = (label, text) => { const m = String(text).match(FORBIDDEN); assert.equal(m, null, `${label} leaks "${m?.[0]}" near: ${m ? String(text).slice(Math.max(0, m.index - 60), m.index + 60) : ''}`); };
let cookie = '';
const ip = `10.9.${Date.now() % 250}.${Math.floor(Math.random() * 250)}`;
async function api(path, body, method) {
  const r = await fetch(`${root}/api/v1/${path}`, { method: method || (body ? 'POST' : 'GET'), headers: { 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, text };
}
const boot = await api('bootstrap', {});
assert.equal(boot.status, 200, boot.text);
const customer = !boot.data.account.operator;

// Public /v1 API: same contract for every account.
// Soft allocation: budget cannot exceed unallocated credits (seeded sandbox keys may already earmark some).
const snapshot = await api('data');
assert.equal(snapshot.status, 200, snapshot.text);
const free = Number(snapshot.data.wallet?.unallocated ?? snapshot.data.wallet?.available ?? 0);
const key = await api('keys', {
  name: 'boundary check',
  budget: free >= 1000000 ? 1000000 : null,
  rateLimit: 60,
  allowedModels: [],
});
assert.equal(key.status, 201, key.text);
const auth = { authorization: `Bearer ${key.data.secret}`, 'content-type': 'application/json' };
const models = await fetch(`${root}/v1/models`, { headers: auth }); const modelsText = await models.text();
leak('/v1/models', modelsText); assert.ok(!('metadata' in JSON.parse(modelsText)), '/v1/models must not expose internal metadata');
const chat = await fetch(`${root}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }) });
leak('/v1/chat/completions', await chat.text());
const bad = await fetch(`${root}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
leak('/v1 error', await bad.text());
console.log('PASS public /v1 responses never mention the supplier');

if (!customer) { console.log('SKIP customer UI checks: server runs with SANDBOX_OPERATOR_ACCESS=true'); process.exit(0); }

leak('customer data payload', boot.text);
assert.equal(boot.data.provider, undefined, 'customer payload must not carry a provider object');
for (const [path, body] of [['admin/security'], ['admin/audit'], ['admin/orders'], ['admin/role', { role: 'owner' }], ['admin/provider/simulate', { balance: 0, reason: 'boundary check attempt' }]]) {
  const r = await api(path, body);
  assert.equal(r.status, 404, `${path} should be invisible to customers, got ${r.status}`);
}
console.log('PASS customer payload is clean and every admin route answers 404');

const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: { 'x-forwarded-for': ip } });
await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: root }]);
const page = await context.newPage();
for (const path of ['/', '/wallet', '/purchase', '/orders', '/keys', '/usage', '/models', '/docs', '/settings', '/support']) {
  await page.goto(root + path, { waitUntil: 'networkidle' });
  await page.locator('#main-content').waitFor();
  leak(`page ${path}`, await page.locator('body').innerText());
  assert.equal(await page.locator('a[href="/admin"], a[href="/roadmap"]').count(), 0, `${path} links to the admin console`);
}
await page.goto(root + '/', { waitUntil: 'networkidle' });
await page.getByRole('button', { name: /جزئیات وضعیت|وضعیت سرویس/ }).first().click();
leak('service status dialog', await page.locator('[role="dialog"]').innerText());
await page.goto(root + '/admin', { waitUntil: 'networkidle' });
assert.ok((await page.locator('#main-content').innerText()).includes('صفحه پیدا نشد'), '/admin must look like a missing page');
await browser.close();
console.log('PASS customer pages, status dialog and navigation never mention the supplier or the admin console');
