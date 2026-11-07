'use strict';

const express = require('express');
const { URLSearchParams } = require('url');
const { z } = require('zod');
const { isPostgresAvailable, query: pgQuery, withTransaction } = require('../lib/postgres');
const { isAdmin, TTLMap } = require('../core/utils');
const { validateTelegramInitData } = require('../socket/auth');
const crypto = require('crypto');
const logger = require('../core/logger');
const dbService = require('../services/dbService');

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

const BrainRingItemSchema = z.object({
  question: z.string().min(1, 'Savol matni bo\'sh bo\'lishi mumkin emas').max(2000),
  answer: z.string().min(1, 'Javob bo\'sh bo\'lishi mumkin emas').max(500),
  comment: z.string().max(1000).optional(),
});

const ZakovatItemSchema = z.object({
  question: z.string().min(1, 'Savol matni bo\'sh bo\'lishi mumkin emas').max(2000),
  answer: z.string().min(1, 'Javob bo\'sh bo\'lishi mumkin emas').max(500),
  author: z.string().max(200).optional(),
  comment: z.string().max(1000).optional(),
});

const SingleKahootQuestionSchema = z.object({
  question: z.string().min(1, 'Savol matni bo\'sh bo\'lishi mumkin emas').max(2000),
  options: z.array(z.string().min(1).max(500)).min(2, 'Kamida 2 ta variant bo\'lishi kerak').max(10),
  correct_index: z.number().int().min(0),
  time_limit: z.number().int().min(5).max(120).optional(),
  explanation: z.string().max(1000).optional(),
}).refine(d => d.correct_index < d.options.length, {
  message: 'correct_index variantlar sonidan kichik bo\'lishi shart',
  path: ['correct_index'],
});

const KahootItemSchema = z.union([
  z.object({
    topic: z.string().max(200).optional(),
    questions: z.array(SingleKahootQuestionSchema).min(1).max(100),
  }),
  SingleKahootQuestionSchema,
]);

const EruditItemSchema = z.union([
  z.object({
    topic: z.string().max(200).optional(),
    questions: z.array(z.record(z.any())).min(1).max(100),
  }),
  z.object({
    question: z.string().min(1).max(2000),
    answer: z.string().min(1).max(500),
    topic: z.string().max(200).optional(),
  }),
]);

const UploadPayloadSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('brain-ring'),
    data: z.array(BrainRingItemSchema).min(1, 'Kamida 1 ta savol bo\'lishi kerak').max(500),
  }),
  z.object({
    mode: z.literal('zakovat'),
    data: z.array(ZakovatItemSchema).min(1, 'Kamida 1 ta savol bo\'lishi kerak').max(500),
  }),
  z.object({
    mode: z.literal('kahoot'),
    data: z.array(KahootItemSchema).min(1, 'Kamida 1 ta savol/blok bo\'lishi kerak').max(500),
  }),
  z.object({
    mode: z.literal('erudit'),
    data: z.array(EruditItemSchema).min(1, 'Kamida 1 ta savol/blok bo\'lishi kerak').max(500),
  }),
]);

