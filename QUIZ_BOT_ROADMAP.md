# Quiz Bot — Texnik Roadmap v3.0
> **Maqsad:** Telegram Hajm Bot → Sessiya-based Imtihon Yordamchisi + WebApp  
> **Asos:** Mavjud kod (`quiz_bot_nodejs`) to'liq audit asosida tuzilgan  
> **Muddati:** 14 hafta (3 fazali)

---

## Joriy Holat — Audit Xulosasi

Kodbase umumiy sifati: **yaxshi**. Arxitektura asoslari to'g'ri qo'yilgan (Redis sessions, BullMQ queues, Sentry, Mutex, StateRouter). Lekin bir nechta kritik muammo mavjud bo'lib, ular ustiga yangi funksiya qurishdan oldin hal qilinishi shart.

### Kritik Bug'lar (deploy uchun bloker)

| # | Fayl | Muammo | Yechim |
|---|------|--------|--------|
| 1 | `aiService.js:9` | `gemini-3.1-flash-lite-preview` — mavjud emas | `gemini-1.5-flash-latest` ga almashtirish |
| 2 | `aiHandlers.js:13` | `userRateLimit` Map hech qachon tozalanmaydi → memory leak, server uzluksiz ishlasa xotira to'ladi | Redis TTL-based yechimga ko'chirish |
| 3 | `aiHandlers.js:6` | `const { config } = require('dotenv')` — noto'g'ri import, `config.ADMIN_ID` `undefined` qaytaradi | `const { ADMIN_ID } = require('../config/config')` |
| 4 | `dbService.js:51` | `stats.history.slice(0, 15)` — xatolar 15 tadan keyin o'chib ketadi, adaptive quiz uchun yetarli emas | Alohida `user_mistakes` jadval (quyida SQL) |
| 5 | `roomManager.js` | `this.rooms = new Map()` — server restart bo'lganda barcha live o'yinlar yo'qoladi | Redis-backed state (quyida yechim) |
| 6 | `aiHandlers.js` | `dailyUsage`, `monthlyUsage` in-memory — restart bo'lganda reset bo'ladi | Redis ga ko'chirish |

### Arxitektura Muammolari (yangi funksiyalar uchun bloker)

| # | Muammo | Sabab xavfli |
|---|--------|--------------|
| 7 | `dbService.getUserStats()` — shelf, history, stats hammasi bitta `user_stats` qatorda JSONB shaklida | Jadval o'sishi bilan so'rovlar sekinlashadi, atomic update imkonsiz |
| 8 | `official_tests`, `user_tests`, `user_stats` jadvallarida indeks yo'q | 1000+ userda full table scan, WebApp real-time uchun kritik |
| 9 | `adaptiveQuiz.js` — mistakes `stats.history[].mistakes` ichida saqlangan (nested JSONB) | Fanlar bo'yicha filtrlash noto'g'ri ishlaydi (`r.subject === subjectKey \|\| r.subjectKey === subjectKey` — ikki xil field nomi) |
| 10 | `aiService.js` — barcha rate limiting in-memory, funksiya limiti noto'g'ri sanaldi | `byFunction` counter reset logikasi kunlik resetda noto'g'ri ishlaydi |

---

## Faza 1 — Mustahkamlash (1–2-hafta)

Bu faza bajarilmasa, keyingi hamma narsa ustiga qurilgan muammolar 3–4x ko'payadi.

### 1.1 — Kritik Bug Fix (Kun 1–3)

**`aiService.js` — model nomi:**
```js
// ESKI (ishlarmaydi)
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });

// YANGI
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
```

**`aiHandlers.js` — import tuzatish:**
```js
// ESKI (noto'g'ri)
const { config } = require('dotenv');
// ...
const ADMIN_IDS = config.ADMIN_ID ? [parseInt(config.ADMIN_ID, 10)] : [];

// YANGI
const { ADMIN_ID } = require('../config/config');
// ...
const isAdmin = userId === ADMIN_ID;
```

**`aiHandlers.js` — userRateLimit Redis ga ko'chirish:**
```js
// ESKI (memory leak)
const userRateLimit = new Map();

// YANGI — redisService orqali
async function checkUserLimit(userId, isPremium = false, isAdmin = false) {
  if (isAdmin) return { allowed: true };
  const key = `ai_rl:${userId}`;
  const data = await redis.get(key);
  const limit = data ? JSON.parse(data) : { dailyCount: 0, hourlyCount: 0 };
  // ... reset logikasi Redis TTL orqali
}
```

### 1.2 — DB Schema Tuzatish (Kun 4–5)

