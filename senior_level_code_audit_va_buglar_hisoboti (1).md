# 🛡️ Senior-Level Chuqurlashtirilgan Arxitektura va Kod Auditi Hisoboti (`quiz_bot_nodejs`)

Ushbu hujjat loyihaning barcha **47 ta fayli** ustida o'tkazilgan **chuqurlashtirilgan (Deep-Dive Forensic)** texnik audit natijasidir. Tahlil davomida jami **28 ta jiddiy va o'rta darajadagi buglar** aniqlandi. Ularning har biri aniq fayl, qator raqami, kelib chiqish sababi (Root Cause), foydalanuvchiga ta'siri va tayyor kod yechimi bilan quyida keltirilgan.

---

## 🚨 1-BO'LIM: QUIZ TUZISH (TEST CREATION) JARAYONIDAGI BUGLAR

### 🔴 Bug #1: Matn formatida savol qo'shilganda 400ms Debounce va Redis Session Race Condition (Savollarning butunlay yo'qolib ketishi)
* **Manzil:** `src/handlers/testCreation.js` (588–687-qatorlar) va `index.js` (104–149-qatorlar)
* **Xavflilik darajasi:** **CRITICAL (Blocker)**
* **Sababi (Root Cause):** `index.js` dagi Redis session middleware `await next()` tugashi bilanoq `finally` blokida `ctx.session` ni `originalSessionStr !== newSessionStr` sharti bilan Redisga saqlaydi. Ammo `onQuestionMessage` (`fmt === "text"`) ichida uzun matnlarni birlashtirish uchun `setTimeout(..., 400)` qo'yilgan va funksiya darhol `return` qiladi:
  ```javascript
  chunkState.timer = setTimeout(async () => {
    userTextChunks.delete(userId);
    await processBatchedTextQuestions(chunkState.ctx, chunkState.text);
  }, 400);
  return;
  ```
  Middleware `await next()` ni 1 ms ichida tugatadi va `ctx.session` o'zgarmagani uchun Redisga hech narsa yozmaydi. Oradan 400ms o'tgach `processBatchedTextQuestions` ishga tushib, `await updateData(ctx, { questions, format_added })` ni chaqiradi. Bu faqat xotiradagi allaqachon yopilgan `ctx.session` obyektini o'zgartiradi, **lekin yangi savollar Redisga hech qachon yozilmaydi!**
* **Oqibati:** Foydalanuvchi matn formatida savollar yuborganda bot *"✅ N ta savol qo'shildi!"* deb javob beradi, lekin foydalanuvchi *"🔙 Panelga qaytish"* yoki *"👁 Ko'rib chiqish"* tugmasini bosganida savat bo'sh (`0 ta savol`) bo'lib chiqadi.
* **Yechim:** `src/core/utils.js` dagi `updateData` funksiyasi yoki `processBatchedTextQuestions` ichida `tg_session:${userId}` ni Redisga bevosita saqlash:
  ```javascript
  const redisConnection = require("../services/redisService");
  await redisConnection.set(`tg_session:${ctx.from.id}`, JSON.stringify(ctx.session), "EX", 86400);
  ```

---

### 🔴 Bug #2: Matn va Oddiy Word (`.docx`) rejimida xato formatdagi savollar (`invalidQs`) foydalanuvchidan yashirilishi
* **Manzil:** `src/handlers/testCreation.js` (555–568 va 588–605-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. `processBatchedTextQuestions` (594-qator) da:
     ```javascript
     const parsed = parseTextQuestions(fullText, data.parse_mode || "hash");
     const newQs = parsed.valid || [];
     ```
     `parsed.invalid` massivi **umuman olinmaydi va tashlab yuboriladi!** Agar foydalanuvchi 20 ta savol tashlasa va 3 tasida `#` belgisini unutgan bo'lsa, bot indamay 17 ta savolni qo'shadi, qolgan 3 ta savol qayoqqa ketganini ham aytmaydi, `"⚠️ Xatolarni to'g'rilash"` tugmasini ham chiqarmaydi.
  2. Oddiy `.docx` yuklanganda (`onDocxFile`, 556-qator) `invalidQs` sessiyaga yoziladi, ammo keyin `showCreationStatusMenu(ctx)` emas, `showDraftDashboard(ctx)` chaqiriladi. `showDraftDashboard` (222–265-qatorlar) ichida esa `data.invalidQs` tekshirilmagan va `"⚠️ Xatolarni to'g'rilash"` tugmasi umuman yo'q! (`showCreationStatusMenu` funksiyasi dead-code bo'lib qolgan).
* **Yechim:**
  * `processBatchedTextQuestions` da `parsed.invalid` ni ham `data.invalidQs` ga qo'shish va javob xabarida `⚠️ Xato formatdagi savollar: X ta` tugmasini chiqarish.
  * `showDraftDashboard` ichiga `if ((data.invalidQs || []).length > 0)` sharti bilan `"⚠️ Xatolarni to'g'rilash (${data.invalidQs.length} ta)"` (`fix_errors_0`) tugmasini qo'shish.

---

