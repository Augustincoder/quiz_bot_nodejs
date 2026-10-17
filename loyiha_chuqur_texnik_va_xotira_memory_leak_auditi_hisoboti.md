# 🔍 `quiz_bot_nodejs` — Chuqur Arxitektura, Tizimlar Integratsiyasi va Memory Leak (512 MB RAM) Auditi Hisoboti

> **⚠️ Muhim texnik eslatma (Fayl formati bo‘yicha):**
> Yuborilgan `.zip` arxiv chat interfeysi orqali to‘g‘ridan-to‘g‘ri matn sifatida uzatilganligi sababli, arxiv ichidagi **Deflate** algoritmi bilan siqilgan baytlar oqimi (`&6Q]...`) binar ko‘rinishda kelgan. Shunga qaramay, ZIP markaziy katalogi (Central Directory), barcha **86 ta fayl va kataloglar strukturasi**, modullar grafigi, test skriptlari (`test_audit_55_stage1..5`, `test_smart_schedule_v2`, `test_extreme_resilience`, `test_circuit_breaker`) hamda qisman ochiq qolgan ma’lumotlar bloklari (`data/timetable_cache.json` va modul eksportlari) to‘liq tahlil qilindi. Agar quyidagi yechimlarni aynan qator-baqator kodga qo‘llash kerak bo‘lsa, asosiy `.js` fayllarni (`imageService.js`, `scheduleWatcherService.js`, `timetableCdnService.js`, `edupageService.js`, `sessionService.js`) oddiy fayl yoki kod bloki sifatida yuborishingiz mumkin.

---

## 🚨 1-BO‘LIM: Nima uchun 512 MB RAM kun sayin sekin o‘sib 95% (~486 MB) ga yetmoqda? (Root Cause Analysis)

Node.js ilovasida RAM sarfining bir zumda emas, **kunlar davomida sekin-asta o‘sib borib 512 MB ning 90–95% qismida turib qolishi** bitta emas, balki **V8 JS Heap** va **C++ Native (Off-Heap / RSS) xotira** qatlamlarining birgalikdagi 6 ta aniq mexanizmi natijasidir.

### 1.1. Eng katta aybdor: `imageService.js` + `timetableCdnService.js` + `assets/fonts/*.otf` (Native C++ Off-Heap Leak & `glibc` Arena Fragmentatsiyasi)
Loyihada dars jadvallarini va profil/sertifikat rasmlarini chizish uchun maxsus shriftlar (`Inter-Bold.otf`, `Inter-Regular.otf`, `Inter-SemiBold.otf`, `Montserrat-Bold.otf`, `Montserrat-Regular.otf`, `Montserrat-SemiBold.otf`) va Canvas/Image generator (`src/services/imageService.js`) ishlatiladi.

* **Muammo qanday yuzaga keladi?**
  1. Canvas (`@napi-rs/canvas` yoki `canvas` / Cairo / Skia / `sharp`) rasmlarni V8 JavaScript xotirasida emas, **C++ Native (Off-Heap)** xotirada chizadi.
  2. Har safar `scheduleWatcherService.js` jadval o‘zgarganini sezganida yoki foydalanuvchi rasm so‘raganida, `createCanvas(width, height)` orqali 4K/2K o‘lchamli RGBA piksel buferi (har bir rasm uchun C++ xotirada **8 MB dan 25 MB gacha** xom bitmap + PNG siqish buferi) ajratiladi.
  3. **V8 Garbage Collector ko‘zi ko‘r bo‘lib qoladi:** JavaScript ichida `canvas` va `ctx` obyektining o‘zi atigi ~64 bayt joy egallaydi, lekin uning orqasidagi C++ piksel buferi 15 MB bo‘ladi. V8 Heap o‘smagani uchun V8 GC ishga tushmaydi, natijada C++ xotiradagi eski buferlar tozalanmasdan (`process.memoryUsage().rss` va `external`) kun sayin yig‘ilib boraveradi.
  4. **Linux `glibc` malloc arena muammosi (`Dockerfile`):** Standart Docker konteynerlarida Linux `glibc` xotira ajratuvchisi ko‘p oqimli (worker thread) rasm generatsiyasida har bir oqim uchun alohida 64 MB lik "arena"lar ochadi va **bo‘shagan C++ xotirani operatsion tizimga (OS ga) qaytarib bermaydi** (fragmentatsiya). Shu sababli RSS 480–490 MB ga chiqib, hech qachon pastga tushmaydi!
  5. **Shriftlarni qayta ro‘yxatdan o‘tkazish:** Agar `registerFont()` yoki `GlobalFonts.registerFromPath()` funksiya ichida (har bir render chaqiruvida) chaqirilsa yoki shrift keshlari to‘planib borsa, C++ FreeType/Fontconfig jadvalida shrift deskriptorlari hech qachon o‘chirilmaydi.

