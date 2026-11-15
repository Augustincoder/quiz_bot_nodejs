# 🏛 LOYIHA TO'LIQ SENIOR-LEVEL TEXNIK AUDITI VA AI UCHUN QAT'IY REFAKTORING QO'LLANMASI

**Loyiha:** `quiz-bot-nodejs` (Talabalar Imtihon Trenajyori — Node.js)  
**Qamrov:** 74 ta runtime fayl (36,277 qator kod, 1.23 MB) — 100% chuqur tahlil  
**Maqsad:** Loyihadagi barcha yashirin xatoliklar (broken logic), xotira va protsessor muammolari (performance/RAM bottlenecks), spagetti va takroriy kodlar (DRY violations), poyga holatlari (race conditions) hamda xavfsizlik zaifliklarini bartaraf etib, tizimni haqiqiy **Enterprise / Senior Production-Grade** darajasiga olib chiqish.

---

## 📊 1. AUDIT XULOSASI (EXECUTIVE SUMMARY)

Loyiha arxitekturasi yaxshi niyatda (Circuit Breaker, TTLMap, Mutex, BullMQ, Multi-tier Caching) qurilgan bo‘lsa-da, quyi qatlamlarda **jiddiy mantiqiy ziddiyatlar, poyga holatlari (race conditions), 3-4 martalab dublikat qilingan xizmatlar va Telegram API spetsifikatsiyasiga zid xatti-harakatlar** mavjud.

Eng xavfli topilmalar:
1. **Foydalanuvchini nohaq umrbod Ban qilish bugi (`userRepository.js` + `index.js`):** Botni vaqtincha to‘xtatgan (403 Forbidden) foydalanuvchilar bazada `is_banned = TRUE` qilib yozib qo‘yilmoqda. Ular botga qaytib `/start` bosganida tizim ularni *"Qoidabuzarlik sababli bloklangansiz"* deb botga kiritmaydi.
2. **Guruhda "Maxfiy (Ephemeral)" tahlilning hammaga oshkor bo‘lishi yoki qulashi (`coreQuiz.js`):** Telegram Bot API `sendMessage` metodida `ephemeral_message_parameters` degan parametr mavjud emas va guruh xabarlarida `web_app` inline tugmasini yuborish `400 Bad Request: BUTTON_TYPE_INVALID` xatosini beradi.
3. **WebApp Widget URL 2048 bayt limitidan oshib tugmaning g‘oyib bo‘lishi (`widgetService.js`):** Savollar massivi to‘g‘ridan-to‘g‘ri URL token ichiga joylangani sababli, 6-7 tadan ko‘p savol bo‘lganda URL 2048 baytdan oshib ketadi va `isValidWebAppUrl` funksiyasi WebApp tugmasini jimjitlik bilan o‘chirib tashlaydi.
4. **`TTLMap` ichida $O(N^2)$ CPU bloklanishi (`utils.js` + `loader.js`):** `TTLMap` to‘lganda har bir yangi `.set()` chaqiruvida barcha 2000 ta element bo‘ylab `.sweep()` sikli aylanadi. Bot yonganda `syncUserNames()` barcha foydalanuvchilarni yuklaganda Node.js Event Loop qotib qoladi.
5. **Socket.IO `JSON.stringify` qulashi (`src/socket/index.js`):** O‘yinchi uzilganda `player.disconnectTimer = setTimeout(...)` obyekti `player` ichiga yoziladi va `Array.from(room.players.values())` soket orqali yuborilganda Node.js `Timeout` obyektining halqasimon (circular) strukturasi sababli `TypeError: Converting circular structure to JSON` xatosi yuzaga keladi.

---

## 🔍 2. ENG QUYI QATLAMGACHA ANIQLANGAN MUAMMOLAR RO'YXATI

### 🔴 A. KRITIK MANTIQIY XATOLAR VA BROKEN LOGIC (PRODUCTION-BREAKING BUGS)

#### 1. `is_blocked` va `is_banned` ustunlarining qorishib ketishi (`src/repositories/userRepository.js:555-571` & `index.js:202-218`)
* **Muammo:** Foydalanuvchi botni bloklaganda (`403 Forbidden`), `workers.js`, `scheduleWatcherService.js` va `adminHandlers.js` `dbService.markUserBlocked(uid, true)` ni chaqiradi. `markUserBlocked` esa PostgreSQL da `UPDATE users SET is_banned = $1 WHERE telegram_id = $2` so‘rovini bajaradi! Foydalanuvchi keyinchalik botni blokdan chiqarib `/start` bossa, `index.js:206` dagi `dbService.isUserBanned(userId, true)` bazadan `is_banned = true` ni o‘qiydi va foydalanuvchiga `"⛔ Siz botdan bloklangansiz! Qoidabuzarlik sababli sizga kirish cheklangan"` deb javob qaytaradi!
* **Yechim:** `is_banned` (admin tomonidan qoidabuzarlik uchun bloklangan) va `is_blocked` (foydalanuvchi botni to‘xtatgan) holatlarini qat’iy ajratish. Agar foydalanuvchi `/start` bossa, uning `user_blocked:${uid}` keshini tozalash (`markUserBlocked(userId, false)`), lekin `markUserBlocked` hech qachon `is_banned` ustunini `TRUE` qilmasligi shart (`is_blocked` ustunini ishlatish yoki faqat Redis/L1 da saqlash).

#### 2. Guruh chatlarida har bir oddiy xabarga Redis/DB so‘rovlari va ommaviy Ban javobi (`index.js:131-218` & `src/core/rateLimiter.js:17-62`)
* **Muammo:** Bot guruhga qo‘shilganda, guruh a’zolarining o‘zaro yozishgan **har bir oddiy matnli xabari**:
  1. `rateLimiterMiddleware` dan o‘tadi (guruhda 1 soniyada 3 ta xabar yozgan odamga logda warning yozadi).
  2. Redis Session Middleware (`index.js:143`) dan o‘tib, har bir xabarga `redisConnection.get('tg_session:' + userId)` so‘rovini yuboradi (holbuki `index.js:353` da guruhdagi matnli xabarlar baribir `if (ctx.chat?.type !== "private") return next();` deb tashlab yuboriladi!).
  3. Ban Check Middleware (`index.js:206`) har bir guruh xabariga bazadan `isUserBanned` ni tekshiradi va agar foydalanuvchi ban bo‘lsa, guruh ichiga hammaga ko‘rinadigan qilib `"⛔ Siz botdan bloklangansiz!"` xabarini yuboradi!
