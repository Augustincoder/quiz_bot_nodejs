'use strict';

/**
 * Unified AI Rate Limiter & Quota Service
 *
 * Provides centralized multi-tier rate limiting for all AI features:
 * - Redis-backed persistence across dynos / restarts (keys: ai:quota:daily:<userId>, ai:quota:hourly:<userId>)
 * - Bounded L1 TTLMap fallback for zero-downtime offline execution
 * - Admin limits with per-request cooldown protection
 */

const redis = require('./redisService');
const { TTLMap } = require('../core/utils');
const logger = require('../core/logger');

const USER_LIMITS = {
  FREE_USER_DAILY: 10,
  FREE_USER_HOURLY: 5,
  PREMIUM_USER_DAILY: 50,
  ADMIN_UNLIMITED: true,
};

const ADMIN_AI_LIMITS = {
  HOURLY_LIMIT: 250,
  DAILY_LIMIT: 1000,
  COOLDOWN_SECONDS: 5,
};

// Bounded local L1 fallback caches
const localUserLimits = new TTLMap(24 * 60 * 60 * 1000, 2000);
const localAdminLimits = new TTLMap(24 * 60 * 60 * 1000, 500);

/**
 * Checks if a standard user has available AI quota.
 *
 * @param {number|string} userId
 * @param {boolean} [isPremium=false]
 * @param {boolean} [isAdmin=false]
 * @returns {Promise<{allowed: boolean, reason?: string, remaining?: number, minutesLeft?: number, hoursLeft?: number}>}
 */
async function checkUserLimit(userId, isPremium = false, isAdmin = false) {
  if (isAdmin && USER_LIMITS.ADMIN_UNLIMITED) {
    return { allowed: true, remaining: 9999 };
  }

  const dailyMax = isPremium ? USER_LIMITS.PREMIUM_USER_DAILY : USER_LIMITS.FREE_USER_DAILY;
  const hourlyMax = USER_LIMITS.FREE_USER_HOURLY;
  const now = Date.now();

  // Try Redis first
  try {
    if (redis && typeof redis.get === 'function') {
      const dailyKey = `ai:quota:daily:${userId}`;
      const hourlyKey = `ai:quota:hourly:${userId}`;

      const [dailyVal, hourlyVal] = await Promise.all([
        redis.get(dailyKey),
        redis.get(hourlyKey),
      ]);

      const dailyCount = parseInt(dailyVal || '0', 10);
      const hourlyCount = parseInt(hourlyVal || '0', 10);

      if (hourlyCount >= hourlyMax) {
        let ttlSeconds = 3600;
        try {
          if (typeof redis.ttl === 'function') {
            const ttl = await redis.ttl(hourlyKey);
            if (ttl > 0) ttlSeconds = ttl;
          }
        } catch {}
        return {
          allowed: false,
          reason: 'hourly_limit',
          minutesLeft: Math.ceil(ttlSeconds / 60) || 1,
          remaining: 0,
        };
      }

      if (dailyCount >= dailyMax) {
        let ttlSeconds = 86400;
        try {
          if (typeof redis.ttl === 'function') {
            const ttl = await redis.ttl(dailyKey);
            if (ttl > 0) ttlSeconds = ttl;
          }
        } catch {}
        return {
          allowed: false,
          reason: 'daily_user_limit',
          hoursLeft: Math.ceil(ttlSeconds / 3600) || 1,
          remaining: 0,
        };
      }

      return {
        allowed: true,
        remaining: Math.max(0, dailyMax - dailyCount),
      };
    }
  } catch (err) {
    logger.debug('aiRateLimiter: Redis error, falling back to L1 TTLMap', { error: err.message });
  }

  // Fallback to local memory L1
  let userLimit = localUserLimits.get(userId);
  if (!userLimit) {
    return { allowed: true, remaining: dailyMax };
  }

  if (now > userLimit.hourlyResetTime) {
    userLimit.hourlyCount = 0;
    userLimit.hourlyResetTime = now + 60 * 60 * 1000;
  }
  if (now > userLimit.dailyResetTime) {
    userLimit.dailyCount = 0;
    userLimit.dailyResetTime = now + 24 * 60 * 60 * 1000;
  }

  if (userLimit.hourlyCount >= hourlyMax) {
    const minutesLeft = Math.ceil((userLimit.hourlyResetTime - now) / 60000);
    return { allowed: false, reason: 'hourly_limit', minutesLeft, remaining: 0 };
  }

  if (userLimit.dailyCount >= dailyMax) {
    const hoursLeft = Math.ceil((userLimit.dailyResetTime - now) / 3600000);
    return { allowed: false, reason: 'daily_user_limit', hoursLeft, remaining: 0 };
  }

  return {
    allowed: true,
    remaining: Math.max(0, dailyMax - userLimit.dailyCount),
  };
}

/**
 * Records a successful AI call by a user.
 *
 * @param {number|string} userId
 */
