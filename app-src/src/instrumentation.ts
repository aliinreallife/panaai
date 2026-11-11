import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { validateEnv, launchWarnings } = await import("@/lib/env");
  const { logger } = await import("@/lib/logger");
  const env = validateEnv();
  for (const warning of launchWarnings(env)) logger.warn("startup.warning", { warning });
  logger.info("startup", { mode: env.PLATFORM_MODE });
}

/** Every unhandled server error (render, route handler, server action) lands here as one structured line. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logger } = await import("@/lib/logger");
  logger.error("request.unhandled_error", { error, method: request.method, path: request.path.split("?")[0], routePath: context.routePath, routeType: context.routeType, digest: (error as { digest?: string }).digest });
};
