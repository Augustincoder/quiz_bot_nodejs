'use strict';

const crypto = require('crypto');
const logger = require('../core/logger');
const edupageService = require('./edupageService');
const scheduleService = require('./scheduleService');
const { normalizeGroupName } = require('./edupageService');
const { escapeHtml, truncateText, TTLMap } = require('../core/utils');

const recentAlertsSent = new TTLMap(2 * 60 * 60 * 1000, 500); // 2-hour deduplication cache

let _dbService = null;
function getDbService() {
  if (!_dbService) {
    try {
      _dbService = require('./dbService');
    } catch (e) {
      logger.warn('dbService unavailable in scheduleWatcherService', { error: e.message });
      _dbService = { getAllUsers: async () => [] };
    }
  }
  return _dbService;
}

function getBroadcastQueue() {
  if (!process.env.REDIS_URL) return null;
  try {
    const { broadcastQueue } = require('../jobs/queues');
    return broadcastQueue;
  } catch {
    return null;
  }
}

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

const REDIS_WATCHER_KEY = 'cache:schedule:watcher:hashes';
const REDIS_SIG_KEY = 'cache:schedule:watcher:signature';
const DEEP_CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes periodic forced deep check

// Internal In-Memory Snapshots
const groupSnapshots = new Map(); // classId -> { hash, schedule, groupName, norm }
let lastCheckedAt = 0;
let lastDeepCheckAt = 0;
let lastKnownSignature = null;
let lastCheckStatus = 'idle';
let isChecking = false;
let isBaselineReady = false;
let tier1SkipsCount = 0;
let deepChecksCount = 0;

let _botTelegram = null;
function setBotInstance(botOrTelegram) {
  _botTelegram = botOrTelegram?.telegram || botOrTelegram;
}

function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  try {
    return require('./redisService');
  } catch {
    return null;
  }
}

/**
 * Extracts a normalized, deterministic representation of a weekly schedule.
 * Normalizes subject, teacher, and room, and sorts lessons deterministically
 * to eliminate order jitter across syncs.
 */
function getSimplifiedSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return {};
  const simplified = {};
  for (let d = 0; d < 6; d++) {
    if (!schedule[d]) continue;
    const periods = Object.keys(schedule[d]).map(Number).sort((a, b) => a - b);
    if (periods.length === 0) continue;
    simplified[d] = {};
    for (const p of periods) {
      simplified[d][p] = (schedule[d][p] || []).map(l => ({
        subject: (l.subject || '').trim(),
        teacher: (l.teacher || '').trim(),
        room: (l.room || '').trim(),
      })).sort((a, b) => (a.subject + a.room).localeCompare(b.subject + b.room));
    }
  }
  return simplified;
}

/**
 * Computes deterministic SHA-256 hash of a group's weekly schedule.
 * Ignores non-essential attributes to prevent false positives.
 */
function computeScheduleHash(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'empty';
  const simplified = getSimplifiedSchedule(schedule);
  return crypto.createHash('sha256').update(JSON.stringify(simplified)).digest('hex');
}

/**
 * Senior-Grade High-Precision Semantic Schedule Diffing Algorithm.
 * Accurately detects:
 * - Moved/Rescheduled lessons across days/periods (LESSON_MOVED)
 * - Room changes (ROOM)
 * - Teacher changes (TEACHER)
 * - Room and Teacher changes simultaneously (ROOM_AND_TEACHER)
 * - Subject changes (SUBJECT)
 * - Added lessons / subgroups (LESSON_ADDED, ADDED_PART)
 * - Cancelled lessons (LESSON_CANCELLED, REMOVED_PART)
 * - Full structured weekly overview fallback (SCHEDULE_FULL_OVERVIEW)
 */