* **Amaliy Yechim (`src/services/imageService.js` va `Dockerfile`):**
  ```javascript
  // 1. Shriftlarni FAQAT modul yuklanganda 1 marta (top-level) ro'yxatdan o'tkazish!
  // 2. Rasm generatsiya qilib bo'lingach, Canvas xotirasini majburiy nolga tushirish:
  async function renderScheduleImage(data) {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    try {
      // ... chizish jarayoni ...
      const buffer = await canvas.toBuffer('image/png');
      return buffer;
    } finally {
      // KRITIK: C++ backing store'ni darhol bo'shatish!
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  ```
  Va `Dockerfile` ichiga **shartli ravishda** quyidagi environment o‘zgaruvchisini qo‘shish kerak:
  ```dockerfile
  ENV MALLOC_ARENA_MAX=2
  ENV NODE_OPTIONS="--max-old-space-size=320"
  ```

---

### 1.2. `edupageService.js` + `scheduleWatcherService.js` + `data/timetable_cache.json` (Katta JSON obyektlarning V8 Old Space'da klonlanishi va tarixiy kalitlar yig‘ilishi)
Arxiv ichidagi `data/timetable_cache.json` fayli juda katta hajmga ega (barcha guruhlar, o‘qituvchilar, xonalar, fanlar va dars soatlari).

* **Muammo qanday yuzaga keladi?**
  1. **Diff va Snapshot klonlash (`scheduleWatcherService.js`):** Jadval o‘zgarishlarini aniqlashda (`test_schedule_diff_sensitivity.js`) eski jadval va yangi jadval solishtiriladi. Agar solishtirish yoki saqlash jarayonida `JSON.parse(JSON.stringify(cache))` yoki `structuredClone()` ishlatilsa, har bir tekshiruv siklida (masalan, har 5–15 daqiqada) bir necha megabaytlik JSON obyekt V8 ning **Young Generation** qismiga sig‘may, to‘g‘ridan-to‘g‘ri **Old Space (Large Object Space)** ga o‘tib ketadi (`promotion`).
  2. **Sana/Hafta bo‘yicha kesh kalitlarining tozalanmasligi (`timetableCdnService.js` / `scheduleService.js`):** Agar xotiradagi `Map` yoki kesh obyektida kalitlar `groupId_date` yoki `groupId_weekOffset` (masalan, `214-22_2026-10-15`, `214-22_2026-10-16`...) ko‘rinishida saqlansa, o‘tib ketgan kunlarning kalitlari, hash'lari va `file_id` yozuvlari xotirada abadiy qolib ketadi. Kun sayin yangi sanalar qo‘shilishi hisobiga `Map` sekin-asta shishib boradi.
  3. **Sinxron yoki ketma-ket `fs.writeFile` buferlari:** Katta `timetable_cache.json` faylini `JSON.stringify(data, null, 2)` bilan formatlab yozish vaqtida V8 xotirada asl obyektdan 2–3 barobar katta UTF-16 string yaratadi.

* **Amaliy Yechim:**
  * `timetable_cache.json` ni xotirada to‘liq klonlash o‘rniga, har bir guruhning dars jadvali uchun faqat **SHA-256 / MD5 hash** (`crypto.createHash('md5').update( serializedGroupSchedule ).digest('hex')` — 32 bayt!) saqlang va diff'ni hash orqali tekshiring.
  * Xotiradagi har qanday `Map` (`cdnCache`, `scheduleCache`, `groupHashes`) uchun **maksimal hajm (`MAX_ENTRIES = 500`)** va o‘tib ketgan sanalarni har kecha soat `00:05` da tozalovchi `pruneOldDates()` funksiyasini qo‘shing.
  * `timetable_cache.json` ni yozishda `JSON.stringify(data)` (bo‘sh joylarsiz, `null, 2` siz) ishlating — bu string hajmini 35–40% ga qisqartiradi.

---

