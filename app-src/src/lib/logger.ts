/**
 * Minimal structured logger. One JSON object per line so Vercel / any log drain can index it.
 * Never pass request bodies, prompts, receipts, API keys or tokens: keys matching SECRET_KEY are
 * redacted as a second line of defence.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|encryption|receipt|content|prompt)/i;
const threshold = () => ORDER[(process.env.LOG_LEVEL as Level) in ORDER ? (process.env.LOG_LEVEL as Level) : process.env.NODE_ENV === "production" ? "info" : "debug"];

function serialize(value: unknown, depth = 0): unknown {
  if (value instanceof Error) {
    const code = (value as { code?: unknown }).code ?? (value as { cause?: { code?: unknown } }).cause?.code;
    return { name: value.name, message: value.message, ...(code ? { code } : {}), ...(process.env.NODE_ENV !== "production" || depth === 0 ? { stack: value.stack?.split("\n").slice(0, 8).join("\n") } : {}) };
  }
  if (depth > 3 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => serialize(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : serialize(v, depth + 1)]));
}

function write(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < threshold()) return;
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...(serialize(fields) as object) });
  if (level === "error") console.error(line); else if (level === "warn") console.warn(line); else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};
