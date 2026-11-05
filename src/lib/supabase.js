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
    supabase = createClient(supabaseUrl, supabaseKey);
  } catch (err) {
    console.error("❌ Supabase initialization error:", err.message);
  }
}

module.exports = { supabase };
