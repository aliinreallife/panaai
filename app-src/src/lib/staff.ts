import "server-only";

/** Default operator mobiles (Iranian 09…). Override with ADMIN_PHONES=09…,09… */
const DEFAULT_ADMIN_PHONES = ["09203050405", "09225006434"];

export function adminPhones(): string[] {
  const raw = process.env.ADMIN_PHONES?.trim();
  const list = (raw ? raw.split(/[\s,;]+/) : DEFAULT_ADMIN_PHONES)
    .map((p) => p.replace(/\D/g, ""))
    .map((p) => (p.startsWith("98") && p.length === 12 ? `0${p.slice(2)}` : p))
    .filter((p) => /^09\d{9}$/.test(p));
  return Array.from(new Set(list.length ? list : DEFAULT_ADMIN_PHONES));
}

export function isAdminPhone(phone: string) {
  const normalized = phone.replace(/\D/g, "");
  const local = normalized.startsWith("98") && normalized.length === 12 ? `0${normalized.slice(2)}` : normalized;
  return adminPhones().includes(local);
}
