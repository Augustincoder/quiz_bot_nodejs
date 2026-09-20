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
  dummy.quit = async () => 'OK';
  dummy.ping = async () => 'PONG';
  dummy.createWorkerConnection = () => null;
  redisConnection = dummy;
} else {
  const isSecureRedis = process.env.REDIS_URL.startsWith('rediss://');
  const redisOptions = {
    maxRetriesPerRequest: null,
    family: 0,
  };

  if (isSecureRedis) {
    redisOptions.tls = { rejectUnauthorized: false };
  }

  redisConnection = new Redis(process.env.REDIS_URL, redisOptions);

  redisConnection.on('error', (err) => console.error('❌ Redis Xatosi:', err.message));
  redisConnection.on('connect', () => {
    console.log(`✅ Redis muvaffaqiyatli ulandi! (SSL: ${isSecureRedis ? 'Yoniq' : "O'chiq"})`);
  });

  redisConnection.createWorkerConnection = () => {
    return new Redis(process.env.REDIS_URL, redisOptions);
  };
}

module.exports = redisConnection;