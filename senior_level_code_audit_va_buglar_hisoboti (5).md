# 🛡️ Chuqur Audit Hisoboti (v5): Shaxsiy Quiz, Guruh Musobaqasi, Xatolar Ustida Ishlash va Qayta Ishlash Jarayonlari

Ushbu tahlilda siz so'ragan **4 ta asosiy o'yin jarayoni** (1. Bitta user ishlashi, 2. Guruhda ishlash, 3. Xatolar ustida ishlash, 4. Qayta ishlash va Javon) boshidan oxirigacha (har bir tugma va har bir taymer kesimida) tekshirib chiqildi.

Natijada **7 ta jiddiy mantiqiy va texnik xatolik (bug)** aniqlandi. Quyida har bir jarayon bo'yicha topilgan muammolar va ularning to'liq yechimlari keltirilgan.

## 🔍 1. XATOLAR USTIDA ISHLASH (INTERAKTIV VA KLASSIK REJIM) DAGI XATOLAR

### 🔴 Bug #1 (CRITICAL): Foydalanuvchi yaratgan testlarda (UGC) `"📚 Fan bloklari"` va `"🔙 Fan bloklariga qaytish"` tugmalari umuman ishlamaydi!

* **Qayerda:** `src/handlers/quizGame.js` (`cbUgcSubj` — 336-qator va `register(bot)` — 935-qator)

* **Muammo:**
  Foydalanuvchi o'zi yaratgan (yoki ulashilgan) testni yakunlaganda `"📚 Fan bloklari"` tugmasi (`ugc_subj_${subjectId}`) chiqadi. Shuningdek, `"❌ Xatolarni ko'rish"` va `"🔄 Xatolar ustida ishlash"` menyularida ham `"🔙 Fan bloklariga qaytish"` (`ugc_subj_${meta.subjectId}`) tugmasi bor.
  Ammo `quizGame.js` dagi `register(bot)` funksiyasi ichida **`bot.action(/^ugc_subj_/, cbUgcSubj)` qatori tushib qolgan!**
  Oqibatda talaba bu tugmani bossa, tugma aylanib turaveradi va hech qanday javob qaytmaydi.

* **Yechim:** `quizGame.js` ning `register(bot)` funksiyasiga `bot.action(/^ugc_subj_/, cbUgcSubj);` qo'shildi.

### 🔴 Bug #2 (CRITICAL): Interaktiv Xatolar Ustida Ishlash (`wm_start_inline_`) da 3 ta xatolik:

* **Qayerda:** `src/handlers/quizGame.js` (`sendNextInlineMistake` va `cbWmAns`, 702–838-qatorlar)