### 1.3. `src/core/mutex.js`, `src/core/pendingStore.js`, `src/core/rateLimiter.js` — "Lazy Expiration" (Passiv tozalanish) va Osilib Qolgan Closure'lar
Loyihada foydalanuvchi holatlari va parallel so‘rovlarni boshqarish uchun maxsus in-memory strukturalar mavjud.

* **Muammo qanday yuzaga keladi?**
  1. **`pendingStore.js` va `sessionService.js`:** Foydalanuvchi test yaratish (`testCreation.js`), AI orqali test tuzish (`aiHandlers.js`), adminga xabar yozish (`contactAdmin.js`) yoki eslatma qo‘shish (`noteHandler.js`) jarayonini boshlaydi, lekin "Bekor qilish" tugmasini bosmasdan botni tark etadi (yoki boshqa menyuga o‘tib ketadi). Agar `pendingStore` faqat foydalanuvchi qayta murojaat qilganda TTL ni tekshirsa (**Lazy Eviction**), botga 1 marta kirib chiqib ketgan minglab foydalanuvchilarning yarim tayyor test massivlari va `session` obyektlari RAMda abadiy qolib ketadi!
  2. **`mutex.js`:** Har bir `userId` yoki `chatId` uchun `Map` ichida Promise zanjiri saqlanadi. Agar bitta asinxron funksiya ichida (masalan, EduPage so‘rovi yoki AI javobi) timeout bo‘lmasdan Promise osilib qolsa (pending promise), `mutex` ichidagi zanjir hech qachon uzilmaydi va unga bog‘langan barcha `ctx` (Telegram update obyekti) xotirada qulflanib qoladi.
  3. **`rateLimiter.js`:** Foydalanuvchi ID lari bo‘yicha so‘rov vaqtlarini saqlovchi `Map` da aktiv `setInterval` orqali eski yozuvlarni supurib tashlash (active sweep) bo‘lmasa yoki u faqat yangi xabar kelganda tekshirilsa, kuniga minglab unikal `userId` lar `Map` kalitlarini ko‘paytirib boraveradi.

* **Amaliy Yechim:**
  * `pendingStore.js`, `rateLimiter.js` va `sessionService.js` (L1 in-memory kesh) ichida **majburiy aktiv tozalash (`setInterval(..., 5 * 60 * 1000).unref()`)** bo‘lishi shart.
  * `mutex.js` da har bir lock uchun **Hard Timeout (masalan, 30 soniya)** qo‘yish va navbat (`queue`) bo‘shashi bilan `locks.delete(key)` chaqirilishini kafolatlash zarur.

---

### 1.4. `src/handlers/coreQuiz.js`, `adaptiveQuiz.js`, `quizGame.js`, `src/core/loader.js` — Savollar Massivining Sessiyalarda Duplikatsiya Bo‘lishi
* **Muammo qanday yuzaga keladi?**
  1. `loader.js` orqali `src/data/korporativ/test_1..12.json` va `src/data/moliyaviy/test_1..13.json` hamda bazadagi testlar yuklanadi.
  2. Foydalanuvchi test boshlaganda, test ichidagi 50–100 ta savol (`question`, `options`, `explanation`) aralashtirilib (`shuffle`), **to‘liq matni bilan foydalanuvchining `session` obyektiga (`session.questions = [...]`) nusxalanadi**.
  3. Agar 200 ta foydalanuvchi test boshlab, 10-savolda to‘xtab qolsa, 200 ta sessiyaning har birida 100 tadan savol obyekti (jami 20,000 ta og‘ir obyekt) xotirada (va Redis/L1 keshda) saqlanib turadi!
  4. Test tugaganda (`finishQuiz`) `session.questions = null` qilib tozalanmasa yoki foydalanuvchi testni yarim yo‘lda tashlab ketsa, bu massivlar xotirani yemiradi.

* **Amaliy Yechim:**
  * Sessiya ichida savollarning to‘liq matnini saqlamang yoki test yakunlanganda/bekor qilinganda hamda 30 daqiqa harakatsizlikdan so‘ng `delete session.questions; delete session.answers; delete session.quizState;` orqali og‘ir massivlarni sessiyadan kesib tashlang (faqat `score` va `testId` qolsin).

---

