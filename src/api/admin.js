'use strict';

const express = require('express');
const { URLSearchParams } = require('url');
const { z } = require('zod');
const { supabase } = require('../lib/supabase');
const { isAdmin, TTLMap } = require('../core/utils');
const { validateTelegramInitData } = require('../socket/auth');
const crypto = require('crypto');
const logger = require('../core/logger');

const router = express.Router();
const adminRateLimitMap = new TTLMap(60 * 1000, 5000); // 1 minute window, max 5000 tracked IPs

function adminRateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const current = (adminRateLimitMap.get(ip) || 0) + 1;
  adminRateLimitMap.set(ip, current);
  if (current > 60) {
    logger.warn('Admin API rate limit exceeded', { ip, count: current });
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }
  next();
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Admin Authentication Middleware
 * Requires either:
 * 1. Admin API key via header 'x-admin-key' or 'Authorization: Bearer <key>'
 * 2. Telegram WebApp initData with admin user ID in header 'x-telegram-init-data'
 */
function adminAuthMiddleware(req, res, next) {
  const envAdminKey = process.env.ADMIN_API_KEY || process.env.ADMIN_SECRET;
  const apiKeyHeader = req.headers['x-admin-key'] || req.headers['x-api-key'];
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  // 1. API key authentication with constant-time comparison
  if (envAdminKey && envAdminKey.trim().length > 0) {
    if ((apiKeyHeader && safeCompare(apiKeyHeader, envAdminKey)) || (bearerToken && safeCompare(bearerToken, envAdminKey))) {
      return next();
    }
  }

  // 2. Telegram WebApp initData authentication
  const initData = req.headers['x-telegram-init-data'] || req.query.initData;
  if (initData && validateTelegramInitData(initData)) {
    try {
      const urlParams = new URLSearchParams(initData);
      const userStr = urlParams.get('user');
      if (userStr) {
        const user = JSON.parse(decodeURIComponent(userStr));
        if (user && isAdmin(user.id)) {
          req.adminUser = user;
          return next();
        }
      }
    } catch (err) {
      logger.warn('adminAuthMiddleware: Telegram user parse error', { error: err.message });
    }
  }

  return res.status(401).json({
    error: 'Unauthorized: Admin authentication required via valid API key or Telegram initData',
  });
}

// Protect all /api/admin routes
router.use(adminRateLimiter);
router.use(adminAuthMiddleware);

const UploadPayloadSchema = z.object({
  mode: z.enum(['brain-ring', 'zakovat', 'kahoot', 'erudit']),
  data: z.array(z.record(z.any())).min(1, "Kamida 1 ta savol/blok bo'lishi kerak").max(500, 'Maksimal 500 ta element qabul qilinadi'),
});

router.post('/upload-questions', async (req, res) => {
  if (!supabase) {
    return res.status(503).json({ error: 'Supabase client not initialized or unavailable' });
  }

  const parsed = UploadPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Validatsiya xatosi',
      details: parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`),
    });
  }

  const { mode, data } = parsed.data;

  try {
    let result;
    switch (mode) {
      case 'brain-ring':
        result = await supabase.from('brain_ring_questions').insert(data);
        break;

      case 'zakovat':
        result = await supabase.from('zakovat_questions').insert(data);
        break;

      case 'kahoot': {
        const kahootRows = data.map(item => ({
          topic: item.topic || 'Umumiy',
          questions: item.questions || [],
        }));
        result = await supabase.from('kahoot_questions').insert(kahootRows);
        break;
      }

      case 'erudit': {
        const eruditRows = data.map(item => ({
          topic: item.topic || 'Umumiy',
          questions: item.questions || [],
        }));
        result = await supabase.from('erudit_questions').insert(eruditRows);
        break;
      }

      default:
        return res.status(400).json({ error: 'Noto\'g\'ri rejim (Invalid mode)' });
    }

    if (result && result.error) throw result.error;
    res.json({ success: true, count: data.length });
  } catch (err) {
    logger.error('Upload Questions API Error:', { error: err.message, mode });
    res.status(500).json({ error: 'Savollarni yuklashda xatolik yuz berdi' });
  }
});

module.exports = router;