* **Muammolar:**

  1. **"🛑 To'xtatish" bosilganda 20 soniyalik taymer o'chmasligi:**
     Interaktiv rejimda har bir savolga 20 soniyalik `wmTimer` qo'yiladi. Agar talaba savolga javob bermasdan `"🛑 To'xtatish"` tugmasini bossa, u `post_subj_...` yoki `ugc_subj_...` orqali Fan menyusiga o'tadi. Lekin `cbPostSubj` va `cbUgcSubj` ichida `clearWmTimer(chatId)` chaqirilmagan va `wm_state` o'chirilmagan! Natijada talaba Fan menyusiga o'tganidan 15 soniya o'tib, fonda ishlab turgan taymer portlaydi va **Fan menyusini `"⏳ Vaqt tugadi! (20 soniyadan o'tib ketdi)"` xabariga almashtirib yuboradi!**

  2. **Ikki marta tez bosish (Double-Tap) keyingi savolni ko'rmasdan o'tkazib yuborishi:**
     Barcha savollar uchun javob tugmalari bir xil `wm_ans_1` (to'g'ri) va `wm_ans_0` (xato) callback'iga ega. Agar talaba internet sekinligida to'g'ri javobni 2 marta tez bossa, 1-bosish 1-savolni yechib 2-savolni chiqaradi, 2-bosish esa **talaba 2-savolni hali o'qimasdan turib uni ham "To'g'ri!" deb o'tkazib yuboradi!** Yoki xato javobni 2 marta bossa, `"❌ Yana xato qildingiz! [➡️ Davom etish]"` ekranida turib navbatdagi savolni ham xato deb ro'yxat oxiriga uloqtiradi.

  3. **9–10 variantli savollarda tugmada `undefined` chiqishi:**
     `labels` massivida faqat 8 ta harf (`A..H`) bor edi, `I` va `J` qo'shilmagan.

* **Yechim:**

  * `"🛑 To'xtatish"` tugmasi maxsus `wm_stop` callback'iga ulandi — u avval `clearWmTimer(chatId)` va `redisConnection.del("wm_state:" + chatId)` ni bajarib, keyin fan menyusiga qaytaradi.

  * Har bir savolga `step` raqami va `awaitingNext` holati berildi (`wm_ans_${step}_${i}_${isCorrect ? 1 : 0}`). Eskirgan yoki takroriy bosishlar 100% bloklanadi.

### 🔴 Bug #3 (HIGH): Klassik Quizda Xatolar Ustida Ishlash (`cbWmStartQuiz`) tugaganda `"➡️ Keyingi blok"` chiqmasligi va 0 ta xato qolganda eski xatolar keshining tozalanmasligi

* **Qayerda:** `src/handlers/quizGame.js` (`cbWmStartQuiz`, 649-qator) va `src/handlers/coreQuiz.js` (`buildFinishButtons`, 103 va 165-qatorlar; `finishTest`, 434-qator)

* **Muammolar:**

  1. `coreQuiz.js` (169-qator) da xatolar ustida ishlash tugagach `"➡️ Keyingi (N+1-Blok)"` tugmasini chiqarish uchun `if (sid.startsWith("retry_"))` deb yozilgan. Ammo `quizGame.js` (`cbWmStartQuiz`, 672-qator) da `testId` sifatida `"retry_${meta.testId}"` o'rniga oddiy `"retry"` yuborilgan! Shu sababli u kod hech qachon ishlamagan.

  2. Agar talaba xatolar ustida ishlash testida barcha savollarni **100% to'g'ri topsa** (`mistakesCount === 0`), `finishTest` ichida `lastMistakesCache` (`mistakes:${chatId}`) tozalanmaydi va yakuniy ekranda baribir `"🔁 Xatolarni qayta ishlash"` tugmasi chiqib, eski xatolarni qayta boshlayveradi!

* **Yechim:**

  * `cbWmStartQuiz` da asl blok identifikatori (`retry_${meta.testId}`) saqlab qolindi.

  * Xatolar ustida ishlash 0 ta xato bilan yakunlanganda `lastMistakesCache` tozalanadi va `"🔁 Xatolarni qayta ishlash"` o'rniga `"🔁 Asosiy blokni qayta ishlash"` hamda `"➡️ Keyingi blok"` tugmalari chiqariladi!

## 🔍 2. BITTA FOYDALANUVCHI (SHAXSIY CHAT) VA QAYTA ISHLASH / JAVON DAGI XATOLAR

### 🔴 Bug #4 (HIGH): Testning 1-savoliga javob berib, `/stop` -> `"🏁 Hozirgi natija bilan yakunlash"` bosilsa, 100% ("🏆 A'lo! Super-Miya!") berilishi

* **Qayerda:** `src/handlers/coreQuiz.js` (`finishTest`, 449–451-qatorlar)

* **Muammo:**
  `finishTest` da natija foizi `const total = session.correct + session.wrong; const pct = safePercent(session.correct, total);` deb hisoblangan.
  Agar 25 ta savollik testda talaba faqat 1-savolni to'g'ri topib (`correct = 1, wrong = 0`), `/stop` bosib `"🏁 Hozirgi natija bilan yakunlash"` (`pause_finish`) ni tanlasa:
  `total = 1`, `skipped = 24`, lekin **`pct = 1/1 = 100%`!**
  Bot unga `"🎯 Natija: 100% — 🏆 A'lo! 🔥 Super-Miya!"` deydi va bazadagi tarixga ham `100%` yozadi! Yoki 0 ta savolga javob berib yakunlasa, bazaga 0% lik bo'sh test yozib qo'yadi.

* **Yechim:**

  * Foiz har doim testdagi jami savollar soniga (`session.sessionQuestions.length`) nisbatan hisoblanadi (`1 / 25 = 4%`).

  * Agar talaba hali birorta ham savolga javob bermasdan (`session.correct + session.wrong === 0`) testni yakunlasa, `dbService.updateUserStats` chaqirilmaydi (statistika buzilmaydi).

### 🔴 Bug #5 (HIGH): Savol almashayotgan 600ms pauzada `/stop` yoki `"🗑 Butunlay bekor qilish"` bosilsa, o'chirilgan testning "tirilib" ketishi va `429` xatosida savolning kuyib ketishi

* **Qayerda:** `src/handlers/quizGame.js` (`cbStopTest`, `cbForceFinish`, `cbPauseShelf`) va `src/handlers/coreQuiz.js` (`sendNextQuestion`)

* **Muammolar:**

  1. Talaba savolga javob berganda `handlePollAnswer` 600ms kutib keyin `sendNextQuestion` ni chaqiradi. Agar shu 600ms ichida `/stop` yoki `"🗑 Butunlay bekor qilish"` bosilsa, ularda `mutex.lock("poll:" + chatId)` yo'qligi sababli `sendNextQuestion` o'chirilgan sessiyani qaytadan Redis'ga yozib, yangi savol yuboradi.

  2. 20–50 kishi bir vaqtda ishlaganda `telegram.sendPoll` ga `429 Too Many Requests` (yoki vaqtinchalik tarmoq uzilishi) tushsa, bot kutmasdan u savolni **xato (`session.wrong++`)** deb o'tkazib yuboradi.

* **Yechim:**

  * Barcha pauza va to'xtatish funksiyalari `mutex.lock("poll:" + chatId)` bilan himoyalandi.

  * `sendPoll` da `429` (`retry_after`), `can't parse entities` (explanation tufayli) yoki tarmoq xatosi bo'lsa, savolni kuydirmasdan avtomatik qayta yuborish (retry) qo'shildi.

### 🟠 Bug #6 (MEDIUM-HIGH): Javondan (Shelf) davom ettirilgan test tugaganda Javondagi progress yangilanmasligi va UGC fan menyusiga qaytish xatosi

* **Qayerda:** `src/handlers/quizGame.js` (`resumeTestFromShelf`, `cbPostSubj`), `src/handlers/shelfHandlers.js` (`cbRunTest`) va `src/handlers/coreQuiz.js` (`finishTest`)

* **Muammolar:**

  1. Talaba chala qolgan testni (masalan, 10-savolda to'xtagan testni) Javondan ochib oxirigacha ishlasa, test tugagach Javon ichidagi yozuv yangilanmaydi — keyingi safar Javonga kirsa hali ham `"⏳ 10-savolga kelgan"` deb turaveradi!

  2. Javondan yuklangan testda `subjectId` va `creatorId` saqlanmagani uchun, test tugaganda `"🔙 Fan menyusi"` (`post_subj_...`) bosilsa va u fan rasmiy `SUBJECTS` da bo'lmasa, `"📭 Bu fanda hozircha test yo'q"` degan bo'sh ekran chiqib qoladi.

* **Yechim:**

  * `shelfData` ichiga `subjectId` va `creatorId` ham saqlanadigan bo'ldi.

  * Javondan boshlangan test tugaganda (yoki qayta pauza qilinganda), uning Javondagi (`shelf[shelfFolder]`) holati avtomatik `"✅ Test to'liq yakunlangan!"` qilib yangilanadi.

  * `cbPostSubj` da agar fan rasmiy `SUBJECTS` da bo'lmasa, foydalanuvchining o'z faniga yoki `"📂 Mening Testlarim"` menyusiga yo'naltiriladi.

## 🔍 3. GURUHDA ISHLASH (GROUP QUIZ VA MARAFON) DAGI XATOLAR

### 🔴 Bug #7 (HIGH): Guruh musobaqasida kechikkan ovozlar, `cbStartTest` kutish zali va AFK qolgan muallif muammosi

* **Qayerda:** `src/handlers/coreQuiz.js` (`handlePollAnswer`, `finishTest`), `src/handlers/groupQuizLogic.js` (`createLobby`, `cbRoomStart`, `cbRoomCancel`, `cbRoomNextBlock`), `src/handlers/startHandler.js` (`cmdStop`)

* **Muammolar:**

  1. **Yopilgan poll'ga kelgan kechikkan ovozlar:** `handlePollAnswer` da guruh a'zosi ovoz berganda `mutex.lock("poll:" + chatId)` ichiga kirgach, `session` tekshirilmasdan oldin `groupTestCache` ga ball yoziladi. Agar barcha qatnashchilar javob berib bo'lib savol yopilgan yoki test tugagan bo'lsa ham, bir necha millisekund kechikib kelgan ovoz `groupTestCache` ni qayta yaratib qo'yadi.

  2. **Marafonda `consecutiveTimeouts` tozalanmasligi:** Guruh marafonida 1-blokda 2 ta savol javobsiz qolgan bo'lsa (`consecutiveTimeouts = 2`), 2-blok boshlanganda u `0` ga tushirilmagan — natijada 2-blokda 1 ta savolga javob berilmasa marafon bekor bo'lib ketadi.

  3. **Guruhda AFK qolgan muallif:** Guruhda test yoki marafon boshlagan talaba Telegram'dan chiqib ketsa, hatto **Guruh Admini** yoki **Bot Admini** ham `/stop`, `"❌ Bekor qilish"` yoki `"▶️ Keyingi blokni boshlash"` ni bosa olmaydi (guruh bloklanib qoladi).

  4. **Guruhda `cbStartTest` / `cbPostStart` orqali ochilgan kutish zali:** `room.testData.subject` va `room.mode` berilmagani sababli kutish zalida fan nomi ko'rinmay qoladi.

* **Yechim:** Barcha 4 ta holat `coreQuiz.js`, `groupQuizLogic.js`, `quizGame.js` va `startHandler.js` da to'liq bartaraf etildi.

## 🛠️ TO'LIQ TUZATILGAN FAYLLAR (NUSXA OLIB QO'YISH UCHUN TAYYOR)

Quyida barcha tuzatishlarni o'z ichiga olgan fayllar keltirilgan:

### 1. `src/handlers/coreQuiz.js` (To'liq kod)

```
"use strict";

const { Markup } = require("telegraf");
const mutex = require("../core/mutex");
const { SUBJECTS } = require("../config/config");
const dbService = require("../services/dbService");
const sessionService = require("../services/sessionService");
const logger = require("../core/logger");
const {
  userNameCache,
  safePercent,
  grade,
  progressBar,
  escapeHtml,
  truncateText,
  safeCallbackData,
} = require("../core/utils");
const redisConnection = require("../services/redisService");
const { buildShareLink } = require("../services/shareService");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── REDIS-BACKED ACTIVE POLLS VA GROUP CACHE ─────────────────────────────
const activePollsCache = {
  set: async (pollId, data) => await redisConnection.set(`poll_cache:${pollId}`, JSON.stringify(data), "EX", 600),
  get: async (pollId) => {
    const d = await redisConnection.get(`poll_cache:${pollId}`);
    return d ? JSON.parse(d) : null;
  },
  delete: async (pollId) => await redisConnection.del(`poll_cache:${pollId}`),
};

const groupTestCache = {
  set: async (chatId, data) => await redisConnection.set(`group_cache:${chatId}`, JSON.stringify(data), "EX", 3600),
  get: async (chatId) => {
    const d = await redisConnection.get(`group_cache:${chatId}`);
    return d ? JSON.parse(d) : null;
  },
  delete: async (chatId) => await redisConnection.del(`group_cache:${chatId}`),
};

async function cancelSessionTimer(session, chatId) {
  try {
    const { quizTimerQueue } = require("../jobs/queues");
    if (!quizTimerQueue || quizTimerQueue.isDummy) return;
    if (session?.timerJobId) {
      await quizTimerQueue.getJob(session.timerJobId).then((j) => j && j.remove()).catch(() => {});
      return;
    }
    const fallbackId = session?.pollId
      ? `timeout_${chatId}_${session?.qIdx}_${session.pollId}`
      : `timeout_${chatId}_${session?.qIdx}`;
    await quizTimerQueue.getJob(fallbackId).then((j) => j && j.remove()).catch(() => {});
  } catch {}
}

// ─── Redis-backed Mistakes Cache ─────────────────────────────
const lastMistakesCache = {
  set: async (chatId, mistakes) => {
    if (!mistakes || mistakes.length === 0) return;
    await redisConnection.set(
      `mistakes:${chatId}`,
      JSON.stringify(mistakes),
      "EX",
      3600,
    );
  },
  get: async (chatId) => {
    const data = await redisConnection.get(`mistakes:${chatId}`);
    return data ? JSON.parse(data) : [];
  },
  clear: async (chatId) => {
    await redisConnection.del(`mistakes:${chatId}`).catch(() => {});
  },
};

function resolveTestName(tId, blockName) {
  const sid = String(tId);
  if (sid === "mock" || sid.startsWith("mock_")) return "🎲 Aralash Test";
  if (sid === "adaptive" || sid.startsWith("adaptive_")) return "🎯 AI Adaptiv Test";
  if (sid === "retry" || sid.startsWith("retry_")) return "🔄 Xatolar ustida ishlash";
  if (sid.startsWith("ugc_")) return `📝 ${blockName || "Maxsus Test"}`;
  return `${tId}-Blok`;
}

// ─── TUGMALARNI YASASH FUNKSIYASI ────────────────────────────
async function buildFinishButtons(tId, subjectKey, mistakesCount = 0, session = null) {
  const btns = [];

  if (mistakesCount > 0) {
    btns.push([
      Markup.button.callback("❌ Xatolarni ko'rish", "review_mistakes"),
    ]);
    btns.push([
      Markup.button.callback(
        `🔄 Xatolar ustida ishlash (${mistakesCount} ta)`,
        safeCallbackData(`wm_menu_${subjectKey}`, 64),
      ),
    ]);
  }

  const sid = String(tId);
  const isUgcSession =
    sid.startsWith("ugc_") ||
    sid.startsWith("retry_ugc_") ||
    Boolean(session?.creatorId) ||
    Boolean(session?.subjectId) ||
    Boolean(session?.isUgc);

  if (isUgcSession) {
    let subjectId = session?.subjectId;
    let rawTestId = NaN;

    if (sid.startsWith("ugc_")) {
      rawTestId = parseInt(sid.replace("ugc_", ""), 10);
    } else if (sid.startsWith("retry_ugc_")) {
      rawTestId = parseInt(sid.replace("retry_ugc_", ""), 10);
    } else if (!sid.startsWith("retry")) {
      rawTestId = parseInt(sid, 10);
    }

    if ((sid === "retry" || sid.startsWith("retry_")) && isNaN(rawTestId)) {
      if (mistakesCount > 0) {
        btns.push([
          Markup.button.callback(
            "🔁 Xatolarni qayta ishlash",
            safeCallbackData(`wm_start_quiz_${subjectKey}`, 64),
          ),
        ]);
      }
      if (subjectId) {
        btns.push([
          Markup.button.callback("📚 Fan bloklari", safeCallbackData(`ugc_subj_${subjectId}`, 64)),
        ]);
      } else {
        btns.push([
          Markup.button.callback("📂 Mening Testlarim", "my_tests"),
        ]);
      }
      btns.push([Markup.button.callback("📥 Javonga saqlash", "shelf_save_init")]);
      btns.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
      return btns;
    }

    let nextBlock = null;
    if (!subjectId && !isNaN(rawTestId)) {
      try {
        const testDb = await dbService.getUserTest(rawTestId);
        if (testDb?.subject_id) subjectId = testDb.subject_id;
      } catch {}
    }

    if (subjectId) {
      try {
        const blocks = await dbService.getSubjectBlocks(subjectId);
        const curIdx = blocks.findIndex((b) => parseInt(b.id, 10) === rawTestId);
        if (curIdx !== -1 && curIdx + 1 < blocks.length) {
          nextBlock = blocks[curIdx + 1];
        }
      } catch (err) {
        console.error("Error finding next UGC block:", err.message);
      }
    }

    if (nextBlock) {
      btns.push([
        Markup.button.callback(
          `➡️ Keyingi (${nextBlock.block_name})`,
          safeCallbackData(`ugc_start_${nextBlock.id}`, 64),
        ),
      ]);
    }

    if (!isNaN(rawTestId)) {
      const retryLabel = sid.startsWith("retry_") ? "🔁 Asosiy blokni qayta ishlash" : "🔁 Qayta ishlash";
      btns.push([
        Markup.button.callback(
          retryLabel,
          safeCallbackData(`ugc_start_${rawTestId}`, 64),
        ),
      ]);
    }

    if (subjectId) {
      btns.push([
        Markup.button.callback(
          "📚 Fan bloklari",
          safeCallbackData(`ugc_subj_${subjectId}`, 64),
        ),
      ]);
    } else {
      btns.push([
        Markup.button.callback("📂 Mening Testlarim", "my_tests"),
      ]);
    }

    btns.push([Markup.button.callback("📥 Javonga saqlash", "shelf_save_init")]);
    btns.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
    return btns;
  } else if (sid === "mock" || sid.startsWith("mock_")) {
    btns.push([
      Markup.button.callback("🎲 Yana aralash", safeCallbackData(`mock_${subjectKey}`, 64)),
    ]);
  } else if (sid === "adaptive" || sid.startsWith("adaptive_")) {
    btns.push([
      Markup.button.callback("🎯 Yana adaptiv", safeCallbackData(`adaptive_${subjectKey}`, 64)),
    ]);
  } else if (sid === "retry" || sid.startsWith("retry_")) {
    if (mistakesCount > 0) {
      btns.push([
        Markup.button.callback("🔁 Xatolarni qayta ishlash", safeCallbackData(`wm_start_quiz_${subjectKey}`, 64)),
      ]);
    }
    if (sid.startsWith("retry_")) {
      const originalId = parseInt(sid.replace("retry_", ""), 10);
      if (!isNaN(originalId) && originalId > 0 && originalId < 1000000) {
        const memDb = require("../core/bot").memoryDb || {};
        if ((memDb[subjectKey] || {})[originalId]) {
          btns.push([
            Markup.button.callback(
              `🔁 ${originalId}-Blokni qayta ishlash`,
              safeCallbackData(`post_start_${subjectKey}_${originalId}`, 64),
            ),
          ]);
        }
        if ((memDb[subjectKey] || {})[originalId + 1]) {
          btns.push([
            Markup.button.callback(
              `➡️ Keyingi (${originalId + 1}-Blok)`,
              safeCallbackData(`post_start_${subjectKey}_${originalId + 1}`, 64),
            ),
          ]);
        }
      }
    }
  } else {
    const numId = parseInt(sid, 10);
    if (!isNaN(numId)) {
      btns.push([
        Markup.button.callback(
          "🔁 Qayta ishlash",
          safeCallbackData(`post_start_${subjectKey}_${numId}`, 64),
        ),
      ]);
      const memDb = require("../core/bot").memoryDb || {};
      if ((memDb[subjectKey] || {})[numId + 1]) {
        btns.push([
          Markup.button.callback(
            `➡️ Keyingi (${numId + 1}-Blok)`,
            safeCallbackData(`post_start_${subjectKey}_${numId + 1}`, 64),
          ),
        ]);
      }
    }
  }

  btns.push([Markup.button.callback("📥 Javonga saqlash", "shelf_save_init")]);
  const isOfficialSubj = Boolean(SUBJECTS[subjectKey]);
  btns.push([
    isOfficialSubj
      ? Markup.button.callback("🔙 Fan menyusi", safeCallbackData(`post_subj_${subjectKey}`, 64))
      : Markup.button.callback("📂 Mening Testlarim", "my_tests"),
    Markup.button.callback("🏠 Asosiy", "post_main"),
  ]);

  return btns;
}

async function sendPollWithRetry(telegram, chatId, pollQ, pollOpts, pollExtra) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await telegram.sendPoll(chatId, pollQ, pollOpts, pollExtra);
    } catch (err) {
      lastErr = err;
      const errMsg = String(err?.message || "");
      const retryAfter = err?.response?.parameters?.retry_after || err?.parameters?.retry_after;

      if (retryAfter && retryAfter <= 15 && attempt < 3) {
        logger.warn(`[coreQuiz] sendPoll 429 rate limit hit for ${chatId}, waiting ${retryAfter}s...`);
        await wait((retryAfter + 1) * 1000);
        continue;
      }

      if (errMsg.includes("can't parse entities") && pollExtra.explanation) {
        delete pollExtra.explanation_parse_mode;
        continue;
      }

      const isTransient =
        errMsg.includes("ETIMEDOUT") ||
        errMsg.includes("ECONNRESET") ||
        errMsg.includes("EAI_AGAIN") ||
        errMsg.includes("502") ||
        errMsg.includes("503") ||
        errMsg.includes("504");

      if (isTransient && attempt < 3) {
        await wait(1000 * attempt);
        continue;
      }

      throw err;
    }
  }
  throw lastErr;
}

async function sendNextQuestion(chatId, telegram) {
  let session;
  try {
    session = await sessionService.getActiveTest(chatId);
    if (!session) return;
    if (session.status === "paused" || session.finished || session.isFinished) return;
    if (session.qIdx >= session.sessionQuestions.length)
      return finishTest(chatId, telegram);

    session.transitionLock = null;
    session.questionState = "ACTIVE";

    const q = session.sessionQuestions[session.qIdx];
    const progress = `[${session.qIdx + 1}/${session.sessionQuestions.length}]`;
    const labels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

    let options = Array.isArray(q.options) ? [...q.options] : [];
    if (options.length < 2) {
      options = ["A varianti", "B varianti"];
    } else if (options.length > 10) {
      options = options.slice(0, 10);
    }

    let correctIndex = typeof q.correct_index === "number" ? q.correct_index : 0;
    if (correctIndex < 0 || correctIndex >= options.length) {
      correctIndex = 0;
    }
    q.options = options;
    q.correct_index = correctIndex;

    const qFull = `${progress} ${q.question || ""}`;
    const needsSplit =
      qFull.length > 255 || options.some((o) => String(o).length > 100);

    let pollQ, pollOpts;
    if (needsSplit) {
      let text =
        `📑 <b>Savol ${progress}</b>\n\n${escapeHtml(q.question || "")}\n\n` +
        options
          .map(
            (opt, i) =>
              `<b>${labels[i] || i + 1})</b> ${escapeHtml(String(opt))}`,
          )
          .join("\n");
      text = truncateText(text, 4000);
      const splitOpts = { parse_mode: "HTML" };
      if (session.messageThreadId) splitOpts.message_thread_id = session.messageThreadId;
      await telegram.sendMessage(chatId, text, splitOpts).catch(() => {});
      pollQ = `${progress} To'g'ri variantni belgilang:`.slice(0, 300);
      pollOpts = options.map((_, i) => `${labels[i] || i + 1} varianti`);
    } else {
      pollQ = qFull.slice(0, 300);
      pollOpts = options.map((o) => (String(o).trim() || "Variant").slice(0, 100));
    }

    let msg;
    try {
      const pollExtra = {
        type: "quiz",
        correct_option_id: correctIndex,
        is_anonymous: false,
        open_period: 30,
      };
      if (session.messageThreadId) {
        pollExtra.message_thread_id = session.messageThreadId;
      }
      if (q.explanation) {
        const { safeTruncateExplanation } = require("../core/questionUtils");
        const exp = safeTruncateExplanation(escapeHtml(String(q.explanation).trim()), 200);
        pollExtra.explanation = exp;
        pollExtra.explanation_parse_mode = "HTML";
      }
      msg = await sendPollWithRetry(telegram, chatId, pollQ, pollOpts, pollExtra);
    } catch (e) {
      console.error(`sendPoll error [${chatId}]:`, e.message);

      const errMsg = String(e?.message || "");
      const migrateTo = e?.parameters?.migrate_to_chat_id || e?.response?.parameters?.migrate_to_chat_id;
      const isFatalChatError =
        errMsg.includes("bot was kicked") ||
        errMsg.includes("not a member") ||
        errMsg.includes("bot was blocked") ||
        errMsg.includes("chat not found") ||
        errMsg.includes("TOPIC_CLOSED") ||
        errMsg.includes("chat write forbidden") ||
        errMsg.includes("group chat was upgraded") ||
        !!migrateTo;

      if (isFatalChatError) {
        console.warn(`[coreQuiz] Fatal chat error detected for chatId ${chatId}: ${errMsg} (migrateTo: ${migrateTo}). Force stopping session.`);
        await sessionService.deleteActiveTest(chatId).catch(() => {});
        await sessionService.deleteWaitingRoom(chatId).catch(() => {});
        if (session?.pollId) {
          await sessionService.deletePollChat(session.pollId).catch(() => {});
        }
        await cancelSessionTimer(session, chatId);
        return;
      }

      session.sendErrors = (session.sendErrors || 0) + 1;
      const errSendOpts = { parse_mode: "HTML" };
      if (session.messageThreadId) errSendOpts.message_thread_id = session.messageThreadId;

      if (session.sendErrors >= 3) {
        session.status = "paused";
        await sessionService.setActiveTest(chatId, session);
        await telegram.sendMessage(
          chatId,
          `⚠️ <b>Texnik xatolik:</b> Telegram savollarni yuborishda muammo yuzaga keldi. Test avtomatik pauza qilindi.\n\nIltimos, birozdan so'ng "▶️ Davom etish" tugmasini bosing.`,
          {
            ...errSendOpts,
            ...Markup.inlineKeyboard([
              [Markup.button.callback("▶️ Davom etish", "pause_resume")],
              [Markup.button.callback("🏁 Yakunlash", "pause_finish")],
            ]),
          }
        ).catch(() => {});
        return;
      }

      await telegram.sendMessage(
        chatId,
        `⚠️ <b>Texnik xatolik:</b> Bu savolni Telegram qabul qilmadi. Savol o'tkazib yuborildi.`,
        errSendOpts
      ).catch(() => {});

      session.wrong++;
      session.mistakes.push({
        question: String(q.question || "Noma'lum savol").substring(0, 100),
        correct_ans: options[correctIndex] || "Noma'lum",
        wrong_ans: "⚠️ Savol yuklanmadi",
        options: options,
        correct_index: correctIndex,
      });
      session.qIdx++;
      await sessionService.setActiveTest(chatId, session);

      await wait(1000);
      return sendNextQuestion(chatId, telegram);
    }

    // Savol yuborilayotgan paytda foydalanuvchi /stop yoki force_finish bosgan bo'lsa tekshiramiz
    const latestSession = await sessionService.getActiveTest(chatId);
    if (!latestSession || latestSession.status === "paused" || latestSession.finished || latestSession.isFinished) {
      if (msg?.message_id) {
        await telegram.stopPoll(chatId, msg.message_id).catch(() => {});
      }
      return;
    }

    const timerJobId = `timeout_${chatId}_${session.qIdx}_${msg.poll.id}`;
    session.sendErrors = 0;
    session.pollId = msg.poll.id;
    session.msgId = msg.message_id;
    session.timerJobId = timerJobId;
    session.transitionLock = null;
    session.questionState = "ACTIVE";

    if (session.chatType !== "private") {
      await activePollsCache.set(msg.poll.id, {
        chatId: chatId,
        correct_index: q.correct_index,
        qData: q,
        expectedParticipantsCount: session.expectedParticipantsCount || 0,
      });
      if (!(await groupTestCache.get(chatId))) {
        await groupTestCache.set(chatId, { scores: session.groupScores || {} });
      }
    }

    await sessionService.setActiveTest(chatId, session);
    await sessionService.setPollChat(msg.poll.id, String(chatId));

    const { quizTimerQueue } = require("../jobs/queues");
    try {
      await quizTimerQueue.add(
        "timeout",
        { chatId, expectedIdx: session.qIdx, pollId: msg.poll.id },
        {
          delay: 31_000,
          jobId: timerJobId,
          removeOnComplete: true,
        },
      );
    } catch (timerErr) {
      console.warn(`[coreQuiz] Failed to schedule timer job for chatId ${chatId}:`, timerErr?.message);
    }
  } catch (e) {
    console.error(`sendNextQuestion fatal [${chatId}]:`, e.message);
    const errMsg = String(e?.message || "");
    const migrateTo = e?.parameters?.migrate_to_chat_id || e?.response?.parameters?.migrate_to_chat_id;
    const isFatalChatError =
      errMsg.includes("bot was kicked") ||
      errMsg.includes("not a member") ||
      errMsg.includes("bot was blocked") ||
      errMsg.includes("chat not found") ||
      errMsg.includes("TOPIC_CLOSED") ||
      errMsg.includes("chat write forbidden") ||
      errMsg.includes("group chat was upgraded") ||
      !!migrateTo;

    if (isFatalChatError) {
      await sessionService.deleteActiveTest(chatId).catch(() => {});
      await sessionService.deleteWaitingRoom(chatId).catch(() => {});
      if (session?.pollId) {
        await sessionService.deletePollChat(session.pollId).catch(() => {});
      }
      await cancelSessionTimer(session, chatId);
      return;
    }

    try {
      if (session) {
        session.status = "paused";
        await sessionService.setActiveTest(chatId, session);
        const errOpts = {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("▶️ Davom etish", "pause_resume")],
            [Markup.button.callback("🏁 Yakunlash", "pause_finish")],
          ]),
        };
        if (session.messageThreadId) errOpts.message_thread_id = session.messageThreadId;
        await telegram.sendMessage(
          chatId,
          `⚠️ <b>Texnik xatolik:</b> Savol yuklashda kutilmagan nosozlik yuz berdi. Test vaqtincha to'xtatildi.\n\n"▶️ Davom etish" orqali davom ettirishingiz yoki "🏁 Yakunlash" ni bosishingiz mumkin.`,
          errOpts
        ).catch(() => {});
      }
    } catch {}
  }
}

