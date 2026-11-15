'use strict';

/**
 * Schedule Repository
 * Handles timetable CDN cache, user notification settings, active broadcast subscribers,
 * and smart schedule course notes.
 */

function getPg() {
  return require('../lib/postgres');
}
const pgQuery = (sql, params) => getPg().query(sql, params);
const isPostgresAvailable = () => getPg().isPostgresAvailable();
const { TTLMap } = require('../core/utils');
const redis = require('../services/redisService');
const logger = require('../core/logger');
const { recordDbError, clearDbError } = require('./dbHelper');
const userRepository = require('./userRepository');

// In-memory fallback cache for timetable CDN metadata (bounded to 1000 items)
const fallbackTimetableCache = new TTLMap(24 * 60 * 60 * 1000, 1000);

// Active schedule subscribers L1 in-memory cache (3-minute TTL)
let activeSubscribersCache = null;
let activeSubscribersCacheExpiresAt = 0;
const SUBSCRIBERS_CACHE_TTL_MS = 3 * 60 * 1000;

function invalidateSubscribersCache() {
  activeSubscribersCache = null;
  activeSubscribersCacheExpiresAt = 0;
}

// Due notes L1 in-memory cache (1-minute TTL, max 50 items)
const dueNotesCache = new Map();
const DUE_NOTES_CACHE_TTL_MS = 60 * 1000;
const MAX_DUE_NOTES_CACHE = 50;

function setDueNotesCache(dateStr, data, expiresAt) {
  if (dueNotesCache.size >= MAX_DUE_NOTES_CACHE && !dueNotesCache.has(dateStr)) {
    const oldestKey = dueNotesCache.keys().next().value;
    if (oldestKey !== undefined) dueNotesCache.delete(oldestKey);
  }
  dueNotesCache.set(dateStr, { data, expiresAt });
}

function invalidateDueNotesCache() {
  dueNotesCache.clear();
}

function cleanupDueNotesCache(now = Date.now()) {
  for (const [key, val] of dueNotesCache.entries()) {
    if (val && val.expiresAt <= now) {
      dueNotesCache.delete(key);
    }
  }
}

function sweepScheduleCaches() {
  try {
    fallbackTimetableCache.sweep();
    cleanupDueNotesCache();
  } catch {}
}

async function getScheduleBroadcastUsers() {
  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery(`
        SELECT telegram_id, class_name, is_banned 
        FROM users 
        WHERE class_name IS NOT NULL AND class_name != '' AND is_banned IS NOT TRUE
      `);
      clearDbError();
      return res.rows;
    } catch (pgErr) {
      logger.error('getScheduleBroadcastUsers pg error:', { error: pgErr.message });
    }
  }
  return [];
}

async function getTimetableCache(groupInput, theme) {
  if (!groupInput || !theme) return null;
  const edupageService = require('../services/edupageService');
  const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';

  const canonical = edupageService.getCanonicalGroupName(groupInput);
  const primaryNorm = canonical
    ? edupageService.normalizeGroupName(canonical)
    : edupageService.normalizeGroupName(groupInput);

  const cacheKey = `cache:timetable_cdn:${primaryNorm}:${validTheme}`;

  const l1Hit = fallbackTimetableCache.get(cacheKey);
  if (l1Hit) return l1Hit;

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        fallbackTimetableCache.set(cacheKey, parsed);
        return parsed;
      }
    } catch (e) {
      logger.debug('Redis getTimetableCache error', { error: e.message });
    }
  }

  if (isPostgresAvailable()) {
    try {
      const rawNorm = edupageService.normalizeGroupName(groupInput);
      const res = await pgQuery(`
        SELECT id, group_name, group_normalized, theme, file_id, channel_message_id, schedule_hash, updated_at
        FROM timetable_cache
        WHERE (group_normalized = $1 OR group_normalized = $2 OR group_name ILIKE $3)
          AND theme = $4
        LIMIT 1
      `, [primaryNorm, rawNorm || primaryNorm, canonical || primaryNorm, validTheme]);
      clearDbError();
      if (res.rows.length > 0) {
        const data = res.rows[0];
        fallbackTimetableCache.set(cacheKey, data);
        if (redis) {
          await redis.set(cacheKey, JSON.stringify(data), 'EX', 86400 * 7).catch(() => {});
        }
        return data;
      }
    } catch (pgErr) {
      logger.error('getTimetableCache pg error:', { error: pgErr.message });
    }
  }

  return null;
}

