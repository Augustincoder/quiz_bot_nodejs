# 🛡️ Senior-Level Arxitektura va Kod Auditi Hisoboti (`quiz_bot_nodejs`)

Ushbu hujjat loyihaning barcha **47 ta fayli** ustida o'tkazilgan chuqur (line-by-line) texnik audit natijasidir. Asosiy e'tibor **Quiz tuzish (Test Creation)**, **Quiz ishlash (Test Solving)**, **Guruh musobaqalari (Group Quiz & Marathon)**, **Xatolar ustida ishlash (Error Mastery)**, **Javon (Shelf)** va **Sessiya/Konkurensiya (Race Conditions)** jarayonlaridagi yashirin hamda kritik buglarga qaratildi.

## 🚨 1-BO'LIM: QUIZ TUZISH (TEST CREATION) JARAYONIDAGI KRITIK BUGLAR

### 🔴 Bug #1: Matn formatida savol qo'shilganda 400ms Debounce va Redis Session Race Condition (Savollarning butunlay yo'qolib ketishi)

* **Manzil:** `src/handlers/testCreation.js` (588–687-qatorlar) va `index.js` (104–149-qatorlar)

* **Xavflilik darajasi:** **CRITICAL (Blocker)**

* **Sababi (Root Cause):** `index.js` dagi Redis session middleware `await next()` tugashi bilanoq `finally` blokida `ctx.session` ni Redisga saqlaydi. Ammo `onQuestionMessage` (`fmt === "text"`) ichida uzun matnlarni birlashtirish uchun `setTimeout(..., 400)` qo'yilgan va funksiya darhol `return` qiladi:

  ```
  chunkState.timer = setTimeout(async () => {
    userTextChunks.delete(userId);
    await processBatchedTextQuestions(chunkState.ctx, chunkState.text);
  }, 400);
  return;
  
  ```

  Middleware `await next()` ni 1 millisekundda tugatadi va `ctx.session` ni o'sha paytdagi (eski) holatda Redisga yozib bo'ladi. Oradan 400ms o'tgach `processBatchedTextQuestions` ishga tushib, `await updateData(ctx, { questions, format_added })` ni chaqiradi. Bu faqatgina xotiradagi `ctx.session` obyektini o'zgartiradi, **lekin middleware allaqachon yakunlangani uchun yangi savollar Redisga hech qachon yozilmaydi!**

* **Oqibati:** Foydalanuvchi matn formatida savollar yuborganda bot *"✅ N ta savol qo'shildi!"* deydi, lekin foydalanuvchi *"🔙 Panelga qaytish"* yoki *"✅ Yakunlash"* tugmasini bosganida savat bo'sh (`0 ta savol`) bo'lib chiqadi.

* **Yechim:**
  `updateData` funksiyasini yoki `processBatchedTextQuestions` ni to'g'ridan-to'g'ri Redisdagi `tg_session:${userId}` kalitini yangilaydigan qilish kerak:

  ```
  // src/handlers/testCreation.js -> processBatchedTextQuestions ichida updateData dan keyin:
  const redisConnection = require("../services/redisService");
  await redisConnection.set(`tg_session:${ctx.from.id}`, JSON.stringify(ctx.session), "EX", 86400);
  
  ```

### 🔴 Bug #2: `parseTextQuestions` da o'nli kasrlar, yillar va ro'yxatli savollarning бузилиb ketishi

* **Manzil:** `src/core/utils.js` (285–336-qatorlar)

* **Xavflilik darajasi:** **HIGH**

