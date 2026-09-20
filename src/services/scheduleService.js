'use strict';

const {
  getFormattedSchedule,
  getRawSchedule,
  getEmptyRoomsText,
  warmUpCache,
  normalizeGroupName,
} = require('./edupageService');
const { generateScheduleImage } = require('./imageService');
const { TTLMap } = require('../core/utils');
const logger = require('../core/logger');

// L1 in-memory cache for rendered weekly PNG images (15 minutes TTL, max 50 items ~12.5MB)
const imageMemoryCache = new TTLMap(15 * 60 * 1000, 50);

// Singleflight promise map to coalesce concurrent image generations per group & theme
const imageGenerationInflight = new Map();

const REDIS_IMAGE_TTL_SEC = 12 * 60 * 60; // 12 hours

function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  try {
    return require('./redisService');
  } catch {
    return null;
  }
}

/**
 * Fetches today's (or a specific day's) schedule formatted in HTML
 * @param {string} className Group name (e.g. "MO-900/26")
 * @param {number|null} specificDayIdx 0=Monday .. 5=Saturday
 */
async function fetchTodaySchedule(className, specificDayIdx = null) {
  if (!className) return '⚠️ Guruh tanlanmagan.';

  let dayOfWeek;
  if (specificDayIdx !== null && specificDayIdx !== undefined) {
    dayOfWeek = specificDayIdx;
  } else {
    const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
    dayOfWeek = (date.getDay() + 6) % 7;
  }

  // Sunday (6) defaults to Monday (0)
  const targetDay = dayOfWeek < 6 ? dayOfWeek : 0;
  return getFormattedSchedule(className, targetDay);
}

/**
 * High-performance weekly schedule image generator with multi-tier caching
 * (L1 Memory -> Singleflight Coalescence -> L2 Redis -> Sharp generation)
 * @param {string} className Group name (e.g. "MO-900/26")
 * @param {string} theme Theme name: 'dark' | 'light' | 'vibrant' (defaults to 'dark')
 * @returns {Promise<Buffer|null>} PNG image Buffer
 */
async function fetchWeeklyScheduleImage(className, theme = 'dark') {
  if (!className) return null;
  const normalized = normalizeGroupName(className);
  if (!normalized) return null;

  const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
  const memKey = `${normalized}:${validTheme}`;

  // 1. L1 In-Memory Cache Hit (Instant sync return)
  if (imageMemoryCache.has(memKey)) {
    return imageMemoryCache.get(memKey);
  }

  // 2. Singleflight: if a fetch/generation is already in-flight for this key, join it!
  if (imageGenerationInflight.has(memKey)) {
    return imageGenerationInflight.get(memKey);
  }

  const generationPromise = (async () => {
    try {
      // Check L2 Redis cache inside singleflight (prevents stampeding Redis)
      const redis = getRedisClient();
      const redisKey = `cache:schedule:img:${normalized}:${validTheme}`;
      if (redis) {
        try {
          const cachedBuf = await redis.getBuffer(redisKey);
          if (cachedBuf && cachedBuf.length > 0) {
            imageMemoryCache.set(memKey, cachedBuf);
            return cachedBuf;
          }
        } catch (redisErr) {
          logger.warn('Redis image cache read failed', { error: redisErr.message, group: normalized, theme: validTheme });
        }
      }

      const schedule = await getRawSchedule(className);
      if (!schedule || Object.keys(schedule).length === 0) return null;

      const imageBuffer = await generateScheduleImage(className, schedule, validTheme);
      if (!imageBuffer) return null;

      // Save to L1 Memory
      imageMemoryCache.set(memKey, imageBuffer);

      // Async save to L2 Redis
      if (redis) {
        redis.set(redisKey, imageBuffer, 'EX', REDIS_IMAGE_TTL_SEC).catch(err => {
          logger.warn('Redis image cache write failed', { error: err.message, group: normalized, theme: validTheme });
        });
      }

      return imageBuffer;
    } finally {
      imageGenerationInflight.delete(memKey);
    }
  })();

  imageGenerationInflight.set(memKey, generationPromise);
  return generationPromise;
}

/**
 * High-performance weekly schedule photo resolver with Telegram Channel CDN & Supabase cache
 * @param {string} className Group name
 * @param {string} theme 'dark' | 'light' | 'vibrant'
 * @param {object} telegram Telegraf telegram client instance
 * @returns {Promise<{ fileId?: string, buffer?: Buffer, isHit?: boolean } | null>}
 */
async function fetchWeeklySchedulePhoto(className, theme = 'dark', telegram = null) {
  if (!className) return null;
  const normalized = normalizeGroupName(className);
  if (!normalized) return null;

  const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';

  try {
    const timetableCdnService = require('./timetableCdnService');
    const res = await timetableCdnService.getOrGenerateTimetablePhoto(telegram, className, validTheme);
    if (res) return res;
  } catch (err) {
    logger.warn('timetableCdnService lookup failed, falling back to local generator', { error: err.message });
  }

  // Fallback to local image generator
  const buffer = await fetchWeeklyScheduleImage(className, validTheme);
  return buffer ? { buffer, isHit: false } : null;
}

/**
 * Fetches paginated empty rooms text
 */
async function fetchEmptyRooms(className, dayIdx, periodNum, offsetDays = 0, binoFilter = null) {
  return getEmptyRoomsText(className, dayIdx, periodNum, offsetDays, binoFilter);
}

/**
 * Invalidates cached weekly schedule image for a group (all themes)
 */
async function invalidateImageCache(className) {
  if (!className) return;
  const normalized = normalizeGroupName(className);
  ['dark', 'light', 'vibrant'].forEach(t => imageMemoryCache.delete(`${normalized}:${t}`));
  const redis = getRedisClient();
  if (redis) {
    ['dark', 'light', 'vibrant'].forEach(t => {
      redis.del(`cache:schedule:img:${normalized}:${t}`).catch(() => {});
    });
  }
  try {
    const timetableCdnService = require('./timetableCdnService');
    await timetableCdnService.invalidateTimetable(className);
  } catch (e) {
    logger.debug('Timetable CDN cache invalidation error', { error: e.message });
  }
}

module.exports = {
  fetchTodaySchedule,
  fetchWeeklyScheduleImage,
  fetchWeeklySchedulePhoto,
  fetchEmptyRooms,
  invalidateImageCache,
  warmUpCache,
};