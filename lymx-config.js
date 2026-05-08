// LYMX shared client config.
// Keep this file in sync with biz-signup.html's inline config block.
//
// SUPABASE_ANON_KEY is the public "anon public" key from
// https://supabase.com/dashboard/project/apffootxzfwmtyjlnteo/settings/api-keys/legacy
// It IS safe to embed in client code — it's the public anon key, not
// the service_role key.
//
// Replace the  value below with the real anon key
// before deploying. Once replaced, every page that loads lymx-config.js +
// lymx-auth.js will be wired to Supabase.

window.LYMX_CONFIG = {
  SUPABASE_URL: 'https://apffootxzfwmtyjlnteo.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFwZmZvb3R4emZ3bXR5amxudGVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc2NjMxNjksImV4cCI6MjA5MzIzOTE2OX0.05FqSREKhwOz7zAtz70UXPuNXtPNl_YfH8WLYo79DtE'
};
