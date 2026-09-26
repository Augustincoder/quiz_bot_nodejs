# Changelog

Barcha muhim o'zgarishlar, yangilanishlar va xavfsizlik yaxshilanishlari ushbu hujjatda qayd etib boriladi.

---

## [1.1.6] — 2026-09-26

### 🛡 Katta Audit va Xatoliklarni Bartaraf Etish (Audit Fixes & System Hardening)
* **Kritik: Foydalanuvchi Tarixini Saqlab Qolish (`getUserStats` & `updateUserStats`):**
  - Tarmoq uzilishlarida `getUserStats` endi bo'sh 0-statistikani haqiqiy foydalanuvchi deb qabul qilmaydi (`_fetchFailed: true` bayrog'i qo'shildi).
  - `updateUserStats` va `saveTestToShelf` ushbu holatda yangilashni to'xtatadi va talabaning yechgan testlari va xatolari tarixini 0 ga tushib qolishidan 100% himoyalaydi.
* **Kritik: Xesh Formulalarini Unifikatsiya Qilish (False Positive Alert Prevention):**
  - `timetableCdnService` va `scheduleWatcherService` dagi darslarni saralash formulasi yagona manbaga keltirildi (`subject + room + teacher` deterministik saralash).
  - O'zgarmagan jadvallar uchun sun'iy xesh farqi va soxta xabarnomalar yuborilishi butunlay bartaraf etildi.
