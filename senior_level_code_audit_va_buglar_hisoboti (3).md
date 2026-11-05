# 🛡️ Senior-Level Audit Hisoboti (v3): Kod Tekshiruvi va Supabase AI Diagnostikasi (`ALL_SYSTEM_CODE_3.txt`)

Ushbu hisobot 3 ta asosiy qismdan iborat:
1. **Avvalgi 7 ta xatolikning `ALL_SYSTEM_CODE_3.txt` da tuzatilganlik natijasi.**
2. **Yangi kodda aniqlangan 5 ta yashirin mantiqiy bug (jumladan, Guruh Marafonida 2-blokning qotib qolishi va `ugc_start_NaN` xatosi).**
3. **Supabase AI hisoboti bo'yicha chuqur tahlil, Kod optimizatsiyasi va tayyor SQL Migratsiya skripti (I/O, Indekslar va RLS Xavfsizligi).**

---

## ✅ 1-BO'LIM: AVVALGI 7 TA XATOLIKNING TEKSHIRUV NATIJASI

| # | Xatolik tavsifi | Holati | Izoh |
|---|---|---|---|
| **1** | `parseTextQuestions` da `#4` yoki `#A` variantining o'chib ketishi | ⚠️ **90% Tuzatildi** | `#4` va `#A` tuzatildi, lekin `# 4` (probel bilan) yozilsa hali ham javob kaliti deb o'ylanadi *(Quyidagi Bug #4 ga qarang)*. |
| **2** | UGC testlarda `wm_menu_${subjectKey}` 64 baytdan oshishi va kontekst | ⚠️ **85% Tuzatildi** | `safeCallbackData` qo'shildi, ammo UGC "Klassik Quiz" (`retry`) tugaganda `ugc_start_NaN` tugmasi chiqib qolmoqda *(Quyidagi Bug #2 ga qarang)*. |
| **3** | Guruh testida `poll:${chatId}` mutex va `groupTestCache.delete` | ✅ **100% Tuzatildi** | Yagona `poll:${chatId}` mutexga o'tkazildi, `activePollsCache` va `groupTestCache` tozalanmoqda. |
| **4** | Javondan olingan `mock_...`, `adaptive_...` testlarining yakuniy tugmalari | ✅ **100% Tuzatildi** | `resolveTestName` va `buildFinishButtons` da `.startsWith()` qo'llanildi. |
| **5** | `sanitizeQuizQuestions` da >100 belgili to'g'ri javobning qirqilishi | ✅ **100% Tuzatildi** | Solishtirishdan oldin `targetOpt` ham 100 belgiga qisqartirilmoqda. |
| **6** | `escapeMarkdown` da teskari chiziqlar (`\`) va `userTextChunks` taymeri | ✅ **100% Tuzatildi** | Legacy Markdown regex to'g'rilandi va `cbCancelCreation` da taymer tozalanmoqda. |
| **7** | `contactAdmin.js` da `target_id` va `scheduleWatcherService.js` da `20:30` | ✅ **100% Tuzatildi** | `ctx.session?.data?.target_id` va `isTimeInWindow('20:30')` qo'shildi. |

---

## 🚨 2-BO'LIM: `ALL_SYSTEM_CODE_3.txt` DA ANIQLANGAN YANGI VA QOLGAN BUGLAR (5 TA)

### 🔴 Bug #1 (CRITICAL — SHOWSTOPPER): Guruh Marafonida (`isMarathon: true`) 2-blokka o'tilganda o'yinning butunlay qotib qolishi!
* **Manzil:** `src/handlers/coreQuiz.js` (320–323 va 467–478-qatorlar)
* **Sababi:**
  1-blok yakunlanganda `finishTest(chatId, telegram)` chaqiriladi va 321–323-qatorlarda quyidagilar o'rnatiladi:
  ```javascript
  session.finished = true;
  session.isFinished = true;
  session.questionState = "FINISHED";
  ```
  So'ngra Marafon shartiga (462-qator: `if (session.isMarathon && session.currentBlockIdx < session.marathonBlocks.length - 1 && !session.forceStopped)`) kirib, keyingi blok tayyorlanadi (474–475-qatorlar):
  ```javascript
  session.qIdx = 0;
  session.groupScores = {}; // Keyingi blok uchun tozalaymiz
  session.finished = false; // Sessiyani ochiq qoldiramiz
  ```
  **Muammo:** `session.finished = false` qilingan, lekin **`session.isFinished` hali ham `true` ligicha qolib ketgan!**
  Oqibatda muallif `"▶️ Keyingi blokni boshlash"` (`cbRoomNextBlock`) ni bosganda:
  1. `sendNextQuestion` faqat `session.finished` ni tekshirgani uchun 2-blokning 1-savolini guruhga yuboradi.
  2. Ammo `handlePollAnswer` (532-qator: `!session.isFinished`), `questionTimeout` (604-qator: `if (... || session.isFinished) return;`) va `finishTest` (320-qator: `if (... || session.isFinished) return;`) funksiyalarining barchasi `session.isFinished === true` ekanini ko'rib, **darhol to'xtaydi (`return`)!**
  3. Natijada 2-blokning 1-savolidan keyin taymer ham ishlamaydi, keyingi savolga ham o'tmaydi, marafon abadiy qotib qoladi!
* **Yechim (`src/handlers/coreQuiz.js` 475-qator):**
  ```javascript
  session.finished = false;
  session.isFinished = false;
  session.questionState = "PREPARING";
  session.transitionLock = null;
  ```

---

### 🔴 Bug #2 (HIGH): UGC (Shaxsiy) testda "Xatolar ustida ishlash -> Klassik Quiz" (`retry`) yakunlanganda `"🔁 Qayta ishlash"` tugmasi `ugc_start_NaN` bo'lib qolishi!
* **Manzil:** `src/handlers/coreQuiz.js` (84–120-qatorlar) va `src/handlers/quizGame.js` (662–677-qatorlar)
* **Sababi:**
  1. Foydalanuvchi o'zi yaratgan (UGC) testni tugatib, `"🔄 Xatolar ustida ishlash"` -> `"📊 Klassik Quiz"` ni bosganda `cbWmStartQuiz` (`quizGame.js` 670-qator) `initAndStartTest` ga `testId = "retry"` va `testData = { subject_id: meta?.subjectId, creator_id: ... }` yuboradi.
  2. Ushbu `"retry"` testi yakunlanganda `buildFinishButtons(tId, ...)` (`coreQuiz.js` 84-qator) ishga tushadi:
     ```javascript
     const sid = String(tId); // "retry"
     const isUgcSession = sid.startsWith("ugc_") || Boolean(session?.creatorId) || Boolean(session?.subjectId);
     if (isUgcSession) {
       const rawTestId = sid.startsWith("ugc_") ? parseInt(sid.replace("ugc_", ""), 10) : parseInt(sid, 10);
     ```
  3. `session.subjectId` mavjud bo'lgani uchun `isUgcSession = true` bo'ladi, lekin `sid = "retry"` bo'lgani sababli `parseInt("retry", 10)` **`NaN`** qaytaradi!
  4. 115-qatorda `Markup.button.callback("🔁 Qayta ishlash", "ugc_start_NaN")` tugmasi yasaladi va bosilganda `"❌ Test topilmadi yoki o'chirilgan"` xatosi chiqadi!
* **Yechim (`src/handlers/coreQuiz.js` 84-qator):**
  Agar `sid === "retry" || sid.startsWith("retry_")` bo'lsa va `isUgcSession` true bo'lsa, `ugc_start_NaN` o'rniga `safeCallbackData(\`wm_start_quiz_${subjectKey}\`, 64)` hamda `ugc_subj_${subjectId}` tugmalarini chiqarish kerak:
  ```javascript
  if (isUgcSession) {
    let subjectId = session?.subjectId;
    if (sid === "retry" || sid.startsWith("retry_")) {
      btns.push([
        Markup.button.callback(
          "🔁 Xatolarni qayta ishlash",
          safeCallbackData(`wm_start_quiz_${subjectKey}`, 64),
        ),
      ]);
      if (subjectId) {
        btns.push([
          Markup.button.callback("📚 Fan bloklari", `ugc_subj_${subjectId}`),
        ]);
      }
      btns.push([Markup.button.callback("📥 Javonga saqlash", "shelf_save_init")]);
      btns.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
      return btns;
    }
    // ... qolgan oddiy UGC blok mantiqi
  ```

---

### 🟠 Bug #3 (MEDIUM): `startHandler.js` va `contactAdmin.js` da aktiv test to'xtatilganda yangi formatdagi BullMQ taymerining (`timeout_${chatId}_${qIdx}_${pollId}`) o'chirilmasligi
* **Manzil:** `src/handlers/startHandler.js` (53–62-qatorlar) va `src/handlers/contactAdmin.js` (625–632-qatorlar)
* **Sababi:**
  1. `coreQuiz.js` da taymer ID formati `timeout_${chatId}_${session.qIdx}_${msg.poll.id}` ga o'zgartirildi (`cancelSessionTimer` orqali o'chiriladi).
  2. Ammo foydalanuvchi test paytida `/start` bossa (`startHandler.js` 55-qator), u hali ham eski `timeout:${chatId}:${session?.qIdx}` ni qidiradi va `cancelSessionTimer` ni chaqirmaydi. Shuningdek, 60-qatorda javonga saqlashda `testId` `"mock"` yoki `"adaptive"` bo'lsa `_${Date.now()}` qo'shilmagan.
  3. Admin foydalanuvchi testini majburan to'xtatganda (`contactAdmin.js` 628-qator: `cbCancelUserTest`), na `stopPoll` qilinadi va na `cancelSessionTimer` chaqiriladi.
* **Yechim:** Ikkala joyda ham `cancelSessionTimer(session, chatId)` ni chaqirish.

---

### 🟡 Bug #4 (LOW-MEDIUM): `utils.js` `parseTextQuestions` da `# 4` (probel bilan yozilgan 1 belgili variant) hali ham javob kaliti deb o'ylanishi
* **Manzil:** `src/core/utils.js` (345–346-qatorlar)
* **Sababi:**
  ```javascript
  const trailingHashMatch = (optionsHavePrefixes && lastLine.match(/^[#*]\s*([a-jA-J1-9])$/i)) ||
    lastLine.match(/^[#*]\s+([a-jA-J1-9])$/i);
  ```
  Ikkinchi qismda (`lastLine.match(/^[#*]\s+([a-jA-J1-9])$/i)`) `optionsHavePrefixes` tekshirilmagan. Agar foydalanuvchi variantlarni harfsiz (`A)` siz) yozib, oxirgi variantda `#` dan keyin probel tashlab `# 4` deb yozsa, u variantni o'chirib yuboradi.
* **Yechim:** `trailingHashMatch` faqat `optionsHavePrefixes` rost bo'lgandagina ishlashi kerak:
  ```javascript
  const trailingHashMatch = optionsHavePrefixes && lastLine.match(/^[#*]\s*([a-jA-J1-9])$/i);
  ```

---

### 🟡 Bug #5 (LOW): `coreQuiz.js` (134, 153-qatorlar) va `quizGame.js` (773-qator) da `safeCallbackData` qolib ketgan tugmalar
* **Manzil:** `src/handlers/coreQuiz.js` (134 va 153-qatorlar)
* **Sababi:** `wm_start_quiz_${subjectKey}` va `post_subj_${subjectKey}` tugmalarida `subjectKey` uzun kirillcha nom bo'lib qolsa (masalan, javondan olingan testda), 64 baytdan oshmasligi uchun ularni ham `safeCallbackData(..., 64)` ga o'rash xavfsizlikni 100% kafolatlaydi.

---

## 🗄️ 3-BO'LIM: SUPABASE AI HISOBOTI TAHLILI VA OPTIMAL YECHIMLAR

Supabase AI tomonidan berilgan hisobot juda aniq va o'rinli. Quyida har bir bandning loyihangiz kodidagi sababi va uni hal qilish yechimi keltirilgan:

### 1. `public.user_stats` dagi og'ir JSONB (`history`, `shelf`) ustunlarini keraksiz o'qishni to'xtatish
* **Muammo sababi (`dbService.js` va `adminHandlers.js`):**
  1. `adminHandlers.js` dagi **Foydalanuvchilar ro'yxati** (`cbAdminUsersList`, 422-qator) har bir sahifada 10 ta foydalanuvchi uchun `dbService.getUserStats(u.telegram_id)` ni chaqiradi. `getUserStats` esa `SELECT *` qilib, har bir foydalanuvchining butun **`shelf`** (javondagi barcha testlar va savollar matni!) hamda **`history`** (oxirgi 15 ta test va ulardagi barcha xato savollar!) JSONB ustunlarini bazadan tortib keladi!
  2. `getAdminDashboardStats` va `cbAdminStats` (`adminHandlers.js` 138 va 675-qatorlar) `dbService.getAllUserStats()` ni chaqiradi — bu funksiya barcha foydalanuvchilarning `history` JSONB ustunini (ichidagi barcha xato savollar matni bilan) xotiraga tortadi.
* **Koddagi Yechim (`src/services/dbService.js` va `src/handlers/adminHandlers.js`):**
  * `dbService.js` ga yengil `getUsersStatsSummaryByIds(userIds)` funksiyasini qo'shish yoki `cbAdminUsersList` da `shelf` ustunini umuman olmaslik.
  * `updateUserStats` da `SELECT *` va to'liq `upsert(stats)` qilish o'rniga, faqat `tests_completed, total_correct, total_wrong, history` ustunlarini o'qish va `.update({ tests_completed, total_correct, total_wrong, history })` qilish (shunda og'ir `shelf` JSONB ustuni tarmoq orqali qayta-qayta u yoqdan bu yoqqa tashilmaydi!).

### 2. `public.timetable_cache` jadvalidagi 2,100 ta ortiqcha (no-op) `UPSERT` yozuvlarini kamaytirish
* **Muammo sababi (`src/services/dbService.js` 860–898-qatorlar):**
  `upsertTimetableCache` funksiyasi chaqirilganda, u L1 xotira (`fallbackTimetableCache`) yoki Redis'da aynan shu `file_id` va `schedule_hash` allaqachon turganini tekshirmasdan to'g'ridan-to'g'ri `supabase.from('timetable_cache').upsert(...)` yuboradi. PostgreSQL'da `ON CONFLICT DO UPDATE` hatto qiymatlar o'zgarmagan bo'lsa ham yangi tuple (qator versiyasi) yozadi va indekslarni yangilaydi.
* **Koddagi Yechim (`src/services/dbService.js`):**
  `upsertTimetableCache` ichida Supabase'ga yozishdan oldin mavjud keshni tekshirish: agar `existing.file_id === row.file_id && existing.schedule_hash === row.schedule_hash` bo'lsa, Supabase `upsert` so'rovini o'tkazib yuborish!

### 3. Dublikat indeksni (`idx_timetable_cache_lookup`) o'chirish va `user_tests` indeksini optimallash
* **Muammo:** `timetable_cache` jadvalida `UNIQUE (group_normalized, theme)` cheklovi bor (u avtomatik `timetable_cache_group_normalized_theme_key` indeksini yaratadi). Uning ustiga bir xil ustunlar uchun `idx_timetable_cache_lookup` indeksi ham ochilgan. Bu har bir `upsert` da disk I/O ni 2 barobar oshiradi.
* **Yechim:** Quyidagi SQL skript orqali dublikat indeks o'chiriladi va `user_tests (creator_id, id DESC)` kompozit indeksi yaratiladi.

### 4. CRITICAL SECURITY: Row Level Security (RLS) ni barcha jadvallarda xavfsiz yoqish
* **Muhim tushuntirish:**
  Supabase'da 2 xil API kalit bo'ladi:
  1. `anon` (public) kalit — RLS qoidalariga bo'ysunadi. Agar siz `.env` faylda `SUPABASE_KEY` sifatida `anon` kalitni ishlatayotgan bo'lsangiz va jadvallarda RLS ni yoqib, hech qanday policy qo'shmasangiz, **botingiz ma'lumotlar bazasiga ulana olmay qoladi!**
  2. `service_role` (secret) kalit — Backend (Node.js) uchun mo'ljallangan bo'lib, u RLS ni avtomatik chetlab o'tadi (`bypass RLS`).
* **Qanday yo'l tutish kerak:**
  1. `.env` faylingizda `SUPABASE_KEY` sifatida Supabase Dashboard -> **Project Settings -> API -> `service_role` (secret)** kaliti turganiga ishonch hosil qiling (`src/lib/supabase.js` ga buni avtomatik tekshirib ogohlantiruvchi kod ham qo'shamiz).
  2. Quyidagi SQL migratsiyani Supabase **SQL Editor** da ishga tushiring — u dublikat indekslarni tozalaydi, `user_tests` indeksini yaratadi va barcha 9 ta jadvalda RLS ni xavfsiz yoqadi:

```sql
-- ============================================================================
-- SUPABASE OPTIMIZATION & SECURITY (RLS) MIGRATION SCRIPT
-- ============================================================================

-- 1. Dublikat indeksni o'chirish (Write I/O ni kamaytiradi)
DROP INDEX IF EXISTS public.idx_timetable_cache_lookup;

-- 2. user_tests jadvali uchun tezkor kompozit indeks (creator_id + id DESC)
CREATE INDEX IF NOT EXISTS idx_user_tests_creator_id_desc
  ON public.user_tests (creator_id, id DESC);

-- 3. Barcha ommaviy jadvallarda Row Level Security (RLS) ni yoqish
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.official_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.kahoot_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_schedule_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.course_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.timetable_cache ENABLE ROW LEVEL SECURITY;

-- 4. service_role uchun to'liq ruxsat (Node.js backend service_role ishlatsa avtomatik o'tadi,
-- ammo explicit policy bo'lishi eng yaxshi amaliyot hisoblanadi)
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'users', 'user_stats', 'user_tests', 'official_tests',
    'kahoot_questions', 'subjects', 'user_schedule_settings',
    'course_notes', 'timetable_cache'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE format('DROP POLICY IF EXISTS "service_role_all_access" ON public.%I', tbl);
      EXECUTE format(
        'CREATE POLICY "service_role_all_access" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        tbl
      );
    END IF;
  END LOOP;
END
$$;
```