```sql
-- 1. user_mistakes: xatolarni alohida jadvalda saqlash
CREATE TABLE user_mistakes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  subject     TEXT NOT NULL,
  question    TEXT NOT NULL,
  correct_ans TEXT NOT NULL,
  wrong_ans   TEXT NOT NULL,
  test_id     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);


CREATE INDEX idx_user_mistakes_user_subject ON user_mistakes(user_id, subject);
CREATE INDEX idx_user_mistakes_created ON user_mistakes(created_at DESC);

-- 2. Mavjud jadvallar uchun indekslar
CREATE INDEX IF NOT EXISTS idx_user_stats_correct ON user_stats(total_correct DESC);
CREATE INDEX IF NOT EXISTS idx_user_stats_user_id ON user_stats(user_id);
CREATE INDEX IF NOT EXISTS idx_user_tests_creator  ON user_tests(creator_id);
CREATE INDEX IF NOT EXISTS idx_official_tests_subj ON official_tests(subject);

-- 3. exam_sessions: Sessiya rejimi uchun (Faza 2 da ishlatiladi)
CREATE TABLE exam_sessions (
  id             BIGSERIAL PRIMARY KEY,
  user_id        TEXT NOT NULL,
  subject        TEXT NOT NULL,
  exam_date      DATE NOT NULL,
  status         TEXT DEFAULT 'active',   -- active | done | expired
  daily_plan     JSONB,
  readiness_pct  INT  DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_exam_sessions_user ON exam_sessions(user_id, status);

-- 4. payment_requests: To'lov tizimi uchun
CREATE TABLE payment_requests (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL,
  screenshot_file_id TEXT,
  amount_uzs        INT,
  plan              TEXT DEFAULT 'premium',
  status            TEXT DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by       TEXT,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- 5. users jadvaliga premium ustun qo'shish
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium    BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ;
```

### 1.3 — `user_mistakes` ga ko'chirish (Kun 5–6)

`dbService.js` da `updateUserStats` funksiyasini yangilash:

```js
// mistakes ni alohida jadvala yozish
async function saveMistakes(userId, subjectKey, testId, mistakes) {
  if (!mistakes || mistakes.length === 0) return;
  const rows = mistakes.map(m => ({
    user_id: String(userId),
    subject: subjectKey,
    question: m.question,
    correct_ans: m.correct_ans,
    wrong_ans: m.wrong_ans,
    test_id: String(testId),
  }));
  const { error } = await supabase.from('user_mistakes').insert(rows);
  if (error) console.error('saveMistakes error:', error.message);
}

// Faqat oxirgi N ta xatoni olish (adaptive uchun)
async function getUserMistakes(userId, subject, limit = 50) {
  const { data } = await supabase
    .from('user_mistakes')
    .select('*')
    .eq('user_id', String(userId))
    .eq('subject', subject)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data || [];
}
```

### 1.4 — RoomManager Redis-backed (Kun 6–7)

```js
// roomManager.js — in-memory Map o'rniga Redis
class RoomManager {
  _key(roomCode) { return `room:${roomCode}`; }

  async createRoom(roomCode, hostId) {
    const room = {
      roomCode, hostId,
      status: 'lobby',
      questions: [],
      currentIndex: 0,
      players: {},          // Map o'rniga plain object (JSON serializeable)
      kahootAnswers: {},
      leaderboardAcks: [],
    };
    await redis.set(this._key(roomCode), JSON.stringify(room), 'EX', 3600);
    return room;
  }

  async getRoom(roomCode) {
    const data = await redis.get(this._key(roomCode));
    return data ? JSON.parse(data) : null;
  }

  async updateRoom(roomCode, updates) {
    const room = await this.getRoom(roomCode);
    if (!room) throw new Error('Room not found');
    const updated = { ...room, ...updates };
    await redis.set(this._key(roomCode), JSON.stringify(updated), 'EX', 3600);
    return updated;
  }

  async deleteRoom(roomCode) {
    await redis.del(this._key(roomCode));
  }
}
// DIQQAT: Timer (readTimer, actionTimer) lar Redis da saqlanmaydi.
// Ularni roomManager tashqarisida, server xotirasida (Map) alohida boshqaring.
```

### 1.5 — adaptiveQuiz xato fieldlarini birlashtirish (Kun 7)

```js
// adaptiveQuiz.js — inconsistent field nomi tuzatish
const mistakes = await getUserMistakes(ctx.from.id, subjectKey, 50);
// Endi alohida jadvaldan keladi, .subject === subjectKey tekshiruvi korrekt
```

