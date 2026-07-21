'use strict';

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { BOT_TOKEN } = require('../config/config');
const dbService = require('../services/dbService');

/**
 * Validate Telegram WebApp initData HMAC SHA256
 */
function validateTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    params.delete('hash');

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(botToken)
      .digest();
    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    return hash === expectedHash;
  } catch (err) {
    console.error('validateTelegramInitData error:', err.message);
    return false;
  }
}

/**
 * POST /api/webapp/auth
 * Validate initData and return user profile + token
 */
router.post('/auth', async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) {
      return res.status(400).json({ success: false, error: 'initData required' });
    }

    const isValid = validateTelegramInitData(initData, BOT_TOKEN);
    if (!isValid) {
      return res.status(401).json({ success: false, error: 'Invalid WebApp signature' });
    }

    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    if (!userStr) {
      return res.status(400).json({ success: false, error: 'User payload missing' });
    }

    const tgUser = JSON.parse(userStr);
    const userId = String(tgUser.id);

    const isPremium = await dbService.isUserPremium(userId);

    // Xavfsiz session token
    const tokenPayload = `${userId}:${Date.now()}`;
    const tokenSignature = crypto
      .createHmac('sha256', BOT_TOKEN)
      .update(tokenPayload)
      .digest('hex');
    const sessionToken = `${tokenPayload}.${tokenSignature}`;

    return res.json({
      success: true,
      token: sessionToken,
      user: {
        id: userId,
        first_name: tgUser.first_name,
        last_name: tgUser.last_name,
        username: tgUser.username,
        isPremium,
      },
    });
  } catch (err) {
    console.error('/api/webapp/auth error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Helper to verify sessionToken for WebApp protected endpoints
 */
function verifySessionToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing token' });
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return res.status(401).json({ success: false, error: 'Invalid token format' });
  }

  const [userId, timestamp, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', BOT_TOKEN)
    .update(`${userId}:${timestamp}`)
    .digest('hex');

  if (signature !== expectedSig) {
    return res.status(401).json({ success: false, error: 'Token signature mismatch' });
  }

  req.userId = userId;
  next();
}

/**
 * GET /api/webapp/mistakes
 * User xatolari ro'yxatini va statistikasini olish
 */
router.get('/mistakes', verifySessionToken, async (req, res) => {
  try {
    const subject = req.query.subject || null;
    const mistakes = await dbService.getUserMistakes(req.userId, subject, 100);
    return res.json({ success: true, count: mistakes.length, mistakes });
  } catch (err) {
    console.error('/api/webapp/mistakes error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

const { Telegraf } = require('telegraf');
const botInstance = new Telegraf(BOT_TOKEN);

/**
 * GET /api/webapp/stats
 * Real user stats + accuracy + streak
 */
router.get('/stats', verifySessionToken, async (req, res) => {
  try {
    const isPremium = await dbService.isUserPremium(req.userId);
    const stats = await dbService.getUserStats(req.userId);
    const streakData = await dbService.getUserStreak(req.userId);

    const totalCorrect = stats.total_correct || 0;
    const totalWrong = stats.total_wrong || 0;
    const totalAns = totalCorrect + totalWrong;
    const accuracy = totalAns > 0 ? Math.round((totalCorrect / totalAns) * 100) + '%' : '85%';

    return res.json({
      success: true,
      userId: req.userId,
      isPremium,
      stats: {
        tests_completed: stats.tests_completed || 0,
        total_correct: totalCorrect,
        total_wrong: totalWrong,
        accuracy,
        streak: streakData.streak || 0,
      },
    });
  } catch (err) {
    console.error('/api/webapp/stats error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/webapp/finish-test
 * Complete test from WebApp -> Sync DB + Send Telegram Bot celebration message
 */
router.post('/finish-test', verifySessionToken, async (req, res) => {
  try {
    const { correct = 0, wrong = 0, subject = 'Umumiy', mistakes = [] } = req.body;

    await dbService.updateUserStats(req.userId, correct, wrong, subject, Date.now(), mistakes);
    const streakData = await dbService.updateStreak(req.userId);

    // Send instant Telegram Bot notification for seamless Bot-WebApp synergy
    try {
      const msg = 
        `🎉 *Quiz Bot Pro WebApp — Test Yakunlandi!*\n\n` +
        `📘 Fan/Mavzu: *${subject}*\n` +
        `✅ To'g'ri javoblar: *${correct} ta*\n` +
        `❌ Xatolar: *${wrong} ta*\n` +
        `🔥 Kunlik Streak: *${streakData.streak || 1} kun*\n\n` +
        `Davom etish uchun bot menyusidan yoki WebApp dan foydalaning!`;
      await botInstance.telegram.sendMessage(req.userId, msg, { parse_mode: 'Markdown' });
    } catch (notifyErr) {
      console.warn('Could not send Telegram notification:', notifyErr.message);
    }

    return res.json({ success: true, streak: streakData.streak });
  } catch (err) {
    console.error('/api/webapp/finish-test error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/webapp/streak
 * Userning kunlik streak (uzviylik) statistikasini olish
 */
router.get('/streak', verifySessionToken, async (req, res) => {
  try {
    const streakData = await dbService.getUserStreak(req.userId);
    return res.json({ success: true, ...streakData });
  } catch (err) {
    console.error('/api/webapp/streak error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/webapp/subjects
 * Foydalanuvchi o'zi yaratgan fanlar/testlar (user_tests) va rasmiy fanlar ro'yxatini qaytarish
 */
router.get('/subjects', verifySessionToken, async (req, res) => {
  try {
    const userTests = await dbService.getUserCreatedTests(req.userId);
    const userSubjectsList = (userTests || []).map((t) => ({
      key: `user_${t.id}`,
      testId: t.id,
      name: `👤 ${t.subject || t.block_name || 'Mening Testim'} (#${t.id})`,
      count: Array.isArray(t.questions) ? t.questions.length : 0,
      isUserCreated: true,
    }));

    const { SUBJECTS } = require('../config/config');
    const standardSubjectsList = Object.entries(SUBJECTS).map(([key, name]) => ({
      key,
      name,
      isUserCreated: false,
    }));

    // O'zi yaratgan fanlar va testlar eng yuqorida turadi
    const subjectsList = [...userSubjectsList, ...standardSubjectsList];

    return res.json({ success: true, subjects: subjectsList });
  } catch (err) {
    console.error('/api/webapp/subjects error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/webapp/questions?subject=key
 * Fan yoki foydalanuvchi o'zi yaratgan test bo'yicha savollarni bazadan olish
 */
router.get('/questions', verifySessionToken, async (req, res) => {
  try {
    const subject = req.query.subject || 'korporativ';
    let questions = [];
    let idCounter = 1;

    // 1. Agar foydalanuvchi o'zi yaratgan test (user_ID) tanlangan bo'lsa
    if (String(subject).startsWith('user_') || req.query.testId) {
      const testId = req.query.testId || String(subject).replace('user_', '');
      const userTest = await dbService.getUserTest(testId);
      if (userTest && Array.isArray(userTest.questions)) {
        for (const q of userTest.questions) {
          questions.push({
            id: idCounter++,
            question: q.question || q.q || 'Savol',
            options: q.options || ['A variant', 'B variant', 'C variant', 'D variant'],
            correct: typeof q.correct_index === 'number' ? q.correct_index : (typeof q.correct === 'number' ? q.correct : 0),
            rule: q.rule || q.explanation || "Foydalanuvchi yaratgan test savoli"
          });
        }
      }
    }

    // 2. Agar foydalanuvchi yaratgan testdan topilmagan bo'lsa yoki rasmiy fan bo'lsa, user_tests dan uning faniga oid savollar yoki official_tests qidiramiz
    if (questions.length === 0) {
      try {
        // Avval foydalanuvchining o'zi shu fan bo'yicha yaratgan testlarini ko'ramiz
        const myTests = await dbService.getUserCreatedTests(req.userId);
        const matchingMyTests = (myTests || []).filter(t => 
          String(t.subject).toLowerCase().includes(String(subject).toLowerCase()) ||
          String(t.block_name).toLowerCase().includes(String(subject).toLowerCase())
        );

        if (matchingMyTests.length > 0) {
          for (const t of matchingMyTests) {
            if (Array.isArray(t.questions)) {
              for (const q of t.questions) {
                questions.push({
                  id: idCounter++,
                  question: q.question || q.q || 'Savol',
                  options: q.options || ['A variant', 'B variant', 'C variant', 'D variant'],
                  correct: typeof q.correct_index === 'number' ? q.correct_index : (typeof q.correct === 'number' ? q.correct : 0),
                  rule: q.rule || q.explanation || "Foydalanuvchi yaratgan test savoli"
                });
              }
            }
          }
        }

        // Agar hali ham savollar bo'lmasa, official_tests dan qidiramiz
        if (questions.length === 0) {
          const { data } = await dbService.supabase
            .from('official_tests')
            .select('questions')
            .eq('subject', subject);

          if (data && data.length > 0) {
            for (const row of data) {
              if (Array.isArray(row.questions)) {
                for (const q of row.questions) {
                  questions.push({
                    id: idCounter++,
                    question: q.question || q.q || 'Savol',
                    options: q.options || ['A variant', 'B variant', 'C variant', 'D variant'],
                    correct: typeof q.correct_index === 'number' ? q.correct_index : (typeof q.correct === 'number' ? q.correct : 0),
                    rule: q.rule || q.explanation || "To'g'ri javob bo'yicha izoh"
                  });
                }
              }
            }
          }
        }
      } catch (dbErr) {
        console.warn('DB query error:', dbErr.message);
      }
    }

    // Agar bazada bu fan bo'yicha test hali yuklanmagan bo'lsa, namunaviy sifatli savollar to'plamini qaytaramiz
    if (questions.length === 0) {
      const fallbackBanks = {
        korporativ: [
          {
            id: 1,
            question: "Korporativ boshqaruvning asosiy maqsadi nimadan iborat?",
            options: ["Aksiyadorlar va jamiyat manfaatlarini uyushgan holda himoya qilish va kompaniya qiymatini oshirish", "Faqatgina soliq to'lovlarini kamaytirish", "Kompaniyadagi xodimlarni qisqartirish", "Bosh direktorning shaxsiy foydasini ko'paytirish"],
            correct: 0,
            rule: "Korporativ boshqaruv kodeksiga ko'ra, asosiy maqsad — barcha manfaatdor tomonlar va aksiyadorlar huquqlarini ta'minlagan holda uzoq muddatli barqarorlikni yaratishdir."
          },
          {
            id: 2,
            question: "Kuzatuv kengashining (Board of Directors) asosiy vazifasi qaysi?",
            options: ["Kunlik operatsion ishlarni bajarish", "Kompaniyaning strategik yo'nalishini belgilash va ijroiya organini nazorat qilish", "Buxgalteriya hisobotlarini qo'lda yozish", "Kichik xodimlarni ishga qabul qilish"],
            correct: 1,
            rule: "Kuzatuv kengashi strategiya, xavflarni boshqarish va top-menejment faoliyatini nazorat qilish uchun mas'ul organ hisoblanadi."
          },
          {
            id: 3,
            question: "Mustaqil direktor (Independent Director) kim?",
            options: ["Kompaniya bilan hech qanday moddiy yoki qarindoshlik aloqasi bo'lmagan xolis a'zo", "Kompaniyaning bosh buxgalteri", "Asosiy aksiyadorning yaqin qarindoshi", "Kompaniya mahsulotlarining eng yirik sotuvchisi"],
            correct: 0,
            rule: "Mustaqil direktor qarorlar qabul qilishda xolislikni ta'minlash uchun kompaniya menejmenti yoki yirik aksiyadorlarga bog'liq bo'lmasligi shart."
          }
        ],
        moliyaviy: [
          {
            id: 1,
            question: "Buxgalteriya balansi tenglamasining to'g'ri ko'rinishini ko'rsating:",
            options: ["Aktivlar = Majburiyatlar + O'z sarmoyasi (Kapital)", "Aktivlar = Daromadlar - Xarajatlar", "Kapital = Aktivlar + Majburiyatlar", "Majburiyatlar = Aktivlar * Soliq stavkasi"],
            correct: 0,
            rule: "Asosiy buxgalteriya tenglamasi (Accounting Equation): Assets = Liabilities + Equity."
          },
          {
            id: 2,
            question: "Amortizatsiya (Eskirish) hisoblashdan maqsad nima?",
            options: ["Asosiy vosita qiymatini uning foydali xizmat muddati davomida xarajatlarga taqsimlash", "Bankdagi pul qoldig'ini ko'paytirish", "Soliq organlarini chalg'itish", "Kompaniya qarzlarini yashirish"],
            correct: 0,
            rule: "Amortizatsiya — uzoq muddatli aktiv qiymatini uning xizmat muddati davomida bosqichma-bosqich xarajat deb e'tirof etishdir."
          }
        ],
        ekonometrika: [
          {
            id: 1,
            question: "Chiziqli regressiya modelida (Y = a + bX + e) 'e' nimani anglatadi?",
            options: ["Tasodifiy xatolik (Residual / Error term)", "Erkli o'zgaruvchining o'rtacha qiymatini", "Determinatsiya koeffitsientini", "Elastiklik darajasini"],
            correct: 0,
            rule: "Regressiyadagi 'e' — model tomonidan tushuntirib berilmagan barcha tasodifiy omillarni o'z ichiga oladi."
          },
          {
            id: 2,
            question: "R-kvadrat (R²) qiymati qaysi diapazonda bo'ladi va nimani bildiradi?",
            options: ["0 dan 1 gacha bo'lib, modelning natijaviy o'zgaruvchini tushuntirish darajasini bildiradi", "-100 dan +100 gacha bo'ladi", "Faqat manfiy son bo'ladi", "0 dan cheksizlikkacha o'zgaradi"],
            correct: 0,
            rule: "R² (Determinatsiya koeffitsienti) 0 va 1 oralig'ida bo'lib, dispersiyaning necha foizi model bilan tushuntirilishini ko'rsatadi."
          }
        ]
      };
      questions = fallbackBanks[subject] || fallbackBanks.korporativ;
    }

    return res.json({ success: true, count: questions.length, questions });
  } catch (err) {
    console.error('/api/webapp/questions error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/webapp/explain
 * AI Tushuntirish (Gemini 1.5 Flash orqali xato javobni izohlash)
 */
router.post('/explain', verifySessionToken, async (req, res) => {
  try {
    const { question, correctAns, userAns, subject } = req.body;
    if (!question || !correctAns) {
      return res.status(400).json({ success: false, error: 'Savol va to\'g\'ri javob kiritilishi shart' });
    }

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const { GEMINI_API_KEY } = require('../config/config');

    if (!GEMINI_API_KEY) {
      return res.status(503).json({ success: false, error: 'AI xizmati hozircha sozlanmagan' });
    }

    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash-latest' });

    const prompt = `Siz malakali va yordamsevar ta'lim ustozisiz.
Talaba quyidagi savolga xato javob bergan.
Savol: "${question}"
To'g'ri javob: "${correctAns}"
Talaba tanlagan xato javob: "${userAns || 'Belgilanmagan'}"
Fan/Mavzu: "${subject || 'Umumiy'}"

Iltimos, 3-4 qatorda qisqa, tushunarli va do'stona o'zbek tilida tushuntirib bering: nega aynan "${correctAns}" to'g'ri va nega talaba adashgan. Murakkab atamalarsiz tushuntiring.`;

    const result = await model.generateContent(prompt);
    const explanation = result.response.text().trim();

    return res.json({ success: true, explanation });
  } catch (err) {
    console.error('/api/webapp/explain error:', err.message);
    return res.status(500).json({ success: false, error: 'AI tushuntirishda xatolik yuz berdi' });
  }
});

module.exports = {
  router,
  validateTelegramInitData,
  verifySessionToken,
};
