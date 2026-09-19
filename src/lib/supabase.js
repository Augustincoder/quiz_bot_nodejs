'use strict';

const { createClient } = require('@supabase/supabase-js');
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase URL yoki Key topilmadi. Supabase xizmatlari faolsizlantirildi.");
} else {
  try {
    supabase = createClient(supabaseUrl, supabaseKey);
  } catch (err) {
    console.error("❌ Supabase initialization error:", err.message);
  }
}

module.exports = { supabase };