function diffGroupSchedules(oldSched, newSched) {
  const oldSimple = getSimplifiedSchedule(oldSched);
  const newSimple = getSimplifiedSchedule(newSched);

  const oldKeysCount = Object.keys(oldSimple).length;
  const newKeysCount = Object.keys(newSimple).length;

  // If old schedule snapshot was missing/empty and new schedule has lessons,
  // return structured full overview instead of just "yangilandi".
  if (oldKeysCount === 0 && newKeysCount > 0) {
    return [{ type: 'SCHEDULE_FULL_OVERVIEW', schedule: newSimple }];
  }

  const diffs = [];
  const unmatchedOldList = [];
  const unmatchedNewList = [];

  for (let d = 0; d < 6; d++) {
    const oldDay = oldSimple[d] || {};
    const newDay = newSimple[d] || {};
    const allPeriods = Array.from(new Set([...Object.keys(oldDay), ...Object.keys(newDay)])).map(Number).sort((a, b) => a - b);

    for (const p of allPeriods) {
      const oldLessons = [...(oldDay[p] || [])];
      const newLessons = [...(newDay[p] || [])];

      // 1. Match identical lessons first (unchanged)
      for (let i = oldLessons.length - 1; i >= 0; i--) {
        const o = oldLessons[i];
        const matchIdx = newLessons.findIndex(n => n.subject === o.subject && n.room === o.room && n.teacher === o.teacher);
        if (matchIdx !== -1) {
          oldLessons.splice(i, 1);
          newLessons.splice(matchIdx, 1);
        }
      }

      // 2. Match same subject in same period (room, teacher, or division changes)
      for (let i = oldLessons.length - 1; i >= 0; i--) {
        const o = oldLessons[i];
        const matchIdx = newLessons.findIndex(n => n.subject === o.subject);
        if (matchIdx !== -1) {
          const n = newLessons[matchIdx];
          const changes = [];
          if (o.room !== n.room && o.teacher !== n.teacher) {
            changes.push({ kind: 'ROOM_AND_TEACHER', subject: o.subject, fromRoom: o.room, toRoom: n.room, fromTeacher: o.teacher, toTeacher: n.teacher });
          } else if (o.room !== n.room) {
            changes.push({ kind: 'ROOM', subject: o.subject, from: o.room, to: n.room });
          } else if (o.teacher !== n.teacher) {
            changes.push({ kind: 'TEACHER', subject: o.subject, from: o.teacher, to: n.teacher });
          }
          if (changes.length > 0) {
            diffs.push({ type: 'MODIFIED', dayIdx: d, period: p, changes });
          }
          oldLessons.splice(i, 1);
          newLessons.splice(matchIdx, 1);
        }
      }

      // 3. Match same teacher in same period (subject changes)
      for (let i = oldLessons.length - 1; i >= 0; i--) {
        const o = oldLessons[i];
        if (o.teacher && o.teacher !== '?') {
          const matchIdx = newLessons.findIndex(n => n.teacher === o.teacher);
          if (matchIdx !== -1) {
            const n = newLessons[matchIdx];
            diffs.push({
              type: 'MODIFIED',
              dayIdx: d,
              period: p,
              changes: [{ kind: 'SUBJECT', from: o.subject, to: n.subject }],
            });
            oldLessons.splice(i, 1);
            newLessons.splice(matchIdx, 1);
          }
        }
      }

      // 4. Collect remaining unmatched for cross-period rescheduling check
      oldLessons.forEach(l => unmatchedOldList.push({ dayIdx: d, period: p, lesson: l }));
      newLessons.forEach(l => unmatchedNewList.push({ dayIdx: d, period: p, lesson: l }));
    }
  }

  // 5. Cross-period / Cross-day Rescheduling Detection (Dars vaqti ko'chirildi)
  for (let i = unmatchedOldList.length - 1; i >= 0; i--) {
    const oItem = unmatchedOldList[i];
    const matchIdx = unmatchedNewList.findIndex(nItem => nItem.lesson.subject === oItem.lesson.subject);
    if (matchIdx !== -1) {
      const nItem = unmatchedNewList[matchIdx];
      diffs.push({
        type: 'LESSON_MOVED',
        subject: oItem.lesson.subject,
        fromDay: oItem.dayIdx,
        fromPeriod: oItem.period,
        toDay: nItem.dayIdx,
        toPeriod: nItem.period,
        fromRoom: oItem.lesson.room,
        toRoom: nItem.lesson.room,
        teacher: nItem.lesson.teacher || oItem.lesson.teacher,
      });
      unmatchedOldList.splice(i, 1);
      unmatchedNewList.splice(matchIdx, 1);
    }
  }

  // 6. Remaining are pure cancelled or pure added
  for (const oItem of unmatchedOldList) {
    diffs.push({
      type: 'LESSON_CANCELLED',
      dayIdx: oItem.dayIdx,
      period: oItem.period,
      oldLessons: [oItem.lesson],
    });
  }

  for (const nItem of unmatchedNewList) {
    diffs.push({
      type: 'LESSON_ADDED',
      dayIdx: nItem.dayIdx,
      period: nItem.period,
      newLessons: [nItem.lesson],
    });
  }

  return diffs;
}

/**
 * Formats a rich, student-friendly HTML notification message detailing exact changes in every scenario
 */
