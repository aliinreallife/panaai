import type { NextConfig } from "next";

const live = process.env.PLATFORM_MODE === "live";
const dev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy. Everything (fonts, images, API) is same-origin. Next.js App Router
 * streams its payload through inline scripts, so script-src needs 'unsafe-inline' unless the app
 * moves to per-request nonces. The sandbox may be embedded by a preview host; live mode cannot be framed.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  live ? "frame-ancestors 'none'" : "",
  dev ? "" : "upgrade-insecure-requests",
].filter(Boolean).join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/(.*)", headers: [
        { key: "Content-Security-Policy", value: csp },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
        ...(live ? [{ key: "X-Frame-Options", value: "DENY" }] : []),
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
        { key: "X-DNS-Prefetch-Control", value: "off" },
      ] },
      // API responses are never cached by shared caches.
      { source: "/(api|v1)/(.*)", headers: [{ key: "Cache-Control", value: "no-store" }] },
    ];
  },
};
export default nextConfig;
