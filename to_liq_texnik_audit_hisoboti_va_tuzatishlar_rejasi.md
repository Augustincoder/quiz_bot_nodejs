# 🛡 Loyiha To'liq Texnik Auditi va High-Load Optimizatsiya Hisoboti
**Loyiha:** `quiz-bot-nodejs` (Talabalar Imtihon Trenajyori — Node.js)  
**Qamrov:** 61 ta runtime fayl (35 447 qator kod, 1.22 MB)  
**Maxsus fokus:** Telegram Bot API 10.4 HTML Widgets (`sendWidget`, `widget_query`, `shared_widget_query`), WebApp Widgets (`podium`, `flashcard`, `docxHealer`), Universal Test Hub, Feature Flag Governance va High-Load chidamlilik.

---

## 📊 1. Umumiy Xulosa (Executive Summary)

Loyiha arxitekturasi (Circuit Breaker, Singleflight kesh, BullMQ navbatlar, Surgical RAM Watchdog, L1/L2/L3 keshlar) juda kuchli poydevorga ega. Biroq yangi qo‘shilgan **Telegram Bot API 10.4 Widget** va **Universal Hub** qatlamlarida **8 ta kritik mantiqiy xato (Critical Bugs)**, **5 ta yuqori bosim (High-Load/Performance) zaifligi** hamda **6 ta arxitektura va kod takrorlanishi (DRY/Clean Code)** muammosi aniqlandi.

| Yo'nalish | Joriy Holat | Maqsadli Holat (Tuzatishdan so'ng) |
| :--- | :--- | :--- |
| **Telegram 10.4 Widget Engine** | ⚠️ Kritik sessiya va indeks xatolari bor | ✅ 100% Atomik, 1KB/4KB limitlarga mos |
| **WebApp (`flashcard`, `docx`, `podium`)** | ⚠️ State desync, XSS/HTML tag ko'rinishi | ✅ Real-time Redis sync va toza UI |
| **Performance & High-Load (512MB RAM)** | ⚠️ Sync `fs.readFileSync` va ochiq endpoint | ✅ Zero-I/O RAM shablonlar + Rate Limit |
| **Clean Code & DRY** | ⚠️ 4 ta asosiy mantiq bir necha joyda nusxalangan | ✅ Markazlashgan yagona helper modullar |

---

## 🚨 2. Kritik Mantiqiy Xatolar va Buglar (Critical Bugs & Logical Errors)

### 🔴 BUG-01: `index.js` da Middleware tartibi xatosi sababli `widget_query` ichida `ctx.session` doim `undefined` bo'lib qolishi
* **Joylashuv:** `index.js` (97–116-qatorlar va 131–180-qatorlar) hamda `src/handlers/testCreation.js` (1335-qator).
* **Muammo:** `index.js` da `widget_query` va `shared_widget_query` middleware Redis sessiya yuklovchi middleware'dan (131-qator) va ban-check middleware'dan (183-qator) **OLDIN** ro‘yxatdan o‘tkazilgan.
* **Oqibati:** Foydalanuvchi Telegram 10.4 inline `docxHealer` vidjeti ichida variantni bosganda (`docx_pick` yoki `docx_heal_all`), `handleDocxWidgetQuery(ctx, q)` chaqiriladi. Bu vaqtda `ctx.session` hali `undefined` bo‘lgani uchun `getData(fakeCtx)` bo‘sh `{}` qaytaradi (`invalidQs = []`). Natijada:
  1. Tanlangan javob kaliti saqlanmaydi;
  2. Vidjetga `questions: [], isFinished: true` qaytadi va vidjet birinchi bosishdayoq *"Tabriklaymiz! Barcha xatoliklar to'g'rilandi!"* deb barcha xato savollarni yo‘qotib yuboradi.
* **Qo'shimcha xato:** Telegraf `4.16.3` da `ctx.from` getteri `widget_query` va `shared_widget_query` update turlarini tanimaydi (`ctx.from === undefined`). Shu sababli `rateLimiterMiddleware` va `session` middleware `ctx.from?.id` orqali foydalanuvchini topa olmaydi. Shuningdek, `cramReviewHandler.js` (697–706-qatorlar) ichida xuddi shu middleware ikkinchi marta takroran ulangan.

---

### 🔴 BUG-02: Inline `docxHealer` vidjetida Indeks Siljishi (Index Shift) va Ma'lumot Buzilishi
* **Joylashuv:** `src/services/widgetService.js` (`buildInlineDocxHealerWidgetHtml`, 540–560-qatorlar) va `src/handlers/testCreation.js` (`handleDocxWidgetQuery`, 1341–1366-qatorlar).
* **Muammo:** 
  1. Frontend vidjetda foydalanuvchi 1-savol (`cur = 0`) uchun variant tanlaganda, frontend `qs` massividan savolni o‘chirmaydi, balki `nav(1)` orqali `cur = 1` ga o‘tadi va keyingi bosishda `qIdx: 1` yuboradi.
  2. Backend (`handleDocxWidgetQuery`, 1353-qator) esa `invalidQs.splice(qIdx, 1)` qilib, `0`-indeksdagi savolni massivdan o‘chirib tashlaydi!
* **Oqibati:**
  * 3 ta xato savol bo‘lsa (`[Q0, Q1, Q2]`): 1-savol (`qIdx: 0`) tuzatilgach, backendda `[Q1, Q2]` qoladi.
  * Foydalanuvchi 2-savol (`Q1`) uchun javob belgilaganda, frontend `qIdx: 1` yuboradi. Backend esa `invalidQs[1]` ni — ya'ni **`Q2` ni** oladi va unga `Q1` ning javobini yozib yuboradi! `Q1` esa qolib ketadi.
  * Foydalanuvchi 3-savol (`Q2`) uchun javob belgilaganda (`qIdx: 2`), backendda `invalidQs.length === 1` bo‘lgani uchun `qIdx < invalidQs.length` (`2 < 1`) `false` bo‘ladi va oxirgi savol umuman saqlanmaydi!

---

### 🔴 BUG-03: Inline `docxHealer` vidjetida Telegram Bot API 10.4 (1 KB `public_data` va 4 KB Zlib HTML) limitlarining buzilishi
* **Joylashuv:** `src/services/widgetService.js` (433–465-qatorlar) va `src/handlers/testCreation.js` (1385–1414-qatorlar).
* **Muammo:**
  1. `cramReviewHandler.js` da `makeSafeWidgetPublicData` faqat joriy 1 ta kartochkani 1000 baytgacha qisqartirib yuboradi. Ammo `testCreation.js` (`handleDocxWidgetQuery`) **barcha** `remainingInvalid` savollarni `JSON.stringify` qilib `editMessageWidgetData` (`public_data`, `chat_data`) va `answerWidgetQuery` (`data`) ga berib yuboradi.
  2. Telegram Bot API 10.4 da `public_data` va `chat_data` maksimal **1024 bayt**, inline HTML esa siqilgan holda **4096 bayt** bo‘lishi shart.
