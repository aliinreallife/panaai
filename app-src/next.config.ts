import type { NextConfig } from "next";
const live = process.env.PLATFORM_MODE === "live";
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
      ...(live ? [{ key: "X-Frame-Options", value: "DENY" }] : []),
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: `${live ? "frame-ancestors 'none'; " : ""}object-src 'none'; base-uri 'self'` },
    ] }];
  },
};
export default nextConfig;
