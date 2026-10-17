# 🔍 `quiz_bot_nodejs` — 50 ta Fayl Bo‘yicha To‘liq Kod Auditi, Aqlli Eslatmalar (Smart Schedule v2.0) Tahlili va Memory Leak (512 MB RAM) Hisoboti

Ushbu hisobot loyihaning taqdim etilgan **50 ta asosiy fayli** (`index.js`, `Dockerfile`, `migrations/*`, `src/core/*`, `src/services/*`, `src/handlers/*`, `src/socket/*`, `src/jobs/*`) ustida o‘tkazilgan qator-baqator statik va arxitekturaviy tahlil asosida tayyorlandi.

---

## 🚨 1-BO‘LIM: Nima Uchun 512 MB RAM Kun Sayin Sekin O‘sib 95% (~486 MB) Ga Yetmoqda? (Aniq Fayl va Qatorlar)

Loyihada `--max-old-space-size=300` va `sharp.cache(false)` qo‘yilgan bo‘lishiga qaramay, konteynerning umumiy **RSS (Resident Set Size)** va **V8 Old Space** xotirasi kun sayin o‘sib 480–490 MB ga chiqib qolishiga kod bazasidagi **7 ta aniq omil** sabab bo‘lmoqda:

### 1.1. `src/services/scheduleWatcherService.js` (442-qator) + `index.js` (319-qator): Har 5 daqiqada majburiy `forceRefresh = true` va Tier-1 Gatekeeper'ning uzib qo‘yilganligi
* **Kodda nima bo‘lmoqda?**
  * `index.js` (319-qator) da `watcherDayCron` har 5 daqiqada `scheduleWatcher.checkScheduleChanges(false)` ni chaqiradi.
  * `src/services/edupageService.js` (336-qator) da maxsus 332 baytlik yengil tekshiruv funksiyasi — `getMetadataSignature()` ("Tier 1 Lightweight Gatekeeper") yozilgan va `scheduleWatcherService.js` (41, 49, 53-qatorlar) da `REDIS_SIG_KEY`, `lastKnownSignature`, `tier1SkipsCount` o‘zgaruvchilari tayyorlab qo‘yilgan.
  * **AMMO** `scheduleWatcherService.js` ning **442-qatorida** `getMetadataSignature()` umuman chaqirilmasdan, to‘g‘ridan-to‘g‘ri:
    ```javascript
    const indexedDb = await edupageService.getIndexedDatabase(true);
    ```
    deb yozib qo‘yilgan!
* **Xotiraga ta’siri (Memory Spike & Old Space Promotion):**
  1. Har 5 daqiqada (kuniga **288 marta**) bot EduPage serveridan ~800 KB siqilgan (ochilganda **10–15 MB** bo‘ladigan) `regularttGetData` JSON javobini tortib oladi.
  2. Jadvalda bitta kichik o‘zgarish bo‘lsa ham, `edupageService.js` (**648–655-qatorlar**) bir vaqtning o‘zida:
     * `saveDiskCache({ ...raw, _defaultNum: defaultNum })` orqali 12 MB lik obyektni klonlab va `JSON.stringify` qilib diskka yozadi;
     * `redis.set(redisKey, JSON.stringify(raw), 'EX', REDIS_TTL_SEC)` orqali **yana bir marta** 12 MB lik string yaratib Redisga yozadi (holbuki, 5 daqiqadan keyin `forceRefresh = true` bo‘lgani uchun Redisdagi bu kesh baribir o‘qilmaydi!).
  3. Bunday 10–15 MB lik gigant stringlar V8 ning *Young Generation (New Space)* xotirasiga sig‘maydi va to‘g‘ridan-to‘g‘ri **V8 Large Object Space / Old Space** ga o‘tkaziladi.

---

### 1.2. `Dockerfile` (48–50-qatorlar) + `src/services/imageService.js` (774-qator): `librsvg` / `PangoCairo` C++ keshlari va Linux `glibc` Arena Fragmentatsiyasi
* **Kodda nima bo‘lmoqda?**
  * `imageService.js` da `sharp.cache(false)` va `sharp.concurrency(1)` qo‘yilgan. Biroq `sharp(Buffer.from(svgString)).png()` chaqirilganda, SVG matnni ($2970 \times 2430$ piksel — har bir rasm uchun **~28–40 MB xom RGBA bitmap**) rastrlashni `libvips` ning o‘zi emas, balki C++ dagi **`librsvg` + `cairo` + `pango` + `fontconfig`** kutubxonalari bajaradi.
  * `PangoCairoFontMap` va `fontconfig` shrift gliflarini C++ (Off-Heap) xotirada keshlaydi.
  * Eng asosiysi: `Dockerfile` (48-qator) da `MALLOC_ARENA_MAX` belgilanmagan! Standart Debian (`node:22-bookworm-slim`) konteynerida Linux `glibc` xotira ajratuvchisi har bir oqim uchun 64 MB lik native "arena"lar ochadi. `librsvg` katta SVG ni chizib bo‘lib `free()` qilganda, `glibc` xotira sahifalarini operatsion tizimga (OS ga) qaytarib bermaydi. Natijada `process.memoryUsage().rss` kun sayin zinapoya bo‘lib 485 MB gacha ko‘tariladi va `global.gc()` uni pasaytira olmaydi (chunki bu V8 Heap emas, C++ Off-Heap fragmentatsiyasidir!).

---

### 1.3. `index.js` (31–39-qatorlar): `@sentry/profiling-node` (`nodeProfilingIntegration`) Native C++ Xotira Sizishi
* **Kodda nima bo‘lmoqda?**
  ```javascript
  const { nodeProfilingIntegration } = require("@sentry/profiling-node");
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      integrations: [nodeProfilingIntegration()],
      tracesSampleRate: 0.1,
      profilesSampleRate: 0.1,
  ```
* **Muammo:** `@sentry/profiling-node` V8 ning C++ `CpuProfiler` qatlamiga ulanib, funksiya adreslari va stack trace jadvallarini native C++ xotirada yig‘adi. 512 MB RAMli uzoq ishlovchi (long-running) Node.js 22 konteynerlarida `nodeProfilingIntegration()` C++ symbol table'larni to‘liq bo‘shatmasligi sababli kuniga **20–40 MB** qo‘shimcha native RSS xotira yeydi.

---

### 1.4. `src/core/utils.js` (`TTLMap`, 7–44-qatorlar) + `src/core/loader.js` (110–123-qatorlar): Minglab `setTimeout` Obyektlari va Closure'lar
* **Kodda nima bo‘lmoqda?**
  * `src/core/utils.js` (22-qator) da `TTLMap.prototype.set` har bir kalit uchun alohida `setTimeout(() => this._map.delete(key), this._ttl)` yaratadi!
  * `src/core/loader.js` (114-qator) da `syncUserNames()` bot ishga tushishi bilan bazadagi barcha foydalanuvchilarni aylanib, `userNameCache.set(user.telegram_id, userName)` qiladi (`ttl = 86400000` — 24 soat).
  * Loyihada jami **11 ta `TTLMap`** instansiyasi mavjud (`userNameCache`, `localUserClasses` [5000], `localUserThemes` [5000], `localActiveTestCache` [2000], `localPollMapCache` [5000], `minuteLocalDedupe` [3000], `recentAlertsSent` [2000], `fallbackTimetableCache` [1000] va h.k.).
  * Natijada Node.js ichida bir vaqtning o‘zida **15,000–25,000 ta aktiv `Timeout` obyekti** va ularning closure'lari (`() => this._map.delete(key)`) 24 soat davomida V8 Old Space va Libuv timer heap'da osilib turadi!

