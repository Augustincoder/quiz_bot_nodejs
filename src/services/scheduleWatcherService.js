'use strict';

const crypto = require('crypto');
const logger = require('../core/logger');
const edupageService = require('./edupageService');
const scheduleService = require('./scheduleService');
const { normalizeGroupName } = require('./edupageService');

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
  1: { start: '08:30', end: '09:50' },
  2: { start: '10:00', end: '11:20' },
  3: { start: '11:30', end: '12:50' },
  4: { start: '13:30', end: '14:50' },
  5: { start: '15:00', end: '16:20' },
  6: { start: '16:30', end: '17:50' },
  7: { start: '18:00', end: '19:20' },
  8: { start: '19:30', end: '20:50' },
};

const REDIS_WATCHER_KEY = 'cache:schedule:watcher:hashes';

// Internal In-Memory Snapshots
const groupSnapshots = new Map(); // normalizedGroup -> { hash, schedule, groupName }
let lastCheckedAt = 0;
let lastCheckStatus = 'idle';
let isChecking = false;
let isBaselineReady = false;

function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  try {
    return require('./redisService');
  } catch {
    return null;
  }
}

/**
 * Computes deterministic SHA-256 hash of a group's weekly schedule.
 * Ignores non-essential attributes to prevent false positives.
 */
function computeScheduleHash(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'empty';

  const simplified = {};
  for (let d = 0; d < 6; d++) {
    if (!schedule[d]) continue;
    simplified[d] = {};
    const periods = Object.keys(schedule[d]).map(Number).sort((a, b) => a - b);
    for (const p of periods) {
      simplified[d][p] = (schedule[d][p] || []).map(l => ({
        subject: (l.subject || '').trim(),
        teacher: (l.teacher || '').trim(),
        room: (l.room || '').trim(),
      }));
    }
  }

  return crypto.createHash('sha256').update(JSON.stringify(simplified)).digest('hex');
}

/**
 * High-precision schedule diffing algorithm between old and new state.
 */
