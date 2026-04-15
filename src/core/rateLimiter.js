'use strict';

const redisConnection = require('../services/redisService');
const { ADMIN_ID } = require('../config/config');
const logger = require('./logger');

// Rate limits per second
const CALLBACK_LIMIT = 3;
const MESSAGE_LIMIT  = 2;
const WINDOW_MS      = 1000; // 1-second sliding window

/**
 * Redis-backed per-user rate limiting middleware.
 * Uses a simple counter with TTL — lightweight and effective.
 * Admin is always bypassed.
 */
function rateLimiterMiddleware() {
  return async (ctx, next) => {
    // Skip updates without a user (e.g., channel posts)
    const userId = ctx.from?.id;
    if (!userId) return next();

    // Admin bypass
    if (userId === ADMIN_ID) return next();

    // Determine limit based on update type
    const isCallback = !!ctx.callbackQuery;
    const limit = isCallback ? CALLBACK_LIMIT : MESSAGE_LIMIT;
    const key = `ratelimit:${userId}:${isCallback ? 'cb' : 'msg'}`;

    try {
      const current = await redisConnection.incr(key);
      if (current === 1) {
        // First request in this window — set TTL
        await redisConnection.pexpire(key, WINDOW_MS);
      }

      if (current > limit) {
        // Rate limited
        if (isCallback) {
          await ctx.answerCbQuery('⏳ Iltimos, sekinroq bosing!', { show_alert: false }).catch(() => {});
        }
        // For text messages, silently drop
        logger.warn('Rate limited', { userId, type: isCallback ? 'callback' : 'message', count: current });
        return; // Do NOT call next()
      }
    } catch (err) {
      // If Redis fails, let the request through (fail-open)
      logger.error('Rate limiter Redis error', { error: err.message });
    }

    return next();
  };
}

module.exports = { rateLimiterMiddleware };