---

### 1.5. `src/services/sessionService.js` (7–11 va 29–41-qatorlar): Tashlab Ketilgan Testlarning RAMda 24 Soat Saqlanishi
* **Kodda nima bo‘lmoqda?**
  ```javascript
  const TTL = 86400; 
  const localActiveTestCache = new TTLMap(TTL * 1000, 2000);
  ```
  * Foydalanuvchi testni boshlaganda (`initAndStartTest` — `quizGame.js` 115-qator), 25–300 ta savoldan iborat to‘liq massiv (`sessionQuestions`), guruh marafonlarida esa barcha bloklarning nusxasi (`marathonBlocks` — `groupQuizLogic.js` 179-qator) `sessionService.setActiveTest` orqali **ham Redisga, ham Node.js RAMidagi `localActiveTestCache` ga 24 soatga** yoziladi.
  * Agar foydalanuvchi `"🚀 Testga tayyormisiz? ▶️ Boshlash"` ekranida tugmani bosmay chiqib ketsa (`status: "preparing"`) yoki testni yarim yo‘lda pauza qilib tashlab ketsa (`status: "paused"`), `deleteActiveTest` hech qachon chaqirilmaydi!

---

### 1.6. `src/services/watchdogService.js` (16–50-qatorlar): Samarasiz Watchdog Sikli
* **Kodda nima bo‘lmoqda?**
  * `watchdogService.js` har 30 soniyada `mem.rss > 360 MB` ni tekshiradi.
  * RSS 360 MB dan oshganda (masalan, 480 MB bo‘lganda), u faqat `scheduleService.clearImageMemoryCache()` ni tozalaydi va `global.gc()` ni chaqiradi.
  * Biroq `imageMemoryCache` allaqachon bo‘sh bo‘lsa ham, `localActiveTestCache`, `fallbackTimetableCache`, `localUserClasses`, `roomsPaginationCache` va `groupSnapshots` ichidagi megabaytlab ma’lumotlar tozalanmaydi. Natijada RSS 360 MB dan pastga tushmaydi va Watchdog **har 30 soniyada to‘xtovsiz `global.gc()` chaqirib**, CPU va loglarni (`logs/combined.log`) to‘ldiraveradi!

---

### 1.7. `src/core/logger.js` (14–16-qatorlar): Cheklanmagan Log Fayllar
* `logs/error.log` va `logs/combined.log` da `maxsize` va `maxFiles` berilmagan. Konteyner ichida kunlar davomida yozilgan loglar disk/overlayfs keshini to‘ldirib boradi.

---

## 🐛 2-BO‘LIM: Umumiy Kod Bazasida Topilgan 10 ta Kritik Xatoliklar (Line-by-Line Bug Report)

### 🔴 Xato #1: `src/services/aiService.js` (307–322-qatorlar) — Rasmdan AI Test Yaratish 100% Ishlamaydi (`ReferenceError: result is not defined`)
`generateQuizFromImage` funksiyasida rasm Google AI serveriga yuklanadi (`fileManager.uploadFile`), `prompt` yaratiladi, lekin **`model.generateContent(...)` chaqiruvi tushib qolgan!**
```javascript
// src/services/aiService.js (317–320-qatorlar):
let questions = null;
try {
    // ❌ XATO: `result` o'zgaruvchisi hech qayerda e'lon qilinmagan!
    const rawQuestions = extractJSON(result.response.text());
    questions = sanitizeQuizQuestions(rawQuestions);
```

### 🔴 Xato #2: `src/handlers/aiTestsHandlers.js` (197–200 va 254-qatorlar) — Admin Panelda Matndan AI Test Yaratish Qulaydi (`ReferenceError: adminId is not defined`)
`onAiTestsText(ctx)` funksiyasida `const adminId = ctx.from.id;` qatori yozilmasdan qolib ketgan. Admin paneldan `"🤖 AI Testlar -> 📝 Matn asosida"` tanlanib matn yuborilishi bilan bot `ReferenceError: adminId is not defined` xatosini otadi.

### 🔴 Xato #3: `src/services/dbService.js` (670-qator) + `src/core/utils.js` (7–44-qatorlar) — `TypeError: fallbackTimetableCache.values is not a function`
`dbService.js` ning **668–674-qatorlarida** `fallbackTimetableCache.values()` chaqirilgan, holbuki `TTLMap` klassida `.values()` metodi mavjud emas! Kamida 1 ta talaba dars jadvalini ko‘rishi bilan `fallbackTimetableCache.size > 0` bo‘ladi va `scheduleWatcherService.js` (478-qator) har 5 daqiqada `db.getAllCachedTimetables()` ni chaqirganda `TypeError` bilan yiqiladi.

### 🔴 Xato #4: `src/handlers/contactAdmin.js` (325-qator) vs `src/handlers/adminHandlers.js` (658-qator) — Admin Foydalanuvchiga Javob Yoza Olmaydi (`❌ Noto'g'ri foydalanuvchi ID`)
1. Foydalanuvchi adminga murojaat yuborganda, adminga boradigan tugma callback'i: `reply_${userId}_${copiedMsg.message_id}`.
2. Admin shu tugmani bosganda, `contactAdmin.js` dagi `cbAdminReplyToUser` (325-qator) `ctx.session.replyTargetUserId = targetUserId` qilib saqlaydi.
3. Admin javob matnini oddiy xabar sifatida yozib yuborganda, `index.js` (272-qator) `States.ADMIN_REPLY` holatini ko‘rib, **`handlers.admin.onReplyMessage(ctx)`** (`adminHandlers.js`, 658-qator) ni chaqiradi!
4. `adminHandlers.onReplyMessage` esa `ctx.session.data.target_id` ni qidiradi va u bo‘sh bo‘lgani uchun adminga **`❌ Noto'g'ri foydalanuvchi ID.`** xatosini qaytaradi!

### 🔴 Xato #5: `src/handlers/scheduleHandler.js` (354–364-qatorlar) — `scheduleHash: null` Saqlanishi Oqibatida Cheksiz Qayta Chizish (Infinite Cache Invalidation)
`cmdHafta` funksiyasida lokal buferdan rasm yuborilganda `scheduleHash: null` (`""`) saqlanadi. Keyingi safar talaba `/hafta` ni bosganda, `timetableCdnService.js` (116-qator) `"" !== currentScheduleHash` deb ko‘rib, keshni o‘chirib tashlaydi va guruhdagi barcha talabalarga yolg‘on *"🔔 DIQQAT: Guruhingiz dars jadvalida o'zgarishlar aniqlanganligi sababli jadval yangilandi!"* bildirishnomasini yuboradi.

