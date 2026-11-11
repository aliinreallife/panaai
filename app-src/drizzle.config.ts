import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Uses DATABASE_URL (from .env or the shell). For Neon, use the DIRECT (non-pooler) URL for schema pushes.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  dbCredentials: { url: process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/app_db" },
});
