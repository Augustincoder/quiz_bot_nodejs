'use strict';

/**
 * Feature Flag & Rollout Governance Service
 * 
 * Provides:
 * - Declarative self-registration for new features (defaulting to ADMIN_ONLY).
 * - Deterministic user bucketing (0..99) using SHA-256 for canary rollouts.
 * - Multi-tiered rollout states: OFF, ADMIN_ONLY, BETA_USERS, PERCENT_*, PUBLIC.
 * - L1 In-Memory Cache (TTL: 5s) + Redis persistence with graceful offline fallback.
 * - Sub-millisecond synchronous evaluation (`isFeatureEnabledSync`).
 */

const crypto = require('crypto');
const logger = require('../core/logger');

// Rollout states enum
const STATES = Object.freeze({
  OFF: 'OFF',
  ADMIN_ONLY: 'ADMIN_ONLY',
  BETA_USERS: 'BETA_USERS',
  PERCENT_10: 'PERCENT_10',
  PERCENT_20: 'PERCENT_20',
  PERCENT_25: 'PERCENT_25',
  PERCENT_50: 'PERCENT_50',
  PUBLIC: 'PUBLIC',
});

// Redis Keys
const REDIS_KEY_STATES = 'feature_flags:states';
const REDIS_KEY_BETA_USERS = 'feature_flags:beta_users';

// L1 In-Memory Cache
const L1_CACHE_TTL_MS = 5000;
let _features = {};
let _betaUsers = new Set();
let _adminList = new Set();
let _featureErrors = new Map();
let _lastL1Refresh = 0;
let _isRefreshing = false;
let _initialized = false;

// Optional Redis client handle
let redisClient = null;
try {
  redisClient = require('./redisService');
} catch (err) {
  logger.warn('featureFlagService: redisService not found, using memory-only mode', { error: err.message });
}

// Load initial admin IDs from config
try {
  const config = require('../config/config');
  if (Array.isArray(config.ADMIN_IDS) && config.ADMIN_IDS.length > 0) {
    config.ADMIN_IDS.forEach(id => {
      const num = Number(id);
      if (!Number.isNaN(num)) _adminList.add(num);
    });
  } else if (config.ADMIN_ID) {
    const num = Number(config.ADMIN_ID);
    if (!Number.isNaN(num)) _adminList.add(num);
  }
} catch (err) {
  // Config load fallback
}

/**
 * Calculate deterministic bucket (0..99) for a given userId and featureKey.
 * Strictly deterministic across all calls and node instances.
 *
 * @param {string|number} userId 
 * @param {string} featureKey 
 * @returns {number} Integer between 0 and 99
 */
function calculateUserBucket(userId, featureKey) {
  if (userId === null || userId === undefined || userId === '') {
    return 0;
  }
  const normalizedUser = String(userId).trim();
  const normalizedKey = String(featureKey || '').trim();
  const input = `${normalizedKey}:${normalizedUser}`;
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  // First 8 hex characters = 32-bit uint
  const num = parseInt(hash.slice(0, 8), 16);
  return num % 100;
}

/**
 * Check if user is in admin list.
 *
 * @param {string|number} userId 
 * @param {Object} [context] 
 * @returns {boolean}
 */
function isAdmin(userId, context) {
  if (context && context.isAdmin === true) return true;
  if (userId === null || userId === undefined) return false;
  const numId = Number(userId);
  if (!Number.isNaN(numId) && _adminList.has(numId)) return true;
  return false;
}

/**
 * Check if user or context chat is in beta testers cohort.
 *
 * @param {string|number} userId 
 * @param {Object} [context] 
 * @returns {boolean}
 */
function isBeta(userId, context) {
  if (userId !== null && userId !== undefined) {
    if (_betaUsers.has(String(userId))) return true;
  }
  if (context && context.chatId !== null && context.chatId !== undefined) {
    if (_betaUsers.has(String(context.chatId))) return true;
  }
  return false;
}

/**
 * Refresh L1 in-memory cache from Redis.
 * Gracefully swallows any connection or parse errors without throwing.
 */