router.post('/upload-questions', async (req, res) => {
  if (!isPostgresAvailable()) {
    return res.status(503).json({ error: 'Database unavailable' });
  }

  const parsed = UploadPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Validatsiya xatosi',
      details: (parsed.error.issues || parsed.error.errors || []).map(e => `${e.path.join('.')}: ${e.message}`),
    });
  }

  const { mode, data } = parsed.data;

  try {
    switch (mode) {
      case 'brain-ring': {
        await withTransaction(async (client) => {
          for (const item of data) {
            await client.query(
              'INSERT INTO brain_ring_questions (question, options, answer, points, time_limit) VALUES ($1, $2, $3, $4, $5)',
              [item.question, JSON.stringify(item.options || []), item.answer, item.points || 1, item.time_limit || 60]
            );
          }
        });
        break;
      }

      case 'zakovat': {
        await withTransaction(async (client) => {
          for (const item of data) {
            await client.query(
              'INSERT INTO zakovat_questions (question, answer, explanation, points, time_limit) VALUES ($1, $2, $3, $4, $5)',
              [item.question, item.answer, item.explanation || null, item.points || 1, item.time_limit || 60]
            );
          }
        });
        break;
      }

      case 'kahoot': {
        await withTransaction(async (client) => {
          for (const item of data) {
            const topic = item.topic || 'Umumiy';
            const questions = item.questions || [item];
            await client.query(
              'INSERT INTO kahoot_questions (title, questions) VALUES ($1, $2)',
              [topic, JSON.stringify(questions)]
            );
          }
        });
        break;
      }

      case 'erudit': {
        await withTransaction(async (client) => {
          for (const item of data) {
            await client.query(
              'INSERT INTO erudit_questions (question, answer, points) VALUES ($1, $2, $3)',
              [item.question, item.answer, item.points || 1]
            );
          }
        });
        break;
      }

      default:
        return res.status(400).json({ error: 'Noto\'g\'ri rejim (Invalid mode)' });
    }

    res.json({ success: true, count: data.length });
  } catch (err) {
    logger.error('Upload Questions API Error:', { error: err.message, mode });
    res.status(500).json({ error: 'Savollarni yuklashda xatolik yuz berdi' });
  }
});

/**
 * Paginated User Retrieval without 1000 row limit
 */
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));

    if (req.query.all === 'true') {
      const allUsers = await dbService.getAllUsers();
      return res.json({ success: true, count: allUsers.length, users: allUsers });
    }

    const { users, total } = await dbService.getUsersPaginated(page, limit);
    return res.json({
      success: true,
      total,
      page,
      limit,
      users: users || [],
    });
  } catch (err) {
    logger.error('Admin API get users error:', { error: err.message });
    res.status(500).json({ error: 'Foydalanuvchilarni yuklashda xatolik' });
  }
});

/**
 * Bug 46 Fix: Official Tests Retrieval across all records
 */
router.get('/official-tests', async (req, res) => {
  try {
    const tests = await dbService.loadAllOfficialTests();
    res.json({ success: true, tests });
  } catch (err) {
    logger.error('Admin API get tests error:', { error: err.message });
    res.status(500).json({ error: 'Rasmiy testlarni yuklashda xatolik' });
  }
});


/**
 * Ingest fresh timetable JSON directly via Admin API
 */
router.post('/timetable/upload', express.json({ limit: '30mb' }), async (req, res) => {
  try {
    const payload = req.body;
    if (!payload) {
      return res.status(400).json({ error: 'Missing timetable payload in request body' });
    }
    const edupageService = require('../services/edupageService');
    const scheduleWatcher = require('../services/scheduleWatcherService');

    const result = await edupageService.manuallyIngestTimetable(payload, 'admin_api');

    // Trigger schedule watcher in background
    scheduleWatcher.checkScheduleChanges(true).catch(err => {
      logger.error('Background schedule watcher error after admin API upload:', { error: err.message });
    });

    return res.status(200).json({
      success: true,
      message: 'Timetable successfully uploaded, parsed, and indexed',
      data: result,
    });
  } catch (err) {
    logger.error('Failed to upload timetable via admin API', { error: err.message });
    return res.status(400).json({ error: err.message });
  }
});

/**
 * Diagnostic status of EduPage subsystem
 */
router.get('/timetable/status', (req, res) => {
  const edupageService = require('../services/edupageService');
  const status = edupageService.getEduPageDiagnosticStatus();
  return res.status(200).json(status);
});

/**
 * Live test of EduPage transports (direct, proxy, mirror)
 */
router.post('/timetable/test', async (req, res) => {
  const edupageService = require('../services/edupageService');
  const results = await edupageService.testTransports();
  return res.status(200).json(results);
});

module.exports = router;
