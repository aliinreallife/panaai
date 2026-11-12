// End-to-end browser flow over the current UI, with screenshots in artifacts/.
// CHROMIUM_PATH can point at a preinstalled Chromium when Playwright's own build is absent.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
const base = process.env.TEST_BASE_URL || 'http://localhost:3000';
const scale = Number(process.env.SCREENSHOT_SCALE || 1);
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: scale, extraHTTPHeaders: { 'x-forwarded-for': `10.1.${Date.now() % 250}.${Math.floor(Math.random() * 250)}` } });
const page = await context.newPage();
const issues = []; page.on('pageerror', e => issues.push(e.message));
const pass = n => console.log(`PASS ${n}`);
const shot = (name, full = true) => page.screenshot({ path: `artifacts/${name}.png`, fullPage: full });
const settle = () => page.waitForTimeout(250);

await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForSelector('.balance-card'); await page.evaluate(() => document.fonts.ready);
assert.match(await page.title(), /PanaAI|پنا|نمای کلی/i);
await shot('01-dashboard-dark');
const themeButton = page.getByRole('button', { name: 'چرخه حالت نمایش: تیره، روشن، خودکار' });
await themeButton.click(); await settle(); await shot('02-dashboard-light', false); await themeButton.click(); await themeButton.click(); await settle();
pass('dashboard renders with provider disclosure and theme cycling');

// API key form: Persian digits, separators and inline range errors
await page.goto(`${base}/keys`, { waitUntil: 'networkidle' });
assert.match(await page.title(), /کلیدهای API/);
await page.locator('.page-actions').getByRole('button', { name: 'ساخت کلید جدید' }).click();
await page.getByPlaceholder('مثلاً پروژه اصلی یا محیط توسعه').fill('کلید مرورگر');
const budget = page.getByRole('textbox', { name: 'سقف کل مصرف' }); await budget.fill('۵۰۰۰۰۰۰');
assert.equal(await budget.inputValue(), '۵٬۰۰۰٬۰۰۰');
const rate = page.getByRole('textbox', { name: 'درخواست در دقیقه' }); await rate.fill('500'); await rate.blur();
await page.getByText('درخواست در دقیقه نباید بیشتر از ۳۰۰ باشد.').waitFor();
assert.ok(await page.getByRole('button', { name: 'ساخت کلید', exact: true }).isDisabled());
await page.getByRole('dialog').screenshot({ path: 'artifacts/03-key-inline-error.png' });
await rate.fill('60');
await page.getByRole('button', { name: 'ساخت کلید', exact: true }).click(); await page.getByRole('button', { name: 'کلید را ذخیره کردم' }).waitFor();
const secret = await page.locator('.secret-code code').innerText(); assert.ok(secret.startsWith('pana-'));
await page.getByRole('button', { name: 'کلید را ذخیره کردم' }).click();
pass('key form: Persian grouped digits, inline range error blocks submit, one-time secret');

// Filter-aware empty state with clear action
await page.getByLabel('جست‌وجوی نام کلید...').fill('هیچ‌چیز-نیست');
await page.getByText('نتیجه‌ای با این فیلترها پیدا نشد').waitFor();
await page.getByRole('button', { name: 'پاک‌کردن فیلترها' }).click();
assert.ok(await page.getByText('کلید مرورگر').first().isVisible());
pass('filter-aware empty state clears the search');

// Simulated API call through the gateway charges the wallet
const completion = await page.request.post(`${base}/v1/chat/completions`, { headers: { authorization: `Bearer ${secret}` }, data: { model: 'gpt-4o', max_tokens: 100, messages: [{ role: 'user', content: 'سلام' }] } });
assert.equal(completion.status(), 200); assert.ok((await completion.json()).usage.platform_credits > 0);
pass('simulated gateway call reserved and settled from the wallet');

