'use strict';
const https = require('https');

const DAY_NAMES = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba"];
const PERIOD_TIMES = {
  1: { start: "08:30", end: "09:50" }, 2: { start: "10:00", end: "11:20" },
  3: { start: "11:30", end: "12:50" }, 4: { start: "13:30", end: "14:50" },
  5: { start: "15:00", end: "16:20" }, 6: { start: "16:30", end: "17:50" },
  7: { start: "18:00", end: "19:20" }, 8: { start: "19:30", end: "20:50" }
};
const CURRENT_WEEK = 91;

let globalTimetableCache = null;
let globalCacheTime = 0;
const CACHE_DURATION = 60 * 60 * 1000; // 1 soat davomida xotirada saqlanadi (Tezlik uchun)

const FAKE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'uz,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'Connection': 'keep-alive'
};

function httpGet(options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('GET timeout')), 30000); 
    https.get(options, (res) => {
      clearTimeout(timer);
      resolve(res.headers['set-cookie'] || []);
    }).on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function httpPost(options, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('POST timeout')), 30000);
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); } catch { reject(new Error('JSON parse failed')); }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.write(payload);
    req.end();
  });
}

async function getEdupageCookie(className, week = CURRENT_WEEK, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const cookies = await httpGet({
        hostname: 'tsue.edupage.org',
        path: `/timetable/view.php?num=${week}&class=${encodeURIComponent(className)}`,
        method: 'GET',
        headers: FAKE_HEADERS,
      });
      return cookies.map(c => c.split(';')[0]).join('; ');
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function fetchRawTimetable(cookieString, week = CURRENT_WEEK, retries = 3) {
  const payload = JSON.stringify({ __args: [null, week.toString()], __gsh: '00000000' });
  for (let i = 0; i < retries; i++) {
    try {
      return await httpPost({
        hostname: 'tsue.edupage.org',
        path: '/timetable/server/regulartt.js?__func=regularttGetData',
        method: 'POST',
        headers: {
          ...FAKE_HEADERS,
          'Content-Type': 'application/json; charset=UTF-8',
          'Content-Length': Buffer.byteLength(payload),
          'Origin': 'https://tsue.edupage.org',
          'Referer': 'https://tsue.edupage.org/timetable/',
          'Cookie': cookieString,
        },
      }, payload);
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function getTimetableData(className) {
  const now = Date.now();
  if (globalTimetableCache && (now - globalCacheTime < CACHE_DURATION)) {
    return globalTimetableCache;
  }
  const cookie = await getEdupageCookie(className, CURRENT_WEEK);
  const raw = await fetchRawTimetable(cookie, CURRENT_WEEK);
  if (raw?.r?.dbiAccessorRes) {
    globalTimetableCache = raw;
    globalCacheTime = now;
  }
  return raw;
}

function parseTables(raw) {
  const tables = raw.r.dbiAccessorRes.tables;
  const findRows = (tid) => tables.find(t => t.id === tid)?.data_rows ?? [];

  const rooms = Object.fromEntries(findRows('classrooms').map(r => [r.id, r.short || r.name]));
  const periods = Object.fromEntries(findRows('periods').map(p => [p.id, p]));
  const teachers = Object.fromEntries(findRows('teachers').map(t => [t.id, t.name || t.short || '?']));
  const classes = Object.fromEntries(findRows('classes').map(c => [c.id, c.short || c.name]));
  const lessonMap = Object.fromEntries(findRows('lessons').map(l => [l.id, l]));
  const cards = findRows('cards');

  const subjects = Object.fromEntries(findRows('subjects').map(s => [
    s.id, { name: s.name || s.short, color: s.color || '#CCCCCC', weight: parseInt(s.contract_weight) || 1 }
  ]));

  return { rooms, periods, subjects, teachers, classes, cards, lessonMap };
}

function parseSchedule(raw, className) {
  const { rooms, periods, subjects, teachers, classes, cards, lessonMap } = parseTables(raw);

  let classId = null;
  const cleanClassName = className.toString().trim();
  
  if (classes[cleanClassName]) {
    classId = cleanClassName;
  } else {
    const reqName = cleanClassName.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    const classEntry = Object.entries(classes).find(([, name]) => name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() === reqName);
    if (classEntry) classId = classEntry[0];
  }

  if (!classId) return null;

  const schedule = {};
  for (const card of cards) {
    const lesson = lessonMap[card.lessonid];
    if (!lesson || !(lesson.classids || []).includes(classId)) continue;

    const pObj = periods[card.period];
    if (!pObj) continue;
    const pNum = parseInt(pObj.period);

    const daysStr = card.days || '';
    for (let d = 0; d < 6; d++) {
      if (daysStr[d] !== '1') continue;
      if (!schedule[d]) schedule[d] = {};
      if (!schedule[d][pNum]) schedule[d][pNum] = [];

      const subjData = subjects[lesson.subjectid] || { name: '?', color: '#CCCCCC', weight: 1 };
      schedule[d][pNum].push({
        subject: subjData.name, color: subjData.color, weight: subjData.weight,
        teacher: (lesson.teacherids || []).filter(Boolean).map(t => teachers[t] || t).join(', ') || '?',
        room: (card.classroomids || []).filter(Boolean).map(r => rooms[r] || r).join(', ') || '?',
      });
    }
  }
  return schedule;
}

function formatTimetableText(schedule, dayIdx) {
  if (!schedule) return '❌ Jadval topilmadi.';
  const days = dayIdx !== null ? [dayIdx] : [0, 1, 2, 3, 4, 5];
  const parts = [];
  for (const d of days) {
    const dayLessons = schedule[d];
    if (dayIdx === null) parts.push(`\n📅 <b>${DAY_NAMES[d]}:</b>`);
    if (!dayLessons || Object.keys(dayLessons).length === 0) {
      parts.push(dayIdx === null ? '  — Dars yo\'q' : '📭 Bugun dars yo\'q.');
      continue;
    }
    for (const pNum of Object.keys(dayLessons).map(Number).sort((a, b) => a - b)) {
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

async function getFormattedSchedule(className, dayIdx) {
  try {
    const raw = await getTimetableData(className);
    if (!raw?.r?.dbiAccessorRes) return "❌ Jadval ma'lumotlarini olishda xatolik.";
    const schedule = parseSchedule(raw, className);
    if (dayIdx !== null) return `📅 <b>${DAY_NAMES[dayIdx]} — dars jadvali:</b>\n${formatTimetableText(schedule, dayIdx)}`;
    return formatTimetableText(schedule, null);
  } catch (e) { return "❌ Jadval ma'lumotlarini olishda xatolik yuz berdi."; }
}

async function getRawSchedule(className) {
  try {
    const raw = await getTimetableData(className);
    if (!raw || !raw?.r?.dbiAccessorRes) return null;
    return parseSchedule(raw, className);
  } catch (e) { return null; }
}

function parseRoomLocation(xona) {
  const slashMatch = xona.match(/^(\d+)\/(\d+)/);
  const dashMatch = xona.match(/^(\d+)-.*?(\d)(\d{2})/);
  const normalMatch = xona.match(/^(\d)(\d{2})/);
  if (slashMatch) return { bino: slashMatch[1] === '1' ? '4-bino' : `${slashMatch[1]}-bino`, qavat: `${slashMatch[2].charAt(0)}-qavat` };
  if (dashMatch) return { bino: `${dashMatch[1]}-bino`, qavat: `${dashMatch[2]}-qavat` };
  if (normalMatch) return { bino: 'Asosiy bino', qavat: `${normalMatch[1]}-qavat` };
  return { bino: 'Asosiy bino', qavat: `${xona.charAt(0)}-qavat` };
}

async function getEmptyRoomsText(className, dayIdx, periodNum, offsetDays = 0) {
  try {
    const raw = await getTimetableData(className);
    if (!raw?.r?.dbiAccessorRes) return ["❌ Tizimdan ma'lumot olishda xatolik."];
    const { rooms, periods, cards } = parseTables(raw);
    const occupiedIds = new Set();
    for (const card of cards) {
      if ((card.days || '')[dayIdx] !== '1') continue;
      const pObj = periods[card.period];
      if (!pObj || parseInt(pObj.period) !== periodNum) continue;
      (card.classroomids || []).forEach(rid => occupiedIds.add(rid));
    }
    const emptyRooms = Object.entries(rooms)
      .filter(([id, name]) => !occupiedIds.has(id) && /^\d/.test((name || '').trim()))
      .map(([, name]) => name.trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));

    if (emptyRooms.length === 0) return [`⚠️ <b>${periodNum}-para</b> uchun barcha xonalar band!`];

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
      } else { current += block; }
    }
    current = current.trimEnd() + `\n\n<i>Jami: ${emptyRooms.length} ta bo'sh xona</i>`;
    pages.push(current);
    return pages;
  } catch (e) { return ["❌ Tizimdan bo'sh xonalarni ajratib olishda xatolik."]; }
}

module.exports = { getFormattedSchedule, getEmptyRoomsText, parseSchedule, formatTimetableText, getRawSchedule,getTimetableData };