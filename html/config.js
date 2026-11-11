// Public Supabase config for the static (browser-only) version.
//
// SAFE TO COMMIT: the publishable key is designed to be exposed to browsers. It
// only grants whatever your Row Level Security (RLS) policies allow for the
// `anon` and `authenticated` roles.
//
// Use the PUBLISHABLE key (starts with sb_publishable_) from Supabase Dashboard >
// Project Settings > API Keys. Legacy JWT anon keys ("eyJ...") are disabled on
// this project and fail with "Legacy API keys are disabled".
//
// NEVER put the secret key (sb_secret_...) or legacy service_role key here —
// those bypass RLS and would give anyone full read/write access to your
// database. They stay server-side only.
window.APP_CONFIG = {
  SUPABASE_URL: 'https://nqsyzxwamtwjrhokpjof.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_4aGpzIQDV8SC15iIrkgMbA_sMjOnWvd',
};