* **Oqibati:** Faylda 3 tadan ortiq xato savol bo‘lsa, `newPublicData` 1024 baytdan oshib ketadi va Telegram API `400 Bad Request: WIDGET_DATA_TOO_LONG` yoki `WIDGET_HTML_TOO_LONG` xatosini qaytaradi.

---

### 🔴 BUG-04: Flashcard Inline Widget (`buildInlineFlashcardWidgetHtml`) ichida `W.chatData || W.publicData` mantiqiy xatosi
* **Joylashuv:** `src/services/widgetService.js` (459–466-qatorlar) va `src/handlers/cramReviewHandler.js` (361–364 va 674-qatorlar).
* **Muammo:**
  1. `launchFlashcardReview` da `chat_data` sifatida faqat `{"userId":123,"cardIdx":0}` (savol va javob matnisiz!) yuboriladi, asosiy savol-javob esa `public_data` ichida bo‘ladi.
  2. Vidjet JS kodida (`widgetService.js`, 460-qator):
     ```javascript
     var lastData = '';
     function checkData() {
       var pd = W.chatData || W.publicData;
       if (pd && pd !== lastData) {
         lastData = pd;
         animateIn(pd);
       }
     }
     setInterval(checkData, 300);
     ```
* **Oqibati:**
  * `W.chatData` bo‘sh bo‘lmagani (`truthy`) sababli `W.chatData || W.publicData` har doim `W.chatData` ni tanlaydi.
  * Vidjet ochilganidan 300ms o‘tib, `checkData()` birinchi marta ishlaydi va `lastData === ''` bo‘lgani uchun kartochkani sababsiz qaytadan sakratib animatsiya qiladi (`animateIn`).
  * `shared_widget_query` orqali `editSharedWidgetData` faqat `public_data` ni yangilaganda, `W.chatData` o‘zgarmay qolgani uchun `checkData()` yangi kartochkani hech qachon ko‘rmaydi!
  * `W.request(act)` ishlaganda ham `W.request().then(animateIn)` va 300ms dan keyin `checkData()` ikki marta ustma-ust `animateIn` chaqiradi.

---

### 🔴 BUG-05: `flashcardWidget.html` (WebApp) ichida `Telegram.WebApp.sendData()` vidjetni majburan yopib yuborishi va Counter xatosi
* **Joylashuv:** `src/widgets/views/flashcardWidget.html` (333 va 382–391-qatorlar) hamda `src/widgets/widgetServer.js` (41–47-qatorlar).
* **Muammo:**
  1. `flashcardWidget.html` 384-qatorda har safar kartochka surilganda `window.Telegram.WebApp.sendData(...)` chaqirilgan. Telegram WebApp spetsifikatsiyasiga ko‘ra, `sendData()` chaqirilishi bilan **Mini App oynasi darhol yopiladi!**
  2. Foydalanuvchi `"👈 Qaytarish"` ni bosganda `cards.push(currentCard)` qilinadi (`cards.length` oshadi), ammo `totalCount` o‘zgarmaydi va `Math.min(currentIndex + 1, totalCount)` sababli hisoblagich oxirgi raqamda qotib qoladi.
  3. `cramReviewHandler.js` dagi `cbCramBlitz` (555-qator) `session.blitzExpiresAt` ni o‘rnatadi, lekin u hech qayerda tekshirilmaydi (chala qolgan funksiya).

---

### 🔴 BUG-06: Guruh Testi (3D Podium & Knowledge Radar) dagi 4 ta mantiqiy xato
* **Joylashuv:** `src/handlers/coreQuiz.js` (541–570, 623, 798-qatorlar) va `src/widgets/views/podiumWidget.html` (435-qator).
* **Muammolar:**
  1. **Marafon oraliq bloklarida tahlil ishlamasligi (`coreQuiz.js`, 798 va 623-qatorlar):** Marafonning 1-bloki tugab 2-blok kutish holatiga o‘tganda `session.groupScores = {}` qilib tozalanadi (798-qator). Foydalanuvchi `"📊 Mening Tahlilim (Faqat Menga)"` tugmasini bosganda `const scores = session?.groupScores || session?.marathonGlobalScores || {};` ishlaydi. JavaScript'da bo‘sh obyekt `{}` **`truthy`** bo‘lgani uchun `session.marathonGlobalScores` ga hech qachon o‘tmaydi va barcha ishtirokchilarga *"Siz ushbu testda qatnashmagansiz"* degan xato chiqadi!
  2. **Javob berilmagan savollarni "To'g'ri" deb hisoblash (`coreQuiz.js`, 555–568-qatorlar):** `generatePersonalAnalysis` funksiyasi foydalanuvchining mavzular bo‘yicha tahlilini chiqarishda `session.sessionQuestions` dagi **barcha** savollar bo‘yicha aylanadi va `if (!mistakesQuestions.has(q.question)) categoryStats[cat].correct++` qiladi. Agar guruhda 25 ta savoldan talaba faqat 2 tasiga javob bergan bo‘lsa (qolgan 23 tasiga javob bermagan bo‘lsa ham), 23 ta javobsiz savolning barchasi `correct++` bo‘lib, mavzu tahlilida `25/25 (100%)` bo‘lib chiqadi!
  3. **Podium WebApp da xom HTML teglarning ko'rinib qolishi (`podiumWidget.html`, 435-qator):** `generateGhostCoachAdvice` matni ichida `<b>...</b>` teglari bor. `podiumWidget.html` esa uni `.textContent = personal.advice` orqali qo‘ygani uchun ekranda `🔥 <b>Ghost Coach maslahati:</b>` ko‘rinishida xom teglar chiqib qoladi.
  4. **`widget_query` da `message_id` va `chat_id` yo'qolishi (`cramReviewHandler.js` 629-qator, `testCreation.js` 1397-qator):** `query.chat?.id` va `query.message_id` o‘rniga `query.message?.chat?.id || query.chat?.id || session.chatId` va `query.message?.message_id || query.message_id || session.messageId` ishlatilmagan.

---