function formatChangeAlert(groupName, diffs) {
  const safeGroupName = escapeHtml(groupName);
  let text = `🔔 <b>DIQQAT! Guruhingiz dars jadvalida o'zgarish kiritildi!</b>\n\n`;
  text += `🎓 Guruh: <b>${safeGroupName}</b>\n`;

  // Scenario 1: Full overview fallback if old schedule was missing/empty
  const fullOverview = (diffs || []).find(d => d.type === 'SCHEDULE_FULL_OVERVIEW');
  if (fullOverview && fullOverview.schedule) {
    text += `\n⚡️ <b>Haftalik yangilangan dars jadvali:</b>\n`;
    for (let d = 0; d < 6; d++) {
      const dayLessons = fullOverview.schedule[d];
      if (!dayLessons || Object.keys(dayLessons).length === 0) continue;
      text += `\n📅 <b>${DAY_NAMES[d]}:</b>\n`;
      const periods = Object.keys(dayLessons).map(Number).sort((a, b) => a - b);
      for (const p of periods) {
        const time = PERIOD_TIMES[p] ? ` <i>(${PERIOD_TIMES[p].start}–${PERIOD_TIMES[p].end})</i>` : '';
        text += `  • <b>${p}-para</b>${time}:\n`;
        for (const l of dayLessons[p]) {
          const roomStr = l.room ? ` | 🚪 ${escapeHtml(l.room)}` : '';
          const teacherStr = l.teacher ? ` | 👨‍🏫 ${escapeHtml(l.teacher)}` : '';
          text += `    📖 <b>${escapeHtml(l.subject)}</b>${roomStr}${teacherStr}\n`;
        }
      }
    }
    text += `\n<i>💡 Yangilangan to'liq jadval rasmini olish uchun /hafta yoki /jadval ni bosing.</i>`;
    return truncateText(text, 3950);
  }

  text += `⚡️ <b>Kiritilgan aniq o'zgarishlar:</b>\n`;

  // Scenario 2: Rescheduled / moved lessons (most important for students!)
  const moved = (diffs || []).filter(d => d.type === 'LESSON_MOVED');
  if (moved.length > 0) {
    for (const m of moved) {
      const fromDay = DAY_NAMES[m.fromDay] || 'Noma\'lum kun';
      const toDay = DAY_NAMES[m.toDay] || 'Noma\'lum kun';
      const toTime = PERIOD_TIMES[m.toPeriod] ? ` (${PERIOD_TIMES[m.toPeriod].start}–${PERIOD_TIMES[m.toPeriod].end})` : '';
      text += `\n🚚 <b>Dars vaqti ko'chirildi:</b>\n`;
      text += `  📖 <b>${escapeHtml(m.subject)}</b>\n`;
      text += `  ❌ Avval: <s>${fromDay}, ${m.fromPeriod}-para</s>\n`;
      text += `  ✅ Yangi: <b>${toDay}, ${m.toPeriod}-para</b>${toTime}\n`;
      if (m.toRoom) text += `  🚪 Xona: <b>${escapeHtml(m.toRoom)}</b>`;
      if (m.teacher) text += ` | 👨‍🏫 ${escapeHtml(m.teacher)}`;
      text += `\n`;
    }
  }

  // Scenario 3: Day-by-day modifications, additions, cancellations
  const otherDiffs = (diffs || []).filter(d => d.type !== 'LESSON_MOVED' && d.type !== 'SCHEDULE_FULL_OVERVIEW');
  for (const diff of otherDiffs) {
    const day = DAY_NAMES[diff.dayIdx] || 'Noma\'lum kun';
    const time = PERIOD_TIMES[diff.period] ? ` <i>(${PERIOD_TIMES[diff.period].start}–${PERIOD_TIMES[diff.period].end})</i>` : '';
    text += `\n📅 <b>${day}, ${diff.period}-para</b>${time}:\n`;

    if (diff.type === 'LESSON_CANCELLED') {
      for (const l of (diff.oldLessons || [])) {
        const roomStr = l.room ? ` (${escapeHtml(l.room)}-xona)` : '';
        text += `  ❌ <b>Dars bekor qilindi:</b> ${escapeHtml(l.subject)}${roomStr}\n`;
      }
    } else if (diff.type === 'LESSON_ADDED') {
      for (const l of (diff.newLessons || [])) {
        text += `  ➕ <b>Yangi dars qo'shildi:</b>\n`;
        text += `    📖 <b>${escapeHtml(l.subject)}</b>\n`;
        const roomStr = l.room ? `${escapeHtml(l.room)}-xona` : 'Xona belgilanmagan';
        const teacherStr = l.teacher ? ` | 👨‍🏫 ${escapeHtml(l.teacher)}` : '';
        text += `    🚪 ${roomStr}${teacherStr}\n`;
      }
    } else if (diff.type === 'MODIFIED') {
      for (const change of (diff.changes || [])) {
        if (change.kind === 'ROOM_AND_TEACHER') {
          text += `  🔄 <b>Xona va o'qituvchi o'zgardi:</b>\n`;
          text += `    📖 <b>${escapeHtml(change.subject)}</b>\n`;
          text += `    🚪 Xona: <s>${escapeHtml(change.fromRoom)}</s> ➡️ <b>${escapeHtml(change.toRoom)}</b>\n`;
          text += `    👨‍🏫 O'qituvchi: <s>${escapeHtml(change.fromTeacher)}</s> ➡️ <b>${escapeHtml(change.toTeacher)}</b>\n`;
        } else if (change.kind === 'ROOM') {
          text += `  🔄 <b>Xona o'zgardi:</b>\n`;
          text += `    📖 <b>${escapeHtml(change.subject)}</b>\n`;
          text += `    🚪 <s>${escapeHtml(change.from)}</s> ➡️ <b>${escapeHtml(change.to)}</b>\n`;
        } else if (change.kind === 'TEACHER') {
          text += `  👨‍🏫 <b>O'qituvchi almashdi:</b>\n`;
          text += `    📖 <b>${escapeHtml(change.subject)}</b>\n`;
          text += `    ❌ Avval: <s>${escapeHtml(change.from)}</s> ➡️ ✅ Yangi: <b>${escapeHtml(change.to)}</b>\n`;
        } else if (change.kind === 'SUBJECT') {
          text += `  🔄 <b>Fan o'zgardi:</b> <s>${escapeHtml(change.from)}</s> ➡️ <b>${escapeHtml(change.to)}</b>\n`;
        } else if (change.kind === 'ADDED_PART') {
          text += `  ➕ <b>Qo'shimcha dars/kichik guruh:</b> 📖 ${escapeHtml(change.to)}\n`;
        } else if (change.kind === 'REMOVED_PART') {
          text += `  ➖ <b>Dars olib tashlandi:</b> ❌ <s>${escapeHtml(change.from)}</s>\n`;
        }
      }
    }
  }

  text += `\n<i>💡 Yangilangan to'liq jadval rasmini olish uchun /hafta yoki /jadval ni bosing.</i>`;
  return truncateText(text, 3950);
}