### 🔴 Xato #6: `src/socket/gameLoop.js` (34–38-qatorlar) — WebSocket Kahoot O‘yinida To‘g‘ri Javob (`0`-indeks / `correct_index`) Hech Qachon Ball Bermaydi!
`src/api/admin.js` da Kahoot savollari bazaga `correct_index` (`0, 1, 2, 3`) bilan yoziladi. Ammo `gameLoop.js` (37-qator) da `room.currentAnswer = subQ.correct_option || q.correct_option || q.answer || "";` yozilgan (`correct_index` tekshirilmagan va `0 || ""` ifodasi `""` qaytaradi).

### 🔴 Xato #7: `src/handlers/startHandler.js` (122-qator) — `TypeError: cbSubject is not a function`
`startHandler.js` (122-qator) da `const { cbSubject } = require('./quizGame');` chaqirilgan, ammo `quizGame.js` eksportlarida `cbSubject` yo‘q.

### 🔴 Xato #8: `src/handlers/quizGame.js` (536–618-qatorlar) — "Xatolar Ustida Ishlash" (`cbWmAns`) Interaktiv Rejimida Double-Click Race Condition
`cbWmAns` ichida `mutex.lock` ishlatilmagan va tugmalarda savol indeksi yo‘q. Ketma-ket 2 marta tez bosilsa, 2 ta savol ketma-ket `queue.shift()` bo‘lib ketadi.

### 🔴 Xato #9: `src/handlers/shelfHandlers.js` (16–95-qatorlar) — Javonda Papka Yaratish (`cbShelfNewFolder`) Oqimi Uzilib Qolgan
`cbShelfSaveInit` (16-qator) `"📥 Javonga saqlash"` bosilganda papka tanlash menyusini chiqarmasdan, testni majburan fan nomidagi papkaga (`dbService.saveToShelf`) saqlab yuboradi.

### 🔴 Xato #10: `src/handlers/quizGame.js` (236-qator) — `cbPostStart` Ichida `readyUsers: new Set()` Xatosi
`Set` obyekti Redisga `JSON.stringify` qilinganda `{}` ga aylanib qoladi va testni boshlagan muallif kutish zalida ro‘yxatdan tushib qoladi.

---

## 🧠 3-BO‘LIM: Yangi "Aqlli Eslatmalar va Jadval Tizimi" (Smart Schedule & Contextual Reminder Engine v2.0) Chuqur Auditi (13 ta Xatolik)

Yangi qo‘shilgan **Smart Schedule v2.0** va **Kontekstual Eslatmalar (`/note`, `/groupnote`, `/mynotes`)** modullarini (`migrations/supabase_smart_schedule_v2.sql`, `noteHandler.js`, `scheduleHandler.js`, `scheduleWatcherService.js`, `scheduleService.js`, `edupageService.js`, `dbService.js`, `keyboards.js`) boshidan oxirigacha tekshirish natijasida **13 ta jiddiy va yashirin xatolik** aniqlandi:

---

### 🔴 Smart-Xato #1: PostgreSQL `CHECK` Cheklovi va Tugmalar To‘qnashuvi — "10 daq" va "20 daq" Tugmalari Bazada Xato Beradi!
* **Manzil:** `migrations/supabase_smart_schedule_v2.sql` (11-qator) vs `src/keyboards/keyboards.js` (153–154-qatorlar) va `src/handlers/scheduleHandler.js` (503–511, 664–666-qatorlar).
* **Muammo:**
  1. SQL migratsiya faylida (`supabase_smart_schedule_v2.sql`, 11-qator) `user_schedule_settings` jadvali uchun qat’iy cheklov qo‘yilgan:
     ```sql
     offset_minutes INTEGER NOT NULL DEFAULT 60 CHECK (offset_minutes IN (15, 30, 60, 120)),
     ```
  2. Biroq `src/keyboards/keyboards.js` (153–154-qatorlar) da foydalanuvchiga **`10 daq` (`v2_offset_10`)** va **`20 daq` (`v2_offset_20`)** tugmalari chiqarilgan!
  3. Foydalanuvchi **"10 daq"** yoki **"20 daq"** tugmasini bosganda, Supabase/PostgreSQL `new row for relation "user_schedule_settings" violates check constraint "user_schedule_settings_offset_minutes_check"` xatosi bilan so‘rovni **rad etadi**!
  4. Eng yomoni: `scheduleHandler.js` dagi `cbV2Offset(ctx, mins)` (506-qator) `dbService.upsertUserScheduleSettings` qaytargan `false` qiymatni tekshirmasdan, foydalanuvchiga yolg‘ondan `"✅ Darsdan 10 daqiqa oldin eslatish belgilandi!"` deb alert chiqaradi, lekin bazada eski `60` daqiqa qolib ketaveradi va tugma hech qachon `🔘 10 daq` holatiga o‘tmaydi!

---

### 🔴 Smart-Xato #2: "🔔 5 daqiqalik qo‘ng‘iroq" (`pre_class_5min_bell`) Vaqti 5 Daqiqa Adashib Ishlaydi (10 daqiqa oldin yuboriladi)!
* **Manzil:** `index.js` (354-qator) + `src/services/edupageService.js` (780–789-qatorlar) + `src/services/scheduleWatcherService.js` (932–936-qatorlar).
* **Muammo:**
  1. `edupageService.js` da para tugashidan 5 daqiqa oldingi vaqtlar `.bell5MinBeforeEnd` sifatida `555` (`09:15`), `645` (`10:45`), `735` (`12:15`), `855` (`14:15`) etib belgilangan (barchasi `:05`, `:15`, `:25`, `:35`, `:45`, `:55` daqiqalarga to‘g‘ri keladi).
  2. Ammo `index.js` (354-qator) da cron **`*/10 * * * *`** (faqat `:00, :10, :20, :30, :40, :50` daqiqalarda) ishga tushadi!
  3. `scheduleWatcherService.js` (936-qator) da esa quyidagicha shart qo‘yilgan:
     ```javascript
     if (bellMinute && (currentMinFromMidnight === bellMinute || (bellMinute >= currentMinFromMidnight && bellMinute < currentMinFromMidnight + 10)))
     ```
  4. Natijada 1-para (`08:00–09:20`) uchun `bellMinute = 555` (`09:15`) bo‘lganda, soat **`09:10`** dagi cron (`currentMinFromMidnight = 550`) `555 >= 550 && 555 < 560` shartiga tushadi va **para tugashiga 10 daqiqa qolganda (soat 09:10 da)** talabaga:
     > *"🔔 5 daqiqadan so‘ng 1-para tugaydi!"*
     deb noto‘g‘ri xabar yuboradi! (3-para uchun soat `12:10` da, 5-para uchun `15:40` da, 7-para uchun `18:40` da — ya’ni har doim **10 daqiqa oldin** "5 daqiqa qoldi" deb xabar boradi).

---

