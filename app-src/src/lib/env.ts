import { z } from "zod";

/**
 * Server environment, validated once at startup (see src/instrumentation.ts).
 * Production builds refuse to start with a broken configuration instead of failing on the first request.
 */
const hexKey = z.string().regex(/^[a-f0-9]{64}$/i, "must be 64 hex characters (openssl rand -hex 32)");
const flag = z.enum(["true", "false"]).optional();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
  DATABASE_URL_UNPOOLED: z.string().regex(/^postgres(ql)?:\/\//).optional(),
  RECEIPT_ENCRYPTION_KEY: hexKey.optional(),
  PLATFORM_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
  SANDBOX_OPERATOR_ACCESS: flag,
  NEXT_PUBLIC_BRAND_NAME: z.string().max(40).optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional(),
  TELEGRAM_BOT_TOKEN: z.string().min(20).optional(),
  RESEND_API_KEY: z.string().min(10).optional(),
  ALERT_EMAIL_FROM: z.string().min(3).optional(),
  CVC_BALANCE_URL: z.string().url().optional(),
  CVC_API_KEY: z.string().min(8).optional(),
  VERCEL: z.string().optional(),
}).superRefine((env, ctx) => {
  const production = env.NODE_ENV === "production";
  if (production && (env.VERCEL || env.PLATFORM_MODE === "live") && !env.RECEIPT_ENCRYPTION_KEY)
    ctx.addIssue({ code: "custom", path: ["RECEIPT_ENCRYPTION_KEY"], message: "is required on Vercel and in live mode" });
  if (!!env.RESEND_API_KEY !== !!env.ALERT_EMAIL_FROM)
    ctx.addIssue({ code: "custom", path: ["ALERT_EMAIL_FROM"], message: "RESEND_API_KEY and ALERT_EMAIL_FROM must be set together" });
  if (!!env.CVC_BALANCE_URL !== !!env.CVC_API_KEY)
    ctx.addIssue({ code: "custom", path: ["CVC_API_KEY"], message: "CVC_BALANCE_URL and CVC_API_KEY must be set together" });
  if (env.PLATFORM_MODE === "live" && env.SANDBOX_OPERATOR_ACCESS === "true")
    ctx.addIssue({ code: "custom", path: ["SANDBOX_OPERATOR_ACCESS"], message: "must not be enabled in live mode" });
});

export type ServerEnv = z.infer<typeof schema>;

/** Values are trimmed (dashboards often keep a pasted newline); empty strings count as "not set". */
function normalized(source: NodeJS.ProcessEnv) {
  return Object.fromEntries(Object.entries(source).flatMap(([k, v]) => v === undefined || v.trim() === "" ? [] : [[k, v.trim()]]));
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env) {
  return schema.safeParse(normalized(source));
}

export function validateEnv(source: NodeJS.ProcessEnv = process.env): ServerEnv {
  const result = parseEnv(source);
  if (!result.success) {
    const problems = result.error.issues.map(i => `  - ${i.path.join(".") || "env"}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}\nSee .env.example and docs/DEPLOY.md.`);
  }
  return result.data;
}

/** Non-fatal launch warnings: things that work but are not ready for real customers. */
export function launchWarnings(env: ServerEnv) {
  const warnings: string[] = [];
  if (env.PLATFORM_MODE === "sandbox" && env.NODE_ENV === "production") warnings.push("PLATFORM_MODE=sandbox: anonymous sandbox workspaces with sample data are served. Use PLATFORM_MODE=live for the real launch.");
  if (env.SANDBOX_OPERATOR_ACCESS === "true") warnings.push("SANDBOX_OPERATOR_ACCESS=true: every new sandbox workspace gets the admin console. Internal previews only.");
  if (env.PLATFORM_MODE === "live" && !env.CVC_BALANCE_URL) warnings.push("Live mode without an upstream balance source: the API stays closed (service_unavailable).");
  return warnings;
}
