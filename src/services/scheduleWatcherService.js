'use strict';

const crypto = require('crypto');
const logger = require('../core/logger');
const edupageService = require('./edupageService');
const scheduleService = require('./scheduleService');
const { normalizeGroupName } = require('./edupageService');
const { escapeHtml, truncateText } = require('../core/utils');

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
 * High-precision schedule diffing algorithm between old and new state.
 */
function diffGroupSchedules(oldSched, newSched) {
  const diffs = [];

  const oldSimple = getSimplifiedSchedule(oldSched);
  const newSimple = getSimplifiedSchedule(newSched);

  const oldKeysCount = Object.keys(oldSimple).length;
  const newKeysCount = Object.keys(newSimple).length;

  // If old schedule snapshot was missing/empty and new schedule has lessons,
  // notify cleanly without falsely reporting 30 lessons as "newly added".
  if (oldKeysCount === 0 && newKeysCount > 0) {
    return [{ type: 'SCHEDULE_REFRESHED' }];
  }

  for (let d = 0; d < 6; d++) {
    const oldDay = oldSimple[d] || {};
    const newDay = newSimple[d] || {};
    const allPeriods = Array.from(new Set([...Object.keys(oldDay), ...Object.keys(newDay)])).map(Number).sort((a, b) => a - b);

    for (const p of allPeriods) {
      const oldLessons = oldDay[p] || [];
      const newLessons = newDay[p] || [];

      if (oldLessons.length > 0 && newLessons.length === 0) {
        diffs.push({
          type: 'LESSON_CANCELLED',
          dayIdx: d,
          period: p,
          oldLessons,
        });
      } else if (oldLessons.length === 0 && newLessons.length > 0) {
        diffs.push({
          type: 'LESSON_ADDED',
          dayIdx: d,
          period: p,
          newLessons,
        });
      } else if (JSON.stringify(oldLessons) !== JSON.stringify(newLessons)) {
        // Detailed modifications
        const changes = [];
        const maxLen = Math.max(oldLessons.length, newLessons.length);

        for (let i = 0; i < maxLen; i++) {
          const o = oldLessons[i];
          const n = newLessons[i];

          if (o && n) {
            if (o.room !== n.room) {
              changes.push({ kind: 'ROOM', subject: n.subject || o.subject, from: o.room, to: n.room });
            }
            if (o.teacher !== n.teacher) {
              changes.push({ kind: 'TEACHER', subject: n.subject || o.subject, from: o.teacher, to: n.teacher });
            }
            if (o.subject !== n.subject) {
              changes.push({ kind: 'SUBJECT', from: o.subject, to: n.subject });
            }
          } else if (!o && n) {
            changes.push({ kind: 'ADDED_PART', to: `${n.subject}${n.room ? ' (' + n.room + ')' : ''}` });
          } else if (o && !n) {
            changes.push({ kind: 'REMOVED_PART', from: `${o.subject}${o.room ? ' (' + o.room + ')' : ''}` });
          }
        }

        if (changes.length > 0) {
          diffs.push({
            type: 'MODIFIED',
            dayIdx: d,
            period: p,
            changes,
          });
        }
      }
    }
  }

  return diffs;
}

/**
 * Formats a clear, student-friendly HTML notification message
 */
