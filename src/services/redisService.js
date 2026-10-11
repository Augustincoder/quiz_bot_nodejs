'use strict';

require('dotenv').config();
const Redis = require('ioredis');

let redisConnection;

if (!process.env.REDIS_URL) {
  const EventEmitter = require('events');
  const dummy = new EventEmitter();
  dummy.isDummy = true;
  const inMemoryStore = new Map();
  dummy.get = async (k) => inMemoryStore.get(k) ?? null;
  dummy.getBuffer = async (k) => inMemoryStore.get(k) ?? null;
  dummy.set = async (k, v) => { inMemoryStore.set(k, String(v)); return 'OK'; };
  dummy.del = async (k) => { const has = inMemoryStore.has(k); inMemoryStore.delete(k); return has ? 1 : 0; };
  dummy.incr = async (k) => { const val = (Number(inMemoryStore.get(k)) || 0) + 1; inMemoryStore.set(k, String(val)); return val; };
  dummy.pexpire = async () => 1;
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
  }

  // Primary connection for caching, sessions, and rate-limiting
  redisConnection = new Redis(process.env.REDIS_URL, {
    ...baseOptions,
    maxRetriesPerRequest: 3,
  });

  redisConnection.on('error', (err) => console.error('❌ Redis Xatosi:', err.message));
  redisConnection.on('connect', () => {
    console.log(`✅ Redis muvaffaqiyatli ulandi! (SSL: ${isSecureRedis ? 'Yoniq' : "O'chiq"})`);
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