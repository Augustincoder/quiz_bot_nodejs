'use strict';

const { parseRoomLocation } = require('./groupNormalizer');

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
    .replace(/\s*\(\s*(?:m|ma|a|s|l|lc|lec|lek|sem|lab|ma['’`ʻʼ]?ruza|maruza|amaliyot|amaliy|seminar|laboratoriya|амалий|маъруза|семинар|лаб|лек|lms|zoom|online)(?:\s+(?:zoom|online|lms))?\s*\)/gi, '')
    .replace(/\s*\[\s*(?:m|ma|a|s|l|lc|lec|lek|sem|lab)\s*\]/gi, '')
    .replace(/\s+(?:Ma|Sem)$/i, '')
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

  if (/\(\s*(?:lab|l|лаб|laboratoriya|лаборатория)\b[^)]*\)|\[\s*(?:l|lab)\s*\]/i.test(fullStr)) {
    return 'lab';
  }
  if (/\(\s*(?:sem|s|a|amal|amaliy|amaliyot|seminar|сем|амалий|семинар)\b[^)]*\)|\[\s*(?:s|a|sem)\s*\]|\s+sem$/i.test(fullStr)) {
    return 'practice';
  }
  if (/\(\s*(?:ma|m|lek|lec|lc|ma['’`ʻʼ]?ruza|maruza|лек|маъруза)\b[^)]*\)|\[\s*(?:m|ma|lek)\s*\]|\s+ma$/i.test(fullStr)) {
    return 'lecture';
  }

  if (rawTypeOrLesson && typeof rawTypeOrLesson === 'object') {
    if ((rawTypeOrLesson.subgroup && String(rawTypeOrLesson.subgroup).trim()) || (Array.isArray(rawTypeOrLesson.subgroups) && rawTypeOrLesson.subgroups.length > 0)) {
      return 'practice';
    }
    if (Array.isArray(rawTypeOrLesson.jointGroups) && rawTypeOrLesson.jointGroups.length > 1) {
      return 'lecture';
    }
  }

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

  list.sort((a, b) => (Number(a.period) || 1) - (Number(b.period) || 1));

  const firstLesson = list[0];
  const lastLesson = list[list.length - 1];

  const pTiming = PERIOD_TIMINGS[firstLesson.period];
  const startStr = firstLesson.startTime || (pTiming ? pTiming.start : '08:00');
  const [sh, sm] = startStr.split(':').map(Number);
  const startMin = (sh || 0) * 60 + (sm || 0);

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
  const seenSlots = new Set();

  for (let offset = 0; offset <= 14; offset++) {
    const checkDate = new Date(startTz.getTime() + offset * 86400000);
    const dayOfWeek = (checkDate.getDay() + 6) % 7; // 0=Mon .. 5=Sat, 6=Sun
    if (dayOfWeek === 6) continue;

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
        if (itemNorm !== baseNorm) {
          continue;
        }

        const pTiming = PERIOD_TIMINGS[p] || { start: '08:00', end: '09:20' };
        const startStr = item.startTime || pTiming.start;
        const [sh, sm] = startStr.split(':').map(Number);
        const itemStartMin = (sh || 0) * 60 + (sm || 0);

        if (offset === 0 && itemStartMin <= currentMinutes + 10) {
          continue;
        }

        const itemLessonType = normalizeLessonType(item);
        const slotKey = `${dateIso}:${p}:${itemLessonType}`;
        if (seenSlots.has(slotKey)) continue;
        seenSlots.add(slotKey);

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
