'use strict';

const https = require('https');
const logger = require('../core/logger');

const DAY_NAMES = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
const PERIOD_TIMES = {
  1: { start: '08:30', end: '09:50' },
  2: { start: '10:00', end: '11:20' },
  3: { start: '11:30', end: '12:50' },
  4: { start: '13:30', end: '14:50' },
  5: { start: '15:00', end: '16:20' },
  6: { start: '16:30', end: '17:50' },
  7: { start: '18:00', end: '19:20' },
  8: { start: '19:30', end: '20:50' },
};

// Fallback semester version if dynamic discovery is temporarily unavailable
const FALLBACK_DEFAULT_NUM = '94';

// Cache TTLs
const L1_CACHE_TTL = 60 * 60 * 1000; // 1 hour fresh
const L1_STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours stale fallback
const DEFAULT_NUM_TTL = 12 * 60 * 60 * 1000; // 12 hours
const REDIS_TTL_SEC = 12 * 60 * 60; // 12 hours in Redis

// Keep-alive agent to reuse TCP/TLS sockets and minimize connection latency
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 10,
  keepAliveMsecs: 30000,
  timeout: 25000,
});

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'uz,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin': 'https://tsue.edupage.org',
  'Referer': 'https://tsue.edupage.org/timetable/',
  'Connection': 'keep-alive',
};

// Internal cache state
let cachedDefaultNum = FALLBACK_DEFAULT_NUM;
let cachedDefaultNumTime = 0;

let l1IndexedDatabase = null;
let l1CacheTime = 0;

// Singleflight Mutex: collapses concurrent callers into a single network fetch
let activeFetchPromise = null;

/**
 * Optional Redis client resolver (graceful degradation if Redis is unavailable)
 */
function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  try {
    return require('./redisService');
  } catch {
    return null;
  }
}

/**
 * Normalizes a class/group string for fast O(1) hash lookups.
 * e.g. "MO-900/26" -> "MO90026", " mi-21 " -> "MI21"
 */
function normalizeGroupName(str) {
  if (!str) return '';
  return str.toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Safe HTTPS POST request with timeout and keep-alive
 */
function httpPost(path, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const postData = typeof payload === 'string' ? payload : JSON.stringify(payload);
    let isSettled = false;

    const req = https.request({
      hostname: 'tsue.edupage.org',
      path,
      agent: httpsAgent,
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch {
          reject(new Error('JSON parse failed for EduPage response'));
        }
      });
    });

    const timer = setTimeout(() => {
      if (isSettled) return;
      isSettled = true;
      req.destroy(new Error(`POST ${path} timed out after ${timeoutMs}ms`));
      reject(new Error(`POST ${path} timed out`));
    }, timeoutMs);

    req.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      reject(err);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Retry helper with exponential backoff and jitter
 */
async function fetchWithRetry(fn, retries = 2, delayMs = 1000) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const jitter = Math.floor(Math.random() * 500);
        const waitTime = delayMs * Math.pow(2, attempt) + jitter;
        await new Promise(r => setTimeout(r, waitTime));
      }
    }
  }
  throw lastError;
}

/**
 * Dynamically resolves current semester/week number (default_num) from EduPage metadata
 */
async function resolveDefaultNum() {
  const now = Date.now();
  if (cachedDefaultNum && (now - cachedDefaultNumTime < DEFAULT_NUM_TTL)) {
    return cachedDefaultNum;
  }

  try {
    const currentYear = new Date().getFullYear();
    const payload = { __args: [null, currentYear], __gsh: '00000000' };
    const res = await fetchWithRetry(
      () => httpPost('/timetable/server/ttviewer.js?__func=getTTViewerData', payload, 15000),
      1,
      800
    );

    const discoveredNum = res?.r?.regular?.default_num;
    if (discoveredNum && String(discoveredNum).trim()) {
      cachedDefaultNum = String(discoveredNum).trim();
      cachedDefaultNumTime = now;
      return cachedDefaultNum;
    }
  } catch (err) {
    logger.warn('Failed to resolve dynamic default_num from EduPage, using fallback', {
      error: err.message,
      fallback: cachedDefaultNum,
    });
  }

  return cachedDefaultNum || FALLBACK_DEFAULT_NUM;
}

/**
 * Tier 1 Lightweight Gatekeeper: probes EduPage metadata (332 bytes)
 * Returns deterministic signature string to detect if any schedule version or table was modified.
 */