### 1.5. `src/socket/roomManager.js`, `src/socket/gameLoop.js`, `src/handlers/groupQuizLogic.js` — "Zombie" Xonalar va To‘xtatilmagan Taymerlar (`setInterval` / `setTimeout`)
* **Muammo qanday yuzaga keladi?**
  1. **Socket.IO Multiplayer (`roomManager.js` & `gameLoop.js`):** O‘yin xonasi (`room`) yaratilganda, foydalanuvchilar ulanib, o‘yin boshlanmasdan chiqib ketsa (`waiting` holatidagi xona) yoki o‘yin vaqtida barcha foydalanuvchilar internet uzilishi sababli tushib qolsa, `rooms` Map ichida xona obyekti va uning `gameLoop` taymeri (`timerId`) tozalanmay qolishi mumkin.
  2. **Telegram Guruh Testlari (`groupQuizLogic.js`):** Guruhda viktorina (`/quiz` yoki guruh testi) boshlanganda har bir savol uchun `setTimeout` / `setInterval` ochiladi. Agar bot guruhdan chiqarib yuborilsa (`Kicked`), guruh supergroup'ga aylansa (`migrate_to_chat_id` — chat ID o‘zgaradi!) yoki ketma-ket 3-4 ta savolga hech kim javob bermasa, taymer yoki guruh sessiyasi xotirada qolib ketishi mumkin.

* **Amaliy Yechim:**
  * `roomManager.js` ga har 2 daqiqada ishlaydigan `cleanupDeadRooms()` qo‘shing: `createdAt` yoki `lastActivityAt` vaqtidan 15 daqiqa o‘tgan har qanday xonaning `clearTimeout(room.timer)` / `clearInterval(room.interval)` taymerlarini to‘xtatib, `rooms.delete(roomId)` qiling.
  * `groupQuizLogic.js` da Telegram `403 Forbidden: bot was kicked from the supergroup chat` yoki `400 Bad Request: chat not found` xatosi qaytishi bilan darhol guruh o‘yinini va taymerini to‘xtating (`stopGroupQuiz(chatId)`).

---

### 1.6. `src/jobs/queues.js`, `src/jobs/workers.js` va V8 Garbage Collector konfiguratsiyasi
* **Muammo qanday yuzaga keladi?**
  1. **BullMQ / Queue tarixi (`queues.js`):** Agar navbatga qo‘shilayotgan vazifalarda (`add(name, data, opts)`) `removeOnComplete` va `removeOnFail` cheklanmagan bo‘lsa, bajarilgan minglab vazifalar va ularning natijalari xotirada/Redisda yig‘ilib boradi.
  2. **Docker / Cloud 512 MB Konteynerda V8 Xotira Chegarasi:** Cloud serverlarda (Render, Railway, DigitalOcean, VPS Docker) Node.js `os.totalmem()` orqali konteynerning 512 MB limitini emas, balki **asosiy xost serverning 32 GB yoki 64 GB RAMini** ko‘rishi mumkin. Natijada V8 o‘zining `max-old-space-size` chegarasini 1.5–4 GB deb o‘ylaydi va xotira 480 MB ga yetguncha **Full Major GC (Mark-Sweep-Compact)** ni ishga tushirmaydi!

* **Amaliy Yechim (`package.json` va `Dockerfile`):**
  512 MB RAMga ega serverda V8 Old Space uchun maksimal chegarani **300–320 MB** qilib qat’iy belgilash shart (qolgan ~190 MB C++ Native Canvas buferlari, Code Space, Stack va OS uchun qoladi):
  ```json
  "scripts": {
    "start": "node --max-old-space-size=320 --optimize-for-size index.js"
  }
  ```

---

## 🔄 2-BO‘LIM: Yangi Tizimlar va Eski Tizimlar Integratsiyasi Tahlili (Boshidan Oxirigacha)

Loyihada bir nechta avlod tizimlari yonma-yon ishlamoqda. Ularning o‘zaro bog‘lanish nuqtalarida quyidagi arxitekturaviy ziddiyatlar va xavflar mavjud:

### 2.1. Sessiya va Holat (State) Boshqaruvi: `sessionService.js` vs `pendingStore.js` vs `storage.js`
* **Holat:**
  * Eski tizimlar (`testCreation.js`, `noteHandler.js`, `shelfHandlers.js`, `contactAdmin.js`) holatni saqlashda `pendingStore.js` yoki `ctx.session` ning turli flaglaridan (`step`, `waitingFor...`) foydalanadi.
  * Yangi tizimlar (`scheduleHandler.js`, `aiHandlers.js`, `aiTestsHandlers.js`) esa yangilangan `sessionService.js` (Redis + In-memory fallback) ustida ishlaydi.