async function upsertTimetableCache({ groupName, groupNormalized, theme, fileId, channelMessageId, scheduleHash }) {
  if ((!groupNormalized && !groupName) || !theme || !fileId) return false;
  const edupageService = require('../services/edupageService');
  const canonical = edupageService.getCanonicalGroupName(groupName || groupNormalized) || (groupName || groupNormalized);
  const norm = edupageService.normalizeGroupName(canonical);
  const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
  const row = {
    group_name: canonical,
    group_normalized: norm,
    theme: validTheme,
    file_id: String(fileId).trim(),
    channel_message_id: channelMessageId ? Number(channelMessageId) : null,
    schedule_hash: String(scheduleHash || '').trim(),
    updated_at: new Date().toISOString(),
  };

  const cacheKey = `cache:timetable_cdn:${norm}:${validTheme}`;

  const existing = fallbackTimetableCache.get(cacheKey);
  const isNoOp = existing &&
    existing.file_id === row.file_id &&
    existing.schedule_hash === row.schedule_hash &&
    (existing.channel_message_id === row.channel_message_id || (!row.channel_message_id && existing.channel_message_id));

  fallbackTimetableCache.set(cacheKey, {
    ...existing,
    ...row,
    channel_message_id: row.channel_message_id || existing?.channel_message_id || null,
  });

  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(row), 'EX', 86400 * 7);
    } catch (e) {
      logger.debug('Redis upsertTimetableCache error', { error: e.message });
    }
  }

  if (isNoOp) {
    return true;
  }

  if (isPostgresAvailable()) {
    try {
      const updateRes = await pgQuery(`
        UPDATE timetable_cache
        SET group_name = $1, file_id = $4, channel_message_id = $5, schedule_hash = $6, updated_at = NOW()
        WHERE group_normalized = $2 AND theme = $3
      `, [row.group_name, row.group_normalized, row.theme, row.file_id, row.channel_message_id, row.schedule_hash]);

      if (updateRes.rowCount === 0) {
        await pgQuery(`
          INSERT INTO timetable_cache (group_name, group_normalized, theme, file_id, channel_message_id, schedule_hash, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, NOW())
        `, [row.group_name, row.group_normalized, row.theme, row.file_id, row.channel_message_id, row.schedule_hash]);
      }
      clearDbError();
      return true;
    } catch (pgErr) {
      logger.error('upsertTimetableCache pg error:', { error: pgErr.message, group: norm, theme: validTheme });
      return false;
    }
  }

  return true;
}