// ─── TESTNI YAKUNLASH VA NATIJALARNI HISOBLASH ─────────────────
async function finishTest(chatId, telegram) {
  let isMarathonContinuing = false;
  const unlock = await mutex.lock(`finish:${chatId}`);
  let session;
  try {
    session = await sessionService.getActiveTest(chatId);
    if (!session || session.finished || session.isFinished) return;
    session.finished = true;
    session.isFinished = true;
    session.questionState = "FINISHED";
    await sessionService.setActiveTest(chatId, session);
  } finally {
    unlock();
  }

  await cancelSessionTimer(session, chatId);
  if (session.pollId) {
    await activePollsCache.delete(session.pollId);
  }

  if (session.chatType !== "private") {
    const groupEntry = await groupTestCache.get(chatId);
    if (groupEntry) {
      session.groupScores = groupEntry.scores;
    }
    await groupTestCache.delete(chatId);
  }

  const tId = session.testId;
  const sid = String(tId);
  const tName = resolveTestName(tId, session.blockName);
  const subjName = SUBJECTS[session.subjectKey] || session.subjectKey;
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const time = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;

  let text;
  let buttons = [];

  try {
    if (session.chatType === "private") {
      // ─── SHAXSIY TEST YAKUNI ───
      let subjectId = session.subjectId || null;
      if (!subjectId && (sid.startsWith("ugc_") || sid.startsWith("retry_ugc_"))) {
        const rawUgcId = parseInt(sid.replace(/^retry_ugc_|^ugc_/, ""), 10);
        if (!isNaN(rawUgcId)) {
          try {
            const tDb = await dbService.getUserTest(rawUgcId);
            if (tDb?.subject_id) {
              subjectId = tDb.subject_id;
              session.subjectId = subjectId;
            }
          } catch {}
        }
      }

      const isUgc =
        sid.startsWith("ugc_") ||
        sid.startsWith("retry_ugc_") ||
        Boolean(session.creatorId) ||
        Boolean(subjectId) ||
        Boolean(session.isUgc);

      const metaTestId = sid.startsWith("retry_") ? sid.replace(/^retry_/, "") : tId;
      await redisConnection.set(`mistakes_meta:${chatId}`, JSON.stringify({
        subjectKey: session.subjectKey,
        testId: metaTestId,
        blockName: tName,
        correct: session.correct,
        wrong: session.wrong,
        isUgc: isUgc,
        subjectId: subjectId,
      }), "EX", 3600).catch(() => {});

      if (Array.isArray(session.mistakes) && session.mistakes.length > 0) {
        await lastMistakesCache.set(chatId, session.mistakes).catch(() => {});
      } else if (sid === "retry" || sid.startsWith("retry_")) {
        await lastMistakesCache.clear(chatId).catch(() => {});
      }

      const answeredTotal = session.correct + session.wrong;
      const totalQuestions = session.sessionQuestions.length || answeredTotal;
      const skipped = Math.max(0, totalQuestions - answeredTotal);
      // Foiz jami savollar soniga nisbatan hisoblanadi (1 ta ishlab to'xtatganda 100% chiqmasligi uchun)
      const pct = safePercent(session.correct, totalQuestions);

      if (answeredTotal > 0) {
        dbService
          .updateUserStats(
            chatId,
            session.correct,
            session.wrong + skipped,
            session.subjectKey,
            tId,
            session.mistakes,
          )
          .catch((e) => console.error("Stats update error:", e.message));
      }

      // Agar test Javondan (Shelf) yuklangan bo'lsa, Javondagi progressini "Yakunlangan" qilib yangilaymiz
      if (session.shelfFolder) {
        dbService.saveTestToShelf(chatId, session.shelfFolder, {
          testId: tId,
          testName: session.blockName || tName,
          subject: session.subjectKey,
          questions: session.sessionQuestions,
          progress: {
            current_index: totalQuestions,
            correct: session.correct || 0,
            mistakes: session.mistakes || [],
          },
        }).catch(() => {});
      }

      logger.info("test:finish", {
        chatId,
        subject: session.subjectKey,
        testId: tId,
        correct: session.correct,
        wrong: session.wrong,
        skipped,
        percent: pct,
        elapsed,
      });

      let funFeedback;
      if (pct === 100) {
        funFeedback = `\n\n🔥 <b>Super-Miya!</b> Siz shunchaki yonayapsiz! 100% to'g'ri javob. Barcha savollarni «chaqib» tashladingiz! 🏆`;
      } else if (pct >= 80) {
        funFeedback = `\n\n😎 <b>Ajoyib natija!</b> Siz deyarli ustoz darajasidasiz. Yana ozgina harakat qilsangiz, 100% lik marra sizniki bo'ladi! 🚀`;
      } else if (pct >= 50) {
        funFeedback = `\n\n👍 <b>Yomon emas, lekin...</b> siz bundan ham zo'riga qodirsiz! O'tkazib yuborilgan «zarbalarni» qayta ishlab chiqamizmi? 🥊\n\n👇 Quyidagi <b>«🔄 Xatolar ustida ishlash»</b> tugmasini bosing.`;
      } else {
        funFeedback = `\n\n😅 <b>Oups...</b> Bugun yulduzlar siz tomonda emas shekilli. Taslim bo'lish yo'q! Xatolarni qayta ishlab, tezda «qasos» oling! ⚔️\n\n👇 Quyidagi <b>«🔄 Xatolar ustida ishlash»</b> tugmasini bosing.`;
      }

      text =
        `🏁 <b>Test Yakunlandi!</b>\n\n` +
        `📚 ${escapeHtml(subjName)} — ${escapeHtml(tName)}\n` +
        `${progressBar(Math.round(pct), 100)}\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `✅ To'g'ri:    <b>${session.correct} ta</b>\n` +
        `❌ Xato:       <b>${session.wrong} ta</b>\n` +
        `⏭ O'tkazildi: <b>${skipped} ta</b>\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `🎯 Natija: <b>${pct}%</b> — ${grade(pct)}\n` +
        `⏱ Vaqt: <b>${time}</b>` +
        funFeedback;

      let saveTestId = tId;
      if (saveTestId === "mock" || saveTestId === "adaptive" || saveTestId === "retry") {
        saveTestId = `${saveTestId}_${Date.now()}`;
      }
      const shelfData = {
        testId: saveTestId,
        testName: tName,
        subject: session.subjectKey,
        subjectId: subjectId,
        creatorId: session.creatorId || null,
        questions: session.sessionQuestions || [],
        progress: {
          current_index: totalQuestions,
          correct: session.correct || 0,
          mistakes: session.mistakes || [],
        },
      };

      await redisConnection
        .set(`shelf_pending:${chatId}`, JSON.stringify(shelfData), "EX", 86400)
        .catch((e) => console.error("Redis shelf save error:", e));

      const mistakesCount = (session.mistakes || []).length;
      buttons = await buildFinishButtons(tId, session.subjectKey, mistakesCount, session);
    } else {
      // Marafon bo'lsa, oraliq natijalarni global reytingga qo'shamiz
      if (session.isMarathon) {
        if (!session.marathonGlobalScores) session.marathonGlobalScores = {};
        for (const [uid, sc] of Object.entries(session.groupScores)) {
          if (!session.marathonGlobalScores[uid]) {
            session.marathonGlobalScores[uid] = {
              name: sc.name,
              correct: 0,
              wrong: 0,
            };
          }
          session.marathonGlobalScores[uid].correct += sc.correct;
          session.marathonGlobalScores[uid].wrong += sc.wrong;
        }
      }

      const scoresToUse =
        session.isMarathon &&
        session.currentBlockIdx >= session.marathonBlocks.length - 1
          ? session.marathonGlobalScores
          : session.groupScores;

      const entries = Object.values(scoresToUse);
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

      const sortedEntries = entries.sort((a, b) => b.correct - a.correct);
      const topEntries = sortedEntries.slice(0, 25);
      let body = topEntries.length
        ? topEntries
            .map(
              (s, i) =>
                `${medals[i] ?? "🔸"} <b>${escapeHtml(s.name)}</b>: ${s.correct} to'g'ri, ${s.wrong} xato`,
            )
            .join("\n")
        : "😔 Hech kim javob bermadi.";
      if (sortedEntries.length > 25) {
        body += `\n<i>...va yana ${sortedEntries.length - 25} nafar ishtirokchi</i>`;
      }

      // MARAFON: Agar hali bloklar qolgan bo'lsa
      if (
        session.isMarathon &&
        session.currentBlockIdx < session.marathonBlocks.length - 1 &&
        !session.forceStopped
      ) {
        session.currentBlockIdx++;
        const nextBlock = session.marathonBlocks[session.currentBlockIdx];
        const { prepareShuffledQuestions } = require("../core/questionUtils");
        session.sessionQuestions = prepareShuffledQuestions(
          nextBlock.questions,
        );
        session.testId = nextBlock.id ? `ugc_${nextBlock.id}` : nextBlock.test_id;
        session.blockName = nextBlock.block_name;
        session.qIdx = 0;
        session.consecutiveTimeouts = 0;
        session.pollId = null;
        session.msgId = null;
        session.groupScores = {};
        session.finished = false;
        session.isFinished = false;
        session.questionState = "PREPARING";
        session.transitionLock = null;

        await sessionService.setActiveTest(chatId, session);

        text = `🏁 <b>${session.currentBlockIdx}-Blok Yakunlandi!</b>\n\n🏆 <b>Bu blok bo'yicha oraliq natijalar:</b>\n${body}\n\n⏳ <i>Keyingi navbat: <b>${escapeHtml(nextBlock.block_name)}</b></i>`;
        text = truncateText(text, 4000);

        const interOpts = {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "▶️ Keyingi blokni boshlash",
                  callback_data: "room_next_block",
                },
              ],
            ],
          },
        };
        if (session.messageThreadId) interOpts.message_thread_id = session.messageThreadId;
        await telegram.sendMessage(chatId, text, interOpts);

        isMarathonContinuing = true;
        return;
      } else {
        const botInfo = await telegram.getMe();
        let targetLink = "";
        const isUgc = sid.startsWith("ugc_") || Boolean(session.creatorId) || Boolean(session.subjectId);
        if (isUgc) {
          if (session.isMarathon) {
            const mSubjId = session.subjectId || session.marathonBlocks?.[0]?.subject_id || session.marathonBlocks?.[0]?.id || 1;
            targetLink = buildShareLink(botInfo.username, "s", mSubjId, true);
          } else {
            const rawTestId = sid.startsWith("ugc_") ? parseInt(sid.replace("ugc_", ""), 10) : tId;
            targetLink = buildShareLink(botInfo.username, "t", rawTestId, true);
          }
        } else {
          if (session.isMarathon) {
            targetLink = `https://t.me/${botInfo.username}?startgroup=offs_${session.subjectKey}`;
          } else {
            targetLink = `https://t.me/${botInfo.username}?startgroup=offt_${session.subjectKey}_${tId}`;
          }
        }
        const shareLink = `https://t.me/share/url?url=${encodeURIComponent(targetLink)}&text=${encodeURIComponent("🏆 Bizning guruh reytingimiz chiroyli chiqdi! Siz ham do'stlar bilan o'ynang.")}`;

        if (session.isMarathon) {
          const globalEntries = Object.values(
            session.marathonGlobalScores,
          ).sort((a, b) => b.correct - a.correct);
          const topGlobal = globalEntries.slice(0, 25);
          let globalBody = topGlobal.length
            ? topGlobal
                .map(
                  (s, i) =>
                    `${medals[i] ?? "🔸"} <b>${escapeHtml(s.name)}</b>: ${s.correct} to'g'ri, ${s.wrong} xato`,
                )
                .join("\n")
            : "😔 Hech kim javob bermadi.";
          if (globalEntries.length > 25) {
            globalBody += `\n<i>...va yana ${globalEntries.length - 25} nafar ishtirokchi</i>`;
          }

          text = `🏆 <b>MARAFON YAKUNLANDI!</b>\n\n📚 Fan: <b>${escapeHtml(subjName)}</b>\nJami: <b>${session.marathonBlocks.length} ta blok</b> o'ynaldi\n⏱ Umumiy vaqt: <b>${time}</b>\n\n👑 <b>YAKUNIY CHEMPIONLAR REYTINGI:</b>\n${globalBody}`;
        } else {
          text = `🏁 <b>Musobaqa Yakunlandi!</b>\n\n📚 Fan: <b>${escapeHtml(subjName)}</b>\n🔖 Blok: <b>${escapeHtml(tName)}</b>\n⏱ Vaqt: <b>${time}</b>\n\n🏆 <b>Yakuniy Reyting:</b>\n${body}`;
        }

        buttons = [
          [
            Markup.button.url(
              "↗️ Do'stlarga maqtanib qo'yish (Ulashish)",
              shareLink,
            ),
          ],
        ];
      }
    }

    text = truncateText(text, 4000);
    const finishOpts = {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    };
    if (session.messageThreadId) finishOpts.message_thread_id = session.messageThreadId;

    await telegram.sendMessage(chatId, text, finishOpts);
  } catch (e) {
    console.error(`finishTest send error [${chatId}]:`, e.message);
  } finally {
    if (session?.pollId)
      await sessionService.deletePollChat(session.pollId).catch(() => {});
    if (!isMarathonContinuing) {
      await sessionService.deleteActiveTest(chatId).catch(() => {});
    }
  }
}