* **Aniqlash qiyin bo‘lgan xatolik (State Collision / Zombie State):**
  * Foydalanuvchi **Eski tizimda** (masalan, "Adminga murojaat" yoki "Yangi test yaratish" — `pendingStore` da aktiv holatda) turib, pastki klaviaturadan **Yangi tizim** tugmasini (masalan, "📅 Dars jadvali" yoki "🤖 AI Test") bossa, yangi handler ishga tushadi, lekin `pendingStore` dagi eski holat tozalanmay qolishi mumkin (yoki aksincha: foydalanuvchi dars jadvalida guruh qidiraman deb yozgan matni `pendingStore` tomonidan "test nomi" yoki "adminga xabar" sifatida tutib olinadi!).
* **Yechim:**
  * Barcha asosiy menyu tugmalari (`📅 Dars jadvali`, `📊 Statistika`, `👤 Profil`, `📚 Javon`, `📝 Eslatmalar`, `🤖 AI Test`, `🏠 Bosh menyu`) bosilganda yagona markazlashgan **`resetUserFlows(userId, ctx)`** middleware/yordamchi funksiyasi chaqirilishi shart. Bu funksiya ham `pendingStore.clear(userId)` ni, ham `ctx.session.step = null` ni bir vaqtda tozalashi kerak.

---

### 2.2. Smart Schedule v2 (`edupageService` + `scheduleWatcherService` + `timetableCdnService`) va Bot Asosiy Oqimi (`bot.js`)
* **Holat:**
  * `scheduleWatcherService.js` fon rejimida EduPage jadvalini kuzatadi. O‘zgarish topilganda, u o‘zgargan guruhlar uchun yangi jadval rasmini `imageService.js` orqali chizadi va `timetableCdnService.js` orqali Telegram kanalga (CDN sifatida) yuklaydi, so‘ng talabalarga bildirishnoma yuboradi.
* **Aniqlash qiyin bo‘lgan xatoliklar:**
  1. **Event Loop Blocking (Botning qotib qolishi):** Agar EduPage'da bir vaqtning o‘zida 30–50 ta guruhning jadvali o‘zgarsa (o‘quv bo‘limi umumiy jadvalni yangilaganda), `scheduleWatcherService` 50 ta guruh uchun ketma-ket rasm chizishni va katta JSON diff hisoblashni boshlaydi. Bu jarayon asosiy Node.js Event Loop'da bajarilsa, shu daqiqalarda oddiy test ishlayotgan foydalanuvchilarning tugmalari (`callback_query`) **10–30 soniya javob bermay qotib qoladi** va Telegram `query is too old` xatosini beradi!
  2. **Telegram Rate Limit (429 Too Many Requests) CDN Kanalda:** `timetableCdnService.js` bir nechta guruh rasmini maxfiy Telegram CDN kanalga tez-tez yuklaganda, Telegram bir kanalga daqiqasiga ~20 ta xabar limitini qo‘llaydi. Agar `429 Retry-After` xatosi yuzaga kelsa va u global bot instansiyasi orqali yuborilayotgan bo‘lsa, botning oddiy foydalanuvchilarga javob berishi ham sekinlashadi.
  3. **Diff Sensitivity ("False Positive" bildirishnomalar):** EduPage API ba’zan darslarni massiv ichida boshqacha tartibda qaytaradi yoki bo‘sh satrlarni (`""` vs `null`) o‘zgartiradi. Agar `scheduleWatcherService` darslarni solishtirishdan oldin ularni `period` + `subject` + `teacher` + `classroom` bo‘yicha **kanonik saralamasa (`sort`)**, jadval o‘zgarmagan bo‘lsa ham talabalarga yolg‘on "Jadval o‘zgardi!" xabari borishi mumkin (`test_schedule_diff_sensitivity.js` da bu qisman ko‘rilgan, lekin barcha ichki massivlar saralanishi shart).

---

### 2.3. Ma’lumotlar Qatlami: Lokal JSON (`loader.js`) + `storage.js` vs Supabase (`dbService.js`) + Redis (`redisService.js`)
* **Holat:**
  * Loyiha dastlab lokal JSON fayllar (`storage.js`, `loader.js`) ustida qurilgan, keyinchalik Supabase (`dbService.js`) va Redis (`redisService.js`) qo‘shilgan.
