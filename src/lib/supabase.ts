import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;

if (!url) {
  throw new Error("SUPABASE_URL is not set");
}

/**
 * Admin client (service role) — server-side only. Bypasses RLS.
 * Used by the ingestion scripts to bulk-insert documents.
 */
export function getAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set (needed for ingestion). Copy it from Supabase Dashboard > Project Settings > API."
    );
  }
  return createClient(url!, serviceKey, {
    auth: { persistSession: false },
  });
}

/**
 * Read client (anon key) — used by the API route to call the
 * SECURITY DEFINER match function. No write access.
 */
export function getReadClient() {
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!anon) {
    throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set");
  }
  return createClient(url!, anon, { auth: { persistSession: false } });
}
