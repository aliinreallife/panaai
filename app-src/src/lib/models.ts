import "server-only";
import { MODEL_CATALOG } from "@/lib/shared";
import { cvcBalanceConfigured, cvcLiveDispatchEnabled, fetchCvcModels, parseCvcModels, type CvcModel } from "@/lib/cvc";

export type UiModel = {
  id: string;
  name: string;
  company: string;
  color: string;
  context: string;
  description: string;
  mark: string;
  multiplier?: number | null;
  live?: boolean;
};

const COLORS = ["#287e6b", "#8bb9a7", "#d8ba87", "#cad4d5", "#6b8cae", "#c49a6c", "#7a9e7e", "#9b7bb8"];
let cache: { at: number; models: UiModel[] } | null = null;
const CACHE_MS = 60_000;

function companyFromId(id: string): { company: string; mark: string } {
  const lower = id.toLowerCase();
  if (lower.includes("gpt") || lower.includes("o1") || lower.includes("o3") || lower.startsWith("openai")) return { company: "OpenAI", mark: "openai" };
  if (lower.includes("claude") || lower.includes("anthropic") || lower.includes("sonnet") || lower.includes("opus") || lower.includes("haiku") || lower.includes("fable")) return { company: "Anthropic", mark: "claude" };
  if (lower.includes("gemini") || lower.includes("google")) return { company: "Google", mark: "gemini" };
  if (lower.includes("deepseek")) return { company: "DeepSeek", mark: "deepseek" };
  if (lower.includes("llama") || lower.includes("meta")) return { company: "Meta", mark: "openai" };
  if (lower.includes("mistral")) return { company: "Mistral", mark: "openai" };
  return { company: "panaAI", mark: "openai" };
}

function prettyName(id: string) {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

export function toUiModel(row: CvcModel, index = 0): UiModel {
  const known = MODEL_CATALOG.find(m => m.id === row.id);
  if (known) return { ...known, multiplier: row.multiplier ?? row.base_multiplier ?? null, live: true };
  const { company, mark } = companyFromId(row.id);
  return {
    id: row.id,
    name: prettyName(row.id),
    company,
    color: COLORS[index % COLORS.length],
    context: "—",
    description: "مدل فعال از فهرست زنده پانا",
    mark,
    multiplier: row.multiplier ?? row.base_multiplier ?? null,
    live: true,
  };
}

export function catalogFromSettings(settings: Record<string, unknown>): UiModel[] {
  const raw = settings["cvc:catalog"];
  if (typeof raw !== "string" || !raw) return [];
  try {
    return parseCvcModels(JSON.parse(raw)).map((m, i) => toUiModel(m, i));
  } catch {
    return [];
  }
}

/** Prefer live CVC catalog when a key is configured; fall back to sandbox demo list. */
export async function resolveModelCatalog(settings: Record<string, unknown> = {}): Promise<UiModel[]> {
  const fromSettings = catalogFromSettings(settings);
  if (!cvcBalanceConfigured()) {
    return MODEL_CATALOG.map(m => ({ ...m, live: false }));
  }
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.models.length ? cache.models : (fromSettings.length ? fromSettings : MODEL_CATALOG.map(m => ({ ...m, live: false })));
  const fetched = await fetchCvcModels();
  if (fetched.ok && fetched.data.length) {
    const models = fetched.data.map((m, i) => toUiModel(m, i));
    cache = { at: Date.now(), models };
    return models;
  }
  if (fromSettings.length) {
    cache = { at: Date.now(), models: fromSettings };
    return fromSettings;
  }
  // Live dispatch configured but catalog empty/unreachable: keep demo labels visible, mark not live.
  return MODEL_CATALOG.map(m => ({ ...m, live: false }));
}

export function modelIds(catalog: UiModel[]) {
  return catalog.map(m => m.id);
}

export function liveCatalogActive() {
  return cvcLiveDispatchEnabled() || cvcBalanceConfigured();
}