/**
 * Dispatches targeted alerts to students of affected groups via BullMQ (or direct Telegram delivery fallback),
 * and pre-warms the updated schedule image ONLY for active groups with registered users.
 */
async function dispatchGroupAlerts(groupName, diffs, usersList, currentHash = null) {
  const canonicalGroupName = edupageService.getCanonicalGroupName(groupName) || groupName;
  const normGroup = normalizeGroupName(canonicalGroupName);
  const rawNormGroup = normalizeGroupName(groupName);

  // Prevent duplicate alert spam to the same group for the same schedule hash within 2 hours
  if (currentHash) {
    const alertKey = `${normGroup}:${currentHash}`;
    if (recentAlertsSent.has(alertKey)) {
      logger.debug(`Alert for group "${canonicalGroupName}" with hash ${currentHash.slice(0, 10)} already sent recently, skipping duplicate.`);
      return;
    }
    recentAlertsSent.set(alertKey, Date.now());
  }

  // If usersList is already filtered, use it; otherwise filter from all users
  const rawUsers = (usersList || []).filter(u => {
    if (!u || !u.telegram_id || !u.class_name || u.is_banned || u.is_blocked) return false;
    const uNorm = normalizeGroupName(u.class_name);
    if (uNorm === normGroup || uNorm === rawNormGroup) return true;

    const uCanonical = edupageService.getCanonicalGroupName(u.class_name);
    if (uCanonical) {
      const uCanonicalNorm = normalizeGroupName(uCanonical);
      if (uCanonicalNorm === normGroup || uCanonicalNorm === rawNormGroup) return true;
    }
    return false;
  });

  // Deduplicate by telegram_id
  const matchingUsers = Array.from(new Map(rawUsers.map(u => [String(u.telegram_id), u])).values());

  // Invalidate rendered weekly image cache for this group
  await scheduleService.invalidateImageCache(groupName);

  if (matchingUsers.length === 0) {
    logger.debug('Schedule changed for group with no registered bot users', { groupName });
    return;
  }

  const message = formatChangeAlert(canonicalGroupName, diffs);

  // 1. Deliver notifications specifically to affected students
  const queue = getBroadcastQueue();
  const redis = getRedisClient();
  const hasRealQueue = queue && !queue.isDummy && redis && !redis.isDummy;
  if (hasRealQueue) {
    const jobs = matchingUsers.map(u => ({
      name: 'schedule-change-alert',
      data: {
        userId: u.telegram_id,
        message,
      },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    }));

    await queue.addBulk(jobs);
    logger.info(`📢 Queued schedule change alert via BullMQ to ${matchingUsers.length} users of ${canonicalGroupName}`, {
      groupName: canonicalGroupName,
      diffCount: diffs.length,
    });
  } else if (_botTelegram) {
    logger.info(`📢 Delivering schedule change alerts directly to ${matchingUsers.length} users of ${canonicalGroupName}...`);
    for (const u of matchingUsers) {
      try {
        await _botTelegram.sendMessage(u.telegram_id, message, { parse_mode: 'HTML' });
      } catch (sendErr) {
        const isBlocked = sendErr?.message?.includes('blocked') ||
          sendErr?.message?.includes('deactivated') ||
          sendErr?.response?.error_code === 403;
        if (isBlocked) {
          getDbService().markUserBlocked(u.telegram_id, true).catch(() => {});
        } else {
          logger.warn(`Direct alert send failed for user ${u.telegram_id}:`, { error: sendErr.message });
        }
      }
      await new Promise(r => setTimeout(r, 60)); // 60ms pacing to stay safely under Telegram limits
    }
  } else {
    logger.info(`📢 Schedule change alert prepared for ${matchingUsers.length} users of ${canonicalGroupName} (no delivery transport available)`, {
      groupName: canonicalGroupName,
      diffCount: diffs.length,
    });
  }

  // 2. Invalidate old cached timetable images in DB & Redis. Fresh photos generate on demand (JIT).
  try {
    const db = getDbService();
    if (typeof db.deleteTimetableCache === 'function') {
      await db.deleteTimetableCache(canonicalGroupName);
    }
  } catch (e) {
    logger.debug('deleteTimetableCache error in dispatchGroupAlerts', { error: e.message });
  }

  // 3. Record alerted hash and persistent snapshot in Redis so students are never spammed and future diffs are exact
  if (redis && currentHash) {
    redis.set(`cache:schedule:last_alerted_hash:${normGroup}`, currentHash, 'EX', 86400 * 30).catch(() => {});
    if (rawNormGroup && rawNormGroup !== normGroup) {
      redis.set(`cache:schedule:last_alerted_hash:${rawNormGroup}`, currentHash, 'EX', 86400 * 30).catch(() => {});
    }
    const snap = groupSnapshots.get(normGroup)?.schedule || groupSnapshots.get(canonicalGroupName)?.schedule;
    if (snap) {
      redis.set(`cache:schedule:active_snapshot:${normGroup}`, JSON.stringify(snap), 'EX', 86400 * 30).catch(() => {});
    }
  }

  if (global.gc) {
    try { global.gc(); } catch {}
  }
}

