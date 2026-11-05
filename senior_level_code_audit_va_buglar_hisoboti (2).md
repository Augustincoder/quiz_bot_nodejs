# 🛡️ Senior-Level Qayta Audit (Re-Audit) va Regressiya Tekshiruvi Hisoboti (`ALL_SYSTEM_CODE_2.txt`)

Ushbu hisobot yangilangan 47 ta fayldan iborat kod bazasini (`ALL_SYSTEM_CODE_2.txt`) avvalgi auditda aniqlangan **24 ta bug** bo'yicha tekshirish hamda yangi yozilgan kodlarda yuzaga kelgan **regressiya va yashirin xatoliklarni** aniqlash natijasidir.

---

## ✅ 1-BO'LIM: AVVALGI 24 TA BUGNING TUZATILGANLIK HOLATI (VERIFICATION MATRIX)

| # | Xatolik tavsifi | Holati | Izoh |
|---|---|---|---|
| **1** | Matn formatida savol qo'shishda 400ms Debounce va Redis Session saqlanmasligi | ✅ **Tuzatildi** | `updateData` va `processBatchedTextQuestions` ichida Redis'ga yozish qo'shildi. *(Kichik chekka holat: `cbCancelCreation` da 400ms taymerni tozalash kerak — Yangi Bug #6 ga qarang).* |
| **2** | Matn va oddiy Word rejimida xato savollar (`invalidQs`) yashirilishi | ✅ **Tuzatildi** | `showDraftDashboard` va `processBatchedTextQuestions` da `invalidQs` tugmalari va hisoboti chiqarildi. |
| **3** | `fixing_error_index` va `editing_question_index` bayroqlarining yopishib qolishi | ✅ **Tuzatildi** | Barcha asosiy dashboard va preview funksiyalarida `undefined` qilib tozalanmoqda. |
| **4** | Admin test yaratishdagi `# A` yo'riqnomasi va parser ziddiyati | ⚠️ **Qisman (Regressiya bor)** | `# A` formati qo'shildi, ammo u 1 belgili oddiy variantlarni (`#4`, `#A`) o'chirib yuboradigan regressiya keltirib chiqardi *(Yangi Bug #1 ga qarang)*. |
| **5** | `parseTextQuestions` da `1.5` kabi o'nli kasrlar qirqilishi va `A) #Javob` formati | ✅ **Tuzatildi** | O'nli kasrlar himoyalandi va `A) #Javob` qo'llab-quvvatlandi. |
| **6** | `sanitizeQuizQuestions` va `prepareShuffledQuestions` da `correct_index` siljishi | ⚠️ **Qisman** | `prepareShuffledQuestions` 100% tuzatildi. `sanitizeQuizQuestions` da esa >100 belgili to'g'ri javob qirqilganda `findIndex` `-1` qaytaradi *(Yangi Bug #5 ga qarang)*. |
| **7** | `cbFinishCreation` da DB xatoligida crash va 50 ta savolning 25 tadan bo'linishi | ✅ **Tuzatildi** | `SINGLE_BLOCK_MAX = 50` qilindi va `testIds.length === 0` himoyasi qo'shildi. |
| **8** | Admin AI testda (`onAiTestsText`) matnning `count` sifatida uzatilishi | ✅ **Tuzatildi** | 1-qatorda savollar soni yoki `auto` ajratib olinadigan qilindi. |
| **9** | `sendNextQuestion` da `correctIndex` o'zgarganda `sessionQuestions` yangilanmasligi | ✅ **Tuzatildi** | `q.options = options; q.correct_index = correctIndex;` qo'shildi. |
| **10** | BullMQ `jobId` to'qnashuvi (`timeout:${chatId}:${qIdx}:${pollId}`) | ✅ **Tuzatildi** | `timerJobId` ga `msg.poll.id` qo'shildi va `cancelSessionTimer` yozildi. |
| **11** | Javonga saqlash (`cbPauseShelf`, `saveTestToShelf`, `cbViewTest`) muammolari | ⚠️ **Qisman (Regressiya bor)** | Upsert va `cbViewTest` tuzatildi, ammo `mock_${Date.now()}` ID si Javondan qayta o'ynalganda `finishTest` da tugmalarni buzadi *(Yangi Bug #4 ga qarang)*. |
| **12** | Xatolar ustida ishlash (`retry`, UGC fan menyusiga qaytish, 20s mutex) | ⚠️ **Qisman** | `mistakes_meta` va mutex qo'shildi, lekin UGC fan nomi uzun/kirillcha bo'lsa `wm_menu_${subjectKey}` 64 baytdan oshib ketadi *(Yangi Bug #2 ga qarang)*. |
| **13** | Guruhda hamma javob bersa ham 31s kutishi va AFK guruhlarda cheksiz spam | ⚠️ **Qisman** | Erta o'tish va 3 ta AFK timeout qo'shildi, ammo `group_poll:${chatId}` va `poll:${chatId}` mutex kalitlari har xil bo'lib qolgan *(Yangi Bug #3 ga qarang)*. |
| **14** | Guruhda `/stop` bosilganda shaxsiy pauza menyusi chiqishi va `groupTestCache` | ✅ **Tuzatildi** | Guruhda `/stop` bosilganda to'g'ridan-to'g'ri `finishTest` chaqirilmoqda va `groupTestCache` tozalanmoqda. |
| **15** | `dbService.getUsersByClassName` da `name` ustuni xatosi (`/groupnote`) | ✅ **Tuzatildi** | `full_name` ustuniga o'tkazildi. |
| **16** | `adminHandlers.js` da `https` va `http` import qilinmagani | ✅ **Tuzatildi** | `https` va `http` import qilindi. |
| **17** | `imageService.js` da 2-fan yo'qolishi va xona tekshirilmasdan birlashishi | ✅ **Tuzatildi** | `nxt[0].room === lesson.room` va `subjects.join(' / ')` qo'shildi. |
| **18** | `index.js` va `noteHandler.js` da `isMainMenuButton` ro'yxati | ✅ **Tuzatildi** | To'liq ro'yxat va `mainMenuButtons.includes(text)` qo'yildi. |
| **19** | `index.js` Session Middleware parallel update'lar race condition | ✅ **Tuzatildi** | Redis merge check qo'shildi. |
| **20** | `utils.js` da `truncateText` funksiyasida `<a>` va LIFO teg yopilishi | ✅ **Tuzatildi** | Stek asosida LIFO yopish algoritmi yozildi. |
| **21** | `dbService.updateUserStats` da `percent` yo'qligi va teskari tarix | ✅ **Tuzatildi** | `percent` qo'shildi, `statsHandlers`, `adminHandlers`, `contactAdmin` to'g'rilandi. |
| **22** | Admin Reply'da media `caption` va qo'shimcha media turlari | ✅ **Tuzatildi** | `caption` va `audio/sticker/video_note/animation` qo'shildi. |
| **23** | `scheduleWatcherService.js` da `isTimeInWindow` | ✅ **Tuzatildi** | Kunlik jadvalda tuzatildi *(1126-qatordagi `20:30` eslatmasida qolib ketgan — Yangi Bug #7 ga qarang)*. |
| **24** | Socket.io Kahoot `flatMap` va `room:created` hodisasi | ✅ **Tuzatildi** | `flatQuestions` va `socket.emit("room:created")` qo'shildi. |

---

## 🚨 2-BO'LIM: YANGI KODDA ANIQLANGAN REGRESSIYALAR VA QOLGAN XATOLIKLAR (7 TA)

### 🔴 Yangi Bug #1 (REGRESSIYA — CRITICAL): `parseTextQuestions` da `#4` yoki `#A` ko'rinishidagi 1 belgili to'g'ri javob varianti "Javob kaliti" deb o'ylangan holda o'chirib yuborilishi!
* **Manzil:** `src/core/utils.js` (336–351-qatorlar)
* **Sababi:** Adminning `# A` formatini qo'llab-quvvatlash uchun quyidagi kod qo'shilgan:
  ```javascript
  let explicitCorrectIdx = -1;
  if (parts.length - 1 > firstOptIdx) {
    const lastLine = parts[parts.length - 1].trim();
    const trailingAnswerMatch = lastLine.match(/^[#*]\s*([a-jA-J1-9])$/i) ||
      lastLine.match(/^[#*]?\s*(?:to'?g'?ri\s+javob|javob)\s*[:=-]?\s*([a-jA-J1-9])$/i);
    if (trailingAnswerMatch) {
      ...
      parts.pop(); // Oxirgi javob kaliti qatorini variantlar orasidan olib tashlaymiz
    }
  }
  ```
  Endi tasavvur qiling, foydalanuvchi botning standart qoidasi bo'yicha (variant oldiga `A)` yozmasdan, to'g'ri javob oldiga `#` qo'yib) matematika, kimyo yoki ingliz tilidan quyidagicha savol kiritdi:
  ```text
  2 + 2 nechaga teng?
  1
  2
  3
  #4
  ```
  yoki:
  ```text
  Qaysi vitamin yetishmasligi shabko'rlikka olib keladi?
  C
  D
  E
  #A
  ```
  1. `lastLine` — `"#4"` yoki `"#A"`.
  2. `/^[#*]\s*([a-jA-J1-9])$/i` regexda `\s*` (0 yoki undan ko'p bo'sh joy) bo'lgani uchun u `"#4"` va `"#A"` ni **alohida javob kaliti qatori** deb o'ylaydi!
  3. `parts.pop()` **4-variantni (`#4` yoki `#A`) variantlar ro'yxatidan o'chirib tashlaydi!**
  4. `"#4"` holatida `opts` ichida 3 ta variant (`["1", "2", "3"]`) qoladi, `explicitCorrectIdx = 3` (`3 < 3` false) bo'lgani uchun savol **yaroqsiz (`invalid`)** deb rad etiladi!
  5. `"#A"` holatida esa `"#A"` o'chib ketib, `opts = ["C", "D", "E"]` qoladi va `explicitCorrectIdx = 0` bo'lgani uchun **xato javob `"C"` to'g'ri javob deb belgilanadi!**
* **Yechim:** Oxirgi qator `# A` javob kaliti bo'lishi uchun:
  1. Yoki unda aniq `javob` so'zi bo'lishi kerak (`Javob: A`, `#Javob: B`);
  2. Yoki undan oldingi variant qatorlari `A)`, `B)`, `C)` kabi harf/raqam prefikslari bilan yozilgan bo'lishi va hech birida `#` belgisi qatnashmagan bo'lishi shart!
  ```javascript
  const optionsHavePrefixes = parts
    .slice(firstOptIdx, parts.length - 1)
    .every(line => /^(?:[a-zA-Z][\)\.]|\d+[\)\.])\s*/.test(line) && !/^[#*]/.test(line));

  const trailingAnswerMatch =
    lastLine.match(/^[#*]?\s*(?:to'?g'?ri\s+javob|javob)\s*[:=-]?\s*([a-jA-J1-9])$/i) ||
    (optionsHavePrefixes && lastLine.match(/^[#*]\s*([a-jA-J1-9])$/i));
  ```

---

### 🔴 Yangi Bug #2 (HIGH): UGC (Shaxsiy) testlarda `wm_menu_${subjectKey}` va `wm_start_inline_${subjectKey}` callback_data 64 baytdan oshib ketishi (`BUTTON_DATA_INVALID`) hamda `cbWmStartQuiz` da UGC kontekstining yo'qolishi
* **Manzil:** `src/handlers/coreQuiz.js` (77-qator) va `src/handlers/quizGame.js` (617–660-qatorlar)
* **Sababi:**
  1. Foydalanuvchi yaratgan fan nomi (`subjectKey`) 50 tagacha kirill harflaridan iborat bo'lishi mumkin (masalan: `"Бухгалтерия ҳисоби ва иқтисодий таҳлил асослари"` — UTF-8 da **88 bayt**!).
  2. Test tugaganda `buildFinishButtons` (`coreQuiz.js` 77-qator) `wm_menu_${subjectKey}` tugmasini yasaydi. Agar callback_data **64 baytdan oshsa**, Telegram API `400 Bad Request: BUTTON_DATA_INVALID` xatosini qaytaradi va **`finishTest` xabari foydalanuvchiga umuman bormaydi (test natijasi chiqmay qoladi)!**
  3. Xuddi shu muammo `cbWorkMistakesMenu` (`quizGame.js` 617–623-qatorlar) da `wm_start_inline_${subjectKey}` (16 bayt prefiks + fan nomi) va `wm_start_quiz_${subjectKey}` tugmalarida ham bor.
  4. Bundan tashqari, foydalanuvchi `"📊 Klassik Quiz"` (`cbWmStartQuiz`) ni bosganda, `subjectKey` sifatida kesilgan matn ketadi va `testData` ichiga `subject_id` (UGC konteksti) berilmagani uchun, xatolar ustida ishlash testi tugagach `"🔙 Fan menyusi"` tugmasi foydalanuvchini o'zining UGC faniga emas, `post_subj_...` (Rasmiy testlar) ga otib yuboradi!
* **Yechim:**
  * `mistakes_meta:${chatId}` Redis'da allaqachon saqlanadi! Shuning uchun `wm_menu_${subjectKey}` o'rniga `safeCallbackData(\`wm_menu_${subjectKey}\`, 64)` ishlatish va `cbWorkMistakesMenu`, `cbWmStartInline`, `cbWmStartQuiz` ichida haqiqiy `subjectKey`, `isUgc`, `subjectId` ma'lumotlarini `mistakes_meta:${chatId}` dan o'qib olish.

---

### 🔴 Yangi Bug #3 (HIGH): Guruh testida (`handlePollAnswer` vs `questionTimeout`) Mutex kalitlarining har xilligi (`group_poll:${chatId}` vs `poll:${chatId}`) va eski kesh qoldig'i
* **Manzil:** `src/handlers/coreQuiz.js` (472, 515–542 va 592-qatorlar) hamda `src/handlers/groupQuizLogic.js` (185-qator)
* **Sababi:**
  1. `handlePollAnswer` (472-qator) guruh javoblarini `mutex.lock(\`group_poll:${chatId}\`)` bilan qulflaydi va barcha qatnashchilar javob berganda `session.qIdx++` qilib, keyingi savolga o'tadi.
  2. `questionTimeout` (592-qator) esa `mutex.lock(\`poll:${chatId}\`)` (boshqa kalit!) bilan qulflaydi.
  3. Agar oxirgi ishtirokchi 31-soniyada ovoz bersa, `handlePollAnswer` va `questionTimeout` **bir vaqtning o'zida parallel** ishga tushadi, ikkalasi ham `session.qIdx++` qiladi va 1 ta savol o'tkazib yuborilib, ketma-ket 2 ta savol guruhga tashlanadi!
  4. Shuningdek, `handlePollAnswer` da barcha ovoz berib bo'lgach `await activePollsCache.delete(pollId)` va `await sessionService.deletePollChat(pollId)` chaqirilmagan.
  5. `cbRoomStart` (`groupQuizLogic.js`) yangi guruh o'yinini boshlashdan oldin `await groupTestCache.delete(chatId)` qilmaydi (agar avvalgi o'yin bot o'chib-yonishi tufayli chala qolgan bo'lsa, eski ballar qo'shilib ketadi).
* **Yechim:** `questionTimeout` va `handlePollAnswer` da yagona mutex kaliti (`poll:${chatId}`) ishlatish yoki guruh erta o'tish blokida `activePollsCache.delete(pollId)` qilish; `cbRoomStart` va `initAndStartTest` da `groupTestCache.delete(chatId)` chaqirish.

---

### 🟠 Yangi Bug #4 (REGRESSIYA — MEDIUM-HIGH): Javondan qayta boshlangan `mock_...`, `adaptive_...`, `retry_...` testlari yakunlanganda (`finishTest`) nom va tugmalarning buzilishi
* **Manzil:** `src/handlers/coreQuiz.js` (61–66 va 119–144-qatorlar)
* **Sababi:** `cbPauseShelf` va `finishTest` da Aralash (`mock`), Adaptiv (`adaptive`) va Qayta ishlash (`retry`) testlarini javonga saqlashda ID ustma-ust tushmasligi uchun `saveTestId = `${saveTestId}_${Date.now()}`` (masalan: `"mock_1762351234567"`) qilingan.
  Ammo foydalanuvchi ushbu testni Javondan ochib (`resumeTestFromShelf`), oxirigacha ishlaganda `finishTest` ichida `session.testId` aynan `"mock_1762351234567"` bo'ladi!
  * `resolveTestName(tId)` (62-qator): `String(tId) === "mock"` faqat aniq `"mock"` ni tekshirgani uchun test nomini **`"mock_1762351234567-Blok"`** deb chiqaradi!
  * `buildFinishButtons(tId)` (119-qator): `sid === "mock"` false bo'lgani uchun `else` shoxiga tushib, `post_start_${subjectKey}_mock_1762351234567` tugmasini chiqaradi va u bosilganda `"❌ Test topilmadi!"` xatosini beradi!
* **Yechim:**
  * `resolveTestName` da `sid.startsWith("mock")`, `sid.startsWith("adaptive")`, `sid.startsWith("retry")` deb tekshirish.
  * `buildFinishButtons` da ham `else if (sid.startsWith("mock"))` va `else if (sid.startsWith("adaptive"))` ishlatish.

---

### 🟠 Yangi Bug #5 (MEDIUM): `sanitizeQuizQuestions` da to'g'ri javob matni 100 belgidan uzun bo'lganda `correct_index` ning `0` ga tushib qolishi
* **Manzil:** `src/validators/testValidators.js` (67–85-qatorlar)
* **Sababi:**
  67-qatorda `targetCorrectText` qirqilmagan `rawOptions[targetIdx]` dan olinadi:
  ```javascript
  const targetCorrectText = String(rawOptions[targetIdx] ?? '').trim().toLowerCase();
  ```
  72-qatorda esa har bir variant 100 belgiga qisqartiriladi:
  ```javascript
  if (opt.length > 100) opt = opt.slice(0, 97) + '...';
  ```
  82-qatorda `options.findIndex((o) => o.toLowerCase() === targetCorrectText)` qidirilganda, qisqartirilgan variant (100 belgi) bilan asl `targetCorrectText` (masalan, 115 belgi) hech qachon teng bo'lmaydi va `resolvedCorrectIdx` doim `0` (A variant) bo'lib qoladi!
* **Yechim:** `targetCorrectText` ni ham solishtirishdan oldin 100 belgiga qisqartirish (`if (rawTarget.length > 100) rawTarget = rawTarget.slice(0, 97) + '...';`).

---

### 🟠 Yangi Bug #6 (MEDIUM): `testCreation.js` da `escapeMarkdown` (MarkdownV2) funksiyasining oddiy `Markdown` (v1) rejimida teskari chiziqlarni (`\`) ekranga chiqarib yuborishi va `userTextChunks` taymeri
* **Manzil:** `src/validators/testValidators.js` (31–34-qatorlar) va `src/handlers/testCreation.js` (151, 232, 995-qatorlar)
* **Sababi:**
  1. `testValidators.js` dagi `escapeMarkdown` funksiyasi `[_*[\]()~`>#+\-=|{}.!]` belgilarining barchasiga `\` qo'yadi. Bu `MarkdownV2` qoidasi. Ammo `testCreation.js` da `parse_mode: "Markdown"` (v1) ishlatilgan! Legacy `Markdown` da `-`, `(`, `)`, `.` belgilaridan oldin qo'yilgan `\` ekranda ko'rinib qoladi: masalan, `1-Blok` -> **`1\-Blok`**, `Tarix (1-qism)` -> **`Tarix \(1\-qism\)`** bo'lib chiqadi.
  2. Agar foydalanuvchi matn yuborib, 400ms ichida `"❌ Bekor qilish"` (`cbCancelCreation`) ni bossa, `userTextChunks` ichidagi taymer tozalanmagani uchun 400ms dan keyin savollarni baribir sessiyaga yozib yuboradi.
* **Yechim:** `escapeMarkdown` da faqat legacy Markdown belgilarini (`/[_*`\[\\]/g`) escape qilish va `cbCancelCreation` da `userTextChunks` taymerini tozalash.

---

### 🟡 Yangi Bug #7 (LOW-MEDIUM): `contactAdmin.js` da `handleAdminReplyState` ID manbasi va `scheduleWatcherService.js` da 20:30 eslatmasi
* **Manzil:** `src/handlers/contactAdmin.js` (397-qator) va `src/services/scheduleWatcherService.js` (1126-qator)
* **Sababi:**
  1. Admin foydalanuvchi profilidan `"↩️ Javob berish"` (`reply_${userId}`) ni bosganda `cbReplyStart` (`adminHandlers.js`) ID ni `ctx.session.data.target_id` ga yozadi (`ctx.session.replyTargetUserId` ga emas). Agar admin ushbu xabarga swipe-reply qilib javob yozsa, `contactAdmin.js` dagi `handleAdminReplyState` faqat `ctx.session?.replyTargetUserId` ni tekshiradi va `"❌ Xatolik: Manzil topilmadi"` deydi.
  2. `scheduleWatcherService.js` 1126-qatorda ertangi kun eslatmalari uchun `if (currentHHMM === '20:30')` qolib ketgan (`if (isTimeInWindow('20:30'))` bo'lishi kerak).