import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaNextJsPostgresqlDb?: NodePgDatabase;
};

function getPool() {
  if (globalForDb.__arenaNextJsPostgresqlPool) return globalForDb.__arenaNextJsPostgresqlPool;
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    // next build imports route modules without Preview env; throw only when a request actually needs the DB.
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({
    connectionString: databaseUrl,
    // Serverless functions each hold their own pool; keep it small and use a pooled (pgbouncer) URL such as Neon's "-pooler" host.
    max: process.env.VERCEL ? 3 : 10,
    idleTimeoutMillis: process.env.VERCEL ? 5000 : 30000,
  });
  globalForDb.__arenaNextJsPostgresqlPool = pool;
  return pool;
}

function getDb() {
  if (globalForDb.__arenaNextJsPostgresqlDb) return globalForDb.__arenaNextJsPostgresqlDb;
  const db = drizzle(getPool());
  globalForDb.__arenaNextJsPostgresqlDb = db;
  return db;
}

/** Lazy so `next build` can collect route data without Preview DATABASE_URL. */
export const pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const value = Reflect.get(getPool(), prop, receiver);
    return typeof value === "function" ? value.bind(getPool()) : value;
  },
});

export const db = new Proxy({} as NodePgDatabase, {
  get(_target, prop, receiver) {
    const value = Reflect.get(getDb(), prop, receiver);
    return typeof value === "function" ? value.bind(getDb()) : value;
  },
});
