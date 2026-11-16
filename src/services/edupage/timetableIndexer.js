'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const logger = require('../../core/logger');
const {
  normalizeGroupName,
  extractGroupBase,
  registerCanonicalGroup,
  getCanonicalGroupName,
  parseRoomLocation,
} = require('./groupNormalizer');
const {
  resolveBaseUrl,
  getActiveEduPageAgent,
  httpPost,
  isEduPageCircuitOpen,
  canAttemptEduPageNetwork,
  recordEduPageFailure,
  recordEduPageSuccess,
  _getCircuitBreakerState,
  sessionManager,
  getActiveTransportName,
  getConfiguredProxies,
} = require('./edupageClient');

const FALLBACK_DEFAULT_NUM = '94';
const L1_CACHE_TTL = 3 * 60 * 1000;
const REDIS_TTL_SEC = 10 * 60;

let cachedDefaultNum = FALLBACK_DEFAULT_NUM;
let cachedDefaultNumTime = Date.now();
let l1IndexedDatabase = null;
let l1CacheTime = 0;
let lastRawTimetableHash = null;

let activeFetchPromise = null;
let activeFetchPromiseIsForced = false;

function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  try {
    return require('../redisService');
  } catch {
    return null;
  }
}

function resolveDiskCachePath() {
  const rootDataPath = path.resolve(__dirname, '../../../data/timetable_cache.json');
  if (fs.existsSync(rootDataPath)) return rootDataPath;
  const localSrcPath = path.resolve(__dirname, '../../data/timetable_cache.json');
  if (fs.existsSync(localSrcPath)) return localSrcPath;
  return rootDataPath;
}

async function readDiskCacheSafe() {
  const diskPath = resolveDiskCachePath();
  try {
    if (fs.existsSync(diskPath)) {
      const content = await fs.promises.readFile(diskPath, 'utf8');
      return JSON.parse(content);
    }
  } catch (err) {
    logger.warn('Failed to read EduPage disk cache', { path: diskPath, error: err.message });
  }
  return null;
}

async function saveTimetableCacheAtomically(filePathOrData, maybeData) {
  let filePath = filePathOrData;
  let data = maybeData;
  if (maybeData === undefined) {
    filePath = resolveDiskCachePath();
    data = filePathOrData;
  }
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
      if (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST' || renameErr.code === 'EBUSY') {
        await fs.promises.copyFile(tmpPath, filePath);
        await fs.promises.unlink(tmpPath).catch(() => {});
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    logger.warn('Failed to atomically write cache file', { path: filePath, error: err.message });
  }
}

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

  if (prevCardCount > 0 && cards.length < prevCardCount * 0.5) {
    logger.warn(`validateTimetablePayload failed: card count dropped by >50% (prev=${prevCardCount}, new=${cards.length})`);
    return false;
  }

  return true;
}

function buildIndexedDatabase(raw, defaultNum) {
  const t0 = Date.now();
  const tables = raw?.r?.dbiAccessorRes?.tables || [];
  const tablesById = Object.fromEntries(tables.map(t => [t.id, t.data_rows || []]));
  const findRows = (tid) => tablesById[tid] ?? [];

  const rooms = Object.fromEntries(findRows('classrooms').map(r => [r.id, r.short || r.name]));
  const periods = Object.fromEntries(findRows('periods').map(p => [p.id, p]));
  const teachers = Object.fromEntries(findRows('teachers').map(t => [t.id, t.name || t.short || '?']));
  const rawClasses = findRows('classes');
  const rawGroups = findRows('groups');
  const groupMap = Object.fromEntries(rawGroups.map(g => [g.id, g]));
  const lessonMap = Object.fromEntries(findRows('lessons').map(l => [l.id, l]));
  const cards = findRows('cards');

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

  const schedulesByClassId = new Map();
  for (const card of cards) {
    const lesson = lessonMap[card.lessonid];
    if (!lesson || !lesson.classids || lesson.classids.length === 0) continue;

    const pObj = periods[card.period];
    if (!pObj) continue;
    const pNum = parseInt(pObj.period, 10);
    if (Number.isNaN(pNum)) continue;

    const duration = parseInt(card.durationperiods || lesson.durationperiods || 1, 10) || 1;
    const weeksBitmask = (card.weeks || lesson.weeks || '').trim();
    let weekParity = 'all';
    if (weeksBitmask === '10') weekParity = 'toq';
    else if (weeksBitmask === '01') weekParity = 'juft';

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

  schedulesByClassId.forEach((_, cid) => {
    const c = classesById.get(cid);
    if (c?.name && !c.name.includes('FAKULTET') && !c.name.includes('KURS')) {
      classNamesList.push(c.name.trim());
    }
  });

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
    raw: null,
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
    isUnchanged: false,
    isFromCircuitBreakerFallback: false,
  };
}