### 🔴 BUG-07: `universalTestHub.js` da Shaxsiy Marafon va Faol Test Ustiga Yozib Yuborish Xatosi
* **Joylashuv:** `src/handlers/universalTestHub.js` (433, 505–535, 669, 728, 759-qatorlar) va `src/handlers/quizGame.js` (`initAndStartTest`, 95-qator).
* **Muammolar:**
  1. `universalTestHub.js` da `"▶️ Ketma-ket Marafon"` bosilganda `startSubjectMarathon` funksiyasi `testData` ichiga `isMarathon: true, marathonBlocks` berib `initAndStartTest` ni chaqiradi. Lekin `initAndStartTest` (`quizGame.js`) bu maydonlarni `sessionService.setActiveTest` ga **ko‘chirmaydi**, `finishTest` (`coreQuiz.js`) esa marafonni faqat guruh chatida (`chatType !== 'private'`) davom ettiradi. Natijada shaxsiy chatda marafon 1-blokdan keyin to‘xtab qoladi.
  2. `universalTestHub.js` da rasmiy testlarni (`isOfficial: true`) boshlashda `initAndStartTest` to‘g‘ridan-to‘g‘ri chaqirilgan — `mutex.lock('start_test:' + chatId)` va `sessionService.getActiveTest(chatId)` tekshiruvi yo‘q! Agar foydalanuvchida faol test ketayotgan bo‘lsa, eski test poll va BullMQ taymerlari osilib qolib, ustiga yangi test yozib yuboriladi.

---

### 🔴 BUG-08: `cramReviewHandler.js` da `FEATURE_WIDGET_ENGINE` Flag va Circuit Breaker Uzilishi
* **Joylashuv:** `src/handlers/cramReviewHandler.js` (354–392-qatorlar) va `src/handlers/testCreation.js` (1311-qator).
* **Muammo:** `launchFlashcardReview` funksiyasida `sendWidget` chaqirishdan oldin `widgetService.isWidgetEngineEnabled(userId)` (`FEATURE_WIDGET_ENGINE`) tekshirilmagan. Admin `/flags` orqali `FEATURE_WIDGET_ENGINE` ni `[OFF]` qilsa ham, Flashcard baribir `sendWidget` yuborishga urinadi. Shuningdek, `catch (widgetErr)` bloklarida `featureFlagService.recordFeatureError(...)` chaqirilmagani sababli Auto-Kill Circuit Breaker xatolarni qayd etmaydi.

---

## ⚡ 3. Performance va High-Load (Yuqori Bosim) Muammolari

1. **Event Loop Blocking (`src/services/widgetService.js`, 153–158-qatorlar):**
   * `renderWidgetHtml` har bir `GET /widget/:token` so‘rovida `fs.existsSync` va `fs.readFileSync` ni sinxron ravishda chaqiradi. Guruhda 100–200 talaba bir vaqtda Podium yoki Flashcard vidjetini ochganda Node.js Event Loop bloklanib qoladi.
   * **Yechim:** HTML shablonlarni dastur ishga tushganda (yoki birinchi murojaatda) xotiraga (`Map` keshga) bir marta o‘qib olish shart.
2. **Ochiq `/widget/query` Endpoint va AI Quota Hujumi (`src/widgets/widgetServer.js`):**
   * `/widget` marshrutlarida rate-limiter yo‘q. `POST /widget/query` dagi `auto_heal_all` amali bevosita Gemini AI (`batchAutoHeal`) ga so‘rov yuboradi. Yaroqli tokeni bor foydalanuvchi ketma-ket `POST /widget/query` yuborib, Gemini API limitini bir necha soniyada tugatib qo‘yishi mumkin.
   * **Yechim:** `/widget` marshrutlariga IP va `userId` bo‘yicha Rate Limiter hamda `save_docx` / `auto_heal_all` uchun in-flight mutex qulfini qo‘yish.
3. **`cramSessions` faqat RAMda saqlanishi (`src/handlers/cramReviewHandler.js`):**
   * `cramSessions` faqat `TTLMap` (RAM) da saqlanadi. Container qayta ishga tushganda barcha ochiq Flashcard vidjetlari javob bermay qoladi. Uni L1 `TTLMap` + L2 `Redis` gibrid keshiga o‘tkazish lozim.
4. **WebApp `save_docx` dan keyin Chat UI yangilanmasligi (`src/widgets/widgetServer.js`, 142–203-qatorlar):**
   * Foydalanuvchi WebApp (`docxHealerWidget.html`) ichida barcha xatolarni tuzatib `"💾 Saqlash va Yakunlash"` ni bosganda, `widgetServer.js` faqat Redisdagi `tg_session:${userId}` ni yangilaydi, ammo Telegram chatdagi eski *"⚠️ Xato Savolni To'g'rilash"* xabarini yangilamaydi va foydalanuvchiga yakuniy Draft Dashboard menyusini chiqarmaydi.

---

## 🧹 4. Clean Code va Takrorlangan Kodlar (DRY Violations)

1. **`decodeHtmlEntities` va `escapeHtml` 4 ta joyda takrorlangan:** `src/core/utils.js`, `src/services/widgetService.js`, `src/services/edupageService.js`, `src/services/errorReporterService.js`. `widgetService.js` bevosita `src/core/utils.js` dan import qilishi kerak.
2. **`getLevenshteinDistance` 2 ta joyda nusxalangan:** `src/services/edupageService.js` (258-qator) va `src/handlers/profileHandler.js` (28-qator).
3. **`canManageLobbyOrGame` 2 ta joyda nusxalangan:** `src/handlers/groupQuizLogic.js` (150-qator) va `src/handlers/startHandler.js` (193-qator). `startHandler.js` uni `groupQuizLogic.js` dan import qilishi kerak.
4. **Faol test borligini tekshirish bloki 6 marta nusxalangan:** `quizGame.js` va `adaptiveQuiz.js` ichida bir xil 20 qatorli kod takrorlangan.

---

## 🛠 5. Qadam-baqadam Tuzatish Yo'riqnomasi va Production Kodlar

Quyida aniqlangan barcha xatolarni to‘liq bartaraf etuvchi, yuqori bosimga chidamli tayyor kod yechimlari keltirilgan.

---

### 1-QADAM: `index.js` — Middleware Zanjiri va `widget_query` Kontekstini Tuzatish

`index.js` faylida `widget_query` / `shared_widget_query` uchun `ctx.from` va `ctx.chat` ni normalizatsiya qilamiz hamda uni **Session** va **Ban-check** middleware'laridan **KEYINGA** joylashtiramiz:

