"use client";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { REFUND_STATES, compact, fa, persianDate, persianTime, type RefundItem } from "@/lib/shared";
import { Badge, Button, CopyButton, Empty, Icon, Modal, Notice, api, useApp, type ApiFailure } from "@/components/ui";
import { CharCount } from "@/components/ux-helpers";
import { FilteredEmpty, NumericField } from "@/components/ux-fields";
import { SelectField } from "@/components/select-field";
import { PROVIDER_STATE_INFO, ROLE_INFO, SYSTEM_LIMITS, can, coverageTier, rangeError, type Permission, type ProviderState, type Role } from "@/lib/rules";

/* ------------------------------------------------------------------ */
/* Security context: role, MFA and session elevation                    */
/* ------------------------------------------------------------------ */
type Security = { role: Role; roleLabel: string; permissions: Permission[]; otpVerified: boolean; mfaEnrolled: boolean; mfaPending: boolean; elevatedUntil: string | null; elevationMinutes: number; demo: boolean };
type SecurityCtx = { security: Security | null; reload: () => Promise<void>; requireElevation: () => void; act: (fn: () => Promise<void>, onError?: (message: string) => void) => Promise<void>; allowed: (p: Permission) => boolean; elevated: boolean };
const SecurityContext = createContext<SecurityCtx | null>(null);
export const useAdminSecurity = () => { const v = useContext(SecurityContext); if (!v) throw new Error("Missing admin security context"); return v; };