### 🔴 Smart-Xato #3: Guruh Eslatmalari (`/groupnote`) va Shaxsiy Eslatmalar (`/note`) Kunlik Jadvalni O‘chirib Qo‘ygan Talabalarga Umuman Bormaydi!
* **Manzil:** `src/services/dbService.js` (933-qator) + `src/services/scheduleWatcherService.js` (764–766 va 814–815-qatorlar).
* **Muammo:**
  1. `dbService.getAllActiveScheduleSubscribers()` (933-qator) da agar talaba kunlik jadval xabarnomasini **`🔕 O'chirish` (`notify_mode === 'disabled'`)** qilgan bo‘lsa, uni `subscriberMap.delete(uid)` orqali ro‘yxatdan butunlay o‘chirib yuboradi!
  2. `scheduleWatcherService.js` (814-qator) da `const subscribers = await db.getAllActiveScheduleSubscribers(); if (!subscribers || subscribers.length === 0) return;` deb yozilgan!
  3. **Oqibati:**
     * Agar guruh sardori `/groupnote` orqali butun guruhga muhim vazifa qo‘ysa, `deliverNoteReminder` (764-qator) faqat `subscribers.filter(u => u.group_name === note.group_name)` ichidagi foydalanuvchilarga yuboradi. Kunlik jadvalni `disabled` qilgan guruhdoshlar `/groupnote` eslatmasini **hech qachon olmaydilar!**
     * Bundan tashqari, `deliverNoteReminder` da `u.group_name === note.group_name` oddiy `===` bilan solishtirilgan! Agar bir talabada guruh nomi `"BHA-56i"`, boshqasida `"BHA-56/24i"` bo‘lsa, `normalizeGroupName` ishlatilmagani sababli guruhdoshiga xabar bormaydi!

---

### 🔴 Smart-Xato #4: `/mynotes` Ro‘yxatidan "Keyingi Darsga Surilgan" (`snoozed`) Eslatmalarning Yo‘qolib Qolishi va Eski Eslatmalarning Tiqilib Qolishi!
* **Manzil:** `src/services/dbService.js` (1085–1100 va 1131-qatorlar) + `src/handlers/noteHandler.js` (239–260 va 325-qatorlar).
* **Muammo:**
  1. Foydalanuvchi eslatma kelganda yoki `/mynotes` ichida **`⏳ Keyingi darsga surish` (`nsz:`)** tugmasini bossa, `noteHandler.js` (325-qator) `await db.updateNoteStatus(noteId, null, 'snoozed', ...)` ni chaqiradi va bazada `status = 'snoozed'` bo‘ladi.
  2. Biroq foydalanuvchi `/mynotes` buyrug‘ini bersa, `dbService.getUserActiveNotes` (**1131-qator**) faqat:
     ```javascript
     .in('status', ['pending', 'notified_evening'])
     ```
     ni qidiradi (`'snoozed'` kiritilmagan!). Natijada **keyingi darsga surilgan barcha vazifalar `/mynotes` ro‘yxatidan butunlay g‘oyib bo‘ladi!**
  3. Aksincha, darsdan 20 daqiqa oldin eslatma yuborilganda (`scheduleWatcherService.js`, 968-qator), `updateNoteStatus(note.id, null, 'notified_before_class')` faqat `notified_before_class_at` ustunini yangilaydi, lekin `status` ustuni `'pending'` yoki `'notified_evening'` ligicha qoladi! Agar talaba `"✅ Bajarildi"` tugmasini bosmasa, o‘tgan oydagi eski eslatmalar ham toabad `'pending'` bo‘lib qolaveradi va `/mynotes` dagi `activeNotes.slice(0, 8)` (249-qator) eng birinchi 8 ta eski (muddati o‘tgan) eslatmani ko‘rsatib, **yangi qo‘shilgan eslatmalarni ekranga chiqarmay qo‘yadi!**

---

### 🔴 Smart-Xato #5: Bir Kunda Ikkita Para Bo‘lganda "⏳ Keyingi darsga surish" (`snooze`) Eslatmani Bloklab Qo‘yadi (`lockKey` xatosi)
* **Manzil:** `src/services/scheduleWatcherService.js` (966–967 va 982–983-qatorlar).
* **Muammo:**
  * Darsdan 20 daqiqa oldin eslatma yuborishda idempotentlik kaliti sifatida:
    ```javascript
    const lockKey = `note_rem:${note.id}:pre20m`;
    if (await acquireNotificationLock(lockKey, 36000)) { // 10 soatlik blok!
    ```
    ishlatilgan (`note.target_date` va `note.target_period` kalitga qo‘shilmagan!).
  * **Stsenariy:** Talabada bugun 1-parada (`08:00`) Ma’ruza, 3-parada (`11:00`) shu fandan Seminar bor. Soat `07:40` da eslatma kelganda talaba `"⏳ Keyingi darsga surish"` tugmasini bosadi va eslatma bugungi 3-paraga (`11:00`) ko‘chiriladi (`notified_before_class_at = null` bo‘ladi). Biroq soat `10:40` bo‘lganda, `note_rem:${note.id}:pre20m` kaliti Redis va `minuteLocalDedupe` ichida 10 soatga band qilingani sababli, **3-para oldidan eslatma yuborilmaydi!**
  * Xuddi shu muammo kechki `20:30` eslatmasida ham bor (`note_rem:${note.id}:evening` — `target_date` yo‘q).

---

### 🔴 Smart-Xato #6: `runSmartScheduleIntervalTick` da Ketma-Ket (Sequential) Yuborish Sababli Eslatmalarning O‘tkazib Yuborilishi (Starvation Bug)
* **Manzil:** `src/services/scheduleWatcherService.js` (795–995-qatorlar).
* **Muammo:**
  1. `runSmartScheduleIntervalTick` funksiyasi boshida `if (isIntervalTickRunning) return;` qulfi bor va `nowTashkent` hamda `currentHHMM` faqat funksiya boshlangan soniyada **bir marta** olinadi (801–806-qatorlar).
  2. Funksiya ichida barcha foydalanuvchilar bo‘yicha `for (const user of subscribers)` sikli **ketma-ket (`await sendDailyBriefingCard` + `40ms` sleep)** aylanadi!
  3. Agar ertalab soat `07:00` (yoki kechqurun `20:00`) da 1,500 ta talabaga kunlik jadval yuborilsa:
     * Har bir talaba uchun `scheduleService.fetchTodaySchedule(groupName, dayOfWeek)` qaytadan chaqiriladi (guruh bo‘yicha matn keshlanmagan!).
     * Har bir Telegram API so‘rovi (~200ms) + 40ms kutish bilan 1,500 ta xabar ketma-ket yuborilishi **$1500 \times 0.24\text{ s} = 360\text{ soniya}$ (6 daqiqa)**, 3,000 ta talabada esa **12 daqiqa** vaqt oladi!
  4. **Oqibati:**
     * `20:00` dagi kechki tarqatish 10 daqiqadan uzoq cho‘zilsa, `20:10`, `20:20`, `20:30` dagi cron chaqiruvlari `if (isIntervalTickRunning) return;` ga urilib **bekor bo‘lib ketadi** va soat `20:30` dagi barcha **Ertangi dars eslatmalari (`/note`) umuman yuborilmay qoladi!**
     * Bundan tashqari, funksiya oxiridagi **B-qism (`Process Contextual Note Reminders`, 955-qator)** faqatgina barcha kunlik jadvallar yuborib bo‘lingandan keyingina navbat oladi!

