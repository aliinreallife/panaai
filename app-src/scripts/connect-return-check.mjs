/**
 * Guards the Panacode loopback return path:
 * - production CSP must not set upgrade-insecure-requests (would rewrite http://127.0.0.1 → https)
 * - docker-compose ships a local Postgres service named `db`
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(join(root, "next.config.ts"), "utf8");
const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");

const failures = [];

// Strip block + line comments before checking for an active CSP directive.
const activeConfig = config.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
if (/upgrade-insecure-requests/.test(activeConfig)) {
  failures.push("next.config.ts must not enable upgrade-insecure-requests (breaks Panacode http://127.0.0.1 callback)");
}
if (!/^\s*db:\s*$/m.test(compose) || !/image:\s*postgres:16/.test(compose)) {
  failures.push("docker-compose.yml must define a local postgres:16 service named db");
}
if (!/127\.0\.0\.1:5432:5432/.test(compose)) {
  failures.push("docker-compose.yml must bind Postgres to 127.0.0.1 only");
}

if (failures.length) {
  console.error("connect-return-check failed:\n - " + failures.join("\n - "));
  process.exit(1);
}
console.log("connect-return-check ok");