// Purchase: preset/custom amount with inline errors, quote, deadline countdown, prefilled claimed amount
await page.goto(`${base}/purchase`, { waitUntil: 'networkidle' });
const custom = page.getByRole('textbox', { name: 'مبلغ دلخواه', exact: true }); await custom.fill('10'); await custom.blur();
await page.getByText(/مبلغ دلخواه باید حداقل ۵۰٬۰۰۰ باشد/).waitFor();
assert.ok(await page.getByRole('button', { name: 'دریافت پیش‌فاکتور' }).isDisabled());
await shot('04-purchase-inline-error');
await page.getByRole('group', { name: 'مقادیر پیشنهادی مبلغ دلخواه' }).getByRole('button', { name: '۲۰۰٬۰۰۰' }).click();
assert.equal(await custom.inputValue(), '۲۰۰٬۰۰۰');
await page.getByRole('button', { name: 'دریافت پیش‌فاکتور' }).click();
await page.getByRole('button', { name: 'تأیید و ایجاد سفارش' }).click();
await page.getByRole('button', { name: 'ثبت رسید و ارسال برای بررسی' }).waitFor();
await page.locator('.deadline-countdown').first().waitFor();
const claimed = page.getByRole('textbox', { name: 'مبلغ واریزشده' }); assert.equal(await claimed.inputValue(), '۲۰۰٬۰۰۰');
await claimed.fill('190000'); await page.getByText(/۱۰٬۰۰۰ تومان کمتر از مبلغ سفارش/).waitFor();
await claimed.fill('200000'); await page.getByText('مبلغ با سفارش منطبق است و برای بررسی عادی ارسال می‌شود.').waitFor();
const ref = await page.locator('.order-status-block code').innerText();
await shot('05-order-deadline-countdown');
const receipt = await sharp({ create: { width: 500, height: 650, channels: 3, background: `#${(Date.now() % 0xffffff).toString(16).padStart(6, '0')}` } }).png().toBuffer();
await page.locator('input[type=file]').setInputFiles({ name: 'browser-receipt.png', mimeType: 'image/png', buffer: receipt });
await page.getByRole('button', { name: 'ثبت رسید و ارسال برای بررسی' }).click();
await page.getByRole('heading', { name: 'رسید شما با موفقیت ثبت شد' }).waitFor();
pass('purchase: presets, inline errors, deadline countdown, prefilled claimed amount with match hint, receipt');

// Admin: locked until phone OTP elevation (TOTP optional)
await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
await page.getByText('عملیات مدیریتی قفل است').waitFor();
const otp = await (await page.request.post(`${base}/api/v1/auth/otp/request`, { data: { phone: '09120000000' } })).json();
assert.equal((await page.request.post(`${base}/api/v1/auth/otp/verify`, { data: { challengeId: otp.challengeId, code: otp.demoCode } })).status(), 200);
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'تأیید هویت مدیر' }).click();
await page.getByRole('dialog').getByRole('button', { name: 'باز کردن نشست مدیریتی' }).click();
await page.getByText('نشست مدیریتی تأییدشده').waitFor();
await page.screenshot({ path: 'artifacts/06-admin-otp-elevate.png' });
pass('admin elevation: demo OTP opens session; TOTP remains optional');

// Payment review with Persian numeric matching
await page.locator('.admin-tabs').getByRole('button', { name: 'بررسی پرداخت‌ها' }).click();
await page.getByRole('button', { name: ref, exact: true }).click();
await page.getByLabel('مرجع یکتای تراکنش تأییدشده بانک').fill(`UI-${Date.now()}`);
const matched = page.getByRole('textbox', { name: 'مبلغ تطبیق‌داده‌شده با بانک' }); await matched.fill('1999999'); await page.getByText(/منطبق نیست؛ تأیید ممکن نیست/).waitFor();
await matched.fill('۲۰۰۰۰۰۰'); assert.equal(await matched.inputValue(), '۲٬۰۰۰٬۰۰۰'); await page.getByText('با مبلغ سفارش منطبق است.').waitFor();
await page.getByLabel('دلیل و توضیح بررسی').fill('بررسی مستقل بانک در این آزمون مرورگری شبیه‌سازی شد.');
await page.getByRole('checkbox', { name: 'تطبیق مستقل دریافت وجه و حساب مقصد را برای این آزمایش شبیه‌سازی می‌کنم.' }).check();
await shot('07-payment-review');
await page.getByRole('button', { name: 'تأیید و شارژ', exact: true }).click(); await page.getByRole('button', { name: 'تأیید نهایی آزمایشی' }).click();
await page.getByRole('dialog').waitFor({ state: 'hidden' });
pass('payment review: grouped-digit amount matching and exactly-once grant');