async function recordUserUsage(userId) {
  const now = Date.now();

  // Update local L1 cache
  let userLimit = localUserLimits.get(userId);
  if (!userLimit) {
    userLimit = {
      dailyCount: 0,
      hourlyCount: 0,
      dailyResetTime: now + 24 * 60 * 60 * 1000,
      hourlyResetTime: now + 60 * 60 * 1000,
    };
  }
  userLimit.dailyCount++;
  userLimit.hourlyCount++;
  localUserLimits.set(userId, userLimit);

  // Update Redis
  try {
    if (redis && typeof redis.incr === 'function') {
      const dailyKey = `ai:quota:daily:${userId}`;
      const hourlyKey = `ai:quota:hourly:${userId}`;

      const [dCount, hCount] = await Promise.all([
        redis.incr(dailyKey),
        redis.incr(hourlyKey),
      ]);

      if (dCount === 1) await redis.expire(dailyKey, 24 * 3600);
      if (hCount === 1) await redis.expire(hourlyKey, 3600);
    }
  } catch (err) {
    logger.debug('aiRateLimiter: failed to record Redis usage', { error: err.message });
  }
}

/**
 * Checks admin rate limit and cooldown.
 *
 * @param {number|string} adminId
 * @returns {Promise<{allowed: boolean, reason?: string, remaining?: number, waitTime?: number, minutesLeft?: number, hoursLeft?: number, message?: string}>}
 */
async function checkAdminAILimit(adminId) {
  const now = Date.now();
  const limitState = localAdminLimits.get(adminId) || {
    hourlyCount: 0,
    dailyCount: 0,
    lastRequestTime: 0,
    hourlyResetTime: now + 60 * 60 * 1000,
    dailyResetTime: now + 24 * 60 * 60 * 1000,
  };

  if (now > limitState.hourlyResetTime) {
    limitState.hourlyCount = 0;
    limitState.hourlyResetTime = now + 60 * 60 * 1000;
  }
  if (now > limitState.dailyResetTime) {
    limitState.dailyCount = 0;
    limitState.dailyResetTime = now + 24 * 60 * 60 * 1000;
  }

  // Cooldown check
  const timeSinceLast = (now - limitState.lastRequestTime) / 1000;
  if (timeSinceLast < ADMIN_AI_LIMITS.COOLDOWN_SECONDS) {
    const waitTime = Math.ceil(ADMIN_AI_LIMITS.COOLDOWN_SECONDS - timeSinceLast);
    return {
      allowed: false,
      reason: 'cooldown',
      waitTime,
      message: `⏳ Iltimos, ${waitTime} soniya kuting (so'rovlar oralig'i).`,
    };
  }

  // Hourly limit check
  if (limitState.hourlyCount >= ADMIN_AI_LIMITS.HOURLY_LIMIT) {
    const minutesLeft = Math.ceil((limitState.hourlyResetTime - now) / 60000);
    return {
      allowed: false,
      reason: 'hourly_limit',
      minutesLeft,
      message: `⚠️ Soatlik limit tugadi (${ADMIN_AI_LIMITS.HOURLY_LIMIT} ta). ${minutesLeft} daqiqadan keyin qayta urinib ko'ring.`,
    };
  }

  // Daily limit check
  if (limitState.dailyCount >= ADMIN_AI_LIMITS.DAILY_LIMIT) {
    const hoursLeft = Math.ceil((limitState.dailyResetTime - now) / 3600000);
    return {
      allowed: false,
      reason: 'daily_limit',
      hoursLeft,
      message: `⚠️ Kunlik limit tugadi (${ADMIN_AI_LIMITS.DAILY_LIMIT} ta). Ertaga qayta urinib ko'ring.`,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(0, ADMIN_AI_LIMITS.DAILY_LIMIT - limitState.dailyCount),
  };
}

/**
 * Records admin AI usage after request execution.
 *
 * @param {number|string} adminId
 */
function recordAdminAIUsage(adminId) {
  const now = Date.now();
  let limitState = localAdminLimits.get(adminId);
  if (!limitState) {
    limitState = {
      hourlyCount: 0,
      dailyCount: 0,
      lastRequestTime: now,
      hourlyResetTime: now + 60 * 60 * 1000,
      dailyResetTime: now + 24 * 60 * 60 * 1000,
    };
  }
  limitState.hourlyCount++;
  limitState.dailyCount++;
  limitState.lastRequestTime = now;
  localAdminLimits.set(adminId, limitState);
}

/**
 * Returns admin AI quota statistics.
 *
 * @param {number|string} adminId
 */
function getAdminAIStats(adminId) {
  const now = Date.now();
  const limitState = localAdminLimits.get(adminId) || {
    hourlyCount: 0,
    dailyCount: 0,
    lastRequestTime: 0,
    hourlyResetTime: now + 60 * 60 * 1000,
    dailyResetTime: now + 24 * 60 * 60 * 1000,
  };

  return {
    hourly: {
      used: limitState.hourlyCount,
      limit: ADMIN_AI_LIMITS.HOURLY_LIMIT,
      remaining: Math.max(0, ADMIN_AI_LIMITS.HOURLY_LIMIT - limitState.hourlyCount),
    },
    daily: {
      used: limitState.dailyCount,
      limit: ADMIN_AI_LIMITS.DAILY_LIMIT,
      remaining: Math.max(0, ADMIN_AI_LIMITS.DAILY_LIMIT - limitState.dailyCount),
    },
  };
}

module.exports = {
  USER_LIMITS,
  ADMIN_AI_LIMITS,
  checkUserLimit,
  recordUserUsage,
  checkAdminAILimit,
  recordAdminAIUsage,
  getAdminAIStats,
  localUserLimits,
  localAdminLimits,
};
