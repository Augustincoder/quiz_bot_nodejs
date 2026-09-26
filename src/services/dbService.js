'use strict';

const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_KEY } = require('../config/config');
const { TTLMap } = require('../core/utils');
const redis = require('./redisService');
const logger = require('../core/logger');

let supabase = null;
try {
  if (SUPABASE_URL && SUPABASE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  } else {
    logger.warn('SUPABASE_URL or SUPABASE_KEY is missing. Operating in fallback mode.');
  }
} catch (e) {
  logger.error('Supabase ulanish xatosi:', { error: e.message });
}

// In-memory fallback cache for timetable CDN metadata (bounded to 1000 items)
const fallbackTimetableCache = new TTLMap(24 * 60 * 60 * 1000, 1000);

async function loadAllOfficialTests() {
  if (!supabase) return {};
  try {
    const { data, error } = await supabase.from('official_tests').select('*');
    if (error) throw error;
    const db = {};
    for (const row of (data || [])) {
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
    return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [] };
  } catch (err) {
    logger.error('getUserStats error:', { userId: uid, error: err.message });
    return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [], _fetchFailed: true };
  }
}

async function updateUserStats(userId, correct, wrong, subjectKey, testId, mistakes) {
  const uid = String(userId);
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
    const { error } = await supabase.from('user_stats').upsert(stats, { onConflict: 'user_id' });
    if (error) throw error;

    await redis.set(`cache:user_stats:${uid}`, JSON.stringify(stats), 'EX', 300).catch(() => {});
    if (correct > 0) {
      await redis.del('cache:leaderboard:top10').catch(() => {});
    }
  } catch (e) {
    logger.error('Stats saqlashda xato:', { userId: uid, error: e.message });
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

async function getAllUserStats() {
  try {
    const { data, error } = await supabase
      .from('user_stats')
      .select('user_id, total_correct, total_wrong, tests_completed, history');
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getAllUserStats error:', { error: err.message });
    return [];
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
  try {
    const { data, error, count } = await supabase
      .from('users')
      .select('*', { count: 'exact' })
      .order('id', { ascending: false })
      .range(from, to);

    if (error) throw error;
    return { users: data || [], total: count ?? 0 };
  } catch (err) {
    logger.error('getUsersPaginated error:', { page, limit, error: err.message });
    return { users: [], total: 0 };
  }
}

async function searchUsers(query, limit = 20) {
  if (!query) return [];
  const cleanQuery = String(query).trim().replace(/[,()]/g, '');
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
    const { data, error } = await supabase
      .from('users')
      .select('telegram_id, full_name');
    if (error) throw error;
    return data || [];
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
    const { data, error } = await supabase
      .from('users')
      .select('telegram_id, name, class_name')
      .ilike('class_name', className);
    if (error) throw error;
    return data || [];
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

async function getUserCreatedTests(creatorId) {
  try {
    const { data, error } = await supabase
      .from('user_tests')
      .select('id, subject, block_name, created_at, questions')
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

    shelf[folderName].push({
      testId: testInfo.testId,
      testName: testInfo.testName,
      subject: testInfo.subject,
      questions: testInfo.questions,
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

// ==========================================
// 🚫 BAN / UNBAN
// ==========================================

async function banUser(userId) {
  const uid = String(userId);
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
  try {
    const cached = await redis.get(`user_banned:${uid}`);
    if (cached !== null) return cached === '1';

    const { data, error } = await supabase
      .from('users')
      .select('is_banned')
      .eq('telegram_id', uid)
      .maybeSingle();

    if (error) throw error;
    const isBanned = data?.is_banned === true;
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

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (e) {
      logger.debug('Redis getTimetableCache error', { error: e.message });
    }
  }

  if (!supabase) return fallbackTimetableCache.get(cacheKey) || null;

  try {
    // 2. Direct query by primaryNorm
    let { data, error } = await supabase
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

  for (const n of keysToDelete) {
    if (theme) {
      const validTheme = ['dark', 'light', 'vibrant'].includes(theme) ? theme : 'dark';
      fallbackTimetableCache.delete(`cache:timetable_cdn:${n}:${validTheme}`);
      if (redis) await redis.del(`cache:timetable_cdn:${n}:${validTheme}`).catch(() => {});
    } else {
      ['dark', 'light', 'vibrant'].forEach(t => {
        fallbackTimetableCache.delete(`cache:timetable_cdn:${n}:${t}`);
      });
      if (redis) {
        ['dark', 'light', 'vibrant'].forEach(t => {
          redis.del(`cache:timetable_cdn:${n}:${t}`).catch(() => {});
        });
      }
    }
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
};