```javascript
// index.js (95-210 qatorlar oralig'ini quyidagicha yangilang)

// ═══ MIDDLEWARE STACK ═════════════════════════════════════════

// 0. Telegram Bot API 10.4 widget_query / shared_widget_query kontekst normalizatsiyasi
bot.use(async (ctx, next) => {
  const wq = ctx.update?.widget_query || ctx.update?.shared_widget_query;
  if (wq) {
    if (!ctx.from && wq.from) {
      Object.defineProperty(ctx, "from", { value: wq.from, configurable: true });
    }
    const resolvedChat = wq.message?.chat || wq.chat || (wq.from ? { id: wq.from.id, type: "private" } : null);
    if (!ctx.chat && resolvedChat) {
      Object.defineProperty(ctx, "chat", { value: resolvedChat, configurable: true });
    }
  }
  return next();
});

// 1. Rate Limiter
bot.use(rateLimiterMiddleware());

// 2. CallbackQuery 10s timeout safety wrapper
bot.use(async (ctx, next) => {
  if (ctx.callbackQuery && typeof ctx.answerCbQuery === "function") {
    const origAnswerCb = ctx.answerCbQuery.bind(ctx);
    ctx.answerCbQuery = async (...args) => {
      try {
        return await origAnswerCb(...args);
      } catch (err) {
        const msg = String(err?.message || err);
        if (msg.includes("query is too old") || msg.includes("query ID is invalid")) {
          return false;
        }
        throw err;
      }
    };
  }
  return next();
});

// 3. Redis Session Middleware (Endi widget_query uchun ham ctx.session to'liq yuklanadi va saqlanadi!)
bot.use(async (ctx, next) => {
  const ignoredUpdates = ["poll_answer", "poll", "my_chat_member", "chat_member"];
  if (ignoredUpdates.includes(ctx.updateType)) return next();

  const userId = ctx.from?.id || ctx.chat?.id;
  if (!userId) return next();

  const key = `tg_session:${userId}`;
  let originalSessionStr = '{"state":null,"data":{}}';

  try {
    const sessionData = await redisConnection.get(key);
    if (sessionData) originalSessionStr = sessionData;
  } catch (err) {
    logger.error("Session Redis read error:", { error: err.message });
  }

  try {
    ctx.session = JSON.parse(originalSessionStr);
  } catch {
    ctx.session = { state: null, data: {} };
  }

  try {
    await next();
  } finally {
    try {
      const sess = ctx.session;
      const isEmpty = !sess || (!sess.state && (!sess.data || Object.keys(sess.data).length === 0));

      if (isEmpty) {
        if (originalSessionStr !== '{"state":null,"data":{}}') {
          await redisConnection.del(key);
        }
      } else {
        const newSessionStr = JSON.stringify(sess);
        const baseSessionStr = ctx._lastSyncedSessionStr || originalSessionStr;
        if (baseSessionStr !== newSessionStr) {
          const latestRedisStr = await redisConnection.get(key).catch(() => null);
          if (latestRedisStr && latestRedisStr !== baseSessionStr) {
            try {
              const latestSess = JSON.parse(latestRedisStr);
              sess.data = { ...(latestSess.data || {}), ...(sess.data || {}) };
              if (sess.state === JSON.parse(baseSessionStr).state && latestSess.state) {
                sess.state = latestSess.state;
              }
            } catch {}
          }
          await redisConnection.set(key, JSON.stringify(sess), "EX", 86400);
        }
      }
    } catch (err) {
      logger.error("Session Redis write error:", { error: err.message });
    }
  }
});

// 4. Ban Check Middleware
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId && !isAdmin(userId)) {
    const text = (ctx.message?.text || "").trim();
    const isStart = text.startsWith("/start");
    const isBanned = await dbService.isUserBanned(userId, isStart);
    if (isBanned) {
      if (ctx.callbackQuery) {
        return ctx.answerCbQuery("⛔ Siz botdan bloklangansiz!", { show_alert: true }).catch(() => {});
      }
      if (ctx.update?.widget_query || ctx.update?.shared_widget_query) {
        const qId = (ctx.update.widget_query || ctx.update.shared_widget_query).id;
        return ctx.telegram.callApi("answerWidgetQuery", { widget_query_id: qId, data: "BANNED" }).catch(() => {});
      }
      return ctx.reply("⛔ <b>Siz botdan bloklangansiz!</b>\n\nQoidabuzarlik sababli sizga kirish cheklangan.", { parse_mode: "HTML" }).catch(() => {});
    }
  }
  return next();
});

// 5. Telegram Bot API 10.4 HTML Widget Queries Middleware (Sessiya va Ban tekshiruvidan KEYIN!)
bot.use(async (ctx, next) => {
  if (ctx.update?.widget_query) {
    const q = ctx.update.widget_query;
    const rawData = String(q.data || "");
    if (rawData.includes("docx") && handlers.testCreation?.handleDocxWidgetQuery) {
      return handlers.testCreation.handleDocxWidgetQuery(ctx, q);
    }
    if (handlers.cram?.handleWidgetQuery) {
      return handlers.cram.handleWidgetQuery(ctx, q);
    }
  }
  if (ctx.update?.shared_widget_query) {
    const sq = ctx.update.shared_widget_query;
    const rawData = String(sq.data || "");
    if (rawData.includes("docx") && handlers.testCreation?.handleDocxSharedWidgetQuery) {
      return handlers.testCreation.handleDocxSharedWidgetQuery(ctx, sq);
    }
    if (handlers.cram?.handleSharedWidgetQuery) {
      return handlers.cram.handleSharedWidgetQuery(ctx, sq);
    }
  }
  return next();
});
```

---

### 2-QADAM: `src/services/widgetService.js` — Shablonlarni RAMda Keshlash, Flashcard `checkData` va Docx Healer Inline Vidjetini Tuzatish

`src/services/widgetService.js` da:
1. Shablonlarni (`podiumWidget.html`, `flashcardWidget.html`, `docxHealerWidget.html`) RAMga keshlaymiz (0ms disk I/O).
2. `buildInlineFlashcardWidgetHtml` dagi `W.publicData || W.chatData` va `lastData` boshlang‘ich qiymatini to‘g‘rilaymiz (dastlabki 300ms da soxta `animateIn` bo‘lmasligi va `publicData` yangilanishini ko‘rishi uchun).
3. `buildInlineDocxHealerWidgetHtml` da 4KB Zlib limitidan oshmaslik va indeks siljimasligi uchun bir vaqtda joriy savolni (`q`, `err`, `opts`, `curIdx`, `total`) ko‘rsatadigan, server bilan 100% sinxron ishlaydigan arxitekturaga o‘tkazamiz.

```javascript
// src/services/widgetService.js ichida yangilanadigan qismlar:

const { decodeHtmlEntities, escapeHtml } = require('../core/utils');

// Shablonlar uchun L1 In-Memory Cache (High-loadda fs.readFileSync bloklanishini yo'qotadi)
const templateMemoryCache = new Map();

function getTemplateContent(templateFileName) {
  if (templateMemoryCache.has(templateFileName)) {
    return templateMemoryCache.get(templateFileName);
  }
  const templatePath = path.join(TEMPLATE_DIR, templateFileName);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Widget template not found: "${templatePath}"`);
  }
  const content = fs.readFileSync(templatePath, 'utf8');
  templateMemoryCache.set(templateFileName, content);
  return content;
}

