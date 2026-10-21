'use strict';

const { supabase } = require('../lib/supabase');
const { TTLMap } = require('../core/utils');
const redis = require('./redisService');
const logger = require('../core/logger');

// In-memory fallback cache for timetable CDN metadata (bounded to 1000 items)
const fallbackTimetableCache = new TTLMap(24 * 60 * 60 * 1000, 1000);

async function loadAllOfficialTests() {
  if (!supabase) return {};
  try {
    const pageSize = 1000;
    let from = 0;
    const allRows = [];
    while (true) {
      const { data, error } = await supabase
        .from('official_tests')
        .select('*')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    const db = {};
    for (const row of allRows) {
      const subj = row.subject;
      const tId  = parseInt(row.test_id, 10);
      if (!db[subj]) db[subj] = {};
      db[subj][tId] = { test_id: tId, range: `1-${row.questions?.length || 0}`, questions: row.questions || [] };
    }
    return db;
  } catch (e) {
    logger.error('Rasmiy testlarni yuklashda xato:', { error: e.message });
    return {};
  }
}

async function saveOfficialTest(subject, testId, questions) {
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('official_tests').upsert(
      { subject, test_id: testId, questions },
      { onConflict: 'subject,test_id' }
    );
    if (error) throw error;

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
    logger.error('saveOfficialTest error:', { error: e.message });
    return false;
  }
}