async function getMetadataSignature() {
  try {
    const currentYear = new Date().getFullYear();
    const payload = { __args: [null, currentYear], __gsh: '00000000' };
    const res = await fetchWithRetry(
      () => httpPost('/timetable/server/ttviewer.js?__func=getTTViewerData', payload, 10000),
      1,
      500
    );

    const defaultNum = res?.r?.regular?.default_num || '';
    const activeTt = res?.r?.regular?.timetables?.[0] || {};
    const ttNum = activeTt.tt_num || '';
    const text = activeTt.text || '';
    const datefrom = activeTt.datefrom || '';
    const changeEvent = res?.r?._changeEvents?.['dbi:global_settings'] || 0;

    if (!defaultNum && !ttNum) return null;

    // Update cached defaultNum if fresh
    if (defaultNum && String(defaultNum).trim()) {
      cachedDefaultNum = String(defaultNum).trim();
      cachedDefaultNumTime = Date.now();
    }

    return `${defaultNum}:${ttNum}:${text}:${datefrom}:${changeEvent}`;
  } catch (err) {
    logger.warn('Failed to fetch EduPage metadata probe signature', { error: err.message });
    return null;
  }
}

/**
 * Parses building and floor information from classroom code
 */
function parseRoomLocation(xona) {
  const slashMatch = xona.match(/^(\d+)\/(\d+)/);
  const dashMatch = xona.match(/^(\d+)-.*?(\d)(\d{2})/);
  const normalMatch = xona.match(/^(\d)(\d{2})/);
  if (slashMatch) return { bino: slashMatch[1] === '1' ? '4-bino' : `${slashMatch[1]}-bino`, qavat: `${slashMatch[2].charAt(0)}-qavat` };
  if (dashMatch) return { bino: `${dashMatch[1]}-bino`, qavat: `${dashMatch[2]}-qavat` };
  if (normalMatch) return { bino: 'Asosiy bino', qavat: `${normalMatch[1]}-qavat` };
  return { bino: 'Asosiy bino', qavat: `${xona.charAt(0)}-qavat` };
}

/**
 * High-performance indexing engine: converts raw EduPage university tables into
 * pre-indexed O(1) structures for classes, teachers, rooms, and weekly schedules.
 */
