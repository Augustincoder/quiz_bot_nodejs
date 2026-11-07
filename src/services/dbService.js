'use strict';

const { pool, query: pgQuery, withTransaction, isPostgresAvailable } = require('../lib/postgres');
const { TTLMap, naturalSortBlocks } = require('../core/utils');
const redis = require('./redisService');
const logger = require('../core/logger');

// In-memory fallback cache for timetable CDN metadata (bounded to 1000 items)
const fallbackTimetableCache = new TTLMap(24 * 60 * 60 * 1000, 1000);

// In-memory L1 cache for fast responses & resilient fallback during outages
const subjectL1Cache = new Map(); // sid -> { data, expiresAt }
const userTestL1Cache = new Map(); // tid -> { data, expiresAt }
const userSubjectsL1Cache = new Map(); // uid -> { data, expiresAt }
const subjectBlocksL1Cache = new Map(); // sid -> { data, expiresAt }

let _lastDbError = null;

function recordDbError(err) {
  _lastDbError = {
    message: String(err?.message || 'Database error'),
    timestamp: Date.now(),
  };
}

function isRecentDbError() {
  if (!_lastDbError) return false;
  return (Date.now() - _lastDbError.timestamp) < 20000;
}

function clearDbError() {
  _lastDbError = null;
}

async function loadAllOfficialTests() {
  if (isPostgresAvailable()) {
    try {
      const res = await pgQuery('SELECT subject, test_id, questions FROM official_tests');
      clearDbError();
      const db = {};
      for (const row of res.rows) {
        const subj = row.subject;
        const tId = parseInt(row.test_id, 10);
        if (!db[subj]) db[subj] = {};
        db[subj][tId] = { test_id: tId, range: `1-${row.questions?.length || 0}`, questions: row.questions || [] };
      }
      return db;
    } catch (e) {
      logger.error('Rasmiy testlarni yuklashda xato (PostgreSQL):', { error: e.message });
      return {};
    }
  }
  return {};
}

