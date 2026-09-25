import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG } from './config.js';

// The session lives in sessionStorage: it ends when the tab or the installed
// app is closed, so every new opening of the system asks for a login.
try { localStorage.removeItem('cafeteria-auth'); } catch (_) { /* old persisted session */ }

export const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'cafeteria-auth', storage: window.sessionStorage },
});
