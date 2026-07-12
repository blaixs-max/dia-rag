/**
 * Loads environment for standalone scripts.
 * Next.js loads .env.local automatically, but tsx scripts do not — dotenv's
 * default only reads ".env". Load .env.local first, then .env as fallback
 * (dotenv does not override already-set vars).
 *
 * IMPORTANT: import this FIRST, before any module that reads process.env
 * at load time (e.g. src/lib/embeddings.ts).
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";

if (existsSync(".env.local")) config({ path: ".env.local" });
config();