async function deleteTimetableCache(groupInput, theme = null) {
  if (!groupInput) return;
  const edupageService = require('../services/edupageService');
  const canonical = edupageService.getCanonicalGroupName(groupInput) || groupInput;
  const primaryNorm = edupageService.normalizeGroupName(canonical);
  const rawNorm = edupageService.normalizeGroupName(groupInput);
  const rawClean = String(groupInput).toUpperCase().trim();

  const keysToDelete = new Set([primaryNorm, rawNorm, rawClean].filter(Boolean));

  const redisKeys = [];
  for (const n of keysToDelete) {
    if (theme) {
      const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
      fallbackTimetableCache.delete(`cache:timetable_cdn:${n}:${validTheme}`);
      redisKeys.push(`cache:timetable_cdn:${n}:${validTheme}`);
    } else {
      ['dark', 'light', 'vibrant'].forEach(t => {
        fallbackTimetableCache.delete(`cache:timetable_cdn:${n}:${t}`);
        redisKeys.push(`cache:timetable_cdn:${n}:${t}`);
      });
    }
  }

  if (redis && redisKeys.length > 0) {
    await redis.del(redisKeys).catch(() => {});
  }

  if (isPostgresAvailable()) {
    try {
      for (const n of keysToDelete) {
        if (theme) {
          await pgQuery('DELETE FROM timetable_cache WHERE group_normalized = $1 AND theme = $2', [n, theme]);
        } else {
          await pgQuery('DELETE FROM timetable_cache WHERE group_normalized = $1', [n]);
        }
      }
      if (canonical) {
        if (theme) {
          await pgQuery('DELETE FROM timetable_cache WHERE group_name ILIKE $1 AND theme = $2', [canonical, theme]);
        } else {
          await pgQuery('DELETE FROM timetable_cache WHERE group_name ILIKE $1', [canonical]);
        }
      }
      clearDbError();
    } catch (pgErr) {
      logger.error('PostgreSQL deleteTimetableCache error:', { error: pgErr.message });
    }
  }
}

async function getAllCachedTimetables() {
  const fallbackList = [];
  if (fallbackTimetableCache.size > 0) {
    for (const val of fallbackTimetableCache.values()) {
      if (val && val.group_normalized) fallbackList.push(val);
    }
  }

  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT group_name, group_normalized, theme, file_id, schedule_hash, channel_message_id, updated_at FROM timetable_cache');
      clearDbError();
      return res.rows.length > 0 ? res.rows : fallbackList;
    } catch (pgErr) {
      logger.error('getAllCachedTimetables pg error:', { error: pgErr.message });
    }
  }

  return fallbackList;
}

async function clearAllTimetableCache() {
  fallbackTimetableCache.clear();
  if (redis) {
    try {
      if (typeof redis.scanStream === 'function') {
        await new Promise((resolve, reject) => {
          const stream = redis.scanStream({ match: 'cache:timetable_cdn:*', count: 100 });
          stream.on('data', (keys) => {
            if (keys && keys.length > 0) {
              stream.pause();
              redis.del(keys)
                .catch(delErr => logger.warn('Redis del batch error during scan:', { error: delErr.message }))
                .finally(() => stream.resume());
            }
          });
          stream.on('error', (err) => {
            logger.error('Redis scanStream error during timetable cache clearance:', { error: err.message });
            reject(err);
          });
          stream.on('end', () => {
            logger.info('Finished scanning and clearing Redis timetable CDN cache.');
            resolve();
          });
        });
      } else {
        const keys = await redis.keys('cache:timetable_cdn:*');
        if (keys && keys.length > 0) {
          await redis.del(keys);
        }
      }
    } catch (e) {
      logger.error('Error clearing Redis timetable cache:', { error: e.message });
    }
  }

  if (isPostgresAvailable()) {
    try {
      await pgQuery('DELETE FROM timetable_cache');
      clearDbError();
      logger.info('Cleared PostgreSQL timetable_cache table.');
    } catch (pgErr) {
      logger.error('Error clearing PostgreSQL timetable cache:', { error: pgErr.message });
    }
  }
}