async function handlePollAnswer(pollAnswer, telegram) {
  const pollId = pollAnswer.poll_id;

  if (!pollAnswer.option_ids || pollAnswer.option_ids.length === 0) {
    return;
  }

  const cachedPoll = await activePollsCache.get(pollId);
  if (cachedPoll) {
    const { chatId, correct_index, qData } = cachedPoll;

    const unlockGroup = await mutex.lock(`poll:${chatId}`);
    try {
      const voter = pollAnswer.user || pollAnswer.voter_chat;
      if (!voter) return;

      // Avval sessiya haqiqatan ham shu poll'da va aktiv ekanligini tekshiramiz
      const session = await sessionService.getActiveTest(chatId);
      if (
        !session ||
        session.status === "paused" ||
        session.finished ||
        session.isFinished ||
        session.pollId !== pollId ||
        session.questionState === "TRANSITIONING"
      ) {
        return;
      }

      const uId = voter.id;
      const added = await redisConnection.sadd(`poll_voters:${pollId}`, String(uId)).catch(() => 1);
      if (added === 0) {
        return;
      }
      redisConnection.expire(`poll_voters:${pollId}`, 600).catch(() => {});

      const isCorrect = pollAnswer.option_ids[0] === correct_index;
      const uName = pollAnswer.user
        ? [pollAnswer.user.first_name, pollAnswer.user.last_name]
            .filter(Boolean)
            .join(" ") || "Talaba"
        : (pollAnswer.voter_chat?.title || "Kanal");
      userNameCache.set(uId, uName);

      let groupEntry = await groupTestCache.get(chatId);
      if (!groupEntry) {
        groupEntry = { scores: {} };
      }

      if (!groupEntry.scores[uId]) {
        groupEntry.scores[uId] = {
          name: uName,
          correct: 0,
          wrong: 0,
          mistakes: [],
        };
      }

      const sc = groupEntry.scores[uId];
      if (isCorrect) {
        sc.correct++;
      } else {
        sc.wrong++;
        sc.mistakes.push({
          question: qData.question,
          correct_ans: qData.correct_text || qData.options[qData.correct_index],
          wrong_ans: qData.options[pollAnswer.option_ids[0]],
          options: qData.options,
          correct_index: qData.correct_index,
        });
      }
      await groupTestCache.set(chatId, groupEntry);

      const expectedCount = cachedPoll.expectedParticipantsCount || session.expectedParticipantsCount || 0;
      const voterCount = typeof redisConnection.scard === "function"
        ? await redisConnection.scard(`poll_voters:${pollId}`).catch(() => 0)
        : 0;

      if (
        expectedCount >= 2 &&
        voterCount >= expectedCount &&
        session.transitionLock !== session.qIdx
      ) {
        await cancelSessionTimer(session, chatId);
        session.transitionLock = session.qIdx;
        session.questionState = "TRANSITIONING";
        session.consecutiveTimeouts = 0;
        session.qIdx++;
        await sessionService.setActiveTest(chatId, session);

        await activePollsCache.delete(pollId);
        await sessionService.deletePollChat(pollId).catch(() => {});
        try {
          await telegram.stopPoll(chatId, session.msgId);
        } catch {}

        await wait(600);
        await sendNextQuestion(chatId, telegram);
      }
    } finally {
      unlockGroup();
    }
    return;
  }

  const chatId = await sessionService.getPollChat(pollId);
  if (!chatId) return;

  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (
      !session ||
      session.status === "paused" ||
      session.finished ||
      session.isFinished ||
      session.pollId !== pollId ||
      session.chatType !== "private"
    )
      return;

    if (session.transitionLock === session.qIdx || session.questionState === "TRANSITIONING") {
      return;
    }
    session.transitionLock = session.qIdx;
    session.questionState = "TRANSITIONING";
    await sessionService.setActiveTest(chatId, session);

    const qData = session.sessionQuestions[session.qIdx];
    const isCorrect = pollAnswer.option_ids[0] === qData.correct_index;
    const voter = pollAnswer.user || pollAnswer.voter_chat;
    const uId = voter ? voter.id : chatId;
    const uName = pollAnswer.user
      ? [pollAnswer.user.first_name, pollAnswer.user.last_name]
          .filter(Boolean)
          .join(" ") || "Talaba"
      : (pollAnswer.voter_chat?.title || "Talaba");
    userNameCache.set(uId, uName);

    session.consecutiveTimeouts = 0;
    try {
      await telegram.stopPoll(chatId, session.msgId);
    } catch {}

    await sessionService.deletePollChat(pollId).catch(() => {});
    await cancelSessionTimer(session, chatId);

    if (isCorrect) {
      session.correct++;
    } else {
      session.wrong++;
      session.mistakes.push({
        question: qData.question,
        correct_ans: qData.correct_text || qData.options[qData.correct_index],
        wrong_ans: qData.options[pollAnswer.option_ids[0]],
        options: qData.options,
        correct_index: qData.correct_index,
      });
    }

    session.qIdx++;
    await sessionService.setActiveTest(chatId, session);
    await wait(600);
    await sendNextQuestion(chatId, telegram);
  } finally {
    unlock();
  }
}