async function getUserStats(userId) {
  const uid = String(userId);
  const cacheKey = `cache:user_stats:${uid}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    if (supabase) {
      const { data, error } = await supabase
        .from('user_stats')
        .select('*')
        .eq('user_id', uid)
        .maybeSingle();

      if (error) throw error;
      if (data) {
        if (!data.history) data.history = [];
        await redis.set(cacheKey, JSON.stringify(data), 'EX', 300).catch(() => {});
        return data;
      }
    }
    return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [] };
  } catch (err) {
    logger.error('getUserStats error:', { userId: uid, error: err.message });
    return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [], _fetchFailed: true };
  }
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

    const entry = {
      date: new Date().toISOString().slice(0, 16).replace('T', ' '),
      timestamp: Date.now(),
      subject: subjectKey,
      test_id: testId,
      correct,
      wrong,
      mistakes,
    };
    if (!Array.isArray(stats.history)) stats.history = [];
    stats.history.unshift(entry);
    stats.history = stats.history.slice(0, 15);

    try {
      delete stats._fetchFailed;
      stats.user_id = uid;
      if (supabase) {
        const { error } = await supabase.from('user_stats').upsert(stats, { onConflict: 'user_id' });
        if (error) throw error;
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

    const { count, error } = await supabase
      .from('user_stats')
      .select('user_id', { count: 'exact', head: true })
      .gt('total_correct', correct);

    if (error) throw error;
    return (count ?? 0) + 1;
  } catch (err) {
    logger.error('getUserRank error:', { userId, error: err.message });
    return 'N/A';
  }
}

async function getTopUsers(limit = 10) {
  try {
    const { data, error } = await supabase
      .from('user_stats')
      .select('user_id, total_correct, tests_completed')
      .gt('total_correct', 0)
      .order('total_correct', { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return data.map(s => ({
      user_id: s.user_id,
      correct: s.total_correct,
      completed: s.tests_completed,
    }));
  } catch (e) {
    logger.error('getTopUsers error:', { error: e.message });
    return [];
  }
}

async function getAllUserStats(options = {}) {
  if (!supabase) return [];
  const includeHistory = options.includeHistory !== false;
  const selectFields = includeHistory
    ? 'user_id, total_correct, total_wrong, tests_completed, history'
    : 'user_id, total_correct, total_wrong, tests_completed';

  const PAGE_SIZE = 1000;
  let from = 0;
  const allRows = [];

  try {
    while (true) {
      const { data, error } = await supabase
        .from('user_stats')
        .select(selectFields)
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;
      allRows.push(...data);
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return allRows;
  } catch (err) {
    logger.error('getAllUserStats error:', { error: err.message });
    return allRows.length > 0 ? allRows : [];
  }
}

async function registerUser(userId, fullName, username) {
  const uid = String(userId);
  try {
    const seenKey = `user_registered:${uid}`;
    const alreadyRegistered = await redis.get(seenKey);
    if (alreadyRegistered) return;

    const { error } = await supabase.from('users').upsert({
      telegram_id: uid,
      full_name: fullName || 'Ismsiz',
      username: username || "yo'q",
      joined_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
    }, { onConflict: 'telegram_id', ignoreDuplicates: true });

    if (!error) {
      await redis.set(seenKey, '1', 'EX', 86400 * 7).catch(() => {});
    }
  } catch (err) {
    logger.error('registerUser error:', { userId: uid, error: err.message });
  }
}

async function getUserCount() {
  if (!supabase) {
    try {
      const storage = require('../core/storage');
      const stats = await storage.getUsersStats();
      return Object.keys(stats || {}).length;
    } catch {
      return 0;
    }
  }
  try {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });
    if (error) throw error;
    return count ?? 0;
  } catch (err) {
    logger.error('getUserCount error:', { error: err.message });
    return 0;
  }
}

async function getUserByTelegramId(userId) {
  try {
    const uid = String(userId);
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('telegram_id', uid)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (err) {
    logger.error('getUserByTelegramId error:', { userId, error: err.message });
    return null;
  }
}

async function getUsersByIds(userIds) {
  if (!userIds || !userIds.length) return [];
  try {
    const stringIds = userIds.map(String);
    const { data, error } = await supabase
      .from('users')
      .select('telegram_id, full_name, username, class_name')
      .in('telegram_id', stringIds);
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getUsersByIds error:', { error: err.message });
    return [];
  }
}

async function getUsersPaginated(page = 0, limit = 10) {
  const from = page * limit;
  const to = from + limit - 1;

  if (!supabase) {
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

  try {
    // 1. Primary order: created_at (standard PostgreSQL timestamp)
    let { data, error, count } = await supabase
      .from('users')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false, nullsFirst: false })
      .range(from, to);

    if (error) {
      // 2. Secondary order: joined_at (recorded on registration)
      const fallbackJoined = await supabase
        .from('users')
        .select('*', { count: 'exact' })
        .order('joined_at', { ascending: false, nullsFirst: false })
        .range(from, to);

      if (fallbackJoined.error) {
        // 3. Fallback: unconstrained range
        const unconstrained = await supabase
          .from('users')
          .select('*', { count: 'exact' })
          .range(from, to);
        if (unconstrained.error) throw unconstrained.error;
        return { users: unconstrained.data || [], total: unconstrained.count ?? 0 };
      }
      return { users: fallbackJoined.data || [], total: fallbackJoined.count ?? 0 };
    }

    return { users: data || [], total: count ?? 0 };
  } catch (err) {
    logger.error('getUsersPaginated error:', { page, limit, error: err.message });
    return { users: [], total: 0 };
  }
}

async function searchUsers(query, limit = 20) {
  const cleanQuery = String(query)
    .trim()
    .replace(/[^\p{L}\p{N}_\s-]/gu, '')
    .substring(0, 50);
  if (!cleanQuery) return [];
  try {
    const isNumeric = /^\d+$/.test(cleanQuery);
    if (isNumeric) {
      const { data: exactUser } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', cleanQuery)
        .maybeSingle();
      if (exactUser) return [exactUser];
    }

    const { data, error } = await supabase
      .from('users')
      .select('*')
      .or(`username.ilike.%${cleanQuery}%,full_name.ilike.%${cleanQuery}%`)
      .limit(limit);

    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('searchUsers error:', { query: cleanQuery, error: err.message });
    return [];
  }
}

async function getBroadcastRecipients() {
  if (!supabase) return [];
  try {
    const pageSize = 1000;
    let from = 0;
    const allIds = [];
    while (true) {
      const { data, error } = await supabase
        .from('users')
        .select('telegram_id')
        .or('is_banned.is.null,is_banned.eq.false')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allIds.push(...data.map(u => u.telegram_id));
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return allIds;
  } catch (err) {
    logger.error('getBroadcastRecipients error:', { error: err.message });
    return [];
  }
}

async function getAllUserNames() {
  if (!supabase) return [];
  try {
    const pageSize = 1000;
    let from = 0;
    const allNames = [];
    while (true) {
      const { data, error } = await supabase
        .from('users')
        .select('telegram_id, full_name')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allNames.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return allNames;
  } catch (err) {
    logger.error('getAllUserNames error:', { error: err.message });
    return [];
  }
}

async function getAllUsers() {
  if (!supabase) return [];
  try {
    const pageSize = 1000;
    let from = 0;
    const allUsers = [];
    while (true) {
      const { data, error } = await supabase
        .from('users')
        .select('*')
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allUsers.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return allUsers;
  } catch (err) {
    logger.error('getAllUsers error:', { error: err.message });
    return [];
  }
}

async function getUsersByClassName(className) {
  if (!className || !supabase) return [];
  try {
    const pageSize = 1000;
    let from = 0;
    const allUsers = [];
    while (true) {
      const { data, error } = await supabase
        .from('users')
        .select('telegram_id, name, class_name')
        .ilike('class_name', className)
        .range(from, from + pageSize - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      allUsers.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return allUsers;
  } catch (err) {
    logger.error('getUsersByClassName error:', { className, error: err.message });
    return [];
  }
}

async function saveUserTest(creatorId, subject, blockName, questions) {
  try {
    const { data, error } = await supabase.from('user_tests').insert({
      creator_id: String(creatorId),
      subject,
      block_name: blockName,
      questions,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }).select('id');
    if (error) throw error;
    return data[0].id;
  } catch (e) {
    logger.error('saveUserTest error:', { creatorId, error: e.message });
    return null;
  }
}

async function getUserTest(testId) {
  const tid = parseInt(testId, 10);
  if (isNaN(tid)) return null;

  try {
    const cacheKey = `cache:user_test:${tid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const { data, error } = await supabase
      .from('user_tests')
      .select('*')
      .eq('id', tid)
      .maybeSingle();

    if (error) throw error;
    if (data) {
      await redis.set(cacheKey, JSON.stringify(data), 'EX', 3600).catch(() => {});
    }
    return data || null;
  } catch (err) {
    logger.error('getUserTest error:', { testId: tid, error: err.message });
    return null;
  }
}