function getCachedIndexedDatabaseSync() {
  if (l1IndexedDatabase) return l1IndexedDatabase;
  const diskPath = resolveDiskCachePath();
  if (fs.existsSync(diskPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
      l1IndexedDatabase = buildIndexedDatabase(raw, raw._defaultNum || FALLBACK_DEFAULT_NUM);
      l1CacheTime = Date.now();
      return l1IndexedDatabase;
    } catch (err) {
      logger.warn('Failed to build indexed database synchronously from disk cache', { error: err.message });
    }
  }
  return null;
}

let isBackgroundRevalidating = false;
function revalidateInBackground() {
  if (isBackgroundRevalidating || isEduPageCircuitOpen()) return;
  isBackgroundRevalidating = true;
  getOrFetchIndexedData(true)
    .then((db) => {
      if (db && !db.isUnchanged) {
        try {
          const scheduleWatcher = require('../scheduleWatcherService');
          if (typeof scheduleWatcher.checkScheduleChanges === 'function') {
            scheduleWatcher.checkScheduleChanges(true).catch(e => {
              logger.debug('Watcher auto-check after background revalidation failed', { error: e.message });
            });
          }
        } catch {}
      }
    })
    .catch(err => {
      logger.warn('Background schedule revalidation failed (serving existing cache)', { error: err.message });
    })
    .finally(() => {
      isBackgroundRevalidating = false;
    });
}

async function resolveDefaultNum() {
  const now = Date.now();
  if (cachedDefaultNum && (now - cachedDefaultNumTime) < 30 * 60 * 1000) {
    return cachedDefaultNum;
  }
  try {
    const currentYear = new Date().getFullYear();
    const payload = { __args: [null, currentYear], __gsh: '00000000' };
    const res = await httpPost('/timetable/server/ttviewer.js?__func=getTTViewerData', payload, 10000);
    const num = res?.r?.regular?.default_num;
    if (num && String(num).trim()) {
      cachedDefaultNum = String(num).trim();
      cachedDefaultNumTime = now;
      return cachedDefaultNum;
    }
  } catch (err) {
    logger.debug('resolveDefaultNum network probe failed, falling back to cached value', { error: err.message });
  }
  return cachedDefaultNum || FALLBACK_DEFAULT_NUM;
}

async function fetchRawTimetable(defaultNum) {
  const payload = { __args: [null, defaultNum.toString()], __gsh: '00000000' };
  return httpPost('/timetable/server/regulartt.js?__func=regularttGetData', payload, 20000);
}