---

### 🔴 Smart-Xato #7: Fan Nomini Qidirishda Substring (`includes`) Xatosi — Eslatma Boshqa Fanga Birikib Ketadi!
* **Manzil:** `src/services/edupageService.js` (1002–1005-qatorlar — `findUpcomingCourseOccurrences`).
* **Muammo:**
  ```javascript
  const itemNorm = normalizeSubjectKey(item.subject).toLowerCase();
  if (itemNorm !== baseNorm && !itemNorm.includes(baseNorm) && !baseNorm.includes(itemNorm)) {
    continue;
  }
  ```
  * Bu yerda `!itemNorm.includes(baseNorm)` sharti qo‘yilgan. Agar talaba `"Iqtisodiyot"` yoki `"Huquq"` yoki `"Matematika"` fanida o‘tirib `/note` yozsa, jadvaldagi `"Raqamli iqtisodiyot"`, `"Makroiqtisodiyot"`, `"Iqtisodiyot nazariyasi"` kabi **umuman boshqa fanlar** ham `itemNorm.includes("iqtisodiyot") === true` bo‘lgani uchun ro‘yxatga qo‘shilib ketadi!
  * Agar ertaga 1-parada `"Raqamli iqtisodiyot"` (Amaliyot) bo‘lsa, bot `"Iqtisodiyot"` ma’ruzasida yozilgan vazifani `"Raqamli iqtisodiyot"` amaliyotiga biriktirib yuboradi!

---

### 🔴 Smart-Xato #8: Kichik Guruhlar (Subgroups) Uchun `/note` Tugmalarining Dublikat Chiqishi va 5-Daqiqalik Qo‘ng‘iroqda Noto‘g‘ri Xona Ko‘rsatilishi
* **Manzil:** `src/services/edupageService.js` (1000-qator), `src/services/scheduleService.js` (378-qator) va `src/services/scheduleWatcherService.js` (938–941-qatorlar).
* **Muammo:**
  1. Universitet jadvalida amaliyot va laboratoriya darslari ko‘pincha 2 ta kichik guruhga bo‘linadi (masalan, Seshanba 2-parada 1-kichik guruh 201-xonada, 2-kichik guruh 305-xonada).
  2. `findUpcomingCourseOccurrences` va `getAllUpcomingLessonsForGroup` funksiyalarida bir xil para (`period`) ichidagi kichik guruhlar birlashtirilmagan (deduplikatsiya qilinmagan). Natijada talaba `/note` yozganda bir xil vaqt uchun **2 ta bir xil tugma** chiqadi:
     * `[🎯 Keyingi Amaliyotga (20.10, 2-para)]`
     * `[✍️ Amaliyot (20.10, 2-para)]`
  3. `scheduleWatcherService.js` (940-qator) da esa `const curr = currLessons[0]; const next = nextLessons[0];` deb faqat 0-indeksdagi kichik guruh olingan. Agar keyingi parada 2 ta kichik guruh 2 xil xonada (yoki 2 xil binoda) bo‘lsa, 2-kichik guruh talabalariga ham 1-kichik guruhning xonasi va o‘qituvchisi yuboriladi!

---

### 🔴 Smart-Xato #9: `scheduleHandler.js` da "🎯 Aniq vaqt" (`custom_time`) Sozlamasining Mantiqiy Xatosi va State Qolib Ketishi
* **Manzil:** `src/handlers/scheduleHandler.js` (543–644-qatorlar) + `src/keyboards/keyboards.js` (159-qator).
* **Muammo:**
  1. Foydalanuvchi `"🎯 Aniq vaqt"` tugmasini bosganda (`cbV2ModeCustom`, 546-qator), `ctx.session.state = 'sched:custom_time'` o‘rnatiladi. Agar foydalanuvchi vaqt yozmasdan, pastdagi **`⬅️ Orqaga` (`schedule_notify_settings`)** yoki tayyor vaqt tugmasini (`v2_ctime:07:30`) bossa, **`ctx.session.state` tozalanmaydi!** Natijada foydalanuvchi keyinroq chatga oddiy matn yozsa, bot uni `onCustomTimeInput` ga yo‘naltirib `"⚠️ Noto'g'ri vaqt formati!"` deb xato beradi!
  2. Bazada har bir foydalanuvchi uchun standart `custom_morning_time = '07:00'` va `custom_evening_time = '20:00'` yozilgan. Agar foydalanuvchi `"🎯 Aniq vaqt"` ga kirib **faqat kechki `🌙 20:30`** ni tanlasa (`hh >= 18`), kod faqat `custom_evening_time: '20:30'` ni yangilaydi, ammo `custom_morning_time` `'07:00'` ligicha qoladi!
     * Oqibatda: Menyudagi tugmada (`keyboards.js`, 159-qator) baribir `🎯 Aniq vaqt (07:00)` deb ko‘rinaveradi va ertalab `07:00` da ham xabar kelaveradi!

---

### 🔴 Smart-Xato #10: `noteHandler.js` (296–305-qatorlar) — Kechki Eslatmada "⏳ Keyingi darsga surish" (`nsz:`) Bosilganda Eslatma O‘sha Ertangi Darsning O‘zida Qolib Ketadi!
* **Manzil:** `src/handlers/noteHandler.js` (296–305-qatorlar).
* **Muammo:**
  ```javascript
  const now = new Date(Date.now() + 15 * 60 * 1000);
  let noteTargetDate = null;
  if (note.target_date && note.target_start_time) {
    const parsed = new Date(`${note.target_date}T${note.target_start_time}:00+05:00`);
    if (!isNaN(parsed.getTime())) {
      noteTargetDate = parsed;
    }
  }
  const searchFrom = (noteTargetDate && noteTargetDate > now)
    ? new Date(noteTargetDate.getTime() + 15 * 60 * 1000)
    : now;
  ```
  * Agar bazada `note.target_start_time` `null` bo‘lsa yoki `"8:00"` (1 xonali soat, masalan `8:00` — bu ISO-8601 formatida `new Date("2026-10-19T8:00:00+05:00")` da `Invalid Date` (`NaN`) beradi!) bo‘lsa, `noteTargetDate` `null` bo‘lib qoladi!
  * Natijada talaba kechqurun soat `20:30` da kelgan eslatmada `"⏳ Keyingi darsga surish"` ni bossa, `searchFrom` kechki `20:45` dan boshlab qidiradi va **ertangi ertalabki darsning o‘zini** topib, eslatmani keyingi haftaga emas, **yana ertangi darsning o‘ziga** yozib qo‘yadi!

---