export function AdminSecurityProvider({ children }: { children: React.ReactNode }) {
  const { notify, data } = useApp();
  const [security, setSecurity] = useState<Security | null>(null); const [modal, setModal] = useState(false); const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(async () => { try { setSecurity(await api<Security>("admin/security")); } catch (e) { notify((e as Error).message, "error"); } }, [notify]);
  useEffect(() => { let live = true; api<Security>("admin/security").then(r => { if (live) setSecurity(r); }).catch(e => notify((e as Error).message, "error")); return () => { live = false; }; }, [notify, data.updatedAt]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const elevated = !!security?.elevatedUntil && new Date(security.elevatedUntil).getTime() > now;
  const act = useCallback(async (fn: () => Promise<void>, onError?: (message: string) => void) => {
    try { await fn(); }
    catch (e) {
      const failure = e as ApiFailure;
      if (failure.code === "mfa_required") { setModal(true); await reload(); }
      if (onError) onError(failure.message); else notify(failure.message, "error");
    }
  }, [notify, reload]);
  const value: SecurityCtx = { security, reload, requireElevation: () => setModal(true), act, allowed: p => !!security && can(security.role, p), elevated };
  return <SecurityContext.Provider value={value}>
    <AdminGateBar now={now} />
    {children}
    {modal && <ElevationModal onClose={() => setModal(false)} />}
  </SecurityContext.Provider>;
}

function AdminGateBar({ now }: { now: number }) {
  const { security, requireElevation, elevated, reload } = useAdminSecurity(); const { notify } = useApp();
  if (!security) return <div className="admin-gate skeleton" style={{ height: 64 }} aria-hidden="true" />;
  const left = elevated ? Math.max(0, Math.floor((new Date(security.elevatedUntil!).getTime() - now) / 1000)) : 0;
  return <div className={`admin-gate ${elevated ? "admin-gate-ok" : ""}`} role="status">
    <span className="admin-gate-icon"><Icon name={elevated ? "secure" : "lock"} size={22} /></span>
    <div><strong>{elevated ? "نشست مدیریتی تأییدشده" : "عملیات مدیریتی قفل است"}</strong><span>نقش: {security.roleLabel} · پیامک (آزمایشی): {security.otpVerified ? "تأییدشده" : "تأیید نشده"} · TOTP: {security.mfaEnrolled ? "فعال" : "فعال نشده"}{elevated ? ` · ${fa(Math.floor(left / 60))}:${fa(String(left % 60).padStart(2, "0"))} تا پایان` : ""}</span></div>
    {elevated
      ? <Button tone="secondary" className="btn-small" onClick={async () => { try { await api("admin/mfa/drop", { method: "POST" }); await reload(); notify("نشست مدیریتی قفل شد.", "info"); } catch (e) { notify((e as Error).message, "error"); } }}><Icon name="lock" size={15} />قفل کردن</Button>
      : <Button className="btn-small" onClick={requireElevation}><Icon name="secure" size={15} />تأیید هویت مدیر</Button>}
  </div>;
}

function ElevationModal({ onClose }: { onClose: () => void }) {
  const { security, reload } = useAdminSecurity(); const { notify } = useApp();
  const [enroll, setEnroll] = useState<{ secret: string; uri: string } | null>(null); const [code, setCode] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [demo, setDemo] = useState<{ code: string; expiresIn: number } | null>(null);
  if (!security) return null;
  const step = !security.otpVerified ? 1 : !security.mfaEnrolled ? 2 : 3;
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const showDemo = () => run(async () => setDemo(await api<{ code: string; expiresIn: number }>("admin/mfa/demo-code")));
  return <Modal title="تأیید هویت مدیر" description="ورود مدیر = کد پیامکی + کد TOTP؛ اعتبار نشست ۱۵ دقیقه" onClose={onClose}>
    <ol className="mfa-steps">
      <li className={step > 1 ? "done" : "current"}><strong>۱. کد پیامکی (OTP)</strong><span>{security.otpVerified ? "شماره موبایل با کد یک‌بارمصرف تأیید شده است." : "ابتدا از منوی حساب، «آزمایش ورود با موبایل» را انجام دهید. پیامک واقعی ارسال نمی‌شود."}</span></li>
      <li className={step > 2 ? "done" : step === 2 ? "current" : ""}><strong>۲. فعال‌سازی TOTP</strong><span>{security.mfaEnrolled ? "برنامه احراز هویت متصل است." : "کلید را در Google Authenticator، Authy یا هر برنامه TOTP وارد کنید."}</span></li>
      <li className={step === 3 ? "current" : ""}><strong>۳. کد TOTP فعلی</strong><span>هر کد فقط یک‌بار پذیرفته می‌شود؛ پنج تلاش ناموفق TOTP را قفل می‌کند.</span></li>
    </ol>
    {step === 2 && (!enroll
      ? <Button busy={busy} onClick={() => run(async () => setEnroll(await api<{ secret: string; uri: string }>("admin/mfa/enroll", { method: "POST" })))}><Icon name="keys" size={16} />ساخت کلید TOTP</Button>
      : <div className="form-stack"><div className="secret-code"><code dir="ltr">{enroll.secret.replace(/(.{4})/g, "$1 ").trim()}</code><CopyButton value={enroll.secret} label="کپی کلید" /></div><details><summary className="muted small">نشانی otpauth برای برنامه‌های سازگار</summary><code className="audit-json" dir="ltr">{enroll.uri}</code></details></div>)}
    {step >= 2 && (step === 3 || enroll) && <form className="form-stack" onSubmit={e => { e.preventDefault(); void run(async () => {
      if (step === 2) { await api("admin/mfa/confirm", { body: { code } }); notify("TOTP فعال شد. برای باز کردن نشست، کد بعدی را وارد کنید.", "info"); setCode(""); setDemo(null); await reload(); }
      else { await api("admin/mfa/elevate", { body: { code } }); await reload(); notify("نشست مدیریتی برای ۱۵ دقیقه باز شد."); onClose(); }
    }); }}>
      <label className="field">کد ۶ رقمی برنامه احراز هویت<input dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={e => setCode(e.target.value.replace(/[۰-۹]/g, d => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/\D/g, ""))} placeholder="------" required /></label>
      {security.demo && <div className="demo-otp"><span>برنامه احراز هویت ندارید؟</span>{demo ? <><strong dir="ltr">{demo.code}</strong><span>کد آزمایشی · {fa(demo.expiresIn)} ثانیه</span></> : <button type="button" className="text-link" onClick={showDemo}>نمایش کد آزمایشی</button>}</div>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <Button type="submit" busy={busy} disabled={code.length !== 6}>{step === 2 ? "تأیید و فعال‌سازی TOTP" : "باز کردن نشست مدیریتی"}</Button>
    </form>}
    {step === 1 && <Notice tone="warning">بدون تأیید شماره موبایل، نشست مدیریتی باز نمی‌شود.</Notice>}
  </Modal>;
}

/* ------------------------------------------------------------------ */
/* Provider: state machine, simulator, pause/resume                    */
/* ------------------------------------------------------------------ */
type ProviderView = { state: ProviderState; admits: boolean; balance: number | null; source: string; paused: boolean; graceUntil: string | null; checkedAt: string | null; changedAt: string; coverageTier: number | null; simulated: boolean };
export function ProviderOps() {
  const { data, refresh, notify } = useApp(); const { act, allowed } = useAdminSecurity();
  const [view, setView] = useState<ProviderView | null>(null); const [balance, setBalance] = useState(""); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  useEffect(() => { let live = true; api<ProviderView>("admin/provider").then(r => { if (live) setView(r); }).catch(e => setError((e as Error).message)); return () => { live = false; }; }, [data.updatedAt]);
  const liabilities = data.wallet.available + data.wallet.reserved;
  const preview = balance ? coverageTier(Number(balance), liabilities) : null;
  const run = (name: string, route: string, body: unknown) => { setBusy(name); setError(""); return act(async () => { setView(await api<ProviderView>(route, { body })); await refresh(); setReason(""); notify("وضعیت تأمین‌کننده دوباره ارزیابی شد.", "info"); }, setError).finally(() => setBusy("")); };
  if (!view) return <div className="skeleton skeleton-chart" aria-busy="true" />;
  const info = PROVIDER_STATE_INFO[view.state];
  const manage = allowed("provider.manage");
  const flow: ProviderState[] = ["healthy", "low", "grace", "zero", "resuming"];
  return <>
    <div className="provider-cards">
      <section className="panel padded verified-balance"><span className="security-emblem"><Icon name="globe" size={30} /></span><h2>موجودی تأمین‌کننده</h2><strong>{view.balance === null ? "—" : compact(view.balance)}</strong><Badge tone={info.tone}>{info.label}{view.simulated ? " · شبیه‌ساز" : ""}</Badge>
        <dl className="detail-list"><div><dt>پذیرش درخواست API</dt><dd>{info.admits ? "فعال" : "متوقف"}</dd></div><div><dt>پوشش نسبت به تعهد مشتری ({compact(liabilities)})</dt><dd>{view.coverageTier === null ? "نامشخص" : `سطح ${fa(view.coverageTier)}٪`}</dd></div><div><dt>آخرین بررسی</dt><dd>{view.checkedAt ? `${persianTime(view.checkedAt)}` : "—"}</dd></div><div><dt>آخرین تغییر وضعیت</dt><dd>{persianDate(view.changedAt)}، {persianTime(view.changedAt)}</dd></div>{view.state === "grace" && view.graceUntil && <div><dt>پایان دوره ارفاق</dt><dd>{persianTime(view.graceUntil)} ({fa(data.system.graceMinutes)} دقیقه)</dd></div>}</dl>
        <Button tone="secondary" busy={busy === "sync"} disabled={!manage} onClick={() => run("sync", "admin/provider/sync", {})}><Icon name="refresh" size={17} />بررسی دوباره وضعیت</Button>
      </section>
      <section className="panel padded"><h2>شبیه‌ساز موجودی CVC</h2><p className="muted small">در پیش‌نمایش، موجودی از شبیه‌ساز می‌آید تا چرخه سالم → دوره ارفاق → صفر → ازسرگیری را بتوان آزمود. در حالت عملیاتی بدون CVC_PRIMARY_API_KEY، وضعیت «تأییدنشده» می‌ماند و درخواستی پذیرفته نمی‌شود.</p>
        <form className="form-stack" onSubmit={e => { e.preventDefault(); void run("simulate", "admin/provider/simulate", { balance: Number(balance), reason }); }}>
          <NumericField label="موجودی جدید" unit="اعتبار" value={balance} onChange={setBalance} min={0} max={Number.MAX_SAFE_INTEGER} required presets={[0, 1000000, 250000000]} describe={() => preview === null ? null : <>سطح پوشش پس از ثبت: {fa(preview)}٪</>} disabled={!manage} />
          <label className="field">دلیل<textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} minLength={10} maxLength={1000} required placeholder="مثلاً آزمون رسیدن موجودی به صفر" disabled={!manage} /><CharCount value={reason} max={1000} /></label>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="button-row"><Button type="submit" busy={busy === "simulate"} disabled={!manage || !!rangeError(balance, { min: 0, required: true }) || reason.trim().length < 10}>ثبت موجودی و ارزیابی</Button><Button type="button" tone="secondary" busy={busy === "outage"} disabled={!manage || reason.trim().length < 10} onClick={() => run("outage", "admin/provider/simulate", { balance: null, outage: true, reason })}><Icon name="warning" size={16} />شبیه‌سازی قطع بررسی موجودی</Button><Button type="button" tone={view.paused ? "secondary" : "danger"} busy={busy === "pause"} disabled={!manage || reason.trim().length < 10} onClick={() => run("pause", "admin/provider/pause", { paused: !view.paused, reason })}><Icon name={view.paused ? "refresh" : "pause"} size={16} />{view.paused ? "ازسرگیری پذیرش" : "توقف دستی پذیرش"}</Button></div>
          {!manage && <Notice>نقش فعلی شما اجازه مدیریت تأمین‌کننده را ندارد.</Notice>}
        </form>
      </section>
    </div>
    <section className="panel padded"><div className="section-title"><div><h2>چرخه وضعیت</h2><p>توقف پذیرش درخواست، فروش اعتبار را متوقف نمی‌کند.</p></div></div>
      <div className="state-flow">{flow.map(st => <div key={st} className={`state-node ${view.state === st ? "current" : ""}`}><Badge tone={PROVIDER_STATE_INFO[st].tone}>{PROVIDER_STATE_INFO[st].label}</Badge><small>{PROVIDER_STATE_INFO[st].admits ? "پذیرش فعال" : "پذیرش متوقف"}</small></div>)}</div>
      <ul className="rule-list"><li>موجودی صفر ← یک دوره ارفاق {fa(data.system.graceMinutes)} دقیقه‌ای (قابل تنظیم در تنظیمات سیستم)، سپس «موجودی صفر».</li><li>قطع یا کهنه شدن بررسی موجودی ← همان دوره ارفاق، سپس «تأییدنشده» تا یک بررسی تازه و مثبت.</li><li>بازگشت موجودی ← «در حال ازسرگیری» برای یک بررسی، سپس «سالم» یا «پوشش کم» (زیر ۲۵٪).</li><li>هر تغییر وضعیت و افت سطح پوشش، رویداد حسابرسی و هشدار (داشبورد/تلگرام/ایمیل) می‌سازد.</li></ul>
    </section>
  </>;
}

/* ------------------------------------------------------------------ */
/* Alerts and channels                                                  */
/* ------------------------------------------------------------------ */
type AlertRow = { id: string; kind: string; severity: string; title: string; message: string; state: string; deliveries: { channel: string; status: string; at: string; detail?: string }[]; createdAt: string };
type Channels = { telegram: { enabled: boolean; chatId: string; configured: boolean }; email: { enabled: boolean; to: string; configured: boolean } };
const DELIVERY: Record<string, { label: string; tone: string }> = { sent: { label: "ارسال شد", tone: "success" }, failed: { label: "ناموفق", tone: "danger" }, not_configured: { label: "تنظیم نشده", tone: "neutral" } };
const CHANNEL: Record<string, string> = { dashboard: "داشبورد", telegram: "تلگرام", email: "ایمیل" };
export function AlertsOps() {
  const { data, notify } = useApp(); const { act, allowed } = useAdminSecurity();
  const [rows, setRows] = useState<AlertRow[] | null>(null); const [channels, setChannels] = useState<Channels | null>(null); const [filter, setFilter] = useState("open"); const [form, setForm] = useState({ telegram: false, telegramChatId: "", email: false, emailTo: "" }); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const apply = useCallback((r: { alerts: AlertRow[]; channels: Channels }) => { setRows(r.alerts); setChannels(r.channels); setForm({ telegram: r.channels.telegram.enabled, telegramChatId: r.channels.telegram.chatId, email: r.channels.email.enabled, emailTo: r.channels.email.to }); }, []);
  const load = useCallback(async () => apply(await api<{ alerts: AlertRow[]; channels: Channels }>("admin/alerts")), [apply]);
  useEffect(() => { let live = true; api<{ alerts: AlertRow[]; channels: Channels }>("admin/alerts").then(r => { if (live) apply(r); }).catch(e => setError(e.message)); return () => { live = false; }; }, [apply, data.updatedAt]);
  const manage = allowed("alerts.manage");
  const visible = (rows || []).filter(r => filter === "all" || r.state === filter);
  return <>
    <section className="panel"><div className="panel-heading"><h2>هشدارها و رخدادها</h2><div className="toolbar-actions"><SelectField compact label="وضعیت هشدار" icon="filter" value={filter} onChange={setFilter} options={[{ value: "open", label: `باز (${fa((rows || []).filter(r => r.state === "open").length)})` }, { value: "acknowledged", label: "دیده‌شده" }, { value: "all", label: `همه (${fa((rows || []).length)})` }]} /><Button tone="secondary" busy={busy === "test"} disabled={!manage} onClick={() => { setBusy("test"); void act(async () => { await api("admin/alerts/test", { method: "POST" }); await load(); notify("هشدار آزمایشی ثبت شد؛ نتیجه هر کانال در فهرست آمده است.", "info"); }).finally(() => setBusy("")); }}><Icon name="send" size={15} />ارسال آزمایشی</Button></div></div>
      {rows === null ? <div className="skeleton skeleton-chart" /> : visible.length ? <div className="alert-list">{visible.map(a => <div className="alert-row" key={a.id}><span className={`notification-icon ${a.severity === "critical" ? "red" : a.severity === "warning" ? "warm" : "gold"}`}><Icon name={a.severity === "info" ? "info" : "warning"} /></span><div><strong>{a.title}</strong><p>{a.message}</p><div className="delivery-row">{a.deliveries.map((d, i) => <Badge key={i} tone={DELIVERY[d.status]?.tone || "neutral"} dot={false}>{CHANNEL[d.channel] || d.channel}: {DELIVERY[d.status]?.label || d.status}</Badge>)}<small className="muted">{persianDate(a.createdAt)}، {persianTime(a.createdAt)}</small></div></div>{a.state === "open" ? <Button tone="secondary" className="btn-small" disabled={!manage} onClick={() => void act(async () => { await api(`admin/alerts/${a.id}/ack`, { method: "POST" }); await load(); })}><Icon name="check" size={14} />دیدم</Button> : <Badge>دیده‌شده</Badge>}</div>)}</div>
        : <FilteredEmpty active={filter !== "all"} onClear={() => setFilter("all")} title="هنوز هشداری ثبت نشده" text="تغییر وضعیت تأمین‌کننده و افت سطح پوشش اینجا ثبت می‌شود. برای آزمون، موجودی شبیه‌ساز را صفر کنید." icon="bell" />}
    </section>
    <section className="panel padded"><div className="section-title"><div><h2>کانال‌های اعلان مدیر</h2><p>توکن‌ها فقط در متغیرهای محیطی سرور نگهداری می‌شوند.</p></div></div>
      <form className="form-stack" onSubmit={e => { e.preventDefault(); setBusy("save"); setError(""); void act(async () => { await api("admin/channels", { method: "PUT", body: form }); await load(); notify("تنظیمات کانال‌ها ذخیره شد."); }, setError).finally(() => setBusy("")); }}>
        <div className="channel-grid">
          <fieldset className="channel-card"><legend><Icon name="send" size={16} />تلگرام</legend><Badge tone={channels?.telegram.configured ? "success" : "neutral"}>{channels?.telegram.configured ? "توکن ربات تنظیم شده" : "TELEGRAM_BOT_TOKEN تنظیم نشده"}</Badge><label className="checkbox-label"><input type="checkbox" checked={form.telegram} onChange={e => setForm({ ...form, telegram: e.target.checked })} disabled={!manage} />ارسال هشدارها به تلگرام</label><label className="field">شناسه گفت‌وگو یا کانال<input dir="ltr" value={form.telegramChatId} onChange={e => setForm({ ...form, telegramChatId: e.target.value })} placeholder="-1001234567890 یا @channel" disabled={!manage} /></label></fieldset>
          <fieldset className="channel-card"><legend><Icon name="bell" size={16} />ایمیل</legend><Badge tone={channels?.email.configured ? "success" : "neutral"}>{channels?.email.configured ? "سرویس ایمیل تنظیم شده" : "RESEND_API_KEY / ALERT_EMAIL_FROM تنظیم نشده"}</Badge><label className="checkbox-label"><input type="checkbox" checked={form.email} onChange={e => setForm({ ...form, email: e.target.checked })} disabled={!manage} />ارسال هشدارها به ایمیل</label><label className="field">نشانی گیرنده<input dir="ltr" type="email" value={form.emailTo} onChange={e => setForm({ ...form, emailTo: e.target.value })} placeholder="ops@example.com" disabled={!manage} /></label></fieldset>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
        <Button type="submit" busy={busy === "save"} disabled={!manage}>ذخیره کانال‌ها</Button>
      </form>
    </section>
  </>;
}

/* ------------------------------------------------------------------ */
/* Refunds                                                              */
/* ------------------------------------------------------------------ */
export function RefundsOps() {
  const { data, refresh, notify } = useApp(); const { act, allowed } = useAdminSecurity();
  const [selected, setSelected] = useState<RefundItem | null>(null); const [filter, setFilter] = useState("all");
  const rows = data.refunds.filter(r => filter === "all" || r.state === filter);
  const tickets = data.tickets.filter(t => t.category === "refund");
  return <><section className="panel"><div className="panel-heading"><h2>درخواست‌های بازپرداخت</h2><SelectField compact label="وضعیت بازپرداخت" icon="filter" value={filter} onChange={setFilter} options={[{ value: "all", label: `همه (${fa(data.refunds.length)})` }, ...Object.entries(REFUND_STATES).map(([id, s]) => ({ value: id, label: `${s.label} (${fa(data.refunds.filter(r => r.state === id).length)})` }))]} /></div>
    {rows.length ? <div className="table-scroll"><table><thead><tr><th>سفارش</th><th>اعتبار برگشتی</th><th>مبلغ بازپرداخت</th><th>وضعیت</th><th>تاریخ</th><th /></tr></thead><tbody>{rows.map(r => { const order = data.orders.find(o => o.id === r.orderId); return <tr key={r.id}><td><bdi className="mono">{order?.reference || r.orderId.slice(0, 8)}</bdi><span className="cell-subtitle">{r.reason}</span></td><td>{compact(r.credits)}</td><td>{fa(r.amountIrr / 10)} تومان</td><td><Badge tone={REFUND_STATES[r.state]?.tone}>{REFUND_STATES[r.state]?.label}</Badge></td><td className="muted">{persianDate(r.createdAt)}</td><td>{["requested", "approved"].includes(r.state) ? <Button className="btn-small" tone="secondary" disabled={!allowed("refunds.decide")} onClick={() => setSelected(r)}>{r.state === "requested" ? "بررسی" : "ثبت واریز"}<Icon name="chevron" size={14} /></Button> : null}</td></tr>; })}</tbody></table></div>
      : <FilteredEmpty active={filter !== "all"} onClear={() => setFilter("all")} title="درخواست بازپرداختی ثبت نشده" text="مشتری از جزئیات یک سفارش تأییدشده، بازپرداخت اعتبار مصرف‌نشده را درخواست می‌کند." icon="rotate" />}
    <div className="table-note"><Icon name="secure" size={14} />تأیید، اعتبار مصرف‌نشده را با رویداد جبرانی برمی‌دارد؛ «واریز شد» فقط با مرجع واریز خروجی بانک ثبت می‌شود.</div></section>
    {tickets.length > 0 && <section className="panel padded"><h2>تیکت‌های پشتیبانی با دسته بازپرداخت</h2>{tickets.map(t => <div className="refund-card" key={t.id}><div><strong>{t.subject}</strong><Badge>تیکت</Badge></div><p>{t.message}</p></div>)}</section>}
    {selected && <RefundDecision refund={selected} onClose={() => setSelected(null)} act={act} onDone={async msg => { await refresh(); notify(msg); setSelected(null); }} />}
  </>;
}
function RefundDecision({ refund, onClose, act, onDone }: { refund: RefundItem; onClose: () => void; act: SecurityCtx["act"]; onDone: (message: string) => Promise<void> }) {
  const [note, setNote] = useState(""); const [payout, setPayout] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const decide = (action: string) => { setBusy(action); setError(""); void act(async () => { await api(`admin/refunds/${refund.id}/${action}`, { body: { note, payoutReference: payout || undefined } }); await onDone(action === "approve" ? "بازپرداخت تأیید شد و اعتبار مصرف‌نشده برداشته شد." : action === "paid" ? "واریز بازپرداخت ثبت شد." : "درخواست بازپرداخت رد شد."); }, setError).finally(() => setBusy("")); };
  return <Modal title={refund.state === "requested" ? "بررسی درخواست بازپرداخت" : "ثبت واریز بازپرداخت"} description={`${fa(refund.amountIrr / 10)} تومان · ${compact(refund.credits)} اعتبار`} onClose={onClose}>
    <Notice title="دلیل مشتری">{refund.reason}</Notice>
    {refund.state === "approved" && <label className="field">مرجع واریز خروجی بانک<input dir="ltr" value={payout} onChange={e => setPayout(e.target.value)} minLength={4} maxLength={100} placeholder="PAYOUT-REFERENCE" /></label>}
    <label className="field"><span className="field-label">یادداشت تصمیم <small>(حداقل ۱۰ نویسه)</small></span><textarea value={note} onChange={e => setNote(e.target.value)} rows={3} minLength={10} maxLength={1000} /><CharCount value={note} max={1000} /></label>
    {error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-actions">{refund.state === "requested" ? <><Button tone="danger" busy={busy === "reject"} disabled={note.trim().length < 10} onClick={() => decide("reject")}>رد درخواست</Button><Button busy={busy === "approve"} disabled={note.trim().length < 10} onClick={() => decide("approve")}>تأیید و برداشت اعتبار</Button></> : <Button busy={busy === "paid"} disabled={note.trim().length < 10 || payout.trim().length < 4} onClick={() => decide("paid")}>ثبت واریز (شبیه‌سازی)</Button>}</div>
  </Modal>;
}

/* ------------------------------------------------------------------ */
/* Users: account state and audited credit adjustment                   */
/* ------------------------------------------------------------------ */
export function UsersOps() {
  const { data, refresh, notify } = useApp(); const { act, allowed } = useAdminSecurity();
  const [reason, setReason] = useState(""); const [amount, setAmount] = useState(""); const [adjReason, setAdjReason] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const suspended = data.account.state === "suspended";
  return <>
    <section className="panel padded"><div className="section-title"><h2>کاربران این فضای آزمایشی</h2><Badge>۱ حساب مستقل</Badge></div>
      <div className="admin-user-card"><span className="avatar large-avatar">{data.user.name.split(" ").map(n => n[0]).slice(0, 2).join(" ")}</span><div><h3>{data.user.name}</h3><p>{data.user.settings.email ? String(data.user.settings.email) : "ایمیل ثبت نشده"} · عضویت از {persianDate(data.user.createdAt, { year: "numeric" })}</p></div><div><span className="muted small">اعتبار قابل استفاده</span><strong>{fa(data.wallet.available)}</strong></div><Badge tone={suspended ? "danger" : "success"}>{suspended ? "معلق" : "فعال"}</Badge></div>
      <form className="form-stack" onSubmit={e => { e.preventDefault(); setBusy("state"); setError(""); void act(async () => { await api("admin/users/state", { body: { state: suspended ? "active" : "suspended", reason } }); await refresh(); setReason(""); notify(suspended ? "حساب دوباره فعال شد." : "حساب معلق شد؛ کلیدهای API و ثبت سفارش جدید متوقف است.", "info"); }, setError).finally(() => setBusy("")); }}>
        <label className="field">دلیل {suspended ? "فعال‌سازی" : "تعلیق"}<textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} minLength={10} maxLength={1000} required disabled={!allowed("users.manage")} /></label>
        <Notice>{suspended ? "پس از فعال‌سازی، کلیدها دوباره درخواست می‌پذیرند." : "تعلیق، درخواست‌های API، ساخت کلید، ثبت سفارش و بازپرداخت جدید را متوقف می‌کند. موجودی و سوابق حفظ می‌شوند. در این نمونه، حساب مدیر و مشتری یکی است."}</Notice>
        <Button type="submit" tone={suspended ? "primary" : "danger"} busy={busy === "state"} disabled={!allowed("users.manage") || reason.trim().length < 10}>{suspended ? "فعال‌سازی دوباره حساب" : "تعلیق حساب"}</Button>
      </form>
    </section>
    <section className="panel padded"><div className="section-title"><div><h2>اصلاح اعتبار</h2><p>هیچ رکوردی ویرایش یا حذف نمی‌شود؛ افزایش یک بسته جدید و کاهش یک رویداد جبرانی FEFO می‌سازد.</p></div><Badge tone="warning">حسابرسی‌شده</Badge></div>
      <form className="form-stack" onSubmit={e => { e.preventDefault(); setBusy("adjust"); setError(""); void act(async () => { await api("admin/wallet/adjust", { body: { amount: Number(amount), reason: adjReason } }); await refresh(); setAmount(""); setAdjReason(""); notify("اصلاح اعتبار ثبت شد."); }, setError).finally(() => setBusy("")); }}>
        <NumericField label="مقدار اصلاح" unit="اعتبار" allowNegative value={amount} onChange={setAmount} min={-Math.min(10000000000, data.wallet.available)} max={10000000000} required hint="برای کاهش، علامت منفی (-) را ابتدای عدد بنویسید." describe={v => v ? <>{v > 0 ? "افزایش" : "کاهش"} {compact(Math.abs(v))} اعتبار</> : null} disabled={!allowed("finance.adjust")} />
        <label className="field">دلیل و مرجع<textarea rows={2} value={adjReason} onChange={e => setAdjReason(e.target.value)} minLength={10} maxLength={1000} required disabled={!allowed("finance.adjust")} /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <Button type="submit" busy={busy === "adjust"} disabled={!allowed("finance.adjust") || !amount || amount === "-" || Number(amount) === 0 || !!rangeError(amount, { min: -Math.min(10000000000, data.wallet.available), max: 10000000000 }) || adjReason.trim().length < 10}>ثبت اصلاح</Button>
      </form>
    </section>
  </>;
}

/* ------------------------------------------------------------------ */
/* Finance: reconciliation                                              */
/* ------------------------------------------------------------------ */
type Recon = { checkedAt: string; lots: number; heldReservations: number; releasedStale: number; lotIssues: { lotId: string; issues: string[] }[]; unbalancedJournalEvents: string[]; ok: boolean };
export function ReconcilePanel() {
  const { refresh } = useApp(); const { act, allowed } = useAdminSecurity(); const [report, setReport] = useState<Recon | null>(null); const [busy, setBusy] = useState(false);
  return <section className="panel padded"><div className="section-title"><div><h2>تطبیق کیف پول و رزروها</h2><p>آزادسازی رزروهای قدیمی (بیش از ۵ دقیقه) و بررسی توازن بسته‌ها، رویدادها و ژورنال.</p></div><Button tone="secondary" busy={busy} disabled={!allowed("finance.adjust")} onClick={() => { setBusy(true); void act(async () => { setReport(await api<Recon>("admin/wallet/reconcile", { method: "POST" })); await refresh(); }).finally(() => setBusy(false)); }}><Icon name="refresh" size={16} />اجرای تطبیق</Button></div>
    {report ? <><Notice tone={report.ok ? "success" : "warning"} title={report.ok ? "همه موارد متوازن است" : "مغایرت پیدا شد"}>{fa(report.lots)} بسته، {fa(report.heldReservations)} رزرو فعال، {fa(report.releasedStale)} رزرو قدیمی آزاد شد · {persianTime(report.checkedAt)}</Notice>{report.lotIssues.map(i => <p className="muted small" key={i.lotId} dir="ltr">{i.lotId.slice(0, 8)}: {i.issues.join("; ")}</p>)}{report.unbalancedJournalEvents.length > 0 && <p className="warning-text small">{fa(report.unbalancedJournalEvents.length)} رویداد ژورنال نامتوازن</p>}</> : <p className="muted small">هنوز در این نشست اجرا نشده است. نتیجه هر اجرا در حسابرسی ثبت می‌شود.</p>}
  </section>;
}

/* ------------------------------------------------------------------ */
/* Packages                                                              */
/* ------------------------------------------------------------------ */
type Pkg = { id: string; label: string; subtitle: string; amountToman: number; icon: string; featured: boolean; active: boolean; sort: number };
export function PackagesAdmin() {
  const { data, refresh, notify } = useApp(); const { act, allowed } = useAdminSecurity();
  const [rows, setRows] = useState<Pkg[] | null>(null); const [edit, setEdit] = useState<Partial<Pkg> | null>(null); const [amount, setAmount] = useState(""); const [reason, setReason] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const load = useCallback(async () => setRows(await api<Pkg[]>("admin/packages")), []);
  useEffect(() => { let live = true; api<Pkg[]>("admin/packages").then(r => { if (live) setRows(r); }).catch(() => setRows([])); return () => { live = false; }; }, [data.updatedAt]);
  const open = (p: Partial<Pkg>) => { setEdit(p); setAmount(p.amountToman ? String(p.amountToman) : ""); setReason(""); setError(""); };
  const save = (e: React.FormEvent) => { e.preventDefault(); if (!edit) return; setBusy(true); setError(""); void act(async () => { await api(edit.id ? `admin/packages/${edit.id}` : "admin/packages", { method: edit.id ? "PUT" : "POST", body: { label: edit.label || "", subtitle: edit.subtitle || "", amountToman: Number(amount), icon: edit.icon || "sparkle", featured: !!edit.featured, active: edit.active !== false, sort: edit.sort ?? (rows?.length || 0) + 1, reason } }); await load(); await refresh(); setEdit(null); notify("بسته ذخیره شد و در صفحه خرید اعمال شد."); }, setError).finally(() => setBusy(false)); };
  const manage = allowed("pricing.manage");
  return <section className="panel"><div className="panel-heading"><h2>بسته‌های خرید</h2><Button tone="secondary" className="btn-small" disabled={!manage || (rows?.length || 0) >= 8} onClick={() => open({ icon: "sparkle", active: true })}><Icon name="purchase" size={15} />بسته جدید</Button></div>
    {rows === null ? <div className="skeleton skeleton-chart" /> : rows.length ? <div className="table-scroll"><table><thead><tr><th>بسته</th><th>مبلغ</th><th>اعتبار با نرخ فعلی</th><th>وضعیت</th><th /></tr></thead><tbody>{rows.map(p => <tr key={p.id}><td><strong>{p.label}</strong>{p.featured && <Badge tone="warning" dot={false}>پیشنهاد ما</Badge>}<span className="cell-subtitle">{p.subtitle}</span></td><td>{fa(p.amountToman)} تومان</td><td>{compact(Number(BigInt(p.amountToman) * BigInt(10) * BigInt(data.pricing.creditsPerUsd) / BigInt(data.pricing.rateIrr)))}</td><td><Badge tone={p.active ? "success" : "neutral"}>{p.active ? "فعال" : "غیرفعال"}</Badge></td><td><Button tone="secondary" className="btn-small" disabled={!manage} onClick={() => open(p)}>ویرایش</Button></td></tr>)}</tbody></table></div> : <Empty title="بسته‌ای تعریف نشده" text="بدون بسته، مشتری فقط مبلغ دلخواه را می‌بیند." icon="cart" />}
    <div className="table-note"><Icon name="info" size={14} />تغییر بسته فقط پیش‌فاکتورهای جدید را تحت تأثیر قرار می‌دهد.</div>
    {edit && <Modal title={edit.id ? "ویرایش بسته" : "بسته جدید"} onClose={() => setEdit(null)}><form className="form-stack" onSubmit={save}>
      <div className="form-grid"><label className="field">نام بسته<input value={edit.label || ""} onChange={e => setEdit({ ...edit, label: e.target.value })} minLength={2} maxLength={30} required /></label><SelectField label="نماد" value={edit.icon || "sparkle"} onChange={v => setEdit({ ...edit, icon: v })} options={[{ value: "sparkle", label: "جرقه", icon: "sparkle" }, { value: "zap", label: "صاعقه", icon: "zap" }, { value: "models", label: "مدل‌ها", icon: "models" }, { value: "wallet", label: "کیف پول", icon: "wallet" }]} /></div>
      <label className="field">توضیح کوتاه<input value={edit.subtitle || ""} onChange={e => setEdit({ ...edit, subtitle: e.target.value })} maxLength={80} /></label>
      <NumericField label="مبلغ" unit="تومان" value={amount} onChange={setAmount} min={data.pricing.minToman} max={data.pricing.maxToman} required describe={v => <>≈ {compact(Number(BigInt(v) * BigInt(10) * BigInt(data.pricing.creditsPerUsd) / BigInt(data.pricing.rateIrr)))} اعتبار با نرخ فعلی</>} />
      <div className="button-row"><label className="checkbox-label"><input type="checkbox" checked={!!edit.featured} onChange={e => setEdit({ ...edit, featured: e.target.checked })} />بسته پیشنهادی</label><label className="checkbox-label"><input type="checkbox" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })} />فعال در صفحه خرید</label></div>
      <label className="field">دلیل تغییر<textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} minLength={10} maxLength={1000} required /></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Button type="submit" busy={busy} disabled={(edit.label || "").trim().length < 2 || !!rangeError(amount, { min: data.pricing.minToman, max: data.pricing.maxToman, required: true }) || reason.trim().length < 10}>ذخیره بسته</Button>
    </form></Modal>}
  </section>;
}

