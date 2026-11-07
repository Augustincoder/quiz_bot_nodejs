'use strict';

const logger = require('./logger');

/**
 * Production-Grade Circuit Breaker with Strict Single-Probe HALF_OPEN Protection.
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

module.exports = { CircuitBreaker };