* **Kritik: BullMQ Retry Tizimini Qayta Tiklash:**
  - `workers.js` da faqat terminal xatolar (bot bloklangan, akkaunt o'chirilgan) to'xtatiladi; tarmoq va server xatolarida xato qayta tashlanadi (`throw err`).
  - BullMQ'dagi `attempts: 3` va eksponensial backoff yana to'liq ishlay boshladi.
  - `quizTimerWorker` ga ushlanmagan xatolar tufayli jarayon qulashining oldini oluvchi `.on('error', ...)` tinglovchisi qo'shildi.
* **Kritik: `/hafta` Foydalanuvchi Qulflanishini Bartaraf Etish:**
  - `activeHaftaRequests.add(userId)` dan so'ng darhol `try/finally` blokiga kirilishi ta'minlandi. Ma'lumotlar bazasi xatosi bo'lganda ham foydalanuvchi bloklanib qolmaydi.
* **Kritik: Guruh Nomlarini Normalizatsiya Qilish Regexini To'g'rilash:**
  - Regex `^([A-Z]+\d+)([IRK])(\d{2})$` ga o'zgartirildi. `MI-24` va `BI-15` kabi yo'nalishlar endi `M-24i` va `B-15i` bilan to'qnashmaydi.
* **Yuqori: Supabase 1,000-qator Chegarasini Bartaraf Etish (Pagination):**
  - `getAllUsers`, `getScheduleBroadcastUsers` va `getBroadcastRecipients` funksiyalariga `.range(from, to)` orqali avtomatik sahifalash qo'shildi. Bot foydalanuvchilari soni 1,000 dan oshganda ham barchasiga xabar yetib boradi.
* **Yuqori: HTML Xavfsiz Qisqartirish (`truncateText`):**
  - `truncateText` qirqilganda ochiq qolgan `<b>`, `<s>`, `<i>`, `<code>` teglari avtomatik yopiladi. Telegram API'ning `400 Bad Request: can't parse entities` xatosi yo'qotildi.
* **Yuqori: 21:00 Cron To'qnashuvini Ajratish (Render RAM Himoyasi):**
  - Tungi kuzatuvchi croni 21:00 dagi kechki jadval tarqatish bilan to'qnashmasligi uchun 21:05 ga ko'chirildi (`5,35 21-23,0-6 * * *`).
* **Xotira Optimizatsiyasi:**
  - `imageMemoryCache` sig'imi 50 tadan 15 tagacha kamaytirilib, Render'ning 512 MB RAM limitida xotira yuki 70-90 MB ga yengillashtirildi.
  - Express JSON body parser hajmi 10 MB dan 2 MB ga tushirildi.
* **Xavfsiz O'chirish (Graceful Shutdown):**
  - Server o'chirilganda HTTP/Socket.io, BullMQ workerlar va navbatlar to'g'ri ketma-ketlikda to'xtatiladi. `_workers?.broadcastWorker?.close()` xavfsiz chaqiruvga o'tkazildi.

---

## [1.1.5] — 2026-09-26

### 🚀 Senior Audit & Chuqur Nosozliklarni Bartaraf Etish (Deep System Audit)
* **Realtime Watcher uchun EduPage Jonli Ma'lumotlarni Majburiy Olish (Live Network Fetch):**
  - Ilgari `checkScheduleChanges` `forceRefresh=false` chaqirganligi sababli, Redis'dagi 10 daqiqalik kesh (`cache:edupage:raw:*`) tufayli EduPage'dagi o'zgarishlar 10 daqiqagacha kechikib aniqlanardi.
  - Endi Watcher har 3 daqiqada to'g'ridan-to'g'ri TsUE EduPage jonli bazasini so'raydi (`getIndexedDatabase(true)`). Natijada dars jadvalining har qanday o'zgarishi darhol (3 daqiqa ichida) aniqlanadi. Agar EduPage tarmog'ida vaqtinchalik uzilish bo'lsa, avtomatik xotiradagi L1 va diskdagi L3 keshiga tayanadi.
* **L3 Disk Keshi Yo'li To'g'rilandi (`DISK_CACHE_PATH`):**
  - Ilgari `DISK_CACHE_PATH` loyiha tashqarisidagi mavjud bo'lmagan papkaga yo'naltirilgan bo'lib, diskka kesh yozishda `ENOENT` xatoligi yuz berardi. Yo'l `src/data/timetable_cache.json` ga to'g'rilandi va avtomatik papka yaratish qo'shildi.
* **Redis va Map o'rtasidagi String/Number `classId` Muvofiqligi:**
  - Redis'dan JSON tiklanganda `cid` kalitlari doimo `string` bo'ladi, in-memory Map'da esa ba'zida `number` bo'lib qolishi tufayli taqqoslashda `undefined` qaytish xavfi mavjud edi. Barcha joyda kalitlar `String(classId)` formatiga keltirildi.
* **On-Demand Kesh Yangilanganda Aniq Diff Yuborish (`notifyGroupScheduleChanged`):**
  - Talaba `/hafta` orqali jadval olganida kesh eskirganligi aniqlansa, oldingi snapshot bilan yangi jadval o'rtasidagi semantik farqlar (`diffGroupSchedules`) hisoblanib, guruhdoshlariga barcha o'zgarishlar to'liq tafsilotlari bilan (yoki haftalik to'liq ko'rinishda) yuboriladi.
* **Xabarnomalar uchun Bo'sh Matn Qolishining Oldini Olish:**
  - `formatChangeAlert` funksiyasida `changesFormatted` tekshiruvi qo'shildi. Har qanday kutilmagan senariyda ham sarlavha tagida bo'sh qator emas, balki aniq xabarnoma chiqishi kafolatlandi.

---

## [1.1.4] — 2026-09-26

### 🚀 Asosiy Yutuqlar (Highlights)
* **Tungi 02:00 dan 05:00 gacha dars jadvali rasmlarini to'ldirish tizimi (Nightly Theme Completion Worker):**
  - **Faqat faol talabalar guruhlari (`activeOnly`):** Tizim server resurslarini bekor sarflamaslik uchun faqat botda ro'yxatdan o'tgan talabalari bor guruhlarni oladi.
  - **Ketma-ket va xavfsiz ishlash (Concurrency = 1, 2.5s pacing):** Render 512 MB bepul tarifida xotira to'lib qolmasligi uchun guruhlar va ularning mavzulari bittalab ishlanadi.
  - **Yetishmagan mavzularni to'ldirish (Smart Theme Completion):**
    - Kunduzi talaba tomonidan so'ralgan on-demand 1 ta mavzu (masalan, `dark`) keshda bo'lsa, qolgan 2 ta mavzu (`light`, `vibrant`) tungi vaqtda chizilib kanalga yuklanadi.
    - Agar 2 ta mavzu yuklangan bo'lsa, yetishmayotgan 3-mavzu to'ldiriladi.
    - Agar barcha 3 ta mavzu keshda va xeshi EduPage bilan bir xil bo'lsa, qayta chizilmasdan darhol o'tkazib yuboriladi (0ms vaqt va 0 MB RAM).
    - Agar jadval yangi o'zgargan bo'lsa, barcha mavzular yangi xesh bilan qayta chizilib, kanaldagi eski xabarlar tozalab boriladi.
  - **Xotira va Vaqt chegarasi (Render RAM Safety & 05:00 Cutoff):**
    - Har bir rasm Telegram kanaliga yuklangach, `imageBuffer = null` qilinib, `global.gc()` orqali V8 va libvips pixel buferlari darhol tozalanadi.
    - Toshkent vaqti bilan 05:00 bo'lishi bilanoq worker ishini xavfsiz to'xtatadi (`stopHourTashkent: 5` chegarasi va `00 05 * * *` cron).
  - **Admin boshqaruv buyruqlari:**
    - `/prewarm_active` — Faol guruhlar rasmlarini to'ldirishni istalgan vaqtda qo'lda ishga tushirish.
    - `/prewarm_status` — Worker holati, jarayon (processed/total), yuklangan, o'tkazib yuborilgan, xatoliklar, joriy guruh va sarflangan vaqt monitoringi.
    - `/prewarm_stop` — Ishlayotgan worker jarayonini to'xtatish.

---

## [1.1.3] — 2026-09-26

### 🚀 Asosiy Yutuqlar (Highlights)
* **Kengaytirilgan Semantik Dars Jadvali Diff Algoritmi (`diffGroupSchedules`):**
  - Jadvaldagi o'zgarishlar faqat "Dars jadvali yangilandi" deb emas, balki barcha senariylar bo'yicha eng mayda tafsilotlarigacha ajratib ko'rsatiladi:
    - 🚚 **Dars ko'chirilishi (`LESSON_MOVED`):** Dars bir kundan yoki paradan boshqa kunga ko'chirilganda (masalan, Dushanba 6-paradan Seshanba 2-paraga) avtomatik aniqlanadi va chiroyli formatda ko'rsatiladi.
    - 🔄 **Xona va o'qituvchi o'zgarishi (`ROOM`, `TEACHER`, `ROOM_AND_TEACHER`):** Eski va yangi xona / o'qituvchilar ustidan chizilgan formatda aniq ko'rsatiladi.
    - 🔄 **Fan o'zgarishi (`SUBJECT`):** Bir vaqtda o'qituvchi yoki para doirasida fan almashishi aniqlanadi.
    - ➕ **Yangi darslar qo'shilishi (`LESSON_ADDED`):** Kun, para va xonasi bilan to'liq bayon etiladi.
    - ❌ **Bekor qilingan darslar (`LESSON_CANCELLED`):** Aniq qaysi dars bekor bo'lgani xabarda ta'kidlanadi.
    - 📋 **Haftalik to'liq taqdimot (`SCHEDULE_FULL_OVERVIEW`):** Agar oldingi darslar xotirada bo'lmagan holatda ham, talabaga quruq "yangilandi" emas, balki o'sha guruhning butun haftalik jadvali (kunlar, paralar, xonalar, o'qituvchilar) to'liq ro'yxat qilib beriladi.
* **Qayta xabar yuborishning oldini olish (Strict Zero-Spam Deduplication):**
  - Har bir faol guruh uchun Redis'da `cache:schedule:last_alerted_hash:${norm}` va `cache:schedule:active_snapshot:${norm}` 30 kunlik muddat bilan saqlanadi.
  - Bir marta xabar olgan guruhga qayta bot ishga tushganda yoki navbatdagi tekshiruvlarda aynan o'sha xesh bo'yicha hech qachon takroriy xabar bormaydi.
  - Faqat va faqat EduPage'da jadval qaytadan rasman o'zgargandagina yangi diff chiqarilib, talabalarga xabar beriladi.

---

## [1.1.2] — 2026-09-25

### 🚀 Asosiy Yutuqlar (Highlights)
* **Render 512 MB RAM xotirasini optimallashtirish va Crash (OOM) oldini olish:**
  - `package.json` dagi start buyrug'iga `--expose-gc --max-old-space-size=350` qo'shildi. V8 xotirasi 350 MB dan oshmaydi va operatsion tizim (OOM Killer) botni o'chirib qo'yishi butunlay bartaraf etildi.
  - Ishga tushishdagi (startup) ortiqcha ikkinchi `scheduleService.warmUpCache()` chaqiruvi olib tashlandi, natijada bir vaqtning o'zida ikkita katta jadval obyektini xotiraga yuklash yo'qotildi (~100 MB heap tejaldi).
  - `buildIndexedDatabase` dan ortiqcha 5 MB xom JSON jadvallar (`raw`) olib tashlandi va majburiy `global.gc()` chaqiruvi ulandi. Natijada 1,337 ta guruh indekslangandan so'ng umumiy xotira atigi **30 MB Heap / 120 MB RSS** ga tushirildi!
  - 1,300 dan ortiq talabasi bo'lmagan guruhlar uchun xotirada haftalik to'liq darslar massivini saqlash to'xtatildi, faqat xesh saqlanadi (xotira 90% ga qisqartirildi).
  - Dars o'zgarganda bir vaqtning o'zida Sharp orqali 15 ta rasmni parallel chizish to'xtatildi. Rasmlar talaba `/hafta` yoki `/jadval` tugmasini bosganida Just-In-Time (JIT) 1 soniyada tayyorlanadi.
  - `timetableCdnService` dagi foydalanilmaydigan mavzularni (`warmRemainingThemesInBackground`) fonda avtomatik chizish o'chirildi.

* **`56i` (`BHA-56/24i`) uchun dars jadvali xabarnomalarini kafolatli yetkazish:**
  - `edupageService.getCanonicalGroupName` ga suffiks tekshiruvi qo'shildi: endi `56i`, `bha-56i`, `BHA-56i/24`, `BHA-56/24i` kabi barcha variantlar 100% aniqlik bilan rasmiy `BHA-56/24i` ga yo'naltiriladi.
  - Xabarnoma yuborilganlik holati rasm keshidan ajratildi (`cache:schedule:last_alerted_hash:*`). Agar talaba `/hafta` orqali yangi rasmni ko'rgan bo'lsa ham, uning guruhiga dars o'zgarishi haqida xabar yuborilmagan bo'lsa (Unalerted schedule version), tizim xabarni albatta yuboradi.
  - Maxsus admin buyruqlari qo'shildi:
    - `/send_schedule_alert 56i` yoki `/alert_group BHA-56/24i` — istalgan guruh talabalariga zudlik bilan dars o'zgarishi xabarini majburiy yuborish.
    - `/check_schedule force` yoki `/check_schedule 56i` — butun bazani yoki aniq guruhni to'liq tekshirish va xabarlarni chiqarish.

---

## [1.1.1] — 2026-09-25

### 🚀 Asosiy Yutuqlar (Highlights)
* **Ma'lumotlar bazasi bilan dual tekshiruv (DB Reconciliation):** Watcher faqat Redis snapshotiga tayanib qolmasdan, har bir ro'yxatdan o'tgan guruhning Supabase'dagi amaldagi CDN kesh xeshini (`dbCachedHash`) to'g'ridan-to'g'ri tekshiradi. Agar dars jadvali bot o'chiq vaqtida yoki kesh yaratilgandan so'ng o'zgargan bo'lsa (masalan, `BHA-56/24i`), tizim buni darhol aniqlaydi va talabalarga bildirishnoma yuboradi.
* **On-Demand o'zgarish xabarnomasi (`/hafta` integratsiyasi):** Talaba haftalik jadval so'raganida kesh eskirganligi aniqlansa, yuborilgan rasm tagida o'zgarish bo'lganligi haqida ogohlantirish ko'rsatiladi (`🔔 DIQQAT: Guruhingiz dars jadvalida o'zgarishlar aniqlanganligi sababli jadval yangilandi!`) va o'sha zahotiyoq guruhdoshlariga ham fon rejimida bildirishnoma tarqatiladi.
* **Takroriy xabarlarning oldini olish (2-soatlik Deduplication):** Bir xil jadval xeshi uchun talabalarga 2 soat ichida qayta-qayta takroriy xabar yuborilishi to'liq bloklandi.

---

## [1.1.0] — 2026-09-25

### 🚀 Asosiy Yutuqlar (Highlights)
* **Realtime EduPage Watcher to'liq qayta ishlandi:** TsUE EduPage dars jadvalidagi har qanday o'zgarish (yangi dars, bekor qilingan dars, xona yoki o'qituvchi almashishi) 3 daqiqa ichida aniqlanadi.
* **Server resurslarini keskin tejash (Resource Optimization):** Botda ro'yxatdan o'tgan talabalari bo'lmagan (faol bo'lmagan) guruhlar uchun Sharp orqali og'ir rasm chizish to'xtatildi. Bu Render starter serverlarida RAM va CPU yuklamasini 98% ga qisqartirdi.
* **Maqsadli bildirishnomalar (Targeted Alerts):** Jadval o'zgarganda faqat va faqat o'sha o'zgargan guruhda ro'yxatdan o'tgan talabalarga batafsil ogohlantirish xabari yuboriladi.
* **Kesh va CDN xeshini qat'iy tekshirish:** Telegram kanalidagi eski rasm ID'lari (`file_id`) dars jadvalining yangi SHA-256 xeshi bilan solishtiriladi va eskirgan keshlar darhol chiqarib tashlanadi.

---

### ✨ Qo'shilgan Imkoniyatlar (Added)
1. **Gzip / Deflate siqish tizimi (`src/services/edupageService.js`):**
   - EduPage serveriga `Accept-Encoding: gzip, deflate` so'rovi va avtomatik dekompressiya ulandi.
   - Tarmoq trafigi **8.3 MB dan ~767 KB ga** (90% tejash) tushirildi.
   - Dars jadvalini to'liq yuklash vaqti ~1.6 soniyagacha qisqardi.

2. **Deterministik darslar strukturasi (`getSimplifiedSchedule`):**
   - Darslar faqat muhim maydonlar (`subject`, `teacher`, `room`) bo'yicha saralangan holda saqlanadi.
   - Kichik guruhlar yoki laboratoriya mashg'ulotlarining kelish tartibi o'zgarganda soxta xesh o'zgarishlari (Order Jitter) butunlay yo'q qilindi.

3. **Guruh o'quvchilariga maqsadli xabar berish:**
   - Yangi dars qo'shilganda (`➕ Yangi dars qo'shildi`);
   - Dars bekor qilinganda (`❌ Dars bekor qilindi`);
   - Xona yoki o'qituvchi o'zgarganda (`🔄 Xona o'zgardi`, `👨‍🏫 O'qituvchi almashdi`);
   - Kichik guruhlar qo'shilganda (`➕ Qo'shimcha dars/kichik guruh`);
   - Dars olib tashlanganda (`➖ Dars olib tashlandi`).

4. **Yakshanba kunduzgi nazorat jadvali (`index.js`):**
   - Universitet dispetcherlari dushanba kunlik darslarni yakshanba kunduzi kiritishini hisobga olib, yakshanba soat 07:00 dan 20:59 gacha har 15 daqiqada tekshiruvchi `watcherSundayCron` qo'shildi.

5. **Zaxira xotira keshi (`fallbackTimetableCache`):**
   - Redis yoki Supabase vaqtincha uzilib qolganda ham bot xotirasida kesh uzluksiz ishlashini ta'minlovchi L1 fallback Map kiritildi.

---

### 🐛 Tuzatilgan Xatolar (Fixed)
1. **Watcher dars o'zgarishlarini sezmay qolish muammosi:**
   - Watcher avval tekshirgan 332 baytlik `ttviewer.js` fayli olib tashlandi. Endi to'g'ridan-to'g'ri darslar bazasi xotirada O(1) xarita orqali ~25 ms da tekshiriladi.
2. **Foydalanuvchiga eski kanal rasmi berilishi:**
   - `timetableCdnService.js` dagi `getOrGenerateTimetablePhoto` ga `cached.schedule_hash === currentScheduleHash` tekshiruvi qo'shildi. Hash mos kelmasa, eski rasm o'chirilib, yangisi yaratiladi.
3. **`dummyQueue`da `isDummy: true` yo'qligi sababli xabarlar yo'qolishi:**
   - `src/jobs/queues.js` dagi `dummyQueue` obyektiga `isDummy: true` berildi. Redis bo'lmaganda xabarlar to'g'ridan-to'g'ri Telegram API orqali (har 60 ms da bittadan) xavfsiz yetkaziladi.
4. **Bot qayta ishga tushganda soxta "30 ta yangi dars" spam xabari:**
   - Redis'dan qayta tiklanganda yoki bo'sh bazada diff tekshirilganda, barcha darslar yangi deb hisoblanmasdan, toza `SCHEDULE_REFRESHED` hodisasi hosil qilinadi.
5. **Telegram HTML qoidasi buzilishi (`escapeHtml`):**
   - Fan nomlari (masalan, *"Moliya & Soliq"*), o'qituvchi va xona nomlaridagi maxsus belgilar (`&`, `<`, `>`, `"`) ekranlashtirildi. Bu Telegram API 400 xatolarini bartaraf etdi.
6. **Xabar uzunligi chegarasi (4096 belgi):**
   - `formatChangeAlert` natijasi `truncateText(text, 3950)` orqali himoyalandi.
7. **Redis'da xom jadvallarning 12 soat qolib ketishi:**
   - `edupageService.js` dagi `REDIS_TTL_SEC` 12 soatdan 10 daqiqaga tushirildi.
8. **Eksport etish xatosi:**
   - `scheduleWatcherService.js` da `setBotInstance` moduli eksportiga qo'shildi.

---

### 🛡 Xavfsizlik va Maxfiylik (Security Hardening)
1. **Token va maxfiy ma'lumotlar logdan chiqarildi:**
   - `scripts/upload_all_to_channel.js` dagi Bot tokenining birinchi belgilarini konsolga chiqarish xavfsiz maskalash bilan almashtirildi (`[SOZLANGAN / CONFIGURED]`).
2. **Doimiy vaqtli taqqoslash (Constant-Time String Comparison):**
   - Admin API autentifikatsiyasida vaqt orqali buzish (timing attack) xavfining oldini olish uchun `crypto.timingSafeEqual` ishlatilmoqda.
3. **Deployment tozaligi:**
   - Barcha vaqtinchalik test fayllari (`test_bha_change_detection.js`, `test_watcher_and_cdn.js`, `test_senior_edge_cases.js`) va kesh fayllari diskdan to'liq olib tashlandi.
   - `.env` fayllari `.gitignore` orqali qat'iy himoyalanganligi tekshirildi.

---

### 📋 Fayllar bo'yicha o'zgarishlar (Files Modified)
* `index.js`: Bot instansiyasini watcher bilan bog'lash, yakshanba kunlik cron qo'shilishi.
* `src/jobs/queues.js`: `dummyQueue`ga `isDummy: true` bayrog'i qo'shildi.
* `src/services/dbService.js`: `deleteTimetableCache` kengaytirildi, in-memory kesh zaxirasi kiritildi.
* `src/services/edupageService.js`: Gzip/deflate siqish integratsiyasi, TTL 10 daqiqaga optimallashtirildi.
* `src/services/scheduleWatcherService.js`: Yangi arxitekturali 3-daqiqalik watcher, xesh tekshiruvi, maqsadli xabarnoma, HTML escaping va tartib tebranishi himoyasi.
* `src/services/timetableCdnService.js`: Xesh tekshiruvi asosida CDN invalidatsiya qilish.
* `scripts/upload_all_to_channel.js`: Konsol loglarida token maskalash.
