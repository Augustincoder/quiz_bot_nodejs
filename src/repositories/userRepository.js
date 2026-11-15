'use strict';

/**
 * User Repository
 * Handles all user profile, statistics, ranking, ban/block, and preferences persistence.
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

// Bounded in-memory caches (24-hour TTL, max 5,000 users)
const localUserClasses = new TTLMap(24 * 60 * 60 * 1000, 5000);
const localUserThemes = new TTLMap(24 * 60 * 60 * 1000, 5000);
const userBannedL1Cache = new TTLMap(30 * 1000, 2000);
const localBlockedUsers = new TTLMap(7 * 24 * 60 * 60 * 1000, 2000);

// In-memory per-user update serialization queue to prevent lost updates on concurrent completions
const userStatsQueues = new Map();

function sweepUserCaches() {
  try {
    localUserClasses.sweep();
    localUserThemes.sweep();
    userBannedL1Cache.sweep();
    localBlockedUsers.sweep();
  } catch {}
}

async function getUserStats(userId) {
  const uid = String(userId);
  const cacheKey = `cache:user_stats:${uid}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery('SELECT * FROM user_stats WHERE user_id = $1 LIMIT 1', [uid]);
        clearDbError();
        if (res.rows.length > 0) {
          const data = res.rows[0];
          if (typeof data.history === 'string') {
            try { data.history = JSON.parse(data.history); } catch { data.history = []; }
          }
          if (typeof data.shelf === 'string') {
            try { data.shelf = JSON.parse(data.shelf); } catch { data.shelf = {}; }
          }
          if (!data.history) data.history = [];
          if (!data.shelf) data.shelf = {};
          await redis.set(cacheKey, JSON.stringify(data), 'EX', 86400).catch(() => {});
          return data;
        }
        return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [], shelf: {} };
      } catch (pgErr) {
        logger.error('getUserStats pg error:', { userId: uid, error: pgErr.message });
        recordDbError(pgErr);
        return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [], _fetchFailed: true };
      }
    }

    return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [] };
  } catch (err) {
    logger.error('getUserStats error:', { userId: uid, error: err.message });
    recordDbError(err);
    return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [], _fetchFailed: true };
  }
}

async function getUsersStatsSummaryByIds(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map();
  const stringIds = userIds.map(id => String(id));
  const resultMap = new Map();

  const missingIds = [];
  await Promise.all(
    stringIds.map(async (uid) => {
      try {
        if (redis) {
          const cached = await redis.get(`cache:user_stats:${uid}`) || await redis.get(`cache:user_stats_summary:${uid}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            resultMap.set(uid, {
              user_id: uid,
              tests_completed: parsed.tests_completed || 0,
              total_correct: parsed.total_correct || 0,
              total_wrong: parsed.total_wrong || 0,
              history: parsed.history || [],
            });
            return;
          }
        }
      } catch {}
      missingIds.push(uid);
    })
  );

  if (missingIds.length > 0 && isPostgresAvailable()) {
    try {
      const res = await pgQuery(
        'SELECT user_id, tests_completed, total_correct, total_wrong, history FROM user_stats WHERE user_id = ANY($1)',
        [missingIds]
      );
      clearDbError();
      for (const row of res.rows) {
        let history = row.history;
        if (typeof history === 'string') {
          try { history = JSON.parse(history); } catch { history = []; }
        }
        resultMap.set(String(row.user_id), {
          user_id: String(row.user_id),
          tests_completed: row.tests_completed || 0,
          total_correct: row.total_correct || 0,
          total_wrong: row.total_wrong || 0,
          history: Array.isArray(history) ? history : [],
        });
        if (redis) {
          redis.set(`cache:user_stats_summary:${row.user_id}`, JSON.stringify(row), 'EX', 300).catch(() => {});
        }
      }
    } catch (pgErr) {
      logger.error('getUsersStatsSummaryByIds pg error:', { error: pgErr.message, missingIds });
    }
  }

  for (const uid of stringIds) {
    if (!resultMap.has(uid)) {
      resultMap.set(uid, {
        user_id: uid,
        tests_completed: 0,
        total_correct: 0,
        total_wrong: 0,
        history: [],
      });
    }
  }

  return resultMap;
}

async function updateUserStats(userId, correct, wrong, subjectKey, testId, mistakes) {
  const uid = String(userId);
  const prevPromise = userStatsQueues.get(uid) || Promise.resolve();

  const currentPromise = (async () => {
    try {
      await prevPromise;
    } catch {}

    const stats = await getUserStats(uid);
    if (stats._fetchFailed) {
      logger.error('updateUserStats aborted: could not retrieve user stats due to DB error. Historical data protected.', { userId: uid });
      return;
    }
    stats.tests_completed = (stats.tests_completed || 0) + 1;
    stats.total_correct = (stats.total_correct || 0) + correct;
    stats.total_wrong = (stats.total_wrong || 0) + wrong;

    const totalQ = (correct || 0) + (wrong || 0);
    const percent = totalQ > 0 ? Math.round(((correct || 0) / totalQ) * 100) : 0;
    const entry = {
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      timestamp: Date.now(),
      subject: subjectKey,
      test_id: testId,
      correct,
      wrong,
      percent,
      mistakes,
    };
    if (!Array.isArray(stats.history)) stats.history = [];
    stats.history.unshift(entry);
    stats.history = stats.history.slice(0, 15);

    try {
      delete stats._fetchFailed;
      stats.user_id = uid;

      if (isPostgresAvailable()) {
        try {
          await pgQuery(`
            INSERT INTO user_stats (user_id, tests_completed, total_correct, total_wrong, history)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (user_id)
            DO UPDATE SET
              tests_completed = EXCLUDED.tests_completed,
              total_correct = EXCLUDED.total_correct,
              total_wrong = EXCLUDED.total_wrong,
              history = EXCLUDED.history;
          `, [uid, stats.tests_completed, stats.total_correct, stats.total_wrong, JSON.stringify(stats.history)]);
          clearDbError();
        } catch (pgErr) {
          logger.error('updateUserStats pg error:', { userId: uid, error: pgErr.message });
        }
      }

      await redis.set(`cache:user_stats:${uid}`, JSON.stringify(stats), 'EX', 300).catch(() => {});
      if (correct > 0) {
        await redis.del('cache:leaderboard:top10').catch(() => {});
      }
    } catch (e) {
      logger.error('Stats saqlashda xato:', { userId: uid, error: e.message });
    }
  })();

  userStatsQueues.set(uid, currentPromise);
  try {
    return await currentPromise;
  } finally {
    if (userStatsQueues.get(uid) === currentPromise) {
      userStatsQueues.delete(uid);
    }
  }
}

async function getUserRank(userId, knownTotalCorrect = null) {
  try {
    const uid = String(userId);
    let correct = knownTotalCorrect;
    if (correct === null || correct === undefined) {
      const stats = await getUserStats(uid);
      correct = stats?.total_correct ?? 0;
    }
    const numCorrect = parseInt(correct, 10);
    if (isNaN(numCorrect) || numCorrect <= 0) return 'N/A';

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery('SELECT COUNT(*) as count FROM user_stats WHERE total_correct > $1', [numCorrect]);
        clearDbError();
        return parseInt(res.rows[0].count, 10) + 1;
      } catch (pgErr) {
        logger.error('getUserRank pg error:', { error: pgErr.message });
        recordDbError(pgErr);
      }
    }
    return 'N/A';
  } catch (err) {
    logger.error('getUserRank error:', { userId, error: err.message });
    return 'N/A';
  }
}

async function getTopUsers(limit = 10) {
  try {
    const numLimit = Math.max(1, parseInt(limit, 10) || 10);
    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery(
          'SELECT user_id, total_correct, tests_completed FROM user_stats WHERE total_correct > 0 ORDER BY total_correct DESC LIMIT $1',
          [numLimit]
        );
        clearDbError();
        return res.rows.map(s => ({
          user_id: s.user_id,
          correct: s.total_correct,
          completed: s.tests_completed,
        }));
      } catch (pgErr) {
        logger.error('getTopUsers pg error:', { error: pgErr.message });
        recordDbError(pgErr);
      }
    }
    return [];
  } catch (e) {
    logger.error('getTopUsers error:', { error: e.message });
    return [];
  }
}

async function getAllUserStats(options = {}) {
  const includeHistory = options.includeHistory !== false;
  const selectFields = includeHistory
    ? 'user_id, total_correct, total_wrong, tests_completed, history'
    : 'user_id, total_correct, total_wrong, tests_completed';

  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery(`SELECT ${selectFields} FROM user_stats`);
      clearDbError();
      return res.rows;
    } catch (pgErr) {
      logger.error('getAllUserStats pg error:', { error: pgErr.message });
      recordDbError(pgErr);
    }
  }
  return [];
}

async function getAggregatedAdminStats() {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const defaults = {
    totalUsers  : 0,
    activeUsers : 0,
    totalTests  : 0,
    todayTests  : 0,
    avgScore    : 0,
    totalCorrect: 0,
    totalWrong  : 0,
  };

  if (isPostgresAvailable()) {
    try {
      // Xavfsiz SQL: sevenDaysAgo va todayStart asosida active_users va todayTests aniq hisoblanadi
      const sql = `
        SELECT 
          (SELECT COUNT(*) FROM users) AS total_users,
          COUNT(*) FILTER (
            WHERE jsonb_typeof(
              CASE 
                WHEN history IS NOT NULL AND history::text != '' AND history::text != 'null' THEN history::jsonb 
                ELSE '[]'::jsonb 
              END
            ) = 'array'
              AND jsonb_array_length(
                CASE 
                  WHEN history IS NOT NULL AND history::text != '' AND history::text != 'null' THEN history::jsonb 
                  ELSE '[]'::jsonb 
                END
              ) > 0
              AND COALESCE(
                (
                  (CASE 
                    WHEN history IS NOT NULL AND history::text != '' AND history::text != 'null' THEN history::jsonb 
                    ELSE '[]'::jsonb 
                  END)->0->>'timestamp'
                )::bigint, 
                0
              ) >= $1
          ) AS active_users,
          COALESCE(SUM(tests_completed), 0) AS total_tests,
          COALESCE(SUM(total_correct), 0) AS total_correct,
          COALESCE(SUM(total_wrong), 0) AS total_wrong
        FROM user_stats;
      `;
      const res = await pgQuery(sql, [sevenDaysAgo]);
      clearDbError();
      const row = res.rows[0] || {};
      const totalUsers = parseInt(row.total_users || 0, 10);
      const activeUsers = parseInt(row.active_users || 0, 10);
      const totalTests = parseInt(row.total_tests || 0, 10);
      const totalCorrect = parseInt(row.total_correct || 0, 10);
      const totalWrong = parseInt(row.total_wrong || 0, 10);
      const totalAnswers = totalCorrect + totalWrong;
      const avgScore = totalAnswers > 0 ? Math.round((totalCorrect / totalAnswers) * 100) : 0;

      let bySubject = null;
      let todayTestsCount = 0;
      try {
        const subjSql = `
          SELECT 
            elem->>'subject' AS subject,
            COUNT(*) AS cnt,
            COUNT(*) FILTER (WHERE COALESCE((elem->>'timestamp')::bigint, 0) >= $1) AS today_cnt,
            COALESCE(SUM( NULLIF(elem->>'correct', '')::int ), 0) AS corr,
            COALESCE(SUM( NULLIF(elem->>'wrong', '')::int ), 0) AS wrng
          FROM user_stats,
          LATERAL jsonb_array_elements(
            CASE 
              WHEN history IS NOT NULL AND history::text != '' AND history::text != 'null' AND jsonb_typeof(history::jsonb) = 'array' THEN history::jsonb 
              ELSE '[]'::jsonb 
            END
          ) AS elem
          WHERE elem->>'subject' IS NOT NULL
          GROUP BY elem->>'subject';
        `;
        const subjRes = await pgQuery(subjSql, [todayStart]);
        bySubject = {};
        for (const r of subjRes.rows) {
          const s = r.subject;
          todayTestsCount += parseInt(r.today_cnt || 0, 10);
          bySubject[s] = {
            count: parseInt(r.cnt || 0, 10),
            correct: parseInt(r.corr || 0, 10),
            wrong: parseInt(r.wrng || 0, 10),
          };
        }
      } catch (subjErr) {
        logger.debug('bySubject SQL aggregation fallback:', { error: subjErr.message });
      }

      return {
        totalUsers,
        activeUsers,
        totalTests,
        todayTests: todayTestsCount,
        avgScore,
        totalCorrect,
        totalWrong,
        bySubject,
      };
    } catch (pgErr) {
      logger.error('getAggregatedAdminStats pg error:', { error: pgErr.message });
      recordDbError(pgErr);
    }
  }

  // Graceful fallback for offline / memory mode
  try {
    const totalUsers = await getUserCount();
    if (!totalUsers) return defaults;

    const allStats = await getAllUserStats();
    let activeUsers  = 0;
    let totalTests   = 0;
    let todayTests   = 0;
    let totalCorrect = 0;
    let totalWrong   = 0;

    for (const stat of allStats) {
      const history = stat.history;
      if (!Array.isArray(history) || !history.length) {
        totalCorrect += stat.total_correct || 0;
        totalWrong   += stat.total_wrong   || 0;
        totalTests   += stat.tests_completed || 0;
        continue;
      }

      let isActive    = false;
      let todayCount  = 0;

      for (const h of history) {
        const ts = h.timestamp ? (typeof h.timestamp === 'string' ? new Date(h.timestamp).getTime() : h.timestamp) : 0;
        if (!isActive && ts > sevenDaysAgo) isActive = true;
        if (ts > todayStart) todayCount++;
        totalCorrect += h.correct || 0;
        totalWrong   += h.wrong   || 0;
      }

      if (isActive) activeUsers++;
      totalTests += history.length;
      todayTests += todayCount;
    }

    const totalAnswers = totalCorrect + totalWrong;
    return {
      totalUsers,
      activeUsers,
      totalTests,
      todayTests,
      avgScore    : totalAnswers ? Math.round((totalCorrect / totalAnswers) * 100) : 0,
      totalCorrect,
      totalWrong,
    };
  } catch (err) {
    logger.error('getAggregatedAdminStats fallback error:', { error: err.message });
    return defaults;
  }
}

async function registerUser(userId, fullName, username) {
  const uid = String(userId);
  try {
    localBlockedUsers.delete(uid);
    if (redis) {
      await redis.del(`user_blocked:${uid}`).catch(() => {});
    }

    const seenKey = `user_registered:${uid}`;
    const alreadyRegistered = await redis.get(seenKey);
    if (alreadyRegistered) return;

    if (isPostgresAvailable()) {
      try {
        await pgQuery(`
          INSERT INTO users (telegram_id, full_name, username, joined_at)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (telegram_id) DO NOTHING
        `, [uid, fullName || 'Ismsiz', username || "yo'q", new Date().toISOString().slice(0, 16).replace('T', ' ')]);
        clearDbError();
        await redis.set(seenKey, '1', 'EX', 86400 * 7).catch(() => {});
        return;
      } catch (pgErr) {
        logger.error('registerUser pg error:', { error: pgErr.message });
      }
    }
  } catch (err) {
    logger.error('registerUser error:', { userId: uid, error: err.message });
  }
}

async function getUserCount() {
  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT COUNT(*) as count FROM users');
      clearDbError();
      return parseInt(res.rows[0].count, 10);
    } catch (pgErr) {
      logger.error('getUserCount pg error:', { error: pgErr.message });
    }
  }

  try {
    const storage = require('../core/storage');
    const stats = await storage.getUsersStats();
    return Object.keys(stats || {}).length;
  } catch {
    return 0;
  }
}

async function getUserByTelegramId(userId) {
  const uid = String(userId);
  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [uid]);
      clearDbError();
      return res.rows[0] || null;
    } catch (pgErr) {
      logger.error('getUserByTelegramId pg error:', { userId, error: pgErr.message });
    }
  }
  return null;
}

async function getUsersByIds(userIds) {
  if (!userIds || !userIds.length) return [];
  const stringIds = userIds.map(String);

  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery(
        'SELECT telegram_id, full_name, username, class_name FROM users WHERE telegram_id = ANY($1)',
        [stringIds]
      );
      clearDbError();
      return res.rows;
    } catch (pgErr) {
      logger.error('getUsersByIds pg error:', { error: pgErr.message });
    }
  }
  return [];
}

async function getUsersPaginated(page = 0, limit = 10) {
  const from = page * limit;
  const to = from + limit - 1;

  if (isPostgresAvailable()) {
    try {
      const [dataRes, countRes] = await Promise.all([
        pgQuery('SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2', [limit, from]),
        pgQuery('SELECT COUNT(*) as count FROM users')
      ]);
      clearDbError();
      const total = parseInt(countRes.rows[0].count, 10);
      return { users: dataRes.rows, total };
    } catch (pgErr) {
      logger.error('getUsersPaginated pg error:', { error: pgErr.message });
    }
  }

  try {
    const storage = require('../core/storage');
    const stats = await storage.getUsersStats();
    const userIds = Object.keys(stats || {});
    const total = userIds.length;
    const pagedIds = userIds.slice(from, to + 1);
    const users = pagedIds.map(uid => ({
      telegram_id: uid,
      full_name: stats[uid]?.name || stats[uid]?.full_name || 'Foydalanuvchi',
      username: stats[uid]?.username || "yo'q",
      joined_at: stats[uid]?.joined_at || new Date().toISOString(),
    }));
    return { users, total };
  } catch {
    return { users: [], total: 0 };
  }
}

async function searchUsers(query, limit = 20) {
  const cleanQuery = String(query)
    .trim()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .substring(0, 50);
  if (!cleanQuery) return [];

  if (isPostgresAvailable()) {
    try {
      const isNumeric = /^\d+$/.test(cleanQuery);
      if (isNumeric) {
        const exact = await pgQuery('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [cleanQuery]);
        if (exact.rows.length) return exact.rows;
      }
      const res = await pgQuery(
        'SELECT * FROM users WHERE username ILIKE $1 OR full_name ILIKE $1 LIMIT $2',
        [`%${cleanQuery}%`, limit]
      );
      clearDbError();
      return res.rows;
    } catch (pgErr) {
      logger.error('searchUsers pg error:', { error: pgErr.message });
    }
  }
  return [];
}

async function getBroadcastRecipients() {
  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT telegram_id FROM users WHERE is_banned IS NOT TRUE');
      clearDbError();
      return res.rows.map(r => r.telegram_id);
    } catch (pgErr) {
      logger.error('getBroadcastRecipients pg error:', { error: pgErr.message });
    }
  }
  return [];
}

async function getAllUserNames() {
  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT telegram_id, full_name FROM users ORDER BY created_at DESC LIMIT 2000');
      clearDbError();
      return res.rows;
    } catch (pgErr) {
      logger.error('getAllUserNames pg error:', { error: pgErr.message });
    }
  }
  return [];
}

async function getAllUsers() {
  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT * FROM users ORDER BY created_at DESC');
      clearDbError();
      return res.rows;
    } catch (pgErr) {
      logger.error('getAllUsers pg error:', { error: pgErr.message });
    }
  }
  return [];
}

async function getUsersByClassName(className) {
  if (!className) return [];

  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT telegram_id, full_name, class_name FROM users WHERE class_name ILIKE $1', [className]);
      clearDbError();
      return res.rows.map(u => ({ ...u, name: u.full_name || '' }));
    } catch (pgErr) {
      logger.error('getUsersByClassName pg error:', { error: pgErr.message });
    }
  }
  return [];
}

async function updateUserClass(telegramId, className) {
  const uid = String(telegramId);
  const edupageService = require('../services/edupageService');
  const canonical = className ? (edupageService.getCanonicalGroupName(className) || className.trim()) : null;
  localUserClasses.set(uid, canonical);

  if (redis) {
    try {
      if (canonical) {
        await redis.set(`user_class:${uid}`, canonical, 'EX', 86400 * 30);
      } else {
        await redis.del(`user_class:${uid}`);
      }
    } catch (e) {
      logger.debug('Redis updateUserClass write skipped', { error: e.message });
    }
  }

  if (isPostgresAvailable()) {
    try {
      await pgQuery('UPDATE users SET class_name = $1 WHERE telegram_id = $2', [canonical, uid]);
      const tidNum = parseInt(uid, 10);
      if (!isNaN(tidNum)) {
        await pgQuery('UPDATE user_schedule_settings SET group_name = $1 WHERE telegram_id = $2', [canonical, tidNum]);
      }
      clearDbError();
    } catch (pgErr) {
      logger.error('updateUserClass pg error:', { error: pgErr.message });
    }
  }

  return true;
}

async function getUserClass(telegramId) {
  const uid = String(telegramId);
  const edupageService = require('../services/edupageService');

  if (localUserClasses.has(uid)) {
    const raw = localUserClasses.get(uid);
    return raw ? (edupageService.getCanonicalGroupName(raw) || raw) : null;
  }

  if (redis) {
    try {
      const cached = await redis.get(`user_class:${uid}`);
      if (cached) {
        const canonical = edupageService.getCanonicalGroupName(cached) || cached;
        localUserClasses.set(uid, canonical);
        return canonical;
      }
    } catch (e) {
      logger.debug('Redis getUserClass read skipped', { error: e.message });
    }
  }

  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT class_name FROM users WHERE telegram_id = $1 LIMIT 1', [uid]);
      clearDbError();
      if (res.rows.length && res.rows[0].class_name) {
        const canonical = edupageService.getCanonicalGroupName(res.rows[0].class_name) || res.rows[0].class_name;
        localUserClasses.set(uid, canonical);
        if (redis) {
          redis.set(`user_class:${uid}`, canonical, 'EX', 86400 * 30).catch(() => {});
        }
        return canonical;
      }
    } catch (pgErr) {
      logger.error('getUserClass pg error:', { error: pgErr.message });
    }
  }

  const fallback = localUserClasses.get(uid);
  return fallback ? (edupageService.getCanonicalGroupName(fallback) || fallback) : null;
}

async function getUserScheduleTheme(telegramId) {
  const uid = String(telegramId);
  if (localUserThemes.has(uid)) {
    return localUserThemes.get(uid);
  }

  if (redis) {
    try {
      const cached = await redis.get(`user_theme:${uid}`);
      if (cached && ['dark', 'light', 'vibrant'].includes(cached)) {
        localUserThemes.set(uid, cached);
        return cached;
      }
    } catch (e) {
      logger.debug('Redis getUserScheduleTheme read skipped', { error: e.message });
    }
  }

  return 'dark';
}

async function setUserScheduleTheme(telegramId, theme) {
  const uid = String(telegramId);
  const valid = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
  localUserThemes.set(uid, valid);

  if (redis) {
    try {
      await redis.set(`user_theme:${uid}`, valid, 'EX', 86400 * 90);
    } catch (e) {
      logger.debug('Redis setUserScheduleTheme write skipped', { error: e.message });
    }
  }
  return true;
}

async function banUser(userId) {
  const uid = String(userId);
  userBannedL1Cache.set(uid, true);
  try {
    if (isPostgresAvailable()) {
      try {
        await pgQuery('UPDATE users SET is_banned = TRUE WHERE telegram_id = $1', [uid]);
        clearDbError();
      } catch (pgErr) {
        logger.error('PostgreSQL banUser error:', { error: pgErr.message });
      }
    }
    if (redis) {
      await redis.set(`user_banned:${uid}`, '1', 'EX', 300).catch(() => {});
    }
    return true;
  } catch (e) {
    logger.error('banUser xatosi:', { userId: uid, error: e.message });
    return false;
  }
}

async function unbanUser(userId) {
  const uid = String(userId);
  userBannedL1Cache.set(uid, false);
  localBlockedUsers.delete(uid);
  try {
    if (isPostgresAvailable()) {
      try {
        await pgQuery('UPDATE users SET is_banned = FALSE WHERE telegram_id = $1', [uid]);
        clearDbError();
      } catch (pgErr) {
        logger.error('PostgreSQL unbanUser error:', { error: pgErr.message });
      }
    }
    if (redis) {
      await redis.del(`user_banned:${uid}`).catch(() => {});
      await redis.del(`user_blocked:${uid}`).catch(() => {});
    }
    return true;
  } catch (e) {
    logger.error('unbanUser xatosi:', { userId: uid, error: e.message });
    return false;
  }
}

async function isUserBanned(userId, forceRefresh = false) {
  const uid = String(userId);
  if (!forceRefresh && userBannedL1Cache.has(uid)) {
    return userBannedL1Cache.get(uid);
  }
  try {
    if (!forceRefresh && redis) {
      const cached = await redis.get(`user_banned:${uid}`);
      if (cached !== null) {
        const isBanned = cached === '1';
        userBannedL1Cache.set(uid, isBanned);
        return isBanned;
      }
    }

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery('SELECT is_banned FROM users WHERE telegram_id = $1 LIMIT 1', [uid]);
        clearDbError();
        const isBanned = res.rows.length ? (res.rows[0].is_banned === true) : false;
        userBannedL1Cache.set(uid, isBanned);
        if (redis) {
          if (isBanned) {
            await redis.set(`user_banned:${uid}`, '1', 'EX', 300).catch(() => {});
          } else {
            await redis.del(`user_banned:${uid}`).catch(() => {});
            await redis.del(`user_blocked:${uid}`).catch(() => {});
          }
        }
        return isBanned;
      } catch (pgErr) {
        logger.error('PostgreSQL isUserBanned error:', { error: pgErr.message });
      }
    }

    return false;
  } catch {
    return false;
  }
}

async function markUserBlocked(userId, isBlocked = true) {
  const uid = String(userId);
  if (isBlocked) {
    localBlockedUsers.set(uid, true);
  } else {
    localBlockedUsers.delete(uid);
  }

  try {
    if (redis) {
      if (isBlocked) {
        await redis.set(`user_blocked:${uid}`, '1', 'EX', 86400 * 7).catch(() => {});
      } else {
        await redis.del(`user_blocked:${uid}`).catch(() => {});
      }
    }
    logger.debug('Updated user blocked status', { userId: uid, isBlocked });
  } catch (err) {
    logger.warn('markUserBlocked error:', { userId: uid, error: err.message });
  }
}

async function isUserBlocked(userId) {
  const uid = String(userId);
  try {
    if (redis) {
      const cached = await redis.get(`user_blocked:${uid}`);
      if (cached !== null) return cached === '1';
    }
    if (localBlockedUsers.has(uid)) return true;
    return false;
  } catch {
    return localBlockedUsers.has(uid);
  }
}

async function getUserNotificationPreference(userId) {
  if (!userId) return 'both';
  if (redis) {
    try {
      const pref = await redis.get(`user:notify_pref:${userId}`);
      if (pref) return pref;
    } catch (e) {
      logger.debug('Redis read error for notification preference', { userId, error: e.message });
    }
  }
  return 'both';
}

async function getUserNotificationPreferences(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return [];
  if (redis && typeof redis.mget === 'function') {
    try {
      const keys = userIds.map(id => `user:notify_pref:${id}`);
      const results = [];
      const CHUNK = 500;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        const res = await redis.mget(slice);
        results.push(...(res || []));
      }
      return results.map(r => r || 'both');
    } catch (e) {
      logger.debug('Redis mget failed for notification preferences', { error: e.message });
    }
  }
  return userIds.map(() => 'both');
}

async function setUserNotificationPreference(userId, preference) {
  if (!userId) return false;
  const valid = ['both', 'morning', 'evening', 'silent'];
  const cleanPref = valid.includes(preference) ? preference : 'both';
  if (redis) {
    try {
      await redis.set(`user:notify_pref:${userId}`, cleanPref, 'EX', 86400 * 90);
    } catch (e) {
      logger.warn('Failed to set notification preference in Redis', { userId, error: e.message });
      return false;
    }
  }
  return true;
}

module.exports = {
  getUserStats,
  getUsersStatsSummaryByIds,
  updateUserStats,
  getUserRank,
  getTopUsers,
  getAllUserStats,
  getAggregatedAdminStats,
  registerUser,
  getUserCount,
  getUserByTelegramId,
  getUsersByIds,
  getUsersPaginated,
  searchUsers,
  getBroadcastRecipients,
  getAllUserNames,
  getAllUsers,
  getUsersByClassName,
  updateUserClass,
  getUserClass,
  getUserScheduleTheme,
  setUserScheduleTheme,
  banUser,
  unbanUser,
  isUserBanned,
  markUserBlocked,
  isUserBlocked,
  getUserNotificationPreference,
  getUserNotificationPreferences,
  setUserNotificationPreference,
  userStatsQueues,
  localBlockedUsers,
  userBannedL1Cache,
  localUserClasses,
  localUserThemes,
  sweepUserCaches,
};