**Faza 1 natijalari:**
- ✅ Bot hech qanday crash bermaydi
- ✅ Xatolar to'g'ri saqlanadi va 50+ ta bo'lganda ham yo'qolmaydi
- ✅ Server restart bo'lganda live o'yinlar, room state yo'qolmaydi
- ✅ DB so'rovlari 5–10x tezlashadi

---

## Faza 2 — Sessiya Rejimi + WebApp (3–9-hafta)

### 2.1 — Premium tizimi (Kun 8–10)

**`dbService.js` ga qo'shish:**
```js
async function isUserPremium(userId) {
  const { data } = await supabase
    .from('users')
    .select('is_premium, premium_until')
    .eq('telegram_id', String(userId))
    .single();
  if (!data || !data.is_premium) return false;
  if (data.premium_until && new Date(data.premium_until) < new Date()) {
    // Muddati o'tgan — avtomatik o'chirish
    await supabase.from('users').update({ is_premium: false }).eq('telegram_id', String(userId));
    return false;
  }
  return true;
}

async function activatePremium(userId, durationDays = 30) {
  const until = new Date();
  until.setDate(until.getDate() + durationDays);
  const { error } = await supabase.from('users').update({
    is_premium: true,
    premium_until: until.toISOString(),
  }).eq('telegram_id', String(userId));
  return !error;
}
```

**To'lov flow (payment handler — yangi fayl `src/handlers/paymentHandler.js`):**
```
Foydalanuvchi "💎 Premium" → karta + narx ko'rsatiladi
→ Foydalanuvchi chek skrinshotini yuboradi
→ payment_requests jadvaliga saqlanadi
→ Admin bot orqali "✅ Tasdiqlash" yoki "❌ Rad etish" bosadi
→ Tasdiqlansa: activatePremium(userId, 30) chaqiriladi
→ Foydalanuvchiga: "✅ 30 kunlik Premium faollashtirildi!"
```

**Tarif (ikki daraja yetarli):**

| Xususiyat | Free | Premium |
|-----------|------|---------|
| Rasmiy testlar | ✅ Cheksiz | ✅ Cheksiz |
| Guruh musobaqasi | ✅ | ✅ |
| Sessiya rejimi | 1 fan | Cheksiz fan |
| AI tushuntirish | 5/kun | 50/kun |
| PDF → Test | 1 marta | Cheksiz |
| Flashcard | ✅ | ✅ |
| Blind Exam | ✅ | ✅ |

### 2.2 — Sessiya Rejimi (Kun 11–20)

Bu botning asosiy farqlovchi xususiyati. Boshqa o'zbek quiz botlarida mavjud emas.

**Oqim:**
```
/sessiya → Fan nomi + imtihon sanasi kiritiladi
         → Bot daily_plan hisoblaydi
         → Har kirganda "Bugungi reja" ko'rsatiladi (push emas)
         → Imtihon kun yaqinlashganda 1 marta eslatma
         → Imtihondan keyin "yopiladi", readiness_pct saqlanadi
```

**`src/handlers/sessionHandler.js` — yangi fayl:**
```js
'use strict';
const { Markup } = require('telegraf');
const { States, setState, clearState } = require('../core/utils');
const supabase = require('../lib/supabase');

// Kunlik reja hisoblash
function buildDailyPlan(examDate, availableQuestions) {
  const today = new Date();
  const daysLeft = Math.max(1, Math.ceil((new Date(examDate) - today) / 86400000));
  const questionsPerDay = Math.ceil(availableQuestions / daysLeft);
  
  const plan = [];
  for (let i = 0; i < daysLeft; i++) {
    const day = new Date(today);
    day.setDate(day.getDate() + i);
    plan.push({
      day: day.toISOString().slice(0, 10),
      target_qty: Math.min(questionsPerDay, 30), // Kuniga max 30 savol
    });
  }
  return plan;
}

async function cbSessiyaMenu(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);
  
  const { data: sessions } = await supabase
    .from('exam_sessions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .order('exam_date');

  if (!sessions || sessions.length === 0) {
    return safeEdit(ctx, 
      `📅 <b>Sessiya Rejimi</b>\n\nHozircha birorta imtihon yo'q.\n\n` +
      `Imtihon qo'shish uchun fan nomi va sanasini yuboring:\n` +
      `<i>Masalan: Moliyaviy hisob 15-yanvar</i>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('➕ Imtihon qo\'shish', 'session_add')],
        [Markup.button.callback('🏠 Asosiy', 'back_to_main')],
      ])}
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const sessionList = sessions.map(s => {
    const daysLeft = Math.ceil((new Date(s.exam_date) - new Date()) / 86400000);
    const urgency = daysLeft <= 2 ? '🔴' : daysLeft <= 5 ? '🟡' : '🟢';
    return `${urgency} <b>${s.subject}</b> — ${daysLeft} kun qoldi (${s.exam_date})\n` +
           `   Tayyorlik: ${s.readiness_pct}%`;
  }).join('\n\n');

  await safeEdit(ctx,
    `📅 <b>Sessiya Rejimi</b>\n\n${sessionList}\n\n` +
    `<i>💡 Bugungi topshiriqni bajarish uchun fan nomini tanlang</i>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      ...sessions.map(s => [Markup.button.callback(`📚 ${s.subject}`, `session_run_${s.id}`)]),
      [Markup.button.callback('➕ Yangi imtihon', 'session_add')],
      [Markup.button.callback('🏠 Asosiy', 'back_to_main')],
    ])}
  );
}