/**
 * Proactively notifies students of an active group when an on-demand request (e.g. /hafta)
 * detects that the cached timetable was stale and had to be regenerated.
 */
async function notifyGroupScheduleChanged(groupName, newHash) {
  const canonicalGroupName = edupageService.getCanonicalGroupName(groupName) || groupName;
  const normGroup = normalizeGroupName(canonicalGroupName);
  if (newHash && recentAlertsSent.has(`${normGroup}:${newHash}`)) {
    return;
  }

  const db = getDbService();
  let users = [];
  try {
    if (typeof db.getScheduleBroadcastUsers === 'function') {
      users = await db.getScheduleBroadcastUsers();
    }
    if (!users || users.length === 0) {
      users = await db.getAllUsers();
    }
  } catch (e) {
    logger.warn('Failed to load users in notifyGroupScheduleChanged', { error: e.message });
  }

  const rawUsers = (users || []).filter(u => {
    if (!u || !u.telegram_id || !u.class_name || u.is_banned || u.is_blocked) return false;
    const uCanonical = edupageService.getCanonicalGroupName(u.class_name) || u.class_name;
    const uNorm = normalizeGroupName(uCanonical);
    const uRawNorm = normalizeGroupName(u.class_name);
    return uNorm === normGroup || uRawNorm === normGroup;
  });

  const matchingUsers = Array.from(new Map(rawUsers.map(u => [String(u.telegram_id), u])).values());
  if (matchingUsers.length === 0) return;

  logger.info(`📢 Proactively dispatching alerts to ${matchingUsers.length} enrolled students of ${canonicalGroupName} (triggered by on-demand stale refresh).`);
  await dispatchGroupAlerts(canonicalGroupName, [{ type: 'SCHEDULE_REFRESHED' }], matchingUsers, newHash);
}

/**
 * Senior-Level 2-Tier Schedule Watcher with Dual Change Detection:
 * 1. Runtime In-Memory / Redis snapshot change detection.
 * 2. Database CDN Reconciliation: Compares current live EduPage hashes against cached hashes in timetable_cache.
 * 3. Alert Delivery Tracking: Guarantees that groups with unalerted schedule hashes (like BHA-56/24i) are ALWAYS detected and notified!
 */