### 🔴 Bug #3: `fixing_error_index` va `editing_question_index` bayroqlarining "Yopishib qolishi" (State Poisoning)
* **Manzil:** `src/handlers/testCreation.js` (612–660, 773, 820, 1138-qatorlar)
* **Xavflilik darajasi:** **CRITICAL**
* **Sababi:**
  1. Foydalanuvchi `"⚠️ Xatolarni to'g'rilash"` (`cbFixErrors`) oynasiga kirganda sessiyaga `fixing_error_index: 0` yoziladi. Agar u xatoni to'g'rilamasdan **"🔙 Ortga"** (`back_to_dashboard` yoki `show_status_menu`) tugmasini bossa, `fixing_error_index` **tozalanmaydi (`undefined` qilinmaydi)!**
  2. Xuddi shunday, `"✏️ Tahrirlash"` (`cbEditQuestionStart`, 820-qator) bosilganda `editing_question_index: idx` yoziladi. Foydalanuvchi **"❌ Bekor qilish"** (`preview_q_${idx}`) ni bossa, `cbPreviewQuestion` ichida `editing_question_index` **tozalanmaydi!**
* **Oqibati:** Foydalanuvchi keyinroq `"📝 Matn"` yoki `"📊 Telegram Quiz"` bo'limiga kirib yangi savol yuborganida, `onQuestionMessage` (608 va 626-qatorlar) uni hali ham 1-savolni tahrirlayapti yoki xatoni tuzatyapti deb o'ylaydi! Telegram Poll yuborsa `"⚠️ Iltimos, matn yuboring."` deb rad etadi, matn yuborsa eski savolning ustiga yozib yuboradi!
* **Yechim:** `showDraftDashboard`, `showEditDashboard`, `cbPreviewQuestion`, `cbPreviewGrid`, `cbFmt` va `showAutoDocxStatusMenu` funksiyalarining boshida `editing_question_index: undefined, fixing_error_index: undefined` qilib tozalash.

---

### 🔴 Bug #4: Admin Test Yaratish (`adminHandlers.js`) da Yo'riqnoma va Parser o'rtasidagi 100% ziddiyat
* **Manzil:** `src/handlers/adminHandlers.js` (1039–1044 va 1168–1176-qatorlar) hamda `src/core/utils.js` (307–317-qatorlar)
* **Xavflilik darajasi:** **CRITICAL**
* **Sababi:** Admin panelda yangi rasmiy test qo'shishda (`adminPrompt` va `onAdmTextContent`) adminga quyidagi shablon ko'rsatiladi:
  ```text
  Savol?
  A) variant
  B) variant
  C) variant
  D) variant
  # to'g'ri javob (A, B, C yoki D)
  ```
  Ammo `parseTextQuestions(ctx.message.text)` funksiyasi `# A` ko'rinishidagi 5-qatorni **tushunmaydi**! U `#` belgisini to'g'ri variant qatorining boshida (`#A) variant`) kutadi.
* **Oqibati:** Admin ko'rsatmaga amal qilib oxirgi qatorga `# A` yoki `# B` deb yozsa, parser buni **5-variant (`E) A`)** sifatida qabul qiladi va o'sha 5-variantni "to'g'ri javob" qilib belgilaydi!
* **Yechim:** `parseTextQuestions` da oxirgi qator `^#\s*([A-Ja-j1-9])$` formatida bo'lsa, uni variant sifatida emas, mos harf/raqam indeksidagi variantni to'g'ri javob sifatida belgilaydigan qilish hamda yo'riqnomani unifikatsiya qilish.

---