* **Sababi:**

  1. **O'nli kasrlar va raqamlarning qirqilishi (313-qator):**

     ```
     optText = optText.replace(/^[a-zA-Z0-9][\)\.]\s*/, '').trim();
     
     ```

     Agar variant matni `"1.5 mol"` yoki `"2.45 sekund"` bo'lsa (oldida `A)` harfi bo'lmasa), regex boshidagi `"1."` yoki `"2."` ni variant belgisi deb o'ylab o'chirib yuboradi! Natijada variant `"5 mol"` yoki `"45 sekund"` bo'lib qoladi.

  2. **Ko'p qatorli savollarda erta kesilish (296-qator):**

     ```
     if (/^[#*]?\s*[a-zA-Z0-9][\)\.]\s*/.test(p)) { firstOptIdx = i; break; }
     
     ```

     Agar savol matni ichida `"1. Birinchi mulohaza"`, `"2. Ikkinchi mulohaza"` kabi bandlar bo'lsa, parser 2-qatorni variant deb o'ylab, savolning qolgan qismini variantlarga aylantirib yuboradi.

  3. **`A) #Javob` formatining o'qilmasligi (311-qator):**
     Ko'plab o'qituvchilar Word faylda `#A) Javob` emas, `A) #Javob` deb belgilashadi. Hozirgi kod avval `optText.startsWith('#')` ni tekshirib, keyin `A)` ni o'chiradi. Natijada `A) #Javob` xato savol (`invalid`) sifatida rad etiladi.

* **Yechim:**
  Variant prefiksini faqat harf + `)` / `.` (va undan keyin bo'sh joy bo'lsa) yoki raqam + `)` bo'lgandagina tozalash hamda `#` belgisini prefiks o'chirilgandan keyin ham tekshirish:

  ```
  let optText = parts[i].trim();
  let isCorrect = false;
  if (mode === 'hash' && optText.startsWith('#')) {
    isCorrect = true;
    optText = optText.substring(1).trim();
  }
  // Faqat A), B., a), 1) kabi aniq prefikslarni o'chirish (1.5 kabi kasrlarga tegmaslik)
  optText = optText.replace(/^(?:[a-zA-Z][\)\.]|\d+\))\s+/, '').trim();
  if (mode === 'hash' && optText.startsWith('#')) {
    isCorrect = true;
    optText = optText.substring(1).trim();
  }
  if (mode === 'first' && i === firstOptIdx) isCorrect = true;
  
  ```

### 🔴 Bug #3: Dublikat variantlar va `sanitizeQuizQuestions` da `correct_index` siljishi (Noto'g'ri javob to'g'ri bo'lib qolishi)

* **Manzil:** `src/validators/testValidators.js` (40–99-qatorlar) va `src/core/questionUtils.js` (22–40-qatorlar)

* **Xavflilik darajasi:** **CRITICAL**

* **Sababi:**

  1. `sanitizeQuizQuestions` (AI testlarda) dublikat variantlarni `seen.has(lower)` orqali o'chirib tashlaydi, **lekin `numCorrect` indeksini yangilamaydi!**
     *Misol:* AI `options: ["1991", "1991", "1992", "1993"]` va `correct_index: 2` (`"1992"`) qaytardi. Deduplikatsiyadan so'ng `options: ["1991", "1992", "1993"]` bo'ladi, ammo `correct_index` `2` ligicha qoladi va endi `"1993"` ga ishora qiladi!

  2. `sanitizeQuizQuestions` ichida 81-qatorda:

     ```
     if (numCorrect >= 1 && numCorrect === rawOptions.length && rawOptions.length <= options.length) {
       numCorrect = numCorrect - 1;
     }
     
     ```

     Bu mantiq xato: agar AI 0-based indeksda oxirgi variantni emas, 1-based indeksda 2-variantni (`2`) bergan bo'lsa uni o'zgartirmaydi, yoki 0-based indeksda dublikat o'chgani uchun indeks siljigan bo'lsa noto'g'ri kamaytiradi.

  3. Oddiy matn/Word/Poll orqali tuzilgan testlarda dublikat variantlar umuman tekshirilmaydi. `prepareShuffledQuestions` da `options.indexOf(...)` dublikat variant bo'lganda doim 1-uchraganini oladi.