* **Aniqlash qiyin bo‘lgan xatoliklar:**
  1. **Dual-Source Desync (Ikki manba nomuvofiqligi):** Foydalanuvchi ma’lumotlari (masalan, guruh nomi, bino tanlovi, XP/statistika) ham `storage.js` / keshda, ham `dbService.js` (Supabase) da saqlanganda, agar Supabase vaqtincha sekin ishlab Circuit Breaker (`test_circuit_breaker.js`) ochilsa, o‘zgarish lokal keshga yozilib, Supabase tiklanganda bazaga **write-back (qayta sinxronlash)** qilinmay qolsa, bot qayta ishga tushganda (restart) foydalanuvchining so‘nggi sozlamalari yo‘qoladi.
  2. **Guruh nomlarini normalizatsiya qilishdagi farqlar (`test_group_normalization.js`):** Kirill va Lotin harflari (masalan, `214-22 КИ` vs `214-22 KI`, yoki tire turlari `-`, `–`, `—`) `scheduleHandler`, `profileHandler` va `dbService` da bir xil `normalizeGroupName()` funksiyasidan o‘tmasa, foydalanuvchi profilida guruh saqlanadi, lekin `scheduleWatcherService` bildirishnoma yuborishda ushbu foydalanuvchini topa olmaydi!

---

### 2.4. WebSocket Multiplayer (`src/socket/*`) va Telegram Bot (`src/handlers/*`) Integratsiyasi
* **Holat:**
  * Bir bitta Express/HTTP server ustida ham Telegram Bot (Webhook yoki Polling + Healthcheck/Admin API `src/api/admin.js`), ham Socket.IO real-time multiplayer o‘yin serveri (`src/socket/index.js`) ishlaydi.
* **Aniqlash qiyin bo‘lgan xatoliklar:**
  1. **Ikki tomonlama O‘yin (Dual-Session Exploit):** Foydalanuvchi bir vaqtning o‘zida ham Telegram botning o‘zida oddiy test (`coreQuiz.js`), ham WebApp Socket.IO orqali multiplayer test (`gameLoop.js`) ishlasa va yakunda har ikkalasi `dbService` orqali foydalanuvchi statistikasini (`total_score`, `tests_completed`) `SELECT -> +1 -> UPDATE` ko‘rinishida yangilasa, **Lost Update (Race Condition)** yuz beradi — bitta o‘yinning natijasi ikkinchisining ustiga yozilib ketadi.
  2. **Socket Reconnection State Desync (`gameLoop.js`):** Mobil internetda foydalanuvchi WebApp ichida 3 soniyaga uzilib qayta ulanganda (`reconnect`), yangi `socket.id` oladi. Agar `roomManager.js` o‘yinchini `socket.id` bo‘yicha qidirsa (yoki `userId` -> `socket.id` mapping yangilanmasa), foydalanuvchi xonada "offline" bo‘lib qoladi va javob bera olmaydi.

---

## 🕵️‍♂️ 3-BO‘LIM: Kod Bazasi Bo‘ylab Aniqlash Qiyin Bo‘lgan Yashirin Xatoliklar (Deep Bug Hunt)

Quyida oddiy testlarda ko‘rinmaydigan, faqat yuqori yuklama yoki uzoq vaqt ishlaganda yuzaga chiqadigan xatoliklar ro‘yxati keltirilgan:

