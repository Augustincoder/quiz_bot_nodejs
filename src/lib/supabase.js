'use strict';

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { CircuitBreaker } = require('../core/circuitBreaker');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY;

let supabase = null;

const supabaseBreaker = new CircuitBreaker({
  name: 'supabase',
  failureThreshold: 4,
  resetTimeoutMs: 30000, // 30s cooldown before probing recovery
});

function isSupabaseAvailable() {
  if (!supabase) return false;
  return supabaseBreaker.canAttempt();
}

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
    const SUPABASE_TIMEOUT_MS = parseInt(process.env.SUPABASE_TIMEOUT_MS, 10) || 8000;
    const MAX_RETRIES = 2; // Up to 2 retries (3 attempts total) on transient network/timeout glitches

    const resilientFetch = async (url, options = {}) => {
      if (!supabaseBreaker.canAttempt()) {
        throw new Error('CircuitBreaker:supabase is OPEN (database temporarily unavailable)');
      }

      let attempt = 0;
      let lastError = null;

      while (attempt <= MAX_RETRIES) {
        attempt++;
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort(new Error('TimeoutError: The operation was aborted due to timeout'));
        }, SUPABASE_TIMEOUT_MS);

        let abortListener = null;
        if (options.signal) {
          if (options.signal.aborted) {
            clearTimeout(timer);
            throw options.signal.reason || new Error('Aborted');
          }
          abortListener = () => {
            clearTimeout(timer);
            controller.abort(options.signal.reason);
          };
          options.signal.addEventListener('abort', abortListener, { once: true });
        }

        try {
          const res = await fetch(url, {
            ...options,
            signal: controller.signal,
          });

          clearTimeout(timer);
          if (abortListener && options.signal) {
            options.signal.removeEventListener('abort', abortListener);
          }

          // Transient gateway/proxy errors from Supabase/Cloudflare
          if (res.status >= 502 && res.status <= 524) {
            const errorText = await res.text().catch(() => '');
            const serverErr = new Error(`Supabase HTTP ${res.status}: ${errorText.slice(0, 150)}`);
            serverErr.status = res.status;
            lastError = serverErr;

            if (attempt <= MAX_RETRIES) {
              const backoff = attempt * 350 + Math.floor(Math.random() * 150);
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            } else {
              supabaseBreaker.recordFailure(serverErr);
              throw serverErr;
            }
          }

          // Valid HTTP response (2xx, 3xx, 4xx) indicates DB connectivity
          supabaseBreaker.recordSuccess();
          return res;
        } catch (err) {
          clearTimeout(timer);
          if (abortListener && options.signal) {
            options.signal.removeEventListener('abort', abortListener);
          }

          lastError = err;
          const errMsg = String(err?.message || '');
          const isTransient =
            errMsg.includes('timeout') ||
            errMsg.includes('Timeout') ||
            errMsg.includes('aborted') ||
            errMsg.includes('ECONNRESET') ||
            errMsg.includes('ETIMEDOUT') ||
            errMsg.includes('ECONNREFUSED') ||
            errMsg.includes('EAI_AGAIN') ||
            errMsg.includes('fetch failed');

          if (isTransient && attempt <= MAX_RETRIES) {
            const backoff = attempt * 350 + Math.floor(Math.random() * 150);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }

          supabaseBreaker.recordFailure(err);
          throw err;
        }
      }

      supabaseBreaker.recordFailure(lastError);
      throw lastError;
    };

    supabase = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
      global: {
        fetch: resilientFetch,
      },
    });
  } catch (err) {
    console.error("❌ Supabase initialization error:", err.message);
  }
}

module.exports = {
  supabase,
  supabaseBreaker,
  isSupabaseAvailable,
};