* **Yechim:**
  To'g'ri javobni indeks orqali emas, **to'g'ri javob matni (`correctAnswerText`)** ni deduplikatsiyadan oldin saqlab olib, deduplikatsiyadan so'ng uning yangi indeksini topish (`options.findIndex(...)`) orqali aniqlash shart.

### 🟠 Bug #4: Legacy Markdown (`parse_mode: "Markdown"`) tufayli Test Yaratish va Tahrirlashda Crash (`400 Bad Request: can't parse entities`)

* **Manzil:** `src/handlers/testCreation.js` (51, 143, 153, 826, 920, 1043, 1066-qatorlar)

* **Xavflilik darajasi:** **HIGH**

* **Sababi:**

  * `showEditDashboard` (51-qator) da `📚 Fan: ${data.subject}\n📝 Blok: ${data.block_name}` hech qanday `escapeMarkdown` siz `parse_mode: "Markdown"` da yuboriladi. Agar blok nomida `_` yoki `*` bo'lsa (masalan, fayl nomidan olingan `Test_1`), Telegram API xato qaytaradi va tahrirlash oynasi ochilmaydi.

  * `cbEditQuestionStart` (826-qator) da savol matni ```` ```\n${textFormat}``` ```` ichiga qo'yilgan. Savol ichida `_`, `*` yoki `` ` `` bo'lsa xato beradi (HTML `<pre><code>${escapeHtml(textFormat)}</code></pre>` ishlatilishi kerak, xuddi `cbFixErrors` dagi kabi).

  * `cbCtNew` (153-qator), `cbFinishCreation` (920-qator), `cbManageSubj` (1043-qator), `cbManageTest` (1066-qator) da `safeEdit(ctx, text, Markup.inlineKeyboard(...))` ko'rinishida chaqirilgan.

### 🟠 Bug #5: Savolni tahrirlashni bekor qilish (`preview_q_${idx}`) `editing_question_index` ni tozalamaydi + Tahrirlash rejimida (`is_editing`) navigatsiya buzilishi

* **Manzil:** `src/handlers/testCreation.js` (42, 754, 773, 820-qatorlar)

* **Xavflilik darajasi:** **MEDIUM-HIGH**

* **Sababi:**

  1. Foydalanuvchi `cbEditQuestionStart` (`edit_q_0`) tugmasini bosganda `editing_question_index: 0` saqlanadi. Agar u fikridan qaytib `"❌ Bekor qilish"` (`preview_q_0`) tugmasini bossa, `cbPreviewQuestion` ishga tushadi, lekin `editing_question_index` **tozalanmaydi (`undefined` qilinmaydi)!** Keyingi safar foydalanuvchi yangi savol qo'shmoqchi bo'lib matn yuborsa, yangi savol qo'shilmaydi — 1-savolning ustiga yozilib ketadi.

  2. Mavjud testni tahrirlash (`edit_test_123`) rejimida `showEditDashboard` -> `preview_q_0` -> `preview_grid_0` ga o'tilganda, pastdagi qaytish tugmasi `back_to_edit_dash` o'rniga `back_to_dashboard` (yangi test yaratish paneli) ga olib chiqib ketadi.

### 🟠 Bug #6: Admin AI Test Yaratishda (`onAiTestsText`) mantiqiy xatolik — Matn o'rniga savol soni yuborilishi

* **Manzil:** `src/handlers/aiTestsHandlers.js` (180–200-qatorlar)

* **Xavflilik darajasi:** **HIGH**

* **Sababi:**

  ```
  async function onAiTestsText(ctx) {
    const text = ctx.message.text;
    let count = 'auto';
    if (text.toLowerCase() === 'auto') {
      // AI o'zi belgilaydi
    } else {
      count = text.trim();
    }
    const questions = await aiService.generateQuizFromText(text, count);
  
  ```

  * Agar admin `"auto"` deb yozsa, AI ga `"auto"` degan 4 harfli so'z matn sifatida yuboriladi!

  * Agar admin maqola matnini yuborsa, `count` o'zgaruvchisiga ham butun maqola matni yuklanadi (`Aynan <maqola matni> ta variantli test tuz`).