// Bugungi reja bo'yicha test boshlash
async function cbSessionRun(ctx) {
  const sessionId = parseInt(parseSuffix(ctx.callbackQuery.data, 'session_run_'), 10);
  const { data: session } = await supabase
    .from('exam_sessions').select('*').eq('id', sessionId).single();
  if (!session) return ctx.answerCbQuery('❌ Sessiya topilmadi');

  const today = new Date().toISOString().slice(0, 10);
  const todayPlan = session.daily_plan?.find(p => p.day === today);
  const qty = todayPlan?.target_qty || 10;

  // Foydalanuvchi xatolariga qarab adaptive yoki oddiy test
  const mistakes = await getUserMistakes(ctx.from.id, session.subject, 30);
  if (mistakes.length >= 5) {
    // Adaptive: zaif joylardan savol
    return cbAdaptiveRunFromSession(ctx, session, qty);
  } else {
    // Oddiy: fan blokidan savol
    return startSessionTest(ctx, session, qty);
  }
}

function register(bot) {
  bot.action('sessiya_menu', cbSessiyaMenu);
  bot.action(/^session_run_\d+$/, cbSessionRun);
  bot.action('session_add', cbSessionAdd);
}

module.exports = { register, cbSessiyaMenu };
```

### 2.3 — Flashcard rejimi (Kun 21–24)

Imtihon oldidan tez takrorlash uchun. Savollar + to'g'ri javob ko'rsatiladi, foydalanuvchi "Bildim / Bilmadim" bosadi.

```js
// src/handlers/flashcardHandler.js
async function cbFlashcardMenu(ctx) {
  // Foydalanuvchi xatolaridan flashcard yasash
  const subject = parseSuffix(ctx.callbackQuery.data, 'flash_');
  const mistakes = await getUserMistakes(ctx.from.id, subject, 20);
  
  if (mistakes.length < 3) {
    return ctx.answerCbQuery('Kamida 3 ta xato bo\'lganda ishlaydi', { show_alert: true });
  }
  
  // Redis ga flashcard session saqlash
  await redis.set(`flash:${ctx.from.id}`, JSON.stringify({
    cards: mistakes,
    idx: 0,
    known: 0,
    unknown: 0,
  }), 'EX', 1800);

  return sendFlashcard(ctx, ctx.from.id, 0);
}

