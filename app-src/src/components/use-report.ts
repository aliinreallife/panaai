"use client";
import { useEffect, useState } from "react";
import { api, useApp } from "@/components/ui";
import type { UsageReport } from "@/lib/shared";
export type ClientReportOptions = { days?: number; page?: number; pageSize?: number; model?: string; key?: string; status?: string; search?: string };
export function useUsageReport(options: ClientReportOptions) {
  const { data } = useApp();
  const query = new URLSearchParams(Object.entries(options).filter(([,v]) => v !== undefined && v !== "all" && v !== "").map(([k,v]) => [k,String(v)])).toString();
  const [state, setState] = useState<{ query: string; report: UsageReport }>({ query: "", report: data.analytics });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    api<UsageReport>(`analytics?${query}`, { signal: controller.signal }).then(report => { setState({ query, report }); setLoading(false); }).catch(e => { if (e.name !== "AbortError") { setError(e.message); setLoading(false); } });
    return () => controller.abort();
  }, [query, data.updatedAt, revision]);
  return { report: state.report, loading: loading || state.query !== query, error, query, retry: () => setRevision(r => r + 1) };
}
export function useDebounced<T>(value: T, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return debounced;
}
export async function downloadUsage(query: string) {
  const response = await fetch(`/api/v1/analytics/export?${query}`, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) { const error = await response.json(); throw new Error(error.message || "دریافت گزارش انجام نشد."); }
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "usage.csv"; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