async function getUserScheduleSettings(telegramId) {
  const uid = Number(telegramId);
  const defaultSettings = {
    telegram_id: uid,
    group_name: null,
    notify_mode: 'shift_aware',
    offset_minutes: 60,
    custom_morning_time: '07:00',
    custom_evening_time: '20:00',
    pre_class_5min_bell: true,
    building_change_alert: true,
    quiet_hours_enabled: true,
    schedule_notifications: true,
  };

  if (!uid) return defaultSettings;

  try {
    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery('SELECT * FROM user_schedule_settings WHERE telegram_id = $1 LIMIT 1', [uid]);
        if (res.rows.length > 0) {
          const data = res.rows[0];
          let groupName = data.group_name;
          if (!groupName) {
            const userRow = await userRepository.getUserByTelegramId(uid);
            groupName = userRow?.student_group || userRow?.class_name || null;
          }
          return {
            telegram_id: uid,
            group_name: groupName,
            notify_mode: data.notify_mode || 'shift_aware',
            offset_minutes: Number(data.offset_minutes) || 60,
            custom_morning_time: data.custom_morning_time || '07:00',
            custom_evening_time: data.custom_evening_time || '20:00',
            pre_class_5min_bell: data.pre_class_5min_bell !== false,
            building_change_alert: data.building_change_alert !== false,
            quiet_hours_enabled: data.quiet_hours_enabled !== false,
            schedule_notifications: data.notify_mode !== 'disabled',
          };
        }
      } catch (pgErr) {
        logger.warn('getUserScheduleSettings Postgres error:', { error: pgErr.message });
      }
    }

    const userRow = await userRepository.getUserByTelegramId(uid);
    if (userRow) {
      const groupName = userRow.student_group || userRow.class_name || null;
      return {
        telegram_id: uid,
        group_name: groupName,
        notify_mode: userRow.notif_mode || 'shift_aware',
        offset_minutes: Number(userRow.notif_offset_min) || 60,
        custom_morning_time: userRow.notif_custom_time || '07:00',
        custom_evening_time: '20:00',
        pre_class_5min_bell: userRow.notif_next_bell !== false,
        building_change_alert: true,
        quiet_hours_enabled: true,
        schedule_notifications: userRow.schedule_notifications !== false && userRow.notif_mode !== 'disabled',
      };
    }
  } catch (err) {
    logger.warn('getUserScheduleSettings error:', { telegramId: uid, error: err.message });
  }

  return defaultSettings;
}

async function upsertUserScheduleSettings(telegramId, patch) {
  const uid = Number(telegramId);
  if (!uid || !patch || typeof patch !== 'object') return false;

  try {
    let groupName = patch.group_name;
    if (!groupName) {
      const currentGroup = await userRepository.getUserClass(uid);
      if (currentGroup) groupName = currentGroup;
    }

    if (isPostgresAvailable()) {
      try {
        const allowedKeys = [
          'group_name', 'notify_mode', 'offset_minutes', 'custom_morning_time',
          'custom_evening_time', 'pre_class_5min_bell', 'building_change_alert', 'quiet_hours_enabled'
        ];
        const fields = ['telegram_id'];
        const values = [uid];
        const updateClauses = [];

        if (groupName !== undefined) {
          fields.push('group_name');
          values.push(groupName);
          updateClauses.push('group_name = EXCLUDED.group_name');
        }

        for (const [k, v] of Object.entries(patch)) {
          if (allowedKeys.includes(k) && k !== 'group_name' && v !== undefined) {
            fields.push(k);
            values.push(v);
            updateClauses.push(`${k} = EXCLUDED.${k}`);
          }
        }

        updateClauses.push('updated_at = NOW()');
        const placeholders = fields.map((_, i) => `$${i + 1}`).join(', ');
        const sql = `
          INSERT INTO user_schedule_settings (${fields.join(', ')}, updated_at)
          VALUES (${placeholders}, NOW())
          ON CONFLICT (telegram_id) DO UPDATE SET
            ${updateClauses.join(', ')};
        `;
        await pgQuery(sql, values);

        const userUpdates = [];
        const userVals = [];
        let uIdx = 1;
        if (patch.notify_mode !== undefined) {
          userUpdates.push(`notif_mode = $${uIdx++}`);
          userVals.push(patch.notify_mode);
        }
        if (patch.offset_minutes !== undefined) {
          userUpdates.push(`notif_offset_min = $${uIdx++}`);
          userVals.push(Number(patch.offset_minutes));
        }
        if (patch.custom_morning_time !== undefined) {
          userUpdates.push(`notif_custom_time = $${uIdx++}`);
          userVals.push(patch.custom_morning_time);
        }
        if (patch.pre_class_5min_bell !== undefined) {
          userUpdates.push(`notif_next_bell = $${uIdx++}`);
          userVals.push(Boolean(patch.pre_class_5min_bell));
        }
        if (groupName !== undefined) {
          userUpdates.push(`class_name = $${uIdx++}`);
          userVals.push(groupName);
        }
        if (userUpdates.length > 0) {
          userVals.push(String(telegramId));
          await pgQuery(`UPDATE users SET ${userUpdates.join(', ')} WHERE telegram_id = $${uIdx}`, userVals).catch(() => {});
        }

        invalidateSubscribersCache();
        return true;
      } catch (pgErr) {
        logger.warn('upsertUserScheduleSettings Postgres error:', { error: pgErr.message });
      }
    }
  } catch (err) {
    logger.error('upsertUserScheduleSettings exception:', { telegramId: uid, error: err.message });
  }

  return false;
}