async function refreshFromRedis() {
  if (!redisClient || typeof redisClient.get !== 'function') {
    _lastL1Refresh = Date.now();
    return;
  }
  if (_isRefreshing) return;
  _isRefreshing = true;

  try {
    // 1. Fetch feature states
    const raw = await redisClient.get(REDIS_KEY_STATES);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        // Merge with local state, preserving local additions
        for (const [k, v] of Object.entries(parsed)) {
          if (!_features[k] || (_features[k].updatedAt || 0) <= (v.updatedAt || 0)) {
            _features[k] = v;
          }
        }
      }
    }

    // 2. Fetch beta users set
    if (typeof redisClient.smembers === 'function') {
      const members = await redisClient.smembers(REDIS_KEY_BETA_USERS);
      if (Array.isArray(members)) {
        for (const m of members) {
          _betaUsers.add(String(m));
        }
      }
    }

    _lastL1Refresh = Date.now();
  } catch (err) {
    logger.debug('featureFlagService: refreshFromRedis error (fallback to local)', { error: err.message });
  } finally {
    _isRefreshing = false;
  }
}

/**
 * Persist current feature states to Redis.
 * Never throws, fails open / logs error.
 */
async function persistFeaturesToRedis() {
  if (!redisClient || typeof redisClient.set !== 'function') return;
  try {
    await redisClient.set(REDIS_KEY_STATES, JSON.stringify(_features));
  } catch (err) {
    logger.warn('featureFlagService: failed to persist states to Redis', { error: err.message });
  }
}

/**
 * Evaluate whether a given feature state allows access for the user/context.
 * 
 * Evaluation order:
 * 1. OFF -> false (even for admins)
 * 2. Admin check -> true for any state other than OFF
 * 3. ADMIN_ONLY -> false
 * 4. BETA_USERS -> true if in beta list / chat in beta
 * 5. PERCENT_* -> bucket < percentage
 * 6. PUBLIC -> true
 * 
 * @param {string} state
 * @param {string} featureKey
 * @param {string|number} userId
 * @param {Object} [context]
 * @returns {boolean}
 */
function evaluateState(state, featureKey, userId, context) {
  // 1. OFF disables feature completely
  if (state === STATES.OFF) {
    return false;
  }

  // 2. Admins have access to any state except OFF
  if (isAdmin(userId, context)) {
    return true;
  }

  // 3. ADMIN_ONLY restricts to admins (handled above)
  if (state === STATES.ADMIN_ONLY) {
    return false;
  }

  // 4. BETA_USERS cohort
  if (state === STATES.BETA_USERS) {
    return isBeta(userId, context);
  }

  // 5. Canary percentage rollout (e.g. PERCENT_10, PERCENT_25, PERCENT_50)
  if (typeof state === 'string' && state.startsWith('PERCENT_')) {
    const match = state.match(/^PERCENT_(\d+)$/);
    const percentage = match ? parseInt(match[1], 10) : 0;
    if (percentage <= 0) return false;
    if (percentage >= 100) return true;

    const bucket = calculateUserBucket(userId, featureKey);
    return bucket < percentage;
  }

  // 6. PUBLIC General Availability
  if (state === STATES.PUBLIC) {
    return true;
  }

  return false;
}

/**
 * Ensure a feature is registered in the L1 registry.
 * If unknown, self-registers with default state ADMIN_ONLY.
 * 
 * @param {string} featureKey 
 * @returns {Object} Feature record
 */
function ensureRegistered(featureKey) {
  if (!_features[featureKey]) {
    _features[featureKey] = {
      key: featureKey,
      state: STATES.ADMIN_ONLY,
      updatedAt: Date.now(),
      autoKillTriggered: false,
      trippedAt: null,
      trippedReason: null,
      errorCount: 0,
    };
    // Schedule background persistence
    persistFeaturesToRedis().catch(() => {});
  }
  return _features[featureKey];
}

/**
 * Asynchronously evaluate if a feature is enabled for a user / context.
 * Automatically self-registers new features with ADMIN_ONLY state.
 * Refreshes L1 cache if expired (> 5s).
 * 
 * @param {string} featureKey 
 * @param {string|number} [userId] 
 * @param {Object} [context] 
 * @returns {Promise<boolean>}
 */
