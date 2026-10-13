/** Supabase Auth for the upload panel: email sign-in links, no passwords to manage. */

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "./supabase";

/** The current session, kept up to date as people sign in and out. */
export function useSession(): { session: Session | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (alive) setSession(data.session);
      })
      .catch(() => {
        /* no session; the panel offers to sign in */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, loading };
}

/** Email a one-time sign-in link that brings the person back to this page. */
export async function sendSignInLink(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: window.location.href },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}
