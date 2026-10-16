'use strict';

const logger = require('../core/logger');
const scheduleService = require('./scheduleService');

// Northflank / Render 512MB RAM safety thresholds:
// 1. Heap threshold: 280MB V8 heap
// 2. RSS threshold: 360MB process resident memory (Northflank/Render SIGKILLs container at 512MB)
const HEAP_THRESHOLD_BYTES = 280 * 1024 * 1024;
const RSS_THRESHOLD_BYTES = 360 * 1024 * 1024;
const CHECK_INTERVAL_MS = 30 * 1000;

let _timer = null;
let _isRunning = false;

function checkMemory() {
  try {
    const mem = process.memoryUsage();
    const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMb = Math.round(mem.rss / 1024 / 1024);

    const isHeapHigh = mem.heapUsed > HEAP_THRESHOLD_BYTES;
    const isRssHigh = mem.rss > RSS_THRESHOLD_BYTES;

    if (isHeapHigh || isRssHigh) {
      logger.warn(`🚨 Surgical RAM Watchdog Alert: Heap ${heapUsedMb}MB / RSS ${rssMb}MB exceeded safe ceiling. Initiating disposable cache purge...`);

      // 1. Clear ONLY disposable timetable PNG image buffers (quizzes and sessions are 100% untouched)
      scheduleService.clearImageMemoryCache();

      // 2. Pause non-essential background CDN pre-warming if active
      try {
        const timetableCdnService = require('./timetableCdnService');
        if (typeof timetableCdnService.stopPrewarmWorker === 'function') {
          timetableCdnService.stopPrewarmWorker();
        }
      } catch (e) {
        logger.debug('Watchdog prewarm stop check:', { error: e.message });
      }

      // 3. Invoke V8 garbage collector if exposed
      if (typeof global.gc === 'function') {
        global.gc();
        const afterMem = process.memoryUsage();
        const afterHeapMb = Math.round(afterMem.heapUsed / 1024 / 1024);
        const freedMb = heapUsedMb - afterHeapMb;
        logger.info(`✅ Surgical RAM Watchdog: GC completed. Heap reduced from ${heapUsedMb}MB to ${afterHeapMb}MB (Freed: ${freedMb}MB). Active quizzes remain 100% intact.`);
      } else {
        logger.warn('⚠️ Surgical RAM Watchdog: Disposable image cache cleared, but global.gc is not exposed.');
      }
    }
  } catch (err) {
    logger.error('Error in Surgical RAM Watchdog:', { error: err.message });
  }
}

function startWatchdog() {
  if (_isRunning) return;
  _isRunning = true;
  _timer = setInterval(checkMemory, CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref(); // Do not hold event loop open on process exit
  logger.info('🛡️ Surgical RAM Watchdog active (380MB threshold, Quiz-safe)');
}

function stopWatchdog() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _isRunning = false;
}

/**
 * Production-Grade Circuit Breaker with Strict Single-Probe HALF_OPEN Protection (Bug #53).
 * When state transitions from OPEN to HALF_OPEN, only exactly 1 probe request is permitted (isProbing = true).
 * Concurrent requests arriving during the probe are throttled/rejected to prevent stampeding downstream external services.
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'default';
    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeoutMs = options.resetTimeoutMs || 45000;
    this.state = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    this.consecutiveFailures = 0;
    this.nextRetryTime = 0;
    this.isProbing = false;
  }

  canAttempt() {
    if (this.state === 'CLOSED') return true;

    const now = Date.now();
    if (this.state === 'OPEN') {
      if (now >= this.nextRetryTime) {
        this.state = 'HALF_OPEN';
        this.isProbing = true;
        logger.info(`🔄 [CircuitBreaker:${this.name}] Testing recovery (HALF_OPEN probe allowed)...`);
        return true;
      }
      return false;
    }

    if (this.state === 'HALF_OPEN') {
      // Single-probe lock: block concurrent requests while probe is in flight
      if (!this.isProbing) {
        this.isProbing = true;
        return true;
      }
      return false;
    }

    return true;
  }

  recordSuccess() {
    if (this.state !== 'CLOSED') {
      logger.info(`✅ [CircuitBreaker:${this.name}] Service recovered! Breaker reset to CLOSED.`);
    }
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.nextRetryTime = 0;
    this.isProbing = false;
  }

  recordFailure(err) {
    this.consecutiveFailures++;
    this.isProbing = false;

    if (this.consecutiveFailures >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.nextRetryTime = Date.now() + this.resetTimeoutMs;
      logger.warn(`⚡ [CircuitBreaker:${this.name}] Tripped to OPEN (${this.consecutiveFailures} consecutive failures). Fast-failing calls for ${this.resetTimeoutMs / 1000}s.`, {
        error: err?.message,
      });
    }
  }

  getState() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      nextRetryTime: this.nextRetryTime,
      isProbing: this.isProbing,
    };
  }

  setState(state, nextRetry = 0, isProbing = false) {
    this.state = state;
    this.nextRetryTime = nextRetry;
    this.isProbing = isProbing;
    if (state === 'CLOSED') {
      this.consecutiveFailures = 0;
    }
  }

  async execute(asyncFn, fallbackFn = null) {
    if (!this.canAttempt()) {
      if (typeof fallbackFn === 'function') {
        return fallbackFn(new Error(`CircuitBreaker is ${this.state}`));
      }
      throw new Error(`CircuitBreaker:${this.name} is ${this.state}`);
    }

    try {
      const result = await asyncFn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      if (typeof fallbackFn === 'function') {
        return fallbackFn(err);
      }
      throw err;
    }
  }
}

module.exports = {
  startWatchdog,
  stopWatchdog,
  checkMemory,
  CircuitBreaker,
};