async function questionTimeout(chatId, expectedIdx, pollId, telegram) {
  await activePollsCache.delete(pollId);
  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session || session.finished || session.isFinished || session.qIdx !== expectedIdx || session.pollId !== pollId)
      return;
    if (session.status === "paused") return;

    if (session.transitionLock === expectedIdx || session.questionState === "TRANSITIONING") {
      return;
    }
    session.transitionLock = expectedIdx;
    session.questionState = "TRANSITIONING";
    await sessionService.setActiveTest(chatId, session);

    try {
      await telegram.stopPoll(chatId, session.msgId);
    } catch {}

    await sessionService.deletePollChat(pollId).catch(() => {});

    const qData = session.sessionQuestions[expectedIdx];
    session.qIdx++;

    if (session.chatType === "private") {
      session.wrong++;
      session.consecutiveTimeouts++;
      session.mistakes.push({
        question: qData.question,
        correct_ans: qData.correct_text || qData.options[qData.correct_index],
        wrong_ans: "⏳ Vaqt tugadi",
        options: qData.options,
        correct_index: qData.correct_index,
      });

      if (
        session.consecutiveTimeouts >= 2 &&
        session.qIdx < session.sessionQuestions.length
      ) {
        const remaining = session.sessionQuestions.length - session.qIdx;
        session.status = "paused";
        await sessionService.setActiveTest(chatId, session);
        await telegram.sendMessage(
          chatId,
          `⏸ <b>Ouu, qayerdasiz?</b> ☕️\n\n` +
          `Ketma-ket 2 ta savol o'tib ketdi. Qahva ichgani ketdingizmi?\n\n` +
          `Xavotir olmang, test avtomatik pauza qilindi. Qachon tayyor bo'lsangiz, davom etamiz!\n\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `📊 <b>Joriy natija:</b>\n` +
          `✅ To'g'ri: <b>${session.correct} ta</b>\n` +
          `❌ Xato:    <b>${session.wrong} ta</b>\n` +
          `📌 Qolgan:  <b>${remaining} ta savol</b>\n` +
          `━━━━━━━━━━━━━━━━`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("▶️ Davom etaman", "resume_test")],
              [Markup.button.callback("🏁 Yakunlash", "force_finish")],
            ]),
          },
        );
        return;
      }
    }

    if (session.chatType !== "private") {
      const voterCount = typeof redisConnection.scard === "function"
        ? await redisConnection.scard(`poll_voters:${pollId}`).catch(() => 0)
        : 0;
      if (voterCount === 0) {
        session.consecutiveTimeouts = (session.consecutiveTimeouts || 0) + 1;
      } else {
        session.consecutiveTimeouts = 0;
      }

      if (session.consecutiveTimeouts >= 3) {
        await telegram.sendMessage(
          chatId,
          `🛑 <b>Musobaqa to'xtatildi!</b>\n\nKetma-ket 3 ta savolga hech kim javob bermagani sababli test avtomatik yakunlandi.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        await sessionService.setActiveTest(chatId, session);
        return finishTest(chatId, telegram);
      }
    }

    await sessionService.setActiveTest(chatId, session);
    await sendNextQuestion(chatId, telegram);
  } finally {
    unlock();
  }
}

module.exports = {
  sendNextQuestion,
  finishTest,
  handlePollAnswer,
  questionTimeout,
  lastMistakesCache,
  resolveTestName,
  groupTestCache,
  activePollsCache,
  buildFinishButtons,
  cancelSessionTimer,
};

```

### 2. `src/handlers/quizGame.js` (To'liq kod)

```
"use strict";
const redisConnection = require("../services/redisService");
const { Markup } = require("telegraf");
const mutex = require("../core/mutex");
const { SUBJECTS } = require("../config/config");
const dbService = require("../services/dbService");
const aiService = require("../services/aiService");
const sessionService = require("../services/sessionService");
const {
  getBlocksKeyboard,
  getMainKeyboard,
} = require("../keyboards/keyboards");
const {
  prepareShuffledQuestions,
  shuffleArray,
  deepClone,
} = require("../core/questionUtils");
const {
  safeEdit,
  safeDelete,
  backToMainKb,
  parseSuffix,
  escapeHtml,
  safeAnswerCb,
  clearState,
  naturalSortBlocks,
  safeCallbackData,
} = require("../core/utils");

const {
  sendNextQuestion,
  finishTest,
  handlePollAnswer,
  questionTimeout,
  lastMistakesCache,
  groupTestCache,
  cancelSessionTimer,
} = require("./coreQuiz");
const {
  cbRoomReady,
  cbRoomStart,
  cbRoomCancel,
  cbRoomNextBlock,
} = require("./groupQuizLogic");
const { cbAdaptiveTest, cbAdaptiveRun } = require("./adaptiveQuiz");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Interaktiv inline taymerlar boshqaruvi
const activeWmTimers = new Map();

function clearWmTimer(chatId) {
  if (activeWmTimers.has(chatId)) {
    clearTimeout(activeWmTimers.get(chatId));
    activeWmTimers.delete(chatId);
  }
}

// ─── OFFICIAL TEST SELECTION ─────────────────────────────────