async function getOrFetchIndexedData(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && l1IndexedDatabase) {
    if (now - l1CacheTime >= L1_CACHE_TTL && !isEduPageCircuitOpen()) {
      revalidateInBackground();
    }
    return l1IndexedDatabase;
  }

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

  if (activeFetchPromise) {
    if (!forceRefresh || activeFetchPromiseIsForced) {
      return activeFetchPromise;
    }
    await activeFetchPromise.catch(() => {});
  }

  activeFetchPromiseIsForced = Boolean(forceRefresh);
  activeFetchPromise = (async () => {
    try {
      const defaultNum = await resolveDefaultNum();
      const redis = getRedisClient();
      const redisKey = `cache:edupage:raw:${defaultNum}`;

      if (!forceRefresh && redis) {
        try {
          const cachedData = typeof redis.getBuffer === 'function'
            ? await redis.getBuffer(redisKey)
            : await redis.get(redisKey);
          if (cachedData) {
            let jsonStr;
            if (Buffer.isBuffer(cachedData) && cachedData.length >= 2 && cachedData[0] === 0x1f && cachedData[1] === 0x8b) {
              jsonStr = zlib.gunzipSync(cachedData).toString('utf8');
            } else {
              jsonStr = cachedData.toString('utf8');
            }
            const raw = JSON.parse(jsonStr);
            if (raw?.r?.dbiAccessorRes?.tables) {
              l1IndexedDatabase = buildIndexedDatabase(raw, defaultNum);
              l1CacheTime = Date.now();
              return l1IndexedDatabase;
            }
          }
        } catch (redisErr) {
          logger.debug('Redis read for EduPage cache skipped or failed', { error: redisErr.message });
        }
      }

      let raw;
      const canAttemptNetwork = canAttemptEduPageNetwork();

      if (!canAttemptNetwork) {
        logger.warn('⚡ EduPage Circuit Breaker is OPEN. Serving from L3 Disk / Memory cache without network attempt.');
        if (l1IndexedDatabase) {
          l1IndexedDatabase.isFromCircuitBreakerFallback = true;
          return l1IndexedDatabase;
        }
        const diskRaw = await readDiskCacheSafe();
        if (diskRaw) {
          l1IndexedDatabase = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || defaultNum);
          l1IndexedDatabase.isFromCircuitBreakerFallback = true;
          return l1IndexedDatabase;
        }
        throw new Error('EduPage Circuit Breaker is OPEN and no offline cache is available');
      }

      try {
        raw = await fetchRawTimetable(defaultNum);
        recordEduPageSuccess();
      } catch (netErr) {
        recordEduPageFailure(netErr);
        logger.warn('EduPage live network fetch failed, triggering Circuit Breaker fallback to L3/L1 cache', {
          error: netErr.message,
        });

        if (l1IndexedDatabase) {
          l1IndexedDatabase.isFromCircuitBreakerFallback = true;
          return l1IndexedDatabase;
        }
        const diskRaw = await readDiskCacheSafe();
        if (diskRaw) {
          l1IndexedDatabase = buildIndexedDatabase(diskRaw, diskRaw._defaultNum || defaultNum);
          l1IndexedDatabase.isFromCircuitBreakerFallback = true;
          return l1IndexedDatabase;
        }
        throw netErr;
      }

      const rawString = JSON.stringify(raw);
      const newHash = crypto.createHash('md5').update(rawString).digest('hex');

      if (lastRawTimetableHash && newHash === lastRawTimetableHash && l1IndexedDatabase) {
        l1CacheTime = Date.now();
        l1IndexedDatabase.isUnchanged = true;
        l1IndexedDatabase.isFromCircuitBreakerFallback = false;
        return l1IndexedDatabase;
      }

      if (!validateTimetablePayload(raw, l1IndexedDatabase)) {
        logger.error('CRITICAL: Fetched EduPage payload failed Sanity Validation. Aborting overwrite to prevent data corruption.');
        if (l1IndexedDatabase) return l1IndexedDatabase;
        const diskRaw = await readDiskCacheSafe();
        if (diskRaw) return buildIndexedDatabase(diskRaw, diskRaw._defaultNum || defaultNum);
        throw new Error('Live timetable payload failed sanity validation and no valid cache available');
      }

      lastRawTimetableHash = newHash;
      raw._defaultNum = defaultNum;

      // 1. Build in-memory index first so users & watchers get instant access
      l1IndexedDatabase = buildIndexedDatabase(raw, defaultNum);
      l1CacheTime = Date.now();
      l1IndexedDatabase.isUnchanged = false;
      l1IndexedDatabase.isFromCircuitBreakerFallback = false;

      // 2. Persist to L3 SSD disk atomically
      saveTimetableCacheAtomically(raw).catch(err => {
        logger.error('Failed to atomically persist timetable cache to disk', { error: err.message });
      });

      // 3. Optional L2 Redis cache: GZIP-compressed (93% smaller: 8.2MB -> 570KB) and deferred via setImmediate
      // This prevents TCP socket congestion and eliminates "write EPIPE" during event loop execution.
      if (redis && !redis.isDummy) {
        setImmediate(() => {
          zlib.gzip(rawString, (gzErr, gzBuf) => {
            if (!gzErr && gzBuf && redis) {
              redis.set(redisKey, gzBuf, 'EX', REDIS_TTL_SEC).catch(err => {
                logger.debug('Optional EduPage Redis cache write failed', { error: err.message });
              });
            }
          });
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

async function getIndexedDatabase(forceFetch = false) {
  return getOrFetchIndexedData(forceFetch);
}

function findClassId(db, className) {
  if (!db || !className) return null;
  const canonical = getCanonicalGroupName(className) || className;
  const directId = db.classesByName.get(canonical);
  if (directId) return directId;

  const norm = normalizeGroupName(className);
  if (db.classesByName.has(norm)) return db.classesByName.get(norm);

  const base = extractGroupBase(className);
  if (base) {
    const baseNorm = normalizeGroupName(base);
    if (db.classesByName.has(baseNorm)) return db.classesByName.get(baseNorm);
  }

  const clean = canonical.trim().toUpperCase();
  if (db.classesByName.has(clean)) return db.classesByName.get(clean);

  return null;
}

async function getRawSchedule(className, forceFresh = false) {
  const db = await getOrFetchIndexedData(forceFresh);
  const classId = findClassId(db, className);
  if (!classId) return null;
  return db.schedulesByClassId.get(classId) || null;
}

async function getTimetableData(forceFresh = false) {
  return getOrFetchIndexedData(forceFresh);
}

async function getAllClassNames() {
  const db = await getOrFetchIndexedData(false);
  return db ? db.classNamesList : [];
}

async function getMetadataSignature(fetchFresh = false) {
  if (!canAttemptEduPageNetwork()) {
    logger.debug('EduPage Circuit Breaker is active; skipping metadata probe signature');
    return null;
  }

  try {
    const currentYear = new Date().getFullYear();
    const payload = { __args: [null, currentYear], __gsh: '00000000' };
    const res = await httpPost('/timetable/server/ttviewer.js?__func=getTTViewerData', payload, 10000, { isProbe: true });
    const regular = res?.r?.regular;
    if (!regular) return null;

    const defaultNum = regular.default_num || '';
    const activeTt = regular.timetables?.[0] || {};
    const ttNum = activeTt.tt_num || '';
    const text = activeTt.text || '';
    const datefrom = activeTt.datefrom || '';
    const changeEvent = res?.r?._changeEvents?.['dbi:global_settings'] || 0;

    if (!defaultNum && !ttNum) return null;

    recordEduPageSuccess();

    return `${defaultNum}:${ttNum}:${datefrom}:${text}:${changeEvent}`;
  } catch (err) {
    logger.warn('Failed to fetch EduPage metadata probe signature', { error: err.message });
    return null;
  }
}

async function hasClassLessonsOnDay(className, dayIndex) {
  if (dayIndex === 6) return false;
  const schedule = await getRawSchedule(className);
  if (!schedule || !schedule[dayIndex]) return false;
  return Object.keys(schedule[dayIndex]).length > 0;
}

async function manuallyIngestTimetable(payload, source = 'admin') {
  let raw = payload;
  if (typeof payload === 'string') {
    try {
      raw = JSON.parse(payload);
    } catch (e) {
      throw new Error(`JSON parse error: ${e.message}`);
    }
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('Payload must be an object or valid JSON string');
  }

  if (!validateTimetablePayload(raw, l1IndexedDatabase)) {
    throw new Error('Payload failed sanity validation: classes, cards, or subjects are missing or severely depleted.');
  }

  const defaultNum = raw._defaultNum || (await resolveDefaultNum());
  raw._defaultNum = defaultNum;

  await saveTimetableCacheAtomically(raw);

  const redis = getRedisClient();
  if (redis) {
    const redisKey = `cache:edupage:raw:${defaultNum}`;
    await redis.set(redisKey, JSON.stringify(raw), 'EX', REDIS_TTL_SEC).catch(() => {});
  }

  l1IndexedDatabase = buildIndexedDatabase(raw, defaultNum);
  l1CacheTime = Date.now();
  recordEduPageSuccess();

  logger.info(`Timetable successfully ingested manually from ${source}`, {
    classesCount: l1IndexedDatabase.schedulesByClassId.size,
    defaultNum,
  });

  return {
    ok: true,
    success: true,
    classesCount: l1IndexedDatabase.schedulesByClassId.size,
    emptySlotsCount: l1IndexedDatabase.emptyRoomsMatrix.size,
    defaultNum,
  };
}

function getEduPageDiagnosticStatus() {
  const cb = typeof _getCircuitBreakerState === 'function' ? _getCircuitBreakerState() : { state: 'CLOSED', consecutiveFailures: 0, nextCircuitRetryTime: 0 };
  const diskPath = resolveDiskCachePath();
  const diskExists = fs.existsSync(diskPath);
  let diskStats = null;
  if (diskExists) {
    try {
      const st = fs.statSync(diskPath);
      diskStats = {
        sizeBytes: st.size,
        sizeMb: (st.size / 1024 / 1024).toFixed(2),
        modifiedAt: st.mtime.toISOString(),
      };
    } catch {}
  }

  return {
    circuitBreakerState: cb.state,
    consecutiveFailures: cb.consecutiveFailures,
    nextCircuitRetryInSec: Math.max(0, Math.ceil((cb.nextCircuitRetryTime - Date.now()) / 1000)),
    activeTransport: typeof getActiveTransportName === 'function' ? getActiveTransportName() : 'direct',
    proxyConfigured: typeof getConfiguredProxies === 'function' ? getConfiguredProxies().length > 0 : false,
    customBaseUrlConfigured: Boolean(process.env.EDUPAGE_BASE_URL || process.env.EDUPAGE_MIRROR_URL),
    sessionCookieActive: Boolean(sessionManager && sessionManager.cookie && Date.now() < sessionManager.cookieExpiresAt),
    cachedDefaultNum,
    hasL1Database: Boolean(l1IndexedDatabase),
    l1ClassesCount: l1IndexedDatabase?.classesById?.size || 0,
    l1IsFallback: Boolean(l1IndexedDatabase?.isFromCircuitBreakerFallback),
    lastCacheTimeAgoSec: l1CacheTime ? Math.floor((Date.now() - l1CacheTime) / 1000) : null,
    circuitBreaker: {
      isOpen: isEduPageCircuitOpen(),
    },
    l1Cache: {
      isLoaded: l1IndexedDatabase !== null,
      cachedAt: l1CacheTime ? new Date(l1CacheTime).toISOString() : null,
      classesCount: l1IndexedDatabase ? l1IndexedDatabase.schedulesByClassId.size : 0,
    },
    diskCache: {
      path: diskPath,
      exists: diskExists,
      stats: diskStats,
    },
  };
}

async function warmUpCache() {
  try {
    await getOrFetchIndexedData(false);
  } catch (err) {
    logger.warn('EduPage cache warm-up deferred to first user request', { error: err.message });
  }
}

module.exports = {
  resolveDiskCachePath,
  saveTimetableCacheAtomically,
  validateTimetablePayload,
  buildIndexedDatabase,
  getCachedIndexedDatabaseSync,
  warmUpCache,
  getOrFetchIndexedData,
  getIndexedDatabase,
  getRawSchedule,
  getTimetableData,
  findClassId,
  getAllClassNames,
  resolveDefaultNum,
  getMetadataSignature,
  hasClassLessonsOnDay,
  manuallyIngestTimetable,
  getEduPageDiagnosticStatus,
  getLastRawTimetableHash: () => lastRawTimetableHash,
  resetRawTimetableHash: () => { lastRawTimetableHash = null; },
};