async function saveOfficialTest(subject, testId, questions) {
  if (isPostgresAvailable()) {
    try {
      await pgQuery(`
        INSERT INTO official_tests (subject, test_id, questions)
        VALUES ($1, $2, $3)
        ON CONFLICT (subject, test_id)
        DO UPDATE SET questions = EXCLUDED.questions, created_at = NOW()
      `, [subject, testId, JSON.stringify(questions)]);
      clearDbError();

      // Hot-reload memoryDb and invalidate blocks pagination cache
      try {
        const botModule = require('../core/bot');
        if (!botModule.memoryDb) botModule.memoryDb = {};
        if (!botModule.memoryDb[subject]) botModule.memoryDb[subject] = {};
        botModule.memoryDb[subject][testId] = {
          test_id: testId,
          range: `1-${questions?.length || 0}`,
          questions: questions || []
        };
        const { invalidateBlocksCache } = require('../keyboards/keyboards');
        invalidateBlocksCache(subject);
      } catch (memErr) {
        logger.warn('Failed to hot-update memoryDb on saveOfficialTest:', { error: memErr.message });
      }

      return true;
    } catch (e) {
      logger.error('saveOfficialTest error (PostgreSQL):', { error: e.message });
      return false;
    }
  }
  return false;
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
        resultMap.set(String(row.user_id), {
          user_id: String(row.user_id),
          tests_completed: row.tests_completed || 0,
          total_correct: row.total_correct || 0,
          total_wrong: row.total_wrong || 0,
          history: Array.isArray(row.history) ? row.history : [],
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

// In-memory per-user update serialization queue to prevent lost updates on concurrent completions (Bug 47)
const userStatsQueues = new Map();

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
    if (correct <= 0) return 'N/A';

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery('SELECT COUNT(*) as count FROM user_stats WHERE total_correct > $1', [correct]);
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
    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery(
          'SELECT user_id, total_correct, tests_completed FROM user_stats WHERE total_correct > 0 ORDER BY total_correct DESC LIMIT $1',
          [limit]
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

async function registerUser(userId, fullName, username) {
  const uid = String(userId);
  try {
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
      const res = await pgQuery('SELECT telegram_id, full_name FROM users');
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

// ─── SUBJECTS & USER TESTS RELATIONAL MANAGEMENT ─────────────────

async function getOrCreateSubject(creatorId, subjectName) {
  const uid = String(creatorId);
  const rawName = String(subjectName || '').trim();
  if (!rawName) return null;
  const normName = rawName.toLowerCase();
  const cacheKey = `cache:subject_by_name:${uid}:${normName}`;

  try {
    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) return JSON.parse(cached);
    }

    if (isPostgresAvailable()) {
      try {
        const existing = await pgQuery(
          'SELECT * FROM subjects WHERE creator_id = $1 AND name ILIKE $2 LIMIT 1',
          [uid, rawName]
        );
        clearDbError();
        if (existing.rows.length) {
          const subj = existing.rows[0];
          if (redis) {
            await redis.set(cacheKey, JSON.stringify(subj), 'EX', 3600).catch(() => {});
            await redis.set(`cache:subject:${subj.id}`, JSON.stringify(subj), 'EX', 3600).catch(() => {});
          }
          return subj;
        }

        // Ensure user exists in users table
        await pgQuery(
          'INSERT INTO users (telegram_id, full_name) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
          [uid, 'Foydalanuvchi']
        ).catch(() => {});

        // Insert subject
        const ins = await pgQuery(
          'INSERT INTO subjects (name, creator_id) VALUES ($1, $2) RETURNING *',
          [rawName, uid]
        );
        const created = ins.rows[0];
        if (created && redis) {
          await redis.set(cacheKey, JSON.stringify(created), 'EX', 3600).catch(() => {});
          await redis.set(`cache:subject:${created.id}`, JSON.stringify(created), 'EX', 3600).catch(() => {});
          await redis.del(`cache:user_subjects:${uid}`).catch(() => {});
        }
        return created;
      } catch (pgErr) {
        logger.error('getOrCreateSubject pg error:', { error: pgErr.message });
      }
    }

    return { id: 1, name: rawName, creator_id: uid };
  } catch (err) {
    logger.error('getOrCreateSubject error:', { creatorId: uid, subjectName: rawName, error: err.message });
    return { id: null, name: rawName, creator_id: uid };
  }
}

async function getSubjectById(subjectId) {
  const sid = parseInt(subjectId, 10);
  if (isNaN(sid)) return null;

  const now = Date.now();
  const l1 = subjectL1Cache.get(sid);
  if (l1 && l1.expiresAt > now) {
    return l1.data;
  }

  const cacheKey = `cache:subject:${sid}`;
  try {
    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed._notFound) {
          subjectL1Cache.set(sid, { data: null, expiresAt: now + 300000 });
          return null;
        }
        subjectL1Cache.set(sid, { data: parsed, expiresAt: now + 300000 });
        return parsed;
      }
    }

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery('SELECT * FROM subjects WHERE id = $1 LIMIT 1', [sid]);
        clearDbError();
        const data = res.rows[0] || null;
        if (data) {
          if (redis) await redis.set(cacheKey, JSON.stringify(data), 'EX', 3600).catch(() => {});
          subjectL1Cache.set(sid, { data, expiresAt: now + 300000 });
          return data;
        } else {
          if (redis) await redis.set(cacheKey, JSON.stringify({ _notFound: true }), 'EX', 600).catch(() => {});
          subjectL1Cache.set(sid, { data: null, expiresAt: now + 300000 });
          return null;
        }
      } catch (pgErr) {
        logger.error('getSubjectById pg error:', { error: pgErr.message });
      }
    }

    if (l1 && l1.data) return l1.data;
    return null;
  } catch (err) {
    logger.error('getSubjectById error:', { subjectId: sid, error: err.message });
    recordDbError(err);
    if (l1 && l1.data) return l1.data;
    return null;
  }
}

