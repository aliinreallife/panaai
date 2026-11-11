import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { parseEnv, launchWarnings } = await import("@/lib/env");
  const { logger } = await import("@/lib/logger");
  const result = parseEnv();
  if (!result.success) {
    const problems = result.error.issues.map(i => `${i.path.join(".") || "env"}: ${i.message}`);
    // Without a database nothing can work: fail loudly. Anything else only disables the feature that
    // needs it (e.g. receipts and API keys without RECEIPT_ENCRYPTION_KEY), so keep serving and log an error.
    if (problems.some(p => p.startsWith("DATABASE_URL:"))) throw new Error(`Invalid environment configuration:\n  - ${problems.join("\n  - ")}\nSee .env.example and docs/DEPLOY.md.`);
    for (const problem of problems) logger.error("startup.invalid_env", { problem });
    return;
  }
  for (const warning of launchWarnings(result.data)) logger.warn("startup.warning", { warning });
  logger.info("startup", { mode: result.data.PLATFORM_MODE });
}

/** Every unhandled server error (render, route handler, server action) lands here as one structured line. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("@/lib/logger");
  logger.error("request.unhandled_error", { error, method: request.method, path: request.path.split("?")[0], routePath: context.routePath, routeType: context.routeType, digest: (error as { digest?: string }).digest });
};