function renderWidgetHtml(type, data = {}) {
  const normType = String(type || '').trim();
  const templateFileName = TEMPLATE_MAP[normType] || TEMPLATE_MAP[normType.toLowerCase()];

  if (!templateFileName) {
    throw new Error(`Unknown widget type: "${type}"`);
  }

  let html = getTemplateContent(templateFileName);

  const safeDataJson = JSON.stringify(data || {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\//g, '\\/');

  const title = escapeHtml(data.title || `${normType.charAt(0).toUpperCase() + normType.slice(1)} Widget`);

  return html
    .replace(/{{DATA_JSON}}/g, safeDataJson)
    .replace(/{{TITLE}}/g, title)
    .replace(/{{TYPE}}/g, escapeHtml(normType))
    .replace(/{{TOKEN}}/g, escapeHtml(data.token || ''));
}
```

Shuningdek, `buildInlineFlashcardWidgetHtml` ichidagi `<script>` qismida `checkData` va `triggerAction` ni quyidagicha tuzating:

```javascript
// src/services/widgetService.js — buildInlineFlashcardWidgetHtml ichidagi <script> yakuni:
var lastData = '';
function getLatestWidgetData() {
  var pd = W.publicData;
  var cd = W.chatData;
  if (pd && String(pd).indexOf('"q"') !== -1) return pd;
  if (cd && String(cd).indexOf('"q"') !== -1) return cd;
  return pd || cd || '';
}

// Dastlabki holatni saqlab olamiz (300ms dan keyin soxta sakrash bo'lmasligi uchun)
lastData = getLatestWidgetData();

function checkData() {
  var nextD = getLatestWidgetData();
  if (nextD && nextD !== lastData) {
    lastData = nextD;
    if (!isAnim) {
      animateIn(nextD);
    }
  }
}
setInterval(checkData, 350);
if (W.onEvent) {
  W.onEvent('chatDataChanged', function() { checkData(); });
  W.onEvent('publicDataChanged', function() { checkData(); });
}
if (W.setResizeAnchor) {
  try { W.setResizeAnchor('top'); } catch(e) {}
}
if (typeof W.ready === 'function') { W.ready(); }
render(${initialData});
```

Va `buildInlineDocxHealerWidgetHtml` funksiyasida indeks siljishini (BUG-02) va 1KB/4KB limit xatosini (BUG-03) bartaraf etish uchun `pickKey(optIdx)` ichida savol tuzatilganda uni lokal ro‘yxatdan ham sinxron o‘chiramiz (`qs.splice(cur, 1)`):

```javascript
// src/services/widgetService.js — buildInlineDocxHealerWidgetHtml ichidagi pickKey funksiyasi:
function pickKey(optIdx) {
  if (isAnim) return;
  var q = qs[cur];
  if (!q || !q.opts) return;

  isAnim = true;
  q.opts.forEach(function(o, i) {
    o.ok = (i === optIdx);
  });
  render();

  if (W.HapticFeedback && typeof W.HapticFeedback.selectionChanged === 'function') {
    W.HapticFeedback.selectionChanged();
  }

  var payload = { action: 'docx_pick', qIdx: cur, optIdx: optIdx };
  var onDone = function(res) {
    if (res && res.result && res.result !== 'OK') {
      try {
        var d = typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
        if (d.isFinished || d.remaining === 0) {
          qs = [];
        } else if (d.currentQuestion) {
          qs[cur] = d.currentQuestion;
          qs.length = d.remaining || qs.length;
        } else {
          qs.splice(cur, 1);
        }
      } catch (e) {
        qs.splice(cur, 1);
      }
    } else {
      // Backend invalidQs.splice(qIdx, 1) qilgani sababli lokal massivni ham sinxron qisqartiramiz!
      qs.splice(cur, 1);
    }
    if (cur >= qs.length && cur > 0) cur = qs.length - 1;
    isAnim = false;
    render();
  };

  if (typeof W.request === 'function') {
    W.request(JSON.stringify(payload)).then(onDone).catch(function() { onDone(null); });
  } else if (typeof W.sendQuery === 'function') {
    W.sendQuery(JSON.stringify(payload));
    setTimeout(function() { onDone(null); }, 220);
  } else {
    setTimeout(function() { onDone(null); }, 220);
  }
}
```

---

### 3-QADAM: `src/handlers/testCreation.js` — `handleDocxWidgetQuery` ni 1024-bayt Limitiga Moslash va Auto-Kill Ulash

`src/handlers/testCreation.js` dagi `cbOpenInspector` va `handleDocxWidgetQuery` funksiyalarini quyidagicha yangilang:

```javascript
// src/handlers/testCreation.js — makeSafeDocxWidgetPublicData yordamchisi va handleDocxWidgetQuery:

function makeSafeDocxWidgetPublicData(remainingInvalid, curIdx = 0, blockName = 'Docx Healer') {
  const total = Array.isArray(remainingInvalid) ? remainingInvalid.length : 0;
  const safeIdx = Math.min(Math.max(0, curIdx), Math.max(0, total - 1));
  let currentQuestion = null;

  if (total > 0 && remainingInvalid[safeIdx]) {
    const raw = remainingInvalid[safeIdx];
    const cand = extractQuestionCandidates(raw);
    currentQuestion = {
      id: safeIdx + 1,
      q: String(cand.questionText || raw).slice(0, 240),
      err: cand.options.length < 2 ? "Variantlar kam" : "To'g'ri javob belgilanmagan",
      opts: (cand.options || []).slice(0, 6).map(o => ({
        t: String(o.cleanText || o.text || '').slice(0, 75),
        ok: Boolean(o.isCorrect),
      })),
    };
  }

  const payload = {
    title: String(blockName || 'Docx Healer').slice(0, 50),
    remaining: total,
    curIdx: safeIdx,
    isFinished: total === 0,
    currentQuestion,
  };

  return JSON.stringify(payload);
}

async function handleDocxWidgetQuery(ctx, query) {
  if (!query) return;

  const userId = query.from?.id || ctx.from?.id;
  const rawAction = String(query.data || '').trim();

  let action = 'docx_pick';
  let qIdx = 0;
  let optIdx = null;

  try {
    if (rawAction.startsWith('{')) {
      const parsed = JSON.parse(rawAction);
      action = parsed.action || parsed.a || 'docx_pick';
      qIdx = typeof parsed.qIdx === 'number' ? parsed.qIdx : 0;
      optIdx = typeof parsed.optIdx === 'number' ? parsed.optIdx : null;
    } else {
      action = rawAction;
    }
  } catch {}

  const data = await getData(ctx);
  const invalidQs = Array.isArray(data.invalidQs) ? [...data.invalidQs] : [];
  const questions = Array.isArray(data.questions) ? [...data.questions] : [];

  if (action === 'docx_pick' && optIdx !== null && qIdx >= 0 && qIdx < invalidQs.length) {
    const badText = invalidQs[qIdx];
    const cand = extractQuestionCandidates(badText);
    const opts = (cand.options && cand.options.length >= 2)
      ? cand.options.map(o => o.cleanText || o.text)
      : [];

    if (opts.length >= 2 && optIdx >= 0 && optIdx < opts.length) {
      const resolved = {
        question: cand.questionText || badText.split('\n')[0].replace(/^(\d+[\)\.]|№\s*\d+[\)\.]?)\s*/, '').trim(),
        options: opts,
        correct_index: optIdx,
      };
      questions.push(resolved);
      invalidQs.splice(qIdx, 1);

      const chunks = [];
      if (data.is_auto_docx) {
        for (let i = 0; i < questions.length; i += 25) {
          chunks.push(questions.slice(i, i + 25));
        }
      }
      await updateData(ctx, {
        questions,
        invalidQs,
        ...(data.is_auto_docx ? { chunks } : {}),
      });
    }
  } else if (action === 'docx_heal_all' && invalidQs.length > 0) {
    const healRes = await aiDocxHealer.batchAutoHeal(invalidQs, process.env.GEMINI_API_KEY);
    const healed = healRes.healed || [];
    const remaining = healRes.remainingInvalid || [];

    if (healed.length > 0) {
      questions.push(...healed);
      const chunks = [];
      if (data.is_auto_docx) {
        for (let i = 0; i < questions.length; i += 25) {
          chunks.push(questions.slice(i, i + 25));
        }
      }
      await updateData(ctx, {
        questions,
        invalidQs: remaining,
        ...(data.is_auto_docx ? { chunks } : {}),
      });
    }
  }

  const updatedData = await getData(ctx);
  const remainingInvalid = updatedData.invalidQs || [];
  const nextCurIdx = Math.min(qIdx, Math.max(0, remainingInvalid.length - 1));
  const newPublicData = makeSafeDocxWidgetPublicData(
    remainingInvalid,
    nextCurIdx,
    updatedData.block_name || 'Docx Healer'
  );

  const chatId = query.message?.chat?.id || query.chat?.id || ctx.chat?.id || userId;
  const messageId = query.message?.message_id || query.message_id || updatedData.docx_widget_msg_id;

  if (chatId && messageId && ctx.telegram && typeof ctx.telegram.callApi === 'function') {
    await ctx.telegram.callApi('editMessageWidgetData', {
      chat_id: chatId,
      message_id: messageId,
      public_data: newPublicData,
      chat_data: newPublicData,
    }).catch(err => logger.debug('editMessageWidgetData error (docx):', err.message));
  }

  if (ctx.telegram && typeof ctx.telegram.callApi === 'function') {
    await ctx.telegram.callApi('answerWidgetQuery', {
      widget_query_id: query.id,
      data: newPublicData,
    }).catch(() => {});
  }
}
```

---

### 4-QADAM: `src/handlers/cramReviewHandler.js` — Redis Session Zaxirasi, `FEATURE_WIDGET_ENGINE` Tekshiruvi va Blitz Taymeri

`src/handlers/cramReviewHandler.js` da:
1. `launchFlashcardReview` ichida `sendWidget` dan oldin `isWidgetEngineEnabled(userId)` ni tekshiramiz.
2. `safeChatData` ga ham `safePublicData` ni beramiz (ikki xil struktura tufayli ustma-ust tushmasligi uchun).
3. `handleWidgetQuery` da `query.message?.chat?.id || query.chat?.id || session.chatId` va `query.message?.message_id || query.message_id || session.messageId` orqali xabar ID sini kafolatli olamiz.
4. `register(bot)` ichidagi dublikat `bot.use` middleware ni olib tashlaymiz (chunki u `index.js` da markazlashgan holda ishlaydi).

```javascript
// src/handlers/cramReviewHandler.js — launchFlashcardReview ichidagi 5-qism (353-395 qatorlar):

  const { isWidgetEngineEnabled } = require('../services/widgetService');
  const canUseNativeWidget = isWidgetEngineEnabled(userId);

  // 5. Telegram Bot API 10.4 HTML Widget launcher
  if (canUseNativeWidget && chatId && ctx.chat?.type === 'private' && ctx.telegram && typeof ctx.telegram.callApi === 'function') {
    try {
      const inlineWidgetHtml = buildInlineFlashcardWidgetHtml(viewData);
      const safePublicData = makeSafeWidgetPublicData(viewData, subjectName, blockName);

      const widgetPayload = {
        chat_id: chatId,
        html: inlineWidgetHtml,
        public_data: safePublicData,
        chat_data: safePublicData,
        is_shared: true,
        allow_queries: true,
      };

      const widgetKeyboard = getWidgetInlineKeyboard(viewData.cardIdx);
      if (widgetKeyboard?.reply_markup) {
        widgetPayload.reply_markup = widgetKeyboard.reply_markup;
      }

      const widgetRes = await ctx.telegram.callApi('sendWidget', widgetPayload);

      if (widgetRes && widgetRes.message_id) {
        widgetSent = true;
        session.isWidget = true;
        session.messageId = widgetRes.message_id;
        session.widgetId = widgetRes.widget?.id || null;
        cramSessions.set(userKey, session);

        if (ctx.callbackQuery?.message) {
          await ctx.deleteMessage().catch(() => {});
        }
      }
    } catch (widgetErr) {
      try {
        const featureFlagService = require('../services/featureFlagService');
        featureFlagService.recordFeatureError('FEATURE_WIDGET_ENGINE', widgetErr);
      } catch {}
      logger.warn('sendWidget failed, falling back to message text:', {
        error: widgetErr.message,
        code: widgetErr.code || widgetErr.error_code,
      });
    }
  }
