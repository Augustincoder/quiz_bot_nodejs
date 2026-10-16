'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const util = require('util');
const crypto = require('crypto');
const gunzipAsync = util.promisify(zlib.gunzip);
const inflateAsync = util.promisify(zlib.inflate);
const logger = require('../core/logger');

function resolveDiskCachePath() {
  const rootDataPath = path.resolve(__dirname, '../../data/timetable_cache.json');
  if (fs.existsSync(rootDataPath)) return rootDataPath;
  const localSrcPath = path.resolve(__dirname, '../data/timetable_cache.json');
  if (fs.existsSync(localSrcPath)) return localSrcPath;
  return rootDataPath;
}
const DISK_CACHE_PATH = resolveDiskCachePath();

const DAY_NAMES = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba', 'Yakshanba'];
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
const L1_CACHE_TTL = 3 * 60 * 1000; // 3 minutes fresh (aligned with 3-minute schedule watcher)
const L1_STALE_TTL = 24 * 60 * 60 * 1000; // 24 hours stale fallback
const DEFAULT_NUM_TTL = 12 * 60 * 60 * 1000; // 12 hours
const REDIS_TTL_SEC = 10 * 60; // 10 minutes in Redis (prevents stale schedule persistence across syncs)

// Keep-alive agent to reuse TCP/TLS sockets and minimize connection latency
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 8,
  maxFreeSockets: 2,
  keepAliveMsecs: 4000, // 4s: safely lower than EduPage Apache server's 10-second keep-alive timeout
  timeout: 30000,
});

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Encoding': 'gzip, deflate',
  'Accept-Language': 'uz,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Origin': 'https://tsue.edupage.org',
  'Referer': 'https://tsue.edupage.org/timetable/',
  'Connection': 'keep-alive',
};

// Internal cache state
let cachedDefaultNum = FALLBACK_DEFAULT_NUM;
let cachedDefaultNumTime = Date.now();

let l1IndexedDatabase = null;
let l1CacheTime = 0;
let lastRawTimetableHash = null;

