'use strict';

const {
  getFormattedSchedule,
  getRawSchedule,
  getEmptyRoomsText,
  warmUpCache,
  normalizeGroupName,
  getCanonicalGroupName,
  getGroupBuildings,
} = require('./edupageService');
const { generateScheduleImage } = require('./imageService');
const { TTLMap, getTashkentDayOfWeek, getTashkentDate, timeToMinutes } = require('../core/utils');
const logger = require('../core/logger');

/**
 * Period boundaries in minutes from midnight (Bug 21 fix)
 */
const PERIOD_INTERVALS = [
  { period: 1, startMins: 8 * 60, endMins: 9 * 60 + 20 },
  { period: 2, startMins: 9 * 60 + 30, endMins: 10 * 60 + 50 },
  { period: 3, startMins: 11 * 60, endMins: 12 * 60 + 20 },
  { period: 4, startMins: 13 * 60, endMins: 14 * 60 + 20 },
  { period: 5, startMins: 14 * 60 + 30, endMins: 15 * 60 + 50 },
  { period: 6, startMins: 16 * 60, endMins: 17 * 60 + 20 },
  { period: 7, startMins: 17 * 60 + 30, endMins: 18 * 60 + 50 },
  { period: 8, startMins: 19 * 60, endMins: 20 * 60 + 20 },
];

/**
 * Compares two times safely using minutes from midnight (resolves ASCII '09:10' vs '8:30' bug).
 * Returns: <0 if t1 < t2, 0 if equal, >0 if t1 > t2
 */
function compareTimes(t1, t2) {
  const m1 = typeof t1 === 'number' ? t1 : timeToMinutes(t1);
  const m2 = typeof t2 === 'number' ? t2 : timeToMinutes(t2);
  return m1 - m2;
}

/**
 * Checks if target time falls within [startTime, endTime] using minute arithmetic.
 */
function isTimeBetween(targetTime, startTime, endTime) {
  const target = typeof targetTime === 'number' ? targetTime : timeToMinutes(targetTime);
  const start = typeof startTime === 'number' ? startTime : timeToMinutes(startTime);
  const end = typeof endTime === 'number' ? endTime : timeToMinutes(endTime);
  if (target === -1 || start === -1 || end === -1) return false;
  return target >= start && target <= end;
}

// L1 in-memory cache for rendered weekly PNG images (15 minutes TTL, max 15 items ~25-30MB)
const imageMemoryCache = new TTLMap(15 * 60 * 1000, 15);

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
  const canonical = getCanonicalGroupName(className) || className;

  let dayOfWeek;
  if (specificDayIdx !== null && specificDayIdx !== undefined) {
    dayOfWeek = Number(specificDayIdx);
  } else {
    dayOfWeek = getTashkentDayOfWeek();
  }


  // Sunday (6) is a day off
  if (dayOfWeek === 6) {
    return "📅 <b>Yakshanba — dam olish kuni!</b>\n\n📭 Ushbu kunda darslar bo'lmaydi.";
  }

  return getFormattedSchedule(canonical, dayOfWeek);
}

/**
 * High-performance weekly schedule image generator with multi-tier caching
 * (L1 Memory -> Singleflight Coalescence -> L2 Redis -> Sharp generation)
 * @param {string} className Group name (e.g. "MO-900/26")
 * @param {string} theme Theme name: 'dark' | 'light' | 'vibrant' (defaults to 'dark')
 * @returns {Promise<Buffer|null>} PNG image Buffer
 */
function fetchWeeklyScheduleImage(className, theme = 'dark') {
  if (!className) return Promise.resolve(null);
  const canonical = getCanonicalGroupName(className) || className;
  const normalized = normalizeGroupName(canonical);
  if (!normalized) return Promise.resolve(null);

  const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
  const memKey = `${normalized}:${validTheme}`;

  // 1. L1 In-Memory Cache Hit (Instant sync return)
  if (imageMemoryCache.has(memKey)) {
    return Promise.resolve(imageMemoryCache.get(memKey));
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

      const schedule = await getRawSchedule(canonical);
      if (!schedule || Object.keys(schedule).length === 0) return null;

      const imageBuffer = await generateScheduleImage(canonical, schedule, validTheme);
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
  const canonical = getCanonicalGroupName(className) || className.trim();
  const normalized = normalizeGroupName(canonical);
  if (!normalized) return null;

  const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';

  try {
    const timetableCdnService = require('./timetableCdnService');
    const res = await timetableCdnService.getOrGenerateTimetablePhoto(telegram, canonical, validTheme);
    if (res) return res;
  } catch (err) {
    logger.warn('timetableCdnService lookup failed, falling back to local generator', { error: err.message });
  }

  // Fallback to local image generator
  const buffer = await fetchWeeklyScheduleImage(canonical, validTheme);
  return buffer ? { buffer, isHit: false } : null;
}

/**
 * Fetches paginated empty rooms text
 */
async function fetchEmptyRooms(className, dayIdx, periodNum, offsetDays = 0, binoFilter = null, timeMode = null) {
  const canonical = className ? (getCanonicalGroupName(className) || className) : null;
  return getEmptyRoomsText(canonical, dayIdx, periodNum, offsetDays, binoFilter, timeMode);
}

/**
 * Invalidates cached weekly schedule image for a group (all themes)
 */
async function invalidateImageCache(className) {
  if (!className) return;
  const canonical = getCanonicalGroupName(className) || className;
  const normalized = normalizeGroupName(canonical);
  ['dark', 'light', 'vibrant'].forEach(t => imageMemoryCache.delete(`${normalized}:${t}`));
  const redis = getRedisClient();
  if (redis) {
    ['dark', 'light', 'vibrant'].forEach(t => {
      redis.del(`cache:schedule:img:${normalized}:${t}`).catch(() => {});
    });
  }
  try {
    const timetableCdnService = require('./timetableCdnService');
    await timetableCdnService.invalidateTimetable(canonical);
  } catch (e) {
    logger.debug('Timetable CDN cache invalidation error', { error: e.message });
  }
}

function clearImageMemoryCache() {
  imageMemoryCache.clear();
}

module.exports = {
  fetchTodaySchedule,
  fetchWeeklyScheduleImage,
  fetchWeeklySchedulePhoto,
  fetchEmptyRooms,
  getGroupBuildings,
  invalidateImageCache,
  warmUpCache,
  clearImageMemoryCache,
  compareTimes,
  isTimeBetween,
  PERIOD_INTERVALS,
};