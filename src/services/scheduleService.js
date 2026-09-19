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

// L1 in-memory cache for rendered weekly PNG images (15 minutes TTL)
const imageMemoryCache = new TTLMap(15 * 60 * 1000);

// Singleflight promise map to coalesce concurrent image generations per group
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
 * (L1 Memory -> L2 Redis -> Singleflight Sharp generation)
 * @param {string} className Group name (e.g. "MO-900/26")
 * @returns {Promise<Buffer|null>} PNG image Buffer
 */
async function fetchWeeklyScheduleImage(className) {
  if (!className) return null;
  const normalized = normalizeGroupName(className);
  if (!normalized) return null;

  // 1. L1 In-Memory Cache Hit
  if (imageMemoryCache.has(normalized)) {
    return imageMemoryCache.get(normalized);
  }

  // 2. L2 Redis Cache Hit
  const redis = getRedisClient();
  const redisKey = `cache:schedule:img:${normalized}`;
  if (redis) {
    try {
      const cachedBuf = await redis.getBuffer(redisKey);
      if (cachedBuf && cachedBuf.length > 0) {
        imageMemoryCache.set(normalized, cachedBuf);
        return cachedBuf;
      }
    } catch (redisErr) {
      logger.warn('Redis image cache read failed', { error: redisErr.message, group: normalized });
    }
  }

  // 3. Singleflight: coalesce concurrent image renders for the same group
  if (imageGenerationInflight.has(normalized)) {
    return imageGenerationInflight.get(normalized);
  }

  const generationPromise = (async () => {
    try {
      const schedule = await getRawSchedule(className);
      if (!schedule || Object.keys(schedule).length === 0) return null;

      const imageBuffer = await generateScheduleImage(className, schedule);
      if (!imageBuffer) return null;

      // Save to L1 Memory
      imageMemoryCache.set(normalized, imageBuffer);

      // Async save to L2 Redis
      if (redis) {
        redis.set(redisKey, imageBuffer, 'EX', REDIS_IMAGE_TTL_SEC).catch(err => {
          logger.warn('Redis image cache write failed', { error: err.message, group: normalized });
        });
      }

      return imageBuffer;
    } finally {
      imageGenerationInflight.delete(normalized);
    }
  })();

  imageGenerationInflight.set(normalized, generationPromise);
  return generationPromise;
}

/**
 * Fetches paginated empty rooms text
 */
async function fetchEmptyRooms(className, dayIdx, periodNum, offsetDays = 0) {
  return getEmptyRoomsText(className, dayIdx, periodNum, offsetDays);
}

/**
 * Invalidates cached weekly schedule image for a group
 */
function invalidateImageCache(className) {
  if (!className) return;
  const normalized = normalizeGroupName(className);
  imageMemoryCache.delete(normalized);
  const redis = getRedisClient();
  if (redis) {
    redis.del(`cache:schedule:img:${normalized}`).catch(() => {});
  }
}

module.exports = {
  fetchTodaySchedule,
  fetchWeeklyScheduleImage,
  fetchEmptyRooms,
  warmUpCache,
  invalidateImageCache,
};