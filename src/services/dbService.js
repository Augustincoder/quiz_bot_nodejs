'use strict';

const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_KEY } = require('../config/config');
const redis = require('./redisService');
const logger = require('../core/logger');

let supabase;
try {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
  logger.error('Supabase ulanish xatosi:', { error: e.message });
}

async function loadAllOfficialTests() {
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
    return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [] };
  }
}

async function updateUserStats(userId, correct, wrong, subjectKey, testId, mistakes) {
  const uid = String(userId);
  const stats = await getUserStats(uid);
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
    const { error } = await supabase.from('user_stats').upsert(stats);
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
  try {
    const { data, error } = await supabase
      .from('users')
      .select('telegram_id')
      .or('is_banned.is.null,is_banned.eq.false');
    if (error) throw error;
    return (data || []).map(u => u.telegram_id);
  } catch (err) {
    logger.error('getBroadcastRecipients error:', { error: err.message });
    return [];
  }
}

async function getAllUserNames() {
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
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw error;
    return data || [];
  } catch (err) {
    logger.error('getAllUsers error:', { error: err.message });
    return [];
  }
}

async function getUsersByClassName(className) {
  if (!className) return [];
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

async function updateUserClass(telegramId, className) {
  try {
    const { error } = await supabase.from('users').update({ class_name: className }).eq('telegram_id', String(telegramId));
    if (error) return false;
    await redis.set(`user_class:${telegramId}`, className, 'EX', 86400).catch(() => {});
    return true;
  } catch (e) {
    logger.error('updateUserClass error:', { telegramId, error: e.message });
    return false;
  }
}

async function getUserClass(telegramId) {
  try {
    const cached = await redis.get(`user_class:${telegramId}`);
    if (cached) return cached;

    const { data, error } = await supabase
      .from('users')
      .select('class_name')
      .eq('telegram_id', String(telegramId))
      .maybeSingle();

    if (error) return null;
    if (data?.class_name) {
      await redis.set(`user_class:${telegramId}`, data.class_name, 'EX', 86400).catch(() => {});
    }
    return data?.class_name || null;
  } catch (e) {
    logger.error('getUserClass error:', { telegramId, error: e.message });
    return null;
  }
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

    stats.shelf = shelf;
    const { error } = await supabase.from('user_stats').upsert(stats);
    if (error) throw error;

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
  getUserShelf,
  saveTestToShelf,
  saveToShelf,
  updateUserShelf,
  banUser,
  unbanUser,
  isUserBanned,
};
