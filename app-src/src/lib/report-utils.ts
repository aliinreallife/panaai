import type { DailyItem } from "@/lib/shared";

export function tehranDay(value: Date | string = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}
export function shiftDay(day: string, offset: number) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
export function reportPeriod(days: number, now = new Date()) {
  const endDay = tehranDay(now);
  const startDay = shiftDay(endDay, 1 - days);
  const previousStartDay = shiftDay(startDay, -days);
  return { startDay, endDay, previousStartDay, start: new Date(`${startDay}T00:00:00+03:30`), previousStart: new Date(`${previousStartDay}T00:00:00+03:30`), end: now };
}
export function fillDaily(start: string, count: number, rows: DailyItem[]) {
  const indexed = new Map(rows.map(row => [row.day, row]));
  return Array.from({ length: count }, (_, i) => { const day = shiftDay(start, i); return indexed.get(day) || { day, credits: 0, requests: 0, errors: 0 }; });
}
export function chartBuckets(daily: DailyItem[], count = 6) {
  if (!daily.length) return [];
  const length = Math.min(count, daily.length);
  return Array.from({ length }, (_, i) => {
    const rows = daily.slice(Math.floor(i * daily.length / length), Math.floor((i + 1) * daily.length / length));
    return { day: rows.at(-1)!.day, startDay: rows[0].day, credits: rows.reduce((a, d) => a + d.credits, 0), requests: rows.reduce((a, d) => a + d.requests, 0), errors: rows.reduce((a, d) => a + d.errors, 0) };
  });
}
export const percentChange = (current: number, previous: number) => previous > 0 ? Math.round((current - previous) / previous * 1000) / 10 : null;
export function csvText(headers: string[], rows: (string | number)[][]) {
  const escape = (value: string | number) => `"${String(value).replace(/^(\s*[=+@-])/, "'$1").replaceAll('"', '""')}"`;
  return "\ufeff" + [headers, ...rows].map(row => row.map(escape).join(",")).join("\r\n");
}
