'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const logger = require('../core/logger');

const DISK_CACHE_PATH = path.join(__dirname, '../../data/timetable_cache.json');

const DAY_NAMES = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
const PERIOD_TIMES = {
  1: { start: '08:00', end: '09:20' },
  2: { start: '09:30', end: '10:50' },
  3: { start: '11:00', end: '12:20' },
  4: { start: '13:00', end: '14:20' },
  5: { start: '14:30', end: '15:50' },
  6: { start: '16:00', end: '17:20' },
  7: { start: '17:30', end: '18:50' },
  8: { start: '19:00', end: '20:20' },
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
  timeout: 45000,
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

const CYRILLIC_LOOKALIKES = {
  '\u0410': 'A', '\u0430': 'A', // А, а
  '\u0412': 'B', '\u0432': 'B', // В, в
  '\u0421': 'C', '\u0441': 'C', // С, с
  '\u0415': 'E', '\u0435': 'E', // Е, е
  '\u041D': 'H', '\u043D': 'H', // Н, н
  '\u041A': 'K', '\u043A': 'K', // К, к
  '\u041C': 'M', '\u043C': 'M', // М, м
  '\u041E': 'O', '\u043E': 'O', // О, о
  '\u0420': 'P', '\u0440': 'P', // Р, р
  '\u0422': 'T', '\u0442': 'T', // Т, т
  '\u0425': 'X', '\u0445': 'X', // Х, х
  '\u0423': 'U', '\u0443': 'U', // У, у
  '\u0406': 'I', '\u0456': 'I', // І, і
};

/**
 * Transliterates Cyrillic lookalikes into Latin equivalents
 */
function transliterateCyrillic(str) {
  if (!str) return '';
  return String(str).replace(/[\u0400-\u04FF]/g, (ch) => CYRILLIC_LOOKALIKES[ch] || ch);
}

/**
 * Normalizes a class/group string for fast O(1) hash lookups.
 * Transliterates Cyrillic lookalikes, trims whitespace, strips punctuation/dashes/slashes.
 * e.g. "BHA-51k/24" -> "BHA51K24", "MMТ-20/23" -> "MMT2023", "BHA_51K" -> "BHA51K"
 */
function normalizeGroupName(str) {
  if (!str) return '';
  const transliterated = transliterateCyrillic(String(str));
  const clean = transliterated.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.replace(/^([A-Z0-9]+?)([IRK])(\d{2})$/, '$1$3$2');
}

/**
 * Extracts base group name without graduation year suffix
 * e.g. "BHA-56/24i" -> "BHA-56i", "BHA-51k/24" -> "BHA-51k", "BHA-51/24" -> "BHA-51"
 */
function extractGroupBase(str) {
  if (!str) return '';
  return String(str).replace(/\/(\d{2})([a-z]?)$/i, (m, yr, track) => track || '');
}

// Global Canonical Group Registry: maps normalized & base variants to official canonical names
const canonicalExact = new Map(); // norm -> canonical (e.g. "BHA51K24" -> "BHA-51k/24")
const canonicalBase = new Map();  // baseNorm -> canonical (e.g. "BHA51K" -> "BHA-51k/24")

function registerCanonicalGroup(groupName) {
  if (!groupName || typeof groupName !== 'string') return;
  const clean = groupName.trim();
  if (!clean || clean === '-' || clean === '--' || clean.includes('FAKULTET') || clean.includes('KURS')) return;

  const norm = normalizeGroupName(clean);
  if (norm) {
    if (!canonicalExact.has(norm)) canonicalExact.set(norm, clean);

    const base = extractGroupBase(clean);
    const baseNorm = normalizeGroupName(base);
    if (baseNorm && !canonicalBase.has(baseNorm)) {
      canonicalBase.set(baseNorm, clean);
    }
  }
}

// Pre-seed canonical registry from groups.json if available
try {
  const groupsJsonPath = path.join(__dirname, '../data/groups.json');
  if (fs.existsSync(groupsJsonPath)) {
    const rawArr = JSON.parse(fs.readFileSync(groupsJsonPath, 'utf8'));
    for (const g of rawArr) {
      registerCanonicalGroup(g);
    }
  }
} catch (e) {
  logger.debug('Failed to pre-seed groups from groups.json:', { error: e.message });
}

function getLevenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1] ? matrix[i - 1][j - 1] : Math.min(matrix[i - 1][j - 1], matrix[i][j - 1], matrix[i - 1][j]) + 1;
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Resolves ANY group input (e.g. "BHA_51K", "bha-51k", "bha 51k", "BHA-51k/24", "MMT-20")
 * to its exact official CANONICAL original appearance ("asli ko'rinishi", e.g. "BHA-51k/24").
 * Returns null if not recognized.
 */
