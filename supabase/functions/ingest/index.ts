// Supabase Edge Function: the dashboard's upload endpoint. All logic is in handler.ts;
// this file only wires it to Deno and to Supabase with the service-role key, which the
// platform provides to every function as an environment variable.

import { createClient } from "npm:@supabase/supabase-js@2.117.3";

import { handleIngest } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey =
  Deno.env.get("SUPABASE_SECRET_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve((req) =>
  handleIngest(req, {
    async userEmail(accessToken) {
      const { data, error } = await admin.auth.getUser(accessToken);
      return error || !data.user?.email ? null : data.user.email;
    },
    async isAdmin(email) {
      const { data, error } = await admin.rpc("is_ingest_admin", { p_email: email });
      if (error) throw new Error(error.message);
      return data === true;
    },
    async rpc(name, args) {
      const { data, error } = await admin.rpc(name, args);
      if (error) throw new Error(error.message);
      return data;
    },
    maxUploadMb: Number(Deno.env.get("MAX_UPLOAD_MB") ?? "20"),
  })
);