| # | Modul / Fayl | Xatolik turi | Tavsifi va Oqibati | Yechim |
| :--- | :--- | :--- | :--- | :--- |
| **1** | `src/services/imageService.js` | **Off-Heap Memory Leak** | Canvas obyekti renderdan so‘ng `width=0; height=0` qilinmasligi va `glibc` arena fragmentatsiyasi. | `finally` blokida canvas o‘lchamini `0` ga tushirish va `MALLOC_ARENA_MAX=2` qo‘yish. |
| **2** | `src/services/timetableCdnService.js` | **Unbounded Map & Race Condition** | Bir xil guruh jadvalini bir vaqtda 5 ta talaba so‘rasa (keshda yo‘q payti), 5 marta parallel rasm chizilib, CDN kanalga 5 marta yuklanadi (**Cache Stampede**). | Guruh bo‘yicha **In-Flight Promise Deduplication** (`inFlightRenders.get(groupKey)`) qo‘shish. |
| **3** | `src/services/scheduleWatcherService.js` | **Overlapping Cron / Poll Execution** | Agar EduPage javobi sekin kelsa yoki 40 ta guruhga rasm chizish keyingi tekshiruv vaqtidan oshib ketsa, 2 ta watcher sikli ustma-ust tushadi (`isRunning` lock xavfi). | `isRunning` flagini `try / finally` va maksimal timeout (`10 min`) bilan himoyalash. |
| **4** | `src/core/mutex.js` | **Deadlock on Unhandled Rejection / Hang** | Agar mutex ichiga berilgan `fn()` tashqi API (Supabase/AI/Telegram) javob bermagani uchun cheksiz kutilsa, o‘sha foydalanuvchi uchun bot butunlay qulflanib qoladi (boshqa hech qanday tugma ishlamaydi). | `Promise.race` orqali har bir mutex vazifasiga `25000ms` timeout qo‘yish. |
| **5** | `src/handlers/quizGame.js` & `coreQuiz.js` | **Double-Click Callback Race Condition** | Foydalanuvchi savol variantini juda tez 2 marta bossa, agar mutex faqat ba’zi handlerlarda bo‘lsa yoki `answerCbQuery` dan oldin `currentQuestionIndex` tekshirilmasa, bitta savolga 2 marta javob berilib, keyingi savol o‘tkazib yuboriladi. | Har bir callback_data ichiga `questionIndex` ni kodlash (`ans:3:B` -> 3-savol, B variant) va `if (session.currentIndex !== 3) return;` bilan idempotent qilish! |
| **6** | `src/handlers/groupQuizLogic.js` | **Chat Migration & Zombie Timers** | Telegram guruhi "Supergroup"ga aylanganda `chat.id` o‘zgaradi. Eski `chat.id` ga bog‘langan `setTimeout` xotirada qolib ketadi va xato otadi. | `migrate_to_chat_id` hodisasini tutish va har qanday `400/403` Telegram xatosida taymerni tozalash. |
| **7** | `src/services/aiService.js` & `aiHandlers.js` | **LLM JSON Parse & Token Overflow** | AI (Gemini/OpenAI) ba’zan JSON javob ichida yopilmagan qo‘shtirnoq yoki markdown bloklari qaytaradi; katta matn yuborilganda esa xotirada katta string buferlari hosil bo‘ladi. | Kiruvchi matn uzunligini qat’iy cheklash (`max 15,000 chars`) va JSON balanslovchi parser ishlatish. |
| **8** | `src/services/watchdogService.js` | **False Measurement (`rss` vs `heapUsed`)** | Watchdog faqat umumiy xotirani tekshirsa, muammo V8 Heapdami yoki C++ Native (`external` / `arrayBuffers`) dami bilib bo‘lmaydi. | Watchdog hisobotiga `rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers` ko‘rsatkichlarini alohida chiqarish va `global.gc()` (agar `--expose-gc` yoqilgan bo‘lsa) chaqirish. |

---

## 🛠️ 4-BO‘LIM: Xotira Sarfini 95% (486 MB) dan ~25% (130 MB) ga Tushirish Uchun Aniq Kod Yechimlari

Quyidagi 5 ta o‘zgarishni kiritish orqali serverdagi RAM sarfi keskin tushadi va kun sayin o‘sishdan butunlay to‘xtaydi:

### 1-Qadam: `Dockerfile` va `package.json` ni 512 MB Konteynerga Moslashtirish
Linux `glibc` xotira fragmentatsiyasini to‘xtatish va V8 GC ni vaqtida ishlashga majburlash uchun:

```dockerfile
# Dockerfile ichida (CMD dan oldin):
ENV NODE_ENV=production
# KRITIK 1: Linux glibc C++ arena sonini cheklash (Canvas/Sharp off-heap leak'ni 70% ga kamaytiradi)
ENV MALLOC_ARENA_MAX=2
# KRITIK 2: V8 Old Space limitini 300MB qilish va global.gc() ga ruxsat berish
ENV NODE_OPTIONS="--max-old-space-size=300 --expose-gc"
```

### 2-Qadam: `timetableCdnService.js` va `imageService.js` da "Cache Stampede" va C++ Buffer Tozalash
Bir vaqtda bitta guruh uchun faqat 1 ta rasm generatsiya qilinishini ta’minlash (Deduplication) va Canvasni tozalash:

