# 🏛 LOYIHA TEXNIK AUDITI VA SENIOR REFACTORING QO'LLANMASI
**Loyiha:** `quiz_bot_nodejs` (Talabalar Imtihon Trenajyori & Smart Schedule v2)  
**Qamrov:** 61 ta fayl | 36,356 qator kod  
**Audit darajasi:** Principal / Senior Software Architect  

---

## 📊 1. UMUMIY BAHOLASH (10 BALLIK TIZIMDA)

Loyiha funksional jihatdan juda boy va ko'plab murakkab muammolar (Circuit Breaker, Singleflight, TTLMap, Concurrency Semaphore, RAM Watchdog, Telegram 10.4 Widgets) ustida jiddiy ishlangan. Biroq, kod bazasining kengayishi natijasida xavfsizlik tirqishlari, monolit fayllar va ma'lumotlar bazasi bilan ishlashda jiddiy "bottleneck"lar yuzaga kelgan.

*   **Xavfsizlik (Security):** `6.0 / 10` *(Hardcoded DB parollar, TLS bypass, zaif default secretlar)*
*   **Performance va Masshtablanish (Scalability):** `7.2 / 10` *(JS ichida `SELECT *` orqali agregatsiya qilish, L1 keshlarning chegaralanmaganligi, Sync I/O)*
*   **Arxitektura va Kod Tozaligi (Clean Code):** `6.5 / 10` *(2500+ qatorli "God Object" fayllar, circular dependency'lar, spaghetti handlerlar)*
*   **Biznes Mantiq va Ishonchlilik (Reliability):** `7.8 / 10` *(Session middleware race condition, ikki marta ro'yxatdan o'tgan global message router)*
*   **Resurslar Boshqaruvi (Memory & Resiliency):** `8.5 / 10` *(Sharp semaphore va Watchdog yaxshi yozilgan, lekin ayrim Map'larda memory leak bor)*

### 🏆 UMUMIY BALL: **7.2 / 10** *(Strong Mid+ / Pre-Senior Level)*

---

## 🚨 2. ANIQLANGAN MUAMMOLAR RO'YXATI (DEEP-DIVE AUDIT)

### 🔴 A. XAVFSIZLIK (SECURITY VULNERABILITIES) — *KRITIK!*
1. **Hardcoded Production Database Credentials (`src/config/config.js:32` va `src/lib/postgres.js:9`):**
   * Kod ichida Northflank PostgreSQL bazasining haqiqiy login, parol va host manzili ochiq matnda (`postgresql://_24c4d3f3b7552851:_43bd4...`) fallback sifatida qolib ketgan. Kod repozitoriyga yoki uchinchi shaxsga tushishi bilan baza to'liq xavf ostida qoladi.
2. **PostgreSQL SSL MITM Zaifligi (`src/lib/postgres.js:35`):**
   * `ssl: needsSsl ? { rejectUnauthorized: false } : false` ishlatilgan. Bu SSL sertifikatini tekshirishni o'chiradi va "Man-in-the-Middle" (MITM) hujumlariga yo'l ochadi.
3. **Zaif Fallback Secret Kalitlar (`src/services/shareService.js:6` va `src/services/widgetService.js:69`):**
   * Agar `.env` da secret berilmasa, `'quiz_bot_share_secret_salt_v1'` va `'quiz_bot_widget_hmac_secret_v1'` kabi statik satrlar ishlatiladi. Tajovuzkor ushbu default kalit orqali har qanday `widgetToken` yoki `shareToken` ni qalbakilashtirishi (forge) mumkin.
4. **In-Memory Rate Limiter Bypass (`src/api/admin.js:15` va `src/widgets/widgetServer.js:12`):**
   * Express `trust proxy` yoqilgan bo'lsa-da, rate limiterlar lokal xotiradagi `TTLMap` da saqlanadi va ularni Redis orqali markazlashtirish qilinmagan. Shuningdek, `/widget/query` endpointida `card_action` va `fix_option` kabi amallar uchun per-user rate limit yo'q (Redis session flood qilish mumkin).

---

### ⚡ B. PERFORMANCE VA MEMORY MUAMMOLARI (BOTTLENECKS)
1. **Node.js Xotirasida To'liq Jadvalni Tortib Hisoblash (`src/handlers/adminHandlers.js:155, 577` va `src/services/dbService.js:294`):**
   * Admin panel har safar ochilganda yoki yangilanganda `dbService.getAllUserStats()` chaqiriladi. Bu funksiya `SELECT user_id, total_correct, total_wrong, tests_completed, history FROM user_stats` qilib **BARCHA foydalanuvchilarning** og'ir JSONB `history` ustunini Node.js RAM'iga tortib keladi va `for` tsiklida aylanib chiqadi. Foydalanuvchilar soni 10,000+ bo'lganda **300MB RAM limiti** darhol to'lib, server **OOM (Out of Memory)** bilan qulaydi! Bu hisob-kitoblar 100% SQL `SUM()`, `COUNT()`, `AVG()` orqali bazaning o'zida bajarilishi shart.
2. **Chegaralanmagan (Unbounded) L1 Keshlar (`src/services/dbService.js:11-14` va `src/services/edupageService.js:393`):**
   * `subjectL1Cache`, `userTestL1Cache`, `userSubjectsL1Cache`, `subjectBlocksL1Cache` oddiy `new Map()` sifatida ochilgan. Ularda na maksimal hajm (maxSize) va na avto-tozalash (sweep) bor. Vaqt o'tishi bilan ular xotirani to'ldirib boradi (Memory Leak). Ularni `TTLMap` ga o'tkazish shart.
   * `roomLocationCache` (`edupageService.js:393`) 1000 taga yetganda `.clear()` qilib to'liq o'chirib yuboriladi (Cache stampede).
3. **Redis Session Middleware'da 2x Tarmoq Kechikishi (`index.js:176-184`):**
   * Har bir foydalanuvchi xabaridan keyin `finally` blokida `redisConnection.get(key)` qilinib, keyin `redisConnection.set(key)` qilinmoqda. Bu har bir xabarga qo'shimcha RTT (Round-Trip Time) qo'shadi va yuqori yuklamada Redis'ni sekinlashtiradi.
4. **Sinxron Disk I/O Operatsiyalari (`src/handlers/testCreation.js`, `src/handlers/aiTestsHandlers.js`, `src/services/widgetService.js:162`):**
   * Runtime handlerlar ichida `fs.existsSync` va `fs.unlinkSync` ishlatilgan. Node.js Event Loop'ini bloklamaslik uchun barcha fayl operatsiyalari `fs.promises` (`await fs.promises.unlink(...)`) bo'lishi kerak.
5. **AI Xizmatida Disk Orqali Rasm Yozish (`src/handlers/testCreation.js:495`, `src/services/aiService.js:368`):**
   * Telegramdan rasm `/tmp` papkaga yuklab olinib, keyin Google File Manager'ga upload qilinmoqda. `gemini-2.5-flash` / `gemini-3.1-flash-lite-preview` inline base64 buffer'ni to'g'ridan-to'g'ri RAM'dan qabul qila oladi. Disk I/O va Google File API'ga 2 marta HTTP so'rov yuborish vaqtni 2 barobar ko'paytirmoqda.

---

### 🍝 C. SPAGHETTI KOD VA ARXITEKTURA XATOLARI
1. **"God Object" (Monolit) Fayllar:**
   * `testCreation.js` (2,639 qator), `edupageService.js` (2,551 qator), `dbService.js` (2,435 qator), `adminHandlers.js` (2,169 qator), `quizGame.js` (1,711 qator), `coreQuiz.js` (1,603 qator). Bitta faylda 2500 qator kod bo'lishi Single Responsibility Principle (SRP) ga zid.
2. **Inline HTML Stringlarning JavaScript Ichiga Tiqilishi (`src/services/widgetService.js:285-816`):**
   * `widgetService.js` ichida 530 qatorlik HTML/CSS/JS kodlari backtick string sifatida yozilgan, vaholanki `src/widgets/views/` papkasida alohida `.html` fayllar ham bor. Bu kodni o'qish va saqlashni (maintainability) juda qiyinlashtiradi.
3. **Aylanma Bog'liqliklar (Circular Dependencies):**
   * `coreQuiz.js` <-> `quizGame.js` <-> `groupQuizLogic.js` <-> `universalTestHub.js` bir-birini funksiyalar ichida `require()` qiladi.
   * `dbService.js` ichida `edupageService.js` chaqiriladi, `scheduleWatcherService.js` esa har ikkalasini chaqiradi.
4. **Dual Global `bot.on("message")` To'qnashuvi (`index.js:343` va `src/handlers/contactAdmin.js:999`):**
   * `index.js` da global `bot.on("message")` state router bor. Lekin `contactAdmin.js` ning `register()` funksiyasi `index.js:218` da (global routerdan **OLDIN**) chaqiriladi va u ham o'zining `bot.on("message", handleContactMessages)` handlerini ro'yxatdan o'tkazadi! Natijada har bir yozilgan xabar avval `contactAdmin.js` ga tushadi, u yerdan `next()` orqali `index.js` ga o'tadi.

---

### 🔁 D. TAKRORLANGAN VA BUZILGAN MANTIQLAR (REPEATED & BROKEN LOGIC)
1. **AI Limitlarining 3 Xil Joyda va Volatile (Uchuvchan) Saqlanishi:**
   * `aiService.js` (21-qator), `aiHandlers.js` (14-qator) va `aiTestsHandlers.js` (18-qator) da 3 ta bir-biridan mustaqil in-memory rate-limiter yozilgan. Server har safar restart bo'lganda barcha kunlik va oylik limitlar `0` ga tushib ketadi! Bundan tashqari, `aiService.js:33` da `byFunction` qiymatlari `100` dan boshlanadi, `FUNCTION_LIMITS` ham `100`. Ya'ni birinchi kunlik reset bo'lmaguncha funksiya limitlari noto'g'ri ishlaydi.
2. **Menu Tugmalari va Escape Funksiyalarining Dublikatsiyasi:**
   * `mainMenuButtons` ro'yxati `index.js:356`, `noteHandler.js:549`, `donateHandler.js:116`, `contactAdmin.js:132` da qayta-qayta copy-paste qilingan.
   * `parseSuffix` funksiyasi `utils.js` da bo'lishiga qaramay, `contactAdmin.js:975` da qayta yozilgan.
   * `toSafeUtf8`, `escapeHtml`, `escapeTelegramHtml`, `sanitizeTelegramHtml` turli fayllarda turlicha implementatsiya qilingan.
3. **Yarim Qolgan Foydalanuvchi Statistika Kaskadi (`src/core/storage.js` vs `src/services/dbService.js`):**
   * `storage.js` fayli `users_stats.json` va Redis bilan ishlaydi, lekin asosiy bot `dbService.js` orqali PostgreSQL dagi `user_stats` jadvali bilan ishlaydi. `dbService.getUsersPaginated` esa PostgreSQL xato bersa `storage.js` ga fallback qiladi (u yerda esa ma'lumot bo'sh). Bu "Dead/Zombie" arxitektura qoldig'i.
4. **CircuitBreaker Dublikatsiyasi:**
   * `src/core/circuitBreaker.js` da toza `CircuitBreaker` klassi bor, lekin `edupageService.js:615` da xuddi shu mantiq global o'zgaruvchilar bilan noldan qayta yozilgan.

---

### 🐛 E. KICHIK BUGLAR (SUBTLE BUGS & EDGE CASES)
1. **Zod v4 Xatoliklarini O'qishda Crash (`src/handlers/testCreation.js:194`):**
   * `package.json` da `"zod": "^4.3.6"` o'rnatilgan. `testValidators.js` da `result.error.issues?.[0]?.message || result.error.errors?.[0]?.message` deb to'g'ri yozilgan, lekin `testCreation.js:194` (`onSubjectInput`) da faqat `result.error.errors[0].message` deb yozilgan! Zod v4 da `.errors` getter o'rniga `.issues` ishlatilganda bu qator `TypeError: Cannot read properties of undefined (reading '0')` berib yiqiladi.
2. **Toshkent Vaqtini Hisoblashdagi Lokalizatsiya Xatosi (`src/core/utils.js:469` va `edupageService.js:1106`):**
   * `new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }))` usuli turli OS va Node.js ICU versiyalarida `Invalid Date` yoki noto'g'ri UTC offset qaytarishi bilan mashhur. Vaqt bilan ishlashda `Intl.DateTimeFormat` parts yoki aniq UTC+5 (`Date.now() + 5 * 3600000`) arifmetikasidan foydalanish kerak.
3. **BullMQ `removeOnComplete` va Idempotency Kaliti:**
   * `index.js:500` da `removeOnComplete: 100` (eski Bull v3 sintaksisi), `queues.js:21` da esa `{ count: 100, age: 3600 }` (BullMQ v5 sintaksisi) ishlatilgan.
4. **Guruh Testlarida `poll_ready_voters` TTL Xatosi (`src/handlers/coreQuiz.js:814`):**
   * `sadd` va `expire` alohida-alohida `await` qilinmasdan chaqirilgan. Redis pipeline ishlatilmagani uchun yuqori konkurensiyada orphan key qolib ketish xavfi bor.

---
---

## 🤖 3. AI UCHUN QAT'IY REFACTORING QO'LLANMASI (MASTER PROMPT)

Loyihani **9.5 / 10 Senior Production** darajasiga olib chiqish uchun quyidagi qo'llanmani Cursor, Claude Code yoki Windsurf AI agentiga bosqichma-bosqich (Phase 1 -> Phase 5) berib bajartiring.

---

### 📋 AI AGENT UCHUN KO'RSATMA (COPY-PASTE UCHUN):

> **SYSTEM ROLE & DIRECTIVE:**
> Sen Principal Node.js Backend Architect va Senior Telegram Bot muhandisisan. Vazifang — `quiz_bot_nodejs` loyihasini mavjud biznes mantiq va funksionallikni 100% saqlagan holda **9.5/10 Senior Production** darajasiga olib chiqishdir.
> 
> **QAT'IY QOIDALAR (NON-NEGOTIABLE):**
> 1. Hech qanday mavjud funksiyani, callback_data formatini yoki foydalanuvchi oqimini (UX flow) buzma.
> 2. Har bir fayl o'zgarishidan so'ng `npm test` skriptini ishga tushirib, barcha testlar o'tishini tekshir.
> 3. Hech qachon kod ichida hardcoded parol, token yoki zaif fallback secret qoldirma.
> 4. Barcha xotira keshlari (`Map`) qat'iy ravishda `TTLMap(ttlMs, maxSize)` bilan chegaralanishi shart (Server RAM limiti: 300MB V8 Heap / 512MB Container).
> 5. PostgreSQL bazasidan hech qachon agregatsiya uchun `SELECT *` qilib barcha qatorlarni Node.js xotirasiga tortma — faqat SQL `COUNT`, `SUM`, `AVG` funksiyalarini ishlat.

---

### 🛠 PHASE 1: XAVFSIZLIK VA KONFIGURATSIYA (SECURITY HARDENING)

**1.1. Hardcoded Database URL va Secretlarni Tozalash:**
*   **Fayllar:** `src/config/config.js`, `src/lib/postgres.js`, `src/services/shareService.js`, `src/services/widgetService.js`
*   **Amal:**
    1. `src/config/config.js` va `src/lib/postgres.js` ichidagi `postgresql://_24c4d3f3b7552851...` default fallback satrini butunlay olib tashla. Agar `process.env.DATABASE_URL` topilmasa, `logger.error("CRITICAL: DATABASE_URL is not set in environment")` chiqarib, `pool = null` qoldir (yoki production rejimida `process.exit(1)` qil).
    2. `src/lib/postgres.js` da SSL konfiguratsiyasini yangila:
       ```javascript
       const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true';
       ssl: needsSsl ? { rejectUnauthorized, ca: process.env.DB_SSL_CA || undefined } : false
       ```
    3. `src/services/shareService.js` va `src/services/widgetService.js` dagi `'quiz_bot_share_secret_salt_v1'` kabi statik fallbacklarni olib tashla. Secret sifatida `process.env.SHARE_LINK_SECRET || crypto.createHmac('sha256', 'share_v1').update(BOT_TOKEN).digest('hex')` ishlat (agar `BOT_TOKEN` ham bo'lmasa, faqat `NODE_ENV === 'test'` da test secretga ruxsat ber).

**1.2. API va Widget Rate Limitingni Redis'ga O'tkazish:**
*   **Fayllar:** `src/api/admin.js`, `src/widgets/widgetServer.js`
*   **Amal:**
    1. `widgetServer.js` dagi `/widget/query` endpointida har bir `verifiedToken.userId` uchun Redis-backed sliding window rate limit qo'sh (masalan, 30 req / 10 sec).
    2. `admin.js` dagi IP rate limiterni Redis (`incr` + `pexpire`) orqali ishlaydigan qil (fallback sifatida `TTLMap` qolsin).

---

### 🚀 PHASE 2: DATABASE VA PERFORMANCE OPTIMIZATSIYASI

**2.1. `getAdminDashboardStats` va `cbAdminStats` ni SQL Agregatsiyaga O'tkazish:**
*   **Fayllar:** `src/services/dbService.js`, `src/handlers/adminHandlers.js`
*   **Amal:**
    1. `dbService.js` ichida yangi `getAggregatedAdminStats()` funksiyasini yoz. U barcha `user_stats` qatorlarini Node.js ga tortmasdan, bitta SQL so'rov orqali hisoblasin:
       ```sql
       SELECT 
         (SELECT COUNT(*) FROM users) AS total_users,
         COUNT(*) FILTER (WHERE updated_at >= NOW() - INTERVAL '7 days' OR (history->0->>'timestamp')::bigint >= $1) AS active_users,
         COALESCE(SUM(tests_completed), 0) AS total_tests,
         COALESCE(SUM(total_correct), 0) AS total_correct,
         COALESCE(SUM(total_wrong), 0) AS total_wrong
       FROM user_stats;
       ```
    2. `adminHandlers.js` dagi `getAdminDashboardStats()` va `cbAdminStats()` funksiyalarini ushbu SQL agregatsiya metodiga bog'la. Natijada xotira sarfi ~80MB dan ~1KB ga tushadi, tezlik esa 50 barobar oshadi.

**2.2. Barcha L1 Keshlarni `TTLMap` ga O'tkazish:**
*   **Fayllar:** `src/services/dbService.js`, `src/services/edupageService.js`, `src/services/widgetService.js`
*   **Amal:**
    1. `dbService.js` (11-14 qatorlar) dagi `subjectL1Cache`, `userTestL1Cache`, `userSubjectsL1Cache`, `subjectBlocksL1Cache` larni oddiy `Map` o'rniga `new TTLMap(5 * 60 * 1000, 500)` qilib o'zgartir.
    2. `edupageService.js:393` dagi `roomLocationCache` ni `new TTLMap(24 * 60 * 60 * 1000, 1000)` ga o'tkaz.
    3. `watchdogService.js` dagi `runMemoryHygieneSweep()` funksiyasiga ushbu L1 keshlarning `.sweep()` metodlarini qo'sh.

**2.3. Sinxron Disk Operatsiyalarini Asinxron (`fs.promises`) Qilish va AI Rasm Oqimini To'g'rilash:**
*   **Fayllar:** `src/handlers/testCreation.js`, `src/handlers/aiTestsHandlers.js`, `src/services/aiService.js`
*   **Amal:**
    1. `fs.existsSync` va `fs.unlinkSync` chaqiruvlarini `await fs.promises.unlink(filePath).catch(() => {})` ga almashtir.
    2. `aiService.js` dagi `generateQuizFromImage` funksiyasida rasm hajmi 4MB dan kichik bo'lsa, Google File API'ga yuklab o'tirmasdan to'g'ridan-to'g'ri inline base64 (`inlineData: { data: buffer.toString('base64'), mimeType }`) orqali `model.generateContent` ga yuboradigan qil.

**2.4. Redis Session Middleware Optimallashtiruvi (`index.js:144-190`):**
*   **Fayl:** `index.js`
*   **Amal:**
    1. Sessiya obyekti o'zgarganini aniqlash uchun faqat `newSessionStr !== baseSessionStr` bo'lgandagina Redis'ga yoz.
    2. Har safar yozishdan oldin `redisConnection.get(key)` qilishni olib tashla; agar `ctx._sessionModifiedKeys` bo'lsa, faqat o'zgargan kalitlarni yangila yoki Lua skript orqali atomic merge qil.

---

### 🧱 PHASE 3: ARXITEKTURA VA "GOD OBJECT" LARNI MODULLARGA AJRATISH

**3.1. `src/services/edupageService.js` (2,551 qator) ni 4 ta Modulga Ajratish:**
*   `src/services/edupage/edupageClient.js` — HTTP transport, Proxy agent, Session/Cookie manager va `CircuitBreaker` (`src/core/circuitBreaker.js` dagi tayyor klassni ishlat!).
*   `src/services/edupage/groupNormalizer.js` — Kirill-Lotin transliteratsiyasi, `normalizeGroupName`, `getCanonicalGroupName`, `parseRoomLocation`.
*   `src/services/edupage/timetableIndexer.js` — `buildIndexedDatabase`, `validateTimetablePayload`, L1/L2/L3 disk kesh.
*   `src/services/edupage/smartScheduleHelper.js` — `PERIOD_TIMINGS`, `normalizeSubjectKey`, `normalizeLessonType`, `detectCurrentActiveLesson`, `findUpcomingCourseOccurrences`.
*   `src/services/edupageService.js` — Facade sifatida barcha funksiyalarni re-export qilsin (boshqa fayllardagi `require('./edupageService')` buzilmasligi uchun!).

**3.2. `src/services/dbService.js` (2,435 qator) ni Repository'larga Ajratish:**
*   `src/repositories/userRepository.js` — Foydalanuvchilar, ban/block va qidiruv.
*   `src/repositories/testRepository.js` — Rasmiy testlar, `subjects`, `user_tests`, va Javon (`shelf`).
*   `src/repositories/scheduleRepository.js` — `timetable_cache`, `user_schedule_settings`, `course_notes`.
*   `src/services/dbService.js` — Barcha repository metodlarini birlashtirib export qiluvchi Facade bo'lsin.

**3.3. `src/handlers/testCreation.js` (2,639 qator) ni Kichik Handlerlarga Bo'lish:**
*   `src/handlers/testCreation/wizardFlow.js` — Fan va blok yaratish, draft/edit dashboard.
*   `src/handlers/testCreation/docxImportFlow.js` — Word fayl yuklash, auto-chunking va `aiDocxHealer` integratsiyasi.
*   `src/handlers/testCreation/aiGenerationFlow.js` — Matn, rasm va savollardan AI test tuzish.
*   `src/handlers/testCreation/questionEditor.js` — Grid preview, bitta savolni tahrirlash va xatolarni tuzatish.
*   `src/handlers/testCreation.js` — Asosiy router va re-export fayli.

**3.4. `src/services/widgetService.js` dagi Inline HTML larni Tashqariga Chiqarish:**
*   `buildInlineFlashcardWidgetHtml` va `buildInlineDocxHealerWidgetHtml` ichidagi 500+ qatorli HTML shablonlarni `src/widgets/views/inlineFlashcard.html` va `src/widgets/views/inlineDocxHealer.html` fayllariga ko'chirib, startup vaqtida xotiraga (`templateMemoryCache`) o'qib oladigan qil.

---

### 🔧 PHASE 4: BROKEN LOGIC VA BUGLARNI TUZATISH

**4.1. Zod v4 Xatoliklarini Yagona Standartga Keltirish:**
*   **Fayl:** `src/handlers/testCreation.js:194`
*   **Amal:** `result.error.errors[0].message` qatorini `result.error.issues?.[0]?.message || result.error.errors?.[0]?.message || "Noto'g'ri format"` ga o'zgartir (`validateSubject` helperini chaqir).

**4.2. Global `bot.on("message")` To'qnashuvini Bartaraf Etish:**
*   **Fayllar:** `index.js`, `src/handlers/contactAdmin.js`
*   **Amal:**
    1. `contactAdmin.js:999` dagi `bot.on('message', handleContactMessages)` qatorini olib tashla!
    2. `index.js` dagi global `bot.on('message')` routeriga admin reply tekshiruvini (`if (isAdmin(userId) && ctx.message?.reply_to_message) return handlers.contact.handleContactMessages(ctx, next);`) qo'sh. `States.USER_CONTACT` allaqachon `index.js:409` dagi `stateMap` da mavjud.

**4.3. Yagona Redis-Backed AI Rate Limiter Yaratish:**
*   **Fayllar:** `src/services/aiService.js`, `src/handlers/aiHandlers.js`, `src/handlers/aiTestsHandlers.js`
*   **Amal:**
    1. Uchta joyda tarqoq yozilgan in-memory AI limitlarini o'chirib, `src/services/aiRateLimiter.js` servisini yarat.
    2. Kunlik, soatlik va oylik AI kvotalarni Redis'da (`ai:quota:daily:YYYY-MM-DD`, `ai:quota:user:${userId}:daily`) saqla (Redis uzilganda `TTLMap` fallback ishlasin).
    3. `aiService.js:33` dagi `byFunction` boshlang'ich qiymatlarini `100` emas, `0` qilib to'g'rila!

**4.4. Vaqt Mintaqasi (Timezone) va Menu Konstantalarini Markazlashtirish:**
*   **Fayl:** `src/core/utils.js`
*   **Amal:**
    1. `MAIN_MENU_BUTTONS` massivini `src/core/utils.js` (yoki `src/config/constants.js`) ga chiqar va `index.js`, `noteHandler.js`, `donateHandler.js`, `contactAdmin.js` da shu yagona konstantani ishlat.
    2. `getTashkentDate(date)` funksiyasini OS locale'ga bog'liq bo'lmagan `Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date)` orqali aniq va xatosiz ishlaydigan qil.

**4.5. `src/core/storage.js` Legacy Kodini Tozalash:**
*   **Fayllar:** `src/core/storage.js`, `src/core/loader.js`, `src/services/dbService.js`
*   **Amal:** `users_stats.json` fayli endi ishlatilmayotganini inobatga olib, `storage.js` dagi ortiqcha disk I/O operatsiyalarini olib tashla va faqat kerakli in-memory obyekt strukturasini qoldir.

---

### ✅ PHASE 5: SIFAT NAZORATI VA VERIFIKATSIYA (QA & TESTING)

Har bir Phase yakunlanganda AI agent quyidagi tekshiruvlarni majburiy ravishda bajarishi shart:
1. `npm test` buyrug'ini ishga tushirib, mavjud 38 ta test skriptining 100% xatosiz o'tishini tasdiqlash.
2. Yangi qo'shilgan `getAggregatedAdminStats()`, `aiRateLimiter` va `edupage` modullari uchun `scripts/test_senior_refactoring.js` test faylini yozish va ishga tushirish.
3. `npx eslint src/ index.js` orqali barcha unused variable va syntax muammolarini tekshirish.
4. Xotira sarfini tekshirish: bot ishga tushganda (`node --expose-gc index.js`) RSS xotira 150MB dan oshmasligini tasdiqlash.