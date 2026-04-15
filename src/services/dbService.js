'use strict';

const { createClient } = require('@supabase/supabase-js');
// Yo'l to'g'rilandi: src/config/config.js dan o'qiydi
const { SUPABASE_URL, SUPABASE_KEY } = require('../config/config');

let supabase;
try {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
} catch (e) {
  console.error('Supabase ulanish xatosi:', e.message);
}

async function loadAllOfficialTests() {
  try {
    const { data, error } = await supabase.from ('official_tests').select('*');
    if (error) throw error;
    const db = {};
    for (const row of data) {
      const subj = row.subject;
      const tId  = parseInt(row.test_id, 10);
      if (!db[subj]) db[subj] = {};
      db[subj][tId] = { test_id: tId, range: `1-${row.questions.length}`, questions: row.questions };
    }
    return db;
  } catch (e) {
    console.error('Rasmiy testlarni yuklashda xato:', e.message);
    return {};
  }
}

async function saveOfficialTest(subject, testId, questions) {
  try {
    const { data } = await supabase.from('official_tests').select('id').eq('subject', subject).eq('test_id', testId);
    if (data && data.length > 0) {
      await supabase.from('official_tests').update({ questions }).eq('id', data[0].id);
    } else {
      await supabase.from('official_tests').insert({ subject, test_id: testId, questions });
    }
    return true;
  } catch (e) { return false; }
}

async function getUserStats(userId) {
  const uid = String(userId);
  try {
    const { data } = await supabase.from('user_stats').select('*').eq('user_id', uid);
    if (data && data.length > 0) {
      const u = data[0];
      if (!u.history) u.history = [];
      return u;
    }
    return { user_id: uid, tests_completed: 0, total_correct: 0, total_wrong: 0, history: [] };
  } catch {
    return { tests_completed: 0, total_correct: 0, total_wrong: 0, history: [] };
  }
}

async function updateUserStats(userId, correct, wrong, subjectKey, testId, mistakes) {
  const uid = String(userId);
  const stats = await getUserStats(uid);
  stats.tests_completed++;
  stats.total_correct += correct;
  stats.total_wrong += wrong;

  const entry = {
    date: new Date().toISOString().slice(0, 16).replace('T', ' '),
    subject: subjectKey,
    test_id: testId,
    correct,
    wrong,
    mistakes,
  };
  if (!Array.isArray(stats.history)) stats.history = [];
  stats.history.unshift(entry);
  stats.history = stats.history.slice(0, 15);

  try { await supabase.from('user_stats').upsert(stats); } 
  catch (e) { console.error('Stats saqlashda xato:', e.message); }
}

async function getUserRank(userId) {
  try {
    const { data } = await supabase.from('user_stats').select('user_id, total_correct').order('total_correct', { ascending: false });
    if (!data) return 'N/A';
    const idx = data.findIndex(r => r.user_id === String(userId));
    return idx === -1 ? 'N/A' : idx + 1;
  } catch { return 'N/A'; }
}

async function registerUser(userId, fullName, username) {
  const uid = String(userId);
  try {
    const { data } = await supabase.from('users').select('telegram_id').eq('telegram_id', uid);
    if (!data || data.length === 0) {
      await supabase.from('users').insert({
        telegram_id: uid,
        full_name: fullName || 'Ismsiz',
        username: username || "yo'q",
        joined_at: new Date().toISOString().slice(0, 16).replace('T', ' '),
      });
    }
  } catch { /* silent */ }
}

async function getAllUsers() {
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw error;
    return data;
  } catch (err) { return null; }
}

async function getTopUsers(limit = 10) {
  try {
    const { data } = await supabase.from('user_stats').select('*').order('total_correct', { ascending: false }).limit(limit);
    if (!data) return [];
    return data.filter(s => s.total_correct > 0).map(s => ({ user_id: s.user_id, correct: s.total_correct, completed: s.tests_completed }));
  } catch { return []; }
}

async function saveUserTest(creatorId, subject, blockName, questions) {
  try {
    const { data, error } = await supabase.from('user_tests').insert({
      creator_id: String(creatorId), subject, block_name: blockName, questions,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }).select('id');
    if (error) throw error;
    return data[0].id;
  } catch (e) { return null; }
}

async function getUserTest(testId) {
  try {
    const { data } = await supabase.from('user_tests').select('*').eq('id', parseInt(testId, 10));
    return (data && data.length > 0) ? data[0] : null;
  } catch { return null; }
}