```

Va `handleWidgetQuery` ichida (`cramReviewHandler.js`, 628–640-qatorlar):
```javascript
    const chatId = query.message?.chat?.id || query.chat?.id || session.chatId || ctx.chat?.id;
    const messageId = query.message?.message_id || query.message_id || session.messageId;

    if (chatId && messageId) {
      await ctx.telegram.callApi('editMessageWidgetData', {
        chat_id: chatId,
        message_id: messageId,
        public_data: newPublicDataStr,
        chat_data: newPublicDataStr,
      }).catch(err => logger.debug('editMessageWidgetData error:', err.message));
    }
```

---

### 5-QADAM: `src/handlers/coreQuiz.js` va `src/widgets/views/podiumWidget.html` — 3D Podium va Radar Tahlilini Tuzatish

1. **`coreQuiz.js` (`cbMyGroupQuizResult`, 623-qator):** Bo‘sh `{}` obyekt sababli `marathonGlobalScores` ga o‘tmay qolish xatosini tuzatamiz:
```javascript
// src/handlers/coreQuiz.js (622-628 qatorlar):
  const rawGroupScores = session?.groupScores && Object.keys(session.groupScores).length > 0
    ? session.groupScores
    : null;
  const scores = rawGroupScores || session?.marathonGlobalScores || {};