async function isFeatureEnabled(featureKey, userId, context = {}) {
  if (!featureKey || typeof featureKey !== 'string') return false;

  // Refresh L1 cache if stale
  if (Date.now() - _lastL1Refresh > L1_CACHE_TTL_MS) {
    await refreshFromRedis();
  }

  let feat = _features[featureKey];
  if (!feat) {
    feat = ensureRegistered(featureKey);
    await persistFeaturesToRedis();
  }

  return evaluateState(feat.state, featureKey, userId, context);
}

/**
 * Synchronously evaluate if a feature is enabled for a user / context.
 * Uses L1 in-memory cache directly with sub-millisecond latency.
 * Suitable for inline keyboard builders and non-async handlers.
 * 
 * @param {string} featureKey 
 * @param {string|number} [userId] 
 * @param {Object} [context] 
 * @returns {boolean}
 */
function isFeatureEnabledSync(featureKey, userId, context = {}) {
  if (!featureKey || typeof featureKey !== 'string') return false;

  // Trigger background refresh if stale without blocking
  if (Date.now() - _lastL1Refresh > L1_CACHE_TTL_MS) {
    refreshFromRedis().catch(() => {});
  }

  let feat = _features[featureKey];
  if (!feat) {
    feat = ensureRegistered(featureKey);
  }

  return evaluateState(feat.state, featureKey, userId, context);
}

/**
 * Set the rollout state for a feature and persist to Redis.
 * 
 * @param {string} featureKey 
 * @param {string} state 
 * @param {Object} [options] 
 * @returns {Promise<Object>}
 */
async function setFeatureState(featureKey, state, options = {}) {
  if (!featureKey || typeof featureKey !== 'string') {
    throw new Error('featureKey must be a non-empty string');
  }

  const existing = _features[featureKey] || {
    key: featureKey,
    autoKillTriggered: false,
    trippedAt: null,
    trippedReason: null,
    errorCount: 0,
  };

  const updated = {
    ...existing,
    key: featureKey,
    state,
    updatedAt: Date.now(),
    ...options,
  };

  _features[featureKey] = updated;
  await persistFeaturesToRedis();
  return updated;
}

/**
 * Get the current rollout state string for a feature.
 * 
 * @param {string} featureKey 
 * @returns {string|null}
 */
function getFeatureState(featureKey) {
  if (!featureKey || !_features[featureKey]) return null;
  return _features[featureKey].state;
}

/**
 * Get map of all registered features and their states/metadata.
 * Returns a cloned object to prevent accidental mutation.
 * 
 * @returns {Object<string, Object>}
 */
function getFeatureStates() {
  const result = {};
  for (const [k, v] of Object.entries(_features)) {
    result[k] = { ...v };
  }
  return result;
}

/**
 * Override the admin IDs list (useful for tests or dynamic admin config).
 * 
 * @param {Array<number|string>} ids 
 */
function setAdminList(ids) {
  _adminList = new Set(
    (Array.isArray(ids) ? ids : [ids])
      .map(Number)
      .filter(id => !Number.isNaN(id) && id > 0)
  );
}

/**
 * Get list of configured admin IDs.
 * 
 * @returns {Array<number>}
 */
function getAdminList() {
  return Array.from(_adminList);
}

/**
 * Add a user or group to the beta cohort.
 * Persists to Redis Set.
 * 
 * @param {string|number} userId 
 * @returns {Promise<boolean>}
 */
async function addBetaUser(userId) {
  if (userId === null || userId === undefined) return false;
  const strId = String(userId);
  _betaUsers.add(strId);

  if (redisClient && typeof redisClient.sadd === 'function') {
    try {
      await redisClient.sadd(REDIS_KEY_BETA_USERS, strId);
    } catch (err) {
      logger.warn('featureFlagService: failed to add beta user to Redis', { error: err.message });
    }
  }
  return true;
}

/**
 * Remove a user or group from the beta cohort.
 * 
 * @param {string|number} userId 
 * @returns {Promise<boolean>}
 */