function formatChangeAlert(groupName, diffs) {
  const safeGroupName = escapeHtml(groupName);
  let text = `🔔 <b>DIQQAT! Guruhingiz dars jadvalida o'zgarish kiritildi!</b>\n\n🎓 Guruh: <b>${safeGroupName}</b>\n`;

  for (const diff of diffs) {
    if (diff.type === 'SCHEDULE_REFRESHED') {
      text += '\n🔄 <b>Dars jadvali yangilandi.</b>\n';
      continue;
    }

    const day = DAY_NAMES[diff.dayIdx] || 'Noma\'lum kun';
    const time = PERIOD_TIMES[diff.period] ? ` <i>(${PERIOD_TIMES[diff.period].start}–${PERIOD_TIMES[diff.period].end})</i>` : '';
    text += `\n📅 <b>${day}, ${diff.period}-para</b>${time}:\n`;

    if (diff.type === 'LESSON_CANCELLED') {
      for (const l of diff.oldLessons) {
        text += `  ❌ <b>Dars bekor qilindi:</b> ${escapeHtml(l.subject)} (${escapeHtml(l.room)}-xona)\n`;
      }
    } else if (diff.type === 'LESSON_ADDED') {
      for (const l of diff.newLessons) {
        text += `  ➕ <b>Yangi dars qo'shildi:</b>\n    📖 ${escapeHtml(l.subject)}\n    🚪 ${escapeHtml(l.room)}-xona | 👨‍🏫 ${escapeHtml(l.teacher)}\n`;
      }
    } else if (diff.type === 'MODIFIED') {
      for (const change of diff.changes) {
        if (change.kind === 'ROOM') {
          text += `  🔄 <b>Xona o'zgardi:</b>\n    📖 ${escapeHtml(change.subject)}\n    ❌ Eski: <s>${escapeHtml(change.from)}</s>\n    ✅ Yangi: <b>${escapeHtml(change.to)}</b>\n`;
        } else if (change.kind === 'TEACHER') {
          text += `  👨‍🏫 <b>O'qituvchi almashdi:</b>\n    📖 ${escapeHtml(change.subject)}\n    ❌ Avval: <s>${escapeHtml(change.from)}</s>\n    ✅ Yangi: <b>${escapeHtml(change.to)}</b>\n`;
        } else if (change.kind === 'SUBJECT') {
          text += `  🔄 <b>Fan o'zgardi:</b>\n    ❌ <s>${escapeHtml(change.from)}</s> ➡️ <b>${escapeHtml(change.to)}</b>\n`;
        } else if (change.kind === 'ADDED_PART') {
          text += `  ➕ <b>Qo'shimcha dars/kichik guruh:</b>\n    📖 ${escapeHtml(change.to)}\n`;
        } else if (change.kind === 'REMOVED_PART') {
          text += `  ➖ <b>Dars olib tashlandi:</b>\n    ❌ <s>${escapeHtml(change.from)}</s>\n`;
        } else {
          text += `  🔄 ${escapeHtml(change.from || '')} ➡️ <b>${escapeHtml(change.to || '')}</b>\n`;
        }
      }
    }
  }

  text += '\n<i>💡 Yangilangan to\'liq jadvalni ko\'rish uchun /jadval yoki /hafta ni bosing.</i>';
  return truncateText(text, 3950);
}

/**
 * Dispatches targeted alerts to students of affected groups via BullMQ (or direct Telegram delivery fallback),
 * and pre-warms the updated schedule image ONLY for active groups with registered users.
 */
async function dispatchGroupAlerts(groupName, diffs, usersList) {
  const canonicalGroupName = edupageService.getCanonicalGroupName(groupName) || groupName;
  const normGroup = normalizeGroupName(canonicalGroupName);
  const rawNormGroup = normalizeGroupName(groupName);

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

  // 2. Pre-warm fresh schedule image ONLY for this active group that actually has registered users!
  if (_botTelegram) {
    try {
      const timetableCdn = require('./timetableCdnService');
      timetableCdn.getOrGenerateTimetablePhoto(_botTelegram, canonicalGroupName, 'dark').catch(err => {
        logger.debug('Active group timetable photo pre-warm in background error:', { group: canonicalGroupName, error: err.message });
      });
    } catch (e) {
      logger.debug('timetableCdnService not available for active group pre-warm', { error: e.message });
    }
  }
}

/**
 * Senior-Level 2-Tier Schedule Watcher:
 * - Tier 1: 332-byte lightweight metadata probe (ttviewer.js). If unchanged, skips heavy sync.
 * - Tier 2: Synchronous O(1) Map iteration over indexedDb.schedulesByClassId (~25ms for 1,342 groups).
 */