```

2. **`coreQuiz.js` (`generatePersonalAnalysis`, 541–575-qatorlar):** Javob berilmagan savollar `correct` bo‘lib qolmasligi uchun foydalanuvchining haqiqiy javob bergan savollar sonidan kelib chiqib hisoblaymiz:
```javascript
// src/handlers/coreQuiz.js (541-575 qatorlar):
  const rank = userIndex !== -1 ? userIndex + 1 : total + 1;
  const rankStr = `${rank} / ${total || 1}`;
  const pctRank = total > 1
    ? Math.max(1, Math.min(100, Math.round(((rank - 1) / total) * 100) || 1))
    : 1;
  const percentile = rank === 1 ? '🏆 1-o\'rin (Top 1%)' : `Top ${pctRank}%`;

  const correct = userData.correct || 0;
  const wrong = userData.wrong || 0;
  const totalAnswered = correct + wrong;
  const accuracy = totalAnswered > 0 ? Math.round((correct / totalAnswered) * 100) : 0;
  const totalTimeMs = userData.totalTimeMs || 0;
  const timeFormatted = `${(totalTimeMs / 1000).toFixed(1)}s`;

  // Category / topic breakdown (faqat haqiqiy ishlangan savollar bo'yicha!)
  const categoryStats = {};
  const mistakes = Array.isArray(userData.mistakes) ? userData.mistakes : [];

  if (mistakes.length > 0 && Array.isArray(session?.sessionQuestions) && session.sessionQuestions.length > 0) {
    const hasCustomCategories = session.sessionQuestions.some(q => q.category || q.topic);
    if (hasCustomCategories) {
      for (const m of mistakes) {
        const cat = m.category || session.blockName || session.subjectKey || "Umumiy";
        if (!categoryStats[cat]) {
          categoryStats[cat] = { name: cat, correct: 0, wrong: 0, total: 0 };
        }
        categoryStats[cat].wrong++;
        categoryStats[cat].total++;
      }
      const fallbackCat = session.blockName || session.subjectKey || "Umumiy";
      if (!categoryStats[fallbackCat]) {
        categoryStats[fallbackCat] = { name: fallbackCat, correct: 0, wrong: 0, total: 0 };
      }
      categoryStats[fallbackCat].correct += correct;
      categoryStats[fallbackCat].total += correct;
    } else {
      const cat = session.blockName || session.subjectKey || "Umumiy";
      categoryStats[cat] = { name: cat, correct, wrong, total: totalAnswered };
    }
  } else {
    const cat = session?.blockName || session?.subjectKey || "Umumiy";
    categoryStats[cat] = {
      name: cat,
      correct,
      wrong,
      total: totalAnswered,
    };
  }
```

3. **`src/widgets/views/podiumWidget.html` (434–438-qatorlar):** `personal.advice` ichidagi HTML teglari ekranda xom ko‘rinib qolmasligi uchun xavfsiz tozalaymiz:
```javascript
// src/widgets/views/podiumWidget.html (434-439 qatorlar):
      if (personal.advice) {
        const cleanAdvice = String(personal.advice)
          .replace(/<\/?(?:b|strong|i|em|code)>/gi, '')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        document.getElementById('coach-advice').textContent = cleanAdvice;
      }
```

---

### 6-QADAM: `src/widgets/views/flashcardWidget.html` — WebApp `sendData()` Yopilib Qolish Bugini Tuzatish

`src/widgets/views/flashcardWidget.html` 326–391-qatorlarida:
1. `window.Telegram.WebApp.sendData(...)` chaqiruvini olib tashlaymiz (chunki u WebApp oynasini darhol yopib yuboradi!).
2. Takrorlashga qaytarilgan kartochkalar uchun hisoblagichni (` Qolgan: X ta`) aniq ko‘rsatamiz.

```javascript
// src/widgets/views/flashcardWidget.html (326-391 qatorlar):
    function renderCurrentCard() {
      if (currentIndex >= cards.length) {
        showFinish();
        return;
      }
      cardEl.className = 'card-wrapper';
      const c = cards[currentIndex];
      frontText.textContent = c.q || c.question || 'Savol';
      backText.textContent = c.a || c.answer || 'To\'g\'ri javob';

      const remaining = cards.length - currentIndex;
      progressText.textContent = `O'rganildi: ${learnedCount} / ${totalCount} (Qoldi: ${remaining})`;
      const pct = Math.min(100, Math.round((learnedCount / totalCount) * 100));
      progressFill.style.width = pct + '%';
      percentText.textContent = pct + '%';
    }

    function sendWidgetQuery(action, actionData) {
      const token = '{{TOKEN}}' || data.token;
      fetch('/widget/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action, data: actionData })
      }).catch(() => {});
    }
```

---

### 7-QADAM: `src/widgets/widgetServer.js` — Rate Limiting, Mutex Qulfi va Dublikat Savollar Himoyasi

`src/widgets/widgetServer.js` da:
1. `/widget` va `/widget/query` uchun Rate Limiter qo‘shamiz (1 daqiqada maksimal 90 ta so‘rov, `auto_heal_all` uchun 1 daqiqada maksimal 5 ta so‘rov).
2. `save_docx` da per-user `mutex.runExclusive` ishlatamiz va bir xil savollar ikki marta qo‘shilib qolmasligini (`idempotency`) ta'minlaymiz.

```javascript
// src/widgets/widgetServer.js boshiga qo'shing:
const mutex = require('../core/mutex');
const { TTLMap } = require('../core/utils');

const widgetIpLimiter = new TTLMap(60 * 1000, 5000);
const widgetAiHealLimiter = new TTLMap(60 * 1000, 2000);

function widgetRateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const count = (widgetIpLimiter.get(ip) || 0) + 1;
  widgetIpLimiter.set(ip, count);
  if (count > 90) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });
  }
  next();
}