async function removeBetaUser(userId) {
  if (userId === null || userId === undefined) return false;
  const strId = String(userId);
  _betaUsers.delete(strId);

  if (redisClient && typeof redisClient.srem === 'function') {
    try {
      await redisClient.srem(REDIS_KEY_BETA_USERS, strId);
    } catch (err) {
      logger.warn('featureFlagService: failed to remove beta user from Redis', { error: err.message });
    }
  }
  return true;
}

/**
 * Get list of all beta cohort IDs.
 * 
 * @returns {Array<string>}
 */
function getBetaUsers() {
  return Array.from(_betaUsers);
}

/**
 * Reset local state (useful for test isolation).
 */
function resetLocalState() {
  _features = {};
  _betaUsers.clear();
  _featureErrors.clear();
  _lastL1Refresh = 0;
}

/**
 * Dispatch emergency alert to bot owner / admins when circuit breaker trips.
 *
 * @param {string} featureKey 
 * @param {Object} info 
 */
function dispatchCircuitBreakerAlert(featureKey, info) {
  try {
    let errorReporter;
    try {
      errorReporter = require('./errorReporterService');
    } catch {
      // safe fallback if not found
    }
    if (errorReporter && typeof errorReporter.report === 'function') {
      const alertMsg = `🚨 <b>[CIRCUIT BREAKER / AUTO-KILL TRIGGERED]</b>\n` +
        `⚙️ <b>Feature:</b> <code>${featureKey}</code>\n` +
        `📉 <b>Action:</b> Downgraded from <code>${info.previousState}</code> to <code>${info.downgradedTo}</code>\n` +
        `💥 <b>Errors in window:</b> <code>${info.errorCount}</code>\n` +
        `⚠️ <b>Tripped reason:</b> <code>${info.reason}</code>\n` +
        `💡 Use <code>/flags</code> to inspect and reset once resolved.`;

      errorReporter.report(alertMsg, {
        source: 'circuitBreaker',
        feature: featureKey,
        previousState: info.previousState,
        downgradedTo: info.downgradedTo,
        errorCount: info.errorCount,
        trippedAt: info.trippedAt,
      }).catch(err => {
        logger.debug('featureFlagService: circuit breaker alert failed to send', { error: err.message });
      });
    }
  } catch (err) {
    logger.warn('featureFlagService: failed to dispatch alert', { error: err.message });
  }
}

/**
 * Record an unhandled feature error in the sliding window.
 * If errors in window exceed threshold, trips circuit breaker and auto-downgrades.
 *
 * @param {string} featureKey 
 * @param {Error|Object|string} error 
 * @param {Object} [options]
 * @param {number} [options.errorThreshold] Default 3
 * @param {number} [options.windowSeconds] Default 300 (5 minutes)
 * @param {string} [options.targetState] Default STATES.ADMIN_ONLY
 * @returns {Object} Trip status and error metrics
 */
function recordFeatureError(featureKey, error, options = {}) {
  if (!featureKey || typeof featureKey !== 'string') {
    return { tripped: false, errorCount: 0, threshold: 3 };
  }

  const feat = ensureRegistered(featureKey);
  const now = Date.now();

  const errorThreshold = (options && typeof options.errorThreshold === 'number' && options.errorThreshold > 0)
    ? options.errorThreshold
    : (feat.errorThreshold || 3);
  const windowSeconds = (options && typeof options.windowSeconds === 'number' && options.windowSeconds > 0)
    ? options.windowSeconds
    : (feat.windowSeconds || 300);
  const targetState = (options && options.targetState && STATES[options.targetState])
    ? options.targetState
    : (feat.targetState || STATES.ADMIN_ONLY);

  const cutoff = now - (windowSeconds * 1000);
  let errors = _featureErrors.get(featureKey) || [];
  errors = errors.filter(e => e.timestamp >= cutoff);

  const errMsg = error instanceof Error
    ? error.message
    : (typeof error === 'object' && error !== null
      ? (error.message || JSON.stringify(error))
      : String(error || 'Unknown error'));

  errors.push({
    timestamp: now,
    message: errMsg,
  });
  _featureErrors.set(featureKey, errors);

  feat.errorCount = errors.length;
  feat.windowSeconds = windowSeconds;
  feat.errorThreshold = errorThreshold;

  // Check if threshold exceeded
  if (errors.length >= errorThreshold) {
    if (feat.autoKillTriggered) {
      return {
        tripped: true,
        alreadyTripped: true,
        previousState: feat.previousState || feat.state,
        downgradedTo: feat.state,
        reason: feat.trippedReason || errMsg,
        errorCount: errors.length,
      };
    }

    const previousState = feat.state;
    feat.previousState = previousState;
    feat.state = targetState;
    feat.autoKillTriggered = true;
    feat.trippedAt = now;
    const reason = errMsg || 'Error threshold exceeded';
    feat.trippedReason = reason;
    feat.updatedAt = now;

    // Background sync to Redis
    persistFeaturesToRedis().catch(() => {});

    // Dispatch emergency alert to bot owner / admins
    dispatchCircuitBreakerAlert(featureKey, {
      previousState,
      downgradedTo: targetState,
      errorCount: errors.length,
      reason,
      trippedAt: now,
    });

    return {
      tripped: true,
      previousState,
      downgradedTo: targetState,
      reason,
      errorCount: errors.length,
    };
  }

  return {
    tripped: false,
    errorCount: errors.length,
    threshold: errorThreshold,
    windowSeconds,
  };
}