## 🚨 2-BO'LIM: QUIZ ISHLASH (TEST SOLVING) VA GAMEPLAY BUGLARI

### 🔴 Bug #7: Xatolar ustida ishlash — "Klassik Quiz" (`cbWmStartQuiz`) yakunlanganda `"🔁 Qayta ishlash"` tugmasi buzilishi

* **Manzil:** `src/handlers/quizGame.js` (650-qator) va `src/handlers/coreQuiz.js` (127–147-qatorlar)

* **Xavflilik darajasi:** **HIGH**

* **Sababi:**
  `cbWmStartQuiz` funksiyasi testni `testId = "retry"` bilan boshlaydi:

  ```
  await initAndStartTest(chatId, ctx.telegram, subjectKey, "retry", testData, ctx.from.id, "private");
  
  ```

  Ammo `coreQuiz.js` dagi `buildFinishButtons` funksiyasi `sid.startsWith("retry_")` ni kutadi (`"retry"` emas!). Natijada `"retry"` oddiy raqamli rasmiy blok deb qabul qilinadi va:

  * `post_start_${subjectKey}_retry` tugmasi yasaladi.

  * Foydalanuvchi uni bossa, `cbPostStart` da `parseInt("retry", 10)` -> `NaN` bo'lib, `"❌ Test topilmadi!"` xatosi chiqadi.

* **Yechim:** `buildFinishButtons` ichida `if (sid === "retry" || sid.startsWith("retry_"))` deb tekshirish va UGC/Rasmiy testga mos tugma qaytarish.

### 🔴 Bug #8: UGC (Shaxsiy yaratilgan) va AI Testlardan so'ng "Xatolarni ko'rish" hamda "Xatolar ustida ishlash" dagi "🔙 Fan menyusiga" tugmasi Rasmiy Testlarga otib yuborishi

* **Manzil:** `src/handlers/quizGame.js` (582, 622, 645-qatorlar)

* **Xavflilik darajasi:** **HIGH**

* **Sababi:**
  `cbReviewMistakes`, `cbWorkMistakesMenu` va `sendNextInlineMistake` funksiyalarida orqaga qaytish tugmasi har doim `post_subj_${subjectKey}` ga yo'naltirilgan.
  `cbPostSubj` esa faqatgina `SUBJECTS` (Rasmiy testlar) bazasidan qidiradi. Agar foydalanuvchi o'zi yaratgan testni (`ugc_...`) yoki AI testni yechib, xatolarini ko'rgach *"🔙 Fan menyusiga"* ni bossa, `"📚 Fan (📭 Bu fanda hozircha test yo'q)"` degan rasmiy testlarning bo'sh sahifasiga tushib qoladi!

* **Yechim:** `mistakes_meta:${chatId}` ichida `subjectId` va `isUgc` bayrog'ini ham saqlash; agar UGC test bo'lsa `ugc_subj_${meta.subjectId}` ga, aks holda rasmiy fanga qaytarish.

### 🔴 Bug #9: Interaktiv Xatolar Ustida Ishlash (`sendNextInlineMistake` & `cbWmAns`) da Taymer va Bosish o'rtasidagi Race Condition hamda `"⏳ Vaqt tugadi"` variantga aylanib qolishi

* **Manzil:** `src/handlers/quizGame.js` (668–755 va 763–818-qatorlar)

* **Xavflilik darajasi:** **HIGH**

* **Sababi:**

  1. `wmTimer` (20 soniyalik taymer, 718-qator) ishga tushganda `mutex.lock('wm_ans:' + chatId)` ishlatilmagan. Agar 20-soniyada taymer va foydalanuvchi bosishi bir vaqtga to'g'ri kelsa, ikkalasi ham `queue.shift()` qiladi va navbatdagi savol o'ynalmasdan o'tib ketadi.

  2. Barcha xato variant tugmalariga bir xil `callback_data: "wm_ans_0"` berilgan va unda savol identifikatori yo'q.

  3. 671-qatorda:

     ```
     if (!options || options.length === 0) {
       options = [String(q.correct_ans), String(q.wrong_ans)];
     
     ```

     Agar savolda vaqt tugagan bo'lsa (`q.wrong_ans === "⏳ Vaqt tugadi"`) va `q.options` saqlanmagan bo'lsa, variant sifatida `B) ⏳ Vaqt tugadi` chiqib qoladi.