* **Yechim:** Guruh va superguruhlarda (`ctx.chat?.type !== 'private'`) oddiy matnli xabarlar (agar ular `/` komanda bo‘lmasa) Session, RateLimiter va BanCheck middleware'laridan darhol `return next()` orqali o‘tkazib yuborilishi, ban bo‘lgan foydalanuvchining guruhdagi komandasiga esa guruhni spam qilmasdan jimjitlik bilan ignore qilinishi shart.

#### 3. Guruh testida "Shaxsiy Tahlil (Ephemeral)" funksiyasining buzilganligi (`src/handlers/coreQuiz.js:647-720`)
* **Muammo:** `cbMyGroupQuizResult` ichida `ctx.telegram.sendMessage(chatId, analysis.text, { ephemeral_message_parameters: { target_user_id: userId }, reply_markup })` chaqirilgan.
  1. Standart Telegram Bot API da guruhga faqat bitta odamga ko‘rinadigan xabar yuboruvchi `ephemeral_message_parameters` mavjud emas.
  2. `replyMarkup` ichida `web_app: { url: ... }` tugmasi bor. Telegram Bot API guruh ichiga `web_app` tugmali xabar yuborishni taqiqlaydi (`400 Bad Request: BUTTON_TYPE_INVALID`). Natijada `try` bloki har doim xatoga tushib, `catch` blokidagi 195 belgili qisqa popup (`answerCbQuery`) ga tushib qoladi!
* **Yechim:** Guruhda `"📊 Mening Tahlilim"` tugmasi bosilganda, to‘liq tahlil va `web_app` (3D Radar & Shohsupa) tugmasini **foydalanuvchining shaxsiy chatiga (DM)** `ctx.telegram.sendMessage(userId, analysis.text, ...)` orqali yuborish va guruhda `ctx.answerCbQuery("📊 Batafsil tahlil va 3D Shohsupa shaxsiy xabaringizga (lichkaga) yuborildi!", { show_alert: false })` ko‘rsatish. Agar foydalanuvchi botga `/start` bosmagan bo‘lsa (403 xato bersa), `answerCbQuery` orqali qisqa natijani alert sifatida ko‘rsatib, bot lichkasiga o‘tishni so‘rash.

#### 4. Socket.IO `player.disconnectTimer` Circular JSON halokati (`src/socket/index.js:200-232`)
* **Muammo:** Foydalanuvchi soketdan uzilganda `player.disconnectTimer = setTimeout(...)` obyekti bevosita `player` obyektiga biriktiriladi. Shu qatorning o‘zidayoq `io.to(room.roomCode).emit("room:player_disconnected", { userId, players: Array.from(room.players.values()) })` chaqiriladi. Node.js da `setTimeout` qaytaradigan `Timeout` obyekti o‘z ichida `_idleNext` va `_idlePrev` halqasimon (circular) referenslarni saqlaydi. Socket.IO buni `JSON.stringify` qilaman deganda `TypeError: Converting circular structure to JSON` xatosi bilan qulaydi!
* **Yechim:** Taymerlarni hech qachon serializatsiya qilinadigan `player` obyekti ichida saqlamaslik yoki yuborishdan oldin `sanitizePlayersForEmit(room)` funksiyasi orqali faqat `{ userId, displayName, score, disconnected }` maydonlarini ajratib olish.

#### 5. BullMQ Timer Job ID formatlarining har xilligi (`coreQuiz.js`, `startHandler.js`, `quizGame.js`)
* **Muammo:**
  - `src/handlers/coreQuiz.js:438` taymerni `timeout_${chatId}_${session.qIdx}_${msg.poll.id}` ID bilan yaratadi.
  - `src/handlers/startHandler.js:55`, `src/handlers/quizGame.js:487` va `quizGame.js:567` esa uni o‘chirish uchun `timeout:${chatId}:${session.qIdx}` (ikki nuqta bilan va `pollId` siz) qidiradi! Natijada eski taymer o‘chmay qolishi mumkin.
* **Yechim:** Taymerni bekor qilishni faqat bitta markazlashgan `cancelSessionTimer(session, chatId)` funksiyasiga topshirish va barcha joydan bevosita `quizTimerQueue.getJob('timeout:...')` chaqiruvlarini olib tashlash.

#### 6. `aiDocxHealer.js:346-386` da savollarning yo‘qolib ketishi (Data Loss)
* **Muammo:** `batchAutoHeal` funksiyasi barcha qolgan xato savollarni bitta promptda Gemini AI ga yuboradi. Agar 50 ta xato savol yuborilib, AI token limiti sababli faqat 10 tasini JSON qilib qaytarsa, 382-qatordagi `remainingInvalid.length = 0;` kodi qolgan **40 ta savolni butunlay o‘chirib yuboradi**!
* **Yechim:** `textsToFix` ni 10 tadan qilib bo‘laklarga (chunk) bo‘lish va AI nechta savol qaytargan bo‘lsa, faqat o‘shalarni `healed` ga o‘tkazib, qaytarilmaganlarini `remainingInvalid` ichida saqlab qolish.