async function checkScheduleChanges(forceOrOptions = false) {
  if (isChecking) {
    logger.debug('Schedule check already in progress, skipping iteration');
    return { checked: false, reason: 'in_progress' };
  }

  let forceDeepCheck = false;
  let forceCheckAllActive = false;
  let targetNorm = null;

  if (typeof forceOrOptions === 'boolean') {
    forceDeepCheck = forceOrOptions;
  } else if (typeof forceOrOptions === 'string') {
    const clean = forceOrOptions.trim();
    if (clean === 'force' || clean === 'true') {
      forceDeepCheck = true;
      forceCheckAllActive = true;
    } else {
      const canonical = edupageService.getCanonicalGroupName(clean) || clean;
      targetNorm = normalizeGroupName(canonical);
      forceDeepCheck = true;
    }
  } else if (typeof forceOrOptions === 'object' && forceOrOptions !== null) {
    forceDeepCheck = !!forceOrOptions.force;
    forceCheckAllActive = !!forceOrOptions.forceAllActive;
    if (forceOrOptions.targetGroup) {
      const canonical = edupageService.getCanonicalGroupName(forceOrOptions.targetGroup) || forceOrOptions.targetGroup;
      targetNorm = normalizeGroupName(canonical);
    }
  }

  isChecking = true;
  lastCheckStatus = 'checking';
  const t0 = Date.now();

  try {
    const redis = getRedisClient();

    // 1. If baseline not in memory, attempt restoring from Redis
    if (!isBaselineReady && redis) {
      try {
        const [storedHashes, storedSig] = await Promise.all([
          redis.get(REDIS_WATCHER_KEY),
          redis.get(REDIS_SIG_KEY),
        ]);
        if (storedHashes) {
          const parsed = JSON.parse(storedHashes);
          for (const [cid, val] of Object.entries(parsed)) {
            groupSnapshots.set(cid, val);
          }
          if (groupSnapshots.size > 0) {
            isBaselineReady = true;
            logger.info('Schedule watcher baseline restored from Redis', { count: groupSnapshots.size });
          }
        }
        if (storedSig) {
          lastKnownSignature = storedSig;
        }
      } catch (err) {
        logger.warn('Failed to read schedule baseline from Redis', { error: err.message });
      }
    }

    // 2. Real-time Database Synchronization from EduPage (Gzip payload ~767KB in ~1.6s)
    deepChecksCount++;
    const indexedDb = await edupageService.getIndexedDatabase(forceDeepCheck || !isBaselineReady);
    if (!indexedDb?.schedulesByClassId || !indexedDb?.classesById) {
      isChecking = false;
      lastCheckStatus = 'error_empty_tables';
      return { checked: false, reason: 'empty_tables' };
    }

    // 3. Pre-load active users and DB cached timetables for dual reconciliation
    const db = getDbService();
    let broadcastUsers = [];
    try {
      if (typeof db.getScheduleBroadcastUsers === 'function') {
        broadcastUsers = await db.getScheduleBroadcastUsers();
      }
      if (!broadcastUsers || broadcastUsers.length === 0) {
        broadcastUsers = await db.getAllUsers();
      }
    } catch (e) {
      logger.warn('Failed to load users for schedule change alerts', { error: e.message });
    }

    // Group active users by normalized group name for fast O(1) matching
    const usersByGroupNorm = new Map();
    for (const u of (broadcastUsers || [])) {
      if (!u.telegram_id || !u.class_name || u.is_banned || u.is_blocked) continue;
      const uCanonical = edupageService.getCanonicalGroupName(u.class_name) || u.class_name;
      const uNorm = normalizeGroupName(uCanonical);
      const uRawNorm = normalizeGroupName(u.class_name);

      if (uNorm) {
        if (!usersByGroupNorm.has(uNorm)) usersByGroupNorm.set(uNorm, []);
        usersByGroupNorm.get(uNorm).push(u);
      }
      if (uRawNorm && uRawNorm !== uNorm) {
        if (!usersByGroupNorm.has(uRawNorm)) usersByGroupNorm.set(uRawNorm, []);
        usersByGroupNorm.get(uRawNorm).push(u);
      }
    }

    // Map all cached timetable hashes in DB
    const cachedTimetablesMap = new Map();
    try {
      if (typeof db.getAllCachedTimetables === 'function') {
        const cachedRows = await db.getAllCachedTimetables();
        for (const row of (cachedRows || [])) {
          if (row.group_normalized && row.schedule_hash) {
            cachedTimetablesMap.set(row.group_normalized, row.schedule_hash);
          }
        }
      }
    } catch (e) {
      logger.debug('Could not load cached timetables for watcher comparison', { error: e.message });
    }

    // Map all alerted hashes and active snapshots from Redis
    const alertedHashesMap = new Map();
    const activeSnapshotsMap = new Map();
    if (redis) {
      try {
        const activeNorms = Array.from(usersByGroupNorm.keys());
        if (activeNorms.length > 0) {
          const pipeline = redis.pipeline();
          for (const n of activeNorms) {
            pipeline.get(`cache:schedule:last_alerted_hash:${n}`);
            pipeline.get(`cache:schedule:active_snapshot:${n}`);
          }
          const results = await pipeline.exec();
          for (let i = 0; i < activeNorms.length; i++) {
            const hashRes = results[i * 2];
            const snapRes = results[i * 2 + 1];
            const n = activeNorms[i];
            if (!hashRes[0] && hashRes[1]) alertedHashesMap.set(n, hashRes[1]);
            if (!snapRes[0] && snapRes[1]) {
              try {
                activeSnapshotsMap.set(n, JSON.parse(snapRes[1]));
              } catch {}
            }
          }
        }
      } catch (e) {
        logger.debug('Could not load alerted hashes/snapshots from Redis', { error: e.message });
      }
    }

    const changedGroups = [];
    const newHashesForRedis = {};

    // DIRECT SYNCHRONOUS MAP ITERATION (~25ms for 1,342 classes!)
    for (const [classId, currentRawSchedule] of indexedDb.schedulesByClassId.entries()) {
      const c = indexedDb.classesById.get(classId);
      if (!c) continue;

      const gName = (c.name || c.short || '').trim();
      if (!gName || gName.includes('FAKULTET') || gName.includes('KURS')) continue;

      const canonical = edupageService.getCanonicalGroupName(gName) || gName;
      const norm = normalizeGroupName(canonical);
      const rawNorm = normalizeGroupName(gName);
      if (!norm) continue;

      const currentSimplified = getSimplifiedSchedule(currentRawSchedule);
      const currentHash = computeScheduleHash(currentRawSchedule);

      const oldEntry = groupSnapshots.get(classId);
      const oldSchedule = oldEntry?.schedule || activeSnapshotsMap.get(norm) || (rawNorm ? activeSnapshotsMap.get(rawNorm) : null);
      const oldHash = oldEntry?.hash;
      const dbCachedHash = cachedTimetablesMap.get(norm) || (rawNorm ? cachedTimetablesMap.get(rawNorm) : null);
      const lastAlertedHash = alertedHashesMap.get(norm) || (rawNorm ? alertedHashesMap.get(rawNorm) : null);
      const hasActiveUsers = (usersByGroupNorm.has(norm) && usersByGroupNorm.get(norm).length > 0) ||
                             (rawNorm && usersByGroupNorm.has(rawNorm) && usersByGroupNorm.get(rawNorm).length > 0);
      const isTargetGroup = targetNorm && (targetNorm === norm || targetNorm === rawNorm);

      // Memory optimization: only save simplified schedule for active groups to save 90% heap
      if (hasActiveUsers) {
        newHashesForRedis[classId] = { hash: currentHash, schedule: currentSimplified, groupName: canonical, norm };
      } else {
        newHashesForRedis[classId] = { hash: currentHash, groupName: canonical, norm };
      }

      // If active group has no recorded baseline in Redis yet (first time initialization), seed it so we don't spam
      if (hasActiveUsers && !lastAlertedHash && !isTargetGroup && !forceCheckAllActive) {
        alertedHashesMap.set(norm, currentHash);
        if (redis) {
          redis.set(`cache:schedule:last_alerted_hash:${norm}`, currentHash, 'EX', 86400 * 30).catch(() => {});
          redis.set(`cache:schedule:active_snapshot:${norm}`, JSON.stringify(currentSimplified), 'EX', 86400 * 30).catch(() => {});
        }
      }

      let hasChanged = false;
      let diffs = [];

      // Detection Condition 1: Runtime in-memory hash change
      if (isBaselineReady && oldEntry && oldHash && oldHash !== currentHash) {
        hasChanged = true;
        diffs = diffGroupSchedules(oldSchedule || {}, currentSimplified);
      }
      // Detection Condition 2: Active registered group whose DB/CDN cache is stale
      else if (hasActiveUsers && dbCachedHash && dbCachedHash !== currentHash) {
        logger.info(`🚨 Stale DB/CDN cache detected for active group "${canonical}" (DB: ${dbCachedHash.slice(0, 10)}... vs EduPage: ${currentHash.slice(0, 10)}...)`);
        hasChanged = true;
        diffs = diffGroupSchedules(oldSchedule || {}, currentSimplified);
      }
      // Detection Condition 3: Active group whose schedule hash has changed since the last alerted hash
      else if (hasActiveUsers && lastAlertedHash && lastAlertedHash !== currentHash && !recentAlertsSent.has(`${norm}:${currentHash}`)) {
        logger.info(`📢 Schedule hash changed since last alert for "${canonical}" (Alerted: ${lastAlertedHash.slice(0, 10)}... -> Current: ${currentHash.slice(0, 10)}...)`);
        hasChanged = true;
        diffs = diffGroupSchedules(oldSchedule || {}, currentSimplified);
      }
      // Explicit admin checks (e.g. /check_schedule force or /check_schedule 56i)
      else if (hasActiveUsers && (forceCheckAllActive || isTargetGroup) && !recentAlertsSent.has(`${norm}:${currentHash}`)) {
        logger.info(`📢 Force checking active group "${canonical}" (Current: ${currentHash.slice(0, 10)}...)`);
        hasChanged = true;
        diffs = diffGroupSchedules(oldSchedule || {}, currentSimplified);
      }

      if (hasChanged) {
        if (!diffs || diffs.length === 0) diffs = [{ type: 'SCHEDULE_FULL_OVERVIEW', schedule: currentSimplified }];
        changedGroups.push({ classId, groupName: canonical, norm, rawNorm, diffs, currentHash });
      }

      // Update in-memory snapshot
      groupSnapshots.set(classId, hasActiveUsers ? {
        hash: currentHash,
        schedule: currentSimplified,
        groupName: canonical,
        norm,
      } : {
        hash: currentHash,
        groupName: canonical,
        norm,
      });

      // Update snapshot in Redis for active group if changed
      if (hasActiveUsers && hasChanged && redis) {
        redis.set(`cache:schedule:active_snapshot:${norm}`, JSON.stringify(currentSimplified), 'EX', 86400 * 30).catch(() => {});
      }
    }

    lastDeepCheckAt = Date.now();

    // 4. Baseline vs Change detection dispatch
    if (!isBaselineReady) {
      isBaselineReady = true;
      logger.info('✅ Initial schedule baseline snapshot established', {
        groupsCount: groupSnapshots.size,
        durationMs: Date.now() - t0,
      });
    }

    if (changedGroups.length > 0) {
      logger.info(`🚨 Processing schedule changes for ${changedGroups.length} groups...`, {
        groups: changedGroups.map(g => g.groupName),
      });

      let activeChangesCount = 0;
      for (const item of changedGroups) {
        const matchingUsers = [
          ...(usersByGroupNorm.get(item.norm) || []),
          ...(item.rawNorm && item.rawNorm !== item.norm ? (usersByGroupNorm.get(item.rawNorm) || []) : []),
        ];

        // Deduplicate
        const uniqueMatching = Array.from(new Map(matchingUsers.map(u => [String(u.telegram_id), u])).values());

        if (uniqueMatching.length === 0) {
          // Inactive/Unused group: Only purge stale cache metadata. DO NOT generate images or send alerts to save server RAM/CPU!
          logger.debug(`Schedule changed for inactive group "${item.groupName}" (0 registered users). Image rendering skipped to save resources.`);
          await scheduleService.invalidateImageCache(item.groupName).catch(() => {});
        } else {
          // Active group with real students! Invalidate old image and dispatch alerts ONLY for this group!
          activeChangesCount++;
          logger.info(`📢 Active group "${item.groupName}" changed! Alerting ${uniqueMatching.length} enrolled users.`);
          await dispatchGroupAlerts(item.groupName, item.diffs, uniqueMatching, item.currentHash);
        }
      }
      logger.info(`Schedule change processing finished: ${activeChangesCount} active groups alerted, ${changedGroups.length - activeChangesCount} inactive groups skipped.`);
    } else {
      logger.debug('Schedule check completed: no changes detected', { durationMs: Date.now() - t0 });
    }

    // 5. Save updated baseline hashes to Redis
    if (redis) {
      redis.set(REDIS_WATCHER_KEY, JSON.stringify(newHashesForRedis), 'EX', 24 * 60 * 60).catch(err => {
        logger.warn('Failed to save schedule watcher hashes in Redis', { error: err.message });
      });
    }

    lastCheckedAt = Date.now();
    lastCheckStatus = 'ok';

    if (global.gc) {
      try { global.gc(); } catch {}
    }

    return {
      checked: true,
      skippedTier1: false,
      changedGroupsCount: changedGroups.length,
      changedGroups: changedGroups.map(g => g.groupName),
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    lastCheckStatus = `error: ${err.message}`;
    logger.error('Error during schedule watcher check', { error: err.message, stack: err.stack });
    return { checked: false, error: err.message };
  } finally {
    isChecking = false;
  }
}

/**
 * On-demand force alert sender for a specific group (e.g. /send_schedule_alert 56i)
 */
async function forceAlertGroup(groupName) {
  const canonical = edupageService.getCanonicalGroupName(groupName) || groupName;
  const norm = normalizeGroupName(canonical);
  const rawNorm = normalizeGroupName(groupName);

  const indexedDb = await edupageService.getIndexedDatabase(false);
  const classId = indexedDb?.classesByName?.get(canonical) || indexedDb?.classesByName?.get(norm);
  const rawSchedule = indexedDb?.schedulesByClassId?.get(classId) || await edupageService.getRawSchedule(canonical);
  const currentHash = computeScheduleHash(rawSchedule);

  const db = getDbService();
  let users = [];
  try {
    if (typeof db.getScheduleBroadcastUsers === 'function') {
      users = await db.getScheduleBroadcastUsers();
    }
    if (!users || users.length === 0) {
      users = await db.getAllUsers();
    }
  } catch (e) {
    logger.warn('Failed to load users for forceAlertGroup', { error: e.message });
  }

  const matchingUsers = (users || []).filter(u => {
    if (!u || !u.telegram_id || !u.class_name || u.is_banned || u.is_blocked) return false;
    const uCanonical = edupageService.getCanonicalGroupName(u.class_name) || u.class_name;
    const uNorm = normalizeGroupName(uCanonical);
    const uRawNorm = normalizeGroupName(u.class_name);
    return uNorm === norm || uRawNorm === norm || uNorm === rawNorm || uRawNorm === rawNorm;
  });

  const uniqueUsers = Array.from(new Map(matchingUsers.map(u => [String(u.telegram_id), u])).values());
  if (uniqueUsers.length === 0) {
    return { success: false, error: 'Guruhda ro\'yxatdan o\'tgan talabalar topilmadi', groupName: canonical, usersCount: 0 };
  }

  const currentSimplified = getSimplifiedSchedule(rawSchedule);

  let oldSchedule = groupSnapshots.get(classId)?.schedule;
  const redis = getRedisClient();
  if (!oldSchedule && redis) {
    try {
      const snapJson = await redis.get(`cache:schedule:active_snapshot:${norm}`);
      if (snapJson) oldSchedule = JSON.parse(snapJson);
    } catch {}
  }

  let diffs = [];
  if (oldSchedule) {
    diffs = diffGroupSchedules(oldSchedule, currentSimplified);
  }
  if (!diffs || diffs.length === 0) {
    diffs = [{ type: 'SCHEDULE_FULL_OVERVIEW', schedule: currentSimplified }];
  }

  // Clear recent deduplication cache for force alert
  recentAlertsSent.delete(`${norm}:${currentHash}`);
  if (rawNorm) recentAlertsSent.delete(`${rawNorm}:${currentHash}`);

  logger.info(`📢 Force alerting ${uniqueUsers.length} enrolled users of ${canonical}...`);
  await dispatchGroupAlerts(canonical, diffs, uniqueUsers, currentHash);

  return { success: true, groupName: canonical, usersCount: uniqueUsers.length, currentHash, diffCount: diffs.length };
}

/**
 * Returns watcher diagnostic status
 */
function getWatcherStatus() {
  return {
    isBaselineReady,
    isChecking,
    trackedGroupsCount: groupSnapshots.size,
    lastKnownSignature,
    tier1SkipsCount,
    deepChecksCount,
    lastCheckedAt: lastCheckedAt ? new Date(lastCheckedAt).toISOString() : null,
    lastDeepCheckAt: lastDeepCheckAt ? new Date(lastDeepCheckAt).toISOString() : null,
    lastCheckStatus,
  };
}

module.exports = {
  setBotInstance,
  notifyGroupScheduleChanged,
  checkScheduleChanges,
  forceAlertGroup,
  diffGroupSchedules,
  computeScheduleHash,
  formatChangeAlert,
  getWatcherStatus,
};