/**
 * Reset circuit breaker for a feature, restoring state and clearing error window.
 *
 * @param {string} featureKey 
 * @param {string} [restoredState] Optional state to force, otherwise restores previousState or current state
 * @returns {Object|null}
 */
function resetFeatureBreaker(featureKey, restoredState) {
  if (!featureKey || typeof featureKey !== 'string') return null;
  const feat = _features[featureKey];
  if (!feat) return null;

  _featureErrors.delete(featureKey);

  const previousState = feat.previousState;
  const target = restoredState && STATES[restoredState]
    ? restoredState
    : (previousState || feat.state || STATES.ADMIN_ONLY);

  feat.state = target;
  feat.autoKillTriggered = false;
  feat.trippedAt = null;
  feat.trippedReason = null;
  feat.errorCount = 0;
  feat.previousState = null;
  feat.updatedAt = Date.now();

  persistFeaturesToRedis().catch(() => {});

  return {
    success: true,
    featureKey,
    state: feat.state,
    autoKillTriggered: false,
  };
}

/**
 * Get real-time health metrics and circuit breaker status for a feature.
 *
 * @param {string} featureKey 
 * @returns {Object}
 */
function getFeatureHealth(featureKey) {
  if (!featureKey || typeof featureKey !== 'string') {
    return {
      errorCount: 0,
      windowSeconds: 300,
      autoKillTriggered: false,
      trippedAt: null,
      trippedReason: null,
    };
  }

  const feat = _features[featureKey] || ensureRegistered(featureKey);
  const windowSeconds = feat.windowSeconds || 300;
  const cutoff = Date.now() - (windowSeconds * 1000);

  let errors = _featureErrors.get(featureKey) || [];
  errors = errors.filter(e => e.timestamp >= cutoff);
  _featureErrors.set(featureKey, errors);

  return {
    featureKey,
    errorCount: errors.length,
    windowSeconds,
    errorThreshold: feat.errorThreshold || 3,
    autoKillTriggered: Boolean(feat.autoKillTriggered),
    trippedAt: feat.trippedAt || null,
    trippedReason: feat.trippedReason || null,
    state: feat.state,
    previousState: feat.previousState || null,
  };
}

/**
 * Initialize service, preload flags and beta cohorts from Redis.
 */
async function init() {
  if (_initialized) return true;
  await refreshFromRedis();
  _initialized = true;
  return true;
}

module.exports = {
  STATES,
  calculateUserBucket,
  isAdmin,
  isBeta,
  isFeatureEnabled,
  isFeatureEnabledSync,
  setFeatureState,
  getFeatureState,
  getFeatureStates,
  setAdminList,
  getAdminList,
  addBetaUser,
  removeBetaUser,
  getBetaUsers,
  resetLocalState,
  recordFeatureError,
  resetFeatureBreaker,
  getFeatureHealth,
  init,
};