#### 7. Markdown v1 va HTML teglarining qorishib ketishi (`aiGenerationFlow.js`, `wizardFlow.js`, `docxImportFlow.js`, `aiHandlers.js`)
* **Muammo:** `AI_WARNING_TEXT` ichida `<b>` va `<i>` HTML teglari ishlatilgan (`src/handlers/testCreation/aiGenerationFlow.js:16`), ammo `cbAiModeQuestions` (70-qator) uni `parse_mode: "Markdown"` bilan yuboradi! Bundan tashqari, `wizardFlow.js`, `docxImportFlow.js`, `questionEditor.js` va `aiHandlers.js` da eski `parse_mode: "Markdown"` ishlatilgan — foydalanuvchi matnida yoki fayl nomida `_` yoki `*` bo‘lsa, Telegram `400 Bad Request: can't parse entities` xatosini beradi.
* **Yechim:** Barcha handlerlarda legacy `Markdown` rejimidan 100% voz kechib, yagona va xavfsiz `parse_mode: "HTML"` hamda `escapeHtml()` standartiga o‘tish.

---

### 🟠 B. PERFORMANCE, XOTIRA (RAM 512MB) VA EVENT-LOOP MUAMMOLARI

#### 1. `TTLMap.set()` ichidagi $O(N)$ qotish va `syncUserNames()` startup muammosi (`src/core/utils.js:16-26` & `src/core/loader.js:97-110`)
* **Muammo:**
  ```js
  } else if (this._map.size >= this._maxSize) {
    this.sweep();
    if (this._map.size >= this._maxSize) {
      const oldestKey = this._map.keys().next().value;
      if (oldestKey !== undefined) this._map.delete(oldestKey);
    }
  }
  ```
  Kesh to‘lganda (`_maxSize = 2000`) va ichidagi elementlarning muddati hali tugamagan bo‘lsa, **har bir yangi `.set()` chaqiruvida** `this.sweep()` 2000 ta elementni birma-bir tekshirib chiqadi! `loader.js` dagi `syncUserNames()` bazadan barcha foydalanuvchilarni `LIMIT` siz tortib kelib loopda `userNameCache.set()` qilganda $O(N \times M)$ operatsiya bajarilib, Event Loop qotadi.
* **Yechim:**
  1. `TTLMap.set()` da `this.sweep()` ni har safar emas, faqat oxirgi sweepdan beri kamida 60 soniya o‘tgan bo‘lsa (`now - this._lastSweepAt > 60000`) chaqirish, aks holda darhol $O(1)$ tezlikda `this._map.keys().next().value` (FIFO/LRU) kalitni o‘chirish!
  2. `TTLMap.get()` da element o‘qilganda uni Map oxiriga o‘tkazish (haqiqiy $O(1)$ LRU algoritmi).
  3. `userRepository.getAllUserNames()` ga `ORDER BY updated_at DESC LIMIT 2000` qo‘yish.

#### 2. `timetableCdnService.js:384` — "Concurrency = 1" deb yozilgan kodning 3 ta og‘ir Sharp PNG renderini parallel bajarishi
* **Muammo:** `prewarmAllTimetables` funksiyasida `await Promise.all(ALL_THEMES.map(async (theme) => ...))` ishlatilgan. Bu bitta guruhning 3 ta mavzusini (`dark`, `light`, `vibrant`) bir vaqtda generatsiya qiladi va Telegram kanalga bir vaqtning o‘zida 3 ta rasm yuklaydi (Telegram 429 Rate Limit va RAM spike keltirib chiqaradi).
* **Yechim:** `Promise.all` o‘rniga qat’iy `for (const theme of ALL_THEMES)` ketma-ketlik siklini ishlatish va har bir yuklash orasida `delayMs` kutish.

#### 3. `cbAdminStats` va `getAllUserStats` da butun `user_stats` jadvalining (`history` JSONB bilan birga) RAMga yuklanishi (`src/handlers/adminHandlers.js:662` & `src/repositories/userRepository.js:258`)
* **Muammo:** Admin `"📈 Batafsil stat."` tugmasini bosganda, `dbService.getAllUserStats()` PostgreSQL dagi `user_stats` jadvalidan barcha qatorlarni va ularning ulkan `history` JSONB massivlarini Node.js xotirasiga tortib keladi. 512MB RAM konteynerda (`--max-old-space-size=300`) bu darhol Out-Of-Memory (SIGKILL 137) ga olib keladi.
* **Yechim:** Fanlar bo‘yicha va faollik statistikasini PostgreSQL ning o‘zida (`jsonb_array_elements` SQL agregatsiyasi bilan) hisoblash yoki bazadan sahifalab (cursor/pagination) o‘qish.

#### 4. `adminHandlers.js:825` (`cbBroadcastConfirm`) — Ommaviy xabarning asosiy oqimda (in-process loop) yuborilishi
* **Muammo:** Loyihada BullMQ (`broadcastQueue`) bor bo‘lsa-da, admin paneldagi ommaviy xabar yuborish (`cbBroadcastConfirm`) BullMQ dan foydalanmasdan, to‘g‘ridan-to‘g‘ri handler ichida `for` sikli orqali minglab foydalanuvchilarga xabar yuboradi.
* **Yechim:** Matnli ommaviy xabarlarni `broadcastQueue` orqali paketlab (`batch-broadcast`) yuborish yoki jarayonni xavfsiz background job sifatida boshqarish.

#### 5. `timetableIndexer.js:318` va `loader.js:39` — Sinxron Fayl Tizimi (`fs.readFileSync`) blokirovkasi
* **Muammo:** `getCachedIndexedDatabaseSync()` funksiyasida `l1IndexedDatabase` bo‘sh bo‘lsa, 5-10 MB hajmli `timetable_cache.json` fayli `fs.readFileSync` orqali sinxron o‘qiladi va JSON parse qilinadi. Bu vaqtda botning barcha foydalanuvchilari va taymerlari 300-800ms ga muzlab qoladi.
* **Yechim:** Bot ishga tushishi (`main()`) vaqtida L1 keshni asinxron (`fs.promises.readFile`) yuklab qo‘yish, runtime da esa sinxron `readFileSync` chaqiruvini cheklash.

---

### 🛡️ C. XAVFSIZLIK (SECURITY) VA DATA INTEGRITY MUAMMOLARI