async function getUserCreatedTests(creatorId, includeQuestions = true) {
  try {
    const selectFields = includeQuestions
      ? 'id, subject, block_name, created_at, questions'
      : 'id, subject, block_name, created_at';
    const { data, error } = await supabase
      .from('user_tests')
      .select(selectFields)
      .eq('creator_id', String(creatorId))
      .order('id', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getUserCreatedTests error:', { creatorId, error: err.message });
    return [];
  }
}

async function deleteUserTest(testId, creatorId) {
  const tid = parseInt(testId, 10);
  try {
    const { error } = await supabase
      .from('user_tests')
      .delete()
      .eq('id', tid)
      .eq('creator_id', String(creatorId));
    if (error) throw error;
    await redis.del(`cache:user_test:${tid}`).catch(() => {});
    return true;
  } catch (err) {
    logger.error('deleteUserTest error:', { testId: tid, error: err.message });
    return false;
  }
}

async function updateUserTestQuestions(testId, creatorId, newQuestions) {
  const tid = parseInt(testId, 10);
  try {
    const { error } = await supabase
      .from('user_tests')
      .update({ questions: newQuestions })
      .eq('id', tid)
      .eq('creator_id', String(creatorId));
    if (error) throw error;
    await redis.del(`cache:user_test:${tid}`).catch(() => {});
    return true;
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

  if (supabase) {
    try {
      const { error } = await supabase.from('users').update({ class_name: canonical }).eq('telegram_id', uid);
      if (error) {
        logger.warn('Supabase updateUserClass returned error', { error: error.message, uid });
      }
      await supabase.from('user_schedule_settings').update({ group_name: canonical }).eq('telegram_id', uid);
      invalidateSubscribersCache();
    } catch (e) {
      logger.error('updateUserClass error:', { telegramId: uid, error: e.message });
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

  // 3. Check Supabase database
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('class_name')
        .eq('telegram_id', uid)
        .maybeSingle();

      if (!error && data?.class_name) {
        const canonical = edupageService.getCanonicalGroupName(data.class_name) || data.class_name;
        localUserClasses.set(uid, canonical);
        if (redis) {
          redis.set(`user_class:${uid}`, canonical, 'EX', 86400 * 30).catch(() => {});
        }
        return canonical;
      }
    } catch (e) {
      logger.error('getUserClass error:', { telegramId: uid, error: e.message });
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
    const { error } = await supabase.from('user_stats').update({ shelf }).eq('user_id', uid);
    if (error) throw error;
    await redis.del(`cache:user_stats:${uid}`).catch(() => {});
    return true;
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
      let shelf = stats.shelf || {};

      if (!shelf[folderName]) shelf[folderName] = [];

      const isExist = shelf[folderName].find(t => String(t.testId) === String(testInfo.testId));
      if (isExist) return 'exist';

      const compactQuestions = Array.isArray(testInfo.questions)
        ? testInfo.questions.map(q => ({
            question: q.question,
            options: q.options,
            correct_index: q.correct_index,
            explanation: q.explanation,
          }))
        : [];

      shelf[folderName].push({
        testId: testInfo.testId,
        testName: testInfo.testName,
        subject: testInfo.subject,
        questions: compactQuestions,
        saved_at: new Date().toISOString(),
        progress: testInfo.progress || null,
      });

      const { error } = await supabase.from('user_stats').update({ shelf }).eq('user_id', uid);
      if (error) {
        stats.shelf = shelf;
        delete stats._fetchFailed;
        const { error: upsertErr } = await supabase.from('user_stats').upsert(stats, { onConflict: 'user_id' });
        if (upsertErr) throw upsertErr;
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
    const { error } = await supabase.from('users').update({ is_banned: true }).eq('telegram_id', uid);
    if (error) throw error;
    await redis.set(`user_banned:${uid}`, '1', 'EX', 86400).catch(() => {});
    return true;
  } catch (e) {
    logger.error('banUser xatosi:', { userId: uid, error: e.message });
    return false;
  }
}

async function unbanUser(userId) {
  const uid = String(userId);
  userBannedL1Cache.set(uid, false);
  try {
    const { error } = await supabase.from('users').update({ is_banned: false }).eq('telegram_id', uid);
    if (error) throw error;
    await redis.del(`user_banned:${uid}`).catch(() => {});
    return true;
  } catch (e) {
    logger.error('unbanUser xatosi:', { userId: uid, error: e.message });
    return false;
  }
}

async function isUserBanned(userId) {
  const uid = String(userId);
  if (userBannedL1Cache.has(uid)) {
    return userBannedL1Cache.get(uid);
  }
  try {
    const cached = await redis.get(`user_banned:${uid}`);
    if (cached !== null) {
      const isBanned = cached === '1';
      userBannedL1Cache.set(uid, isBanned);
      return isBanned;
    }

    const { data, error } = await supabase
      .from('users')
      .select('is_banned')
      .eq('telegram_id', uid)
      .maybeSingle();

    if (error) throw error;
    const isBanned = data?.is_banned === true;
    userBannedL1Cache.set(uid, isBanned);
    await redis.set(`user_banned:${uid}`, isBanned ? '1' : '0', 'EX', 3600).catch(() => {});
    return isBanned;
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
    if (supabase) {
      await supabase.from('users').update({ is_blocked: isBlocked }).eq('telegram_id', uid);
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
    if (!supabase) return false;

    const { data, error } = await supabase
      .from('users')
      .select('is_blocked')
      .eq('telegram_id', uid)
      .maybeSingle();

    if (error) throw error;
    const isBlocked = data?.is_blocked === true;
    if (redis) {
      await redis.set(`user_blocked:${uid}`, isBlocked ? '1' : '0', 'EX', 3600).catch(() => {});
    }
    return isBlocked;
  } catch {
    return localBlockedUsers.has(uid);
  }
}

/**
 * High-efficiency query: fetches only active students with a valid class name,
 * filtering out banned and blocked users to conserve BullMQ and Telegram API capacity.
 */
async function getScheduleBroadcastUsers() {
  if (!supabase) return [];
  try {
    const pageSize = 1000;
    let from = 0;
    const allUsers = [];
    while (true) {
      const { data, error } = await supabase
        .from('users')
        .select('telegram_id, class_name, is_banned')
        .not('class_name', 'is', null)
        .or('is_banned.is.null,is_banned.eq.false')
        .range(from, from + pageSize - 1);

      if (error) throw error;
      if (!data || data.length === 0) break;
      allUsers.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return allUsers.filter(u => u.class_name && u.class_name.trim() && !u.is_banned);
  } catch (err) {
    logger.error('getScheduleBroadcastUsers error:', { error: err.message });
    return [];
  }
}

// ==========================================
// 📅 TIMETABLE CDN CACHE (Telegram CDN + Supabase)
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

  if (!supabase) return null;

  try {
    // 2. Direct query by primaryNorm
    let { data } = await supabase
      .from('timetable_cache')
      .select('id, group_name, group_normalized, theme, file_id, channel_message_id, schedule_hash, updated_at')
      .eq('group_normalized', primaryNorm)
      .eq('theme', validTheme)
      .maybeSingle();

    // 3. Fallback: if primaryNorm was derived from canonical, also check raw normalized if different
    const rawNorm = edupageService.normalizeGroupName(groupInput);
    if (!data && rawNorm && rawNorm !== primaryNorm) {
      const res = await supabase
        .from('timetable_cache')
        .select('id, group_name, group_normalized, theme, file_id, channel_message_id, schedule_hash, updated_at')
        .eq('group_normalized', rawNorm)
        .eq('theme', validTheme)
        .maybeSingle();
      if (res?.data) data = res.data;
    }

    // 4. Fallback: match by group_name directly
    if (!data && canonical) {
      const res = await supabase
        .from('timetable_cache')
        .select('id, group_name, group_normalized, theme, file_id, channel_message_id, schedule_hash, updated_at')
        .ilike('group_name', canonical)
        .eq('theme', validTheme)
        .maybeSingle();
      if (res?.data) data = res.data;
    }

    if (data) {
      fallbackTimetableCache.set(cacheKey, data);
      if (redis) {
        await redis.set(cacheKey, JSON.stringify(data), 'EX', 86400 * 7).catch(() => {});
      }
      return data;
    }
    return null;
  } catch (err) {
    logger.error('getTimetableCache error:', { error: err.message, group: primaryNorm, theme: validTheme });
    return null;
  }
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

  // Update memory fallback cache
  fallbackTimetableCache.set(cacheKey, row);

  // Update Redis immediately
  if (redis) {
    try {
      await redis.set(cacheKey, JSON.stringify(row), 'EX', 86400 * 7);
    } catch (e) {
      logger.debug('Redis upsertTimetableCache error', { error: e.message });
    }
  }

  if (!supabase) return true;

  try {
    const { error } = await supabase
      .from('timetable_cache')
      .upsert(row, { onConflict: 'group_normalized,theme' });

    if (error) throw error;
    return true;
  } catch (err) {
    logger.error('upsertTimetableCache error:', { error: err.message, group: norm, theme: validTheme });
    return false;
  }
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

  if (supabase) {
    try {
      for (const n of keysToDelete) {
        let q = supabase.from('timetable_cache').delete().eq('group_normalized', n);
        if (theme) {
          const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
          q = q.eq('theme', validTheme);
        }
        await q;
      }
      if (canonical) {
        let q = supabase.from('timetable_cache').delete().ilike('group_name', canonical);
        if (theme) {
          const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
          q = q.eq('theme', validTheme);
        }
        await q;
      }
    } catch (err) {
      logger.warn('deleteTimetableCache supabase error:', { error: err.message });
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

  if (!supabase) return fallbackList;
  try {
    const { data, error } = await supabase
      .from('timetable_cache')
      .select('group_name, group_normalized, theme, file_id, schedule_hash, channel_message_id, updated_at');
    if (error) throw error;
    return data && data.length > 0 ? data : fallbackList;
  } catch (err) {
    logger.error('getAllCachedTimetables error:', { error: err.message });
    return fallbackList;
  }
}

async function clearAllTimetableCache() {
  if (redis) {
    try {
      if (typeof redis.scanStream === 'function') {
        const stream = redis.scanStream({ match: 'cache:timetable_cdn:*', count: 100 });
        stream.on('data', async (keys) => {
          if (keys && keys.length > 0) {
            await redis.del(keys).catch(() => {});
          }
        });
        stream.on('end', () => {
          logger.info('Finished scanning and clearing Redis timetable CDN cache.');
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
  if (supabase) {
    try {
      const { error } = await supabase.from('timetable_cache').delete().neq('group_normalized', '__NONE__');
      if (error) throw error;
      logger.info('Cleared Supabase timetable_cache table.');
    } catch (e) {
      logger.error('Error clearing Supabase timetable cache:', { error: e.message });
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
    // 1. First attempt to fetch from user_schedule_settings table
    if (supabase) {
      const { data, error } = await supabase
        .from('user_schedule_settings')
        .select('*')
        .eq('telegram_id', uid)
        .maybeSingle();

      if (!error && data) {
        // Also verify student_group / class_name from users if group_name is missing
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
    }

    // 2. Fallback to existing public.users table fields
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
 * Upserts user schedule preferences into Supabase with backwards compatibility.
 * @param {number|string} telegramId
 * @param {object} patch
 */
async function upsertUserScheduleSettings(telegramId, patch) {
  const uid = Number(telegramId);
  if (!uid || !patch || typeof patch !== 'object') return false;

  try {
    if (supabase) {
      let groupName = patch.group_name;
      if (!groupName) {
        const currentGroup = await getUserClass(uid);
        if (currentGroup) groupName = currentGroup;
      }

      const payload = {
        telegram_id: uid,
        ...patch,
        updated_at: new Date().toISOString(),
      };
      if (groupName) {
        payload.group_name = groupName;
      }

      const { error } = await supabase
        .from('user_schedule_settings')
        .upsert(payload, { onConflict: 'telegram_id' });

      if (error) {
        logger.warn('upsertUserScheduleSettings Supabase error:', { error: error.message });
      }

      // Also mirror to users table for backwards-compatibility if columns exist
      const userUpdates = {};
      if (patch.notify_mode !== undefined) userUpdates.notif_mode = patch.notify_mode;
      if (patch.offset_minutes !== undefined) userUpdates.notif_offset_min = patch.offset_minutes;
      if (patch.custom_morning_time !== undefined) userUpdates.notif_custom_time = patch.custom_morning_time;
      if (patch.pre_class_5min_bell !== undefined) userUpdates.notif_next_bell = patch.pre_class_5min_bell;
      if (groupName !== undefined) {
        userUpdates.class_name = groupName;
      }

      if (Object.keys(userUpdates).length > 0) {
        try {
          await supabase
            .from('users')
            .update(userUpdates)
            .eq('telegram_id', uid);
        } catch {
          // ignore
        }
      }

      invalidateSubscribersCache();
      return !error;
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
 * Caches in memory for 3 minutes to avoid hammering Supabase on every 60-second cron tick.
 * @param {boolean} forceRefresh
 */
async function getAllActiveScheduleSubscribers(forceRefresh = false) {
  if (!supabase) {
    if (!activeSubscribersCache || forceRefresh) activeSubscribersCache = [];
    return activeSubscribersCache;
  }
  const now = Date.now();
  if (!forceRefresh && activeSubscribersCache && now < activeSubscribersCacheExpiresAt) {
    return activeSubscribersCache;
  }

  const PAGE_SIZE = 1000;
  const subscriberMap = new Map();

  try {
    // 1. Fetch base users from public.users with pagination
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('users')
        .select('telegram_id, class_name, is_banned')
        .not('class_name', 'is', null)
        .or('is_banned.is.null,is_banned.eq.false')
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        logger.warn('getAllActiveScheduleSubscribers users error:', { error: error.message });
        break;
      }
      if (!data || data.length === 0) break;

      for (const u of data) {
        const group = u.class_name;
        if (!group) continue;

        const uid = Number(u.telegram_id);
        if (localBlockedUsers.has(String(uid))) continue;

        subscriberMap.set(uid, {
          telegram_id: uid,
          group_name: group,
          notify_mode: 'shift_aware',
          offset_minutes: 60,
          custom_morning_time: '07:00',
          custom_evening_time: '20:00',
          pre_class_5min_bell: true,
          building_change_alert: true,
          quiet_hours_enabled: true,
          schedule_notifications: true,
        });
      }
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    // 2. Fetch custom settings from user_schedule_settings with pagination
    from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('user_schedule_settings')
        .select('*')
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        logger.warn('getAllActiveScheduleSubscribers settings error:', { error: error.message });
        break;
      }
      if (!data || data.length === 0) break;

      for (const s of data) {
        const uid = Number(s.telegram_id);
        if (s.notify_mode === 'disabled' || s.schedule_notifications === false) {
          subscriberMap.delete(uid);
          continue;
        }

        const existing = subscriberMap.get(uid);
        const resolvedGroup = s.group_name || existing?.group_name;
        if (!resolvedGroup) {
          continue;
        }

        subscriberMap.set(uid, {
          telegram_id: uid,
          group_name: resolvedGroup,
          notify_mode: s.notify_mode || existing?.notify_mode || 'shift_aware',
          offset_minutes: s.offset_minutes !== undefined ? Number(s.offset_minutes) : (existing?.offset_minutes || 60),
          custom_morning_time: s.custom_morning_time || existing?.custom_morning_time || '07:00',
          custom_evening_time: s.custom_evening_time || existing?.custom_evening_time || '20:00',
          pre_class_5min_bell: s.pre_class_5min_bell !== undefined ? s.pre_class_5min_bell : (existing?.pre_class_5min_bell !== false),
          building_change_alert: s.building_change_alert !== undefined ? s.building_change_alert : (existing?.building_change_alert !== false),
          quiet_hours_enabled: s.quiet_hours_enabled !== undefined ? s.quiet_hours_enabled : (existing?.quiet_hours_enabled !== false),
          schedule_notifications: true,
        });
      }

      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    activeSubscribersCache = Array.from(subscriberMap.values());
    activeSubscribersCacheExpiresAt = Date.now() + SUBSCRIBERS_CACHE_TTL_MS;
    return activeSubscribersCache;
  } catch (err) {
    logger.error('getAllActiveScheduleSubscribers exception:', { error: err.message });
    if (activeSubscribersCache) {
      return activeSubscribersCache;
    }
    return Array.from(subscriberMap.values());
  }
}

/**
 * Creates a course note in public.course_notes (or class_notes fallback).
 * @param {object} payload
 */
async function createCourseNote(payload) {
  if (!supabase || !payload) return null;
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

    // Try primary table course_notes
    let { data, error } = await supabase
      .from('course_notes')
      .insert([record])
      .select('*')
      .single();

    if (error && error.message?.includes('relation "public.course_notes" does not exist')) {
      // Fallback to class_notes if migration used class_notes name
      const fallbackRecord = {
        creator_id: record.creator_id,
        group_name: record.group_name,
        is_group_note: record.is_group_shared,
        subject_name: record.subject_name,
        target_lesson_type: record.target_lesson_type.toUpperCase(),
        target_date: record.target_date,
        target_period: record.target_period,
        target_start_time: record.target_start_time || '08:00',
        note_text: record.note_text,
        media_type: record.media_type,
        media_file_id: record.media_file_id,
        status: record.status,
      };
      const res = await supabase.from('class_notes').insert([fallbackRecord]).select('*').single();
      data = res.data;
      error = res.error;
    }

    if (error) {
      logger.error('createCourseNote error:', { error: error.message });
      return null;
    }
    invalidateDueNotesCache();
    return data;
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
  if (!supabase || !dateStr) return [];
  const isGlobalDateQuery = !telegramId && !groupName;
  const now = Date.now();

  if (isGlobalDateQuery && dueNotesCache.has(dateStr)) {
    const cached = dueNotesCache.get(dateStr);
    if (now < cached.expiresAt) {
      return cached.data;
    }
    dueNotesCache.delete(dateStr);
  }

  try {
    let query = supabase
      .from('course_notes')
      .select('*')
      .in('status', ['pending', 'notified_evening', 'snoozed'])
      .eq('target_date', dateStr);

    if (telegramId && groupName) {
      const safeGroup = String(groupName).replace(/"/g, '').trim();
      query = query.or(`creator_id.eq.${Number(telegramId)},and(is_group_shared.eq.true,group_name.eq."${safeGroup}")`);
    } else if (groupName) {
      query = query.eq('group_name', groupName);
    } else if (telegramId) {
      query = query.eq('creator_id', Number(telegramId));
    }

    const { data, error } = await query;
    if (error) {
      // Try class_notes fallback
      const { data: altData } = await supabase
        .from('class_notes')
        .select('*')
        .in('status', ['pending', 'snoozed'])
        .eq('target_date', dateStr);
      const resData = altData || [];
      if (isGlobalDateQuery) {
        setDueNotesCache(dateStr, resData, now + DUE_NOTES_CACHE_TTL_MS);
      }
      return resData;
    }

    const resData = data || [];
    if (isGlobalDateQuery) {
      setDueNotesCache(dateStr, resData, now + DUE_NOTES_CACHE_TTL_MS);
    }
    return resData;
  } catch (err) {
    logger.error('getDueNotesForLesson exception:', { error: err.message });
    if (isGlobalDateQuery && dueNotesCache.has(dateStr)) {
      return dueNotesCache.get(dateStr).data;
    }
    return [];
  }
}

/**
 * Retrieves a single course note by its primary ID.
 * @param {number|string} noteId
 */
async function getNoteById(noteId) {
  if (!supabase || !noteId) return null;
  try {
    const id = Number(noteId);
    let { data, error } = await supabase
      .from('course_notes')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error || !data) {
      const alt = await supabase.from('class_notes').select('*').eq('id', id).maybeSingle();
      data = alt.data;
    }
    return data || null;
  } catch (err) {
    logger.error('getNoteById error:', { noteId, error: err.message });
    return null;
  }
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
  if (!supabase || !noteId) return false;
  try {
    const id = Number(noteId);
    const updates = {
      updated_at: new Date().toISOString(),
    };

    if (newStatus === 'notified_before_class') {
      updates.notified_before_class_at = new Date().toISOString();
    } else if (newStatus) {
      updates.status = newStatus;
      if (newStatus === 'notified_evening') {
        updates.notified_evening_at = new Date().toISOString();
      }
    }

    if (newStatus === 'snoozed' || newTargetDate) {
      updates.notified_before_class_at = null;
      updates.notified_evening_at = null;
    }

    if (newTargetDate) updates.target_date = newTargetDate;
    if (newTargetPeriod) updates.target_period = Number(newTargetPeriod);
    if (newStartTime) updates.target_start_time = newStartTime;

    if (extraFields && typeof extraFields === 'object') {
      Object.assign(updates, extraFields);
    }

    let query = supabase.from('course_notes').update(updates).eq('id', id);
    if (telegramId) {
      query = query.eq('creator_id', Number(telegramId));
    }
    let { error } = await query;

    if (error && error.message?.includes('course_notes')) {
      const altQuery = supabase.from('class_notes').update(updates).eq('id', id);
      const res = await altQuery;
      error = res.error;
    }

    invalidateDueNotesCache();
    return !error;
  } catch (err) {
    logger.error('updateNoteStatus exception:', { noteId, error: err.message });
    return false;
  }
}

/**
 * Retrieves all active/pending notes for a user and their group.
 * @param {number|string} telegramId
 * @param {string|null} groupName
 */
async function getUserActiveNotes(telegramId, groupName = null) {
  if (!supabase || !telegramId) return [];
  try {
    const uid = Number(telegramId);
    const edupageService = require('./edupageService');
    const nowTz = edupageService.getTashkentNow();
    const todayIso = `${nowTz.getFullYear()}-${String(nowTz.getMonth() + 1).padStart(2, '0')}-${String(nowTz.getDate()).padStart(2, '0')}`;

    let query = supabase
      .from('course_notes')
      .select('*')
      .in('status', ['pending', 'notified_evening', 'snoozed'])
      .gte('target_date', todayIso)
      .order('target_date', { ascending: true })
      .order('target_period', { ascending: true });

    if (groupName) {
      const safeGroup = String(groupName).replace(/"/g, '').trim();
      query = query.or(`creator_id.eq.${uid},and(is_group_shared.eq.true,group_name.eq."${safeGroup}")`);
    } else {
      query = query.eq('creator_id', uid);
    }

    const { data, error } = await query;
    if (error) {
      // Fallback to class_notes
      const altQuery = supabase
        .from('class_notes')
        .select('*')
        .in('status', ['pending', 'snoozed'])
        .gte('target_date', todayIso)
        .order('target_date', { ascending: true });
      if (groupName) {
        const safeGroup = String(groupName).replace(/"/g, '').trim();
        altQuery.or(`creator_id.eq.${uid},and(is_group_note.eq.true,group_name.eq."${safeGroup}")`);
      } else {
        altQuery.eq('creator_id', uid);
      }
      const altRes = await altQuery;
      return altRes.data || [];
    }
    return data || [];
  } catch (err) {
    logger.error('getUserActiveNotes exception:', { telegramId, error: err.message });
    return [];
  }
}

module.exports = {
  loadAllOfficialTests,
  saveOfficialTest,
  getUserStats,
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
  saveUserTest,
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
};