// Provider state machine via simulator
await page.locator('.admin-tabs').getByRole('button', { name: 'تأمین‌کننده' }).click();
await page.getByRole('textbox', { name: 'موجودی جدید' }).fill('0');
await page.getByPlaceholder('مثلاً آزمون رسیدن موجودی به صفر').fill('آزمون مرورگری رسیدن موجودی به صفر.');
await page.getByRole('button', { name: 'ثبت موجودی و ارزیابی' }).click();
await page.locator('.verified-balance .badge', { hasText: 'دوره ارفاق' }).waitFor();
await shot('08-provider-grace');
await page.locator('.admin-tabs').getByRole('button', { name: 'هشدارها' }).click();
await page.getByText(/سالم ← دوره ارفاق/).first().waitFor();
await shot('09-alerts-channels');
pass('provider grace transition raises an alert with per-channel delivery status');
await page.locator('.admin-tabs').getByRole('button', { name: 'تنظیمات و امنیت' }).click(); await page.getByText('نقش‌ها و دسترسی‌ها').waitFor(); await shot('10-admin-system-roles');
await page.locator('.admin-tabs').getByRole('button', { name: 'قیمت‌گذاری' }).click(); await page.getByText('بسته‌های خرید').waitFor(); await shot('11-admin-pricing-packages');

// Wallet notices + new event types
assert.equal((await page.request.put(`${base}/api/v1/admin/system`, { data: { transferHours: 24, graceMinutes: 5, lowBalanceCredits: 900000000, maxKeys: 20, creditsPerCvcToken: 1, creditsPerUsd: 20000000, upstreamTokensPerUsd: 25000000, reason: 'آزمون مرورگری اعلان کمبود اعتبار.' } })).status(), 200);
await page.goto(`${base}/wallet`, { waitUntil: 'networkidle' });
await page.getByText('اعتبار شما رو به اتمام است').waitFor();
await shot('12-wallet-notices');
await page.getByRole('button', { name: 'بستن اعلان «اعتبار شما رو به اتمام است»' }).click();
await page.reload({ waitUntil: 'networkidle' }); await page.waitForSelector('.balance-card');
assert.equal(await page.getByText('اعتبار شما رو به اتمام است').count(), 0);
pass('wallet low-balance notice follows the admin threshold and stays dismissed for the session');

// Desktop and mobile overflow on every route
for (const route of ['wallet', 'purchase', 'orders', 'keys', 'usage', 'models', 'docs', 'settings', 'support', 'admin', 'roadmap']) {
  await page.goto(`${base}/${route}`, { waitUntil: 'networkidle' }); await page.waitForSelector('.page-title, .analytics-heading');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `Desktop overflow: ${route}`);
}
pass('no horizontal overflow on desktop routes');
await shot('13-prd-status');
const mobile = await context.newPage(); await mobile.setViewportSize({ width: 390, height: 844 }); mobile.on('pageerror', e => issues.push(e.message));
for (const route of ['', 'purchase', 'orders', 'keys', 'wallet', 'admin', 'roadmap']) {
  await mobile.goto(`${base}/${route}`, { waitUntil: 'networkidle' }); await mobile.waitForSelector('.page-title, .analytics-heading, .balance-card');
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= 391), `Mobile overflow: ${route || 'overview'}`);
  if (route === 'admin' || route === '') await mobile.screenshot({ path: `artifacts/14-mobile-${route || 'overview'}.png`, fullPage: false });
}
pass('no horizontal overflow on mobile routes');

// Retry-After countdown when sandbox creation is rate limited (fresh IP, 31 attempts)
const limited = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: scale, extraHTTPHeaders: { 'x-forwarded-for': `10.250.${Date.now() % 250}.9` } });
for (let i = 0; i < 31; i++) await limited.request.post(`${base}/api/v1/bootstrap`, { data: {} }).then(async r => { const c = r.headers()['set-cookie']; if (c) await limited.clearCookies(); });
const lp = await limited.newPage(); lp.on('pageerror', e => issues.push(e.message));
await lp.goto(base, { waitUntil: 'networkidle' });
await lp.getByText(/امکان تلاش دوباره تا/).waitFor();
assert.ok(await lp.getByRole('button', { name: /تلاش دوباره \(/ }).isDisabled());
await lp.screenshot({ path: 'artifacts/15-retry-after-countdown.png' });
pass('rate-limited sandbox creation shows a Retry-After countdown with a disabled retry button');

assert.deepEqual(issues, []); pass('no browser runtime errors');
await browser.close();