#### 1. `widgetService.js:218` — `.replace(/{{DATA_JSON}}/g, safeDataJson)` dagi `$` Pattern Injection va XSS/Syntax Buzilishi
* **Muammo:** JavaScriptda `String.prototype.replace(regex, replacementStr)` ikkinchi argumentdagi `$&`, `$'`, `` $` ``, `$$` belgilarini maxsus buyruq sifatida talqin qiladi! Agar test savoli ichida `$` belgisi bo‘lsa (masalan, Iqtisodiyot fanida `"$100 va $' qiymat"`), `.replace(/{{DATA_JSON}}/g, safeDataJson)` HTML shablonning qolgan qismini JSON ichiga nusxalab yuboradi va JavaScript sintaksisini sindiradi!
* **Yechim:** `.replace()` ning ikkinchi argumentiga har doim funksiya berish:
  ```js
  html = html
    .replace(/\{\{DATA_JSON\}\}/g, () => safeDataJson)
    .replace(/\{\{TITLE\}\}/g, () => title)
    .replace(/\{\{TYPE\}\}/g, () => escapeHtml(normType))
    .replace(/\{\{TOKEN\}\}/g, () => escapeHtml(data.token || ''));
  ```

#### 2. `widgetService.js:183-260` — Katta Payload tufayli URL Tokenning 2048 baytdan oshib ketishi
* **Muammo:** `buildWidgetMessage` funksiyasi savollar massivini (`payload`) to‘liq holda URL token ichiga (`<base64url>.<hmac>`) joylaydi. Savollar soni 6-7 tadan oshganda URL uzunligi 2048 baytdan oshadi va `isValidWebAppUrl()` `false` qaytarib, WebApp tugmasini o‘chirib yuboradi!
* **Yechim:** `widgetService.js` ichida katta payloadlarni server xotirasida (`TTLMap` + Redis `widget_data:${sid}`) saqlab, URL token ichiga faqat kichik identifikatorni (`sid`) joylash. Shunda URL uzunligi har doim ~160 bayt bo‘ladi va hech qachon 2048 bayt limitiga urilmaydi!

#### 3. `postgres.js:29-48` va `89-103` — `withTransaction` ning CircuitBreaker'ni chetlab o‘tishi va Query Timeout yo‘qligi
* **Muammo:**
  1. `DATABASE_URL` bo‘lmasa ham `pool = new Pool(...)` yaratib qo‘yilgan.
  2. `withTransaction` funksiyasi `isPostgresAvailable()` ni tekshirmaydi va xatoliklarni `postgresBreaker` ga yozmaydi.
  3. `Pool` konfiguratsiyasida `query_timeout` va `statement_timeout` yo‘q — osilib qolgan so‘rovlar ulanishlar hovuzini (pool) to‘ldirib qo‘yadi.
* **Yechim:** `DATABASE_URL` bo‘lmasa `pool = null` qilish; `Pool` ga `query_timeout: 10000, statement_timeout: 10000` qo‘shish; `withTransaction` ichida `postgresBreaker` ni to‘liq integratsiya qilish.

---

### 🍝 D. SPAGETTI KODLAR, DUBLIKATSIYALAR VA KICHIK BUGLAR

1. **4 ta joyda tarqoq va bir-biriga zid AI Rate Limiterlar:**
   - `src/services/aiRateLimiter.js` (Markaziy Redis + L1 xizmati — **lekin hech qaysi handler `checkUserLimit` ni undan chaqirmaydi!**)
   - `src/services/aiService.js` (Ichki `aiServiceUsage`)
   - `src/handlers/aiHandlers.js` (Dublikat `userRateLimit`, `dailyUsage`, `monthlyUsage`)
   - `src/handlers/aiTestsHandlers.js` (Dublikat `adminAIUsage`, `checkAdminAILimit`)
   - *Bundan tashqari:* `aiGenerationFlow.js`, `adaptiveQuiz.js`, `universalTestHub.js` va `quizGame.js` (`cbAiExplainMistakes`) da foydalanuvchi limiti umuman tekshirilmaydi!
2. **Dublikat `parseSuffix` va `onContactMessage`:**
   - `contactAdmin.js:765` da `parseSuffix` qayta yozilgan (holbuki `utils.js` da bor).
   - `adminHandlers.js:1164-1220` da `cbCancelContact` va `onContactMessage` eski holatda qolib ketgan (`contactAdmin.js` bilan dublikat).
3. **`contactAdmin.js:592` (`cbCancelUserTest`) da noto‘g‘ri maydon nomlari:**
   - `session.subject` o‘rniga `session.subjectKey`, `session.currentQuestion` o‘rniga `(session.qIdx || 0) + 1`, `session.totalQuestions` o‘rniga `(session.sessionQuestions || []).length` bo‘lishi kerak.
4. **Mavjud bo‘lmagan fayllarni o‘qishga urinish (`widgetService.js:319, 366`):**
   - `getTemplateContent('inlineFlashcard.html')` va `getTemplateContent('inlineDocxHealer.html')` chaqiriladi, bunday fayllar esa `src/widgets/views/` ichida yo‘q. Har safar `Error` otib `catch` ga tushadi.

---

## 🤖 3. AI KODLASH AGENTI UCHUN QAT'IY BAJARISH QO'LLANMASI (STRICT EXECUTION PROMPT)

> **AI AGENT UCHUN KO'RSATMA:** Quyidagi 10 ta fazani qat’iy ketma-ketlikda bajaring. Har bir faylni tahrirlashda mavjud eksport nomlari (`module.exports`) va backward-compatibility (testlar bilan moslik) 100% saqlanishi shart. Hech qanday "placeholder" yoki chala kod qoldirmang.

---

### 🔹 1-FAZA: Ma'lumotlar Bazasi va Xotira Mag'zini Mustahkamlash (`src/lib/postgres.js`, `src/core/utils.js`, `src/services/redisService.js`)

#### 1.1. `src/lib/postgres.js` ni tuzatish:
- **Muammo:** `!databaseUrl` bo‘lganda ham `new Pool()` yaratilmoqda, `query_timeout` yo‘q, `withTransaction` esa `postgresBreaker` dan foydalanmaydi.
- **Amal:**
  1. `!databaseUrl` bo‘lganda `pool = null` qoldiring (soxta `new Pool()` yaratmang).
  2. `Pool` konfiguratsiyasiga `query_timeout: 10000`, `statement_timeout: 10000`, `keepAlive: true` qo‘shing.
  3. `withTransaction(callback)` funksiyasini quyidagicha yangilang:
     ```js
     async function withTransaction(callback) {
       if (!pool || !databaseUrl) {
         throw new Error('PostgreSQL pool is not initialized');
       }
       if (!postgresBreaker.canAttempt()) {
         throw new Error('CircuitBreaker:postgres is OPEN (PostgreSQL temporarily unavailable)');
       }
       const client = await pool.connect();
       try {
         await client.query('BEGIN');
         const result = await callback(client);
         await client.query('COMMIT');
         postgresBreaker.recordSuccess();
         return result;
       } catch (err) {
         await client.query('ROLLBACK').catch(() => {});
         postgresBreaker.recordFailure(err);
         throw err;
       } finally {
         client.release();
       }
     }
     ```

#### 1.2. `src/core/utils.js` ichidagi `TTLMap` va `updateData` ni optimallashtirish:
- **Muammo:** `TTLMap.set()` to‘lganda har bir qo‘shishda $O(N)$ `this.sweep()` chaqiradi.
- **Amal:**
  1. `TTLMap` konstruktoriga `this._lastSweepAt = Date.now();` qo‘shing.
  2. `TTLMap.set(key, value)` va `TTLMap.get(key)` ni $O(1)$ LRU + throttled sweep shakliga o‘tkazing:
     ```js
     set(key, value) {
       const now = Date.now();
       if (this._map.has(key)) {
         this._map.delete(key);
       } else if (this._map.size >= this._maxSize) {
         if (now - this._lastSweepAt > 60000) {
           this.sweep(now);
         }
         if (this._map.size >= this._maxSize) {
           const oldestKey = this._map.keys().next().value;
           if (oldestKey !== undefined) this._map.delete(oldestKey);
         }
       }
       this._map.set(key, { value, expiresAt: now + this._ttl });
     }
     get(key) {
       const entry = this._map.get(key);
       if (!entry) return undefined;
       if (Date.now() > entry.expiresAt) {
         this._map.delete(key);
         return undefined;
       }
       // Refresh LRU order in O(1)
       this._map.delete(key);
       this._map.set(key, entry);
       return entry.value;
     }
     sweep(now = Date.now()) {
       this._lastSweepAt = now;
       for (const [k, entry] of this._map.entries()) {
         if (now > entry.expiresAt) this._map.delete(k);
       }
     }
     ```
  3. `setState(ctx, stateName)` va `clearState(ctx)` funksiyalarida `ctx.session` o‘zgarganda `ctx._sessionDirty = true` belgisini qo‘ying.

#### 1.3. `src/services/redisService.js` (Dummy Redis To‘liqligi):
- **Muammo:** `REDIS_URL` bo‘lmaganda `dummy` obyektda `.pipeline()`, `.multi()`, `.ttl()` metodlari yo‘q va `inMemoryStore` cheksiz o‘sadi.
- **Amal:**
  1. `inMemoryStore` hajmi `5000` dan oshganda eng eski kalitni o‘chirish himoyasini qo‘shing.
  2. `dummy.ttl = async (k) => 3600;` hamda `dummy.pipeline` / `dummy.multi` zanjirli (chainable) metodlarini qo‘shing (`get`, `set`, `del`, `incr`, `pexpire`, `exec` metodlarini qo‘llab-quvvatlaydigan qilib).

---

### 🔹 2-FAZA: Middleware Stack, Ban vs Block Ajratilishi va Repository Optimizatsiyasi (`index.js`, `src/core/rateLimiter.js`, `src/repositories/userRepository.js`, `src/repositories/testRepository.js`, `src/core/loader.js`)

#### 2.1. `src/repositories/userRepository.js` da `markUserBlocked` bugini tuzatish:
- **Muammo:** `markUserBlocked` PostgreSQL da `is_banned = TRUE` qilib yubormoqda, natijada botni blokdan chiqarib `/start` bosgan foydalanuvchi umrbod "Qoidabuzarlik uchun ban bo‘ldingiz" xabarini oladi.
- **Amal:**
  1. `markUserBlocked(userId, isBlocked = true)` ichidagi:
     `await pgQuery('UPDATE users SET is_banned = $1 WHERE telegram_id = $2', [isBlocked, uid])`
     qatorini **OLIB TASHLANG**! `is_banned` faqat `banUser` va `unbanUser` tomonidan boshqarilishi shart!
  2. `markUserBlocked` faqat `localBlockedUsers` va Redis `user_blocked:${uid}` kalitini yangilasin.
  3. `registerUser(userId, fullName, username)` yoki `/start` bosilganda, agar foydalanuvchi botga qayta yozgan bo‘lsa, `localBlockedUsers.delete(uid)` va `redis.del('user_blocked:' + uid)` orqali uning "botni bloklagan" statusini avtomatik tozalang.
  4. `getAllUserNames()` so‘roviga `LIMIT 2000` qo‘shing (`SELECT telegram_id, full_name FROM users ORDER BY created_at DESC LIMIT 2000`).

#### 2.2. `index.js` va `src/core/rateLimiter.js` da Guruh Xabarlarini Filtrlash:
- **Muammo:** Guruhda talabalar oddiy suhbatlashganda har bir xabar Redis Session, RateLimiter va BanCheck middleware'larini ishga tushiradi va ban bo‘lgan odam guruhda oddiy gap yozsa ham bot guruhga javob qaytaradi.
- **Amal:**
  1. `index.js` dagi **1. Rate Limiter**, **3. Redis Session Middleware** va **4. Ban Check Middleware** ichida:
     Agar `ctx.chat?.type !== 'private'` bo‘lsa va xabar komanda (`text.startsWith('/')`) hamda `callback_query` / `poll_answer` / `widget_query` bo‘lmasa, hech qanday Redis/DB so‘rovi yubormasdan darhol `return next();` qiling!
  2. **4. Ban Check Middleware** (`index.js:202-218`) ichida:
     Agar `isStart` bo‘lsa, avval `dbService.markUserBlocked(userId, false).catch(() => {})` chaqirilsin.
     Agar `isBanned` bo‘lsa va `ctx.chat?.type !== 'private'` bo‘lsa, guruh chatiga `"⛔ Siz botdan bloklangansiz!"` deb javob yozmang (`if (ctx.callbackQuery) return ctx.answerCbQuery(...); return;`).

#### 2.3. `src/core/loader.js` da Asinxron Fayl O‘qish:
- **Muammo:** `loadAllTests()` ichida `fs.existsSync`, `fs.readdirSync`, `fs.readFileSync` ishlatilgan.
- **Amal:** `fs.promises.readdir` va `fs.promises.readFile` ga o‘tkazing.

---

### 🔹 3-FAZA: AI Rate Limiterlarni Yagona Markazga Birlashtirish va Timeout Himoyasi (`src/services/aiRateLimiter.js`, `src/services/aiService.js`, `src/handlers/aiHandlers.js`, `src/handlers/aiTestsHandlers.js`, `src/handlers/testCreation/aiGenerationFlow.js`, `src/handlers/adaptiveQuiz.js`, `src/handlers/universalTestHub.js`, `src/handlers/quizGame.js`)

#### 3.1. `src/services/aiService.js` va `src/services/aiDocxHealer.js` ni mustahkamlash:
- **Amal:**
  1. `src/services/aiService.js` ichida Gemini API chaqiruvlari uchun 45 soniyalik timeout wrapper (`withAiTimeout(promise, 45000)`) qo‘shing.
  2. `aiRateLimiter.recordUserUsage('system_global')` ni so‘rovdan oldin emas, faqat Gemini javobi muvaffaqiyatli qaytgandan keyin (`incrementAIUsage` ichida) chaqiring.
  3. `src/services/aiDocxHealer.js` dagi `batchAutoHeal` funksiyasida:
     - `remainingInvalid` massivini ko‘pi bilan 15 tadan bo‘laklarga (batch) bo‘lib ishlang.
     - Agar Gemini javobi qisman qaytsa yoki xato bersa, `remainingInvalid.length = 0` qilib yubormasdan, faqat haqiqatda tuzatilgan savollar soniga mos kelgan qismini tozalang (`if (parsed.length >= textsToFix.length) { remainingInvalid.length = 0; }`).

#### 3.2. `src/handlers/aiHandlers.js` va `src/handlers/aiTestsHandlers.js` dagi dublikat kodlarni tozalash:
- **Amal:**
  1. `src/handlers/aiHandlers.js` ichidagi dublikat `userRateLimit`, `checkUserLimit` funksiyalarini `src/services/aiRateLimiter.js` dagi `await aiRateLimiter.checkUserLimit(userId, isPremium, isAdminUser)` va `await aiRateLimiter.recordUserUsage(userId)` bilan bog‘lang. Limitni faqat AI muvaffaqiyatli javob qaytarganda kamaytiring!
  2. `src/handlers/aiTestsHandlers.js` ichidagi dublikat `adminAIUsage` ni `src/services/aiRateLimiter.js` bilan sinxronlang hamda `onAiTestsImage`, `onAiTestsAdaptiveCount` funksiyalariga ham `activeAdminAiUsers` concurrency qulfini qo‘shing (hozirda faqat `onAiTestsText` va `cbAiTestsRegenerate` da bor, `onAiTestsImage` va `onAiTestsAdaptiveCount` da qolib ketgan!).
  3. `src/handlers/testCreation/aiGenerationFlow.js` (`onAiTextInput`, `onAiQuestionsInput`, `onAiImageInput`) hamda `src/handlers/quizGame.js` (`cbAiExplainMistakes`) ichiga `aiRateLimiter.checkUserLimit(ctx.from.id, false, isAdmin(ctx.from.id))` tekshiruvini qo‘shing.

---

### 🔹 4-FAZA: Quiz Engine, Guruh Podiumi va Marafon Poyga Holatlarini Tuzatish (`src/handlers/coreQuiz.js`, `src/handlers/quizGame.js`, `src/handlers/startHandler.js`, `src/handlers/groupQuizLogic.js`)

#### 4.1. `src/handlers/coreQuiz.js` dagi `cbMyGroupQuizResult` ni to‘g‘rilash:
- **Muammo:** Guruh ichiga `web_app` tugmali va soxta `ephemeral_message_parameters` li xabar yuborishga urinish.
- **Amal:**
  1. Agar `ctx.chat?.type !== 'private'` bo‘lsa:
     Avvalo foydalanuvchining shaxsiy chatiga (`userId`) `ctx.telegram.sendMessage(userId, analysis.text, { parse_mode: "HTML", reply_markup: replyMarkup })` yuboring va `await ctx.answerCbQuery("📊 Shaxsiy tahlilingiz va 3D Shohsupa bot lichkasiga yuborildi!", { show_alert: false })` qaytaring.
  2. Agar foydalanuvchi bot lichkasini ochmagan bo‘lsa (`sendMessage(userId, ...)` xato bersa), `ctx.answerCbQuery(alertSummary.slice(0, 195), { show_alert: true })` orqali natijani popup oynada ko‘rsating! Hech qachon guruh chatining o‘ziga shaxsiy tahlil matnini `sendMessage(chatId, ...)` qilib yubormang!

#### 4.2. `src/handlers/coreQuiz.js` da Guruh Testi Avto-O‘tish Poyga Holati (Race Condition):
- **Muammo:** `handlePollAnswer` (1007-qator) guruh testida barcha qatnashchilar javob bergach, mutex qulfidan chiqib ketib `setTimeout(() => sendNextQuestion(chatId, telegram), 1000)` ni qulfsiz chaqiradi.
- **Amal:**
  `setTimeout` ichida `sendNextQuestion` chaqirilishidan oldin sessiya holati (`session.finished`, `session.status === 'paused'`) qayta tekshirilishini va `sendNextQuestion` oxirida `session.questionState = "ACTIVE"` atomik saqlanishini ta’minlang.

#### 4.3. `src/handlers/startHandler.js` va `src/handlers/quizGame.js` da Taymer Bekor Qilishni Unifikatsiya Qilish:
- **Amal:** `startHandler.js:55`, `quizGame.js:487` va `quizGame.js:567` dagi eski `quizTimerQueue.getJob('timeout:${chatId}:${session.qIdx}')` qatorlarini olib tashlang — ularning tepasida turgan `await cancelSessionTimer(session, chatId)` barcha formatlarni to‘g‘ri tozalaydi.

---

### 🔹 5-FAZA: Test Yaratish, Docx Import va Markdown -> HTML Unifikatsiyasi (`src/handlers/testCreation/*`, `src/handlers/aiHandlers.js`)

#### 5.1. Legacy `parse_mode: "Markdown"` xatolarini bartaraf etish:
- **Muammo:** `aiGenerationFlow.js:70` (`cbAiModeQuestions`) da `AI_WARNING_TEXT` (HTML tegli) `parse_mode: "Markdown"` bilan yuborilgan. Shuningdek `processAiResult`, `onDocxFile`, `showDraftDashboard`, `cbCancelCreation`, `cbCreateTest` da `Markdown` ishlatilgan.
- **Amal:**
  1. `src/handlers/testCreation/aiGenerationFlow.js` dagi `cbAiModeQuestions`, `onAiQuestionsInput`, `onAiImageInput`, `processAiResult` funksiyalarini to‘liq `parse_mode: "HTML"` ga o‘tkazing.
  2. `src/handlers/testCreation/docxImportFlow.js` dagi `onDocxFile`, `cbAutoDocx` va `src/handlers/testCreation/wizardFlow.js` dagi `cbParseModeSelect`, `showCreationStatusMenu`, `cbCancelCreation` funksiyalarida HTML yoki xavfsiz escape qilingan format ishlating.

---

### 🔹 6-FAZA: EduPage, Jadval Kuzatuvchisi va CDN Worker Optimizatsiyasi (`src/services/edupage/timetableIndexer.js`, `src/services/timetableCdnService.js`, `src/services/scheduleWatcherService.js`)

#### 6.1. `src/services/timetableCdnService.js` da `prewarmAllTimetables` Konkurentligini Tuzatish:
- **Muammo:** 384-qatorda `await Promise.all(ALL_THEMES.map(async (theme) => ...))` bir vaqtda 3 ta rasm generatsiya qilib, 512MB RAM konteynerni zo‘riqtiradi.
- **Amal:** `Promise.all` o‘rniga `for (const theme of ALL_THEMES)` ketma-ketlik sikliga o‘tkazing:
  ```js
  for (const theme of ALL_THEMES) {
    if (workerState.shouldStop) break;
    if (stopHourTashkent != null && isTashkentCutoffReached(stopHourTashkent)) {
      logger.info(`⏰ Nightly pre-warm cutoff reached during theme processing (${stopHourTashkent}:00 Asia/Tashkent). Stopping.`);
      break;
    }
    // ... mavjud rasm tekshirish, generatsiya va kanalga yuklash kodi ...
    if (wasGenerated) {
      await sleep(Math.min(1000, delayMs));
    }
  }
  ```

#### 6.2. `src/services/scheduleWatcherService.js` da `redis.pipeline()` va Guruh Eslatmalarini Optimallashtirish:
- **Muammo:**
  1. 552-qatorda `if (redis)` tekshirilib `redis.pipeline()` chaqirilgan (`redis.isDummy` tekshirilmagan).
  2. `deliverNoteReminder` ichida har bir guruh eslatmasi uchun bazaga `db.getUsersByClassName(note.group_name)` so‘rovi yuboriladi, holbuki `subscribers` ro‘yxati allaqachon xotirada bor!
- **Amal:**
  1. 549-qatorda `if (redis && typeof redis.pipeline === 'function')` tekshiruvini qo‘ying.
  2. `deliverNoteReminder` ichida avval `subscribers` massividan foydalanuvchilarni oling; faqat `subscribers` bo‘sh bo‘lgandagina `db.getUsersByClassName` ga murojaat qiling.

---

### 🔹 7-FAZA: Admin Panel va ContactAdmin Tozalovi (`src/handlers/adminHandlers.js`, `src/handlers/contactAdmin.js`)

#### 7.1. `src/handlers/contactAdmin.js` dagi `cbCancelUserTest` bugini tuzatish:
- **Muammo:** 592-qatorda `session.subject`, `session.currentQuestion`, `session.totalQuestions` ishlatilgan (bunday xossalar `session` da yo‘q!).
- **Amal:**
  ```js
  const subjTitle = escapeHtml(session.subjectKey || session.subject || '—');
  const curQ = (session.qIdx ?? session.currentQuestion ?? 0) + 1;
  const totQ = session.sessionQuestions?.length || session.totalQuestions || 0;
  ```
  ko‘rinishiga o‘tkazing va oxiridagi dublikat `parseSuffix` funksiyasini olib tashlab (`utils.js` dan import qilinganini ishlating).

#### 7.2. `src/handlers/adminHandlers.js` da `cbAdminStats` RAM Himoyasi:
- **Muammo:** `cbAdminStats` barcha foydalanuvchilarning `history` massivini tortib keladi.
- **Amal:** `dbService.getAggregatedAdminStats()` natijasidan foydalaning va `getAllUserStats()` chaqirilganda xavfsiz ishlashini ta’minlang.

---

### 🔹 8-FAZA: Socket.IO Multiplayer O'yin Dvigatelini Tuzatish (`src/socket/index.js`, `src/socket/roomManager.js`, `src/socket/gameLoop.js`)

#### 8.1. `src/socket/index.js` va `src/socket/gameLoop.js` da Circular JSON Crash'ni bartaraf etish:
- **Muammo:** `player.disconnectTimer = setTimeout(...)` obyekti `player` ichida saqlangani sababli `Array.from(room.players.values())` soket orqali uzatilganda `TypeError: Converting circular structure to JSON` xatosi chiqadi.
- **Amal:**
  1. `src/socket/roomManager.js` da `serializePlayers(room)` yordamchi metodini yarating:
     ```js
     serializePlayers(room) {
       if (!room || !room.players) return [];
       return Array.from(room.players.values()).map(p => ({
         userId: p.userId,
         displayName: p.displayName,
         socketId: p.socketId,
         score: p.score || 0,
         disconnected: Boolean(p.disconnected),
         disconnectedAt: p.disconnectedAt || null,
       }));
     }
     ```
  2. `src/socket/index.js` va `src/socket/gameLoop.js` dagi barcha `Array.from(room.players.values())` emit chaqiruvlarini `roomManager.serializePlayers(room)` bilan almashtiring!
  3. `kahoot:answer_submit` ichida `answerIndex` ni validatsiya qiling va tez javob bergan o‘yinchiga vaqt bonusi yoki aniq ball hisoblanishini ta’minlang.

---

### 🔹 9-FAZA: WebApp Widget Engine Xavfsizligi va Hajm Muammosini Hal Qilish (`src/services/widgetService.js`, `src/widgets/widgetServer.js`)

#### 9.1. `src/services/widgetService.js` da `.replace()` Injection va 2048-bayt URL Limitini Tuzatish:
- **Muammo:**
  1. `renderWidgetHtml` ichida `.replace(/{{DATA_JSON}}/g, safeDataJson)` savol matnida `$` bo‘lsa HTML/JS kodni buzadi.
  2. `createWidgetToken` katta `payload` obyektini URL token ichiga joylagani uchun URL 2048 baytdan oshib ketadi va `isValidWebAppUrl` `false` qaytaradi.
  3. `buildInlineFlashcardWidgetHtml` va `buildInlineDocxHealerWidgetHtml` mavjud bo‘lmagan `inlineFlashcard.html` va `inlineDocxHealer.html` fayllarini qidirib har safar `Error` otadi.
- **Amal:**
  1. `widgetService.js` ichida `TTLMap` asosida `widgetPayloadStore = new TTLMap(2 * 60 * 60 * 1000, 2000)` yarating.
  2. `createWidgetToken(userId, type, payload = {}, ttlMs = DEFAULT_TTL_MS)` ichida:
     Agar `JSON.stringify(payload).length > 400` bo‘lsa, `payload` ni `widgetPayloadStore` ga `sid` (16 baytli random hex yoki hash) bilan saqlang va token ichiga `{ userId, type, sid, iat, exp }` yozing (kichik payloadlar uchun esa to‘g‘ridan-to‘g‘ri `payload` ham saqlanaversin). `verifyWidgetToken(token)` ichida esa agar `parsed.sid` bo‘lsa, `widgetPayloadStore.get(parsed.sid)` dan `payload` ni tiklang!
     *Natija:* Har qanday 100 ta savolli testda ham `/widget/:token` URL uzunligi 180 belgidan oshmaydi va `isValidWebAppUrl` har doim `true` qaytaradi!
  3. `renderWidgetHtml` ichida `.replace()` chaqiruvlarini funksional replacer (`() => safeDataJson`) ga o‘tkazing:
     ```js
     html = html
       .replace(/\{\{DATA_JSON\}\}/g, () => safeDataJson)
       .replace(/\{\{TITLE\}\}/g, () => title)
       .replace(/\{\{TYPE\}\}/g, () => escapeHtml(normType))
       .replace(/\{\{TOKEN\}\}/g, () => escapeHtml(data.token || ''));
     ```
  4. `buildInlineFlashcardWidgetHtml` va `buildInlineDocxHealerWidgetHtml` ichida mavjud bo‘lmagan `inlineFlashcard.html` / `inlineDocxHealer.html` ga `try/catch` otmasdan, to‘g‘ridan-to‘g‘ri `flashcardWidget.html` va `docxHealerWidget.html` ni oling.

---

### 🔹 10-FAZA: Regressiya va Yakuniy Tekshiruv (Verification Checklist)

AI agent barcha o‘zgarishlarni kiritib bo‘lgach, quyidagi tekshiruvlarni bajarishi shart:
1. `npm test` buyrug‘ini ishga tushirib, mavjud 43 ta test skriptining (`scripts/test_*.js`) barchasi 100% yashil (`PASS`) o‘tishini tasdiqlash.
2. Quyidagi yangi unit/integratsion holatlarni tekshirish:
   - Foydalanuvchi `markUserBlocked(uid, true)` bo‘lganda `isUserBanned(uid, true)` `false` qaytarishi;
   - `TTLMap` to‘lganda 10,000 ta ketma-ket `.set()` chaqiruvi 50ms dan kam vaqt olishi;
   - 50 ta savoldan iborat payload uchun `buildWidgetMessage` URL uzunligi `< 250` belgi bo‘lishi va `verifyWidgetToken` barcha 50 ta savolni to‘liq qaytarishi;
   - Tarkibida `$&`, `$'`, `$$` bo‘lgan savollar `renderWidgetHtml` orqali render qilinganda JSON buzilmasligi;
   - Socket.IO da o‘yinchi uzilganda (`disconnect`) `roomManager.serializePlayers(room)` `JSON.stringify` da hech qanday circular error bermasligi;
   - Guruhda `cbMyGroupQuizResult` bosilganda guruh chatiga ommaviy xabar ketmasdan, foydalanuvchi lichkasiga (yoki alert popupga) yuborilishi.