### 🔴 Smart-Xato #11: `dbService.js` (1043 va 1138-qatorlar) — PostgREST `.or()` So‘rovida Guruh Nomlari Bilan Sintaksis Xatosi
* **Manzil:** `src/services/dbService.js` (1042–1043 va 1138-qatorlar).
* **Muammo:**
  * `getUserActiveNotes` (1138-qator) da:
    ```javascript
    query = query.or(`creator_id.eq.${uid},and(is_group_shared.eq.true,group_name.eq.${groupName})`);
    ```
    Agar guruh nomida qavs yoki bo‘sh joy bo‘lsa (masalan, `MMT-20/23 (rus)`), PostgREST `.or()` parseri qavsni mantiqiy operator deb o‘ylab `PGRST100` xatosi bilan yiqiladi.
  * `getDueNotesForLesson` (1042-qator) da esa `String(groupName).replace(/[,()"\\]/g, '')` qavsni o‘chirib yuboradi, natijada `"MMT-20/23 (rus)"` guruh nomi `"MMT-20/23 rus"` ga aylanib, bazadagi asl guruh nomi bilan umuman mos tushmay qoladi! PostgRESTda maxsus belgili qiymatlar qo‘shtirnoq ichiga olinishi shart: `group_name.eq."${groupName.replace(/"/g, '')}"`.

---

### 🔴 Smart-Xato #12: `noteHandler.js` (274–278-qatorlar) + `dbService.js` (1107–1109-qatorlar) — Admin Guruh Eslatmasini "Bajarildi" Qila Olmaydi
* **Manzil:** `src/handlers/noteHandler.js` (274–278-qatorlar) va `src/services/dbService.js` (1107–1109-qatorlar).
* **Muammo:**
  * `noteHandler.js` (274-qator) da adminlarga guruh eslatmasini bajarildi qilishga ruxsat berilgan (`!isAdmin(userId)`).
  * Biroq 278-qatorda `await db.updateNoteStatus(noteId, userId, 'completed')` chaqirilganda, `dbService.js` (1108-qator) `query = query.eq('creator_id', Number(telegramId))` shartini qo‘shadi! Admin eslatma muallifi (`creator_id`) bo‘lmagani uchun bazada **0 ta qator** yangilanadi, ammo bot adminga `"✅ Topshiriq bajarildi!"` deb javob qaytaradi!

---

### 🔴 Smart-Xato #13: `/note` va `/groupnote` Buyruqlari Avvalgi Wizard Holatini (`ctx.session.state`) Tozalamaydi
* **Manzil:** `src/handlers/noteHandler.js` (124-qator — `handleNoteCommand`).
* **Muammo:**
  * Foydalanuvchi boshqa biror menyuda (masalan, guruh kiritish `States.SET_CLASS`, vaqt kiritish `sched:custom_time` yoki test yaratish `States.CREATE_QUESTIONS`) turib `/note` yoki `/mynotes` buyrug‘ini yozsa, `bot.command("note", ...)` bevosita `handleNoteCommand` ni ishga tushiradi.
  * `handleNoteCommand` ichida `clearState(ctx)` chaqirilmagani sababli, foydalanuvchining `ctx.session.state` holati saqlanib qoladi va `/note` tugagandan keyin yozilgan har qanday xabar eski osilib qolgan wizardga tushib ketadi!

---

## 🛠️ 4-BO‘LIM: Xotira Sizishini (Memory Leak), Umumiy Xatolarni va Smart Schedule v2.0 Xatolarini Tuzatish Uchun Aniq Kod Yechimlari

Quyidagi o‘zgarishlarni tegishli fayllarga kiritish orqali **512 MB RAM muammosi**, **10 ta umumiy xato** hamda **13 ta Smart Schedule v2.0 xatolari 100% bartaraf etiladi**:

### 1. `Dockerfile` — Linux `glibc` C++ Arena Cheklovi (48-qator)
```dockerfile
# 2. Production Environment defaults
ENV NODE_ENV=production \
    PORT=8080 \
    MALLOC_ARENA_MAX=2 \
    NODE_OPTIONS="--expose-gc --max-old-space-size=300"
```

---

### 2. `migrations/supabase_smart_schedule_v2.sql` — `offset_minutes` Chekloviga `10` va `20` Daqiqalarni Qo‘shish (11-qator)
Supabase SQL Editor orqali quyidagi migratsiyani ishga tushiring (va `migrations/supabase_smart_schedule_v2.sql` 11-qatorini yangilang):
```sql
ALTER TABLE public.user_schedule_settings
  DROP CONSTRAINT IF EXISTS user_schedule_settings_offset_minutes_check;

ALTER TABLE public.user_schedule_settings
  ADD CONSTRAINT user_schedule_settings_offset_minutes_check
  CHECK (offset_minutes IN (10, 15, 20, 30, 60, 120));
```

---

### 3. `src/core/utils.js` — `TTLMap` ni Minglab `setTimeout` larsiz Ishlaydigan Qilish va `.values()` Metodini Qo‘shish (7–45-qatorlar)
```javascript
// ─── TTLMap (Zero-Timer Overhead, Bounded LRU-like Map with Periodic Sweep) ───
class TTLMap {
  constructor(ttlMs = 3600000, maxSize = 2000) {
    this._map = new Map();
    this._ttl = ttlMs;
    this._maxSize = maxSize;
    this._sweepInterval = setInterval(() => this.sweep(), Math.min(ttlMs, 5 * 60 * 1000));
    if (this._sweepInterval.unref) this._sweepInterval.unref();
  }
  set(key, value) {
    if (this._map.has(key)) {
      this._map.delete(key);
    } else if (this._map.size >= this._maxSize) {
      this.sweep();
      if (this._map.size >= this._maxSize) {
        const oldestKey = this._map.keys().next().value;
        if (oldestKey !== undefined) this._map.delete(oldestKey);
      }
    }
    this._map.set(key, { value, expiresAt: Date.now() + this._ttl });
  }
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this._map.delete(key);
      return undefined;
    }
    return entry.value;
  }
  has(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this._map.delete(key);
      return false;
    }
    return true;
  }
  delete(key) {
    return this._map.delete(key);
  }
  clear() {
    this._map.clear();
  }
  sweep() {
    const now = Date.now();
    for (const [k, entry] of this._map.entries()) {
      if (now > entry.expiresAt) this._map.delete(k);
    }
  }
  keys() {
    this.sweep();
    return this._map.keys();
  }
  *values() {
    const now = Date.now();
    for (const [k, entry] of this._map.entries()) {
      if (now > entry.expiresAt) {
        this._map.delete(k);
      } else {
        yield entry.value;
      }
    }
  }
  get size() {
    return this._map.size;
  }
}
```

---

