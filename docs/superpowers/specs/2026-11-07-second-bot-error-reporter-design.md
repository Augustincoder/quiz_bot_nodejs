# Design Document: Second Bot Error Reporting System

## 1. Intent & Why
Foydalanuvchi `.env` fayliga `SECOND_BOT` o'zgaruvchisi orqali ikkinchi Telegram bot tokenini kiritgan. Loyihadagi barcha xatoliklar (qizil loglar, `logger.error`, `uncaughtException`, `unhandledRejection`, `bot.catch`, Express va worker xatolari) ushbu ikkinchi bot orqali avtomatik ravishda `ADMIN_ID` ga yuborilishi kerak. Maqsad — server loglarini qo'lda tekshirmasdan ham har qanday nosozlikni real vaqtda Telegram orqali bilish.

## 2. Goals & Anti-Goals
### Goals:
- Butun loyihadagi 174 dan ortiq `logger.error` chaqiriqlarini hech qanday faylni qo'lda tahrirlamasdan markaziy tarzda ushlash.
- Barcha global xatoliklarni (`process.on('uncaughtException')`, `process.on('unhandledRejection')`, `bot.catch`, Express va BullMQ) qamrab olish.
- Telegram xabari formatini chiroyli va tushunarli qilish:
  - 🚨 Xatolik sarlavhasi va darajasi
  - 📅 Toshkent vaqti (`Asia/Tashkent`)
  - 🏷 Xatolik matni (error message)
  - 📍 Stack trace (kod qayerda to'xtagani)
  - 📊 Qo'shimcha metadata/kontekst
- **Anti-flood & Deduplication**: Bir xil xatolik ketma-ket yuz bersa (masalan, baza uzilib qolsa), admin lichkasiga sekundiga o'nlab xabar borib spamlashmasligi uchun 60 soniyalik oyna ichida bir xil xatoni guruhlash va sanash.
- **Telegram Limits & Formatting**: Telegramning 4096 belgilik chekloviga mos holda matnni xavfsiz qirqish, HTML maxsus belgilarini (`<`, `>`, `&`) to'g'ri escape qilish.
- **Zero Crash & Recursion Guard**: Xatolikni Telegramga yuborishda xatolik yuz bersa (masalan internet uzilsa), bu yangi xatolik chaqirib rekursiv cheksiz tsikl (infinite loop) yoki dastur to'xtashini (crash) keltirib chiqarmasligi shart.

### Non-Goals:
- Foydalanuvchining botni bloklashi (`bot was blocked by user`), eski callback query (`query is too old`) kabi tabiiy/zararsiz Telegram mijoz xatoliklarini adminga yuborish (ular filtrlanadi).
- Sentry yoki faylli loglarni (`logs/error.log`) o'chirish — ular o'z o'rnida ishlashda davom etadi.

### Anti-Goals:
- Xatolik yuborish jarayoni asosiy botning Event Loop'ini bloklamasligi va xotira sizishiga (memory leak) olib kelmasligi kerak.

## 3. Approaches
- **Approach 1 (Tanlangan): Winston Custom Transport + Markaziy `errorReporterService.js`**.
  Winston loggeriga maxsus transport qo'shiladi. Bu orqali 174+ ta `logger.error` chaqiruvlari avtomatik ushlanadi. Global xatoliklar (`uncaughtException`, `unhandledRejection`, `bot.catch`) ham ushbu servisga yo'naltiriladi.
- **Approach 2 (Rad etilgan): Faqat index.js global handlerlari**.
  Loyiha ichidagi `try/catch` bloklari ichida `logger.error` ga chiqariladigan xatolar chetda qolib ketar edi.
- **Approach 3 (Rad etilgan): Har bir faylni alohida tahrirlash**.
  100 dan ortiq faylni o'zgartirish talab etilar edi, noqulay va xato xavfi yuqori.

## 4. Architecture & Implementation Details
1. **`src/config/config.js`**:
   - `SECOND_BOT` o'zgaruvchisini `process.env.SECOND_BOT` dan o'qib eksport qilish.
2. **`src/services/errorReporterService.js`**:
   - Telegram Bot API `sendMessage` bilan to'g'ridan-to'g'ri yoki yengil HTTP klient orqali ishlash.
   - Dedup cache (Map / TTL) — bir xil fingerprintli xatoliklarni 60 soniya ichida bostirish va takrorlanishlar sonini yozib borish.
   - HTML formatlovchi va 4000 belgiga xavfsiz qisqartiruvchi yordamchi funksiyalar.
   - Yuborish navbati (queue) — Telegram 429 rate limitdan himoya qilish uchun ketma-ket yuborish.
3. **`src/core/logger.js`**:
   - Winston uchun `ErrorReporterTransport` yaratish va `level: 'error'` da xabarlarni `errorReporterService.report(...)` ga uzatish.
4. **`index.js`**:
   - `uncaughtException`, `unhandledRejection`, `bot.catch` integratsiyasini mustahkamlash.
   - `console.error` ni xavfsiz ravishda xatolik hisoblagichiga ulash.
5. **`.env.example`**:
   - `SECOND_BOT=...` hujjatlashtirish.
6. **Avtotestlar**:
   - `scripts/test_error_reporter.js` orqali deduplication, HTML escaping, uzun matn qirqilishi va xatoliklar ushlanishi to'liq sinovdan o'tkaziladi.