function diffGroupSchedules(oldSched, newSched) {
  const diffs = [];

  for (let d = 0; d < 6; d++) {
    const oldDay = oldSched?.[d] || {};
    const newDay = newSched?.[d] || {};
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
            changes.push({ kind: 'ADDED_PART', to: `${n.subject} (${n.room})` });
          } else if (o && !n) {
            changes.push({ kind: 'REMOVED_PART', from: `${o.subject} (${o.room})` });
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
  let text = `🔔 <b>DIQQAT! Guruhingiz dars jadvalida o'zgarish kiritildi!</b>\n\n🎓 Guruh: <b>${groupName}</b>\n`;

  for (const diff of diffs) {
    const day = DAY_NAMES[diff.dayIdx] || 'Noma\'lum kun';
    const time = PERIOD_TIMES[diff.period] ? ` <i>(${PERIOD_TIMES[diff.period].start}–${PERIOD_TIMES[diff.period].end})</i>` : '';
    text += `\n📅 <b>${day}, ${diff.period}-para</b>${time}:\n`;

    if (diff.type === 'LESSON_CANCELLED') {
      for (const l of diff.oldLessons) {
        text += `  ❌ <b>Dars bekor qilindi:</b> ${l.subject} (${l.room}-xona)\n`;
      }
    } else if (diff.type === 'LESSON_ADDED') {
      for (const l of diff.newLessons) {
        text += `  ➕ <b>Yangi dars qo'shildi:</b>\n    📖 ${l.subject}\n    🚪 ${l.room}-xona | 👨‍🏫 ${l.teacher}\n`;
      }
    } else if (diff.type === 'MODIFIED') {
      for (const change of diff.changes) {
        if (change.kind === 'ROOM') {
          text += `  🔄 <b>Xona o'zgardi:</b>\n    📖 ${change.subject}\n    ❌ Eski: <s>${change.from}</s>\n    ✅ Yangi: <b>${change.to}</b>\n`;
        } else if (change.kind === 'TEACHER') {
          text += `  👨‍🏫 <b>O'qituvchi almashdi:</b>\n    📖 ${change.subject}\n    ❌ Avval: <s>${change.from}</s>\n    ✅ Yangi: <b>${change.to}</b>\n`;
        } else if (change.kind === 'SUBJECT') {
          text += `  🔄 <b>Fan o'zgardi:</b>\n    ❌ <s>${change.from}</s> ➡️ <b>${change.to}</b>\n`;
        } else {
          text += `  🔄 ${change.from || ''} ➡️ <b>${change.to || ''}</b>\n`;
        }
      }
    }
  }

  text += '\n<i>💡 Yangilangan to\'liq jadvalni ko\'rish uchun /jadval yoki /hafta ni bosing.</i>';
  return text;
}

/**
 * Dispatches targeted alerts to students of affected groups via BullMQ
 */
async function dispatchGroupAlerts(groupName, diffs, allUsers) {
  const normGroup = normalizeGroupName(groupName);
  const matchingUsers = (allUsers || []).filter(u =>
    u.telegram_id && normalizeGroupName(u.class_name) === normGroup
  );

  if (matchingUsers.length === 0) {
    logger.debug('Schedule changed for group with no registered bot users', { groupName });
    return;
  }

  const message = formatChangeAlert(groupName, diffs);

  // Invalidate rendered weekly image cache
  scheduleService.invalidateImageCache(groupName);

  // Enqueue alert notifications into BullMQ
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

  const queue = getBroadcastQueue();
  if (queue) {
    await queue.addBulk(jobs);
    logger.info(`📢 Queued schedule change alert to ${matchingUsers.length} users of ${groupName}`, {
      groupName,
      diffCount: diffs.length,
    });
  } else {
    logger.info(`📢 Schedule change alert generated for ${matchingUsers.length} users of ${groupName} (queue disabled)`, {
      groupName,
      diffCount: diffs.length,
    });
  }
}

/**
 * Checks for schedule changes and notifies users
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
        const storedHashes = await redis.get(REDIS_WATCHER_KEY);
        if (storedHashes) {
          const parsed = JSON.parse(storedHashes);
          for (const [norm, val] of Object.entries(parsed)) {
            groupSnapshots.set(norm, val);
          }
          if (groupSnapshots.size > 0) {
            isBaselineReady = true;
            logger.info('Schedule watcher baseline restored from Redis', { count: groupSnapshots.size });
          }
        }
      } catch (err) {
        logger.warn('Failed to read schedule baseline from Redis', { error: err.message });
      }
    }

    // 2. Fetch active university database
    // On forceDeepCheck or during periodic verification, force a fresh network fetch
    const indexedDb = await edupageService.getTimetableData(forceDeepCheck);
    if (!indexedDb?.r?.dbiAccessorRes?.tables) {
      isChecking = false;
      lastCheckStatus = 'error_empty_tables';
      return { checked: false, reason: 'empty_tables' };
    }

    // Read classes and pre-indexed schedules
    const tables = indexedDb.r.dbiAccessorRes.tables;
    const rawClasses = tables.find(t => t.id === 'classes')?.data_rows || [];

    const changedGroups = [];
    const newHashesForRedis = {};

    // 3. Compare each active group's schedule against previous baseline
    for (const c of rawClasses) {
      const gName = (c.name || c.short || '').trim();
      if (!gName || gName.includes('FAKULTET') || gName.includes('KURS')) continue;

      const norm = normalizeGroupName(gName);
      if (!norm) continue;

      // Get raw schedule object from edupageService
      const currentRawSchedule = await edupageService.getRawSchedule(gName);
      if (!currentRawSchedule || Object.keys(currentRawSchedule).length === 0) continue;

      const currentHash = computeScheduleHash(currentRawSchedule);
      newHashesForRedis[norm] = { hash: currentHash, groupName: gName };

      if (isBaselineReady) {
        const oldEntry = groupSnapshots.get(norm);
        if (oldEntry && oldEntry.hash !== currentHash) {
          const diffs = diffGroupSchedules(oldEntry.schedule, currentRawSchedule);
          if (diffs.length > 0) {
            changedGroups.push({ groupName: gName, norm, diffs });
          }
        }
      }

      // Update in-memory snapshot
      groupSnapshots.set(norm, {
        hash: currentHash,
        schedule: currentRawSchedule,
        groupName: gName,
      });
    }

    // 4. If this was the first run, mark baseline ready without sending alerts
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

      // Fetch users once for all affected groups
      const db = getDbService();
      const allUsers = await db.getAllUsers();
      for (const item of changedGroups) {
        await dispatchGroupAlerts(item.groupName, item.diffs, allUsers);
      }
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

    return {
      checked: true,
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
    lastCheckedAt: lastCheckedAt ? new Date(lastCheckedAt).toISOString() : null,
    lastCheckStatus,
  };
}

module.exports = {
  checkScheduleChanges,
  diffGroupSchedules,
  computeScheduleHash,
  formatChangeAlert,
  getWatcherStatus,
};
