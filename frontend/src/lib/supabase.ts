/** The one Supabase client, configured from the build-time environment. */

import { createClient } from "@supabase/supabase-js";

// Trailing slashes stripped, so "https://x.supabase.co/" does not produce "//rest/...".
export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? "").replace(/\/+$/, "");
export const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";

/** False when the build was made without the two variables; the app says so on screen. */
export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

// createClient throws on an empty URL. A placeholder keeps the module importable (tests,
// a misconfigured build) and every call then fails with a message the app can show.
export const supabase = createClient(
  SUPABASE_URL || "http://supabase.invalid",
  SUPABASE_KEY || "missing-publishable-key",
  { auth: { persistSession: true, detectSessionInUrl: true } },
);
