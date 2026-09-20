'use strict';

require('dotenv').config();
const Redis = require('ioredis');

let redisConnection;

if (!process.env.REDIS_URL) {
  const EventEmitter = require('events');
  const dummy = new EventEmitter();
  dummy.isDummy = true;
  dummy.get = async () => null;
  dummy.getBuffer = async () => null;
  dummy.set = async () => 'OK';
  dummy.del = async () => 1;
  dummy.incr = async () => 1;
  dummy.pexpire = async () => 1;
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
    baseOptions.tls = { rejectUnauthorized: false };
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