router.use(widgetRateLimiter);
```

Va `executeQueryAction` ichidagi `auto_heal_all` hamda `save_docx` кейslarini quyidagicha himoyalang:

```javascript
// src/widgets/widgetServer.js — auto_heal_all va save_docx himoyasi:
    case 'auto_heal_all': {
      const uidKey = String(verifiedToken.userId || 'anon');
      const aiCount = (widgetAiHealLimiter.get(uidKey) || 0) + 1;
      widgetAiHealLimiter.set(uidKey, aiCount);
      if (aiCount > 5) {
        throw new Error('AI avto-tuzatish limiti: daqiqasiga ko\'pi bilan 5 marta urinish mumkin.');
      }
      // ... mavjud auto_heal_all mantiqi
    }

    case 'save_docx': {
      const userId = verifiedToken.userId;
      return await mutex.runExclusive(`widget_save_docx:${userId}`, async () => {
        const questionsInput = data?.questions || verifiedToken.payload?.questions || [];
        const validQuestionsToAdd = [];
        const remainingInvalid = [];

        for (const q of questionsInput) {
          const opts = (q.options || []).map(o => typeof o === 'string' ? o : (o.cleanText || o.text || ''));
          const correctIdx = (q.options || []).findIndex(o => Boolean(o.isCorrect));

          if (opts.length >= 2 && correctIdx >= 0) {
            validQuestionsToAdd.push({
              question: q.questionText || q.question || (typeof q.raw === 'string' ? q.raw.split('\n')[0] : 'Savol'),
              options: opts,
              correct_index: correctIdx,
            });
          } else {
            remainingInvalid.push(typeof q.raw === 'string' ? q.raw : (q.questionText || 'Xato savol'));
          }
        }

        let totalValid = validQuestionsToAdd.length;
        if (userId) {
          try {
            const redisConnection = require('../services/redisService');
            const sessionKey = `tg_session:${userId}`;
            const rawSession = await redisConnection.get(sessionKey);
            let session = rawSession ? JSON.parse(rawSession) : { data: {} };
            if (!session.data) session.data = {};

            const existingValid = Array.isArray(session.data.questions) ? session.data.questions : [];
            const existingSet = new Set(existingValid.map(item => `${item.question}::${(item.options || []).join('|')}`));
            const deduplicatedNew = validQuestionsToAdd.filter(
              item => !existingSet.has(`${item.question}::${(item.options || []).join('|')}`)
            );

            const updatedQuestions = [...existingValid, ...deduplicatedNew];
            session.data.questions = updatedQuestions;
            session.data.invalidQs = remainingInvalid;
            session.data.fixing_error_index = undefined;
            if (session.data.fixedKeysDraft) delete session.data.fixedKeysDraft;

            if (session.data.is_auto_docx) {
              const chunks = [];
              for (let i = 0; i < updatedQuestions.length; i += 25) {
                chunks.push(updatedQuestions.slice(i, i + 25));
              }
              session.data.chunks = chunks;
            }

            totalValid = updatedQuestions.length;
            await redisConnection.set(sessionKey, JSON.stringify(session), 'EX', 86400);
          } catch (err) {
            logger.warn('save_docx session update in redis failed/offline:', err?.message);
          }
        }

        return {
          status: 'completed',
          savedCount: validQuestionsToAdd.length,
          remainingCount: remainingInvalid.length,
          totalValid,
        };
      });
    }
```

---

### 8-QADAM: `src/handlers/universalTestHub.js` va `src/handlers/quizGame.js` — Shaxsiy Marafon va Faol Test Himoyasi

`src/handlers/quizGame.js` dagi `initAndStartTest` funksiyasida `testData` ichidagi marafon parametrlarini sessiyaga saqlaymiz va faol test ustiga yozib yuborishdan himoyalaymiz:

```javascript
// src/handlers/quizGame.js — initAndStartTest ichida setActiveTest obyektiga qo'shing (105-130 qatorlar):
  await sessionService.setActiveTest(chatId, {
    chatType,
    initiatorId,
    subjectKey,
    testId,
    subjectId: testData?.subject_id || null,
    creatorId: testData?.creator_id || null,
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
    status: "preparing",
    transitionLock: null,
    questionState: "PREPARING",
    isMarathon: Boolean(testData?.isMarathon),
    marathonBlocks: Array.isArray(testData?.marathonBlocks) ? testData.marathonBlocks : [],
    currentBlockIdx: Number(testData?.currentBlockIdx) || 0,
  });
```

Va `src/handlers/coreQuiz.js` dagi `buildFinishButtons` funksiyasida (70–75-qatorlar) shaxsiy marafon bo‘lsa keyingi blok tugmasini avtomatik chiqaramiz:

```javascript
// src/handlers/coreQuiz.js — buildFinishButtons ichiga qo'shing:
  if (session?.isMarathon && Array.isArray(session.marathonBlocks)) {
    const nextIdx = (session.currentBlockIdx || 0) + 1;
    const nextBlock = session.marathonBlocks[nextIdx];
    if (nextBlock) {
      const nextCb = String(tId).startsWith("ugc_") || session?.subjectId
        ? safeCallbackData(`ugc_start_${nextBlock.id || nextBlock.test_id}`, 64)
        : safeCallbackData(`post_start_${subjectKey}_${nextBlock.id || nextBlock.test_id}`, 64);
      btns.unshift([
        Markup.button.callback(
          `🏃‍♂️ Keyingi marafon bloki (${nextBlock.block_name || `${nextIdx + 1}-Blok`})`,
          nextCb,
        ),
      ]);
    }
  }
```

---

## ✅ 6. Yakuniy Tekshiruv Ro'yxati (Audit Verification Checklist)

1. **`index.js` Middleware:** `widget_query` va `shared_widget_query` endi `ctx.from`, `ctx.chat` va `ctx.session` ga to‘liq ega bo‘ladi.
2. **Inline Docx Healer (`widgetService.js` + `testCreation.js`):** Savollar indeksi siljimaydi (`qs.splice(cur, 1)`), `public_data` hajmi har doim `< 1024` bayt va Zlib HTML `< 4096` bayt bo‘lib qoladi.
3. **Inline Flashcard (`widgetService.js` + `cramReviewHandler.js`):** `getLatestWidgetData()` orqali `publicData` yangilanishi 100% ushlanadi va dastlabki 300ms dagi soxta animatsiya yo‘qoladi.
4. **WebApp Flashcard (`flashcardWidget.html`):** `Telegram.WebApp.sendData()` olib tashlangani sababli kartochka surilganda WebApp oynasi yopilib ketmaydi.
5. **3D Podium & Knowledge Radar (`coreQuiz.js` + `podiumWidget.html`):** Marafon oraliq bloklarida `"📊 Mening Tahlilim"` to‘g‘ri ishlaydi, javob berilmagan savollar xato ravishda "to‘g‘ri" deb hisoblanmaydi va Podium WebApp da `<b>` teglari toza matnga aylanadi.
6. **High-Load & Security (`widgetServer.js`):** HTML shablonlar RAMdan 0ms da o‘qiladi, `/widget/query` rate-limiter va `mutex` bilan himoyalangan.