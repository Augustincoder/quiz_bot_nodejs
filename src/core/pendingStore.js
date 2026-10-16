'use strict';
const { TTLMap } = require('./utils');

// 10 daqiqadan keyin xotiradan avtomatik o'chib ketadi (600_000 ms)
// Bu bot RAM'ini himoya qiladi
const pendingShelfSaves = new TTLMap(600_000); 

// Generic wizard / temporary state cache (15 minutes default TTL, up to 2000 active sessions)
const generalPendingStore = new TTLMap(15 * 60 * 1000, 2000);

async function set(key, value, ttlMs = 15 * 60 * 1000) {
  generalPendingStore.set(key, value);
  try {
    const redis = require('../services/redisService');
    if (redis && redis.isReady && typeof redis.set === 'function') {
      const ttlSec = Math.max(1, Math.round(ttlMs / 1000));
      await redis.set(`pending:${key}`, JSON.stringify(value), 'EX', ttlSec);
    }
  } catch {}
}

async function get(key) {
  if (generalPendingStore.has(key)) {
    return generalPendingStore.get(key);
  }
  try {
    const redis = require('../services/redisService');
    if (redis && redis.isReady && typeof redis.get === 'function') {
      const raw = await redis.get(`pending:${key}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        generalPendingStore.set(key, parsed);
        return parsed;
      }
    }
  } catch {}
  return null;
}

async function del(key) {
  generalPendingStore.delete(key);
  try {
    const redis = require('../services/redisService');
    if (redis && redis.isReady && typeof redis.del === 'function') {
      await redis.del(`pending:${key}`);
    }
  } catch {}
}

function clearPendingUser(userId) {
  if (!userId) return;
  pendingShelfSaves.delete(userId);
  del(`note_wiz:${userId}`).catch(() => {});
}

module.exports = {
  pendingShelfSaves,
  clearPendingUser,
  set,
  get,
  delete: del,
};