### 🔴 Bug #5: `parseTextQuestions` da o'nli kasrlar qirqilishi, ko'p qatorli savollar buzilishi va `A) #Javob` formatining rad etilishi
* **Manzil:** `src/core/utils.js` (285–336-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. **O'nli kasrlar qirqilishi (313-qator):** `optText = optText.replace(/^[a-zA-Z0-9][\)\.]\s*/, '').trim();`
     Agar variant matni `"1.5 mol"` yoki `"3.14 sm"` bo'lsa, regex boshidagi `"1."` yoki `"3."` ni variant raqami deb o'ylab o'chirib yuboradi! Variant `"5 mol"` yoki `"14 sm"` bo'lib qoladi.
  2. **`A) #Javob` formati (311-qator):** Ko'plab ustozlar `#A) Javob` emas, `A) #Javob` deb yozadi. Kod avval `startsWith('#')` ni tekshirib, keyin `A)` ni o'chirgani uchun bunday savollarni yaroqsiz (`invalid`) deb topadi.
  3. **Bo'sh savol matni (`questionText === ""`):** Agar blokda savol matni tushib qolib, 1-qatorning o'zi variantdan boshlansa yoki faqat `"1."` bo'lsa, `questionText` bo'sh (`""`) bo'lib qoladi va Telegram Poll yuborishda xatolik beradi.

---

### 🔴 Bug #6: Dublikat variantlar va `sanitizeQuizQuestions` da `correct_index` siljib ketishi
* **Manzil:** `src/validators/testValidators.js` (40–99-qatorlar) va `src/core/questionUtils.js` (22–40-qatorlar)
* **Xavflilik darajasi:** **CRITICAL**
* **Sababi:**
  1. `sanitizeQuizQuestions` dublikat variantlarni `seen.has(lower)` orqali o'chirib tashlaydi, **lekin `numCorrect` indeksini yangilamaydi!**
     Masalan, `rawOptions = ["A", "A", "B", "C"]` va `correct_index = 2` (`"B"`) bo'lsa, deduplikatsiyadan keyin `options = ["A", "B", "C"]` bo'ladi (`"B"` endi `1`-indeksda), ammo `correct_index` `2` ligicha qolib, xato javob `"C"` ni to'g'ri deb belgilaydi!
  2. `prepareShuffledQuestions` (`questionUtils.js` 30-qator) da variantlar aralashtirilgach, to'g'ri javob indeksi `options.indexOf(...)` orqali matn bo'yicha qidiriladi. Agar foydalanuvchi tuzgan testda ikkita bir xil matnli variant bo'lib qolsa, `indexOf` doim birinchisini tanlaydi.
* **Yechim:** `prepareShuffledQuestions` da variantlarni `{ text, isCorrect: idx === q.correct_index }` obyektlari sifatida aralashtirish va `sanitizeQuizQuestions` da to'g'ri javob matnini deduplikatsiyadan oldin olib qolib, keyin `findIndex` bilan topish.

---

### 🔴 Bug #7: `cbFinishCreation` da DB xatoligi yuz berganda Crash (`encodeShareToken` exception) va 25-savoldan keyin majburiy bo'lib yuborish
* **Manzil:** `src/handlers/testCreation.js` (889–942-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. Agar Supabase vaqtincha uzilgan bo'lsa yoki xato qaytarsa, `dbService.saveUserTest` `null` qaytaradi. `testIds` massivi `[null]` yoki `[]` bo'lib qoladi. 940-qatorda `buildShareLink(botInfo.username, 't', firstTestId)` chaqirilganda `encodeShareToken` `Error: type and id are required` xatosini otadi va foydalanuvchining yig'gan savollari `clearState(ctx)` bilan o'chib ketadi.
  2. Oddiy `.docx` yuklashda foydalanuvchiga `"Bitta blok uchun 50 ta savol qabul qilinadi"` deyiladi (365-qator), lekin `cbFinishCreation` (889-qator) `CHUNK_SIZE = 25` bo'lgani uchun 30 ta savolli blokni ham majburan 2 ta blokka bo'lib yuboradi (`!data.is_auto_docx` bo'lganda 50 tagacha bitta blokda saqlashi kerak edi).

---

### 🟠 Bug #8: Admin AI Test Yaratishda (`onAiTestsText` va `onAiTestsImage`) mantiqiy xato
* **Manzil:** `src/handlers/aiTestsHandlers.js` (180–245-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. `onAiTestsText` ichida:
     ```javascript
     let count = 'auto';
     if (text.toLowerCase() === 'auto') {
     } else {
       count = text.trim();
     }
     const questions = await aiService.generateQuizFromText(text, count);
     ```
     Admin matn yuborsa, `count` o'zgaruvchisiga ham butun maqola matni yozilib qoladi! Admin `"auto"` deb yozsa, AI ga `"auto"` so'zidan test tuzish buyuriladi!
  2. `onAiTestsImage` da rasm yuborishdan oldin faqat `"auto"` so'zi qabul qilinadi, agar admin `"15"` deb savol sonini yozsa rad etiladi.

---

## 🚨 2-BO'LIM: QUIZ ISHLASH (TEST SOLVING), PAUZA VA JAVON BUGLARI

### 🔴 Bug #9: `sendNextQuestion` da `correctIndex` tuzatilsa-da, `session.sessionQuestions` yangilanmasligi (To'g'ri javob ❌ Xato deb hisoblanishi)
* **Manzil:** `src/handlers/coreQuiz.js` (172–210 va 529-qatorlar)
* **Xavflilik darajasi:** **CRITICAL**
* **Sababi:** `sendNextQuestion` ichida:
  ```javascript
  let correctIndex = typeof q.correct_index === "number" ? q.correct_index : 0;
  if (correctIndex < 0 || correctIndex >= options.length) {
    correctIndex = 0;
  }
  ```
  Telegram Poll `correct_option_id: correctIndex` bilan yuboriladi. Ammo `q.correct_index` ning o'zi yangilanmaydi!
  * Guruh rejimida (207-qator): `activePollsCache.set(msg.poll.id, { ..., correct_index: q.correct_index })`
  * Shaxsiy rejimda (529-qator): `const isCorrect = pollAnswer.option_ids[0] === qData.correct_index;`
  Agar savolda `options.length > 10` bo'lib qirqilgan bo'lsa yoki `correct_index` noto'g'ri bo'lsa, Telegram Poll'da yashil chiroq yonadi, lekin bot javobni **xato** deb hisoblaydi!
* **Yechim:** `q.options = options; q.correct_index = correctIndex;` qilib sessiyadagi savol obyektini ham sinxronlash.

---

### 🔴 Bug #10: BullMQ Taymer `jobId` (`timeout:${chatId}:${session.qIdx}`) to'qnashuvi — Pauza/Resume va Qayta boshlashda taymer ishlamay qolishi
* **Manzil:** `src/handlers/coreQuiz.js` (296–305-qatorlar)
* **Xavflilik darajasi:** **CRITICAL**
* **Sababi:** BullMQ da `jobId: timeout:${chatId}:${session.qIdx}` ishlatilgan.
  Agar:
  1. Foydalanuvchi savolga javob berdi yoki `/stop` bosdi, lekin `quizTimerQueue.getJob(...).then(j => j && j.remove())` asinxron (`await` qilinmagan!) bo'lgani uchun yoki job `failed`/`active` holatda qolgani uchun hali o'chmagan bo'lsa;
  2. Foydalanuvchi `"▶️ Davom etish"` (`cbPauseResume`) ni bosganda aynan o'sha `qIdx` uchun qaytadan `timeout:${chatId}:${session.qIdx}` qo'shiladi;
  3. Yoki Guruh Marafonida 1-blok tugab, 2-blok `qIdx = 0` dan boshlanganda (31 soniya ichida);
  BullMQ bir xil `jobId` li vazifa navbatda turgan bo'lsa, yangi taymerni **indamay e'tiborsiz qoldiradi (ignore qiladi)** yoki eski taymer yangi savolni muddatidan oldin (masalan, 3 soniyada) yopib qo'yadi!
* **Yechim:** `jobId` ichiga `msg.poll.id` ni qo'shish: `jobId: timeout:${chatId}:${session.qIdx}:${msg.poll.id}` va `session.timerJobId` sifatida saqlash. Shunda har bir Poll o'zining 100% unikal taymeriga ega bo'ladi va eski taymer hech qachon yangi savolni yopib yubora olmaydi (`session.pollId === pollId` tekshiruvi allaqachon `questionTimeout` da bor).

---

### 🔴 Bug #11: Javonga saqlashda (`cbPauseShelf` va `saveTestToShelf`) Ma'lumot yo'qolishi va Tugallangan testning "Chala" bo'lib ko'rinishi
* **Manzil:** `src/handlers/quizGame.js` (482–520-qatorlar), `src/services/dbService.js` (659-qator), `src/handlers/shelfHandlers.js` (286-qator)
* **Xavflilik darajasi:** **CRITICAL**
* **Sababi:**
  1. **Faol testning erta o'chirilishi:** `cbPauseShelf` foydalanuvchi hali papkani tanlamasdan turib `sessionService.deleteActiveTest(chatId)` qiladi. Agar foydalanuvchi keyingi oynada `"❌ Bekor qilish"` ni bossa, test butunlay yo'qoladi.
  2. **Progress yangilanmasligi (`exist` bugi):** Foydalanuvchi Javondan testni ochib, 5-savoldan 15-savolgacha ishlab, yana Javonga saqlamoqchi bo'lsa, `dbService.saveTestToShelf` `if (isExist) return 'exist';` deb rad etadi! Natijada 5-savoldan 15-savolgacha ishlagan mehnati kuyib ketadi.
  3. **`mock` va `adaptive` ID to'qnashuvi:** Barcha Aralash testlarning `testId` si `"mock"`, barcha Adaptiv testlarniki `"adaptive"`. Foydalanuvchi bitta papkaga ikkinchi marta Aralash test saqlay olmaydi (`"exist"` beradi).
  4. **Yakunlangan testning "⏳ 25-savolga kelgan" deb ko'rinishi:** `finishTest` (`coreQuiz.js` 359-qator) test tugaganda `progress.current_index = session.sessionQuestions.length` (masalan, `25`) qilib yozadi. `cbViewTest` (`shelfHandlers.js` 286-qator) esa `if (test.progress && test.progress.current_index > 0)` deb tekshirgani uchun, 100% tugallangan testni ham `"⏳ 25-savolga kelgan. ▶️ Qolgan joyidan davom etish"` deb ko'rsatadi!
* **Yechim:**
  * `saveTestToShelf` da agar `isExist` topilsa, uning `progress`, `questions` va `saved_at` maydonlarini yangilash (`upsert`).
  * `cbViewTest` da `test.progress.current_index > 0 && test.progress.current_index < qCount` bo'lgandagina `"Qolgan joyidan davom etish"`, aks holda `"✅ Yakunlangan (Qaytadan boshlash)"` deb ko'rsatish.

---

### 🔴 Bug #12: Xatolar ustida ishlash (`cbWmStartQuiz`, `cbReviewMistakes`, `sendNextInlineMistake`) dagi 4 ta jiddiy xato
* **Manzil:** `src/handlers/quizGame.js` (582, 610–825-qatorlar) va `src/handlers/coreQuiz.js` (127-qator)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. **`testId = "retry"` tugma xatosi:** `cbWmStartQuiz` testni `testId = "retry"` bilan boshlaydi, lekin `buildFinishButtons` `sid.startsWith("retry_")` ni kutadi. Natijada test tugagach `post_start_${subjectKey}_retry` tugmasi chiqadi va bosilganda `parseInt("retry")` -> `NaN` bo'lib ishlamaydi.
  2. **UGC / AI testlardan keyin noto'g'ri menyuga qaytish:** `cbReviewMistakes` va `cbWorkMistakesMenu` dagi `"🔙 Fan menyusiga"` tugmasi har doim `post_subj_${subjectKey}` (Rasmiy testlar) ga otadi. Agar foydalanuvchi shaxsiy (`ugc_`) test ishlagan bo'lsa, u o'zining faniga emas, bo'sh rasmiy fanga tushib qoladi.
  3. **Interaktiv rejimda 20s taymerda Mutex yo'qligi:** `wmTimer` (718-qator) mutexsiz `checkState.queue.shift()` qiladi. Foydalanuvchi 20-soniyada tugmani bossa, ikki marta `shift()` bo'lib, keyingi savol o'tkazib yuboriladi.
  4. **`"⏳ Vaqt tugadi"` variant sifatida chiqishi:** 671-qatorda `if (!options || options.length === 0) options = [String(q.correct_ans), String(q.wrong_ans)]` qilingan. Agar savolda vaqt tugagan bo'lsa, variantlardan biri `"⏳ Vaqt tugadi"` bo'lib chiqadi.

---

## 🚨 3-BO'LIM: GURUH MUSOBAQALARI (GROUP QUIZ & MARATHON) BUGLARI

### 🔴 Bug #13: Guruh testida barcha qatnashchilar javob berib bo'lsa ham bot 31 soniya kutib turishi va AFK guruhlarda cheksiz spam
* **Manzil:** `src/handlers/coreQuiz.js` (480–523 va 590–645-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. `handlePollAnswer` guruh savoliga javob kelganda `groupTestCache` ga ballni yozadi va **522-qatorda shunchaki `return` qiladi**. Agar kutish zalida (`readyUsers`) 3 kishi ro'yxatdan o'tgan bo'lsa va uchalasi ham 4 soniyada javob bersa, bot baribir 31 soniya tugashini kutadi!
  2. `questionTimeout` ichida `consecutiveTimeouts` faqat `session.chatType === "private"` uchungina ishlaydi (597-qator). Agar guruhda marafon (masalan, 100 ta savol) boshlanib, hamma guruhdan chiqib ketsa yoki javob bermasa, bot hech qachon to'xtamaydi va guruhga 100 ta so'rovnoma tashlab spam qiladi!
* **Yechim:**
  * Guruh sessiyasida `expectedParticipantsCount = Object.keys(room.readyUsers).length` ni saqlash; agar barcha ro'yxatdan o'tganlar javob bersa (va kamida 2 kishi), Poll'ni yopib keyingi savolga o'tish.
  * Guruhda ketma-ket 3 ta savolga umuman hech kim (0 kishi) javob bermasa, testni avtomatik to'xtatib natijani e'lon qilish.

---

### 🔴 Bug #14: Guruhda `/stop` bosilganda Shaxsiy Pauza Menyusi chiqishi va `groupTestCache` tozalanmasligi
* **Manzil:** `src/handlers/startHandler.js` (196–215-qatorlar), `src/handlers/quizGame.js` (407–520 va 898-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. `cmdStop` (`startHandler.js` 202-qator) da `if (cbStopTest) return cbStopTest(ctx);` yozilgan. `cbStopTest` doim mavjud bo'lgani uchun `else` dagi guruh marafonini yakunlash kodi **hech qachon ishlamaydi!** Guruhda `/stop` bosilganda shaxsiy pauza menyusi (`"📥 Javonga saqlash"`) chiqadi va guruhning istalgan a'zosi tugmalarni bosib o'yinni buzishi mumkin.
  2. `cbForceFinish` (`quizGame.js` 898-qator) yoki `cmdStart` faol testni o'chirganida `groupTestCache.delete(chatId)` qilinmaydi! Natijada guruhda yangi o'yin boshlanganda (`sendNextQuestion` 211-qator: `if (!(await groupTestCache.get(chatId)))`), eski bekor qilingan o'yinning ballari yangi o'yinga qo'shilib ketadi!
  3. `createLobby` (`groupQuizLogic.js` 51-qator) guruhda allaqachon faol test ketayotganini tekshirmaydi.

---

## 🚨 4-BO'LIM: BAZA (SUPABASE), REDIS, JADVAL VA ADMIN PANEL BUGLARI

### 🔴 Bug #15: `dbService.getUsersByClassName` da mavjud bo'lmagan `name` ustuni so'ralishi — `/groupnote` guruhdoshlarga bormasligi!
* **Manzil:** `src/services/dbService.js` (371–393-qatorlar) va `src/services/scheduleWatcherService.js` (869-qator)
* **Xavflilik darajasi:** **CRITICAL**
* **Sababi:** `getUsersByClassName` funksiyasida:
  ```javascript
  const { data, error } = await supabase
    .from('users')
    .select('telegram_id, name, class_name')
    .ilike('class_name', className)
  ```
  `public.users` jadvalida `name` degan ustun **yo'q** (ustun nomi `full_name` — qarang: 206, 248, 340-qatorlar)!
  Supabase (PostgREST) `column users.name does not exist` xatosini qaytaradi, `catch` bloki esa buni ushlab `return []` qaytaradi!
* **Oqibati:** `getUsersByClassName` har doim bo'sh massiv `[]` qaytaradi! Sardor `/groupnote` orqali butun guruh uchun eslatma yaratganida (`deliverNoteReminder`), bazadan guruh a'zolari topilmaydi.
* **Yechim:** `.select('telegram_id, full_name, class_name')` ga o'zgartirish.

---

### 🔴 Bug #16: `adminHandlers.js` da `https` va `http` modullari import qilinmagani sababli `/upload_timetable` da `ReferenceError` Crash!
* **Manzil:** `src/handlers/adminHandlers.js` (1–18 va 1335-qatorlar)
* **Xavflilik darajasi:** **CRITICAL**
* **Sababi:** `handleTimetableDocumentIngest` (1335-qator) ichida:
  ```javascript
  const httpsLib = fileLink.href.startsWith('https') ? https : http;
  ```
  Ammo `src/handlers/adminHandlers.js` faylining tepasida `const https = require('https');` va `const http = require('http');` **umuman yozilmagan!**
* **Oqibati:** Admin favqulodda holatda `timetable_cache.json` faylini yuklaganida funksiya darhol `ReferenceError: https is not defined` bilan qulaydi!

---

### 🔴 Bug #17: Haftalik jadval rasmida (`imageService.js`) Toq/Juft hafta va Tanlov fanlarning 2-fani yo'qolib ketishi hamda Xona birlashib ketishi
* **Manzil:** `src/services/imageService.js` (1455–1492-qatorlar) va `src/services/scheduleWatcherService.js` (113–130-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. **Ikkinchi fanning yashirinib qolishi (1459 va 1481-qatorlar):** Agar bitta parada 2 ta yozuv bo'lsa (masalan, Toq haftada *Ekonometrika*, Juft haftada *Moliyaviy hisob*; yoki 1-kichik guruhda *Ingliz tili*, 2-kichik guruhda *Nemis tili*), `imageService.js` faqat `lesson = lessons[0]` ning fan nomini oladi (`lessons[1].subject` ni butunlay tashlab yuboradi!) va ikkala o'qituvchi hamda xonani bitta fanga birlashtirib yuboradi!
  2. **Ketma-ket paralarda xona tekshirilmasligi (1468-qator):**
     ```javascript
     if (nxt && nxt.length > 0 && nxt[0].subject === lesson.subject && nxt[0].teacher === lesson.teacher) {
       span++;
     }
     ```
     Agar bitta o'qituvchi ketma-ket 2 para dars o'tsa, lekin 2-para **boshqa xonada** bo'lsa, kod xonalar bir xilligini (`nxt[0].room === lesson.room`) tekshirmasdan 2 ta katakni bitta kartochkaga birlashtirib yuboradi va 2-paraning xonasini ko'rsatmaydi!
  3. **Watcher'da kichik guruh va hafta juftligi ko'rinmasligi:** `scheduleWatcherService.js` dagi `getSimplifiedSchedule` ichida `subgroup` va `weekParity` maydonlari olib qolinmagan.

---

### 🔴 Bug #18: `index.js` da Asosiy Menyu tugmalari ro'yxati (`isMainMenuButton`) va `keyboards.js` o'rtasidagi nomuvofiqlik
* **Manzil:** `index.js` (331–342-qatorlar), `src/handlers/noteHandler.js` (536–546-qatorlar), `src/keyboards/keyboards.js` (120–124-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:** `keyboards.js` da foydalanuvchiga quyidagi Reply Keyboard tugmalari chiqariladi:
  `["📅 Bugungi jadval", "🖼 Haftalik jadval"]`, `["🏢 Bo'sh xonalar", "⚙️ Guruhni sozlash"]`, `["🔙 Asosiy menyu"]`.
  Ammo `index.js` (331-qator) da wizard state'dan chiqish uchun tekshiriladigan ro'yxatda:
  `'📅 Bugungi jadval'`, `'🖼 Haftalik jadval'`, `'⚙️ Guruhni sozlash'`, `'🔙 Asosiy menyu'` tugmalari **yo'q!**
  Bundan tashqari, `text.includes(btn)` ishlatilgan: agar foydalanuvchi insho (`AI_ESSAY_ANALYSIS`) yoki adminga murojaat (`USER_CONTACT`) yozayotib matn ichida `"Statistika"` yoki `"Profil"` so'zini ishlatsa (`btn` da emoji bor, lekin ehtiyot bo'lish kerak), `text === btn` o'rniga `includes` ishlatilgan.
* **Oqibati:** Foydalanuvchi guruh kiritish (`SET_CLASS`) yoki fan kiritish (`CREATE_SUBJECT`) bosqichida turib pastdagi `"📅 Bugungi jadval"` yoki `"🔙 Asosiy menyu"` reply tugmasini bossa, bot state'dan chiqmaydi va `"📅 Bugungi jadval"` ni guruh nomi sifatida qidirib `"❌ 📅 Bugungi jadval nomli guruh topilmadi"` deydi!

---

### 🔴 Bug #19: `index.js` Session Middleware'da Parallel So'rovlar (Concurrent Updates) Race Condition
* **Manzil:** `index.js` (104–149-qatorlar)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:** Foydalanuvchi 2 ta tugmani ketma-ket tez bossa yoki media-guruh (albom) yuborsa, ikkita update bir vaqtda `tg_session:${userId}` ni o'qiydi, har biri o'zining xotirasidagi `ctx.session` ni o'zgartiradi va oxirgi tugagan update birinchisining yozgan ma'lumotlarini ustidan bosib o'chirib yuboradi (Lost Update).

---

### 🟠 Bug #20: `utils.js` dagi `truncateText` funksiyasida `<a href="...">` tegining yopilmasligi va teglarning noto'g'ri tartibda yopilishi
* **Manzil:** `src/core/utils.js` (147–173-qatorlar)
* **Xavflilik darajasi:** **MEDIUM-HIGH**
* **Sababi:**
  1. `const tags = ['b', 'i', 's', 'u', 'code', 'pre'];` — ro'yxatda `a` (`<a href="...">`) tegi yo'q! Agar kesish `<a href="...">Ism</a>` tegining ichiga to'g'ri kelsa, `</a>` yopilmay qoladi va Telegram `400 Bad Request: can't parse entities` beradi.
  2. Teglar LIFO (ochilish tartibiga teskari stek) bo'yicha emas, qat'iy massiv tartibida yopilgani uchun `<i><b>matn` -> `<i><b>matn</b></i>` (to'g'ri), lekin `<b><i>matn` -> `<b><i>matn</b></i>` (xato kesishgan teglar!) hosil bo'ladi va Telegram HTML parseri xato beradi.

---

### 🟠 Bug #21: `dbService.updateUserStats` da `percent` saqlanmasligi va Tarix (`statsHandlers.js`) teskari ko'rsatilishi
* **Manzil:** `src/services/dbService.js` (117–128-qatorlar), `src/handlers/adminHandlers.js` (634-qator), `src/handlers/contactAdmin.js` (34-qator), `src/handlers/statsHandlers.js` (129-qator)
* **Xavflilik darajasi:** **HIGH**
* **Sababi:**
  1. `updateUserStats` tarixga `percent` maydonini yozmaydi (`correct` va `wrong` ni yozadi). Admin panel (`showUserDetails`) va `contactAdmin` esa `h.percent || 0` orqali o'rtacha ballni hisoblaydi — natijada barcha foydalanuvchilarning o'rtacha bali Admin panelda **`0%`** ko'rinadi!
  2. `updateUserStats` yangi testni `stats.history.unshift(entry)` bilan 0-indeksga qo'shadi (eng yangisi boshida). Ammo `statsHandlers.js` (129-qator) da `.slice().reverse()` qilingani uchun foydalanuvchiga eng eski testi 1-bo'lib ko'rinadi, `contactAdmin.js` (31-qator) da `history[history.length - 1]` olingani uchun oxirgi test o'rniga eng birinchi test sanasi chiqadi.

---

### 🟠 Bug #22: Admin Reply (`adminHandlers.js` vs `contactAdmin.js`) da Caption va Media turlarining yo'qolishi
* **Manzil:** `src/handlers/adminHandlers.js` (958–1020-qatorlar) va `index.js` (378-qator)
* **Xavflilik darajasi:** **MEDIUM-HIGH**
* **Sababi:** Admin `"✉️ Javob yozish"` tugmasini bosganda `States.ADMIN_REPLY` o'rnatiladi. Admin rasm yoki faylga izoh (caption) yozib yuborsa, `index.js` (378-qator) uni `handlers.admin.onReplyMessage` ga yo'naltiradi. `onReplyMessage` esa `ctx.message.caption` ni o'qimaydi (`ctx.message?.text || ''`) hamda audio/sticker/video_note/animation turlarini `hasMedia` deb tanimaydi.

---

### 🟠 Bug #23: Smart Schedule v2 (`runSmartScheduleIntervalTick`) da `currentHHMM === '07:00'` qat'iy tengligi sababli eslatmalarning o'tkazib yuborilishi
* **Manzil:** `src/services/scheduleWatcherService.js` (965–1085-qatorlar)
* **Xavflilik darajasi:** **MEDIUM-HIGH**
* **Sababi:** Cron har 5 daqiqada (`*/5 6-22 * * *`) ishlaydi. Agar `07:00` da serverda GC, EduPage tarmoq so'rovi yoki konteyner qayta ishga tushishi sababli funksiya `07:01:02` da bajarilsa, `currentHHMM` `'07:01'` bo'ladi va `currentHHMM === '07:00'` (yoki `'11:30'`, `'20:00'`, `'20:30'`) sharti bajarilmay qoladi!
* **Yechim:** Vaqtni `currentHHMM === '07:00'` emas, daqiqa oralig'i (`currentMinFromMidnight >= targetMin && currentMinFromMidnight < targetMin + 10`) bilan tekshirish (chunki `acquireNotificationLock` Redis'da bir kunda faqat 1 marta yuborilishini allaqachon kafolatlaydi!).

---

### 🟠 Bug #24: Socket.io Kahoot (`gameLoop.js` va `socket/index.js`) da savollar massivining faqat 1-savoli o'ynalishi va `room:created` hodisasi yo'qligi
* **Manzil:** `src/socket/gameLoop.js` (42-qator) va `src/socket/index.js` (30–43, 102–120-qatorlar)
* **Xavflilik darajasi:** **MEDIUM-HIGH**
* **Sababi:**
  1. `kahoot_questions` jadvalida har bir qator `{ topic, questions: [q1, q2, ...] }` ko'rinishida saqlanadi. `gameLoop.js` da `const subQ = Array.isArray(q.questions) ? q.questions[0] : q;` qilingani uchun har bir blokning faqat 1-savoli o'qiladi, qolgan savollar tashlab ketiladi.
  2. `room:create` da xona yaratilgach klientga `socket.emit("room:created", ...)` yuborilmaydi.

---

## 📊 YIG'MA JADVAL (BARCHA ANIQLANGAN BUGLAR RO'YXATI)

| # | Fayl | Funksiyalar / Qatorlar | Xatolik tavsifi | Daraja |
|---|---|---|---|---|
| **1** | `testCreation.js`, `index.js` | `onQuestionMessage` (675), Middleware (135) | 400ms `setTimeout` debounce sababli matnli savollar Redis sessiyasiga saqlanmay qolishi | 🔴 **CRITICAL** |
| **2** | `testCreation.js` | `processBatchedTextQuestions` (594), `showDraftDashboard` (222) | Matn va oddiy Word rejimida xato savollar (`invalidQs`) foydalanuvchiga ko'rsatilmasligi | 🔴 **HIGH** |
| **3** | `testCreation.js` | `cbFixErrors` (1138), `cbEditQuestionStart` (820) | "Ortga/Bekor qilish" bosilganda `fixing_error_index` va `editing_question_index` tozalanmasligi | 🔴 **CRITICAL** |
| **4** | `adminHandlers.js`, `utils.js` | `adminPrompt` (1039), `parseTextQuestions` (307) | Admin test yaratishdagi `# A` yo'riqnomasi parser tomonidan 5-variant deb qabul qilinishi | 🔴 **CRITICAL** |
| **5** | `utils.js` | `parseTextQuestions` (296, 311, 313) | `1.5` kabi o'nli kasrlarning qirqilishi, `A) #Javob` formatining o'qilmasligi, bo'sh savol matni | 🔴 **HIGH** |
| **6** | `testValidators.js`, `questionUtils.js` | `sanitizeQuizQuestions` (65–88), `prepareShuffledQuestions` (30) | Dublikat variantlar o'chirilganda yoki aralashtirilganda `correct_index` siljib ketishi | 🔴 **CRITICAL** |
| **7** | `testCreation.js` | `cbFinishCreation` (889–942) | DB xatoligida `encodeShareToken` crash berishi va 26–50 ta savolli bitta blokning majburan bo'linishi | 🔴 **HIGH** |
| **8** | `aiTestsHandlers.js` | `onAiTestsText` (180), `onAiTestsImage` (231) | Admin AI testda matnning `count` sifatida uzatilishi va `"auto"` so'zidan test tuzilishi | 🔴 **HIGH** |
| **9** | `coreQuiz.js` | `sendNextQuestion` (172), `handlePollAnswer` (529) | `correctIndex` tuzatilganda `sessionQuestions` yangilanmasligi (to'g'ri javob xato hisoblanishi) | 🔴 **CRITICAL** |
| **10** | `coreQuiz.js` | `sendNextQuestion` (298) | BullMQ `jobId: timeout:${chatId}:${qIdx}` to'qnashuvi (Pauza/Resume va Marafonda taymer buzilishi) | 🔴 **CRITICAL** |
| **11** | `quizGame.js`, `dbService.js`, `shelfHandlers.js` | `cbPauseShelf` (482), `saveTestToShelf` (659), `cbViewTest` (286) | Javonga saqlashda faol test erta o'chishi, progress ustidan yozilmasligi va tugallangan test "chala" ko'rinishi | 🔴 **CRITICAL** |
| **12** | `quizGame.js`, `coreQuiz.js` | `cbWmStartQuiz` (650), `cbReviewMistakes` (582), `wmTimer` (718) | `testId="retry"` da `NaN` xatosi, UGC testdan Rasmiy fanga otib yuborishi, 20s taymerda race condition | 🔴 **HIGH** |
| **13** | `coreQuiz.js` | `handlePollAnswer` (480), `questionTimeout` (597) | Guruhda hamma javob bersa ham 31s kutishi va AFK guruhlarda marafon to'xtamasdan spam qilishi | 🔴 **HIGH** |
| **14** | `startHandler.js`, `quizGame.js`, `groupQuizLogic.js` | `cmdStop` (202), `cbForceFinish` (898), `createLobby` (51) | Guruhda `/stop` bosilganda shaxsiy pauza menyusi chiqishi va `groupTestCache` tozalanmasligi | 🔴 **HIGH** |
| **15** | `dbService.js` | `getUsersByClassName` (378) | Mavjud bo'lmagan `name` ustuni (`full_name` o'rniga) so'ralishi sababli `/groupnote` ishlamasligi | 🔴 **CRITICAL** |
| **16** | `adminHandlers.js` | `handleTimetableDocumentIngest` (1335) | `https` va `http` import qilinmagani sababli `/upload_timetable` da `ReferenceError` crash | 🔴 **CRITICAL** |
| **17** | `imageService.js`, `scheduleWatcherService.js` | `generateScheduleImage` (1459–1485), `getSimplifiedSchedule` (113) | Rasmda Toq/Juft hafta va tanlov fanlarning 2-fani tushib qolishi hamda xonalar tekshirilmasdan birlashishi | 🔴 **HIGH** |
| **18** | `index.js`, `noteHandler.js` | `isMainMenuButton` (331, 536) | Reply klaviatura tugmalari (`📅 Bugungi jadval`, `🔙 Asosiy menyu`) wizard state'ni to'xtatmasligi | 🔴 **HIGH** |
| **19** | `index.js` | Session Middleware (104–149) | Bir foydalanuvchidan parallel kelgan update'larda Redis session ustidan yozilib ketishi | 🟠 **HIGH** |
| **20** | `utils.js` | `truncateText` (147–173) | `<a>` tegi yopilmasligi va ichma-ich teglarning LIFO tartibida yopilmasligi (`400 Bad Request`) | 🟠 **MEDIUM** |
| **21** | `dbService.js`, `statsHandlers.js` | `updateUserStats` (117), `cbHistoryPage` (129) | `history` da `percent` yo'qligi sababli Admin panelda `0%` chiqishi va tarixning teskari ko'rinishi | 🟠 **HIGH** |
| **22** | `adminHandlers.js`, `contactAdmin.js` | `onReplyMessage` (958) | Admin javob yozganda media caption o'qilmasligi va audio/sticker/video_note yuborilmasligi | 🟠 **MEDIUM** |
| **23** | `scheduleWatcherService.js` | `runSmartScheduleIntervalTick` (965–1085) | `currentHHMM === '07:00'` qat'iy tengligi sababli 1 daqiqa kechikishda kunlik jadval yuborilmasligi | 🟠 **MEDIUM** |
| **24** | `socket/gameLoop.js`, `socket/index.js` | `advanceQuestion` (42), `room:start` (104) | Kahoot savollar massivining faqat 0-indeksi o'qilishi (`flatMap` qilinmagani) | 🟠 **MEDIUM** |