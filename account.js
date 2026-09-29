// Sign in with GitHub through Supabase, and keep each user's Bridge settings
// in Supabase so they follow them to every device. Without a key below,
// Bridge falls back to a GitHub access token kept in the browser.
//
// The publishable key is meant to be public: row-level security in
// supabase/schema.sql lets each user read and write only their own row.

export const SUPABASE_URL = "https://azlmlldumsuejdkduxoy.supabase.co";
export const SUPABASE_KEY = "sb_publishable_7QttQqgZQZ6lSA6ZDsTcTA_vkt7JehV";

// repo: read and write the site repos. workflow: install the sync workflow.
const SCOPES = "repo workflow read:user";
const TABLE = "bridge_settings";

let client = null;
export const enabled = () => Boolean(SUPABASE_URL && SUPABASE_KEY);

async function supabase() {
  if (!client) {
    const { createClient } = await import("./vendor/supabase.js");
    client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true } });
  }
  return client;
}

/** Leaves for GitHub; comes back to this page signed in. */
export async function signInWithGitHub() {
  const sb = await supabase();
  const { error } = await sb.auth.signInWithOAuth({
    provider: "github",
    options: { scopes: SCOPES, redirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
}

/**
 * After the redirect back from GitHub: the Supabase session and the GitHub
 * token it carries. GitHub only hands the token over at sign-in, so the
 * caller keeps it; later page loads return the session with no token.
 */
export async function currentSession() {
  if (!enabled()) return null;
  const sb = await supabase();
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  if (data.session && /[?&]code=/.test(location.search)) history.replaceState(null, "", location.pathname + location.hash);
  return data.session;
}

export async function signOut() {
  if (!enabled() || !client) return;
  await client.auth.signOut().catch(() => {});
}

/** This user's saved settings, or {} when there are none yet. */
export async function loadSettings(userId) {
  const sb = await supabase();
  const { data, error } = await sb.from(TABLE).select("data").eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data?.data || {};
}

export async function saveSettings(userId, data) {
  const sb = await supabase();
  const { error } = await sb.from(TABLE).upsert({ user_id: userId, data, updated_at: new Date().toISOString() });
  if (error) throw error;
}
