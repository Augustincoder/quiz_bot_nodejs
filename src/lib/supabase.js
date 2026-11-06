'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase URL yoki Key topilmadi. Supabase xizmatlari faolsizlantirildi.");
} else {
  // Check if anon key is configured instead of service_role key
  try {
    const parts = supabaseKey.split('.');
    if (parts.length === 3) {
      const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
      const payload = JSON.parse(payloadJson);
      if (payload && payload.role === 'anon') {
        console.warn("⚠️ [SECURITY WARNING] Supabase 'anon' (public) kaliti aniqlandi! RLS yoqilganda bot so'rovlari bloklanishi mumkin. Iltimos, .env faylida SUPABASE_KEY sifatida 'service_role' (secret) kalitini ishlating.");
      }
    }
  } catch {}

  try {
    const SUPABASE_TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS, 10) || 20000;
    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        fetch: (url, options = {}) => {
          const timeoutSignal = AbortSignal.timeout(SUPABASE_TIMEOUT_MS);
          const signal = options.signal
            ? (AbortSignal.any ? AbortSignal.any([options.signal, timeoutSignal]) : options.signal)
            : timeoutSignal;
          return fetch(url, { ...options, signal });
        },
      },
    });
  } catch (err) {
    console.error("❌ Supabase initialization error:", err.message);
  }
}

module.exports = { supabase };