function buildIndexedDatabase(raw, defaultNum) {
  const t0 = Date.now();
  const tables = raw?.r?.dbiAccessorRes?.tables || [];
  const findRows = (tid) => tables.find(t => t.id === tid)?.data_rows ?? [];

  const rooms = Object.fromEntries(findRows('classrooms').map(r => [r.id, r.short || r.name]));
  const periods = Object.fromEntries(findRows('periods').map(p => [p.id, p]));
  const teachers = Object.fromEntries(findRows('teachers').map(t => [t.id, t.name || t.short || '?']));
  const rawClasses = findRows('classes');
  const lessonMap = Object.fromEntries(findRows('lessons').map(l => [l.id, l]));
  const cards = findRows('cards');

  const subjects = Object.fromEntries(findRows('subjects').map(s => [
    s.id, {
      name: s.name || s.short || 'Noma\'lum fan',
      color: s.color || '#CCCCCC',
      weight: parseInt(s.contract_weight, 10) || 1,
    }
  ]));

  const classesById = new Map();
  const classesByName = new Map();
  const classNamesList = [];

  rawClasses.forEach(c => {
    classesById.set(c.id, c);
    const cName = (c.name || '').trim();
    const cShort = (c.short || '').trim();

    if (cName) {
      classesByName.set(normalizeGroupName(cName), c.id);
      classesByName.set(cName.toUpperCase(), c.id);
    }
    if (cShort) {
      classesByName.set(normalizeGroupName(cShort), c.id);
      classesByName.set(cShort.toUpperCase(), c.id);
    }
    classesByName.set(c.id, c.id);
  });

  // Pre-index weekly schedule for each class
  const schedulesByClassId = new Map();
  for (const card of cards) {
    const lesson = lessonMap[card.lessonid];
    if (!lesson || !lesson.classids || lesson.classids.length === 0) continue;

    const pObj = periods[card.period];
    if (!pObj) continue;
    const pNum = parseInt(pObj.period, 10);
    if (Number.isNaN(pNum)) continue;

    const daysStr = card.days || '';
    for (const cid of lesson.classids) {
      let classSchedule = schedulesByClassId.get(cid);
      if (!classSchedule) {
        classSchedule = {};
        schedulesByClassId.set(cid, classSchedule);
      }

      for (let d = 0; d < 6; d++) {
        if (daysStr[d] !== '1') continue;
        classSchedule[d] = classSchedule[d] || {};
        classSchedule[d][pNum] = classSchedule[d][pNum] || [];

        const subjData = subjects[lesson.subjectid] || { name: '?', color: '#CCCCCC', weight: 1 };
        classSchedule[d][pNum].push({
          subject: subjData.name,
          color: subjData.color,
          weight: subjData.weight,
          teacher: (lesson.teacherids || []).filter(Boolean).map(t => teachers[t] || t).join(', ') || '?',
          room: (card.classroomids || []).filter(Boolean).map(r => rooms[r] || r).join(', ') || '?',
        });
      }
    }
  }

  // Populate clean student group names that actually have lessons
  schedulesByClassId.forEach((_, cid) => {
    const c = classesById.get(cid);
    if (c?.name && !c.name.includes('FAKULTET') && !c.name.includes('KURS')) {
      classNamesList.push(c.name.trim());
    }
  });

  // Pre-index empty rooms matrix for all 6 days * 8 periods (48 slots)
  const emptyRoomsMatrix = new Map();
  for (let d = 0; d < 6; d++) {
    for (let p = 1; p <= 8; p++) {
      const occupied = new Set();
      for (const card of cards) {
        if ((card.days || '')[d] !== '1') continue;
        const pObj = periods[card.period];
        if (!pObj || parseInt(pObj.period, 10) !== p) continue;
        (card.classroomids || []).forEach(rid => occupied.add(rid));
      }

      const empty = Object.entries(rooms)
        .filter(([id, name]) => !occupied.has(id) && /^\d/.test((name || '').trim()))
        .map(([, name]) => name.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

      emptyRoomsMatrix.set(`${d}:${p}`, empty);
    }
  }

  logger.info('EduPage database successfully indexed', {
    defaultNum,
    classesCount: schedulesByClassId.size,
    emptySlotsIndexed: emptyRoomsMatrix.size,
    indexingTimeMs: Date.now() - t0,
  });

  return {
    defaultNum,
    fetchedAt: Date.now(),
    raw,
    classesById,
    classesByName,
    classNamesList,
    schedulesByClassId,
    emptyRoomsMatrix,
  };
}

/**
 * Fetches raw timetable JSON from TsUE EduPage with retry
 */
async function fetchRawTimetable(defaultNum) {
  const payload = { __args: [null, defaultNum.toString()], __gsh: '00000000' };
  return fetchWithRetry(
    () => httpPost('/timetable/server/regulartt.js?__func=regularttGetData', payload, 35000),
    2,
    1000
  );
}

/**
 * Resolves indexed timetable with Singleflight concurrency protection and multi-tier caching
 */
async function getOrFetchIndexedData(forceRefresh = false) {
  const now = Date.now();

  // L1 In-Memory Cache Hit
  if (!forceRefresh && l1IndexedDatabase && (now - l1CacheTime < L1_CACHE_TTL)) {
    return l1IndexedDatabase;
  }

  // Singleflight: reuse running promise to coalesce concurrent incoming calls
  if (activeFetchPromise) {
    return activeFetchPromise;
  }

  activeFetchPromise = (async () => {
    try {
      const defaultNum = await resolveDefaultNum();
      const redis = getRedisClient();
      const redisKey = `cache:edupage:raw:${defaultNum}`;

      // L2 Redis Check (only if L1 expired or missing, and not forcing network refresh)
      if (!forceRefresh && redis) {
        try {
          const cachedJson = await redis.get(redisKey);
          if (cachedJson) {
            const raw = JSON.parse(cachedJson);
            if (raw?.r?.dbiAccessorRes?.tables) {
              l1IndexedDatabase = buildIndexedDatabase(raw, defaultNum);
              l1CacheTime = Date.now();
              return l1IndexedDatabase;
            }
          }
        } catch (redisErr) {
          logger.warn('Redis read failed for EduPage cache, proceeding with network fetch', { error: redisErr.message });
        }
      }

      // Network Fetch from TsUE EduPage
      let raw;
      try {
        raw = await fetchRawTimetable(defaultNum);
      } catch (networkErr) {
        // Stale-While-Revalidate Fallback: Serve stale data if EduPage server is down
        if (l1IndexedDatabase && (now - l1CacheTime < L1_STALE_TTL)) {
          logger.warn('EduPage network request failed; serving stale cache', { error: networkErr.message });
          return l1IndexedDatabase;
        }
        throw networkErr;
      }

      if (!raw?.r?.dbiAccessorRes?.tables) {
        throw new Error('Invalid response structure from EduPage API');
      }

      // Index and cache in L1
      l1IndexedDatabase = buildIndexedDatabase(raw, defaultNum);
      l1CacheTime = Date.now();

      // Async write to L2 Redis
      if (redis) {
        redis.set(redisKey, JSON.stringify(raw), 'EX', REDIS_TTL_SEC).catch(err => {
          logger.warn('Redis write failed for EduPage cache', { error: err.message });
        });
      }

      return l1IndexedDatabase;
    } finally {
      activeFetchPromise = null;
    }
  })();

  return activeFetchPromise;
}

/**
 * Finds class ID using exact match, normalized match, or fuzzy lookup
 */
function findClassId(db, className) {
  if (!className || !db) return null;
  const clean = className.toString().trim();
  const normalized = normalizeGroupName(clean);

  if (db.classesByName.has(clean)) return db.classesByName.get(clean);
  if (db.classesByName.has(normalized)) return db.classesByName.get(normalized);

  // Partial / case-insensitive search
  const cleanUpper = clean.toUpperCase();
  for (const [key, id] of db.classesByName.entries()) {
    if (key.includes(cleanUpper) || key.includes(normalized)) {
      return id;
    }
  }

  return null;
}

/**
 * Formats a weekly schedule object into Telegram HTML text
 */
function formatTimetableText(schedule, dayIdx) {
  if (!schedule || Object.keys(schedule).length === 0) return '❌ Jadval topilmadi.';
  const days = dayIdx !== null ? [dayIdx] : [0, 1, 2, 3, 4, 5];
  const parts = [];

  for (const d of days) {
    const dayLessons = schedule[d];
    if (dayIdx === null) parts.push(`\n📅 <b>${DAY_NAMES[d]}:</b>`);
    if (!dayLessons || Object.keys(dayLessons).length === 0) {
      parts.push(dayIdx === null ? '  — Dars yo\'q' : '📭 Bugun dars yo\'q.');
      continue;
    }

    const periodsSorted = Object.keys(dayLessons).map(Number).sort((a, b) => a - b);
    for (const pNum of periodsSorted) {
      const t = PERIOD_TIMES[pNum];
      const timeStr = t ? ` <i>(${t.start}–${t.end})</i>` : '';
      parts.push(`\n<b>${pNum}-para</b>${timeStr}`);
      for (const l of dayLessons[pNum]) {
        parts.push(`  📖 ${l.subject}\n  👨‍🏫 ${l.teacher}\n  🚪 ${l.room}`);
      }
    }
  }

  return parts.join('\n').trim() || '📭 Dars yo\'q.';
}

/**
 * Retrieves pre-indexed raw weekly schedule object for a class
 */
async function getRawSchedule(className) {
  try {
    const db = await getOrFetchIndexedData();
    const classId = findClassId(db, className);
    if (!classId) return null;
    return db.schedulesByClassId.get(classId) || null;
  } catch (err) {
    logger.error('Error in getRawSchedule', { className, error: err.message });
    return null;
  }
}

/**
 * Retrieves formatted HTML text schedule for a class
 */
async function getFormattedSchedule(className, dayIdx) {
  try {
    const db = await getOrFetchIndexedData();
    const classId = findClassId(db, className);
    if (!classId) {
      return `❌ "<b>${className}</b>" guruhi bo'yicha jadval topilmadi.\n\n💡 Iltimos, /setclass orqali guruhingiz nomini tekshirib qayta kiriting (Masalan: <code>/setclass MI-21</code>).`;
    }

    const schedule = db.schedulesByClassId.get(classId);
    if (!schedule || Object.keys(schedule).length === 0) {
      return '📭 Ushbu guruh uchun darslar kiritilmagan.';
    }

    if (dayIdx !== null && dayIdx !== undefined) {
      return `📅 <b>${DAY_NAMES[dayIdx]} — dars jadvali:</b>\n${formatTimetableText(schedule, dayIdx)}`;
    }
    return formatTimetableText(schedule, null);
  } catch (err) {
    logger.error('Error in getFormattedSchedule', { className, dayIdx, error: err.message });
    return '❌ Jadval ma\'lumotlarini olishda texnik xatolik yuz berdi. Birozdan so\'ng qayta urinib ko\'ring.';
  }
}

/**
 * Backward compatibility parser
 */
function parseSchedule(raw, className) {
  if (!raw?.r?.dbiAccessorRes?.tables) return null;
  const tempDb = buildIndexedDatabase(raw, 'temp');
  const cid = findClassId(tempDb, className);
  return cid ? (tempDb.schedulesByClassId.get(cid) || null) : null;
}

/**
 * Returns empty rooms paginated HTML text pages
 */
async function getEmptyRoomsText(className, dayIdx, periodNum, offsetDays = 0) {
  try {
    const db = await getOrFetchIndexedData();
    const matrixKey = `${dayIdx}:${periodNum}`;
    let emptyRooms = db.emptyRoomsMatrix.get(matrixKey) || [];

    // Building filter support: e.g. "*3" or "*4"
    if (className && className.startsWith('*') && className.length > 1) {
      const binoNum = className.slice(1);
      emptyRooms = emptyRooms.filter(xona => {
        const loc = parseRoomLocation(xona);
        return loc.bino.includes(binoNum);
      });
    }

    if (emptyRooms.length === 0) {
      return [`⚠️ <b>${periodNum}-para</b> uchun barcha xonalar band!`];
    }

    const grouped = {};
    for (const xona of emptyRooms) {
      const { bino, qavat } = parseRoomLocation(xona);
      (grouped[bino] ??= {})[qavat] ??= [];
      grouped[bino][qavat].push(xona);
    }

    const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
    if (offsetDays > 0) tzDate.setDate(tzDate.getDate() + offsetDays);
    const dateStr = `${String(tzDate.getDate()).padStart(2, '0')}.${String(tzDate.getMonth() + 1).padStart(2, '0')}.${tzDate.getFullYear()}`;
    const header = `✅ <b>${dateStr}, ${DAY_NAMES[dayIdx]}</b>\n📚 <b>${periodNum}-para</b> — bo'sh xonalar:\n`;

    const sortedBinos = Object.keys(grouped).sort((a, b) => {
      if (a === 'Asosiy bino') return -1;
      if (b === 'Asosiy bino') return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });

    const pages = [];
    let current = header;
    for (const bino of sortedBinos) {
      let block = `\n🏛 <b>${bino}</b>\n`;
      for (const qavat of Object.keys(grouped[bino]).sort()) {
        const sorted = grouped[bino][qavat].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        block += `  <code>${qavat}:</code>  ${sorted.join('   ')}\n`;
      }
      if (current.length + block.length > 1200) {
        pages.push(current.trimEnd());
        current = `${header}(davomi)\n${block}`;
      } else {
        current += block;
      }
    }
    current = current.trimEnd() + `\n\n<i>Jami: ${emptyRooms.length} ta bo'sh xona</i>`;
    pages.push(current);
    return pages;
  } catch (err) {
    logger.error('Error in getEmptyRoomsText', { className, dayIdx, periodNum, error: err.message });
    return ['❌ Tizimdan bo\'sh xonalarni ajratib olishda xatolik yuz berdi.'];
  }
}

/**
 * Returns all active student group names
 */
async function getAllClassNames() {
  try {
    const db = await getOrFetchIndexedData();
    return db.classNamesList || [];
  } catch {
    return [];
  }
}

/**
 * Pre-warms the schedule cache asynchronously on startup
 */
async function warmUpCache() {
  try {
    logger.info('Pre-warming EduPage schedule cache in background...');
    await getOrFetchIndexedData();
    logger.info('EduPage schedule cache successfully pre-warmed');
  } catch (err) {
    logger.warn('Failed to pre-warm EduPage cache (will retry on first request)', { error: err.message });
  }
}

async function getTimetableData(forceRefresh = false) {
  const db = await getOrFetchIndexedData(forceRefresh);
  return db.raw;
}

async function getIndexedDatabase(forceRefresh = false) {
  return getOrFetchIndexedData(forceRefresh);
}

module.exports = {
  getFormattedSchedule,
  getEmptyRoomsText,
  parseSchedule,
  formatTimetableText,
  getRawSchedule,
  getTimetableData,
  getIndexedDatabase,
  getMetadataSignature,
  getAllClassNames,
  warmUpCache,
  normalizeGroupName,
};