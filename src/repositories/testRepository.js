'use strict';

/**
 * Test Repository
 * Handles official tests, subjects, UGC (user generated) tests, blocks, and user shelf.
 */

function getPg() {
  return require('../lib/postgres');
}
const pgQuery = (sql, params) => getPg().query(sql, params);
const isPostgresAvailable = () => getPg().isPostgresAvailable();
const withTransaction = (fn) => getPg().withTransaction(fn);
const { TTLMap, naturalSortBlocks } = require('../core/utils');
const redis = require('../services/redisService');
const logger = require('../core/logger');
const { recordDbError, clearDbError } = require('./dbHelper');
const userRepository = require('./userRepository');

// In-memory L1 caches for tests & subjects (5-minute TTL, bounded to 500 items)
const subjectL1Cache = new TTLMap(5 * 60 * 1000, 500);
const userTestL1Cache = new TTLMap(5 * 60 * 1000, 500);
const userSubjectsL1Cache = new TTLMap(5 * 60 * 1000, 500);
const subjectBlocksL1Cache = new TTLMap(5 * 60 * 1000, 500);

function sweepTestCaches() {
  try {
    subjectL1Cache.sweep();
    userTestL1Cache.sweep();
    userSubjectsL1Cache.sweep();
    subjectBlocksL1Cache.sweep();
  } catch {}
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
  const tId = parseInt(testId, 10);
  if (isNaN(tId)) return false;

  if (isPostgresAvailable()) {
    try {
      await pgQuery(`
        INSERT INTO official_tests (subject, test_id, questions)
        VALUES ($1, $2, $3)
        ON CONFLICT (subject, test_id)
        DO UPDATE SET questions = EXCLUDED.questions, created_at = NOW()
      `, [subject, tId, JSON.stringify(questions)]);
      clearDbError();

      try {
        const botModule = require('../core/bot');
        if (!botModule.memoryDb) botModule.memoryDb = {};
        if (!botModule.memoryDb[subject]) botModule.memoryDb[subject] = {};
        botModule.memoryDb[subject][tId] = {
          test_id: tId,
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

        await pgQuery(
          'INSERT INTO users (telegram_id, full_name) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
          [uid, 'Foydalanuvchi']
        ).catch(() => {});

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
        const rows = (res.rows || []).map(row => {
          if (typeof row.questions === 'string') {
            try { row.questions = JSON.parse(row.questions); } catch { row.questions = []; }
          }
          return row;
        });
        const sorted = naturalSortBlocks(rows);
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
          if (typeof data.questions === 'string') {
            try { data.questions = JSON.parse(data.questions); } catch { data.questions = []; }
          }
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
        const data = (res.rows || []).map(row => {
          if (typeof row.questions === 'string') {
            try { row.questions = JSON.parse(row.questions); } catch { row.questions = []; }
          }
          return row;
        });
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
        userTestL1Cache.delete(tid);
        userSubjectsL1Cache.delete(String(creatorId));
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
        userTestL1Cache.delete(tid);
        userSubjectsL1Cache.delete(String(creatorId));
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

async function getUserShelf(userId) {
  const stats = await userRepository.getUserStats(userId);
  return stats.shelf || {};
}

async function updateUserShelf(userId, shelf) {
  const uid = String(userId);
  const prevPromise = userRepository.userStatsQueues.get(uid) || Promise.resolve();

  const currentPromise = (async () => {
    try { await prevPromise; } catch {}
    try {
      if (isPostgresAvailable()) {
        await pgQuery(`
          INSERT INTO user_stats (user_id, shelf)
          VALUES ($1, $2)
          ON CONFLICT (user_id)
          DO UPDATE SET shelf = EXCLUDED.shelf
        `, [uid, JSON.stringify(shelf)]);
        clearDbError();
        await redis.del(`cache:user_stats:${uid}`).catch(() => {});
        return true;
      }
      return false;
    } catch (e) {
      logger.error('Javonni yangilashda xato:', { userId: uid, error: e.message });
      return false;
    }
  })();

  userRepository.userStatsQueues.set(uid, currentPromise);
  try {
    return await currentPromise;
  } finally {
    if (userRepository.userStatsQueues.get(uid) === currentPromise) {
      userRepository.userStatsQueues.delete(uid);
    }
  }
}

async function saveTestToShelf(userId, folderName, testInfo) {
  const uid = String(userId);
  const prevPromise = userRepository.userStatsQueues.get(uid) || Promise.resolve();

  const currentPromise = (async () => {
    try {
      await prevPromise;
    } catch {}

    try {
      const stats = await userRepository.getUserStats(uid);
      if (stats._fetchFailed) {
        logger.error('saveTestToShelf aborted: could not retrieve user stats due to DB error', { userId: uid });
        return 'error';
      }

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

  userRepository.userStatsQueues.set(uid, currentPromise);
  try {
    return await currentPromise;
  } finally {
    if (userRepository.userStatsQueues.get(uid) === currentPromise) {
      userRepository.userStatsQueues.delete(uid);
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

module.exports = {
  loadAllOfficialTests,
  saveOfficialTest,
  getOrCreateSubject,
  getSubjectById,
  getUserSubjects,
  getSubjectBlocks,
  invalidateSubjectCache,
  saveUserTest,
  saveUserTestsBatch,
  getUserTest,
  invalidateUserCreatedTestsCache,
  getUserCreatedTests,
  deleteUserTest,
  updateUserTestQuestions,
  getUserShelf,
  updateUserShelf,
  saveTestToShelf,
  saveToShelf,
  subjectL1Cache,
  userTestL1Cache,
  userSubjectsL1Cache,
  subjectBlocksL1Cache,
  sweepTestCaches,
};