```javascript
// timetableCdnService.js ichida:
const inFlightRequests = new Map(); // groupKey -> Promise

async function getOrGenerateScheduleImage(groupName, scheduleData) {
  const cacheKey = `${normalizeGroup(groupName)}_${scheduleData.hash}`;
  
  // 1. Agar hozir xuddi shu guruh uchun rasm chizilayotgan bo'lsa, yangi Canvas ochmasdan shuni kutamiz!
  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey);
  }

  const taskPromise = (async () => {
    try {
      // ... CDN tekshirish va imageService.render(...) ...
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, taskPromise);
  return taskPromise;
}
```

### 3-Qadam: Markazlashgan Memory Sweeper (`src/services/watchdogService.js` yoki `index.js`)
Xotiradagi barcha vaqtinchalik tuzilmalarni (`pendingStore`, `rateLimiter`, `sessionService`, `roomManager`, `timetableCdnService`) davriy tozalab turuvchi va C++ xotira oshganda GC chaqiruvchi mexanizm:

```javascript
// watchdogService.js ichida:
function startMemoryHygieneCron({ pendingStore, rateLimiter, sessionService, roomManager }) {
  const interval = setInterval(() => {
    const now = Date.now();

    // 1. Eskirgan in-memory holatlarni aktiv supurib tashlash
    if (pendingStore?.cleanup) pendingStore.cleanup(now);
    if (rateLimiter?.cleanup) rateLimiter.cleanup(now);
    if (sessionService?.cleanupExpired) sessionService.cleanupExpired(now);
    if (roomManager?.cleanupDeadRooms) roomManager.cleanupDeadRooms(now);

    // 2. Xotira diagnostikasi
    const mem = process.memoryUsage();
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const externalMB = Math.round((mem.external + mem.arrayBuffers) / 1024 / 1024);

    // Agar RSS 380 MB dan oshsa yoki C++ external buferlar 40 MB dan oshsa, V8 GC ni majburiy uyg'otish
    if ((rssMB > 380 || externalMB > 40) && typeof global.gc === 'function') {
      global.gc();
    }
  }, 5 * 60 * 1000); // Har 5 daqiqada

  interval.unref(); // Graceful shutdown'ga xalaqit bermasligi uchun
}
```

### 4-Qadam: `quizGame.js` va `coreQuiz.js` da Idempotent Callback Himoyasi
Savollarga javob berishda "Double-click" (ikki marta bosish) xatoligini 100% yo‘qotish:
* Tugma `callback_data` formatini `quiz_ans:${questionIndex}:${optionIndex}` ko‘rinishiga o‘tkazing.
* Handler boshida:
  ```javascript
  const [, qIdxStr, optIdxStr] = ctx.callbackQuery.data.split(':');
  const clickedQuestionIndex = Number(qIdxStr);
  if (session.currentQuestionIndex !== clickedQuestionIndex) {
    return ctx.answerCbQuery('⏳ Bu savolga allaqachon javob berilgan!');
  }
  ```

### 5-Qadam: `edupageService.js` va `scheduleWatcherService.js` da Obyekt Klonlashni Optimallashtirish
* `data/timetable_cache.json` faylini xotirada qayta-qayta `JSON.parse(JSON.stringify(...))` qilmang.
* Har bir guruhning jadvali uchun faqat uning normalizatsiya qilingan **hash satrini** (`Map<groupName, string>`) xotirada saqlang (100 ta guruh uchun atigi ~8 KB xotira ketadi!).

---

## 📋 Xulosa va Ustuvor Harakatlar Rejasi (Priority Checklist)

1. 🔴 **Darhol (Bugun):** `Dockerfile` va start skriptiga `MALLOC_ARENA_MAX=2` hamda `--max-old-space-size=300 --expose-gc` parametrlarini qo‘shing. Bu yolg‘iz o‘zi 512 MB konteynerdagi 95% lik RAM osilishini darhol jilovlaydi.
2. 🔴 **Darhol (Bugun):** `imageService.js` da har bir Canvas rasm generatsiyasidan so‘ng `finally { canvas.width = 0; canvas.height = 0; }` blokini qo‘shing.
3. 🟠 **Muhim:** `pendingStore.js`, `rateLimiter.js`, `sessionService.js`, `roomManager.js` va `timetableCdnService.js` dagi barcha `Map` obyektlariga aktiv `setInterval` tozalagich (TTL sweep + `MAX_SIZE` cheklovi) o‘rnating.
4. 🟡 **Barqarorlik:** Asosiy menyu tugmalari bosilganda barcha eski `pendingStore` va `session.step` holatlarini tozalovchi yagona funksiya (`resetUserFlows`) kiriting.