async function getAllActiveScheduleSubscribers(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && activeSubscribersCache && now < activeSubscribersCacheExpiresAt) {
    return activeSubscribersCache;
  }

  const subscriberMap = new Map();

  if (isPostgresAvailable()) {
    try {
      const sql = `
        SELECT 
          u.telegram_id,
          u.class_name,
          u.is_banned,
          s.group_name,
          s.notify_mode,
          s.offset_minutes,
          s.custom_morning_time,
          s.custom_evening_time,
          s.pre_class_5min_bell,
          s.building_change_alert,
          s.quiet_hours_enabled
        FROM users u
        LEFT JOIN user_schedule_settings s ON u.telegram_id = s.telegram_id::text
        WHERE u.class_name IS NOT NULL
          AND (u.is_banned IS NULL OR u.is_banned = FALSE);
      `;
      const res = await pgQuery(sql);
      for (const row of res.rows) {
        const uid = Number(row.telegram_id);
        if (userRepository.localBlockedUsers.has(String(uid))) continue;
        if (row.notify_mode === 'disabled') continue;

        const resolvedGroup = row.group_name || row.class_name;
        if (!resolvedGroup) continue;

        subscriberMap.set(uid, {
          telegram_id: uid,
          group_name: resolvedGroup,
          notify_mode: row.notify_mode || 'shift_aware',
          offset_minutes: row.offset_minutes != null ? Number(row.offset_minutes) : 60,
          custom_morning_time: row.custom_morning_time || '07:00',
          custom_evening_time: row.custom_evening_time || '20:00',
          pre_class_5min_bell: row.pre_class_5min_bell !== false,
          building_change_alert: row.building_change_alert !== false,
          quiet_hours_enabled: row.quiet_hours_enabled !== false,
          schedule_notifications: true,
        });
      }
      activeSubscribersCache = Array.from(subscriberMap.values());
      activeSubscribersCacheExpiresAt = Date.now() + SUBSCRIBERS_CACHE_TTL_MS;
      return activeSubscribersCache;
    } catch (pgErr) {
      logger.warn('getAllActiveScheduleSubscribers Postgres error:', { error: pgErr.message });
      if (activeSubscribersCache && activeSubscribersCache.length > 0) {
        activeSubscribersCacheExpiresAt = Date.now() + 30000;
        return activeSubscribersCache;
      }
    }
  }

  activeSubscribersCache = Array.from(subscriberMap.values());
  activeSubscribersCacheExpiresAt = Date.now() + SUBSCRIBERS_CACHE_TTL_MS;
  return activeSubscribersCache;
}