async function getUserSubjects(creatorId) {
  const uid = String(creatorId);
  const cacheKey = `cache:user_subjects:${uid}`;

  const now = Date.now();
  const l1 = userSubjectsL1Cache.get(uid);
  if (l1 && l1.expiresAt > now) {
    return l1.data;
  }

  try {
    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        const parsed = JSON.parse(cached);
        userSubjectsL1Cache.set(uid, { data: parsed, expiresAt: now + 120000 });
        return parsed;
      }
    }

    if (isPostgresAvailable()) {
      try {
        const [subjRes, testRes] = await Promise.all([
          pgQuery('SELECT * FROM subjects WHERE creator_id = $1 ORDER BY id DESC', [uid]),
          pgQuery('SELECT id, subject_id, subject, block_name FROM user_tests WHERE creator_id = $1', [uid])
        ]);
        clearDbError();
        const subjects = subjRes.rows;
        const tests = testRes.rows;

        const blockCounts = new Map();
        const legacyMap = new Map();
        for (const t of tests || []) {
          if (t.subject_id) {
            const sid = String(t.subject_id);
            blockCounts.set(sid, (blockCounts.get(sid) || 0) + 1);
          } else if (t.subject) {
            const norm = t.subject.trim().toLowerCase();
            legacyMap.set(norm, (legacyMap.get(norm) || 0) + 1);
          }
        }

        const result = (subjects || []).map((s) => ({
          ...s,
          block_count: blockCounts.get(String(s.id)) || legacyMap.get(String(s.name || '').trim().toLowerCase()) || 0,
        }));

        const existingNames = new Set((subjects || []).map(s => String(s.name || '').trim().toLowerCase()));
        for (const t of tests || []) {
          if (t.subject && !t.subject_id) {
            const norm = String(t.subject).trim().toLowerCase();
            if (!existingNames.has(norm)) {
              existingNames.add(norm);
              result.push({
                id: t.id,
                name: String(t.subject).trim(),
                creator_id: uid,
                block_count: legacyMap.get(norm) || 1,
                is_legacy: true,
              });
            }
          }
        }

        if (redis) {
          await redis.set(cacheKey, JSON.stringify(result), 'EX', 3600).catch(() => {});
        }
        userSubjectsL1Cache.set(uid, { data: result, expiresAt: now + 120000 });
        return result;
      } catch (pgErr) {
        logger.error('getUserSubjects pg error:', { error: pgErr.message });
      }
    }

    if (l1 && l1.data) return l1.data;
    return [];
  } catch (err) {
    logger.error('getUserSubjects error:', { creatorId: uid, error: err.message });
    recordDbError(err);
    if (l1 && l1.data) return l1.data;
    return [];
  }
}

async function getSubjectBlocks(subjectId) {
  const sid = parseInt(subjectId, 10);
  if (isNaN(sid)) return [];

  const now = Date.now();
  const l1 = subjectBlocksL1Cache.get(sid);
  if (l1 && l1.expiresAt > now) {
    return l1.data;
  }

  const cacheKey = `cache:subject_blocks:${sid}`;
  try {
    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        const parsed = JSON.parse(cached);
        subjectBlocksL1Cache.set(sid, { data: parsed, expiresAt: now + 300000 });
        return parsed;
      }
    }

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery(
          'SELECT id, creator_id, subject, subject_id, block_name, questions, created_at FROM user_tests WHERE subject_id = $1 ORDER BY id ASC',
          [sid]
        );
        clearDbError();
        const sorted = naturalSortBlocks(res.rows);
        if (redis) {
          await redis.set(cacheKey, JSON.stringify(sorted), 'EX', 3600).catch(() => {});
        }
        subjectBlocksL1Cache.set(sid, { data: sorted, expiresAt: now + 300000 });
        return sorted;
      } catch (pgErr) {
        logger.error('getSubjectBlocks pg error:', { error: pgErr.message });
      }
    }

    if (l1 && l1.data) return l1.data;
    return [];
  } catch (err) {
    logger.error('getSubjectBlocks error:', { subjectId: sid, error: err.message });
    recordDbError(err);
    if (l1 && l1.data) return l1.data;
    return [];
  }
}

async function invalidateSubjectCache(subjectId, creatorId) {
  try {
    if (subjectId) {
      const sid = parseInt(subjectId, 10);
      subjectL1Cache.delete(sid);
      userTestL1Cache.delete(sid);
      subjectBlocksL1Cache.delete(sid);
    }
    if (creatorId) {
      userSubjectsL1Cache.delete(String(creatorId));
    }
    if (!redis) return;
    const promises = [];
    if (subjectId) {
      promises.push(redis.del(`cache:subject:${subjectId}`).catch(() => {}));
      promises.push(redis.del(`cache:subject_blocks:${subjectId}`).catch(() => {}));
      promises.push(redis.del(`cache:user_test:${subjectId}`).catch(() => {}));
    }
    if (creatorId) {
      promises.push(redis.del(`cache:user_subjects:${creatorId}`).catch(() => {}));
      promises.push(invalidateUserCreatedTestsCache(creatorId));
    }
    await Promise.all(promises);
  } catch {}
}

async function saveUserTest(creatorId, subject, blockName, questions, subjectId = null) {
  try {
    let resolvedSubjectId = subjectId ? parseInt(subjectId, 10) : null;
    let resolvedSubjectName = subject;

    if (!resolvedSubjectId && subject) {
      const subj = await getOrCreateSubject(creatorId, subject);
      if (subj && subj.id) {
        resolvedSubjectId = subj.id;
        resolvedSubjectName = subj.name;
      }
    } else if (resolvedSubjectId && !resolvedSubjectName) {
      const subj = await getSubjectById(resolvedSubjectId);
      if (subj) resolvedSubjectName = subj.name;
    }

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery(
          `INSERT INTO user_tests (creator_id, subject, subject_id, block_name, questions, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, subject_id`,
          [String(creatorId), resolvedSubjectName, resolvedSubjectId, blockName, JSON.stringify(questions)]
        );
        clearDbError();
        await invalidateSubjectCache(resolvedSubjectId, creatorId);
        return res.rows[0].id;
      } catch (pgErr) {
        logger.error('saveUserTest pg error:', { error: pgErr.message });
      }
    }

    return null;
  } catch (e) {
    logger.error('saveUserTest error:', { creatorId, error: e.message });
    return null;
  }
}

