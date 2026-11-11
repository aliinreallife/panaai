"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon, Modal, useApp } from "@/components/ui";
import { MODEL_CATALOG, NAV_ITEMS, ascii, compact } from "@/lib/shared";
const normalize = (s: string) => ascii(s).toLowerCase().replaceAll("ي", "ی").replaceAll("ك", "ک");
export function CommandSearch({ onClose }: { onClose: () => void }) {
  const { data, openKey, openOrder, openUsage } = useApp(); const router = useRouter();
  const [query, setQuery] = useState(""); const [selected, setSelected] = useState(0); const input = useRef<HTMLInputElement>(null); const listId = useId();
  const go = (href: string) => { onClose(); router.push(href); };
  const routes = [...NAV_ITEMS, { id: "docs", label: "مستندات و راهنما", icon: "docs", href: "/docs" }, { id: "support", label: "پشتیبانی", icon: "support", href: "/support" }, { id: "settings", label: "تنظیمات", icon: "settings", href: "/settings" }, { id: "admin", label: "مدیریت آزمایشی", icon: "shield", href: "/admin" }];
  const actions = [{ id: "new-key", title: "ساخت کلید API", description: "عملیات سریع · کلید اختصاصی پروژه", icon: "keys", run: () => { onClose(); setTimeout(openKey, 30); } }, ...routes.map(item => ({ id: item.id, title: item.label, description: "صفحه · فضای کار شما", icon: item.icon, run: () => go(item.href) }))];
  const records = query.trim() ? [
    ...data.orders.map(o => ({ id: o.id, title: o.reference, description: `سفارش · ${compact(o.credits)} اعتبار`, icon: "orders", run: () => { onClose(); setTimeout(() => openOrder(o), 30); } })),
    ...data.keys.map(k => ({ id: k.id, title: k.name, description: `کلید API · ${k.enabled ? "فعال" : "لغوشده"}`, icon: "keys", run: () => go(`/keys?search=${encodeURIComponent(k.name)}`) })),
    ...MODEL_CATALOG.map(m => ({ id: m.id, title: m.name, description: `مدل پیشنهادی · ${m.company}`, icon: "box", run: () => go(`/models?search=${encodeURIComponent(m.name)}`) })),
    ...data.usage.map(u => ({ id: u.id, title: u.requestId, description: `درخواست اخیر · ${u.model}`, icon: "code", run: () => { onClose(); setTimeout(() => openUsage(u), 30); } })),
  ] : [];
  const results = [...actions, ...records].filter(r => !query.trim() || normalize(`${r.title} ${r.description}`).includes(normalize(query.trim()))).slice(0, 9);
  useEffect(() => { const timer = setTimeout(() => input.current?.focus(), 100); return () => clearTimeout(timer); }, []);
  return <Modal title="هر چیزی را سریع پیدا کنید" description="صفحه‌ها، سفارش‌ها، کلیدها و درخواست‌های اخیر خودتان" onClose={onClose}><div className="command-search"><div className="command-input"><Icon name="search" size={22} /><input ref={input} role="combobox" aria-expanded={results.length > 0} aria-controls={listId} aria-activedescendant={results[selected] ? `${listId}-${selected}` : undefined} aria-autocomplete="list" aria-label="جست‌وجوی سراسری" placeholder="نام صفحه، مدل، کلید یا شناسه سفارش..." value={query} onChange={e => { setQuery(e.target.value); setSelected(0); }} onKeyDown={e => { if (e.key === "ArrowDown") { e.preventDefault(); setSelected(n => Math.min(n + 1, results.length - 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setSelected(n => Math.max(n - 1, 0)); } if (e.key === "Enter") { e.preventDefault(); results[selected]?.run(); } }} /><kbd>ESC</kbd></div><div id={listId} role="listbox" aria-label="نتایج جست‌وجو" className="command-results">{results.map((r, i) => <button type="button" role="option" aria-selected={i === selected} id={`${listId}-${i}`} key={r.id} onPointerMove={() => setSelected(i)} onClick={r.run}><span className="command-result-icon"><Icon name={r.icon} size={20} /></span><span><strong>{r.title}</strong><small>{r.description}</small></span><Icon name="chevron" size={15} /></button>)}{!results.length && <div className="command-empty"><Icon name="search" size={29} /><strong>نتیجه‌ای پیدا نشد</strong><p>نام صفحه یا بخشی از شناسه سفارش را امتحان کنید.</p></div>}</div><div className="command-hint"><span><kbd>↑</kbd><kbd>↓</kbd> انتخاب نتیجه</span><span><kbd>Enter</kbd> باز کردن</span></div></div></Modal>;
}