async function cbOfficialTests(ctx) {
  clearWmTimer(ctx.chat?.id);
  clearState(ctx);
  await safeAnswerCb(ctx);
  const memDb = require("../core/bot").memoryDb;
  const buttons = Object.entries(SUBJECTS).map(([k, v]) => {
    const blocks = memDb[k] || {};
    const qCount = Object.values(blocks).reduce(
      (s, b) => s + (b.questions || []).length,
      0,
    );
    return [
      Markup.button.callback(
        `📘 ${v}  •  ${Object.keys(blocks).length} blok, ${qCount} savol`,
        `subj_${k}`,
      ),
    ];
  });
  buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
  await safeEdit(
    ctx,
    `📚 <b>Rasmiy Test Bazasi</b>\n\nProfessional tarzda tayyorlangan rasmiy test bloklari. Fan tanlang va bilimingizni sinab ko'ring!\n\n💡 <i>Har bir fanda Adaptiv test va Aralash (Mock Exam) rejimi mavjud.</i>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
  );
}

async function sendWaitingRoomMessage(ctx, chatId, subjectKey, testId, qCount) {
  const room = (await sessionService.getWaitingRoom(chatId)) || {};
  let usersList = [];
  if (room.readyUsers) {
    if (Array.isArray(room.readyUsers)) {
      usersList = room.readyUsers.map((u) => (typeof u === "string" ? u : u.name || "Foydalanuvchi"));
    } else if (typeof room.readyUsers === "object") {
      usersList = Object.values(room.readyUsers).map((u) => (typeof u === "string" ? u : u.name || "Foydalanuvchi"));
    }
  }
  const subjTitle = SUBJECTS[subjectKey] || subjectKey;
  const text =
    `🎯 <b>Kutish Zali</b>\n\n` +
    `📚 Fan: <b>${escapeHtml(subjTitle)}</b>\n` +
    `🔢 Savollar: <b>${qCount} ta</b>\n\n` +
    `👥 Qatnashchilar: ${usersList.length} ta\n` +
    (usersList.length
      ? usersList.map((name, i) => `<b>${i + 1}.</b> ${escapeHtml(name)}`).join("\n")
      : "<i>Hali hech kim yo'q</i>");

  const buttons = [
    [Markup.button.callback("✋ Men ham qatnashaman", "room_ready")],
    [
      Markup.button.callback("▶️ Boshlash", "room_start"),
      Markup.button.callback("❌ Bekor qilish", "room_cancel"),
    ],
  ];

  await ctx.telegram.sendMessage(chatId, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function initAndStartTest(
  chatId,
  telegram,
  subjectKey,
  testId,
  testData,
  initiatorId,
  chatType,
) {
  clearWmTimer(chatId);
  if (chatType !== "private") {
    await groupTestCache.delete(chatId);
  }
  const sessionQ = prepareShuffledQuestions(testData.questions || []);
  const subjName = SUBJECTS[subjectKey] || subjectKey;
  const blockName =
    testData.block_name ||
    (String(testId).startsWith("ugc_") ? "Maxsus Test" : `${testId}-Blok`);

  await sessionService.setActiveTest(chatId, {
    chatType,
    initiatorId,
    subjectKey,
    testId,
    subjectId: testData?.subject_id || null,
    creatorId: testData?.creator_id || null,
    isUgc: Boolean(testData?.is_ugc) || String(testId).startsWith("ugc_") || Boolean(testData?.subject_id),
    blockName: blockName,
    sessionQuestions: sessionQ,
    qIdx: 0,
    startTime: Date.now(),
    pollId: null,
    msgId: null,
    correct: 0,
    wrong: 0,
    mistakes: [],
    consecutiveTimeouts: 0,
    groupScores: {},
    finished: false,
    isFinished: false,
    status: "preparing",
    transitionLock: null,
    questionState: "PREPARING",
  });

  if (chatType === "private") {
    const text = `📚 <b>Fan:</b> ${escapeHtml(subjName)}\n🔖 <b>Blok:</b> ${escapeHtml(blockName)}\n🔢 <b>Savollar:</b> ${sessionQ.length} ta\n\n🚀 <b>Testga tayyormisiz?</b>\nBoshlash uchun pastdagi tugmani bosing!`;

    await telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "▶️ Boshlash", callback_data: "user_ready_start" }],
        ],
      },
    });
  } else {
    const session = await sessionService.getActiveTest(chatId);
    session.status = "running";
    session.startTime = Date.now();
    await sessionService.setActiveTest(chatId, session);
    await sendNextQuestion(chatId, telegram);
  }
}

async function cbSubject(ctx) {
  clearWmTimer(ctx.chat?.id);
  await ctx.answerCbQuery().catch(() => {});
  const subjectKey = parseSuffix(ctx.callbackQuery.data, "subj_");
  const subjName = escapeHtml(SUBJECTS[subjectKey] || "Fan");
  const botInfo = await ctx.telegram.getMe();

  const blocksKb = getBlocksKeyboard(subjectKey, 0);

  blocksKb.reply_markup.inline_keyboard.unshift([
    Markup.button.url(
      "🏃 Butun fanni Guruhda o'ynash (Marafon)",
      `https://t.me/${botInfo.username}?startgroup=offs_${subjectKey}`,
    ),
  ]);

  await safeEdit(
    ctx,
    `📚 <b>${subjName}</b>\n\nQuyidagi blokdan birini tanlang yoki maxsus rejimlardan foydalaning:`,
    { parse_mode: "HTML", ...blocksKb },
  );
}

async function cbPage(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const parts = ctx.callbackQuery.data.split("_");
  const page = parseInt(parts[parts.length - 1], 10);
  const subjectKey = parts.slice(1, parts.length - 1).join("_");
  try {
    await ctx.editMessageReplyMarkup(
      getBlocksKeyboard(subjectKey, page).reply_markup,
    );
  } catch {}
}

// ─── TEST START ENTRY POINTS ─────────────────────────────────

async function cbStartTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  const unlock = await mutex.lock(`start_test:${chatId}`);
  const memDb = require("../core/bot").memoryDb;

  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing) {
      await ctx
        .answerCbQuery("⚠️ Faol test mavjud!", { show_alert: false })
        .catch(() => {});
      return ctx.reply(
        "⚠️ <b>Sizda tugallanmagan (yoki qotib qolgan) test bor.</b>\n\nYangi test boshlashdan oldin uni to'xtatishingiz kerak:",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "🛑 Faol testni to'xtatish",
                "force_finish",
              ),
            ],
          ]),
        },
      );
    }
    const isMock = ctx.callbackQuery.data.startsWith("mock_");
    let subjectKey, testId, testData;

    if (isMock) {
      subjectKey = parseSuffix(ctx.callbackQuery.data, "mock_");
      const allRaw = Object.values(memDb[subjectKey] || {}).flatMap(
        (t) => t.questions || [],
      );
      if (!allRaw.length)
        return ctx
          .answerCbQuery("❌ Bu fanda savollar yo'q!", {
            show_alert: true,
          })
          .catch(() => {});
      const allQs = deepClone(allRaw);
      shuffleArray(allQs);
      testData = { questions: allQs.slice(0, 25), block_name: "Aralash Test", subject: subjectKey };
      testId = "mock";
    } else {
      const suffix = parseSuffix(ctx.callbackQuery.data, "start_test_");
      const parts = suffix.split("_");
      testId = parseInt(parts[parts.length - 1], 10);
      subjectKey = parts.slice(0, -1).join("_");
      const rawBlock = (memDb[subjectKey] || {})[testId];
      if (!rawBlock)
        return ctx
          .answerCbQuery("❌ Test topilmadi!", { show_alert: true })
          .catch(() => {});
      testData = { ...rawBlock, subject: subjectKey, block_name: rawBlock.block_name || `${testId}-Blok` };
    }

    const msgText = ctx.callbackQuery?.message?.text || "";
    if (!msgText.startsWith("🏁")) {
      await safeDelete(ctx);
    } else {
      await ctx.editMessageReplyMarkup({}).catch(() => {});
    }

    if (ctx.chat.type !== "private") {
      const initiatorName = ctx.from.first_name || "Muallif";
      await sessionService.setWaitingRoom(chatId, {
        subjectKey,
        testId,
        testData,
        mode: "block",
        isOfficial: true,
        param: `offt_${subjectKey}_${testId}`,
        initiatorId: ctx.from.id,
        initiatorName,
        readyUsers: { [ctx.from.id]: initiatorName },
      });
      return sendWaitingRoomMessage(
        ctx,
        chatId,
        subjectKey,
        testId,
        testData.questions.length,
      );
    }

    await initAndStartTest(
      chatId,
      ctx.telegram,
      subjectKey,
      testId,
      testData,
      ctx.from.id,
      "private",
    );
  } catch (e) {
    console.error("cbStartTest error:", e.message);
  } finally {
    unlock();
  }
}

async function cbPostStart(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  const unlock = await mutex.lock(`start_test:${chatId}`);
  const suffix = parseSuffix(ctx.callbackQuery.data, "post_start_");
  const parts = suffix.split("_");
  const testId = parseInt(parts[parts.length - 1], 10);
  const subjectKey = parts.slice(0, -1).join("_");

  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing)
      return ctx
        .answerCbQuery(
          "⚠️ Hozirda faol test mavjud. Avval uni yakunlang yoki /stop buyrug'i bilan to'xtating.",
          {
            show_alert: true,
          },
        )
        .catch(() => {});

    const memDb = require("../core/bot").memoryDb || {};
    const rawBlock = (memDb[subjectKey] || {})[testId];
    if (!rawBlock)
      return ctx
        .answerCbQuery("❌ Test topilmadi!", { show_alert: true })
        .catch(() => {});

    const testData = { ...rawBlock, subject: subjectKey, block_name: rawBlock.block_name || `${testId}-Blok` };

    try {
      await ctx.editMessageReplyMarkup({});
    } catch {}

    if (ctx.chat.type !== "private") {
      const initiatorName = ctx.from?.first_name || "Muallif";
      await sessionService.setWaitingRoom(chatId, {
        subjectKey,
        testId,
        testData,
        mode: "block",
        isOfficial: true,
        param: `offt_${subjectKey}_${testId}`,
        initiatorId: ctx.from.id,
        initiatorName,
        readyUsers: { [ctx.from.id]: initiatorName },
      });
      return sendWaitingRoomMessage(
        ctx,
        chatId,
        subjectKey,
        testId,
        testData.questions.length,
      );
    }

    await initAndStartTest(
      chatId,
      ctx.telegram,
      subjectKey,
      testId,
      testData,
      ctx.from.id,
      "private",
    );
  } catch (e) {
    console.error("cbPostStart error:", e.message);
  } finally {
    unlock();
  }
}

// ─── UGC (USER-GENERATED TESTS) ──────────────────────────────

async function showUgcSubjectBlocks(ctx, subjectIdOrCreator, subjectName = null, loadingMsgId = null) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  clearWmTimer(chatId);
  try {
    let subjTests = [];
    let titleSubject = subjectName;

    const numericId = parseInt(subjectIdOrCreator, 10);
    if (!isNaN(numericId) && numericId > 0 && !subjectName) {
      const subject = await dbService.getSubjectById(numericId);
      if (subject) {
        titleSubject = subject.name;
        subjTests = await dbService.getSubjectBlocks(subject.id);
      } else {
        const testData = await dbService.getUserTest(numericId);
        if (testData) {
          titleSubject = testData.subject;
          if (testData.subject_id) {
            subjTests = await dbService.getSubjectBlocks(testData.subject_id);
          } else {
            const tests = await dbService.getUserCreatedTests(testData.creator_id);
            subjTests = naturalSortBlocks((tests || []).filter((t) => t.subject === testData.subject));
          }
        }
      }
    } else if (numericId && subjectName) {
      subjTests = await dbService.getSubjectBlocks(numericId);
      titleSubject = subjectName;
    } else {
      const tests = await dbService.getUserCreatedTests(subjectIdOrCreator);
      subjTests = naturalSortBlocks((tests || []).filter((t) => t.subject === subjectName));
      titleSubject = subjectName;
    }

    if (!subjTests.length) {
      const emptyText = "❌ Bu fanda bloklar topilmadi.";
      if (loadingMsgId && chatId) {
        return ctx.telegram.editMessageText(
          chatId,
          loadingMsgId,
          undefined,
          emptyText,
          backToMainKb()
        ).catch(() => ctx.reply(emptyText, backToMainKb()));
      }
      return ctx.reply(emptyText, backToMainKb());
    }

    const buttons = subjTests.map((t) => [
      Markup.button.callback(
        `📘 ${t.block_name}  •  ${(t.questions || []).length} savol`,
        `ugc_start_${t.id}`,
      ),
    ]);
    buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);

    const text = `📚 <b>${escapeHtml(titleSubject || "Fan")}</b>\n\n${subjTests.length} ta blok mavjud. Boshlash uchun blokni tanlang:`;
    const opts = { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) };

    if (loadingMsgId && chatId) {
      try {
        await ctx.telegram.editMessageText(
          chatId,
          loadingMsgId,
          undefined,
          text,
          opts
        );
        return;
      } catch {}
    }

    if (ctx.callbackQuery) {
      return safeEdit(ctx, text, opts);
    }

    await ctx.reply(text, opts);
  } catch (e) {
    console.error("showUgcSubjectBlocks error:", e.message);
  }
}

async function cbUgcSubj(ctx) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  clearWmTimer(chatId);
  await redisConnection.del(`wm_state:${chatId}`).catch(() => {});
  await safeAnswerCb(ctx);
  const subjectId = parseSuffix(ctx.callbackQuery.data, "ugc_subj_");
  await showUgcSubjectBlocks(ctx, subjectId);
}