async function saveUserTestsBatch(creatorId, subject, blocks, subjectId = null) {
  try {
    if (!Array.isArray(blocks) || blocks.length === 0) return [];

    let resolvedSubjectId = subjectId ? parseInt(subjectId, 10) : null;
    let resolvedSubjectName = subject;

    if (!resolvedSubjectId && subject) {
      const subj = await getOrCreateSubject(creatorId, subject);
      if (subj && subj.id) {
        resolvedSubjectId = subj.id;
        resolvedSubjectName = subj.name;
      }
    } else if (resolvedSubjectId && !resolvedSubjectName) {
      const subj = await getSubjectById(resolvedSubjectId);
      if (subj) resolvedSubjectName = subj.name;
    }

    if (isPostgresAvailable()) {
      try {
        const insertedIds = await withTransaction(async (client) => {
          const ids = [];
          for (const b of blocks) {
            const res = await client.query(
              `INSERT INTO user_tests (creator_id, subject, subject_id, block_name, questions, created_at)
               VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id`,
              [String(creatorId), resolvedSubjectName, resolvedSubjectId, b.blockName, JSON.stringify(b.questions)]
            );
            ids.push(res.rows[0].id);
          }
          return ids;
        });
        clearDbError();
        await invalidateSubjectCache(resolvedSubjectId, creatorId);
        return insertedIds;
      } catch (pgErr) {
        logger.error('saveUserTestsBatch pg error:', { error: pgErr.message });
      }
    }

    return [];
  } catch (e) {
    logger.error('saveUserTestsBatch error:', { creatorId, error: e.message });
    return [];
  }
}

async function getUserTest(testId) {
  const tid = parseInt(testId, 10);
  if (isNaN(tid)) return null;

  const now = Date.now();
  const l1 = userTestL1Cache.get(tid);
  if (l1 && l1.expiresAt > now) {
    return l1.data;
  }

  const cacheKey = `cache:user_test:${tid}`;
  try {
    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed._notFound) {
          userTestL1Cache.set(tid, { data: null, expiresAt: now + 300000 });
          return null;
        }
        userTestL1Cache.set(tid, { data: parsed, expiresAt: now + 300000 });
        return parsed;
      }
    }

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery('SELECT * FROM user_tests WHERE id = $1 LIMIT 1', [tid]);
        clearDbError();
        const data = res.rows[0] || null;
        if (data) {
          if (redis) await redis.set(cacheKey, JSON.stringify(data), 'EX', 3600).catch(() => {});
          userTestL1Cache.set(tid, { data, expiresAt: now + 300000 });
          return data;
        } else {
          if (redis) await redis.set(cacheKey, JSON.stringify({ _notFound: true }), 'EX', 600).catch(() => {});
          userTestL1Cache.set(tid, { data: null, expiresAt: now + 300000 });
          return null;
        }
      } catch (pgErr) {
        logger.error('getUserTest pg error:', { error: pgErr.message });
      }
    }

    if (l1 && l1.data) return l1.data;
    return null;
  } catch (err) {
    logger.error('getUserTest error:', { testId: tid, error: err.message });
    recordDbError(err);
    if (l1 && l1.data) return l1.data;
    return null;
  }
}

async function invalidateUserCreatedTestsCache(creatorId) {
  if (!creatorId) return;
  try {
    if (redis) {
      await redis.del([
        `cache:user_created_tests:${creatorId}:1`,
        `cache:user_created_tests:${creatorId}:0`,
      ]).catch(() => {});
    }
  } catch {}
}

async function getUserCreatedTests(creatorId, includeQuestions = true) {
  const cacheKey = `cache:user_created_tests:${creatorId}:${includeQuestions ? '1' : '0'}`;
  try {
    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) return JSON.parse(cached);
    }

    const selectFields = includeQuestions
      ? 'id, subject, subject_id, block_name, created_at, questions'
      : 'id, subject, subject_id, block_name, created_at';

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery(
          `SELECT ${selectFields} FROM user_tests WHERE creator_id = $1 ORDER BY id DESC`,
          [String(creatorId)]
        );
        clearDbError();
        const data = res.rows;
        if (data && redis) {
          await redis.set(cacheKey, JSON.stringify(data), 'EX', 3600).catch(() => {});
        }
        return data || [];
      } catch (pgErr) {
        logger.error('getUserCreatedTests pg error:', { error: pgErr.message });
      }
    }

    return [];
  } catch (err) {
    logger.error('getUserCreatedTests error:', { creatorId, error: err.message });
    recordDbError(err);
    return [];
  }
}

