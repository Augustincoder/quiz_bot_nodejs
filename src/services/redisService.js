'use strict';

require('dotenv').config();
const Redis = require('ioredis');
const logger = require('../core/logger');

let redisConnection;

if (!process.env.REDIS_URL) {
  const EventEmitter = require('events');
  const dummy = new EventEmitter();
  dummy.isDummy = true;
  const inMemoryStore = new Map();
  const inMemoryTimers = new Map();

  const clearKeyTimer = (k) => {
    const t = inMemoryTimers.get(k);
    if (t) {
      clearTimeout(t);
      inMemoryTimers.delete(k);
    }
  };

  dummy.get = async (k) => inMemoryStore.get(k) ?? null;
  dummy.getBuffer = async (k) => inMemoryStore.get(k) ?? null;
  dummy.set = async (k, v, ...args) => {
    clearKeyTimer(k);
    inMemoryStore.set(k, String(v));
    if (args.length >= 2) {
      const mode = String(args[0]).toUpperCase();
      const val = Number(args[1]);
      if (mode === 'EX' && val > 0) {
        dummy.expire(k, val);
      } else if (mode === 'PX' && val > 0) {
        dummy.pexpire(k, val);
      }
    }
    return 'OK';
  };
  dummy.del = async (k) => {
    clearKeyTimer(k);
    const has = inMemoryStore.has(k);
    inMemoryStore.delete(k);
    return has ? 1 : 0;
  };
  dummy.incr = async (k) => {
    const val = (Number(inMemoryStore.get(k)) || 0) + 1;
    inMemoryStore.set(k, String(val));
    return val;
  };
  dummy.pexpire = async (k, ms) => {
    clearKeyTimer(k);
    if (ms > 0 && inMemoryStore.has(k)) {
      const t = setTimeout(() => {
        inMemoryStore.delete(k);
        inMemoryTimers.delete(k);
      }, ms);
      if (t.unref) t.unref();
      inMemoryTimers.set(k, t);
    }
    return 1;
  };
  dummy.expire = async (k, sec) => dummy.pexpire(k, Number(sec) * 1000);
  dummy.exists = async (k) => inMemoryStore.has(k) ? 1 : 0;
  dummy.sadd = async (k, ...members) => {
    let set = inMemoryStore.get(k);
    if (!(set instanceof Set)) {
      set = new Set();
      inMemoryStore.set(k, set);
    }
    let added = 0;
    for (const m of members) {
      if (!set.has(String(m))) {
        set.add(String(m));
        added++;
      }
    }
    return added;
  };
  dummy.sismember = async (k, member) => {
    const set = inMemoryStore.get(k);
    return (set instanceof Set && set.has(String(member))) ? 1 : 0;
  };
  dummy.srem = async (k, ...members) => {
    const set = inMemoryStore.get(k);
    if (!(set instanceof Set)) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(String(m))) removed++;
    }
    return removed;
  };
  dummy.smembers = async (k) => {
    const set = inMemoryStore.get(k);
    return set instanceof Set ? Array.from(set) : [];
  };
  dummy.mget = async (...keys) => {
    const flat = Array.isArray(keys[0]) ? keys[0] : keys;
    return flat.map(k => inMemoryStore.get(k) ?? null);
  };
  dummy.quit = async () => 'OK';
  dummy.ping = async () => 'PONG';
  dummy.createWorkerConnection = () => null;
  redisConnection = dummy;
} else {
  const isSecureRedis = process.env.REDIS_URL.startsWith('rediss://');
  const baseOptions = {
    family: 4, // Force IPv4 (avoids IPv6 connection timeouts on Render and cloud hosts)
    connectTimeout: 10000,
    keepAlive: 10000,
    retryStrategy(times) {
      return Math.min(times * 150, 3000);
    },
  };

  if (isSecureRedis) {
    const rejectUnauthorized = process.env.REDIS_TLS_REJECT_UNAUTHORIZED !== 'false';
    baseOptions.tls = { rejectUnauthorized };
    if (!rejectUnauthorized) {
      logger.warn('⚠️ SECURITY WARNING: REDIS_TLS_REJECT_UNAUTHORIZED=false. Redis TLS certificate verification is bypassed.');
    }
  }

  // Primary connection for caching, sessions, and rate-limiting
  redisConnection = new Redis(process.env.REDIS_URL, {
    ...baseOptions,
    maxRetriesPerRequest: 3,
  });

  redisConnection.on('error', (err) => logger.error('❌ Redis Xatosi:', { error: err.message }));
  redisConnection.on('connect', () => {
    logger.info(`✅ Redis muvaffaqiyatli ulandi! (SSL: ${isSecureRedis ? 'Yoniq' : "O'chiq"})`);
  });

  // Dedicated worker connection factory for BullMQ (requires maxRetriesPerRequest: null)
  redisConnection.createWorkerConnection = () => {
    return new Redis(process.env.REDIS_URL, {
      ...baseOptions,
      maxRetriesPerRequest: null,
    });
  };
}

module.exports = redisConnection;