function getCanonicalGroupName(input) {
  if (!input) return null;
  const clean = input.toString().trim().replace(/^[*#]/, '');
  const norm = normalizeGroupName(clean);
  if (!norm) return null;

  // 1. Exact normalized match (e.g. "BHA51K24", "BHA-51k/24")
  if (canonicalExact.has(norm)) {
    return canonicalExact.get(norm);
  }

  // 2. Base match without year suffix (e.g. "BHA_51K", "BHA-51k", "bha 51k")
  if (canonicalBase.has(norm)) {
    return canonicalBase.get(norm);
  }
  const base = extractGroupBase(clean);
  const baseNorm = normalizeGroupName(base);
  if (baseNorm && canonicalBase.has(baseNorm)) {
    return canonicalBase.get(baseNorm);
  }

  // 3. Fallback: prefix match among valid groups (only if norm is at least 4 chars)
  if (norm.length >= 4) {
    for (const [n, canonical] of canonicalExact.entries()) {
      if (n.startsWith(norm)) {
        return canonical;
      }
    }
  }

  const normDigits = (norm.match(/\d+/g) || []).join('');

  // 4. Fallback: fuzzy typo match (Levenshtein distance <= 2)
  let best = null;
  let minDist = Infinity;
  for (const [n, canonical] of canonicalExact.entries()) {
    if (Math.abs(n.length - norm.length) > 1) continue;
    // Guard: digits must match if present to prevent cross-group number matching (e.g., 56 vs 50)
    const nDigits = (n.match(/\d+/g) || []).join('');
    if (normDigits && nDigits && normDigits !== nDigits) continue;

    const d = getLevenshteinDistance(norm, n);
    if (d < minDist) {
      minDist = d;
      best = canonical;
    }
  }
  if (minDist <= 2) return best;

  return null;
}

/**
 * Escapes characters for Telegram HTML parse_mode
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  const clean = (xona || '').trim();
  const bochkaMatch = clean.match(/^(\d+)-bochka/i);
  if (bochkaMatch) return { bino: `${bochkaMatch[1]}-bochka`, qavat: '1-qavat' };

  const multiSlashMatch = clean.match(/^(\d+)\/+(\d+)/);
  if (multiSlashMatch) {
    const bNum = multiSlashMatch[1];
    return { bino: bNum === '1' ? '4-bino' : `${bNum}-bino`, qavat: `${multiSlashMatch[2].charAt(0)}-qavat` };
  }

  const dashMatch = clean.match(/^(\d+)-.*?(\d)(\d{2})/);
  if (dashMatch) return { bino: `${dashMatch[1]}-bino`, qavat: `${dashMatch[2]}-qavat` };

  const normalMatch = clean.match(/^(\d)(\d{2})/);
  if (normalMatch) return { bino: 'Asosiy bino', qavat: `${normalMatch[1]}-qavat` };

  return { bino: 'Asosiy bino', qavat: `${clean.charAt(0) || '1'}-qavat` };
}

/**
 * Resolves all university campus buildings where a class/group has scheduled lessons
 * @param {string} className Group name (e.g. "BHA-51k/24")
 * @returns {Promise<string[]>} Array of building names, e.g. ["1-bochka", "13-bino", "14-bino"]
 */
async function getGroupBuildings(className) {
  if (!className) return [];
  try {
    const canonical = getCanonicalGroupName(className) || className;
    const schedule = await getRawSchedule(canonical);
    if (!schedule) return [];

    const binos = new Set();
    for (let d = 0; d < 6; d++) {
      if (!schedule[d]) continue;
      for (const p of Object.keys(schedule[d])) {
        const lessons = schedule[d][p];
        if (!Array.isArray(lessons)) continue;
        for (const l of lessons) {
          if (l.room && l.room !== '?' && !l.room.toLowerCase().includes('online')) {
            const loc = parseRoomLocation(l.room);
            if (loc && loc.bino) binos.add(loc.bino);
          }
        }
      }
    }

    return Array.from(binos).sort((a, b) => {
      if (a === 'Asosiy bino') return -1;
      if (b === 'Asosiy bino') return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
  } catch (err) {
    logger.warn('Failed to resolve group buildings', { className, error: err.message });
    return [];
  }
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
      registerCanonicalGroup(cName);
      classesByName.set(normalizeGroupName(cName), c.id);
      classesByName.set(cName.toUpperCase(), c.id);
      classesByName.set(cName, c.id);
      const base = extractGroupBase(cName);
      if (base) {
        classesByName.set(normalizeGroupName(base), c.id);
      }
    }
    if (cShort) {
      registerCanonicalGroup(cShort);
      classesByName.set(normalizeGroupName(cShort), c.id);
      classesByName.set(cShort.toUpperCase(), c.id);
      classesByName.set(cShort, c.id);
      const base = extractGroupBase(cShort);
      if (base) {
        classesByName.set(normalizeGroupName(base), c.id);
      }
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

async function saveDiskCache(raw) {
  try {
    const tmpPath = `${DISK_CACHE_PATH}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(raw), 'utf8');
    await fs.promises.rename(tmpPath, DISK_CACHE_PATH);
  } catch (err) {
    logger.warn('Failed to atomically write EduPage L3 Disk Cache', { error: err.message });
  }
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
        // Fallback 1: Stale-While-Revalidate Memory Cache
        if (l1IndexedDatabase && (now - l1CacheTime < L1_STALE_TTL)) {
          logger.warn('EduPage network request failed; serving stale memory cache', { error: networkErr.message });
          return l1IndexedDatabase;
        }

        // Fallback 2: L3 Disk Cache (guarantees survival through process restarts & server downtime)
        try {
          if (fs.existsSync(DISK_CACHE_PATH)) {
            const diskRaw = JSON.parse(await fs.promises.readFile(DISK_CACHE_PATH, 'utf8'));
            if (diskRaw?.r?.dbiAccessorRes?.tables) {
              logger.warn('EduPage network request failed; restored from L3 Disk Cache', { error: networkErr.message });
              l1IndexedDatabase = buildIndexedDatabase(diskRaw, defaultNum);
              l1CacheTime = Date.now();
              return l1IndexedDatabase;
            }
          }
        } catch (diskErr) {
          logger.error('Failed to read L3 Disk Cache', { error: diskErr.message });
        }

        throw networkErr;
      }

      if (!raw?.r?.dbiAccessorRes?.tables) {
        throw new Error('Invalid response structure from EduPage API');
      }

      // Index and cache in L1
      l1IndexedDatabase = buildIndexedDatabase(raw, defaultNum);
      l1CacheTime = Date.now();

      // Async atomic write to L3 Disk Cache (guarantees zero corruption across reboots)
      saveDiskCache(raw).catch(() => {});

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
  const canonical = getCanonicalGroupName(clean);
  const normalized = normalizeGroupName(canonical || clean);

  // 1. Exact canonical & clean checks
  if (canonical && db.classesByName.has(canonical)) return db.classesByName.get(canonical);
  if (db.classesByName.has(clean)) return db.classesByName.get(clean);
  if (db.classesByName.has(normalized)) return db.classesByName.get(normalized);

  const rawNorm = normalizeGroupName(clean);
  if (db.classesByName.has(rawNorm)) return db.classesByName.get(rawNorm);

  // 2. Base match check
  const base = extractGroupBase(canonical || clean);
  const baseNorm = normalizeGroupName(base);
  if (baseNorm && db.classesByName.has(baseNorm)) return db.classesByName.get(baseNorm);

  // 3. Fallback: exact uppercase search
  const cleanUpper = clean.toUpperCase();
  for (const [key, id] of db.classesByName.entries()) {
    if (key === cleanUpper || key === normalized) {
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
    if (dayIdx === null) parts.push(`\n📅 <b>${DAY_NAMES[d] || 'Noma\'lum kun'}:</b>`);
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
        const cleanSubj = escapeHtml(l.subject || 'Noma\'lum fan');
        const cleanTeacher = escapeHtml(l.teacher || '?');
        const cleanRoom = escapeHtml(l.room || '?');
        parts.push(`  📖 ${cleanSubj}\n  👨‍🏫 ${cleanTeacher}\n  🚪 ${cleanRoom}`);
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
      const safeClass = escapeHtml(className);
      return `❌ "<b>${safeClass}</b>" guruhi bo'yicha jadval topilmadi.\n\n💡 Iltimos, /setclass orqali guruhingiz nomini tekshirib qayta kiriting (Masalan: <code>/setclass MI-15</code>).`;
    }

    const schedule = db.schedulesByClassId.get(classId);
    if (!schedule || Object.keys(schedule).length === 0) {
      return '📭 Ushbu guruh uchun darslar kiritilmagan.';
    }

    if (dayIdx !== null && dayIdx !== undefined) {
      const safeDay = Math.max(0, Math.min(5, Number(dayIdx) || 0));
      return `📅 <b>${DAY_NAMES[safeDay]} — dars jadvali:</b>\n${formatTimetableText(schedule, safeDay)}`;
    }
    return formatTimetableText(schedule, null);
  } catch (err) {
    logger.error('Error in getFormattedSchedule', { className, dayIdx, error: err.message, stack: err.stack });
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
async function getEmptyRoomsText(className, dayIdx, periodNum, offsetDays = 0, binoFilter = null, timeMode = null) {
  try {
    const db = await getOrFetchIndexedData();
    const matrixKey = `${dayIdx}:${periodNum}`;
    let emptyRooms = db.emptyRoomsMatrix.get(matrixKey) || [];

    let studentBinos = [];
    if (className) {
      studentBinos = await getGroupBuildings(className);
    }

    // Building filter support: 'my' (student's buildings), explicit binoFilter, or "*3" prefix
    if (binoFilter === 'my') {
      if (studentBinos.length > 0) {
        const binoSet = new Set(studentBinos.map(b => b.toLowerCase()));
        emptyRooms = emptyRooms.filter(xona => {
          const loc = parseRoomLocation(xona);
          return binoSet.has(loc.bino.toLowerCase());
        });
      } else {
        emptyRooms = [];
      }
    } else if (binoFilter && binoFilter !== 'all') {
      const cleanFilter = binoFilter.toLowerCase();
      emptyRooms = emptyRooms.filter(xona => {
        const loc = parseRoomLocation(xona);
        const bName = loc.bino.toLowerCase();
        if (cleanFilter === 'asosiy') return bName.includes('asosiy');
        if (cleanFilter.endsWith('-bochka') || cleanFilter.endsWith('-bino')) {
          return bName === cleanFilter;
        }
        return bName === `${cleanFilter}-bino` || bName.includes(cleanFilter);
      });
    } else if (className && className.startsWith('*') && className.length > 1) {
      const binoNum = className.slice(1);
      emptyRooms = emptyRooms.filter(xona => {
        const loc = parseRoomLocation(xona);
        return loc.bino.includes(binoNum);
      });
    }

    if (emptyRooms.length === 0) {
      if (binoFilter === 'my') {
        if (studentBinos.length > 0) {
          return [`⚠️ <b>${periodNum}-para</b> uchun guruhingiz binolarida (<i>${escapeHtml(studentBinos.join(', '))}</i>) bo'sh xonalar topilmadi!`];
        }
        return [`⚠️ <b>${escapeHtml(className || '')}</b> guruhi jadvalida bino xonalari belgilanmagan.`];
      }
      return [`⚠️ <b>${periodNum}-para</b> uchun tanlangan binoda barcha xonalar band!`];
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
    const pTime = PERIOD_TIMES[periodNum] ? ` (${PERIOD_TIMES[periodNum].start}–${PERIOD_TIMES[periodNum].end})` : '';

    let header = '';
    if (timeMode === 'now') {
      header = `⚡️ <b>Hozirgi para: ${periodNum}-para${pTime}</b>\n📅 <b>${dateStr}, ${DAY_NAMES[dayIdx]}</b>\n`;
    } else if (timeMode === 'next') {
      header = `⏭️ <b>Keyingi para: ${periodNum}-para${pTime}</b>\n📅 <b>${dateStr}, ${DAY_NAMES[dayIdx]}</b>\n`;
    } else {
      header = `✅ <b>${dateStr}, ${DAY_NAMES[dayIdx]}</b>\n📚 <b>${periodNum}-para${pTime}</b> — bo'sh xonalar:\n`;
    }

    if (binoFilter === 'my' && studentBinos.length > 0) {
      header += `🎓 <b>Mening binolarim:</b> <i>${escapeHtml(studentBinos.join(', '))}</i>\n`;
    }

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
    // 1. Instant 0ms boot from L3 Disk Cache if available
    if (!l1IndexedDatabase && fs.existsSync(DISK_CACHE_PATH)) {
      try {
        const diskRaw = JSON.parse(await fs.promises.readFile(DISK_CACHE_PATH, 'utf8'));
        if (diskRaw?.r?.dbiAccessorRes?.tables) {
          l1IndexedDatabase = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || FALLBACK_DEFAULT_NUM);
          l1CacheTime = Date.now();
          logger.info('EduPage schedule cache instantly restored from L3 Disk Cache', {
            classesCount: l1IndexedDatabase.schedulesByClassId.size,
          });
        }
      } catch (diskErr) {
        logger.warn('Failed to read initial L3 Disk Cache', { error: diskErr.message });
      }
    }

    // 2. Fetch fresh from network / Redis in background
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
  getCanonicalGroupName,
  extractGroupBase,
  getGroupBuildings,
  parseRoomLocation,
};