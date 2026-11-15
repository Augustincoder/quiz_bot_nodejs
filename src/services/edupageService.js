'use strict';

/**
 * EduPage Service Facade
 * Orchestrates timetable indexing, client network requests, normalization,
 * and presentation-layer formatting.
 */

const dns = require('dns');
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const logger = require('../core/logger');
const { escapeHtml } = require('../core/utils');

// Submodules
const groupNormalizer = require('./edupage/groupNormalizer');
const smartScheduleHelper = require('./edupage/smartScheduleHelper');
const edupageClient = require('./edupage/edupageClient');
const timetableIndexer = require('./edupage/timetableIndexer');

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

/**
 * Resolves all university campus buildings where a class/group has scheduled lessons
 * @param {string} className Group name (e.g. "BHA-51k/24")
 * @returns {Promise<string[]>} Array of building names, e.g. ["1-bochka", "13-bino", "14-bino"]
 */
async function getGroupBuildings(className) {
  if (!className) return [];
  try {
    const db = await timetableIndexer.getOrFetchIndexedData();
    if (db && db.buildingsByClassId) {
      const classId = timetableIndexer.findClassId(db, className);
      if (classId && db.buildingsByClassId.has(classId)) {
        return db.buildingsByClassId.get(classId);
      }
    }

    const canonical = groupNormalizer.getCanonicalGroupName(className) || className;
    const schedule = await timetableIndexer.getRawSchedule(canonical);
    if (!schedule) return [];

    const binos = new Set();
    for (let d = 0; d < 6; d++) {
      if (!schedule[d]) continue;
      for (const p of Object.keys(schedule[d])) {
        const lessons = schedule[d][p];
        if (!Array.isArray(lessons)) continue;
        for (const l of lessons) {
          if (l.room) {
            const loc = groupNormalizer.parseRoomLocation(l.room);
            if (loc && loc.bino) binos.add(loc.bino);
          }
        }
      }
    }
    return Array.from(binos);
  } catch (err) {
    logger.error('Error in getGroupBuildings', { className, error: err.message });
    return [];
  }
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
 * Retrieves formatted HTML text schedule for a class
 */
async function getFormattedSchedule(className, dayIdx) {
  try {
    const db = await timetableIndexer.getOrFetchIndexedData();
    const classId = timetableIndexer.findClassId(db, className);
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
      const emergencyDb = timetableIndexer.getCachedIndexedDatabaseSync();
      if (emergencyDb) {
        const classId = timetableIndexer.findClassId(emergencyDb, className);
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
  const tempDb = timetableIndexer.buildIndexedDatabase(raw, 'temp');
  const cid = timetableIndexer.findClassId(tempDb, className);
  return cid ? (tempDb.schedulesByClassId.get(cid) || null) : null;
}

/**
 * Returns empty rooms paginated HTML text pages
 */
async function getEmptyRoomsText(className, dayIdx, periodNum, offsetDays = 0, binoFilter = null, timeMode = null) {
  try {
    const db = await timetableIndexer.getOrFetchIndexedData();
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
          const loc = groupNormalizer.parseRoomLocation(xona);
          return Boolean(loc && loc.bino && binoSet.has(loc.bino.toLowerCase()));
        });
      } else {
        emptyRooms = [];
      }
    } else if (binoFilter && binoFilter !== 'all') {
      const cleanFilter = binoFilter.toLowerCase();
      emptyRooms = emptyRooms.filter(xona => {
        const loc = groupNormalizer.parseRoomLocation(xona);
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
        const loc = groupNormalizer.parseRoomLocation(xona);
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
      const loc = groupNormalizer.parseRoomLocation(xona);
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

module.exports = {
  // Presentation & formatting
  DAY_NAMES,
  PERIOD_TIMES,
  getFormattedSchedule,
  getEmptyRoomsText,
  parseSchedule,
  formatTimetableText,
  getGroupBuildings,

  // Normalizer methods & caches
  normalizeGroupName: groupNormalizer.normalizeGroupName,
  getCanonicalGroupName: groupNormalizer.getCanonicalGroupName,
  extractGroupBase: groupNormalizer.extractGroupBase,
  parseRoomLocation: groupNormalizer.parseRoomLocation,
  registerCanonicalGroup: groupNormalizer.registerCanonicalGroup,
  sweepCaches: () => groupNormalizer.sweepCaches(),

  // Timetable Indexer methods & cache management
  getRawSchedule: timetableIndexer.getRawSchedule,
  getTimetableData: timetableIndexer.getTimetableData,
  getIndexedDatabase: timetableIndexer.getIndexedDatabase,
  getMetadataSignature: timetableIndexer.getMetadataSignature,
  getAllClassNames: timetableIndexer.getAllClassNames,
  warmUpCache: timetableIndexer.warmUpCache,
  resolveDefaultNum: timetableIndexer.resolveDefaultNum,
  findClassId: timetableIndexer.findClassId,
  hasClassLessonsOnDay: timetableIndexer.hasClassLessonsOnDay,
  validateTimetablePayload: timetableIndexer.validateTimetablePayload,
  saveTimetableCacheAtomically: timetableIndexer.saveTimetableCacheAtomically,
  buildIndexedDatabase: timetableIndexer.buildIndexedDatabase,
  getCachedIndexedDatabaseSync: timetableIndexer.getCachedIndexedDatabaseSync,
  getLastRawTimetableHash: timetableIndexer.getLastRawTimetableHash,
  resetRawTimetableHash: timetableIndexer.resetRawTimetableHash,
  manuallyIngestTimetable: timetableIndexer.manuallyIngestTimetable,
  getEduPageDiagnosticStatus: timetableIndexer.getEduPageDiagnosticStatus,

  // Network client & circuit breaker
  canAttemptEduPageNetwork: edupageClient.canAttemptEduPageNetwork,
  isEduPageCircuitOpen: edupageClient.isEduPageCircuitOpen,
  recordEduPageFailure: edupageClient.recordEduPageFailure,
  recordEduPageSuccess: edupageClient.recordEduPageSuccess,
  probeEduPageHealth: edupageClient.probeEduPageHealth,
  testTransports: edupageClient.testTransports,
  getSessionManager: () => edupageClient.sessionManager,
  _getCircuitBreakerState: edupageClient._getCircuitBreakerState,
  _setCircuitBreakerState: edupageClient._setCircuitBreakerState,

  // Context-aware smart schedule helper exports
  PERIOD_TIMINGS: smartScheduleHelper.PERIOD_TIMINGS,
  getTashkentNow: smartScheduleHelper.getTashkentNow,
  normalizeSubjectKey: smartScheduleHelper.normalizeSubjectKey,
  normalizeLessonType: smartScheduleHelper.normalizeLessonType,
  extractBuildingCode: smartScheduleHelper.extractBuildingCode,
  detectBuildingTransition: smartScheduleHelper.detectBuildingTransition,
  isSameDoublePair: smartScheduleHelper.isSameDoublePair,
  getFirstAndLastLessonOfDay: smartScheduleHelper.getFirstAndLastLessonOfDay,
  detectCurrentActiveLesson: smartScheduleHelper.detectCurrentActiveLesson,
  findUpcomingCourseOccurrences: smartScheduleHelper.findUpcomingCourseOccurrences,
};