### 🔴 Bug #10: Javonga saqlashda (`saveTestToShelf` / `cbPauseShelf`) Testni qayta saqlab bo'lmasligi va Pauzadagi testning o'chib ketishi

* **Manzil:** `src/services/dbService.js` (659-qator) va `src/handlers/quizGame.js` (482–520-qatorlar)

* **Xavflilik darajasi:** **CRITICAL**

* **Sababi:**

  1. `cbPauseShelf` funksiyasi foydalanuvchi testni pauza qilib *"📥 Javonga saqlash"* ni bosishi bilanoq **hali foydalanuvchi papkani tanlamasdan turib** `sessionService.deleteActiveTest(chatId)` orqali faol testni o'chirib yuboradi! Agar foydalanuvchi keyingi ekranda *"❌ Bekor qilish"* ni bossa, test ham yo'q, javonda ham yo'q!

  2. `dbService.saveTestToShelf` da:

     ```
     const isExist = shelf[folderName].find(t => String(t.testId) === String(testInfo.testId));
     if (isExist) return 'exist';
     
     ```

     * Agar foydalanuvchi Javondan testni ochib, yana 10 ta savol ishlab, qayta Javonga saqlamoqchi bo'lsa, `testId` bir xil bo'lgani uchun `"exist"` qaytaradi va **yangi progressni ustidan yozmaydi** (faol test esa o'chib ketadi)!

     * Agar foydalanuvchi `"🎲 Aralash Test"` (`testId: "mock"`) yoki `"🎯 AI Adaptiv Test"` (`testId: "adaptive"`) ni javonga saqlasa, ikkinchi marta boshqa Aralash testni o'sha papkaga saqlay olmaydi, chunki barcha aralash testlarning `testId` si `"mock"`!

* **Yechim:**

  * `saveTestToShelf` ichida agar `isExist` topilsa va yangi saqlanayotgan testda `progress` bo'lsa, `"exist"` qaytarish o'rniga mavjud testning `progress` va `saved_at` qiymatlarini **ustidan yangilash (upsert)** kerak!

  * `mock`, `adaptive`, `retry` testlariga `testId: "mock_" + Date.now()` kabi unikal ID berish kerak.

### 🔴 Bug #11: Guruhda `/stop` buyrug'i bosilganda Shaxsiy Pauza Menyusi chiqishi va Begona a'zolar testni buzishi

* **Manzil:** `src/handlers/startHandler.js` (196–215-qatorlar) va `src/handlers/quizGame.js` (407–520-qatorlar)

* **Xavflilik darajasi:** **HIGH**

* **Sababi:**
  `cmdStop` ichida:

  ```
  const { cbStopTest, finishTest } = require('./quizGame');
  if (cbStopTest) {
    return cbStopTest(ctx);
  }
  
  ```

  `cbStopTest` har doim mavjud bo'lgani uchun `else` bloki (marafonni to'xtatib `finishTest` chaqiradigan qism) **hech qachon ishlamaydi (Dead Code)!**
  Guruhda muallif `/stop` bossa:

  1. Guruhga shaxsiy chat uchun mo'ljallangan Pauza menyusi (`To'g'ri: 0 ta`, `"📥 Javonga saqlash"`) chiqadi.

  2. Shu menyudagi `"▶️ Davom etish"`, `"🏁 Yakunlash"`, `"🗑 Butunlay bekor qilish"` tugmalarida `initiatorId` tekshiruvi yo'q — guruhdagi istalgan odam bosib musobaqani o'chirib yuborishi mumkin.