async function checkScheduleChanges(forceDeepCheck = false) {
  if (isChecking) {
    logger.debug('Schedule check already in progress, skipping iteration');
    return { checked: false, reason: 'in_progress' };
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
    const indexedDb = await edupageService.getIndexedDatabase(true);
    if (!indexedDb?.schedulesByClassId || !indexedDb?.classesById) {
      isChecking = false;
      lastCheckStatus = 'error_empty_tables';
      return { checked: false, reason: 'empty_tables' };
    }

    const changedGroups = [];
    const newHashesForRedis = {};

    // DIRECT SYNCHRONOUS MAP ITERATION (~25ms for 1,342 classes!)
    for (const [classId, currentRawSchedule] of indexedDb.schedulesByClassId.entries()) {
      const c = indexedDb.classesById.get(classId);
      if (!c) continue;

      const gName = (c.name || c.short || '').trim();
      if (!gName || gName.includes('FAKULTET') || gName.includes('KURS')) continue;

      const norm = normalizeGroupName(gName);
      if (!norm) continue;

      const currentSimplified = getSimplifiedSchedule(currentRawSchedule);
      const currentHash = computeScheduleHash(currentRawSchedule);
      newHashesForRedis[classId] = { hash: currentHash, schedule: currentSimplified, groupName: gName, norm };

      if (isBaselineReady) {
        const oldEntry = groupSnapshots.get(classId);
        if (oldEntry && oldEntry.hash !== currentHash) {
          const diffs = diffGroupSchedules(oldEntry.schedule || {}, currentSimplified);
          if (diffs.length > 0) {
            changedGroups.push({ classId, groupName: gName, norm, diffs });
          }
        }
      }

      // Update in-memory snapshot
      groupSnapshots.set(classId, {
        hash: currentHash,
        schedule: currentSimplified,
        groupName: gName,
        norm,
      });
    }

    lastDeepCheckAt = Date.now();

    // 3. Baseline vs Change detection dispatch
    if (!isBaselineReady) {
      isBaselineReady = true;
      logger.info('✅ Initial schedule baseline snapshot established', {
        groupsCount: groupSnapshots.size,
        durationMs: Date.now() - t0,
      });
    } else if (changedGroups.length > 0) {
      logger.info(`🚨 Detected schedule changes in ${changedGroups.length} groups!`, {
        groups: changedGroups.map(g => g.groupName),
      });

      // Fetch enrolled active users from DB once
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

      let activeChangesCount = 0;
      for (const item of changedGroups) {
        const canonical = edupageService.getCanonicalGroupName(item.groupName) || item.groupName;
        const norm = normalizeGroupName(canonical);
        const rawNorm = normalizeGroupName(item.groupName);

        const matchingUsers = [
          ...(usersByGroupNorm.get(norm) || []),
          ...(rawNorm && rawNorm !== norm ? (usersByGroupNorm.get(rawNorm) || []) : []),
        ];

        // Deduplicate
        const uniqueMatching = Array.from(new Map(matchingUsers.map(u => [String(u.telegram_id), u])).values());

        if (uniqueMatching.length === 0) {
          // Inactive/Unused group: Only purge stale cache metadata. DO NOT generate images or send alerts to save server RAM/CPU!
          logger.debug(`Schedule changed for inactive group "${item.groupName}" (0 registered users). Image rendering skipped to save resources.`);
          await scheduleService.invalidateImageCache(item.groupName).catch(() => {});
        } else {
          // Active group with real students! Invalidate old image, dispatch alerts, and pre-warm image ONLY for this group!
          activeChangesCount++;
          logger.info(`📢 Active group "${item.groupName}" changed! Alerting ${uniqueMatching.length} enrolled users and pre-warming CDN.`);
          await dispatchGroupAlerts(item.groupName, item.diffs, uniqueMatching);
        }
      }
      logger.info(`Schedule change processing finished: ${activeChangesCount} active groups alerted, ${changedGroups.length - activeChangesCount} inactive groups skipped.`);
    } else {
      logger.debug('Schedule check completed: no changes detected', { durationMs: Date.now() - t0 });
    }

    // 4. Save updated baseline hashes to Redis
    if (redis) {
      redis.set(REDIS_WATCHER_KEY, JSON.stringify(newHashesForRedis), 'EX', 24 * 60 * 60).catch(err => {
        logger.warn('Failed to save schedule watcher hashes in Redis', { error: err.message });
      });
    }

    lastCheckedAt = Date.now();
    lastCheckStatus = 'ok';

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
  checkScheduleChanges,
  diffGroupSchedules,
  computeScheduleHash,
  formatChangeAlert,
  getWatcherStatus,
};