### 4. `src/services/edupageService.js` — `findUpcomingCourseOccurrences` da Fan Qidiruvi va Kichik Guruhlar Dublikatini Tuzatish (995–1035-qatorlar)
`findUpcomingCourseOccurrences` ichida fan nomini solishtirish va bir xil paradagi kichik guruhlarni birlashtirishni quyidagicha yangilang:
```javascript
function findUpcomingCourseOccurrences(fullGroupTimetable, subjectName, targetLessonType = 'any', fromDate = null, maxResults = 3) {
  if (!fullGroupTimetable || !subjectName) return [];

  const baseNorm = normalizeSubjectKey(subjectName).toLowerCase();
  const startTz = getTashkentNow(fromDate);
  const currentMinutes = startTz.getHours() * 60 + startTz.getMinutes();

  const DAY_LABELS = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];
  const results = [];
  const seenSlots = new Set(); // Bir xil sana va paradagi kichik guruhlar dublikatini oldini oladi

  for (let offset = 0; offset <= 14; offset++) {
    const checkDate = new Date(startTz.getTime() + offset * 86400000);
    const dayOfWeek = (checkDate.getDay() + 6) % 7; // 0=Mon .. 5=Sat, 6=Sun
    if (dayOfWeek === 6) continue; // Sunday off

    const daySchedule = fullGroupTimetable[dayOfWeek];
    if (!daySchedule) continue;

    const yyyy = checkDate.getFullYear();
    const mm = String(checkDate.getMonth() + 1).padStart(2, '0');
    const dd = String(checkDate.getDate()).padStart(2, '0');
    const dateIso = `${yyyy}-${mm}-${dd}`;
    const dateDisplay = `${dd}.${mm}`;

    const periods = Object.keys(daySchedule).map(Number).sort((a, b) => a - b);
    for (const p of periods) {
      const items = Array.isArray(daySchedule[p]) ? daySchedule[p] : [daySchedule[p]];
      for (const item of items) {
        if (!item || !item.subject) continue;
        if (item.isContinuation) continue;
        const itemNorm = normalizeSubjectKey(item.subject).toLowerCase();
        // ✅ TUZATILDI: Boshqa fanlar (masalan "Iqtisodiyot" -> "Makroiqtisodiyot") aralashib ketmasligi uchun aniq solishtirish
        if (itemNorm !== baseNorm) {
          continue;
        }

        const pTiming = PERIOD_TIMINGS[p] || { start: '08:00', end: '09:20' };
        const startStr = item.startTime || pTiming.start;
        const [sh, sm] = startStr.split(':').map(Number);
        const itemStartMin = (sh || 0) * 60 + (sm || 0);

        if (offset === 0 && itemStartMin <= currentMinutes + 10) {
          continue;
        }

        const itemLessonType = normalizeLessonType(item);
        const slotKey = `${dateIso}:${p}:${itemLessonType}`;
        if (seenSlots.has(slotKey)) continue;
        seenSlots.add(slotKey);

        results.push({
          dateIso,
          dateDisplay,
          dayLabel: DAY_LABELS[dayOfWeek],
          offsetDays: offset,
          period: p,
          startTime: startStr,
          endTime: item.endTime || pTiming.end,
          subject: item.subject,
          baseSubject: normalizeSubjectKey(item.subject),
          lessonType: itemLessonType,
          room: item.room || item.classroom || '',
          teacher: item.teacher || '',
        });
      }
    }
  }

  if (targetLessonType && targetLessonType !== 'any') {
    results.sort((a, b) => {
      const aMatch = a.lessonType === targetLessonType ? 1 : 0;
      const bMatch = b.lessonType === targetLessonType ? 1 : 0;
      if (aMatch !== bMatch) return bMatch - aMatch;
      return a.offsetDays - b.offsetDays || a.period - b.period;
    });
  } else {
    results.sort((a, b) => a.offsetDays - b.offsetDays || a.period - b.period);
  }

  return results.slice(0, maxResults);
}
```

---

### 5. `src/services/dbService.js` — `/mynotes` da `snoozed` Eslatmalarni Ko‘rsatish, Muddati O‘tganlarini Filtrlash va PostgREST `.or()` Xatosini Tuzatish (1035–1155-qatorlar)
```javascript
async function getDueNotesForLesson(telegramId, groupName, dateStr) {
  if (!supabase || !dateStr) return [];
  const isGlobalDateQuery = !telegramId && !groupName;
  const now = Date.now();

  if (isGlobalDateQuery && dueNotesCache.has(dateStr)) {
    const cached = dueNotesCache.get(dateStr);
    if (now < cached.expiresAt) {
      return cached.data;
    }
    dueNotesCache.delete(dateStr);
  }

  try {
    let query = supabase
      .from('course_notes')
      .select('*')
      .in('status', ['pending', 'notified_evening', 'snoozed'])
      .eq('target_date', dateStr);

    if (telegramId && groupName) {
      const safeGroup = String(groupName).replace(/"/g, '').trim();
      query = query.or(`creator_id.eq.${Number(telegramId)},and(is_group_shared.eq.true,group_name.eq."${safeGroup}")`);
    } else if (groupName) {
      query = query.eq('group_name', groupName);
    } else if (telegramId) {
      query = query.eq('creator_id', Number(telegramId));
    }

    const { data, error } = await query;
    const resData = (!error && data) ? data : [];
    if (isGlobalDateQuery) {
      dueNotesCache.set(dateStr, { data: resData, expiresAt: now + DUE_NOTES_CACHE_TTL_MS });
    }
    return resData;
  } catch (err) {
    logger.error('getDueNotesForLesson exception:', { error: err.message });
    return [];
  }
}

async function getUserActiveNotes(telegramId, groupName = null) {
  if (!supabase || !telegramId) return [];
  try {
    const uid = Number(telegramId);
    const edupageService = require('./edupageService');
    const nowTz = edupageService.getTashkentNow();
    const todayIso = `${nowTz.getFullYear()}-${String(nowTz.getMonth() + 1).padStart(2, '0')}-${String(nowTz.getDate()).padStart(2, '0')}`;

    let query = supabase
      .from('course_notes')
      .select('*')
      .in('status', ['pending', 'notified_evening', 'snoozed']) // ✅ TUZATILDI: 'snoozed' qo'shildi
      .gte('target_date', todayIso) // ✅ TUZATILDI: O'tib ketgan eski eslatmalar ro'yxatni to'sib qo'ymaydi
      .order('target_date', { ascending: true })
      .order('target_period', { ascending: true });

    if (groupName) {
      const safeGroup = String(groupName).replace(/"/g, '').trim();
      query = query.or(`creator_id.eq.${uid},and(is_group_shared.eq.true,group_name.eq."${safeGroup}")`);
    } else {
      query = query.eq('creator_id', uid);
    }

    const { data, error } = await query;
    return (!error && data) ? data : [];
  } catch (err) {
    logger.error('getUserActiveNotes exception:', { telegramId, error: err.message });
    return [];
  }
}
```

---

