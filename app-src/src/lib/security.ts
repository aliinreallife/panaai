import "server-only";
import { db } from "@/db";
import * as s from "@/db/schema";
import { eq } from "drizzle-orm";
import { ApiError, decryptImage, encryptImage, getSession, isDemo } from "@/lib/server";
import { ELEVATION_MINUTES, MFA_ROUTES, ROLE_INFO, ROLE_PERMISSIONS, can, isOperator, permissionFor, type Role } from "@/lib/rules";
import { newTotpSecret, otpauthUri, totp, verifyTotp } from "@/lib/totp";

type User = typeof s.users.$inferSelect;
const encrypt = async (secret: string) => encryptImage(Buffer.from(secret, "utf8"));
const decrypt = async (value: string) => (await decryptImage(value)).toString("utf8");

export async function securityStatus(user: User) {
  const [session, [mfa]] = await Promise.all([getSession(), db.select().from(s.adminMfa).where(eq(s.adminMfa.userId, user.id)).limit(1)]);
  const elevatedUntil = session?.elevatedUntil && session.elevatedUntil > new Date() ? session.elevatedUntil : null;
  return {
    role: user.role as Role, roleLabel: ROLE_INFO[user.role as Role]?.label ?? user.role, permissions: ROLE_PERMISSIONS[user.role as Role] ?? [],
    otpVerified: !!user.phone, mfaEnrolled: !!mfa?.enabledAt, mfaPending: !!mfa && !mfa.enabledAt,
    elevatedUntil: elevatedUntil?.toISOString() ?? null, elevationMinutes: ELEVATION_MINUTES, demo: isDemo,
  };
}

/**
 * Server-side gate for every admin route.
 *  1. the route must map to a known permission (unknown routes are denied);
 *  2. the operator's role must grant it;
 *  3. every mutation additionally needs a session elevated with OTP (phone) + TOTP in the last 15 minutes.
 */
export async function authorizeAdmin(user: User, route: string, method: string) {
  // Customers get the same answer as for a route that does not exist: the admin surface is invisible to them.
  if (!isOperator(user.role)) throw new ApiError("not_found", "مسیر یافت نشد.", 404);
  if (MFA_ROUTES.has(route)) return;
  const permission = permissionFor(route, method);
  if (!permission) throw new ApiError("not_found", "عملیات مدیریتی یافت نشد.", 404);
  if (!can(user.role, permission)) throw new ApiError("forbidden_role", `نقش «${ROLE_INFO[user.role as Role]?.label ?? user.role}» اجازه این عملیات را ندارد.`, 403);
  if (method === "GET") return;
  const session = await getSession();
  if (!session?.elevatedUntil || session.elevatedUntil < new Date()) throw new ApiError("mfa_required", "برای عملیات مدیریتی، ابتدا با کد پیامکی و کد TOTP هویت خود را تأیید کنید.", 401);
}

export async function enrollMfa(user: User) {
  const [existing] = await db.select().from(s.adminMfa).where(eq(s.adminMfa.userId, user.id)).limit(1);
  if (existing?.enabledAt) throw new ApiError("mfa_already_enabled", "TOTP قبلاً فعال شده است.", 409);
  const secret = newTotpSecret();
  const encrypted = await encrypt(secret);
  await db.insert(s.adminMfa).values({ userId: user.id, secret: encrypted }).onConflictDoUpdate({ target: s.adminMfa.userId, set: { secret: encrypted, failures: 0, lastStep: null } });
  await db.insert(s.audit).values({ userId: user.id, action: "admin.mfa_enrollment_started" });
  return { secret, uri: otpauthUri(secret, user.phone || user.id.slice(0, 8)) };
}

async function checkCode(user: User, code: string) {
  return db.transaction(async tx => {
    const [mfa] = await tx.select().from(s.adminMfa).where(eq(s.adminMfa.userId, user.id)).for("update");
    if (!mfa) throw new ApiError("mfa_not_enrolled", "ابتدا TOTP را فعال کنید.", 409);
    if (mfa.failures >= 5) throw new ApiError("mfa_locked", "به دلیل تلاش‌های ناموفق، TOTP قفل شد. با مالک سیستم تماس بگیرید.", 423);
    const step = verifyTotp(await decrypt(mfa.secret), code);
    // A code may be accepted only once (replay protection across the ±30 s window).
    if (step === null || (mfa.lastStep !== null && step <= mfa.lastStep)) {
      await tx.update(s.adminMfa).set({ failures: mfa.failures + 1 }).where(eq(s.adminMfa.userId, user.id));
      return null;
    }
    await tx.update(s.adminMfa).set({ failures: 0, lastStep: step, ...(mfa.enabledAt ? {} : { enabledAt: new Date() }) }).where(eq(s.adminMfa.userId, user.id));
    return { firstEnable: !mfa.enabledAt };
  });
}

export async function confirmMfa(user: User, code: string) {
  const result = await checkCode(user, code);
  if (!result) throw new ApiError("invalid_totp", "کد TOTP نادرست، تکراری یا منقضی است.");
  await db.insert(s.audit).values({ userId: user.id, action: "admin.mfa_enabled" });
}

export async function elevate(user: User, code: string) {
  if (!user.phone) throw new ApiError("otp_required", "ابتدا شماره موبایل را با کد یک‌بارمصرف تأیید کنید (مرحله اول ورود مدیر).", 409);
  const [mfa] = await db.select().from(s.adminMfa).where(eq(s.adminMfa.userId, user.id)).limit(1);
  if (!mfa?.enabledAt) throw new ApiError("mfa_not_enrolled", "ابتدا TOTP را فعال کنید.", 409);
  const result = await checkCode(user, code);
  if (!result) {
    await db.insert(s.audit).values({ userId: user.id, action: "admin.elevation_failed" });
    throw new ApiError("invalid_totp", "کد TOTP نادرست، تکراری یا منقضی است.");
  }
  const session = await getSession();
  if (!session) throw new ApiError("unauthorized", "نشست یافت نشد.", 401);
  const until = new Date(Date.now() + ELEVATION_MINUTES * 60000);
  await db.update(s.sessions).set({ elevatedUntil: until }).where(eq(s.sessions.tokenHash, session.tokenHash));
  await db.insert(s.audit).values({ userId: user.id, action: "admin.elevated", details: { until: until.toISOString(), factors: ["otp_demo", "totp"] } });
  return until;
}

export async function dropElevation(user: User) {
  const session = await getSession();
  if (session) await db.update(s.sessions).set({ elevatedUntil: null }).where(eq(s.sessions.tokenHash, session.tokenHash));
  await db.insert(s.audit).values({ userId: user.id, action: "admin.elevation_dropped" });
}

/** Sandbox-only helper, like the displayed demo OTP: reveals the current TOTP so testers without an authenticator app can proceed. */
export async function demoTotp(user: User) {
  if (!isDemo) throw new ApiError("not_found", "یافت نشد.", 404);
  const [mfa] = await db.select().from(s.adminMfa).where(eq(s.adminMfa.userId, user.id)).limit(1);
  if (!mfa) throw new ApiError("mfa_not_enrolled", "ابتدا TOTP را فعال کنید.", 409);
  // Never hand out an already-used step; the next step is still inside the ±1 verification window.
  const time = Math.max(Date.now(), mfa.lastStep !== null ? (mfa.lastStep + 1) * 30000 : 0);
  return { code: totp(await decrypt(mfa.secret), time), expiresIn: Math.max(1, Math.ceil(((Math.floor(time / 30000) + 1) * 30000 - Date.now()) / 1000)), demo: true };
}