async function createCourseNote(payload) {
  if (!payload) return null;
  const cId = Number(payload.creator_id);
  if (!cId || isNaN(cId)) return null;

  try {
    const record = {
      creator_id: cId,
      group_name: payload.group_name,
      is_group_shared: Boolean(payload.is_group_shared ?? payload.is_group_note ?? false),
      subject_name: payload.subject_name,
      subject_norm: payload.subject_norm || (payload.subject_name || '').toLowerCase().trim(),
      target_lesson_type: (payload.target_lesson_type || 'any').toLowerCase(),
      target_date: payload.target_date,
      target_period: Number(payload.target_period) || 1,
      target_start_time: payload.target_start_time || null,
      note_text: payload.note_text ? String(payload.note_text).slice(0, 2000) : null,
      media_file_id: payload.media_file_id || null,
      media_type: payload.media_type || null,
      status: payload.status || 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (isPostgresAvailable()) {
      try {
        const sql = `
          INSERT INTO course_notes (
            creator_id, group_name, is_group_shared, subject_name, subject_norm,
            target_lesson_type, target_date, target_period, target_start_time,
            note_text, media_file_id, media_type, status, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW()
          ) RETURNING *;
        `;
        const values = [
          record.creator_id, record.group_name, record.is_group_shared,
          record.subject_name, record.subject_norm, record.target_lesson_type,
          record.target_date, record.target_period, record.target_start_time,
          record.note_text, record.media_file_id, record.media_type, record.status,
        ];
        const res = await pgQuery(sql, values);
        invalidateDueNotesCache();
        return res.rows[0] || null;
      } catch (pgErr) {
        logger.warn('createCourseNote Postgres error:', { error: pgErr.message });
      }
    }

    return null;
  } catch (err) {
    logger.error('createCourseNote exception:', { error: err.message });
    return null;
  }
}

async function getDueNotesForLesson(telegramId, groupName, dateStr) {
  if (!dateStr) return [];
  const isGlobalDateQuery = !telegramId && !groupName;
  const now = Date.now();

  if (isGlobalDateQuery && dueNotesCache.has(dateStr)) {
    const cached = dueNotesCache.get(dateStr);
    if (now < cached.expiresAt) {
      return cached.data;
    }
    dueNotesCache.delete(dateStr);
  }

  if (isPostgresAvailable()) {
    try {
      let sql = `
        SELECT * FROM course_notes
        WHERE status IN ('pending', 'notified_evening', 'snoozed')
          AND target_date = $1
      `;
      const params = [dateStr];

      if (telegramId && groupName) {
        const tid = Number(telegramId);
        params.push(isNaN(tid) ? 0 : tid, String(groupName).trim());
        sql += ' AND (creator_id = $2 OR (is_group_shared = TRUE AND group_name = $3))';
      } else if (groupName) {
        params.push(String(groupName).trim());
        sql += ' AND group_name = $2';
      } else if (telegramId) {
        const tid = Number(telegramId);
        params.push(isNaN(tid) ? 0 : tid);
        sql += ' AND creator_id = $2';
      }

      const res = await pgQuery(sql, params);
      const resData = res.rows || [];
      if (isGlobalDateQuery) {
        setDueNotesCache(dateStr, resData, now + DUE_NOTES_CACHE_TTL_MS);
      }
      return resData;
    } catch (pgErr) {
      logger.warn('getDueNotesForLesson Postgres error:', { error: pgErr.message });
    }
  }

  if (isGlobalDateQuery && dueNotesCache.has(dateStr)) {
    return dueNotesCache.get(dateStr).data;
  }
  return [];
}

async function getNoteById(noteId) {
  if (!noteId) return null;
  const id = Number(noteId);

  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT * FROM course_notes WHERE id = $1 LIMIT 1', [id]);
      if (res.rows.length > 0) return res.rows[0];
      const altRes = await pgQuery('SELECT * FROM class_notes WHERE id = $1 LIMIT 1', [id]).catch(() => ({ rows: [] }));
      if (altRes.rows.length > 0) return altRes.rows[0];
      return null;
    } catch (pgErr) {
      logger.warn('getNoteById Postgres error:', { error: pgErr.message });
    }
  }

  return null;
}