* **Yechim:** `cmdStop` ichida `if (isGroup)` bo'lsa `cbStopTest` ni emas, to'g'ridan-to'g'ri `session.forceStopped = true` qilib `finishTest(chatId, ctx.telegram)` ni chaqirish kerak.

### 🟠 Bug #12: Guruhda musobaqa ketayotgan paytda ustidan yangi Lobby (`createLobby`) ochilishi

* **Manzil:** `src/handlers/groupQuizLogic.js` (51–119 va 141–258-qatorlar)

* **Xavflilik darajasi:** **MEDIUM-HIGH**

* **Sababi:**
  `createLobby` va `cbRoomStart` da shu guruhda (`chatId`) allaqachon faol test (`sessionService.getActiveTest(chatId)`) bor-yo'qligi tekshirilmaydi. Agar guruhda test ketayotgan paytda kimdir deeplink orqali yangi test boshlasa, eski testning BullMQ taymeri (`timeout:${chatId}:${qIdx}`) o'chirilmaydi va yangi boshlangan testning savollarini muddatidan oldin yopib yuboradi.

## 🚨 3-BO'LIM: STATISTIKA, ADMIN PANEL VA SOCKET.IO BUGLARI

### 🔴 Bug #13: Talabalar tarixida (`history`) `percent` saqlanmagani sababli Admin Panelda barcha talabalarning o'rtacha bali `0%` chiqishi va Tarixning teskari ko'rinishi

* **Manzil:**

  * `src/services/dbService.js` (`updateUserStats` - 117–128-qatorlar)

  * `src/handlers/adminHandlers.js` (`showUserDetails` - 634-qator, `cbAdminUserStats` - 708-qator)

  * `src/handlers/contactAdmin.js` (`getUserActivityContext` - 34-qator)

  * `src/handlers/statsHandlers.js` (`cbHistoryPage` - 129-qator)

* **Xavflilik darajasi:** **HIGH**

* **Sababi:**

  1. `dbService.updateUserStats` da `stats.history` ichiga `{ date, timestamp, subject, test_id, correct, wrong, mistakes }` yoziladi, ammo **`percent` yozilmaydi!**
     Admin panel (`showUserDetails`) va Murojaat (`getUserActivityContext`) esa `h.percent || 0` ni yig'ib o'rtacha ball hisoblaydi — natijada har doim **`0%`** chiqadi!

  2. `dbService.updateUserStats` da yangi yechilgan test `stats.history.unshift(entry)` bilan massivning **boshiga (0-indeksga)** qo'shiladi. Ammo `statsHandlers.js` (129-qator) da `stats.history.slice().reverse()` qilinib, eng eski test birinchi sahifada, eng yangi test oxirida ko'rsatilmoqda! `contactAdmin.js` (31-qator) da ham `history[history.length - 1]` olingani uchun oxirgi test emas, eng birinchi (eski) test ko'rsatiladi.

### 🟠 Bug #14: Socket.io Kahoot (`gameLoop.js` va `socket/index.js`) da savollar massivining faqat 1-elementi o'qilishi

* **Manzil:** `src/socket/gameLoop.js` (40–48-qatorlar) va `src/socket/index.js` (30–42, 95–125-qatorlar)

* **Xavflilik darajasi:** **MEDIUM-HIGH**

* **Sababi:**

  1. `src/api/admin.js` (167-qator) da Kahoot savollari bazaga `{ topic, questions: [q1, q2, ...] }` shaklida (bitta qatorda bir nechta savol) yoziladi.
     Ammo `socket/index.js` (104-qator) da `SELECT * FROM kahoot_questions LIMIT 30` qilinib, `gameLoop.js` (42-qator) da:

     ```
     const subQ = Array.isArray(q.questions) ? q.questions[0] : q;
     
     ```

     deb har bir blokning faqatgina 1-savoli (`q.questions[0]`) olinadi va blok ichidagi qolgan barcha savollar tashlab ketiladi! (`questions.flatMap(row => Array.isArray(row.questions) ? row.questions : [row])` qilinishi kerak edi).

  2. `room:create` da xona yaratilganda yaratuvchiga (`socket.emit('room:created', ...)`) javob qaytarilmaydi.