async function startUgcTest(ctx, testDb) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  const unlock = await mutex.lock(`start_test:${chatId}`);
  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing)
      return ctx.reply(
        "⚠️ Sizda hozirda faol test mavjud. Avval uni yakunlang yoki /stop bilan to'xtating.",
      );

    if (ctx.chat?.type !== "private") {
      const initiatorName = ctx.from.first_name || "Muallif";
      await sessionService.setWaitingRoom(chatId, {
        subjectKey: testDb.subject,
        testId: `ugc_${testDb.id}`,
        testData: testDb,
        mode: "block",
        isOfficial: false,
        param: `t_${testDb.id}`,
        initiatorId: ctx.from.id,
        initiatorName,
        readyUsers: { [ctx.from.id]: initiatorName },
      });
      return sendWaitingRoomMessage(
        ctx,
        chatId,
        testDb.subject,
        `ugc_${testDb.id}`,
        testDb.questions?.length || 0,
      );
    }

    await initAndStartTest(
      chatId,
      ctx.telegram,
      testDb.subject,
      `ugc_${testDb.id}`,
      testDb,
      ctx.from.id,
      "private",
    );
  } catch (e) {
    console.error("startUgcTest error:", e.message);
  } finally {
    unlock();
  }
}

async function cbUgcStart(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const testId = parseSuffix(ctx.callbackQuery.data, "ugc_start_");
  try {
    const testDb = await dbService.getUserTest(testId);
    if (!testDb)
      return ctx.reply("❌ Test topilmadi yoki o'chirilgan.", backToMainKb());
    const msgText = ctx.callbackQuery?.message?.text || "";
    if (msgText.startsWith("🏁")) {
      await ctx.editMessageReplyMarkup({}).catch(() => {});
    } else {
      await safeDelete(ctx);
    }
    await startUgcTest(ctx, testDb);
  } catch (e) {
    console.error("cbUgcStart error:", e.message);
  }
}

// ─── SESSION CONTROL ─────────────────────────────────────────

async function cbUserReadyStart(ctx) {
  const chatId = ctx.chat.id;
  const unlock = await mutex.lock(`ready_start:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session || session.status !== "preparing") {
      return ctx
        .answerCbQuery("⚠️ Test topilmadi yoki allaqachon boshlangan!", {
          show_alert: true,
        })
        .catch(() => {});
    }
    if (session.initiatorId !== ctx.from.id) {
      return ctx
        .answerCbQuery("⚠️ Bu sizning testingiz emas!", {
          show_alert: true,
        })
        .catch(() => {});
    }

    await ctx.answerCbQuery("🚀 Test boshlanmoqda!").catch(() => {});
    session.status = "running";
    session.startTime = Date.now();
    await sessionService.setActiveTest(chatId, session);

    const subjName = SUBJECTS[session.subjectKey] || session.subjectKey;
    const blockName = session.blockName || "Test";
    const header = `📚 <b>Fan:</b> ${escapeHtml(subjName)}\n🔖 <b>Blok:</b> ${escapeHtml(blockName)}\n\n`;

    await safeEdit(
      ctx,
      header +
        "🚀 <b>Kamarlarni taqing! BOSHLADIK!</b> Omad yor bo'lsin, muvaffaqiyat sizga! 🍀",
      {
        parse_mode: "HTML",
      },
    );

    await sendNextQuestion(chatId, ctx.telegram);
  } catch (e) {
    console.error("cbUserReadyStart error:", e.message);
  } finally {
    unlock();
  }
}

// ─── 1. PAUZA MENYUSI (/stop Yoki To'xtatish bosilganda) ─────────────
async function cbStopTest(ctx) {
  const isCb = !!ctx.callbackQuery;
  if (isCb) await ctx.answerCbQuery("⏸ Pauza...").catch(() => {});
  const chatId = ctx.chat.id;

  const unlock = await mutex.lock(`poll:${chatId}`);
  let session;
  try {
    session = await sessionService.getActiveTest(chatId);
    if (!session) {
      const msg = "⚠️ Faol test topilmadi yoki allaqachon yakunlangan.";
      const kbd = {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
        ]),
      };
      return isCb ? safeEdit(ctx, msg, kbd) : ctx.reply(msg, kbd);
    }

    if (session.msgId) {
      await ctx.telegram.stopPoll(chatId, session.msgId).catch(() => {});
    }
    if (session.pollId) {
      await sessionService.deletePollChat(session.pollId).catch(() => {});
      session.pollId = null;
    }
    try {
      await cancelSessionTimer(session, chatId);
    } catch {}

    session.status = "paused";
    await sessionService.setActiveTest(chatId, session);
  } finally {
    unlock();
  }

  const total = session.sessionQuestions ? session.sessionQuestions.length : 0;
  const answered = session.qIdx || 0;

  const text =
    `⏸ <b>Test to'xtatib turildi (Pauza)!</b>\n\n` +
    `📊 <b>Hozirgi holat:</b>\n` +
    `Jami savollar: ${total} ta\n` +
    `Ishlandi: ${answered} ta\n` +
    `To'g'ri: ${session.correct || 0} ta\n\n` +
    `<i>Nima qilamiz? Quyidagilardan birini tanlang:</i>`;

  const buttons = [
    [Markup.button.callback("▶️ Davom etish", "pause_resume")],
    [
      Markup.button.callback(
        "🏁 Hozirgi natija bilan yakunlash",
        "pause_finish",
      ),
    ],
    [
      Markup.button.callback(
        "📥 Javonga saqlash (Keyin davom etish)",
        "pause_shelf",
      ),
    ],
    [Markup.button.callback("🗑 Butunlay bekor qilish", "force_finish")],
  ];

  if (isCb) {
    await safeEdit(ctx, text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    });
  }
}

// ─── 2. DAVOM ETISH (Resume) ─────────────
async function cbPauseResume(ctx) {
  await ctx.answerCbQuery("▶️ Test davom etmoqda...").catch(() => {});
  await safeDelete(ctx);

  const chatId = ctx.chat.id;
  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (session && session.status === "paused") {
      session.status = "running";
      session.consecutiveTimeouts = 0;
      await sessionService.setActiveTest(chatId, session);
      await sendNextQuestion(chatId, ctx.telegram);
    } else if (!session) {
      await safeEdit(ctx, "⚠️ Test sessiyasi topilmadi yoki eskirgan.", { parse_mode: "HTML" }).catch(() => {});
    }
  } catch (e) {
    console.error("cbPauseResume error:", e.message);
  } finally {
    unlock();
  }
}

// ─── 3. SHU YERDA YAKUNLASH VA NATIJANI KO'RISH (Finish) ─────────────
async function cbPauseFinish(ctx) {
  await ctx.answerCbQuery("🏁 Yakunlanmoqda...").catch(() => {});
  await safeDelete(ctx);
  await finishTest(ctx.chat.id, ctx.telegram);
}

// ─── 4. JAVONGA SAQLASH UCHUN TAYYORLASH (Shelf) ─────────────
async function cbPauseShelf(ctx) {
  await ctx.answerCbQuery("📥 Javon uchun tayyorlanmoqda...").catch(() => {});
  const chatId = ctx.chat.id;
  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session) return safeEdit(ctx, "⚠️ Faol test topilmadi.");

    let saveTestId = session.testId;
    if (saveTestId === "mock" || saveTestId === "adaptive" || saveTestId === "retry") {
      saveTestId = `${saveTestId}_${Date.now()}`;
    }
    const shelfData = {
      testId: saveTestId,
      testName: session.blockName || "Noma'lum blok",
      subject: session.subjectKey || "Noma'lum fan",
      subjectId: session.subjectId || null,
      creatorId: session.creatorId || null,
      questions: session.sessionQuestions || [],
      progress: {
        current_index: session.qIdx || 0,
        correct: session.correct || 0,
        mistakes: session.mistakes || [],
      },
    };

    await redisConnection
      .set(`shelf_pending:${chatId}`, JSON.stringify(shelfData), "EX", 86400)
      .catch(() => {});

    if (session.msgId) {
      await ctx.telegram.stopPoll(chatId, session.msgId).catch(() => {});
    }
    if (session.pollId) {
      await sessionService.deletePollChat(session.pollId).catch(() => {});
      session.pollId = null;
    }
    try {
      await cancelSessionTimer(session, chatId);
    } catch {}
    session.status = "paused";
    await sessionService.setActiveTest(chatId, session).catch(() => {});

    await safeEdit(
      ctx,
      `🛑 <b>Test to'xtatildi va Javon uchun tayyorlandi!</b>\n\nSiz testni oxirigacha ishlashni xohlamadingiz. Pastdagi tugmani bosib uni shaxsiy javoningizga saqlab qo'ying.`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "📥 Tasdiqlash va Javonga saqlash",
              "shelf_save_init",
            ),
          ],
          [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
        ]),
      },
    );
  } finally {
    unlock();
  }
}

// ─── POST-TEST ACTIONS (ERROR REVIEW & MASTERY) ──────────────

async function cbReviewMistakes(ctx) {
  await ctx.answerCbQuery().catch(() => {});

  let page = 0;
  const match = ctx.callbackQuery.data.match(/review_mistakes_(\d+)/);
  if (match) page = parseInt(match[1], 10);

  const mistakes = (await lastMistakesCache.get(ctx.chat.id)) || [];
  if (!mistakes.length) {
    return ctx
      .answerCbQuery("🎉 Bu testda xato yo'q edi!", { show_alert: true })
      .catch(() => {});
  }

  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(mistakes.length / ITEMS_PER_PAGE);
  const validPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = validPage * ITEMS_PER_PAGE;
  const currentMistakes = mistakes.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const parts = [
    `📑 <b>Xatolar Tahlili</b> — <i>${mistakes.length} ta xato topildi</i>\n<i>Sahifa: ${validPage + 1} / ${totalPages}</i>\n`,
  ];

  currentMistakes.forEach((m, i) => {
    parts.push(
      `<b>${startIdx + i + 1}.</b> ${escapeHtml(String(m.question || "Savol matni yo'q"))}\n` +
      `❌ <i>Sizning javob: ${escapeHtml(String(m.wrong_ans || "-"))}</i>\n` +
      `✅ <b>To'g'ri javob: ${escapeHtml(String(m.correct_ans || "-"))}</b>`,
    );
  });

  const navRow = [];
  if (validPage > 0)
    navRow.push(
      Markup.button.callback(
        "⬅️ Oldingi 5 ta",
        `review_mistakes_${validPage - 1}`,
      ),
    );
  if (validPage < totalPages - 1)
    navRow.push(
      Markup.button.callback(
        "Keyingi 5 ta ➡️",
        `review_mistakes_${validPage + 1}`,
      ),
    );

  const buttons = [];
  if (navRow.length > 0) buttons.push(navRow);
  buttons.push([
    Markup.button.callback(
      "🤖 AI Tutor: Shu 5 ta xatoni tahlil qilish",
      `ai_explain_mistakes_${validPage}`,
    ),
  ]);

  const metaRaw = await redisConnection.get(`mistakes_meta:${ctx.chat.id}`).catch(() => null);
  const meta = metaRaw ? JSON.parse(metaRaw) : null;
  let backBtn;
  if (meta?.isUgc) {
    backBtn = meta.subjectId
      ? Markup.button.callback("🔙 Fan bloklariga qaytish", safeCallbackData(`ugc_subj_${meta.subjectId}`, 64))
      : Markup.button.callback("🔙 Mening testlarim", "my_tests");
  } else if (meta?.subjectKey && meta.subjectKey !== "main" && SUBJECTS[meta.subjectKey]) {
    backBtn = Markup.button.callback("🔙 Fan menyusiga qaytish", safeCallbackData(`post_subj_${meta.subjectKey}`, 64));
  } else {
    backBtn = Markup.button.callback("🏠 Asosiy Menyu", "post_main");
  }
  buttons.push([backBtn]);

  await safeEdit(ctx, parts.join("\n\n"), {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

// ─── ERROR MASTERY (XATOLAR USTIDA ISHLASH) ───────────────────

async function cbWorkMistakesMenu(ctx) {
  try {
    clearWmTimer(ctx.chat?.id);
    await ctx.answerCbQuery().catch(() => {});

    const metaRaw = await redisConnection.get(`mistakes_meta:${ctx.chat.id}`).catch(() => null);
    const meta = metaRaw ? JSON.parse(metaRaw) : null;
    const subjectKey = meta?.subjectKey || ctx.callbackQuery.data.replace("wm_menu_", "") || "general";

    const mistakes = (await lastMistakesCache.get(ctx.chat.id)) || [];
    if (!mistakes || mistakes.length === 0)
      return ctx
        .answerCbQuery("🎉 Xatolar topilmadi!", { show_alert: true })
        .catch(() => {});

    let backCallback = SUBJECTS[subjectKey] ? `post_subj_${subjectKey}` : "my_tests";
    let backLabel = SUBJECTS[subjectKey] ? "🔙 Fan menyusiga" : "🔙 Mening testlarim";
    if (meta?.isUgc) {
      backCallback = meta.subjectId ? `ugc_subj_${meta.subjectId}` : "my_tests";
      backLabel = meta.subjectId ? "🔙 Fan bloklariga" : "🔙 Mening testlarim";
    }

    await safeEdit(
      ctx,
      `🔄 <b>Xatolar ustida ishlash</b>\n\nSizda jami <b>${mistakes.length} ta</b> xato bor. Qaysi usulda qayta ishlamoqchisiz?`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🕹 Interaktiv Rejim",
              safeCallbackData(`wm_start_inline_${subjectKey}`, 64),
            ),
          ],
          [
            Markup.button.callback(
              "📊 Klassik Quiz",
              safeCallbackData(`wm_start_quiz_${subjectKey}`, 64),
            ),
          ],
          [
            Markup.button.callback(
              backLabel,
              safeCallbackData(backCallback, 64),
            ),
          ],
        ]),
      },
    );
  } catch (error) {
    console.error(`[wm_menu xatosi]:`, error);
  }
}