/* ------------------------------------------------------------------ */
/* System settings and roles                                            */
/* ------------------------------------------------------------------ */
export function SystemOps() {
  const { data, refresh, notify } = useApp(); const { act, allowed, security, reload } = useAdminSecurity();
  const [values, setValues] = useState(() => Object.fromEntries(Object.entries(data.system).map(([k, v]) => [k, String(v)])) as Record<keyof typeof SYSTEM_LIMITS, string>);
  const [reason, setReason] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const manage = allowed("system.manage");
  const fields: { key: keyof typeof SYSTEM_LIMITS; label: string; unit: string; hint: string }[] = [
    { key: "transferHours", label: "مهلت واریز سفارش", unit: "ساعت", hint: "برای سفارش‌های جدید؛ سفارش‌های قبلی تغییر نمی‌کنند." },
    { key: "graceMinutes", label: "دوره ارفاق موجودی صفر", unit: "دقیقه", hint: "صفر یعنی توقف فوری پذیرش درخواست." },
    { key: "lowBalanceCredits", label: "آستانه هشدار کمبود اعتبار مشتری", unit: "اعتبار", hint: "اعلان «اعتبار رو به اتمام» زیر این مقدار نمایش داده می‌شود." },
    { key: "maxKeys", label: "حداکثر کلید فعال هر حساب", unit: "کلید", hint: "" },
  ];
  const invalid = fields.some(f => rangeError(values[f.key], { min: SYSTEM_LIMITS[f.key][0], max: SYSTEM_LIMITS[f.key][1], required: true }));
  return <div className="settings-layout">
    <section className="panel padded"><div className="section-title"><h2>تنظیمات سیستم</h2><Badge tone="warning">حسابرسی‌شده</Badge></div>
      <form className="form-stack" onSubmit={e => { e.preventDefault(); setBusy("system"); setError(""); void act(async () => { await api("admin/system", { method: "PUT", body: { ...Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])), reason } }); await refresh(); setReason(""); notify("تنظیمات سیستم ذخیره شد."); }, setError).finally(() => setBusy("")); }}>
        {fields.map(f => <NumericField key={f.key} label={f.label} unit={f.unit} value={values[f.key]} onChange={v => setValues({ ...values, [f.key]: v })} min={SYSTEM_LIMITS[f.key][0]} max={SYSTEM_LIMITS[f.key][1]} required hint={`${f.hint} مجاز: ${fa(SYSTEM_LIMITS[f.key][0])} تا ${fa(SYSTEM_LIMITS[f.key][1])}.`} disabled={!manage} />)}
        <label className="field">دلیل تغییر<textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} minLength={10} maxLength={1000} required disabled={!manage} /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <Button type="submit" busy={busy === "system"} disabled={!manage || invalid || reason.trim().length < 10}>ذخیره تنظیمات</Button>
        {!manage && <Notice>فقط نقش «مالک» می‌تواند تنظیمات سیستم را تغییر دهد.</Notice>}
      </form>
    </section>
    <section className="panel padded"><div className="section-title"><h2>نقش‌ها و دسترسی‌ها</h2><Badge>RBAC سمت سرور</Badge></div>
      <div className="role-list">{(Object.keys(ROLE_INFO) as Role[]).map(r => <div key={r} className={security?.role === r ? "current" : ""}><div><strong>{ROLE_INFO[r].label}</strong><p>{ROLE_INFO[r].description}</p></div>{security?.role === r ? <Badge tone="success">نقش فعلی</Badge> : <Button tone="secondary" className="btn-small" busy={busy === r} onClick={() => { setBusy(r); void act(async () => { await api("admin/role", { body: { role: r } }); await reload(); await refresh(); notify(`نقش آزمایشی به «${ROLE_INFO[r].label}» تغییر کرد.`, "info"); }).finally(() => setBusy("")); }}>شبیه‌سازی</Button>}</div>)}</div>
      <Notice>در این پیش‌نمایش فقط یک حساب وجود دارد؛ «شبیه‌سازی نقش» برای آزمون محدودیت‌های سمت سرور است و در حسابرسی ثبت می‌شود. در نسخه عملیاتی، نقش‌ها فقط توسط مالک اختصاص داده می‌شوند.</Notice>
    </section>
  </div>;
}
