# Changelog

Barcha muhim o'zgarishlar, yangilanishlar va xavfsizlik yaxshilanishlari ushbu hujjatda qayd etib boriladi.

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
