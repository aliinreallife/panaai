"use client";
import React, { createContext, useContext, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { LayoutDashboard, Wallet, Plus, ReceiptText, KeyRound, ChartNoAxesCombined, Boxes, BookOpen, Settings2, Headphones, ChevronLeft, ChevronDown, ArrowUpLeft, ArrowUpRight, ArrowDownLeft, ArrowLeft, Activity, Bell, Sun, Moon, Menu, X, Copy, Check, Info, CircleCheck, TriangleAlert, CalendarDays, Download, Search, SlidersHorizontal, MoreHorizontal, RefreshCw, ExternalLink, Clock3, ShieldCheck, LockKeyhole, CreditCard, UploadCloud, Eye, Trash2, RotateCw, FileImage, ArrowRight, Sparkles, Zap, CircleHelp, FlaskConical, Code2, Terminal, Send, UserRound, CircleX, LoaderCircle, Shield, Monitor, Globe, CirclePause, CircleArrowDown, LogIn, Home, Box, ShoppingCart, ChartColumn, Layers3, LogOut, Command, History } from "lucide-react";
import type { AppData, OrderItem, UsageItem } from "@/lib/shared";
import { MODEL_CATALOG, ORDER_STATES, fa } from "@/lib/shared";
const icons = { home: Home, box: Box, cart: ShoppingCart, chart: ChartColumn, stack: Layers3, logout: LogOut, command: Command, history: History, overview: LayoutDashboard, wallet: Wallet, purchase: Plus, orders: ReceiptText, keys: KeyRound, usage: ChartNoAxesCombined, models: Boxes, docs: BookOpen, settings: Settings2, support: Headphones, chevron: ChevronLeft, down: ChevronDown, upLeft: ArrowUpLeft, upRight: ArrowUpRight, downLeft: ArrowDownLeft, left: ArrowLeft, activity: Activity, bell: Bell, sun: Sun, moon: Moon, menu: Menu, close: X, copy: Copy, check: Check, info: Info, success: CircleCheck, warning: TriangleAlert, calendar: CalendarDays, download: Download, search: Search, filter: SlidersHorizontal, more: MoreHorizontal, refresh: RefreshCw, external: ExternalLink, clock: Clock3, secure: ShieldCheck, lock: LockKeyhole, card: CreditCard, upload: UploadCloud, eye: Eye, trash: Trash2, rotate: RotateCw, image: FileImage, right: ArrowRight, sparkle: Sparkles, zap: Zap, help: CircleHelp, demo: FlaskConical, code: Code2, terminal: Terminal, send: Send, user: UserRound, error: CircleX, loading: LoaderCircle, shield: Shield, monitor: Monitor, globe: Globe, pause: CirclePause, arrowDown: CircleArrowDown, login: LogIn };
export function Icon({ name, size = 20, className = "" }: { name: string; size?: number; className?: string }) { const Component = icons[name as keyof typeof icons] || CircleHelp; return <Component size={size} strokeWidth={1.7} className={className} aria-hidden="true" />; }
export type ToastTone = "success" | "error" | "info";
export type AppContextValue = { data: AppData; refresh: () => Promise<void>; notify: (message: string, tone?: ToastTone) => void; openKey: () => void; openOrder: (order: OrderItem) => void; openUsage: (usage: UsageItem) => void; openStatus: () => void; range: number; setRange: (range: number) => void; theme: string; setTheme: (theme: string) => void; baseUrl: string };
export const AppContext = createContext<AppContextValue | null>(null);
export const useApp = () => { const value = useContext(AppContext); if (!value) throw new Error("Missing app context"); return value; };
export async function api<T = Record<string, unknown>>(route: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const form = options.body instanceof FormData;
  const response = await fetch(`/api/v1/${route}`, { method: options.method || (options.body ? "POST" : "GET"), headers: options.body && !form ? { "Content-Type": "application/json" } : undefined, body: options.body ? form ? options.body as FormData : JSON.stringify(options.body) : undefined, credentials: "same-origin", cache: "no-store", signal: options.signal });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure = new Error(result.message || "درخواست انجام نشد؛ دوباره تلاش کنید.") as ApiFailure;
    failure.status = response.status; failure.code = result.code;
    const wait = Number(response.headers.get("Retry-After") || result.retryAfter || 0);
    if (Number.isFinite(wait) && wait > 0) failure.retryAfter = Math.ceil(wait);
    throw failure;
  }
  return result as T;
}
export type ApiFailure = Error & { status?: number; code?: string; retryAfter?: number };
export function Button({ children, tone = "primary", busy = false, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: string; busy?: boolean }) { return <button {...props} disabled={props.disabled || busy} className={`btn btn-${tone} ${className}`}>{busy && <Icon name="loading" size={17} className="spin" />}{children}</button>; }
export function ActionLink({ href, children, tone = "primary", className = "" }: { href: string; children: React.ReactNode; tone?: string; className?: string }) { return <Link href={href} className={`btn btn-${tone} ${className}`}>{children}</Link>; }
export function Badge({ children, tone = "neutral", dot = true }: { children: React.ReactNode; tone?: string; dot?: boolean }) { return <span className={`badge badge-${tone}`}>{dot && <i />}{children}</span>; }
export function OrderBadge({ state }: { state: string }) { const info = ORDER_STATES[state] || { label: state, tone: "neutral" }; return <Badge tone={info.tone}>{info.label}</Badge>; }
export function Notice({ children, tone = "info", title, icon }: { children: React.ReactNode; tone?: string; title?: string; icon?: string }) { return <div className={`notice notice-${tone}`} role={tone === "danger" ? "alert" : undefined}><Icon name={icon || (tone === "warning" ? "warning" : tone === "success" ? "secure" : "info")} size={20} /><div>{title && <strong>{title}</strong>}<div>{children}</div></div></div>; }
export function PageTitle({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) { return <div className="page-title"><div><h1>{title}</h1><p>{description}</p></div><div className="page-actions">{children}</div></div>; }
export function Empty({ title = "هنوز اطلاعاتی ثبت نشده", text, icon = "orders", children }: { title?: string; text?: string; icon?: string; children?: React.ReactNode }) { return <div className="empty-state"><div className="empty-icon"><Icon name={icon} size={29} /></div><h3>{title}</h3>{text && <p>{text}</p>}{children}</div>; }
export function CopyButton({ value, label = "کپی", compact = false }: { value: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const ta = document.createElement("textarea");
        ta.value = value; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        if (!document.execCommand("copy")) throw new Error("copy failed");
        ta.remove();
      }
      setCopied(true); setFailed(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setFailed(true); }
  };
  return <button type="button" className={`${compact ? "icon-btn copy-btn" : "copy-label"} ${copied ? "copied" : ""}`} title={copied ? "کپی شد ✓" : label} aria-label={copied ? "کپی شد" : label} onClick={copy}><Icon name={copied ? "check" : "copy"} size={16} />{!compact && <span aria-live="polite">{failed ? "متن را انتخاب و کپی کنید" : copied ? "کپی شد ✓" : label}</span>}</button>;
}
export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null); const id = useId(); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    const focusTimer = setTimeout(() => { const first = ref.current?.querySelector<HTMLElement>("input:not([disabled]),select,textarea") || ref.current?.querySelector<HTMLElement>("button"); first?.focus(); }, 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key !== "Tab") return;
      const focusable = ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),select,textarea,[tabindex="0"]');
      if (!focusable?.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(focusTimer); document.body.style.overflow = overflow; document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, []);
  return createPortal(<div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} dir="rtl"><div className="modal-heading"><div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-btn" onClick={onClose} aria-label="بستن پنجره"><Icon name="close" /></button></div><div className="modal-body">{children}</div></div></div>, document.body);
}
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) { return <button type="button" className={`toggle ${checked ? "on" : ""}`} role="switch" aria-checked={checked} aria-label={label} onClick={onChange}><span /></button>; }
export function ModelMark({ model, size = 28 }: { model: string; size?: number }) {
  const item = MODEL_CATALOG.find(m => m.id === model);
  const lower = model.toLowerCase();
  const mark = item?.mark
    || (lower.includes("claude") || lower.includes("anthropic") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku") || lower.includes("fable") ? "claude"
      : lower.includes("gemini") || lower.includes("google") ? "gemini"
        : lower.includes("deepseek") ? "deepseek"
          : "openai");
  return <span className={`model-mark model-${mark}`} style={{ width: size, height: size }}>
    {mark === "claude" ? <svg viewBox="0 0 30 30" fill="none" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <path key={i} d="M15 3V11" transform={`rotate(${i * 30} 15 15)`} stroke="currentColor" strokeWidth="1.8" />)}</svg> : mark === "gemini" ? <svg viewBox="0 0 28 28" fill="currentColor" aria-hidden="true"><path d="M14 2C14 9 9 14 2 14C9 14 14 19 14 26C14 19 19 14 26 14C19 14 14 9 14 2Z" /></svg> : mark === "deepseek" ? <svg viewBox="0 0 30 30" fill="currentColor" aria-hidden="true"><path d="M4 12c4 2 7-5 14-2 5 2 7 5 7 8l4-3-1 6-5 1C9 28 3 20 4 12Z" /><circle cx="20" cy="15" r="1" fill="white" /><path d="m14 9-3-4 7 3Z" /></svg> : <svg viewBox="0 0 30 30" fill="none" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <rect key={i} x="12" y="4" width="11" height="15" rx="5" transform={`rotate(${i * 60} 15 15)`} stroke="currentColor" strokeWidth="1.4" />)}</svg>}
  </span>;
}
export function SearchInput({ value, onChange, placeholder = "جست‌وجو..." }: { value: string; onChange: (v: string) => void; placeholder?: string }) { return <label className="search-input"><Icon name="search" size={18} /><input aria-label={placeholder} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />{value ? <button type="button" className="search-clear" aria-label="پاک‌کردن جست‌وجو" onClick={() => onChange("")}><Icon name="close" size={14} /></button> : null}</label>; }
export function Pagination({ page, total, size = 10, setPage }: { page: number; total: number; size?: number; setPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  const nums: (number | "…")[] = [];
  if (pages <= 7) { for (let i = 1; i <= pages; i++) nums.push(i); }
  else {
    nums.push(1);
    if (page > 3) nums.push("…");
    for (let i = Math.max(2, page - 1); i <= Math.min(pages - 1, page + 1); i++) nums.push(i);
    if (page < pages - 2) nums.push("…");
    nums.push(pages);
  }
  return <div className="pagination"><span>{total ? `${fa((page - 1) * size + 1)} تا ${fa(Math.min(page * size, total))} از ${fa(total)} مورد` : "بدون نتیجه"}</span><div className="pagination-pages"><button aria-label="صفحه قبل" className="icon-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}><Icon name="right" size={16} /></button>{nums.map((n, i) => n === "…" ? <span key={`e${i}`} className="page-ellipsis" aria-hidden="true">…</span> : <button key={n} className={`page-number ${n === page ? "current" : ""}`} aria-label={`صفحه ${fa(n)}`} aria-current={n === page ? "page" : undefined} onClick={() => setPage(n)}>{fa(n)}</button>)}<button className="icon-btn" aria-label="صفحه بعد" disabled={page >= pages} onClick={() => setPage(page + 1)}><Icon name="left" size={16} /></button></div></div>;
}
export function downloadCsv(name: string, headers: string[], rows: (string | number)[][]) {
  const csv = "\ufeff" + [headers, ...rows].map(row => row.map(v => `"${String(v).replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
}