async function getUserCreatedTests(creatorId) {
  try {
    const { data } = await supabase.from('user_tests').select('id, subject, block_name, created_at, questions')
      .eq('creator_id', String(creatorId)).order('id', { ascending: false });
    return data || [];
  } catch { return []; }
}

async function deleteUserTest(testId, creatorId) {
  try {
    await supabase.from('user_tests').delete().eq('id', parseInt(testId, 10)).eq('creator_id', String(creatorId));
    return true;
  } catch { return false; }
}

async function updateUserClass(telegramId, className) {
  try {
    const { error } = await supabase.from('users').update({ class_name: className }).eq('telegram_id', telegramId);
    if (error) return false;
    return true;
  } catch (e) { return false; }
}

async function getUserClass(telegramId) {
  try {
    const { data, error } = await supabase.from('users').select('class_name').eq('telegram_id', telegramId).single();
    if (error) return null;
    return data?.class_name || null;
  } catch (e) { return null; }
}
// Mavjud testning savollarini yangilash
async function updateUserTestQuestions(testId, creatorId, newQuestions) {
  try {
    const { error } = await supabase.from('user_tests')
      .update({ questions: newQuestions })
      .eq('id', parseInt(testId, 10))
      .eq('creator_id', String(creatorId));
    if (error) throw error;
    return true;
  } catch (e) { 
    return false; 
  }
}
// ==========================================
// YANGI: JAVON (SHELF) BILAN ISHLASH
// ==========================================

// Foydalanuvchining butun javonini olish
async function getUserShelf(userId) {
    const stats = await getUserStats(userId);
    return stats.shelf || {}; 
    // Format: { "Asosiy": [...testlar], "Ertangi imtihonga": [...testlar] }
}

// Foydalanuvchining javonini yangilash
async function updateUserShelf(userId, shelf) {
    try {
        const { error } = await supabase.from('user_stats').update({ shelf }).eq('user_id', String(userId));
        if (error) throw error;
        return true;
    } catch (e) {
        console.error('Javonni yangilashda xato:', e);
        return false;
    }
}

// Javonga test saqlash (yoki chala progressni saqlash)
async function saveTestToShelf(userId, folderName, testInfo) {
    try {
        const stats = await getUserStats(userId);
        let shelf = stats.shelf || {};
        
        // Agar papka yo'q bo'lsa, yaratamiz
        if (!shelf[folderName]) shelf[folderName] = [];

        // Duplikatni tekshirish (Shu test avval saqlanganmi?)
        const isExist = shelf[folderName].find(t => String(t.testId) === String(testInfo.testId));
        if (isExist) return 'exist'; // Allaqachon bor

        // Testni qo'shish
        shelf[folderName].push({
            testId: testInfo.testId,
            testName: testInfo.testName,
            subject: testInfo.subject,
            questions: testInfo.questions, // AI testlar yo'qolmasligi uchun savollar saqlanadi
            saved_at: new Date().toISOString(),
            progress: testInfo.progress || null // Agar chala to'xtatgan bo'lsa, o'sha joyi saqlanadi
        });

        // Supabase ga yangilash
        const { error } = await supabase.from('user_stats').update({ shelf }).eq('user_id', String(userId));
        if (error) throw error;
        
        return 'saved';
    } catch (e) {
        console.error('Javonga saqlashda xato:', e);
        return 'error';
    }
}

// ==========================================
// BAN FOYDALANUVCHI
// ==========================================
async function banUser(userId) {
  try {
    const { error } = await supabase.from('users').update({ is_banned: true }).eq('telegram_id', String(userId));
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('banUser xatosi:', e.message);
    return false;
  }
}

async function isUserBanned(userId) {
  try {
    const { data } = await supabase.from('users').select('is_banned').eq('telegram_id', String(userId)).single();
    return data?.is_banned === true;
  } catch {
    return false;
  }
}

module.exports = {
  loadAllOfficialTests, saveOfficialTest, getUserStats, updateUserStats, getUserRank,
  registerUser, getAllUsers, getTopUsers, saveUserTest, getUserTest, getUserCreatedTests,
  deleteUserTest, updateUserClass, getUserClass, updateUserTestQuestions, getUserShelf, saveTestToShelf, updateUserShelf,
  banUser, isUserBanned,
};