### 🟠 Bug #15: `contactAdmin.js` dagi global `bot.on('message')` ro'yxatdan o'tish tartibi

* **Manzil:** `src/handlers/contactAdmin.js` (985-qator) va `index.js` (212 va 321-qatorlar)

* **Xavflilik darajasi:** **MEDIUM**

* **Sababi:**
  `contactAdmin.register(bot)` ichida `bot.on('message', handleContactMessages)` chaqirilgan. `index.js` da `handlers` ro'yxatdan o'tkazilganda bu handler `index.js` dagi asosiy `bot.on('message')` state routeridan va `/unban`, `/note` kabi komandalardan **oldin** middleware zanjiriga qo'shilib qoladi. Agar admin boshqa state ichida (masalan, test yaratish yoki broadcast) biror xabarga reply qilib yozsa, `handleContactMessages` (106-qator) uni ushlab olib foydalanuvchiga reply sifatida yuborishga harakat qiladi.

## 📋 XULOSA VA USTUVOR TUZATISH REJASI (PRIORITY MATRIX)

| \# | Modul / Fayl | Muammo qisqacha | Daraja | 
| ----- | ----- | ----- | ----- | 
| **1** | `testCreation.js` | Matnli savol qo'shishda 400ms `setTimeout` tufayli savollar Redisga saqlanmasligi | 🔴 **CRITICAL** | 
| **2** | `testValidators.js` / `questionUtils.js` | Dublikat variantlar o'chirilganda `correct_index` siljib, xato javob to'g'ri bo'lib qolishi | 🔴 **CRITICAL** | 
| **3** | `dbService.js` / `quizGame.js` | Javonga saqlashda (`cbPauseShelf`) faol test erta o'chishi va `testId` dublikat bo'lganda progress yangilanmasligi | 🔴 **CRITICAL** | 
| **4** | `utils.js` | `parseTextQuestions` da `1.5` kabi o'nli kasrlar qirqilishi va `A) #Javob` formatining o'qilmasligi | 🔴 **HIGH** | 
| **5** | `startHandler.js` / `quizGame.js` | Guruhda `/stop` bosilganda shaxsiy pauza menyusi chiqishi va begona odamlar testni to'xtata olishi | 🔴 **HIGH** | 
| **6** | `quizGame.js` / `coreQuiz.js` | `cbWmStartQuiz` (`testId = "retry"`) tugagach "Qayta ishlash" tugmasi `NaN` bo'lib buzilishi | 🔴 **HIGH** | 
| **7** | `quizGame.js` | UGC va AI testlardan keyin "Xatolar tahlili" dagi "Fan menyusiga" tugmasi Rasmiy testlarga otib yuborishi | 🔴 **HIGH** | 
| **8** | `aiTestsHandlers.js` | `onAiTestsText` da matn o'rniga `count` uzatilishi va `"auto"` so'zidan test tuzilishi | 🔴 **HIGH** | 
| **9** | `dbService.js` / `statsHandlers.js` | `history` da `percent` yo'qligi sababli Admin panelda o'rtacha ball `0%` chiqishi va tarixning teskari tartiblanishi | 🟠 **HIGH** | 
| **10** | `testCreation.js` | Legacy Markdown (`parse_mode: "Markdown"`) va `editing_question_index` tozalanmasligi | 🟠 **MEDIUM** | 
| **11** | `groupQuizLogic.js` | Guruhda faol test ustidan yangi lobby ochilganda eski BullMQ taymerining tozalanmasligi | 🟠 **MEDIUM** | 
| **12** | `socket/gameLoop.js` | Kahoot bazadan olingan savollar massivining faqat 1-savolini o'qishi (`flatMap` yo'qligi) | 🟠 **MEDIUM** | 