// Singleflight Mutex: collapses concurrent callers into a single network fetch
let activeFetchPromise = null;
let activeFetchPromiseIsForced = false;

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
  return clean.replace(/^([A-Z]+\d+)([IRK])(\d{2})$/, '$1$3$2');
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
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const bLen = b.length;
  let prevRow = new Int32Array(bLen + 1);
  let currRow = new Int32Array(bLen + 1);

  for (let j = 0; j <= bLen; j++) {
    prevRow[j] = j;
  }

  for (let i = 1; i <= a.length; i++) {
    currRow[0] = i;
    const charA = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j++) {
      const cost = charA === b.charCodeAt(j - 1) ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,
        currRow[j - 1] + 1,
        prevRow[j - 1] + cost
      );
    }
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }
  return prevRow[bLen];
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

  // 3b. Suffix match on base names: e.g. "56i" -> matches "BHA56I" -> "BHA-56/24i"
  if (norm.length >= 2 && /\d/.test(norm)) {
    const suffixMatches = [];
    for (const [baseNorm, canonical] of canonicalBase.entries()) {
      if (baseNorm.endsWith(norm)) {
        suffixMatches.push(canonical);
      }
    }
    if (suffixMatches.length === 1) {
      return suffixMatches[0];
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
function httpPost(path, payload, timeoutMs = 45000) {
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
      // Guard: Non-2xx HTTP status codes (e.g. 502 Bad Gateway, 503 Maintenance, 403 Cloudflare)
      if (res.statusCode < 200 || res.statusCode >= 300) {
        if (!isSettled) {
          isSettled = true;
          clearTimeout(timer);
          res.resume(); // Drain stream to release TCP socket back to agent pool
          reject(new Error(`EduPage HTTP error ${res.statusCode}: ${res.statusMessage || 'Unknown'}`));
        }
        return;
      }

      const chunks = [];
      res.on('data', chunk => { chunks.push(chunk); });
      res.on('error', (streamErr) => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        reject(streamErr);
      });
      res.on('end', async () => {
        if (isSettled) return;
        isSettled = true;
        clearTimeout(timer);
        try {
          let buffer = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          if (encoding === 'gzip') {
            buffer = await gunzipAsync(buffer);
          } else if (encoding === 'deflate') {
            buffer = await inflateAsync(buffer);
          }

          // Ultra-fast zero-allocation check for regularttGetData:
          // If uncompressed payload hash is byte-for-byte identical to the last fetch,
          // and l1IndexedDatabase is loaded, skip JSON.parse and heap allocation entirely!
          if (path.includes('regularttGetData')) {
            const rawHash = crypto.createHash('md5').update(buffer).digest('hex');
            if (lastRawTimetableHash && rawHash === lastRawTimetableHash && l1IndexedDatabase) {
              resolve({ __isUnchanged: true, _rawHash: rawHash });
              return;
            }
          }

          const text = buffer.toString('utf8');
          if (!text || text.trim().length === 0) {
            throw new Error('Empty response body received from EduPage');
          }
          const json = JSON.parse(text);
          if (path.includes('regularttGetData') && typeof json === 'object' && json !== null) {
            const rawHash = crypto.createHash('md5').update(buffer).digest('hex');
            json._rawHash = rawHash;
          }
          resolve(json);
        } catch (e) {
          reject(new Error(`JSON parse failed for EduPage response: ${e.message}`));
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

  // Fast return fallback if circuit breaker is open (prevents 15s timeout during outages)
  if (!canAttemptEduPageNetwork()) {
    return cachedDefaultNum || FALLBACK_DEFAULT_NUM;
  }

  try {
    const currentYear = new Date().getFullYear();
    const payload = { __args: [null, currentYear], __gsh: '00000000' };
    const res = await fetchWithRetry(
      () => httpPost('/timetable/server/ttviewer.js?__func=getTTViewerData', payload, 15000),
      1,
      500
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
      fallback: cachedDefaultNum || FALLBACK_DEFAULT_NUM,
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

const roomLocationCache = new Map();
/**
 * Parses building and floor information from classroom code
 */
function parseRoomLocation(xona) {
  let clean = (xona || '').trim();
  if (!clean || clean === '?' || clean === '-' || clean === '--' || clean === '---') return null;
  if (/online/i.test(clean)) return null;

  clean = transliterateCyrillic(clean);

  const cached = roomLocationCache.get(clean);
  if (cached !== undefined) return cached;
  if (roomLocationCache.size > 1000) roomLocationCache.clear();

  let res = null;

  const bochkaMatch = clean.match(/^(\d+)-bochka/i);
  if (bochkaMatch) {
    const qMatch = clean.match(/(\d)\d{2}/);
    res = { bino: `${bochkaMatch[1]}-bochka`, qavat: `${qMatch ? qMatch[1] : '1'}-qavat` };
  } else {
    // e.g. 4-bino Test markazi 1-30, 2-bino/210, etc.
    const binoPrefixMatch = clean.match(/^(\d+)-bino/i);
    if (binoPrefixMatch) {
      const qMatch = clean.match(/(\d)(?:\d{2}|-\d+)/);
      res = { bino: `${binoPrefixMatch[1]}-bino`, qavat: `${qMatch ? qMatch[1] : '1'}-qavat` };
    } else {
      // e.g. 1/111, 4//1-250, 7/labaratoriya, 2/leksionniy-1
      const slashMatch = clean.match(/^(\d+)\/+(.*)/);
      if (slashMatch) {
        const bNum = slashMatch[1];
        const bino = bNum === '1' ? '4-bino' : `${bNum}-bino`;
        const rest = slashMatch[2];
        const qMatch = rest.match(/(\d)(?:\d{2}|-\d+)/) || rest.match(/(\d)/);
        const qNum = qMatch ? qMatch[1] : '1';
        res = { bino, qavat: `${qNum || '1'}-qavat` };
      } else {
        // e.g. 204-A, 301-B (3-digit room followed by letter building)
        const roomLetterMatch = clean.match(/^(\d)(\d{2})[-\s]*([A-Za-z])$/);
        if (roomLetterMatch) {
          res = { bino: `${roomLetterMatch[3].toUpperCase()}-bino`, qavat: `${roomLetterMatch[1]}-qavat` };
        } else {
          // e.g. 8-101, 8-201-68, 2-M2
          const dashMatch = clean.match(/^(\d+)-(.*)/);
          if (dashMatch) {
            const bNum = dashMatch[1];
            const rest = dashMatch[2];
            const qMatch = rest.match(/(\d)(?:\d{2}|-\d+)/) || rest.match(/(\d)/);
            const qNum = qMatch ? qMatch[1] : '1';
            res = { bino: `${bNum}-bino`, qavat: `${qNum || '1'}-qavat` };
          } else {
            // e.g. A-204, B-301
            const letterDashMatch = clean.match(/^([A-Za-z])-(\d)(?:\d{2}|-\d+)/);
            if (letterDashMatch) {
              res = { bino: `${letterDashMatch[1].toUpperCase()}-bino`, qavat: `${letterDashMatch[2]}-qavat` };
            } else {
              // e.g. B bino 301
              const letterBinoMatch = clean.match(/^([A-Za-z])\s*bino\s*(\d)(?:\d{2}|-\d+)/i);
              if (letterBinoMatch) {
                res = { bino: `${letterBinoMatch[1].toUpperCase()}-bino`, qavat: `${letterBinoMatch[2]}-qavat` };
              } else {
                // e.g. 1 korpus 211 xona
                const korpusMatch = clean.match(/^(\d+)\s*korpus\s*(\d)(\d{2})/i);
                if (korpusMatch) {
                  const bNum = korpusMatch[1] === '1' ? '4-bino' : `${korpusMatch[1]}-bino`;
                  res = { bino: bNum, qavat: `${korpusMatch[2]}-qavat` };
                } else if (/^litsey/i.test(clean)) {
                  const qMatch = clean.match(/(\d)[A-Za-z]/);
                  res = { bino: 'Litsey', qavat: `${qMatch ? qMatch[1] : '1'}-qavat` };
                } else if (/rektorat/i.test(clean) || /1[24]etaj/i.test(clean) || /xitoy\s*tili/i.test(clean)) {
                  const qMatch = clean.match(/(\d+)/);
                  res = { bino: 'Rektorat', qavat: `${qMatch ? qMatch[1] : '1'}-qavat` };
                } else if (/sport\s*zal/i.test(clean)) {
                  res = { bino: 'Sportzal', qavat: '1-qavat' };
                } else if (/asosiy/i.test(clean)) {
                  res = { bino: 'Asosiy bino', qavat: `${clean.charAt(0) || '1'}-qavat` };
                }
              }
            }
          }
        }
      }
    }
  }

  roomLocationCache.set(clean, res);
  return res;
}

/**
 * Resolves all university campus buildings where a class/group has scheduled lessons
 * @param {string} className Group name (e.g. "BHA-51k/24")
 * @returns {Promise<string[]>} Array of building names, e.g. ["1-bochka", "13-bino", "14-bino"]
 */
async function getGroupBuildings(className) {
  if (!className) return [];
  try {
    const db = await getOrFetchIndexedData();
    if (db && db.buildingsByClassId) {
      const classId = findClassId(db, className);
      if (classId && db.buildingsByClassId.has(classId)) {
        return db.buildingsByClassId.get(classId);
      }
    }

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
            for (const r of l.room.split(',')) {
              const loc = parseRoomLocation(r.trim());
              if (loc && loc.bino) binos.add(loc.bino);
            }
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
  const rawGroups = findRows('groups');
  const groupMap = Object.fromEntries(rawGroups.map(g => [g.id, g]));
  const lessonMap = Object.fromEntries(findRows('lessons').map(l => [l.id, l]));
  const cards = findRows('cards');

  // Defense-in-depth: Reject incomplete datasets (e.g. maintenance pages, partial API responses)
  if (rawClasses.length < 50 || cards.length < 100) {
    throw new Error(`Incomplete EduPage dataset: classes=${rawClasses.length}, cards=${cards.length}`);
  }

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

    // Handle durationperiods (Bug 19): 2-period / 3-period lessons
    const duration = parseInt(card.durationperiods || lesson.durationperiods || 1, 10) || 1;

    // Handle weeks bitmask (Bug 27): "10" (odd / toq), "01" (even / juft), "11" or "" (all)
    const weeksBitmask = (card.weeks || lesson.weeks || '').trim();
    let weekParity = 'all';
    if (weeksBitmask === '10') weekParity = 'toq';
    else if (weeksBitmask === '01') weekParity = 'juft';

    // Subgroup resolution (Bug 20)
    let subgroupName = '';
    if (Array.isArray(lesson.groupids) && lesson.groupids.length > 0) {
      const parts = lesson.groupids
        .map(gid => groupMap[gid])
        .filter(g => g && !g.entireclass && g.name && !/весь класс|butun/i.test(g.name))
        .map(g => g.name);
      if (parts.length > 0) subgroupName = parts.join(', ');
    } else if (Array.isArray(lesson.groupnames) && lesson.groupnames.length > 0) {
      subgroupName = lesson.groupnames.join(', ');
    }

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

        for (let offset = 0; offset < duration; offset++) {
          const currentP = pNum + offset;
          if (currentP > 8) break;

          classSchedule[d][currentP] = classSchedule[d][currentP] || [];

          const subjData = subjects[lesson.subjectid] || { name: '?', color: '#CCCCCC', weight: 1 };
          classSchedule[d][currentP].push({
            subject: subjData.name,
            color: subjData.color,
            weight: subjData.weight,
            teacher: (lesson.teacherids || []).filter(Boolean).map(t => teachers[t] || t).join(', ') || '?',
            room: (card.classroomids || []).filter(Boolean).map(r => rooms[r] || r).join(', ') || '?',
            subgroup: subgroupName,
            weekParity,
            weeks: weeksBitmask,
            duration,
            isContinuation: offset > 0,
          });
        }
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

  // Pre-index building locations per class
  const buildingsByClassId = new Map();
  schedulesByClassId.forEach((classSchedule, cid) => {
    const binos = new Set();
    for (let d = 0; d < 6; d++) {
      if (!classSchedule[d]) continue;
      for (const p of Object.keys(classSchedule[d])) {
        const lessons = classSchedule[d][p];
        if (!Array.isArray(lessons)) continue;
        for (const l of lessons) {
          if (l.room && l.room !== '?' && !l.room.toLowerCase().includes('online')) {
            for (const r of l.room.split(',')) {
              const loc = parseRoomLocation(r.trim());
              if (loc && loc.bino) binos.add(loc.bino);
            }
          }
        }
      }
    }
    const sorted = Array.from(binos).sort((a, b) => {
      if (a === 'Asosiy bino') return -1;
      if (b === 'Asosiy bino') return 1;
      return a.localeCompare(b, undefined, { numeric: true });
    });
    buildingsByClassId.set(cid, sorted);
  });

  // Pre-index empty rooms matrix for all 6 days * 8 periods (48 slots)
  const occupiedBySlot = new Map();
  for (const card of cards) {
    const daysStr = card.days || '';
    const pObj = periods[card.period];
    if (!pObj) continue;
    const pNum = parseInt(pObj.period, 10);
    if (Number.isNaN(pNum) || pNum < 1 || pNum > 8) continue;
    const roomIds = card.classroomids || [];
    if (roomIds.length === 0) continue;

    const lesson = lessonMap[card.lessonid];
    const duration = parseInt(card.durationperiods || lesson?.durationperiods || 1, 10) || 1;

    for (let d = 0; d < 6; d++) {
      if (daysStr[d] === '1') {
        for (let offset = 0; offset < duration; offset++) {
          const currentP = pNum + offset;
          if (currentP > 8) break;
          const key = `${d}:${currentP}`;
          let set = occupiedBySlot.get(key);
          if (!set) {
            set = new Set();
            occupiedBySlot.set(key, set);
          }
          for (const rid of roomIds) set.add(rid);
        }
      }
    }
  }

  const roomEntries = Object.entries(rooms).filter(([, name]) => parseRoomLocation(name) !== null);
  const emptyRoomsMatrix = new Map();
  for (let d = 0; d < 6; d++) {
    for (let p = 1; p <= 8; p++) {
      const key = `${d}:${p}`;
      const occupied = occupiedBySlot.get(key);
      const empty = roomEntries
        .filter(([id]) => !occupied || !occupied.has(id))
        .map(([, name]) => name.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
      emptyRoomsMatrix.set(key, empty);
    }
  }

  logger.info('EduPage database successfully indexed', {
    defaultNum,
    classesCount: schedulesByClassId.size,
    emptySlotsIndexed: emptyRoomsMatrix.size,
    indexingTimeMs: Date.now() - t0,
  });

  if (global.gc) {
    try { global.gc(); } catch {}
  }

  return {
    raw: null, // Freed from heap memory; available on-demand from disk cache/Redis
    defaultNum,
    fetchedAt: Date.now(),
    classesById,
    classesByName,
    classNamesList,
    schedulesByClassId,
    buildingsByClassId,
    emptyRoomsMatrix,
    _cardCount: cards.length,
    _classCount: rawClasses.length,
    _lessonCount: Object.keys(lessonMap).length,
  };
}

// ─── EduPage Circuit Breaker ──────────────────────────────────
let circuitBreakerState = 'CLOSED'; // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
let consecutiveFailures = 0;
let nextCircuitRetryTime = 0;
let isHalfOpenProbeInFlight = false;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_RESET_TIMEOUT_MS = 45000; // 45 seconds

function recordEduPageFailure(err) {
  consecutiveFailures++;
  isHalfOpenProbeInFlight = false;
  if (consecutiveFailures >= FAILURE_THRESHOLD || circuitBreakerState === 'HALF_OPEN') {
    circuitBreakerState = 'OPEN';
    nextCircuitRetryTime = Date.now() + CIRCUIT_RESET_TIMEOUT_MS;
    logger.warn(`⚡ EduPage Circuit Breaker tripped to OPEN (${consecutiveFailures} consecutive failures, previous state: ${circuitBreakerState}). Fast-failing network calls for 45s.`, { error: err?.message });
  }
}

function recordEduPageSuccess() {
  if (circuitBreakerState !== 'CLOSED') {
    logger.info('✅ EduPage Circuit Breaker recovered and reset to CLOSED.');
  }
  circuitBreakerState = 'CLOSED';
  consecutiveFailures = 0;
  nextCircuitRetryTime = 0;
  isHalfOpenProbeInFlight = false;
}

function canAttemptEduPageNetwork() {
  if (circuitBreakerState === 'CLOSED') return true;
  if (circuitBreakerState === 'OPEN') {
    if (Date.now() >= nextCircuitRetryTime) {
      circuitBreakerState = 'HALF_OPEN';
      isHalfOpenProbeInFlight = true;
      logger.info('🔄 EduPage Circuit Breaker testing recovery (HALF_OPEN probe request)...');
      return true;
    }
    return false;
  }
  // When in HALF_OPEN, throttle concurrent requests to exactly 1 probe in flight
  if (circuitBreakerState === 'HALF_OPEN') {
    if (!isHalfOpenProbeInFlight) {
      isHalfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }
  return true;
}

/**
 * Fetches raw timetable JSON from TsUE EduPage (single attempt, fail-fast to cache)
 */
async function fetchRawTimetable(defaultNum) {
  const payload = { __args: [null, defaultNum.toString()], __gsh: '00000000' };
  return httpPost('/timetable/server/regulartt.js?__func=regularttGetData', payload, 45000);
}

/**
 * Senior-Grade Sanity Guard: Validates that live EduPage payload is structurally complete
 * and has not dropped more than 50% of classes/cards compared to previous cache.
 */
function validateTimetablePayload(newData, oldDataOrDb = null) {
  if (!newData || typeof newData !== 'object') return false;

  const tables = newData?.r?.dbiAccessorRes?.tables;
  if (!Array.isArray(tables) || tables.length < 5) return false;

  const findRows = (tid) => tables.find((t) => t.id === tid)?.data_rows ?? [];
  const classes = findRows('classes');
  const lessons = findRows('lessons');
  const cards = findRows('cards');

  // Defense-in-depth: Minimum viable dataset thresholds
  if (classes.length < 50 || cards.length < 100 || lessons.length < 50) {
    logger.warn(`validateTimetablePayload failed: classes=${classes.length}, cards=${cards.length}, lessons=${lessons.length}`);
    return false;
  }

  // Relative drop check against previous snapshot (if oldData/oldDb exists)
  let prevCardCount = 0;
  if (oldDataOrDb?._cardCount) {
    prevCardCount = oldDataOrDb._cardCount;
  } else if (oldDataOrDb?.r?.dbiAccessorRes?.tables) {
    const oldTables = oldDataOrDb.r.dbiAccessorRes.tables;
    const oldCards = oldTables.find((t) => t.id === 'cards')?.data_rows ?? [];
    prevCardCount = oldCards.length;
  }

  if (prevCardCount > 50 && cards.length < prevCardCount * 0.5) {
    logger.warn(`validateTimetablePayload rejected partial dataset: prevCards=${prevCardCount}, newCards=${cards.length} (< 50% threshold)`);
    return false;
  }

  return true;
}

/**
 * POSIX Atomic File Writer with Windows-resilient rename fallback & automatic .bak rotation
 */
async function saveTimetableCacheAtomically(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  const bakPath = `${filePath}.bak`;
  const serialized = typeof data === 'string' ? data : JSON.stringify(data);

  try {
    await fs.promises.writeFile(tmpPath, serialized, 'utf8');
    if (fs.existsSync(filePath)) {
      await fs.promises.copyFile(filePath, bakPath).catch(() => {});
    }
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (renameErr) {
      // Windows fallback if target file is locked or cross-device
      if (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST' || renameErr.code === 'EBUSY') {
        await fs.promises.copyFile(tmpPath, filePath);
        await fs.promises.unlink(tmpPath).catch(() => {});
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    logger.warn('Failed to atomically write cache file', { path: filePath, error: err.message });
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

async function saveDiskCache(raw) {
  if (!raw?.r?.dbiAccessorRes?.tables || !Array.isArray(raw.r.dbiAccessorRes.tables) || raw.r.dbiAccessorRes.tables.length < 5) {
    logger.warn('saveDiskCache aborted: invalid or incomplete raw structure');
    return;
  }
  if (!validateTimetablePayload(raw)) {
    logger.warn('saveDiskCache aborted: payload failed validateTimetablePayload sanity check');
    return;
  }
  await saveTimetableCacheAtomically(DISK_CACHE_PATH, raw).catch((err) => {
    logger.warn('Failed to save EduPage L3 Disk Cache', { error: err.message });
  });
}

async function readDiskCacheSafe() {
  const candidates = [
    DISK_CACHE_PATH,
    `${DISK_CACHE_PATH}.bak`,
    path.resolve(__dirname, '../data/timetable_cache.json'),
    path.resolve(__dirname, '../../data/timetable_cache.json'),
  ];
  const checked = new Set();
  for (const candidate of candidates) {
    if (checked.has(candidate)) continue;
    checked.add(candidate);
    if (fs.existsSync(candidate)) {
      try {
        const content = await fs.promises.readFile(candidate, 'utf8');
        if (!content || content.length < 100) continue;
        const parsed = JSON.parse(content);
        if (parsed?.r?.dbiAccessorRes?.tables && Array.isArray(parsed.r.dbiAccessorRes.tables) && parsed.r.dbiAccessorRes.tables.length >= 5) {
          return parsed;
        }
      } catch (err) {
        logger.warn('Candidate disk cache read failed', { path: candidate, error: err.message });
      }
    }
  }
  return null;
}

function readDiskCacheSyncSafe() {
  const candidates = [
    DISK_CACHE_PATH,
    `${DISK_CACHE_PATH}.bak`,
    path.resolve(__dirname, '../data/timetable_cache.json'),
    path.resolve(__dirname, '../../data/timetable_cache.json'),
  ];
  const checked = new Set();
  for (const candidate of candidates) {
    if (checked.has(candidate)) continue;
    checked.add(candidate);
    if (fs.existsSync(candidate)) {
      try {
        const content = fs.readFileSync(candidate, 'utf8');
        if (!content || content.length < 100) continue;
        const parsed = JSON.parse(content);
        if (parsed?.r?.dbiAccessorRes?.tables && Array.isArray(parsed.r.dbiAccessorRes.tables) && parsed.r.dbiAccessorRes.tables.length >= 5) {
          return parsed;
        }
      } catch {}
    }
  }
}

/**
 * Synchronous in-memory L1 cache accessor. If not initialized, builds database ONCE
 * from local L3 disk cache synchronously and caches it in memory.
 */
function getCachedIndexedDatabaseSync() {
  if (l1IndexedDatabase) return l1IndexedDatabase;
  const diskRaw = readDiskCacheSyncSafe();
  if (diskRaw) {
    try {
      l1IndexedDatabase = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || FALLBACK_DEFAULT_NUM);
      l1CacheTime = Date.now();
      logger.info('EduPage schedule cache loaded synchronously into memory from disk', {
        classesCount: l1IndexedDatabase?.schedulesByClassId?.size || 0,
      });
      return l1IndexedDatabase;
    } catch (err) {
      logger.warn('Failed to build indexed database synchronously from disk cache', { error: err.message });
    }
  }
  return null;
}

// Non-blocking background revalidation guard
let isBackgroundRevalidating = false;
function revalidateInBackground() {
  if (isBackgroundRevalidating || !canAttemptEduPageNetwork()) return;
  isBackgroundRevalidating = true;
  getOrFetchIndexedData(true)
    .catch(err => {
      logger.warn('Background schedule revalidation failed (serving existing cache)', { error: err.message });
    })
    .finally(() => {
      isBackgroundRevalidating = false;
    });
}

/**
 * Resolves indexed timetable with Singleflight concurrency protection and multi-tier caching
 */
async function getOrFetchIndexedData(forceRefresh = false) {
  const now = Date.now();

  // Fast path 1: L1 In-Memory Cache Hit (Stale-While-Revalidate)
  if (!forceRefresh && l1IndexedDatabase) {
    if (now - l1CacheTime >= L1_CACHE_TTL && canAttemptEduPageNetwork()) {
      revalidateInBackground();
    }
    return l1IndexedDatabase;
  }

  // Fast Path 2: Cold Boot - Instantly restore from L3 Disk Cache
  if (!forceRefresh && !l1IndexedDatabase) {
    const diskRaw = await readDiskCacheSafe();
    if (diskRaw) {
      try {
        l1IndexedDatabase = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || FALLBACK_DEFAULT_NUM);
        l1CacheTime = Date.now();
        logger.info('EduPage schedule cache instantly restored from L3 Disk Cache on cold boot', {
          classesCount: l1IndexedDatabase.schedulesByClassId.size,
        });
        return l1IndexedDatabase;
      } catch (diskErr) {
        logger.warn('Failed to build indexed database from disk cache on cold boot', { error: diskErr.message });
      }
    }
  }

  // Singleflight: reuse running promise if it satisfies forceRefresh requirement
  if (activeFetchPromise) {
    if (!forceRefresh || activeFetchPromiseIsForced) {
      return activeFetchPromise;
    }
    // If caller demands forceRefresh but in-flight fetch is unforced, await it then proceed
    await activeFetchPromise.catch(() => {});
  }

  activeFetchPromiseIsForced = Boolean(forceRefresh);
  activeFetchPromise = (async () => {
    try {
      const defaultNum = await resolveDefaultNum();
      const redis = getRedisClient();
      const redisKey = `cache:edupage:raw:${defaultNum}`;

      // L2 Redis Check (only if not forcing network refresh)
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

      // Network Fetch from TsUE EduPage with Circuit Breaker
      let raw;
      const canAttemptNetwork = canAttemptEduPageNetwork();
      if (canAttemptNetwork) {
        try {
          raw = await fetchRawTimetable(defaultNum);
          if (raw?.__isUnchanged && l1IndexedDatabase) {
            recordEduPageSuccess();
            l1CacheTime = Date.now();
            l1IndexedDatabase.isUnchanged = true;
            return l1IndexedDatabase;
          }
          if (!raw?.r?.dbiAccessorRes?.tables) {
            throw new Error('Invalid response structure from EduPage API (missing tables)');
          }
          const existingSnapshot = l1IndexedDatabase || (await readDiskCacheSafe());
          if (!validateTimetablePayload(raw, existingSnapshot)) {
            logger.warn('Live EduPage response failed sanity validation (incomplete/partial). Using existing cache fallback.');
            if (l1IndexedDatabase) {
              l1IndexedDatabase.isUnchanged = true;
              return l1IndexedDatabase;
            }
            if (existingSnapshot && existingSnapshot.r) {
              l1IndexedDatabase = buildIndexedDatabase(existingSnapshot, existingSnapshot._defaultNum || defaultNum || FALLBACK_DEFAULT_NUM);
              l1IndexedDatabase.isUnchanged = true;
              return l1IndexedDatabase;
            }
            throw new Error('Incomplete EduPage dataset failed sanity validation');
          }
          recordEduPageSuccess();
        } catch (networkErr) {
          recordEduPageFailure(networkErr);
          // Fallback 1: Memory Cache (even if stale)
          if (l1IndexedDatabase) {
            logger.warn('EduPage network request failed; serving existing memory cache', { error: networkErr.message });
            l1CacheTime = Date.now() - L1_CACHE_TTL + 60000;
            return l1IndexedDatabase;
          }

          // Fallback 2: L3 Disk Cache Safe Read
          const diskRaw = await readDiskCacheSafe();
          if (diskRaw) {
            try {
              logger.warn('EduPage network request failed; restored from L3 Disk Cache', { error: networkErr.message });
              l1IndexedDatabase = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || defaultNum || FALLBACK_DEFAULT_NUM);
              l1CacheTime = Date.now() - L1_CACHE_TTL + 60000;
              return l1IndexedDatabase;
            } catch (diskErr) {
              logger.error('Failed to read L3 Disk Cache', { error: diskErr.message });
            }
          }

          throw networkErr;
        }
      } else {
        logger.warn('⚡ EduPage Circuit Breaker is OPEN. Serving from L1 memory or L3 disk cache without network latency.');
        if (l1IndexedDatabase) {
          return l1IndexedDatabase;
        }
        const diskRaw = await readDiskCacheSafe();
        if (diskRaw) {
          try {
            l1IndexedDatabase = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || defaultNum || FALLBACK_DEFAULT_NUM);
            l1CacheTime = Date.now() - L1_CACHE_TTL + 30000;
            return l1IndexedDatabase;
          } catch (diskErr) {
            logger.error('Failed to read L3 Disk Cache during circuit break', { error: diskErr.message });
          }
        }
        throw new Error('EduPage Circuit Breaker is OPEN and no local cache is available');
      }

      if (!raw?.r?.dbiAccessorRes?.tables) {
        throw new Error('Invalid response structure from EduPage API');
      }

      // Index and cache in L1
      lastRawTimetableHash = raw._rawHash || null;
      l1IndexedDatabase = buildIndexedDatabase(raw, defaultNum);
      l1IndexedDatabase.isUnchanged = false;
      l1CacheTime = Date.now();

      // Async atomic write to L3 Disk Cache (guarantees zero corruption across reboots)
      saveDiskCache({ ...raw, _defaultNum: defaultNum }).catch(() => {});

      // Async write to L2 Redis
      if (redis) {
        redis.set(redisKey, JSON.stringify(raw), 'EX', REDIS_TTL_SEC).catch(err => {
          logger.warn('Redis write failed for EduPage cache', { error: err.message });
        });
      }

      return l1IndexedDatabase;
    } finally {
      activeFetchPromise = null;
      activeFetchPromiseIsForced = false;
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
      parts.push(dayIdx === null ? '  — Dars yo\'q' : '📭 Ushbu kunda darslar yo\'q.');
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
        const subgroupTag = l.subgroup ? ` <i>(${escapeHtml(l.subgroup)})</i>` : '';
        const weekTag = l.weekParity === 'toq' ? ' <i>[Toq hafta]</i>' : (l.weekParity === 'juft' ? ' <i>[Juft hafta]</i>' : '');
        const contTag = l.isContinuation ? ' <i>(davomi)</i>' : '';
        parts.push(`  📖 ${cleanSubj}${subgroupTag}${weekTag}${contTag}\n  👨‍🏫 ${cleanTeacher}\n  🚪 ${cleanRoom}`);
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
    // Emergency offline disk fallback
    try {
      const diskRaw = readDiskCacheSyncSafe();
      if (diskRaw?.r?.dbiAccessorRes?.tables) {
        const emergencyDb = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || FALLBACK_DEFAULT_NUM);
        const classId = findClassId(emergencyDb, className);
        if (classId) return emergencyDb.schedulesByClassId.get(classId) || null;
      }
    } catch {}
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
      const numDay = Number(dayIdx);
      if (numDay === 6) {
        return `📅 <b>Yakshanba — dam olish kuni!</b>\n\n📭 Ushbu kunda darslar bo'lmaydi.`;
      }
      const safeDay = Math.max(0, Math.min(5, numDay || 0));
      return `📅 <b>${DAY_NAMES[safeDay]} — dars jadvali:</b>\n${formatTimetableText(schedule, safeDay)}`;
    }
    return formatTimetableText(schedule, null);
  } catch (err) {
    logger.error('Error in getFormattedSchedule', { className, dayIdx, error: err.message, stack: err.stack });

    // Emergency offline disk fallback
    try {
      const diskRaw = readDiskCacheSyncSafe();
      if (diskRaw?.r?.dbiAccessorRes?.tables) {
        const emergencyDb = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || FALLBACK_DEFAULT_NUM);
        const classId = findClassId(emergencyDb, className);
        if (classId) {
          const schedule = emergencyDb.schedulesByClassId.get(classId);
          if (schedule && Object.keys(schedule).length > 0) {
            if (dayIdx !== null && dayIdx !== undefined) {
              const numDay = Number(dayIdx);
              if (numDay === 6) return `📅 <b>Yakshanba — dam olish kuni!</b>\n\n📭 Ushbu kunda darslar bo'lmaydi.`;
              const safeDay = Math.max(0, Math.min(5, numDay || 0));
              return `📅 <b>${DAY_NAMES[safeDay]} — dars jadvali:</b>\n${formatTimetableText(schedule, safeDay)}`;
            }
            return formatTimetableText(schedule, null);
          }
        }
      }
    } catch (fallbackErr) {
      logger.error('Emergency disk fallback failed in getFormattedSchedule', { error: fallbackErr.message });
    }

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
          return Boolean(loc && loc.bino && binoSet.has(loc.bino.toLowerCase()));
        });
      } else {
        emptyRooms = [];
      }
    } else if (binoFilter && binoFilter !== 'all') {
      const cleanFilter = binoFilter.toLowerCase();
      emptyRooms = emptyRooms.filter(xona => {
        const loc = parseRoomLocation(xona);
        if (!loc || !loc.bino) return false;
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
        return Boolean(loc && loc.bino && loc.bino.includes(binoNum));
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
      const loc = parseRoomLocation(xona);
      if (!loc || !loc.bino) continue;
      const { bino, qavat } = loc;
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

    // 2. Fetch fresh from network / Redis in background only if L1 is expired or missing
    if (!l1IndexedDatabase || (Date.now() - l1CacheTime >= L1_CACHE_TTL)) {
      if (canAttemptEduPageNetwork()) {
        logger.info('Pre-warming EduPage schedule cache in background...');
        await getOrFetchIndexedData(false);
        logger.info('EduPage schedule cache successfully pre-warmed');
      }
    }
  } catch (err) {
    logger.warn('Failed to pre-warm EduPage cache (will retry on first request)', { error: err.message });
  }
}

async function getTimetableData(forceRefresh = false) {
  const db = await getOrFetchIndexedData(forceRefresh);
  if (db?.raw) return db.raw;
  if (fs.existsSync(DISK_CACHE_PATH)) {
    try {
      return JSON.parse(await fs.promises.readFile(DISK_CACHE_PATH, 'utf8'));
    } catch {}
  }
  return null;
}

async function getIndexedDatabase(forceRefresh = false) {
  return getOrFetchIndexedData(forceRefresh);
}

/**
 * Checks whether a group has any scheduled lessons on a given day index (0=Mon..6=Sun)
 * @param {string} className
 * @param {number} dayIdx 0=Mon .. 5=Sat, 6=Sun
 * @returns {Promise<boolean>}
 */
async function hasClassLessonsOnDay(className, dayIdx) {
  if (!className || dayIdx === null || dayIdx === undefined) return false;
  const numDay = Number(dayIdx);
  if (numDay < 0 || numDay >= 6) return false; // Sunday (6) never has lessons
  try {
    const db = await getOrFetchIndexedData();
    const classId = findClassId(db, className);
    if (!classId) return false;
    const schedule = db.schedulesByClassId.get(classId);
    if (!schedule) return false;
    const dayLessons = schedule[numDay];
    return Boolean(dayLessons && Object.keys(dayLessons).length > 0);
  } catch (err) {
    logger.error('Error in hasClassLessonsOnDay', { className, dayIdx, error: err.message });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// SMART SCHEDULE V2: CONTEXT-AWARE TIMETABLE HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

/**
 * Standard university period timings with start, end, and 5-min pre-end bell minutes
 */
const PERIOD_TIMINGS = {
  1: { num: 1, start: '08:00', end: '09:20', startMins: 480, endMins: 560, bell5MinBeforeEnd: 555 },
  2: { num: 2, start: '09:30', end: '10:50', startMins: 570, endMins: 650, bell5MinBeforeEnd: 645 },
  3: { num: 3, start: '11:00', end: '12:20', startMins: 660, endMins: 740, bell5MinBeforeEnd: 735 },
  4: { num: 4, start: '13:00', end: '14:20', startMins: 780, endMins: 860, bell5MinBeforeEnd: 855 },
  5: { num: 5, start: '14:30', end: '15:50', startMins: 870, endMins: 950, bell5MinBeforeEnd: 945 },
  6: { num: 6, start: '16:00', end: '17:20', startMins: 960, endMins: 1040, bell5MinBeforeEnd: 1035 },
  7: { num: 7, start: '17:30', end: '18:50', startMins: 1050, endMins: 1130, bell5MinBeforeEnd: 1125 },
  8: { num: 8, start: '19:00', end: '20:20', startMins: 1140, endMins: 1220, bell5MinBeforeEnd: 1215 },
};

/**
 * Returns current Date in Asia/Tashkent (+05:00) timezone safely
 */
function getTashkentNow(customDate = null) {
  const base = customDate instanceof Date ? customDate : (customDate ? new Date(customDate) : new Date());
  const tzStr = base.toLocaleString('en-US', { timeZone: 'Asia/Tashkent' });
  return new Date(tzStr);
}

/**
 * Normalizes subject key by stripping prefixes like (M), (A), (S), (L),
 * recognized bracketed descriptions, trailing Ma/Sem, and uniforming quotes/spaces.
 * Preserves descriptions like (soft skills) and (aylanma).
 * @param {string} subjectName
 */
function normalizeSubjectKey(subjectName = '') {
  if (!subjectName || typeof subjectName !== 'string') return '';
  return subjectName
    // Strip recognized tags inside parentheses
    .replace(/\s*\(\s*(?:m|ma|a|s|l|lc|lec|lek|sem|lab|ma['’`ʻʼ]?ruza|maruza|amaliyot|amaliy|seminar|laboratoriya|амалий|маъруза|семинар|лаб|лек|lms|zoom|online)(?:\s+(?:zoom|online|lms))?\s*\)/gi, '')
    // Strip bracketed abbreviations like "[M]", "[A]", "[S]", "[L]" anywhere
    .replace(/\s*\[\s*(?:m|ma|a|s|l|lc|lec|lek|sem|lab)\s*\]/gi, '')
    // Strip trailing Ma or Sem e.g. 'Fan nomi Ma' or 'Fan nomi Sem'
    .replace(/\s+(?:Ma|Sem)$/i, '')
    // Normalize various apostrophes and quotation marks
    .replace(/[`’‘ʻʼ]/g, "'")
    .replace(/["“”«»]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes raw lesson type / subject into: 'lecture', 'practice', 'lab', or 'any'
 * @param {string|object} rawTypeOrLesson
 */
function normalizeLessonType(rawTypeOrLesson) {
  let fullStr = '';
  if (typeof rawTypeOrLesson === 'string') {
    fullStr = rawTypeOrLesson.trim();
  } else if (rawTypeOrLesson && typeof rawTypeOrLesson === 'object') {
    fullStr = [
      rawTypeOrLesson.subject || rawTypeOrLesson.name || '',
      rawTypeOrLesson.lessonType || '',
      rawTypeOrLesson.type || '',
      rawTypeOrLesson.room || rawTypeOrLesson.classroom || '',
      rawTypeOrLesson.group || '',
    ].join(' ').trim();
  }

  // Step 1 (Highest Priority — Explicit parenthetical/bracketed tags or trailing Ma/Sem):
  // Check explicit tags inside (...) or [...] or trailing Ma/Sem FIRST before inspecting general words
  if (/\(\s*(?:lab|l|лаб|laboratoriya|лаборатория)\b[^)]*\)|\[\s*(?:l|lab)\s*\]/i.test(fullStr)) {
    return 'lab';
  }
  if (/\(\s*(?:sem|s|a|amal|amaliy|amaliyot|seminar|сем|амалий|семинар)\b[^)]*\)|\[\s*(?:s|a|sem)\s*\]|\s+sem$/i.test(fullStr)) {
    return 'practice';
  }
  if (/\(\s*(?:ma|m|lek|lec|lc|ma['’`ʻʼ]?ruza|maruza|лек|маъруза)\b[^)]*\)|\[\s*(?:m|ma|lek)\s*\]|\s+ma$/i.test(fullStr)) {
    return 'lecture';
  }

  // Step 2 (Object metadata):
  if (rawTypeOrLesson && typeof rawTypeOrLesson === 'object') {
    if ((rawTypeOrLesson.subgroup && String(rawTypeOrLesson.subgroup).trim()) || (Array.isArray(rawTypeOrLesson.subgroups) && rawTypeOrLesson.subgroups.length > 0)) {
      return 'practice';
    }
    if (Array.isArray(rawTypeOrLesson.jointGroups) && rawTypeOrLesson.jointGroups.length > 1) {
      return 'lecture';
    }
  }

  // Step 3 (Fallback whole-word regex with strict word boundaries):
  // Strict boundary regex ensures "Elektron", "Intellektual", "kompleksi" NEVER match "lek"
  if (/(?:^|[^a-zA-Zа-яА-ЯўқғҳЎҚҒҲ])(ma['’`ʻʼ]?ruza|maruza|маъруза|leksiya|лекция|lek)(?=$|[^a-zA-Zа-яА-ЯўқғҳЎҚҒҲ])/i.test(fullStr)) {
    return 'lecture';
  }
  if (/(?:^|[^a-zA-Zа-яА-ЯўқғҳЎҚҒҲ])(laboratoriya|лаборатория|lab|лаб)(?=$|[^a-zA-Zа-яА-ЯўқғҳЎҚҒҲ])/i.test(fullStr)) {
    return 'lab';
  }
  if (/(?:^|[^a-zA-Zа-яА-ЯўқғҳЎҚҒҲ])(amaliyot|amaliy[a-zа-я]*|seminar|семинар|амалий[а-я]*|amal|sem|kichik|\d-guruh|\d-гуруҳ)(?=$|[^a-zA-Zа-яА-ЯўқғҳЎҚҒҲ])/i.test(fullStr)) {
    return 'practice';
  }

  return 'any';
}

/**
 * Detects building code from room name (e.g. "A-204" -> "A", "2-bino 301" -> "2", "Asosiy bino" -> "ASOSIY")
 * @param {string} roomStr
 */
function extractBuildingCode(roomStr = '') {
  if (!roomStr || typeof roomStr !== 'string') return null;
  const clean = roomStr.trim();
  const loc = parseRoomLocation(clean);
  if (loc && loc.bino) return loc.bino.toUpperCase();

  // Regex fallback: "A-204", "B 301", "3-bochka"
  const m = clean.match(/^([A-Za-z0-9]+)\s*[-/.\s]/);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Checks if building changes between consecutive periods
 * @param {object} currentLesson
 * @param {object} nextLesson
 */
function detectBuildingTransition(currentLesson, nextLesson) {
  if (!currentLesson || !nextLesson) return false;
  const currBld = extractBuildingCode(currentLesson.room || currentLesson.classroom);
  const nextBld = extractBuildingCode(nextLesson.room || nextLesson.classroom);
  if (!currBld || !nextBld) return false;
  return currBld !== nextBld;
}

/**
 * Detects if two lessons form a continuing double period block in the same room on the same subject
 * @param {object} currentLesson
 * @param {object} nextLesson
 */
function isSameDoublePair(currentLesson, nextLesson) {
  if (!currentLesson || !nextLesson) return false;
  if (nextLesson.isContinuation) return true;
  const sub1 = normalizeSubjectKey(currentLesson.subject);
  const sub2 = normalizeSubjectKey(nextLesson.subject);
  if (!sub1 || !sub2 || sub1.toLowerCase() !== sub2.toLowerCase()) return false;

  const room1 = (currentLesson.room || currentLesson.classroom || '').trim().toLowerCase();
  const room2 = (nextLesson.room || nextLesson.classroom || '').trim().toLowerCase();
  if (room1 && room2 && room1 !== room2) return false;

  const type1 = normalizeLessonType(currentLesson);
  const type2 = normalizeLessonType(nextLesson);
  if (type1 !== 'any' && type2 !== 'any' && type1 !== type2) return false;

  return true;
}

/**
 * Returns first and last lesson of a day, and flags if morning or afternoon shift
 * @param {Array|object} dayLessons
 */
function getFirstAndLastLessonOfDay(dayLessons) {
  if (!dayLessons) return { firstLesson: null, lastLesson: null, isAfternoonShift: false };

  let list = [];
  if (Array.isArray(dayLessons)) {
    list = dayLessons.filter(Boolean);
  } else if (typeof dayLessons === 'object') {
    const pKeys = Object.keys(dayLessons).map(Number).sort((a, b) => a - b);
    for (const p of pKeys) {
      const items = dayLessons[p];
      if (Array.isArray(items)) {
        list.push(...items.map(l => ({ ...l, period: p })));
      } else if (items) {
        list.push({ ...items, period: p });
      }
    }
  }

  if (list.length === 0) {
    return { firstLesson: null, lastLesson: null, isAfternoonShift: false };
  }

  // Sort lessons by period or startTime
  list.sort((a, b) => (Number(a.period) || 1) - (Number(b.period) || 1));

  const firstLesson = list[0];
  const lastLesson = list[list.length - 1];

  // Resolve start time
  const pTiming = PERIOD_TIMINGS[firstLesson.period];
  const startStr = firstLesson.startTime || (pTiming ? pTiming.start : '08:00');
  const [sh, sm] = startStr.split(':').map(Number);
  const startMin = (sh || 0) * 60 + (sm || 0);

  // isAfternoonShift is true if first lesson starts at or after 13:00 (780 mins)
  const isAfternoonShift = startMin >= 13 * 60;

  return { firstLesson, lastLesson, isAfternoonShift };
}

/**
 * Detects if student is currently sitting in a class (or within 10 minutes after it ended).
 * @param {Array|object} groupScheduleToday Array or map of lessons for today
 * @param {number} nowMinutes Minutes from midnight (e.g. 8:45 -> 525)
 */
function detectCurrentActiveLesson(groupScheduleToday, nowMinutes = null) {
  if (!groupScheduleToday) return null;

  let currentMin = nowMinutes;
  if (currentMin === null || currentMin === undefined) {
    const tzNow = getTashkentNow();
    currentMin = tzNow.getHours() * 60 + tzNow.getMinutes();
  }

  let lessons = [];
  if (Array.isArray(groupScheduleToday)) {
    lessons = groupScheduleToday.filter(Boolean);
  } else if (typeof groupScheduleToday === 'object') {
    const pKeys = Object.keys(groupScheduleToday).map(Number).sort((a, b) => a - b);
    for (const p of pKeys) {
      const items = groupScheduleToday[p];
      if (Array.isArray(items)) {
        lessons.push(...items.map(l => ({ ...l, period: p })));
      } else if (items) {
        lessons.push({ ...items, period: p });
      }
    }
  }

  for (const lesson of lessons) {
    const pTiming = PERIOD_TIMINGS[lesson.period];
    const startStr = lesson.startTime || (pTiming ? pTiming.start : '08:00');
    const endStr = lesson.endTime || (pTiming ? pTiming.end : '09:20');

    const [sh, sm] = startStr.split(':').map(Number);
    const [eh, em] = endStr.split(':').map(Number);
    const startMin = (sh || 0) * 60 + (sm || 0);
    const endMin = (eh || 0) * 60 + (em || 0);

    // Active during class (with a 5-min pre-class window)
    if (currentMin >= startMin - 5 && currentMin <= endMin) {
      return {
        state: 'IN_PROGRESS',
        lesson,
        period: Number(lesson.period) || 1,
        subject: lesson.subject,
        baseSubject: normalizeSubjectKey(lesson.subject),
        lessonType: normalizeLessonType(lesson),
        startTime: startStr,
        endTime: endStr,
      };
    }

    // Just finished (within 10 minutes after class ended)
    if (currentMin > endMin && currentMin <= endMin + 10) {
      return {
        state: 'JUST_FINISHED',
        lesson,
        period: Number(lesson.period) || 1,
        subject: lesson.subject,
        baseSubject: normalizeSubjectKey(lesson.subject),
        lessonType: normalizeLessonType(lesson),
        startTime: startStr,
        endTime: endStr,
      };
    }
  }

  return null;
}

/**
 * Scans upcoming occurrences of a course over the next 14 days,
 * prioritizing targetLessonType (e.g. Lecture -> Practice).
 * @param {object} fullGroupTimetable Full weekly schedule { 0: { 1: [...] }, ... 5: { ... } }
 * @param {string} subjectName
 * @param {string} targetLessonType 'practice' | 'lecture' | 'lab' | 'any'
 * @param {Date|string} fromDate
 * @param {number} maxResults
 */
function findUpcomingCourseOccurrences(fullGroupTimetable, subjectName, targetLessonType = 'any', fromDate = null, maxResults = 3) {
  if (!fullGroupTimetable || !subjectName) return [];

  const baseNorm = normalizeSubjectKey(subjectName).toLowerCase();
  const startTz = getTashkentNow(fromDate);
  const currentMinutes = startTz.getHours() * 60 + startTz.getMinutes();

  const DAY_LABELS = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];
  const results = [];

  for (let offset = 0; offset <= 14; offset++) {
    const checkDate = new Date(startTz.getTime() + offset * 86400000);
    const dayOfWeek = (checkDate.getDay() + 6) % 7; // 0=Mon .. 5=Sat, 6=Sun
    if (dayOfWeek === 6) continue; // Sunday off

    const daySchedule = fullGroupTimetable[dayOfWeek];
    if (!daySchedule) continue;

    const yyyy = checkDate.getFullYear();
    const mm = String(checkDate.getMonth() + 1).padStart(2, '0');
    const dd = String(checkDate.getDate()).padStart(2, '0');
    const dateIso = `${yyyy}-${mm}-${dd}`;
    const dateDisplay = `${dd}.${mm}`;

    const periods = Object.keys(daySchedule).map(Number).sort((a, b) => a - b);
    for (const p of periods) {
      const items = Array.isArray(daySchedule[p]) ? daySchedule[p] : [daySchedule[p]];
      for (const item of items) {
        if (!item || !item.subject) continue;
        if (item.isContinuation) continue;
        const itemNorm = normalizeSubjectKey(item.subject).toLowerCase();
        if (itemNorm !== baseNorm && !itemNorm.includes(baseNorm) && !baseNorm.includes(itemNorm)) {
          continue;
        }

        const pTiming = PERIOD_TIMINGS[p] || { start: '08:00', end: '09:20' };
        const startStr = item.startTime || pTiming.start;
        const [sh, sm] = startStr.split(':').map(Number);
        const itemStartMin = (sh || 0) * 60 + (sm || 0);

        // Skip if today and already ended/in progress
        if (offset === 0 && itemStartMin <= currentMinutes + 10) {
          continue;
        }

        const itemLessonType = normalizeLessonType(item);

        results.push({
          dateIso,
          dateDisplay,
          dayLabel: DAY_LABELS[dayOfWeek],
          offsetDays: offset,
          period: p,
          startTime: startStr,
          endTime: item.endTime || pTiming.end,
          subject: item.subject,
          baseSubject: normalizeSubjectKey(item.subject),
          lessonType: itemLessonType,
          room: item.room || item.classroom || '',
          teacher: item.teacher || '',
        });

        if (results.length >= 10) break;
      }
      if (results.length >= 10) break;
    }
  }

  // Sort and prioritize:
  // If targetLessonType is specified and not 'any', prioritize matching lesson types first
  if (targetLessonType && targetLessonType !== 'any') {
    results.sort((a, b) => {
      const aMatch = a.lessonType === targetLessonType ? 1 : 0;
      const bMatch = b.lessonType === targetLessonType ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return a.offsetDays - b.offsetDays || a.period - b.period;
    });
  } else {
    results.sort((a, b) => a.offsetDays - b.offsetDays || a.period - b.period);
  }

  return results.slice(0, maxResults);
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
  resolveDefaultNum,
  findClassId,
  hasClassLessonsOnDay,
  validateTimetablePayload,
  saveTimetableCacheAtomically,
  buildIndexedDatabase,
  getCachedIndexedDatabaseSync,
  getLastRawTimetableHash: () => lastRawTimetableHash,
  resetRawTimetableHash: () => { lastRawTimetableHash = null; },
  canAttemptEduPageNetwork,
  recordEduPageFailure,
  recordEduPageSuccess,
  _getCircuitBreakerState: () => ({
    state: circuitBreakerState,
    consecutiveFailures,
    nextCircuitRetryTime,
    isHalfOpenProbeInFlight,
  }),
  _setCircuitBreakerState: (state, nextRetry = 0, inFlight = false) => {
    circuitBreakerState = state;
    nextCircuitRetryTime = nextRetry;
    isHalfOpenProbeInFlight = inFlight;
  },
  // Phase 2 Context-Aware Timetable Exports:
  PERIOD_TIMINGS,
  getTashkentNow,
  normalizeSubjectKey,
  normalizeLessonType,
  extractBuildingCode,
  detectBuildingTransition,
  isSameDoublePair,
  getFirstAndLastLessonOfDay,
  detectCurrentActiveLesson,
  findUpcomingCourseOccurrences,
};