async function updateNoteStatus(noteId, telegramId, newStatus, newTargetDate = null, newTargetPeriod = null, newStartTime = null, extraFields = null) {
  if (!noteId) return false;
  const id = Number(noteId);
  if (!id || isNaN(id)) return false;

  if (isPostgresAvailable()) {
    try {
      const sets = ['updated_at = NOW()'];
      const params = [];
      let pIdx = 1;

      if (newStatus === 'notified_before_class') {
        sets.push('notified_before_class_at = NOW()');
      } else if (newStatus) {
        params.push(newStatus);
        sets.push(`status = $${pIdx++}`);
        if (newStatus === 'notified_evening') {
          sets.push('notified_evening_at = NOW()');
        }
      }

      if (newStatus === 'snoozed' || newTargetDate) {
        sets.push('notified_before_class_at = NULL');
        sets.push('notified_evening_at = NULL');
      }

      if (newTargetDate) {
        params.push(newTargetDate);
        sets.push(`target_date = $${pIdx++}`);
      }
      if (newTargetPeriod != null) {
        params.push(Number(newTargetPeriod));
        sets.push(`target_period = $${pIdx++}`);
      }
      if (newStartTime) {
        params.push(newStartTime);
        sets.push(`target_start_time = $${pIdx++}`);
      }
      if (extraFields && typeof extraFields === 'object') {
        for (const [k, v] of Object.entries(extraFields)) {
          params.push(v);
          sets.push(`${k} = $${pIdx++}`);
        }
      }

      params.push(id);
      let whereClause = `WHERE id = $${pIdx++}`;
      if (telegramId) {
        const tid = Number(telegramId);
        if (!isNaN(tid)) {
          params.push(tid);
          whereClause += ` AND creator_id = $${pIdx++}`;
        }
      }

      const sql = `UPDATE course_notes SET ${sets.join(', ')} ${whereClause}`;
      const res = await pgQuery(sql, params);
      invalidateDueNotesCache();
      return (res.rowCount || 0) > 0;
    } catch (pgErr) {
      logger.warn('updateNoteStatus Postgres error:', { error: pgErr.message });
    }
  }

  return false;
}

async function getUserActiveNotes(telegramId, groupName = null) {
  if (!telegramId) return [];
  const uid = Number(telegramId);
  if (!uid || isNaN(uid)) return [];
  const edupageService = require('../services/edupageService');
  const nowTz = edupageService.getTashkentNow();
  const todayIso = `${nowTz.getFullYear()}-${String(nowTz.getMonth() + 1).padStart(2, '0')}-${String(nowTz.getDate()).padStart(2, '0')}`;

  if (isPostgresAvailable()) {
    try {
      let sql = `
        SELECT * FROM course_notes
        WHERE status IN ('pending', 'notified_evening', 'snoozed')
          AND target_date >= $1
      `;
      const params = [todayIso];

      if (groupName) {
        params.push(uid, String(groupName).trim());
        sql += ' AND (creator_id = $2 OR (is_group_shared = TRUE AND group_name = $3))';
      } else {
        params.push(uid);
        sql += ' AND creator_id = $2';
      }

      sql += ' ORDER BY target_date ASC, target_period ASC';

      const res = await pgQuery(sql, params);
      return res.rows || [];
    } catch (pgErr) {
      logger.warn('getUserActiveNotes Postgres error:', { error: pgErr.message });
    }
  }

  return [];
}

module.exports = {
  getScheduleBroadcastUsers,
  getTimetableCache,
  upsertTimetableCache,
  deleteTimetableCache,
  getAllCachedTimetables,
  clearAllTimetableCache,
  getUserScheduleSettings,
  upsertUserScheduleSettings,
  getAllActiveScheduleSubscribers,
  createCourseNote,
  getDueNotesForLesson,
  getNoteById,
  updateNoteStatus,
  getUserActiveNotes,
  invalidateSubscribersCache,
  invalidateDueNotesCache,
  cleanupDueNotesCache,
  setDueNotesCache,
  fallbackTimetableCache,
  sweepScheduleCaches,
};