async function deleteUserTest(testId, creatorId) {
  const tid = parseInt(testId, 10);
  try {
    const existing = await getUserTest(tid);

    if (isPostgresAvailable()) {
      try {
        await pgQuery('DELETE FROM user_tests WHERE id = $1 AND creator_id = $2', [tid, String(creatorId)]);
        clearDbError();
        await redis.del(`cache:user_test:${tid}`).catch(() => {});
        if (existing?.subject_id) {
          await invalidateSubjectCache(existing.subject_id, creatorId);
        } else {
          await invalidateUserCreatedTestsCache(creatorId);
        }
        return true;
      } catch (pgErr) {
        logger.error('deleteUserTest pg error:', { error: pgErr.message });
      }
    }
    return false;
  } catch (err) {
    logger.error('deleteUserTest error:', { testId: tid, error: err.message });
    return false;
  }
}

async function updateUserTestQuestions(testId, creatorId, newQuestions) {
  const tid = parseInt(testId, 10);
  try {
    const existing = await getUserTest(tid);

    if (isPostgresAvailable()) {
      try {
        await pgQuery('UPDATE user_tests SET questions = $1 WHERE id = $2 AND creator_id = $3', [JSON.stringify(newQuestions), tid, String(creatorId)]);
        clearDbError();
        await redis.del(`cache:user_test:${tid}`).catch(() => {});
        if (existing?.subject_id) {
          await invalidateSubjectCache(existing.subject_id, creatorId);
        } else {
          await invalidateUserCreatedTestsCache(creatorId);
        }
        return true;
      } catch (pgErr) {
        logger.error('updateUserTestQuestions pg error:', { error: pgErr.message });
      }
    }
    return false;
  } catch (e) {
    logger.error('updateUserTestQuestions error:', { testId: tid, error: e.message });
    return false;
  }
}

// Bounded in-memory caches (24-hour TTL, max 5,000 users) to eliminate unbounded memory growth
const localUserClasses = new TTLMap(24 * 60 * 60 * 1000, 5000);

async function updateUserClass(telegramId, className) {
  const uid = String(telegramId);
  const edupageService = require('./edupageService');
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
      await pgQuery('UPDATE user_schedule_settings SET group_name = $1 WHERE telegram_id = $2::bigint', [canonical, uid]);
      invalidateSubscribersCache();
      clearDbError();
    } catch (pgErr) {
      logger.error('updateUserClass pg error:', { error: pgErr.message });
    }
  }

  return true;
}

