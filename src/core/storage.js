'use strict';
const fs = require('fs').promises; // Asinxron metodlar
const fsSync = require('fs'); // Faqat ilk marta papka ochish uchun
const path = require('path');

function resolveUsersStatsPath() {
  const rootPath = path.join(__dirname, '../../data/users_stats.json');
  const srcPath = path.join(__dirname, '../data/users_stats.json');
  if (fsSync.existsSync(srcPath)) {
    try {
      const data = JSON.parse(fsSync.readFileSync(srcPath, 'utf8'));
      if (Object.keys(data).length > 0) return srcPath;
    } catch {}
  }
  if (fsSync.existsSync(rootPath)) return rootPath;
  return srcPath;
}
const usersStatsPath = resolveUsersStatsPath();

// Bu funksiya bot ishga tushganda 1 marta ishlagani uchun Sync qolsa bo'ladi
function initStorage() {
  if (!fsSync.existsSync(usersStatsPath)) {
    fsSync.mkdirSync(path.dirname(usersStatsPath), { recursive: true });
    fsSync.writeFileSync(usersStatsPath, JSON.stringify({}));
  }
  return {};
}

let _redisClient = null;
function getRedis() {
  if (!_redisClient) {
    try {
      _redisClient = require('../services/redisService');
    } catch {
      _redisClient = null;
    }
  }
  return _redisClient;
}

// Memory store to keep sync state during transient Redis outages
let inMemoryStatsCache = null;
let isDirty = false;
let flushPromise = null;

// Asinxron o'qish - In-Memory / Redis / Fayl kaskadi
async function getUsersStats() {
  // 1. Agar in-memory keshda bo'lsa darhol qaytaramiz
  if (inMemoryStatsCache && Object.keys(inMemoryStatsCache).length > 0) {
    return inMemoryStatsCache;
  }

  // 2. Redis mavjud bo'lsa Redis'dan tekshiramiz
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get('storage:users_stats');
      if (cached) {
        inMemoryStatsCache = JSON.parse(cached);
        return inMemoryStatsCache;
      }
    } catch (err) {
      console.warn('storage: Redisdan o\'qishda xatolik, faylga o\'tilmoqda:', err.message);
    }
  }

  // 3. Diskdagi JSON fayldan o'qish
  try {
    const data = await fs.readFile(usersStatsPath, 'utf8');
    inMemoryStatsCache = JSON.parse(data);
    return inMemoryStatsCache;
  } catch (error) {
    console.error('Statistika o\'qishda xatolik:', error);
    return {};
  }
}

// Atomic Asinxron yozish va Redis'ga sinxronlash (Dual-write + Auto-flush)
async function saveUsersStats(stats) {
  inMemoryStatsCache = stats || {};
  isDirty = true;

  try {
    const tempPath = `${usersStatsPath}.tmp`;
    // 1. Avval vaqtinchalik faylga yozamiz
    await fs.writeFile(tempPath, JSON.stringify(stats, null, 2));
    // 2. Keyin asli bilan almashtiramiz
    await fs.rename(tempPath, usersStatsPath);
  } catch (error) {
    console.error('Statistika yozishda xatolik:', error);
  }

  // Redis'ga sinxronlash (agar ulanish uzilgan bo'lsa keyinroq flushSync qiladi)
  await flushToRedis().catch(() => {});
}

/**
 * Flush in-memory stats to Redis when connection is restored
 */
async function flushToRedis() {
  if (!isDirty || !inMemoryStatsCache) return;
  const redis = getRedis();
  if (!redis) return;

  if (flushPromise) return flushPromise;

  flushPromise = (async () => {
    try {
      await redis.set('storage:users_stats', JSON.stringify(inMemoryStatsCache));
      isDirty = false;
    } catch (e) {
      // Redis hali ham uzilgan bo'lsa dirty holatda qoladi
    } finally {
      flushPromise = null;
    }
  })();

  return flushPromise;
}

// Redis qayta ulanganda auto-flush hodisasini tinglash
try {
  const redis = getRedis();
  if (redis && typeof redis.on === 'function') {
    redis.on('connect', () => {
      if (isDirty) {
        flushToRedis().catch(() => {});
      }
    });
  }
} catch {}

module.exports = {
  initStorage,
  getUsersStats,
  saveUsersStats,
  flushToRedis,
  usersStatsPath,
  _getInMemoryStats: () => inMemoryStatsCache,
  _isDirty: () => isDirty,
};