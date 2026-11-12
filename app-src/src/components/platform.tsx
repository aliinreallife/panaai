"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AppData, OrderItem, UsageItem, fa, persianDate, persianTime, ascii } from "@/lib/shared";
import { AppContext, Badge, Button, CopyButton, Empty, Icon, Modal, Notice, ToastTone, api, useApp, type ApiFailure } from "@/components/ui";
import { RetryCountdown } from "@/components/ux-fields";
import { PROVIDER_STATE_INFO } from "@/lib/rules";
import { Dashboard } from "@/components/dashboard";
import { PurchaseView, OrdersView, OrderDetail } from "@/components/purchases";
import { WalletView, KeysView, UsageView, KeyModal } from "@/components/account-views";
import { DocsView, ModelsView, SettingsView, SupportView } from "@/components/resource-views";
import { AdminView } from "@/components/admin";
import { RoadmapView } from "@/components/prd-coverage";
import { PanaBrand } from "@/components/brand-art";
import { CommandSearch } from "@/components/command-search";
import { isUnread, notificationsFor } from "@/lib/notifications";
import { Breadcrumbs, CardsSkeleton, FormSkeleton, OfflineBanner, Skeleton, TableSkeleton } from "@/components/ux-helpers";

let bootstrapPromise: Promise<AppData> | null = null;
let clientCache: AppData | null = null;
const primaryNav = [
  { id: "overview", href: "/", label: "نمای کلی", icon: "home" },
  { id: "models", href: "/models", label: "مدل‌های هوش مصنوعی", icon: "box" },
  { id: "keys", href: "/keys", label: "کلیدهای API", icon: "keys" },
  { id: "purchase", href: "/purchase", label: "خرید اعتبار", icon: "cart" },
  { id: "orders", href: "/orders", label: "سفارش‌ها و تراکنش‌ها", icon: "orders" },
  { id: "usage", href: "/usage", label: "تحلیل مصرف", icon: "chart" },
];
const secondaryNav = [{ id: "wallet", href: "/wallet", label: "کیف پول", icon: "wallet" }, { id: "docs", href: "/docs", label: "مستندات و راهنما", icon: "docs" }, { id: "support", href: "/support", label: "پشتیبانی", icon: "support" }];
const operatorNav = [{ id: "roadmap", href: "/roadmap", label: "وضعیت PRD", icon: "history" }];
const VIEW_META: Record<string, { title: string; crumb: string }> = {
  overview: { title: "نمای کلی", crumb: "نمای کلی" },
  wallet: { title: "کیف پول", crumb: "کیف پول" },
  purchase: { title: "خرید اعتبار", crumb: "خرید اعتبار" },
  orders: { title: "سفارش‌ها و تراکنش‌ها", crumb: "سفارش‌ها و تراکنش‌ها" },
  keys: { title: "کلیدهای API", crumb: "کلیدهای API" },
  usage: { title: "تحلیل مصرف", crumb: "تحلیل مصرف" },
  models: { title: "مدل‌های هوش مصنوعی", crumb: "مدل‌های هوش مصنوعی" },
  docs: { title: "مستندات و راهنما", crumb: "مستندات و راهنما" },
  settings: { title: "تنظیمات حساب", crumb: "تنظیمات" },
  support: { title: "پشتیبانی", crumb: "پشتیبانی" },
  admin: { title: "مدیریت", crumb: "مدیریت" },
  roadmap: { title: "وضعیت پیاده‌سازی PRD", crumb: "نقشه راه PRD" },
};
type ActiveModal = "key" | "status" | "notifications" | "login" | "search" | "account" | "logout" | null;
export default function Platform({ view = "overview" }: { view?: string }) {
  const [data, setData] = useState<AppData | null>(null); const [error, setError] = useState(""); const [retryAfter, setRetryAfter] = useState(0);
  const [theme, setThemeState] = useState("dark"); const [range, setRangeState] = useState(30); const [mobile, setMobile] = useState(false);
  const [modal, setModal] = useState<ActiveModal>(null); const [order, setOrder] = useState<OrderItem | null>(null); const [request, setRequest] = useState<UsageItem | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null); const [baseUrl, setBaseUrl] = useState("/v1"); const [loggedOut, setLoggedOut] = useState(false); const [actionBusy, setActionBusy] = useState(false);
  const notify = useCallback((message: string, tone: ToastTone = "success") => setToast({ message, tone }), []);
  const load = useCallback(async () => {
    setError("");
    try {
      if (clientCache) { setData(clientCache); return; }
      if (!bootstrapPromise) bootstrapPromise = api<AppData>("bootstrap", { method: "POST" }).finally(() => { bootstrapPromise = null; });
      const result = await bootstrapPromise; clientCache = result; setData(result); setRetryAfter(0);
    } catch (e) { setError((e as Error).message); setRetryAfter((e as ApiFailure).retryAfter || 0); }
  }, []);
  const refresh = useCallback(async () => { const result = await api<AppData>("data"); clientCache = result; setData(result); }, []);
  const setTheme = useCallback((value: string) => { setThemeState(value); localStorage.setItem("pana-theme", value); document.documentElement.dataset.theme = value === "system" ? matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : value; }, []);
  const setRange = useCallback((value: number) => { if (![7,30,90].includes(value)) return; setRangeState(value); sessionStorage.setItem("pana-range", String(value)); }, []);
  useEffect(() => {
    if (sessionStorage.getItem("pana-session-ended")) setLoggedOut(true); else void load();
    setTheme(localStorage.getItem("pana-theme") || "dark");
    const days = Number(new URLSearchParams(window.location.search).get("days") || sessionStorage.getItem("pana-range") || "30"); if ([7,30,90].includes(days)) setRangeState(days);
    setBaseUrl(`${window.location.origin}/v1`);
  }, [load, setTheme]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), 5000); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    setMobile(false); setModal(null); setOrder(null); setRequest(null);
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [view]);
  useEffect(() => {
    const openSearch = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && data) { event.preventDefault(); setModal(current => current === "search" ? null : "search"); } };
    document.addEventListener("keydown", openSearch); return () => document.removeEventListener("keydown", openSearch);
  }, [data]);
  useEffect(() => {
    if (!data) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible" && !modal) void refresh().catch(() => undefined); }, 60000);
    return () => clearInterval(timer);
  }, [data?.user.id, modal, refresh]);
  useEffect(() => {
    if (!mobile) return;
    const previous = document.activeElement as HTMLElement | null; const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const drawer = document.querySelector<HTMLElement>(".sidebar"); drawer?.querySelector<HTMLElement>("a,button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobile(false);
      if (event.key !== "Tab") return;
      const nodes = drawer?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])'); if (!nodes?.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
      if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [mobile]);
  useEffect(() => { const media = matchMedia("(prefers-color-scheme: dark)"); const listener = () => { if (theme === "system") document.documentElement.dataset.theme = media.matches ? "dark" : "light"; }; media.addEventListener("change", listener); return () => media.removeEventListener("change", listener); }, [theme]);
  const notices = useMemo(() => data ? notificationsFor(data) : [], [data]);
  const unreadCount = notices.filter(item => isUnread(item, data?.user.settings.notificationsReadAt)).length;
  const initials = data?.user.name.split(" ").map(n => n[0]).slice(0, 2).join(" ") || "آ م";
  const currentOrder = order && data ? data.orders.find(o => o.id === order.id) || order : order;
  const openOrder = (item: OrderItem) => { setModal(null); setRequest(null); setOrder(item); };
  const openUsage = (item: UsageItem) => { setModal(null); setOrder(null); setRequest(item); };
  const logout = async () => { setActionBusy(true); try { await api("auth/logout", { method: "POST" }); clientCache = null; setData(null); setModal(null); setMobile(false); setOrder(null); setRequest(null); sessionStorage.setItem("pana-session-ended", "yes"); setLoggedOut(true); } catch (e) { notify((e as Error).message, "error"); } finally { setActionBusy(false); } };
  const body = () => { switch (view) { case "overview": return <Dashboard />; case "purchase": return <PurchaseView />; case "orders": return <OrdersView />; case "wallet": return <WalletView />; case "keys": return <KeysView />; case "usage": return <UsageView />; case "models": return <ModelsView />; case "docs": return <DocsView />; case "settings": return <SettingsView />; case "support": return <SupportView />; case "admin": return data?.account.operator ? <AdminView /> : <Empty title="صفحه پیدا نشد" text="از منوی کنار به بخش مورد نظر بروید." />; case "roadmap": return data?.account.operator ? <RoadmapView /> : <Empty title="صفحه پیدا نشد" text="از منوی کنار به بخش مورد نظر بروید." />; default: return <Empty title="صفحه پیدا نشد" text="از منوی کنار به بخش مورد نظر بروید." />; } };
  const cycleTheme = () => {
    const order = ["dark", "light", "system"];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    setTheme(next);
    notify(`حالت نمایش: ${next === "dark" ? "تیره" : next === "light" ? "روشن" : "خودکار (سیستم)"}`, "info");
  };
  const navLink = (item: typeof primaryNav[number]) => <Link href={item.href} key={item.id} className={`rail-link ${view === item.id ? "rail-active" : ""}`} aria-label={item.label} aria-current={view === item.id ? "page" : undefined}><Icon name={item.icon} size={25} /><span className="rail-label">{item.label}</span><span className="rail-tooltip" aria-hidden="true">{item.label}</span>{item.id === "orders" && data?.orders.some(o => ["receipt_submitted","needs_more_information"].includes(o.state)) && <i className="rail-dot" />}</Link>;
  return <AppContext.Provider value={data ? { data, refresh, notify, openKey: () => setModal("key"), openOrder, openUsage, openStatus: () => setModal("status"), range, setRange, theme, setTheme, baseUrl } : null}>
    <div className="app-shell pana-shell" dir="rtl">{mobile && <button className="sidebar-overlay" aria-label="بستن منو" onClick={() => setMobile(false)} />}
      <aside className={`sidebar pana-rail ${mobile ? "sidebar-open" : ""}`} aria-label="ناوبری فضای کار" onClick={event => { if ((event.target as Element).closest("a")) setMobile(false); }}><div className="rail-mobile-brand"><PanaBrand /><button className="icon-btn" aria-label="بستن منو" onClick={() => setMobile(false)}><Icon name="close" /></button></div><nav className="rail-primary" aria-label="منوی اصلی">{primaryNav.map(navLink)}</nav><div className="rail-separator" /><nav className="rail-secondary" aria-label="راهنما و کیف پول">{secondaryNav.map(navLink)}{data?.account.operator && operatorNav.map(navLink)}</nav><nav className="rail-bottom" aria-label="تنظیمات و امنیت">{data?.account.operator && navLink({ id: "admin", href: "/admin", label: "مدیریت", icon: "shield" })}{navLink({ id: "settings", href: "/settings", label: "تنظیمات", icon: "settings" })}<button className="rail-link rail-exit" aria-label="خروج از حساب" disabled={!data} onClick={() => { setMobile(false); setModal("logout"); }}><Icon name="logout" size={24} /><span className="rail-label">خروج از حساب</span><span className="rail-tooltip" aria-hidden="true">خروج از حساب</span></button></nav></aside>
      <div className="workspace"><header className="topbar pana-topbar" dir="ltr"><PanaBrand /><div className="pana-header-actions"><button className="header-search" title="جست‌وجو · Ctrl/⌘+K" aria-label="باز کردن جست‌وجو" onClick={() => setModal("search")} disabled={!data}><Icon name="search" size={23} /></button><button className="icon-btn theme-button theme-cycle" title={`حالت فعلی: ${theme === "dark" ? "تیره" : theme === "light" ? "روشن" : "خودکار"} — کلیک برای تغییر`} aria-label="چرخه حالت نمایش: تیره، روشن، خودکار" onClick={cycleTheme}><Icon name={theme === "system" ? "monitor" : theme === "dark" ? "sun" : "moon"} size={20} /></button><button className="header-notifications" title="اعلان‌ها" aria-label="نمایش اعلان‌ها" onClick={() => setModal("notifications")} disabled={!data}><Icon name="bell" size={24} />{unreadCount > 0 && <span>{fa(unreadCount)}</span>}</button><span className="header-divider" /><button className="account-trigger" title="حساب کاربری" aria-label="باز کردن منوی حساب" onClick={() => setModal("account")} disabled={!data}><span className="header-avatar">{initials}</span><Icon name="down" size={18} /></button><button className="icon-btn mobile-only" onClick={() => setMobile(true)} aria-label="باز کردن منو"><Icon name="menu" size={23} /></button></div></header>
        <main className={`main-content ${view === "overview" ? "overview-content" : "inner-content"}`} id="main-content"><OfflineBanner />{data && view !== "overview" && VIEW_META[view] ? <Breadcrumbs trail={[{ label: VIEW_META[view].crumb }]} /> : null}{loggedOut ? <section className="panel session-gate"><span className="session-gate-icon"><Icon name="secure" size={34} /></span><h1>نشست شما با امنیت پایان یافت</h1><p>نشست روی سرور لغو شد؛ سفارش‌ها و سوابق مالی حذف نشده‌اند.</p><Notice>این پیش‌نمایش ورود واقعی ندارد. با ادامه، یک فضای آزمایشی مستقل و جدید ساخته می‌شود.</Notice><Button onClick={() => { sessionStorage.removeItem("pana-session-ended"); setLoggedOut(false); void load(); }}>ساخت فضای آزمایشی جدید<Icon name="left" size={17} /></Button></section> : data ? body() : error ? <div className="load-error"><Notice tone="danger" title="بارگذاری اطلاعات انجام نشد">{error}</Notice>{retryAfter > 0 ? <RetryCountdown key={retryAfter + error} seconds={retryAfter} onRetry={() => void load()} label="تلاش دوباره" /> : <Button onClick={() => void load()}><Icon name="refresh" size={16} />تلاش دوباره</Button>}</div> : <ViewSkeleton view={view} />}</main>
      </div>
    </div>
    {data && modal === "key" && <KeyModal onClose={() => setModal(null)} />}
    {data && modal === "search" && <CommandSearch onClose={() => setModal(null)} />}
    {data && currentOrder && <OrderDetail order={currentOrder} onClose={() => setOrder(null)} />}
    {data && modal === "account" && <Modal title="حساب کاربری شما" description="فضای کار شخصی PanaAI" onClose={() => setModal(null)}><div className="account-card"><span className="account-avatar">{initials}</span><div><h3>{data.user.name}</h3>{data.mode === "sandbox" && <Badge tone="warning">حساب آزمایشی</Badge>}</div></div><div className="account-menu"><Link href="/settings" onClick={() => setModal(null)}><Icon name="settings" />تنظیمات و اعلان‌ها<Icon name="chevron" size={15} /></Link><Link href="/wallet" onClick={() => setModal(null)}><Icon name="wallet" />کیف پول و انقضای اعتبار<Icon name="chevron" size={15} /></Link><button onClick={() => setModal("login")}><Icon name="login" />آزمایش ورود با موبایل<Icon name="chevron" size={15} /></button><button onClick={() => setModal("logout")} className="account-exit"><Icon name="logout" />خروج از حساب<Icon name="chevron" size={15} /></button></div></Modal>}
    {data && modal === "logout" && <Modal title="از فضای کار خارج می‌شوید؟" description="نشست فعلی روی سرور لغو می‌شود." onClose={() => { if (!actionBusy) setModal(null); }}><Notice tone="warning">کلیدها، سفارش‌ها و سوابق حذف نمی‌شوند. این محیط آزمایشی هنوز ورود واقعی ندارد؛ پس از خروج فقط می‌توانید یک فضای آزمایشی جدید بسازید.</Notice><div className="modal-actions"><Button tone="secondary" disabled={actionBusy} onClick={() => setModal(null)}>ماندن در حساب</Button><Button tone="danger" busy={actionBusy} onClick={logout}>خروج از حساب</Button></div></Modal>}
    {data && modal === "status" && <StatusModal onClose={() => setModal(null)} />}
    {data && modal === "notifications" && <Modal title="اعلان‌های شما" description={unreadCount ? `${fa(unreadCount)} اعلان خوانده‌نشده` : "همه اعلان‌ها خوانده شده‌اند"} onClose={() => setModal(null)}><div className="notification-list">{notices.map(item => <Link href={item.href} onClick={() => setModal(null)} key={item.id} className={isUnread(item, data.user.settings.notificationsReadAt) ? "notification-unread" : ""}><span className={`notification-icon ${item.tone}`}><Icon name={item.icon} size={21} /></span><div><strong>{item.title}</strong><p>{item.description}</p><small>{persianDate(item.createdAt)} · {persianTime(item.createdAt)}</small></div><Icon name="chevron" size={15} /></Link>)}</div><Button tone="secondary" className="full-width" busy={actionBusy} disabled={!unreadCount} onClick={async () => { setActionBusy(true); try { await api("notifications/read", { method: "POST" }); await refresh(); notify("اعلان‌ها به‌عنوان خوانده‌شده ذخیره شدند."); } catch (e) { notify((e as Error).message, "error"); } finally { setActionBusy(false); } }}><Icon name="check" size={17} />علامت‌گذاری همه به‌عنوان خوانده‌شده</Button></Modal>}
    {data && modal === "login" && <LoginModal onClose={() => setModal(null)} onSuccess={() => { setModal(null); notify("ورود آزمایشی تأیید شد؛ هیچ پیامک واقعی ارسال نشده است."); }} />}
    {request && <Modal title="جزئیات درخواست" description="فقط فراداده؛ محتوای ورودی و خروجی ذخیره نمی‌شود" onClose={() => setRequest(null)}><div className="request-id"><code dir="ltr">{request.requestId}</code><CopyButton value={request.requestId} compact /></div><dl className="detail-list"><div><dt>مدل</dt><dd dir="ltr">{request.model}</dd></div><div><dt>کلید</dt><dd>{request.keyName}</dd></div><div><dt>اعتبار مصرف‌شده</dt><dd>{fa(request.credits)}</dd></div><div><dt>توکن ورودی / خروجی</dt><dd>{fa(request.inputTokens)} / {fa(request.outputTokens)}</dd></div><div><dt>زمان پاسخ</dt><dd>{fa(request.latency)} میلی‌ثانیه</dd></div><div><dt>زمان ثبت</dt><dd>{persianDate(request.createdAt)}، {persianTime(request.createdAt)}</dd></div><div><dt>وضعیت</dt><dd><Badge tone={request.status === "success" ? "success" : "danger"}>{request.status === "success" ? "موفق" : "ناموفق"}</Badge></dd></div></dl></Modal>}
    {toast && <div className={`toast toast-${toast.tone}`} role="status"><Icon name={toast.tone === "error" ? "error" : toast.tone === "info" ? "info" : "success"} size={21} /><span>{toast.message}</span><button aria-label="بستن پیام" onClick={() => setToast(null)}><Icon name="close" size={16} /></button></div>}
  </AppContext.Provider>;
}
function DashboardSkeleton() { return <div className="dashboard-skeleton" aria-label="در حال بارگذاری" aria-busy="true"><div className="skeleton skeleton-banner" style={{ height: 124 }} /><div className="stats-grid">{[1,2,3,4].map(i => <div className="skeleton skeleton-stat" key={i} />)}</div><div className="chart-grid"><div className="skeleton skeleton-chart" /><div className="skeleton skeleton-chart" /></div><div className="skeleton skeleton-chart" /></div>; }
function ViewSkeleton({ view }: { view: string }) {
  if (view === "overview") return <DashboardSkeleton />;
  if (view === "usage") return <div className="dashboard-skeleton" aria-label="در حال بارگذاری گزارش" aria-busy="true"><Skeleton className="skeleton-banner" style={{ height: 64 }} /><div className="skeleton-cards"><Skeleton className="skeleton-card" /><Skeleton className="skeleton-card" /><Skeleton className="skeleton-card" /><Skeleton className="skeleton-card" /></div><Skeleton className="skeleton-chart" /><TableSkeleton rows={4} cols={6} /></div>;
  if (view === "purchase" || view === "settings" || view === "support") return <div className="dashboard-skeleton" aria-label="در حال بارگذاری فرم" aria-busy="true"><Skeleton className="skeleton-banner" style={{ height: 56 }} /><FormSkeleton /></div>;
  if (view === "models" || view === "docs") return <div className="dashboard-skeleton" aria-label="در حال بارگذاری" aria-busy="true"><Skeleton className="skeleton-banner" style={{ height: 56 }} /><CardsSkeleton count={4} /></div>;
  return <div className="dashboard-skeleton" aria-label="در حال بارگذاری جدول" aria-busy="true"><Skeleton className="skeleton-banner" style={{ height: 56 }} /><TableSkeleton rows={6} cols={5} /></div>;
}
function StatusModal({ onClose }: { onClose: () => void }) {
  const { data } = useApp();
  const info = PROVIDER_STATE_INFO[data.service.state];
  const sandbox = data.mode === "sandbox";
  return <Modal title="وضعیت سرویس" description="وضعیت لحظه‌ای سرویس API و خرید اعتبار" onClose={onClose}>
    <Notice tone={data.service.admits ? "info" : "warning"} title={`سرویس API: ${info.service}`}>{info.notice}{sandbox && " این محیط آزمایشی است و پاسخ‌های API نمونه‌اند."}</Notice>
    <div className="status-list">
      <div><span><Icon name="globe" />پذیرش درخواست API</span><Badge tone={data.service.admits ? "success" : "warning"}>{data.service.admits ? (sandbox ? "فعال (آزمایشی)" : "فعال") : info.service}</Badge></div>
      <div><span><Icon name="activity" />آخرین بررسی وضعیت</span><strong>{data.service.checkedAt ? persianTime(data.service.checkedAt) : "انجام نشده"}</strong></div>
      <div><span><Icon name="orders" />ثبت سفارش و خرید اعتبار</span><Badge tone={data.account.state === "active" ? "success" : "danger"}>{data.account.state === "active" ? "در دسترس" : "حساب معلق"}</Badge></div>
      {sandbox && <div><span><Icon name="card" />پرداخت واقعی</span><Badge>غیرفعال در محیط آزمایشی</Badge></div>}
    </div>
    <p className="muted small">توقف موقت سرویس API، خرید اعتبار را متوقف نمی‌کند و اعتبار شما محفوظ می‌ماند.{sandbox && " اعتبار و مصرف این محیط آزمایشی‌اند و وجه واقعی دریافت نمی‌شود."}</p>
    <div className="modal-actions"><Button onClick={onClose}>متوجه شدم</Button></div>
  </Modal>;
}
function LoginModal({ onClose, onSuccess }: { onClose: () => void; onSuccess: () => void }) {
  const [phone, setPhone] = useState(""); const [code, setCode] = useState(""); const [challenge, setChallenge] = useState<{ challengeId: string; demo?: boolean; demoCode?: string; message?: string } | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [remaining, setRemaining] = useState(0);
  useEffect(() => { if (remaining <= 0) return; const timer = setTimeout(() => setRemaining(remaining - 1), 1000); return () => clearTimeout(timer); }, [remaining]);
  const submit = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setError(""); try { if (!challenge) { const result = await api<{ challengeId: string; demo?: boolean; demoCode?: string; message?: string; expiresIn?: number }>("auth/otp/request", { body: { phone: ascii(phone) } }); setChallenge(result); setRemaining(result.expiresIn || 120); } else { await api("auth/otp/verify", { body: { challengeId: challenge.challengeId, code: ascii(code) } }); onSuccess(); } } catch (e) { const wait = (e as ApiFailure).retryAfter; setError(wait ? `${(e as Error).message} امکان تلاش دوباره تا ${fa(wait)} ثانیه دیگر.` : (e as Error).message); } finally { setBusy(false); } };
  return <Modal title="ورود با شماره موبایل" description="ورود امن با کد یک‌بارمصرف پیامکی" onClose={onClose}>
    <Notice tone={challenge && challenge.demo === false ? "success" : "warning"}>{challenge?.message || "اگر کلید کاوه‌نگار تنظیم شده باشد پیامک واقعی ارسال می‌شود؛ وگرنه کد آزمایشی همین‌جا نمایش داده می‌شود."}</Notice>
    <form onSubmit={submit} className="form-stack">
      <label className="field">شماره موبایل<input dir="ltr" placeholder="0912 345 6789" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} required disabled={!!challenge} /></label>
      {challenge && <>
        {challenge.demo && challenge.demoCode && <div className="demo-otp">کد آزمایشی: <strong dir="ltr">{challenge.demoCode}</strong><span>{fa(remaining)} ثانیه</span></div>}
        {!challenge.demo && <div className="demo-otp"><span>کد پیامکی ارسال شد</span><span>{fa(remaining)} ثانیه</span></div>}
        <label className="field">کد تأیید<input dir="ltr" inputMode="numeric" placeholder="------" value={code} maxLength={6} onChange={e => setCode(e.target.value)} required /></label>
      </>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <Button busy={busy} className="full-width" type="submit">{challenge ? "تأیید کد و ادامه" : "دریافت کد"}<Icon name="left" size={16} /></Button>
      {challenge && remaining <= 60 && <Button type="button" tone="ghost" onClick={() => { setChallenge(null); setCode(""); }}>دریافت کد جدید</Button>}
      <p className="form-caption">کد ۲ دقیقه معتبر است و فقط یک‌بار قابل استفاده خواهد بود.</p>
    </form>
  </Modal>;
}
