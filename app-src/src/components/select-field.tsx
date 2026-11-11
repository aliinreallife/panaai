"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui";
export type SelectOption = { value: string; label: string; description?: string; icon?: string };
export function SelectField({ value, onChange, options, label, icon, compact = false, className = "", disabled = false }: { value: string; onChange: (value: string) => void; options: SelectOption[]; label: string; icon?: string; compact?: boolean; className?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const searchable = options.length > 6;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => `${o.label} ${o.description || ""} ${o.value}`.toLowerCase().includes(q));
  }, [options, query]);
  const selected = options.find(o => o.value === value) || options[0];
  useEffect(() => {
    if (!open) { setQuery(""); return; }
    const close = (e: PointerEvent) => { if (!container.current?.contains(e.target as Node)) setOpen(false); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    if (searchable) setTimeout(() => searchRef.current?.focus(), 30);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape, true); };
  }, [open, searchable]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  const choose = (opt: SelectOption) => { onChange(opt.value); setOpen(false); setQuery(""); button.current?.focus(); };
  const keyboard = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (!open) { setOpen(true); setActive(Math.max(0, filtered.findIndex(o => o.value === value))); } else setActive(i => (i + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) % Math.max(1, filtered.length)); }
    if (e.key === "Home" && open) { e.preventDefault(); setActive(0); }
    if (e.key === "End" && open) { e.preventDefault(); setActive(filtered.length - 1); }
    if ((e.key === "Enter" || e.key === " ") && open && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); if (filtered[active]) choose(filtered[active]); }
  };
  return <div className={`select-field ${compact ? "select-field-compact" : ""} ${className} ${disabled ? "select-disabled" : ""}`} ref={container} onKeyDown={keyboard}>
    <button ref={button} type="button" className="select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={id} disabled={disabled} onClick={() => { if (disabled) return; setActive(Math.max(0, filtered.findIndex(o => o.value === value))); setOpen(!open); }}>
      {icon && <span className="select-trigger-icon"><Icon name={icon} size={17} /></span>}
      <span className="select-trigger-content">{!compact && <small>{label}</small>}<strong>{selected.label}</strong></span><Icon name="down" size={15} className={`select-arrow ${open ? "rotated" : ""}`} />
    </button>
    {open && !disabled && <div ref={menu} className="select-popover" id={id} role="listbox" aria-label={label}>
      {searchable && <div className="select-search"><Icon name="search" size={15} /><input ref={searchRef} value={query} onChange={e => { setQuery(e.target.value); setActive(0); }} placeholder="جست‌وجو در گزینه‌ها..." aria-label={`جست‌وجو در ${label}`} onKeyDown={e => { if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") { e.stopPropagation(); } if (e.key === "Enter" && filtered[active]) { e.preventDefault(); choose(filtered[active]); } }} /></div>}
      <div className="select-options">
        {filtered.map((option) => {
          const idx = filtered.indexOf(option);
          return <button type="button" key={option.value} role="option" tabIndex={-1} aria-selected={value === option.value} className={`select-option ${idx === active ? "active" : ""} ${value === option.value ? "selected" : ""}`} onMouseEnter={() => setActive(idx)} onClick={() => choose(option)}><span className="select-option-main">{option.icon && <Icon name={option.icon} size={17} />}<span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span></span>{option.value === value && <Icon name="check" size={16} className="select-option-check" />}</button>;
        })}
        {!filtered.length && <div className="select-empty">گزینه‌ای پیدا نشد.</div>}
      </div>
    </div>}
  </div>;
}