async function sendFlashcard(ctx, userId, idx) {
  const data = JSON.parse(await redis.get(`flash:${userId}`));
  if (idx >= data.cards.length) {
    return ctx.editMessageText(
      `✅ <b>Flashcard yakunlandi!</b>\n\n` +
      `✔️ Bilardim: ${data.known} ta\n❌ Bilmasdim: ${data.unknown} ta`,
      { parse_mode: 'HTML', ...backToMainKb() }
    );
  }
  
  const card = data.cards[idx];
  await ctx.editMessageText(
    `🃏 <b>Flashcard ${idx + 1}/${data.cards.length}</b>\n\n` +
    `<b>${card.question}</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([
      [Markup.button.callback('💡 Javobni ko\'rish', `flash_reveal_${idx}`)],
      [Markup.button.callback('⏭ O\'tkazib yuborish', `flash_skip_${idx}`)],
    ])}
  );
}
```

### 2.4 — Blind Exam rejimi (Kun 25–28)

Real imtihon simulyatsiyasi: vaqt chegarasi, natija faqat oxirida.

```js
// coreQuiz.js ga qo'shish — BlindExam mode
// Farqi: sendNextQuestion da to'g'ri/noto'g'ri ko'rsatilmaydi (open_period = 0)
// Foydalanuvchi oxirida to'liq natijani ko'radi
async function startBlindExam(chatId, telegram, subjectKey, questions) {
  const sessionQ = shuffleArray(questions).slice(0, 30); // Har doim 30 ta
  await sessionService.setActiveTest(chatId, {
    ...defaultSession,
    isBlindExam: true,      // <-- flag
    chatType: 'private',
    subjectKey,
    sessionQuestions: sessionQ,
    startTime: Date.now(),
  });
  await sendNextQuestion(chatId, telegram);
}
// sendNextQuestion da:
// if (session.isBlindExam) open_period = 60 (60 soniya)
// finishTest da isBlindExam bo'lsa xatolar darhol ko'rsatiladi
```

### 2.5 — WebApp (React) — Mavzular Dashboard (4–7-hafta)

Prava imtihoni ilovasi (screenshot)dagi dizayn asosi olinadi: dark theme, yashil/qizil ranglar, aniq progress.

**Stack:**
```
React + Vite
shadcn/ui (Telegram-friendly komponentlar)
Tailwind CSS (dark mode default)
Recharts (progress grafiklar)
React Query (server state)
Zustand (local state)
```

**Sahifalar:**

```
/                 → Dashboard (bugungi reja, progress, tezkor boshlash)
/subjects         → Fanlar ro'yxati (mavjud bloklar soni bilan)
/subjects/:key    → Fan ichida bloklar, progress ring
/study            → Test yechish (WebApp ichida, bot pollsiz)
/mistakes         → Xatolar bo'yicha tahlil (fan, mavzu, grafik)
/stats            → To'liq statistika, reyting
/session          → Sessiya rejimi (imtihon sanalar)
/flashcard        → Flashcard rejimi
```

**Telegram WebApp auth:**
```js
// src/api/webapp.js — yangi fayl
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

router.post('/auth', (req, res) => {
  const { initData } = req.body;
  const isValid = validateTelegramInitData(initData, process.env.BOT_TOKEN);
  if (!isValid) return res.status(401).json({ error: 'Invalid auth' });
  
  const params = new URLSearchParams(initData);
  const user = JSON.parse(params.get('user'));
  // JWT token qaytarish
  const token = generateJWT({ userId: user.id, username: user.username });
  res.json({ token, user });
});

function validateTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  
  return hash === expectedHash;
}
```

**WebApp `src/pages/Study.jsx` — test yechish (bot pollsiz):**
```jsx
// Prava ilovasi kabi: savol + variantlar, bosishdanoq natija
export default function Study() {
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);

  const handleAnswer = (idx) => {
    if (answered) return;
    setSelected(idx);
    setAnswered(true);
    // 1.2 soniyadan keyin keyingiga o'tish (prava ilovasi kabi)
    setTimeout(() => {
      setCurrent(c => c + 1);
      setSelected(null);
      setAnswered(false);
    }, 1200);
  };

  return (
    <div className="min-h-screen bg-gray-950 text-white p-4">
      <Timer seconds={session.timeLeft} />
      <QuestionCard question={questions[current]} />
      <div className="grid gap-2 mt-4">
        {questions[current].options.map((opt, i) => (
          <button
            key={i}
            onClick={() => handleAnswer(i)}
            className={cn(
              "p-4 rounded-xl text-left font-medium transition-all",
              answered && i === questions[current].correct_index && "bg-green-600",
              answered && i === selected && i !== questions[current].correct_index && "bg-red-600",
              !answered && "bg-gray-800 hover:bg-gray-700",
            )}
          >
            <span className="text-gray-400 mr-2">F{i + 1}</span>
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}
```

**WebApp dizayn tokenlari (Telegram dark theme bilan mos):**
```css
/* index.css */
:root {
  --bg-primary:   #0f172a;   /* Telegram dark background */
  --bg-card:      #1e293b;   /* Card background */
  --bg-elevated:  #334155;   /* Elevated element */
  --accent-green: #22c55e;   /* To'g'ri javob, progress */
  --accent-red:   #ef4444;   /* Xato javob */
  --accent-amber: #f59e0b;   /* Ogohlantirish */
  --accent-blue:  #3b82f6;   /* Asosiy tugmalar */
  --text-primary: #f8fafc;
  --text-muted:   #94a3b8;
}
```

**Bot → WebApp integratsiya:**
```js
// keyboards.js ga qo'shish
function webAppButton(text, path) {
  return Markup.button.webApp(text, `${process.env.WEBAPP_URL}${path}`);
}

// Asosiy menyu tugmalariga qo'shish:
[webAppButton('📊 Mavzular bo\'yicha tahlil', '/mistakes')],
[webAppButton('📈 To\'liq statistika', '/stats')],
[webAppButton('📚 Test yechish', '/study')],
```

---

## Faza 3 — Kontent + Admin + Sayqal (10–14-hafta)

### 3.1 — PDF → Test generatori (Kun 63–70)

```js
// src/handlers/pdfHandler.js
const pdfParse = require('pdf-parse'); // yoki mammoth (docx uchun allaqachon bor)

async function onDocumentUpload(ctx) {
  const file = ctx.message.document;
  const isPdf = file.mime_type === 'application/pdf';
  const isDocx = file.mime_type.includes('wordprocessingml');
  
  if (!isPdf && !isDocx) return;
  
  const isPremium = await isUserPremium(ctx.from.id);
  const usageKey = `pdf_gen:${ctx.from.id}:${new Date().toDateString()}`;
  const todayCount = parseInt(await redis.get(usageKey) || '0');
  
  if (!isPremium && todayCount >= 1) {
    return ctx.reply('⚠️ Free foydalanuvchilar kuniga 1 ta PDF dan test yasa oladi.\n💎 Premium uchun: /premium');
  }
  
  const msg = await ctx.reply('⏳ PDF o\'qilmoqda...');
  
  // Fayl yuklab olish
  const fileUrl = await ctx.telegram.getFileLink(file.file_id);
  const buffer = await fetch(fileUrl.href).then(r => r.buffer());
  
  let text = '';
  if (isPdf) {
    const result = await pdfParse(buffer);
    text = result.text.slice(0, 8000); // AI uchun max
  } else {
    const result = await mammoth.extractRawText({ buffer });
    text = result.value.slice(0, 8000);
  }
  
  const questions = await aiService.generateQuizFromText(text, 15);
  if (!questions || questions.length === 0) {
    return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
      '❌ Matndan savol yaratib bo\'lmadi. Aniqroq matn yuboring.');
  }
  
  // Test sifatida saqlash
  const testId = await dbService.saveUserTest(ctx.from.id, 'ai_generated', 'PDF Test', questions);
  await redis.incr(usageKey); await redis.expire(usageKey, 86400);
  
  await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined,
    `✅ ${questions.length} ta savol yaratildi!\n\n📌 Test ID: #${testId}`,
    Markup.inlineKeyboard([[Markup.button.callback('▶️ Hozir boshlash', `ugc_start_${testId}`)]]));
}
```

### 3.2 — Admin Dashboard WebApp sahifasi (Kun 71–77)

```
/admin            → Faqat ADMIN_ID ga ko'rinadi
  ├── /admin/payments   → To'lov so'rovlari (screenshot + 1-tugmali tasdiq)
  ├── /admin/stats      → Foydalanuvchilar soni, kunlik aktiv, AI usage
  ├── /admin/broadcast  → Xabar yuborish (filter: premium/free/barcha)
  └── /admin/tests      → Hotspot savollar (eng ko'p xato qilingan)
```

**To'lov tasdiqlash (admin WebApp orqali):**
```jsx
// src/pages/admin/Payments.jsx
export default function AdminPayments() {
  const { data: requests } = useQuery(['payments'], fetchPending);

  return requests?.map(req => (
    <div key={req.id} className="bg-gray-800 rounded-xl p-4">
      <img src={req.screenshot_url} className="w-full rounded-lg mb-3" />
      <p className="text-sm text-gray-400">User: {req.user_id}</p>
      <div className="flex gap-2 mt-3">
        <button onClick={() => approve(req.id)} className="flex-1 bg-green-600 ...">
          ✅ Tasdiqlash
        </button>
        <button onClick={() => reject(req.id)} className="flex-1 bg-red-600 ...">
          ❌ Rad etish
        </button>
      </div>
    </div>
  ));
}
```

### 3.3 — Sentry va Monitoring sozlash (Kun 78–80)

Sentry allaqachon `index.js` da ulangan, lekin to'liq sozlanmagan:

```js
// Har bir kritik funksiyada qo'shimcha context:
Sentry.withScope(scope => {
  scope.setTag('feature', 'session_mode');
  scope.setUser({ id: userId });
  scope.setContext('session', { subject, examDate, daysLeft });
  Sentry.captureException(err);
});

// AI so'rovlari uchun performance tracing:
const transaction = Sentry.startTransaction({ name: 'ai.generateQuiz', op: 'ai' });
try {
  const result = await aiService.generateQuizFromText(text, count);
  transaction.setStatus('ok');
} finally {
  transaction.finish();
}
```

### 3.4 — Load test (Kun 81–84)

```bash
# Artillery bilan 100 parallel foydalanuvchi simulyatsiyasi
npm install -g artillery
artillery run load-test.yml

# load-test.yml
config:
  target: 'https://your-bot-server.com'
  phases:
    - duration: 60
      arrivalRate: 10   # sekundiga 10 yangi session
      rampTo: 100       # 60 soniyada 100 ga yetkazish
scenarios:
  - flow:
      - post:
          url: "/api/simulate-poll-answer"
          json:
            userId: "{{ $randomInt(1, 10000) }}"
            pollId: "test_poll_{{ $randomInt(1, 500) }}"
```

**Kutilayotgan bottleneck:** `sessionService.setActiveTest` Redis ga har savolda yozadi. 1000+ user bo'lganda Redis pipeline ishlatish kerak bo'ladi:
```js
// Optimizatsiya (kerak bo'lsa)
const pipeline = redis.pipeline();
pipeline.set(`activeTest:${chatId}`, JSON.stringify(session), 'EX', TTL);
pipeline.set(`pollMap:${pollId}`, String(chatId), 'EX', TTL);
await pipeline.exec();
```

---

## Texnik Qarz (to'liq ro'yxat)

| # | Muammo | Prioritet | Qaerda |
|---|--------|-----------|--------|
| T1 | `sessionQuestions` butun array Redis da saqlanadi — 1000 user = ~100MB Redis | Medium | `sessionService.js` |
| T2 | `updateUserStats` — `upsert` o'rniga `select` + `update/insert` 2x round-trip | Low | `dbService.js` |
| T3 | `loadAllTests` — startup da barcha testlar xotiraga yuklanadi, 10k+ savol bo'lganda muammo | Low | `loader.js` |
| T4 | `finishTest` — `dbService.updateUserStats` `.catch()` bilan fire-and-forget, xato yo'q bo'lib ketishi mumkin | Medium | `coreQuiz.js` |
| T5 | `getUserRank` — `SELECT *` butun jadval, rank uchun `COUNT(*)` yetarli | Medium | `dbService.js` |
| T6 | `shelf` user_stats da JSONB — katta bo'lganda serialization bottleneck | Low (keyinroq) | `dbService.js` |

---

## Metrikalar va Muvaffaqiyat Mezonlari

| Metrika | Hozir | 1-oy | 3-oy |
|---------|-------|------|------|
| Foydalanuvchilar | ~350 | 600 | 1,200 |
| 7-kun retention | ~20% | 35% | 50% |
| Sessiya rejimi (%) | 0% | 25% | 45% |
| Premium konversiya | 0% | 3% | 7% |
| WebApp DAU | 0 | 150 | 400 |
| AI xato rate | ~5% | <2% | <1% |
| p95 javob vaqti | ~800ms | <400ms | <200ms |

---

## Haftalik Ish Jadvali

### Hafta 1–2 — Mustahkamlash
```
Kun 1–3:   Bug fix (model nomi, import, rate limit)
Kun 4–5:   DB schema (user_mistakes, indekslar, exam_sessions, payment_requests)
Kun 6–7:   RoomManager Redis, adaptiveQuiz field fix
Kun 8–10:  Premium tizimi (dbService + paymentHandler + admin tasdiqlash)
```

### Hafta 3–5 — Sessiya Rejimi
```
Kun 11–14: sessionHandler.js (fan/sana kiritish, daily_plan hisoblash)
Kun 15–18: Sessiya bo'yicha test boshlash (adaptive + oddiy)
Kun 19–21: Imtihon eslatmasi (BullMQ scheduled job)
Kun 22–24: Flashcard handler
Kun 25–28: Blind Exam rejimi
```

### Hafta 4–7 — WebApp
```
Kun 22–25: Vite + React + shadcn/ui setup, Telegram auth
Kun 26–30: Dashboard + Subjects sahifalari
Kun 31–35: Study (test yechish) sahifasi — prava ilovasi kabi UX
Kun 36–40: Mistakes tahlil + Stats sahifalari
Kun 41–45: Session sahifasi + bot ↔ WebApp integratsiya
```

### Hafta 8–10 — Kontent va To'lov
```
Kun 50–55: PDF/DOCX → Test generatori
Kun 56–60: To'lov handler (screenshot qabul + admin tasdiq)
Kun 61–65: Admin WebApp sahifasi (payments, stats, broadcast)
```

### Hafta 11–14 — Sayqal va Kengaytirish
```
Kun 70–77: Load test, performance optimallashtirish
Kun 78–84: Sentry monitoring to'liq sozlash
Kun 85–90: Guruh musobaqasi UX yaxshilash
Kun 91–98: Beta test, feedback, bugfix
```

---

## WebApp Texnik Stack — Yakuniy

```
Frontend:
  ├── React 18 + Vite
  ├── TypeScript
  ├── Tailwind CSS (dark mode, Telegram ranglariga mos)
  ├── shadcn/ui (Radix UI asosida, accessibility tayyor)
  ├── Recharts (progress, statistika grafiklar)
  ├── React Query v5 (server state, cache)
  ├── Zustand (local state: test sessiyasi)
  └── @twa-dev/sdk (Telegram WebApp API)

Backend (mavjud, qo'shimcha endpoint lar):
  ├── Express (allaqachon bor)
  ├── /api/webapp/auth     → TMA initData validatsiya
  ├── /api/webapp/me       → Profil + statistika
  ├── /api/webapp/subjects → Fan + bloklar ro'yxati
  ├── /api/webapp/study    → Test sessiyasi (start, answer, finish)
  ├── /api/webapp/mistakes → Xatolar tahlili
  └── /api/admin/*         → Admin panel (JWT + ADMIN_ID tekshiruv)

Deploy:
  ├── Bot + API: Railway yoki Render (mavjud)
  └── WebApp: Vercel yoki Netlify (statik, CDN)
```

---

## Muhim Qarorlar

**Nima qilinmaydi (va nima uchun):**

| G'oya | Qaror | Sabab |
|-------|-------|-------|
| Duello 1v1 real-time | ⏸ Keyinga | Socket.io infra bor, lekin kahoot o'ziyoq o'sha vazifani bajaradi |
| Telegram Stars to'lov | ❌ | Murakkash, Uzbekistonda cheklangan — screenshot yetarli |
| Spaced Repetition algoritmi | 🔄 | `exam_sessions.daily_plan` ichida oddiy versiyasi — alohida SRS engine shart emas |
| TTS ovozli flashcard | ⏸ | Matnli flashcard birinchi, agar talab bo'lsa keyinroq |
| Test bozori (pullik sotish) | ❌ | Monetizatsiya murakkablashtiradi, bepul ulashish yetarli |

---

## Faza 5 — Telegram WebApp UI/UX Suite & AI Shaxsiy Tutor (`v5.0.0`) ✅ BAJARILDI

### 5.1 — Backend API & Streak Gamifikatsiya (`v5.0.0`)
- `dbService.getUserStreak(userId)` va `dbService.updateStreak(userId)` ishlab chiqildi (`users` jadvaliga `streak_days` va `last_study_date` qo'shildi).
- `coreQuiz.js` ichida `finishTest` bosqichida har bir yakunlangan test uchun avtomatik streak hisoblanishi qo'shildi.
- `index.js` da production monitoring uchun `/health` endpointi ulangan.

### 5.2 — AI Shaxsiy Tutor & Izohlash (`/api/webapp/explain`)
- `src/api/webapp.js` ichida `/api/webapp/explain`, `/api/webapp/streak` va `/api/webapp/subjects` endpointlari ulangan.
- Gemini 1.5 Flash (`gemini-1.5-flash-latest`) orqali xato berilgan javoblarni 3-4 qatorda o'zbek tilida izohlab beruvchi AI Ustoz tizimi tayyorlandi.

### 5.3 — Telegram Mini App Frontend UI/UX (`webapp/`) — React 18 + Vite + Tailwind CSS
- `webapp/` papkasi ichida zamonaviy **React 18 + Vite + Tailwind CSS + Lucide Icons + `@twa-dev/sdk`** arxitekturasi asosida to'liq interaktiv loyiha qurildi:
  - **`Navbar.jsx` & `BottomNav.jsx`:** Kunlik streak otash nishoni (`🔥 X kun`), PRO status va navigatsiya.
  - **`DashboardPage.jsx`:** Glassmorphism hero kartasi, statistika va tezkor o'tishlar.
  - **`StudyPage.jsx`:** Prava / Duolingo uslubidagi silliq animatsiyali test yechish ekrani, haptic reaksiya va AI tushuntirish imkoniyati.
  - **`MistakesPage.jsx` & `AiExplanationModal.jsx`:** Xatolar ustida ishlash va Gemini 1.5 Flash AI Ustoz izoh moduli.
  - **`AdminPage.jsx`:** To'lov moderatsiyasi va umumiy xabar (Broadcast) paneli.
- WebApp Express serveri orqali `/app` yo'li bo'yicha ham ishlab chiqish (`webapp/`), ham production build (`webapp/dist`) ko'rinishida xizmat ko'rsatadi.

---

*Roadmap muallifi: Audit + loyiha asosi o'rganildi, barcha qarorlar haqiqiy kod holati asosida qabul qilindi.*