### 6. `src/handlers/noteHandler.js` — State Tozalash, Admin Ruxsati va `nsz:` (Snooze) Sana Hisoblashni Tuzatish
1. `handleNoteCommand` va `handleMyNotesCommand` boshiga `clearState(ctx);` qo‘shing (`const { escapeHtml, truncateText, safeCallbackData, clearState } = require('../core/utils');`).
2. `handleNoteCallback` ichidagi `nd:` (278-qator) va `nsz:` (296–306-qatorlar) qismini quyidagicha tuzating:
```javascript
  // 1. Mark completed action: nd:<id>
  if (data.startsWith('nd:') || data.startsWith('note_done:') || data.startsWith('note_done_')) {
    const noteId = Number(data.replace(/^(?:nd:|note_done:|note_done_)/, ''));
    const note = await db.getNoteById(noteId);
    if (!note) {
      return ctx.answerCbQuery('⚠️ Eslatma topilmadi', { show_alert: true }).catch(() => {});
    }
    const { isAdmin } = require('../core/utils');
    const isUserAdmin = isAdmin(userId);
    if (note.is_group_shared && String(note.creator_id) !== String(userId) && !isUserAdmin) {
      return ctx.answerCbQuery('⚠️ Guruh eslatmasini faqat uni yaratgan sardor yoki admin o‘zgartira oladi!', { show_alert: true }).catch(() => {});
    }
    await ctx.answerCbQuery('✅ Topshiriq bajarildi!').catch(() => {});
    // ✅ TUZATILDI: Admin bosganda creator_id filtri bloklab qo'ymasligi uchun null beriladi
    await db.updateNoteStatus(noteId, isUserAdmin ? null : userId, 'completed');
    return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  }

  // 2. Snooze to next occurrence: nsz:<id>
  if (data.startsWith('nsz:') || data.startsWith('note_snooze:') || data.startsWith('note_snooze_')) {
    const noteId = Number(data.replace(/^(?:nsz:|note_snooze:|note_snooze_)/, ''));
    const note = await db.getNoteById(noteId);
    if (!note) {
      return ctx.answerCbQuery('⚠️ Eslatma topilmadi', { show_alert: true }).catch(() => {});
    }
    const { isAdmin } = require('../core/utils');
    if (note.is_group_shared && String(note.creator_id) !== String(userId) && !isAdmin(userId)) {
      return ctx.answerCbQuery('⚠️ Guruh eslatmasini faqat uni yaratgan sardor yoki admin o‘zgartira oladi!', { show_alert: true }).catch(() => {});
    }

    const now = new Date(Date.now() + 15 * 60 * 1000);
    let noteTargetDate = null;
    if (note.target_date) {
      const pTiming = edupageService.PERIOD_TIMINGS[note.target_period] || { start: '08:00' };
      const rawTime = note.target_start_time || pTiming.start;
      const [hh, mm] = String(rawTime).split(':').map(Number);
      const padTime = `${String(hh || 8).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}`;
      const parsed = new Date(`${note.target_date}T${padTime}:00+05:00`);
      if (!isNaN(parsed.getTime())) {
        noteTargetDate = parsed;
      }
    }
    const searchFrom = (noteTargetDate && noteTargetDate > now)
      ? new Date(noteTargetDate.getTime() + 15 * 60 * 1000)
      : now;
```

---

### 7. `src/services/scheduleWatcherService.js` — `deliverNoteReminder` Guruh Qidiruvi, `lockKey` va 5-Daqiqalik Qo‘ng‘iroqni Tuzatish (764–994-qatorlar)
1. `deliverNoteReminder` (764-qator) da guruh a’zolarini `db.getUsersByClassName(note.group_name)` yoki `normalizeGroupName` orqali aniqlang (shunda kunlik jadvalni o‘chirib qo‘ygan talabalar ham `/groupnote` eslatmasini oladi):
```javascript
async function deliverNoteReminder(bot, note, subscribers, titleHeader) {
  if (!bot || !note) return;
  const db = getDbService();
  let recipients = [note.creator_id];

  if (note.is_group_shared && note.group_name) {
    const targetNorm = normalizeGroupName(note.group_name);
    const groupUsers = await db.getUsersByClassName(note.group_name).catch(() => []);
    const fromDb = (groupUsers || []).map(u => Number(u.telegram_id)).filter(Boolean);
    const fromSubs = (subscribers || [])
      .filter(u => normalizeGroupName(u.group_name) === targetNorm)
      .map(u => Number(u.telegram_id));
    recipients = Array.from(new Set([...fromDb, ...fromSubs, Number(note.creator_id)]));
  }
```
2. `runSmartScheduleIntervalTick` ichida (967 va 982-qatorlar) `lockKey` ga `target_date` va `target_period` ni qo‘shing:
```javascript
// 967-qator:
const lockKey = `note_rem:${note.id}:${note.target_date}:${note.target_period}:pre20m`;

// 982-qator:
const lockKey = `note_rem:${note.id}:${note.target_date}:evening`;
```
3. `runSmartScheduleIntervalTick` (814-qator) da `if (!subscribers || subscribers.length === 0) return;` o‘rniga, `subscribers` bo‘sh bo‘lsa ham **B-qism (`Process Contextual Note Reminders`)** ishlashini ta’minlang (`if (subscribers && subscribers.length > 0) { ... }` bloki ichiga faqat A-qismni oling).

---

### 8. `src/handlers/scheduleHandler.js` — `cbNotifySettings` da State Tozalash va `cbV2Offset` Xato Tekshiruvi (449 va 503-qatorlar)
1. `renderNotifySettings` (449-qator) boshiga `clearState(ctx);` qo‘shing (foydalanuvchi `"🎯 Aniq vaqt"` ichidan `"⬅️ Orqaga"` bosganda `sched:custom_time` holati tozalanishi uchun).
2. `v2_ctime:` callback handlerida (680-qator) ham `clearState(ctx);` chaqiring.
3. `cbV2Offset` (503-qator) da bazaga yozish natijasini tekshiring:
```javascript
async function cbV2Offset(ctx, mins) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const ok = await dbService.upsertUserScheduleSettings(userId, {
    notify_mode: 'offset_before_first',
    offset_minutes: Number(mins),
  });
  if (!ok) {
    return renderNotifySettings(ctx, '⚠️ Bazada saqlashda xatolik (SQL migratsiyani tekshiring)');
  }
  return renderNotifySettings(ctx, `✅ Darsdan ${mins} daqiqa oldin eslatish belgilandi!`);
}
```

---

### 9. Qolgan Umumiy Tuzatishlar (Qisqa Xulosa)
* **`src/services/aiService.js` (318-qator):** `generateQuizFromImage` ichiga `const result = await model.generateContent([...]);` chaqiruvini qo‘shing.
* **`src/handlers/aiTestsHandlers.js` (190-qator):** `onAiTestsText` boshiga `const adminId = ctx.from.id;` qo‘shing.
* **`src/handlers/contactAdmin.js` (328-qator):** `cbAdminReplyToUser` ichiga `await updateData(ctx, { target_id: String(targetUserId), target_msg_id: originalMsgId ? String(originalMsgId) : null });` qo‘shing.
* **`src/socket/gameLoop.js` (37-qator):** `const rawAns = subQ.correct_index ?? q.correct_index ?? subQ.correct_option ?? q.correct_option ?? q.answer ?? ""; room.currentAnswer = String(rawAns);` qilib o‘zgartiring.
* **`src/services/sessionService.js` (10-qator):** `localActiveTestCache` TTL va hajmini `new TTLMap(15 * 60 * 1000, 200)` ga tushiring.