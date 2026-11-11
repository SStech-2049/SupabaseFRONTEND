import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey || serviceKey === 'paste_service_role_key_here') {
  // Thrown lazily on first query so the app still boots without a key set.
  console.warn(
    '[webinar-admin] SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local — see README.',
  );
}

// Service-role client. SERVER-SIDE ONLY. Bypasses RLS. Never import this from a client component.
export const supabaseAdmin = createClient(url ?? '', serviceKey ?? '', {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function assertConfigured() {
  if (!url) throw new Error('SUPABASE_URL missing in .env.local');
  if (!serviceKey || serviceKey === 'paste_service_role_key_here') {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY missing in .env.local. Use the secret key (sb_secret_...) from Supabase Dashboard > Project Settings > API Keys.',
    );
  }
}