async function cbWmStartQuiz(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  clearWmTimer(chatId);

  const metaRaw = await redisConnection.get(`mistakes_meta:${chatId}`).catch(() => null);
  const meta = metaRaw ? JSON.parse(metaRaw) : null;
  const subjectKey = meta?.subjectKey || ctx.callbackQuery.data.replace("wm_start_quiz_", "") || "general";

  const mistakes = (await lastMistakesCache.get(chatId)) || [];

  if (!mistakes.length) {
    return ctx.reply("⚠️ Kechirasiz, xatoliklar ro'yxati xotiradan topilmadi yoki allaqachon o'zlashtirilgan.", backToMainKb());
  }

  await safeDelete(ctx);
  const testData = {
    block_name: "Xatolar ustida ishlash",
    questions: mistakes,
    subject_id: meta?.subjectId || null,
    is_ugc: Boolean(meta?.isUgc),
    creator_id: meta?.isUgc ? ctx.from.id : null,
  };

  let retryTestId = "retry";
  if (meta?.testId && !String(meta.testId).startsWith("retry")) {
    retryTestId = `retry_${meta.testId}`;
  }

  await initAndStartTest(
    chatId,
    ctx.telegram,
    subjectKey,
    retryTestId,
    testData,
    ctx.from.id,
    "private",
  );
}

async function cbWmStartInline(ctx) {
  try {
    await ctx
      .answerCbQuery("⏳ Interaktiv rejim yuklanmoqda...")
      .catch(() => {});
    const chatId = ctx.chat.id;

    const metaRaw = await redisConnection.get(`mistakes_meta:${chatId}`).catch(() => null);
    const meta = metaRaw ? JSON.parse(metaRaw) : null;
    const subjectKey = meta?.subjectKey || ctx.callbackQuery.data.replace("wm_start_inline_", "") || "general";

    const mistakes = (await lastMistakesCache.get(chatId)) || [];
    if (!mistakes || mistakes.length === 0) {
      return ctx.answerCbQuery("⚠️ Xatoliklar topilmadi yoki vaqti tugagan!", { show_alert: true }).catch(() => {});
    }

    const stateData = {
      queue: [...mistakes],
      total: mistakes.length,
      step: 0,
      awaitingNext: false,
      startTime: Date.now(),
      subjectKey: subjectKey,
      isUgc: Boolean(meta?.isUgc),
      subjectId: meta?.subjectId || null,
    };

    await redisConnection.set(
      `wm_state:${chatId}`,
      JSON.stringify(stateData),
      "EX",
      3600,
    );

    await sendNextInlineMistake(ctx);
  } catch (error) {
    console.error(`[cbWmStartInline Xatosi]:`, error);
  }
}

async function sendNextInlineMistake(ctx) {
  try {
    const chatId = ctx.chat.id;
    clearWmTimer(chatId);

    const rawState = await redisConnection.get(`wm_state:${chatId}`);
    if (!rawState) {
      return ctx.reply(
        "⚠️ Sessiya eskirgan yoki topilmadi. Qaytadan boshlang.",
      );
    }

    const state = JSON.parse(rawState);
    const queue = state.queue || [];

    let backAction;
    if (state.isUgc) {
      backAction = state.subjectId ? safeCallbackData(`ugc_subj_${state.subjectId}`, 64) : "my_tests";
    } else {
      const subjKey = state.subjectKey || "main";
      backAction = subjKey !== "main" && SUBJECTS[subjKey]
        ? safeCallbackData(`post_subj_${subjKey}`, 64)
        : "back_to_main";
    }

    // 🏆 G'alaba ekrani
    if (queue.length === 0) {
      await redisConnection.del(`wm_state:${chatId}`);
      await lastMistakesCache.clear(chatId).catch(() => {});
      return safeEdit(
        ctx,
        `🎉 <b>Tabriklaymiz! Barcha xatolarni yengdingiz!</b>\n\nSiz <b>${state.total} ta</b> xatoning barchasini qayta ishlab, to'g'ri javoblarni o'zlashtirdingiz! 🧠💪`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Fan menyusiga qaytish", backAction)],
          ]),
        },
      );
    }

    const q = queue[0];
    const qText = q.question || "Savol matni yo'q";

    let options = q.options;
    let correctIdx = q.correct_index;

    if (!options || options.length === 0) {
      let wrongAns = String(q.wrong_ans || "").trim();
      if (!wrongAns || wrongAns.includes("Vaqt tugadi")) {
        wrongAns = "Variant B";
      }
      options = [String(q.correct_ans), wrongAns];
      options.sort(() => Math.random() - 0.5);
      correctIdx = options.indexOf(String(q.correct_ans));
    }

    state.step = (state.step || 0) + 1;
    state.awaitingNext = false;
    state.startTime = Date.now();
    const currentStep = state.step;

    await redisConnection.set(
      `wm_state:${chatId}`,
      JSON.stringify(state),
      "EX",
      3600,
    );

    let text =
      `🎯 <b>Xatolar ustida ishlash</b> (Qoldi: ${queue.length} ta)\n` +
      `⏱ <i>Vaqt limiti: 20 soniya</i>\n━━━━━━━━━━━━━━━━\n` +
      `<b>Savol:</b>\n${escapeHtml(String(qText))}\n\n`;

    const buttons = [];
    const labels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    let row = [];

    options.forEach((opt, i) => {
      const isCorrect = i === correctIdx;
      const lbl = labels[i] || `${i + 1}`;
      text += `<b>${lbl})</b> ${escapeHtml(String(opt))}\n`;
      row.push(
        Markup.button.callback(
          lbl,
          `wm_ans_${currentStep}_${i}_${isCorrect ? 1 : 0}`,
        ),
      );

      if (row.length === 2 || i === options.length - 1) {
        buttons.push(row);
        row = [];
      }
    });

    buttons.push([Markup.button.callback("🛑 To'xtatish", "wm_stop")]);

    let msgId;
    if (ctx.callbackQuery) {
      await safeEdit(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
      msgId = ctx.callbackQuery.message.message_id;
    } else {
      const sentMsg = await ctx.reply(text, { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) });
      msgId = sentMsg.message_id;
    }

    const wmTimer = setTimeout(async () => {
      activeWmTimers.delete(chatId);
      const unlock = await mutex.lock(`wm_ans:${chatId}`);
      try {
        const rawCheck = await redisConnection.get(`wm_state:${chatId}`);
        if (!rawCheck) return;

        const checkState = JSON.parse(rawCheck);
        if (checkState.step === currentStep && !checkState.awaitingNext) {
          const timedOutQ = checkState.queue.shift();
          if (timedOutQ) checkState.queue.push(timedOutQ);
          checkState.awaitingNext = true;
          await redisConnection.set(`wm_state:${chatId}`, JSON.stringify(checkState), "EX", 3600);

          const correctText = q.correct_ans || (q.options ? q.options[q.correct_index] : "Noma'lum");

          await ctx.telegram.editMessageText(
            chatId,
            msgId,
            undefined,
            `⏳ <b>Vaqt tugadi!</b> (20 soniyadan o'tib ketdi)\n\nSiz hech qanday javob belgilamadingiz.\nTo'g'ri javob:\n<b>✅ ${escapeHtml(String(correctText))}</b>\n\n<i>Bu savol ro'yxat oxiriga tushdi!</i>`,
            {
              parse_mode: "HTML",
              ...Markup.inlineKeyboard([
                [Markup.button.callback("➡️ Davom etish", "wm_next")],
                [Markup.button.callback("🛑 To'xtatish", "wm_stop")],
              ]),
            }
          ).catch(() => {});
        }
      } catch (err) {
        console.error("Inline Timeout Xatosi:", err.message);
      } finally {
        unlock();
      }
    }, 20000);
    wmTimer.unref();
    activeWmTimers.set(chatId, wmTimer);
  } catch (error) {
    console.error(`[sendNextInlineMistake Xatosi - Chat: ${ctx.chat.id}]:`, error);
    await ctx
      .answerCbQuery("❌ Savolni chiqarishda xato yuz berdi!", {
        show_alert: true,
      })
      .catch(() => {});
  }
}

async function cbWmAns(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const unlock = await mutex.lock(`wm_ans:${chatId}`);
  try {
    const rawState = await redisConnection.get(`wm_state:${chatId}`);
    if (!rawState) {
      clearWmTimer(chatId);
      return ctx
        .answerCbQuery(
          "⚠️ Sessiya eskirgan yoki o'yin yakunlangan. Qayta boshlang.",
          { show_alert: true },
        )
        .catch(() => {});
    }

    const state = JSON.parse(rawState);
    const queue = state.queue || [];
    if (!queue.length || state.awaitingNext) {
      return ctx.answerCbQuery().catch(() => {});
    }

    const suffix = parseSuffix(ctx.callbackQuery.data, "wm_ans_");
    const parts = suffix.split("_");
    let isCorrect = false;
    if (parts.length >= 3) {
      const clickedStep = parseInt(parts[0], 10);
      if (state.step && clickedStep !== state.step) {
        return ctx.answerCbQuery().catch(() => {});
      }
      isCorrect = parts[parts.length - 1] === "1";
    } else {
      isCorrect = suffix === "1";
    }

    clearWmTimer(chatId);
    const q = queue.shift();

    const elapsed = Date.now() - (state.startTime || Date.now());
    const isTimeout = elapsed > 20500;

    if (isCorrect && !isTimeout) {
      await ctx.answerCbQuery("✅ Ajoyib! To'g'ri.").catch(() => {});
      await redisConnection.set(
        `wm_state:${chatId}`,
        JSON.stringify(state),
        "EX",
        3600,
      );
      return sendNextInlineMistake(ctx);
    } else {
      queue.push(q);
      state.awaitingNext = true;
      await redisConnection.set(
        `wm_state:${chatId}`,
        JSON.stringify(state

```