async function getUserClass(telegramId) {
  const uid = String(telegramId);
  const edupageService = require('./edupageService');

  // 1. Check local in-memory store
  if (localUserClasses.has(uid)) {
    const raw = localUserClasses.get(uid);
    return raw ? (edupageService.getCanonicalGroupName(raw) || raw) : null;
  }

  // 2. Check Redis cache
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

  // 3. Check PostgreSQL database
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

const localUserThemes = new TTLMap(24 * 60 * 60 * 1000, 5000);

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

  return 'dark'; // Default: Variant 6A (Fresh Slate Dark)
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

// ==========================================
// 🗄 USER SHELF (JAVON)
// ==========================================

async function getUserShelf(userId) {
  const stats = await getUserStats(userId);
  return stats.shelf || {};
}

async function updateUserShelf(userId, shelf) {
  const uid = String(userId);
  try {
    if (isPostgresAvailable()) {
      try {
        await pgQuery(`
          INSERT INTO user_stats (user_id, shelf)
          VALUES ($1, $2)
          ON CONFLICT (user_id)
          DO UPDATE SET shelf = EXCLUDED.shelf
        `, [uid, JSON.stringify(shelf)]);
        clearDbError();
        await redis.del(`cache:user_stats:${uid}`).catch(() => {});
        return true;
      } catch (pgErr) {
        logger.error('updateUserShelf pg error:', { error: pgErr.message });
      }
    }
    return false;
  } catch (e) {
    logger.error('Javonni yangilashda xato:', { userId: uid, error: e.message });
    return false;
  }
}

async function saveTestToShelf(userId, folderName, testInfo) {
  const uid = String(userId);
  const prevPromise = userStatsQueues.get(uid) || Promise.resolve();

  const currentPromise = (async () => {
    try {
      await prevPromise;
    } catch {}

    try {
      const stats = await getUserStats(uid);
      if (stats._fetchFailed) {
        logger.error('saveTestToShelf aborted: could not retrieve user stats due to DB error', { userId: uid });
        return 'error';
      }

      // Self-healing: agar keshda shelf yo'q bo'lsa, bazadan tekshirib to'liq shelfni olish
      if (!stats.shelf) {
        if (isPostgresAvailable()) {
          try {
            const res = await pgQuery('SELECT shelf FROM user_stats WHERE user_id = $1 LIMIT 1', [uid]);
            if (res.rows.length && res.rows[0].shelf) {
              stats.shelf = res.rows[0].shelf;
            }
          } catch {}
        }
      }

      let shelf = stats.shelf || {};

      if (!shelf[folderName]) shelf[folderName] = [];

      const existingIdx = shelf[folderName].findIndex(t => String(t.testId) === String(testInfo.testId));
      const compactQuestions = Array.isArray(testInfo.questions) && testInfo.questions.length > 0
        ? testInfo.questions.map(q => ({
            question: q.question,
            options: q.options,
            correct_index: q.correct_index,
            explanation: q.explanation,
          }))
        : [];

      if (existingIdx !== -1) {
        shelf[folderName][existingIdx] = {
          ...shelf[folderName][existingIdx],
          testName: testInfo.testName || shelf[folderName][existingIdx].testName,
          subject: testInfo.subject || shelf[folderName][existingIdx].subject,
          subjectId: testInfo.subjectId || shelf[folderName][existingIdx].subjectId || null,
          creatorId: testInfo.creatorId || shelf[folderName][existingIdx].creatorId || null,
          isUgc: testInfo.isUgc !== undefined ? Boolean(testInfo.isUgc) : Boolean(shelf[folderName][existingIdx].isUgc),
          questions: compactQuestions.length > 0 ? compactQuestions : shelf[folderName][existingIdx].questions,
          saved_at: new Date().toISOString(),
          progress: testInfo.progress || shelf[folderName][existingIdx].progress || null,
        };
      } else {
        shelf[folderName].push({
          testId: testInfo.testId,
          testName: testInfo.testName,
          subject: testInfo.subject,
          subjectId: testInfo.subjectId || null,
          creatorId: testInfo.creatorId || null,
          isUgc: Boolean(testInfo.isUgc),
          questions: compactQuestions,
          saved_at: new Date().toISOString(),
          progress: testInfo.progress || null,
        });
      }

      if (isPostgresAvailable()) {
        try {
          await pgQuery(`
            INSERT INTO user_stats (user_id, shelf)
            VALUES ($1, $2)
            ON CONFLICT (user_id)
            DO UPDATE SET shelf = EXCLUDED.shelf
          `, [uid, JSON.stringify(shelf)]);
          clearDbError();
        } catch (pgErr) {
          logger.error('saveTestToShelf pg error:', { error: pgErr.message });
        }
      }

      stats.shelf = shelf;
      delete stats._fetchFailed;
      await redis.set(`cache:user_stats:${uid}`, JSON.stringify(stats), 'EX', 300).catch(() => {});
      return 'saved';
    } catch (e) {
      logger.error('Javonga saqlashda xato:', { userId: uid, error: e.message });
      return 'error';
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

async function saveToShelf(userId, testInfo) {
  const folderName = testInfo.subject || 'Asosiy';
  return saveTestToShelf(userId, folderName, {
    testId: testInfo.test_id || testInfo.testId,
    testName: testInfo.test_name || testInfo.testName,
    subject: testInfo.subject,
    subjectId: testInfo.subject_id || testInfo.subjectId || null,
    creatorId: testInfo.creator_id || testInfo.creatorId || null,
    isUgc: Boolean(testInfo.is_ugc || testInfo.isUgc),
    questions: testInfo.questions,
    progress: testInfo.progress,
  });
}

// L1 in-memory cache for user banned status (30s TTL, bounded to 2000 users)
const userBannedL1Cache = new TTLMap(30 * 1000, 2000);

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
    invalidateSubscribersCache();
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

// ==========================================
// 📵 USER BLOCKED STATUS (TELEGRAM FLOOD GUARD)
// ==========================================

// In-memory flood guard bounded to 2000 users with 7-day TTL
const localBlockedUsers = new TTLMap(7 * 24 * 60 * 60 * 1000, 2000);

async function markUserBlocked(userId, isBlocked = true) {
  const uid = String(userId);
  if (isBlocked) {
    localBlockedUsers.set(uid, true);
  } else {
    localBlockedUsers.delete(uid);
  }

  try {
    if (redis) {
      await redis.set(`user_blocked:${uid}`, isBlocked ? '1' : '0', 'EX', 86400 * 7).catch(() => {});
    }
    if (isPostgresAvailable()) {
      await pgQuery('UPDATE users SET is_banned = $1 WHERE telegram_id = $2', [isBlocked, uid]).catch(() => {});
    }
    invalidateSubscribersCache();
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

    if (isPostgresAvailable()) {
      try {
        const res = await pgQuery('SELECT is_banned FROM users WHERE telegram_id = $1 LIMIT 1', [uid]);
        if (res.rows.length) {
          const isBlocked = res.rows[0].is_banned === true;
          if (redis) {
            await redis.set(`user_blocked:${uid}`, isBlocked ? '1' : '0', 'EX', 3600).catch(() => {});
          }
          return isBlocked;
        }
      } catch {}
    }

    return localBlockedUsers.has(uid);
  } catch {
    return localBlockedUsers.has(uid);
  }
}

/**
 * High-efficiency query: fetches only active students with a valid class name,
 * filtering out banned and blocked users to conserve BullMQ and Telegram API capacity.
 */
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

// ==========================================
// 📅 TIMETABLE CDN CACHE (PostgreSQL + Redis + L1 Map)
// ==========================================

async function getTimetableCache(groupInput, theme) {
  if (!groupInput || !theme) return null;
  const edupageService = require('./edupageService');
  const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';

  // 1. Resolve canonical and compute primary normalized
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
  const edupageService = require('./edupageService');
  const canonical = edupageService.getCanonicalGroupName(groupName || groupNormalized) || (groupName || groupNormalized);
  const norm = edupageService.normalizeGroupName(canonical);
  const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
  const row = {
    group_name: canonical, // ALWAYS STORE CANONICAL "ASLI KO'RINISHI"
    group_normalized: norm,
    theme: validTheme,
    file_id: String(fileId).trim(),
    channel_message_id: channelMessageId ? Number(channelMessageId) : null,
    schedule_hash: String(scheduleHash || '').trim(),
    updated_at: new Date().toISOString(),
  };

  const cacheKey = `cache:timetable_cdn:${norm}:${validTheme}`;

  // Check in-memory fallback cache first to eliminate redundant writes
  const existing = fallbackTimetableCache.get(cacheKey);
  const isNoOp = existing &&
    existing.file_id === row.file_id &&
    existing.schedule_hash === row.schedule_hash &&
    (existing.channel_message_id === row.channel_message_id || (!row.channel_message_id && existing.channel_message_id));

  // Update memory fallback cache
  fallbackTimetableCache.set(cacheKey, {
    ...existing,
    ...row,
    channel_message_id: row.channel_message_id || existing?.channel_message_id || null,
  });

  // Update Redis immediately
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(row), 'EX', 86400 * 7);
    } catch (e) {
      logger.debug('Redis upsertTimetableCache error', { error: e.message });
    }
  }

  // Skip redundant database write if cache data has not changed
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
  const edupageService = require('./edupageService');
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
  return 'both'; // Default: morning + evening
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
      await redis.set(`user:notify_pref:${userId}`, cleanPref, 'EX', 86400 * 90); // 90 days TTL
    } catch (e) {
      logger.warn('Failed to set notification preference in Redis', { userId, error: e.message });
      return false;
    }
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════
// SMART SCHEDULE V2 & COURSE NOTES SERVICE LAYER
// ═══════════════════════════════════════════════════════════════════

/**
 * Returns user schedule notification preferences with safe fallback defaults.
 * @param {number|string} telegramId
 */
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
            const userRow = await getUserByTelegramId(uid);
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

    // Fallback to existing public.users table fields
    const userRow = await getUserByTelegramId(uid);
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

/**
 * Upserts user schedule preferences into PostgreSQL with backwards compatibility.
 * @param {number|string} telegramId
 * @param {object} patch
 */
async function upsertUserScheduleSettings(telegramId, patch) {
  const uid = Number(telegramId);
  if (!uid || !patch || typeof patch !== 'object') return false;

  try {
    let groupName = patch.group_name;
    if (!groupName) {
      const currentGroup = await getUserClass(uid);
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

        // Also mirror to users table for backwards-compatibility
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
          userVals.push(uid);
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

// Active schedule subscribers L1 in-memory cache (3-minute TTL)
let activeSubscribersCache = null;
let activeSubscribersCacheExpiresAt = 0;
const SUBSCRIBERS_CACHE_TTL_MS = 3 * 60 * 1000;

function invalidateSubscribersCache() {
  activeSubscribersCache = null;
  activeSubscribersCacheExpiresAt = 0;
}

// Due notes L1 in-memory cache (1-minute TTL, max 50 items to avoid day-over-day unbounded growth)
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

/**
 * Paginated fetch of all active schedule subscribers (>1000 users safe).
 * Merges public.users and public.user_schedule_settings by telegram_id.
 * Caches in memory for 3 minutes.
 * @param {boolean} forceRefresh
 */
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
        if (localBlockedUsers.has(String(uid))) continue;
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

/**
 * Creates a course note in public.course_notes (or class_notes fallback).
 * @param {object} payload
 */
async function createCourseNote(payload) {
  if (!payload) return null;
  try {
    const record = {
      creator_id: Number(payload.creator_id),
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

/**
 * Gets notes due for a specific date and target group / student.
 * Caches global date queries in memory for 1 minute to avoid redundant database reads.
 * @param {number|string} telegramId
 * @param {string} groupName
 * @param {string} dateStr 'YYYY-MM-DD'
 */
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
        params.push(Number(telegramId), String(groupName).trim());
        sql += ' AND (creator_id = $2 OR (is_group_shared = TRUE AND group_name = $3))';
      } else if (groupName) {
        params.push(String(groupName).trim());
        sql += ' AND group_name = $2';
      } else if (telegramId) {
        params.push(Number(telegramId));
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

/**
 * Retrieves a single course note by its primary ID.
 * @param {number|string} noteId
 */
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

/**
 * Updates note status (e.g. 'completed', 'snoozed', 'cancelled'), with optional new date and period.
 * @param {number|string} noteId
 * @param {number|string} telegramId
 * @param {string} newStatus
 * @param {string|null} newTargetDate 'YYYY-MM-DD'
 * @param {number|null} newTargetPeriod
 */
async function updateNoteStatus(noteId, telegramId, newStatus, newTargetDate = null, newTargetPeriod = null, newStartTime = null, extraFields = null) {
  if (!noteId) return false;
  const id = Number(noteId);

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
        params.push(Number(telegramId));
        whereClause += ` AND creator_id = $${pIdx++}`;
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

/**
 * Retrieves all active/pending notes for a user and their group.
 * @param {number|string} telegramId
 * @param {string|null} groupName
 */
async function getUserActiveNotes(telegramId, groupName = null) {
  if (!telegramId) return [];
  const uid = Number(telegramId);
  const edupageService = require('./edupageService');
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
  loadAllOfficialTests,
  saveOfficialTest,
  getUserStats,
  getUsersStatsSummaryByIds,
  updateUserStats,
  getUserRank,
  getTopUsers,
  getAllUserStats,
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
  getOrCreateSubject,
  getSubjectById,
  getUserSubjects,
  getSubjectBlocks,
  invalidateSubjectCache,
  saveUserTest,
  saveUserTestsBatch,
  getUserTest,
  getUserCreatedTests,
  deleteUserTest,
  updateUserTestQuestions,
  updateUserClass,
  getUserClass,
  getUserScheduleTheme,
  setUserScheduleTheme,
  getUserShelf,
  saveTestToShelf,
  saveToShelf,
  updateUserShelf,
  banUser,
  unbanUser,
  isUserBanned,
  markUserBlocked,
  isUserBlocked,
  getScheduleBroadcastUsers,
  getTimetableCache,
  upsertTimetableCache,
  deleteTimetableCache,
  getAllCachedTimetables,
  clearAllTimetableCache,
  getUserNotificationPreference,
  getUserNotificationPreferences,
  setUserNotificationPreference,
  getUserScheduleSettings,
  upsertUserScheduleSettings,
  getAllActiveScheduleSubscribers,
  createCourseNote,
  getDueNotesForLesson,
  getNoteById,
  updateNoteStatus,
  getUserActiveNotes,
  // Aliases for blueprint compatibility:
  getUserSchedulePrefs: getUserScheduleSettings,
  updateUserSchedulePrefs: upsertUserScheduleSettings,
  getAllSubscribedScheduleUsers: getAllActiveScheduleSubscribers,
  createClassNote: createCourseNote,
  updateClassNote: updateNoteStatus,
  getPendingNotesForDate: (dateStr) => getDueNotesForLesson(null, null, dateStr),
  getUserPendingNotes: getUserActiveNotes,
  _userStatsQueues: userStatsQueues,
  invalidateSubscribersCache,
  invalidateDueNotesCache,
  cleanupDueNotesCache,
  recordDbError,
  isRecentDbError,
  clearDbError,
};
