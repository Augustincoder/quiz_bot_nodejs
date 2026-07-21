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
    const { error } = await supabase
      .from('user_stats')
      .upsert(stats, { onConflict: 'user_id' });
    if (error) throw error;
  } catch (e) {
    console.error('Stats saqlashda xato:', e.message);
  }
}

async function getUserRank(userId) {
  const uid = String(userId);
  try {
    const { data: userRow, error: fetchErr } = await supabase
      .from('user_stats')
      .select('total_correct')
      .eq('user_id', uid)
      .single();

    if (fetchErr || !userRow) return 'N/A';

    const userScore = userRow.total_correct || 0;
    const { count, error: countErr } = await supabase
      .from('user_stats')
      .select('user_id', { count: 'exact', head: true })
      .gt('total_correct', userScore);

    if (countErr) return 'N/A';
    return (count || 0) + 1;
  } catch {
    return 'N/A';
  }
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
        stats.shelf = shelf;
        const { error } = await supabase.from('user_stats').upsert(stats);
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

// ==========================================
// USER MISTAKES (Faza 1 — Adaptive Quiz)
// ==========================================
async function saveUserMistake(userId, subject, question, correctAns, wrongAns, testId = null) {
  try {
    const { error } = await supabase.from('user_mistakes').insert({
      user_id: String(userId),
      subject: subject || 'Nomaʼlum',
      question: String(question),
      correct_ans: String(correctAns),
      wrong_ans: String(wrongAns),
      test_id: testId ? String(testId) : null,
      created_at: new Date().toISOString()
    });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('user_mistakes saqlashda xato:', e.message);
    return false;
  }
}

async function saveUserMistakesBatch(userId, subject, testId, mistakesArray) {
  if (!Array.isArray(mistakesArray) || mistakesArray.length === 0) return true;
  try {
    const rows = mistakesArray.map(m => ({
      user_id: String(userId),
      subject: subject || 'Nomaʼlum',
      question: String(m.question || ''),
      correct_ans: String(m.correct_ans || m.correct || ''),
      wrong_ans: String(m.wrong_ans || m.wrong || ''),
      test_id: testId ? String(testId) : null,
      created_at: new Date().toISOString()
    }));
    const { error } = await supabase.from('user_mistakes').insert(rows);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('saveUserMistakesBatch xatosi:', e.message);
    return false;
  }
}

async function getUserMistakes(userId, subject = null, limit = 50) {
  try {
    let query = supabase.from('user_mistakes').select('*').eq('user_id', String(userId)).order('created_at', { ascending: false }).limit(limit);
    if (subject) {
      query = query.eq('subject', subject);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error('getUserMistakes xatosi:', e.message);
    return [];
  }
}

async function clearUserMistakes(userId, subject = null) {
  try {
    let query = supabase.from('user_mistakes').delete().eq('user_id', String(userId));
    if (subject) {
      query = query.eq('subject', subject);
    }
    const { error } = await query;
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('clearUserMistakes xatosi:', e.message);
    return false;
  }
}

// ==========================================
// PREMIUM FOYDALANUVCHILAR BILAN ISHLASH
// ==========================================
async function isUserPremium(userId) {
  try {
    const { data, error } = await supabase
      .from('users')
      .select('is_premium, premium_until')
      .eq('telegram_id', String(userId))
      .single();
    if (error || !data) return false;

    if (data.is_premium === true) {
      if (data.premium_until && new Date(data.premium_until) < new Date()) {
        await supabase
          .from('users')
          .update({ is_premium: false })
          .eq('telegram_id', String(userId));
        return false;
      }
      return true;
    }
    return false;
  } catch (e) {
    console.error('isUserPremium xatosi:', e.message);
    return false;
  }
}

async function activatePremium(userId, durationDays = 30) {
  try {
    const now = new Date();
    const premiumUntil = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from('users')
      .update({ is_premium: true, premium_until: premiumUntil })
      .eq('telegram_id', String(userId));
    if (error) throw error;
    return true;
  } catch (e) {
    console.error('activatePremium xatosi:', e.message);
    return false;
  }
}

// ==========================================
// GAMIFIKATSIYA & KUNLIK STREAK (FAZA 5)
// ==========================================
async function getUserStreak(userId) {
  const uid = String(userId);
  try {
    const { data, error } = await supabase
      .from('users')
      .select('streak_days, last_study_date')
      .eq('telegram_id', uid)
      .single();
    if (error || !data) return { streak_days: 0, last_study_date: null };
    return {
      streak_days: data.streak_days || 0,
      last_study_date: data.last_study_date || null,
    };
  } catch {
    return { streak_days: 0, last_study_date: null };
  }
}

async function updateStreak(userId) {
  const uid = String(userId);
  try {
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const { streak_days = 0, last_study_date } = await getUserStreak(uid);

    if (last_study_date === todayStr) {
      return { streak_days, updated: false }; // Bugun allaqachon hisoblangan
    }

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10);

    const newStreak = last_study_date === yesterdayStr ? streak_days + 1 : 1;

    await supabase
      .from('users')
      .update({ streak_days: newStreak, last_study_date: todayStr })
      .eq('telegram_id', uid);

    return { streak_days: newStreak, updated: true };
  } catch (err) {
    console.error('updateStreak xatosi:', err.message);
    return { streak_days: 0, updated: false };
  }
}

module.exports = {
  loadAllOfficialTests, saveOfficialTest, getUserStats, updateUserStats, getUserRank,
  registerUser, getAllUsers, getTopUsers, saveUserTest, getUserTest, getUserCreatedTests,
  deleteUserTest, updateUserClass, getUserClass, updateUserTestQuestions, getUserShelf, saveTestToShelf, updateUserShelf,
  banUser, isUserBanned,
  saveUserMistake, saveUserMistakesBatch, getUserMistakes, clearUserMistakes,
  isUserPremium, activatePremium,
  getUserStreak, updateStreak,
};
