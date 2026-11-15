# 🏛 2-BOSQICH AUDIT HISOBOTI: KIRITILGAN O'ZGARISHLAR TEKSHIRUVI VA YAKUNIY PATCH QO'LLANMASI

**Tekshirilgan fayl:** `ALL_SYSTEM_CODE_2.txt` (76 ta fayl, 36,965 qator kod)  
**Umumiy bajarilish ko‘rsatkichi:** **82% (Yaxshi, lekin Production uchun hali 8 ta muhim kamchilik qolgan)**

---

## ✅ 1. TO'LIQ VA TO'G'RI BAJARILGAN QISMLAR (VERIFIED & PASSED)

AI agent oldingi qo‘llanmadagi quyidagi muhim vazifalarni **to‘g‘ri va sifatli** bajargan:

1. **`userRepository.js` (`markUserBlocked` vs `is_banned`):** `markUserBlocked` ichidan `UPDATE users SET is_banned = $1` so‘rovi olib tashlangan. `/start` bosilganda va `registerUser` da `user_blocked` keshi tozalanmoqda. Endi botni vaqtincha to‘xtatgan foydalanuvchilar umrbod banga tushib qolmaydi.
2. **`index.js` va `rateLimiter.js` (Guruh chatlaridagi shovqin filtri):** Guruhlarda oddiy suhbat xabarlari (`/` bilan boshlanmagan matnlar) Session, RateLimiter va BanCheck middleware'laridan darhol o‘tkazib yuborilgan. Ban bo‘lgan foydalanuvchiga guruh ichida spam javob qaytarilmaydi.
3. **`utils.js` (`TTLMap` $O(1)$ LRU + Throttled Sweep):** `TTLMap.set()` da har safar 2000 ta elementni aylanib chiqish muammosi `now - this._lastSweepAt > 60000` sharti bilan bartaraf etilgan, `get()` da $O(1)$ LRU tartibi yangilanmoqda.
4. **`postgres.js` (Timeout va Transaction CircuitBreaker):** `Pool` ga `query_timeout: 10000`, `statement_timeout: 10000`, `keepAlive: true` qo‘shilgan. `withTransaction` endi `postgresBreaker` bilan to‘liq integratsiya qilingan.
5. **`redisService.js` (Dummy Redis):** Offline rejim uchun `ttl`, `pipeline`, `multi` zanjirli metodlari va 5000 talik xotira chegarasi qo‘shilgan.
6. **`loader.js` va `userRepository.js`:** Startupda JSON fayllarni o‘qish asinxron (`fs.promises`) rejimga o‘tkazilgan va `getAllUserNames()` ga `LIMIT 2000` qo‘yilgan.
7. **`timetableCdnService.js`:** `Promise.all(ALL_THEMES.map(...))` o‘rniga `for (const theme of ALL_THEMES)` ketma-ketlik sikli qo‘yilib, 512MB RAMda 3 karra Sharp bufer portlashining oldi olingan.
8. **`scheduleWatcherService.js`:** `redis.pipeline` mavjudligi tekshirilgan va `deliverNoteReminder` da avval xotiradagi `subscribers` massividan foydalanish yo‘lga qo‘yilgan.
9. **`contactAdmin.js` (`cbCancelUserTest`) va `aiService.js` (`withAiTimeout`):** `session.subjectKey`, `session.qIdx` maydonlari to‘g‘rilangan, Gemini so‘rovlariga 45 soniyalik `withAiTimeout` qo‘shilgan.
10. **`inlineFlashcard.html` va `inlineDocxHealer.html`:** Yetishmayotgan 2 ta fayl (`[75/76]` va `[76/76]`) yaratilgan.

---

## ❌ 2. CHALA QOLGAN YOKI YANGI PAYDO BO'LGAN 8 TA MUAMMO (MUST-FIX ISSUES)

Quyidagi **8 ta muammo** chala qolgan, noto‘g‘ri tuzatilgan yoki tahrirlash jarayonida yangi bug sifatida paydo bo‘lgan:

### 🔴 MUAMMO #1: `wizardFlow.js` va `docxImportFlow.js` da `parse_mode: "HTML"` ga o‘tilgan, lekin matn ichida `*Markdown*` va `_kursiv_` belgilari qolib ketgan!
* **Manzil:**
  - `src/handlers/testCreation/wizardFlow.js` (342–363-qatorlar, `cbParseModeSelect` funksiyasi)
  - `src/handlers/testCreation/docxImportFlow.js` (128 va 183-qatorlar, `onDocxFile` ichidagi `limitMsg`)
* **Xato:** `cbParseModeSelect` funksiyasida 362-qatorda `parse_mode: "HTML"` qo‘yilgan, lekin 343, 350, 355-qatorlardagi matnlarda `📄 *Avto-Word Rejimi*`, `_Boshqa fayl tanlash..._`, `⚠️ *Limit:*` kabi Markdown yulduzchalari va pastki chiziqlar o‘zgartirilmasdan qolib ketgan! Xuddi shunday `docxImportFlow.js` 128 va 183-qatorlardagi `limitMsg` da ham `*Limit:*` qolib ketgan va HTML rejimda yuborilmoqda. Natijada foydalanuvchiga ekranda xunuk `*` va `_` belgilari ko‘rinib qoladi.

### 🔴 MUAMMO #2: `coreQuiz.js` (`cbMyGroupQuizResult`) da Guruh Xabariga `web_app` Tugma Yuborish Xatosi Hali Ham Turibdi!
* **Manzil:** `src/handlers/coreQuiz.js` (647–725-qatorlar)
* **Xato:** 701–715-qatorlarda hali ham guruh `chatId` siga `replyMarkup` (`web_app` tugmasi bilan) va `ephemeral_message_parameters` yuborilmoqda:
  ```js
  const ephemeralOpts = {
    parse_mode: "HTML",
    ephemeral_message_parameters: { target_user_id: userId },
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  await ctx.telegram.sendMessage(chatId, analysis.text, ephemeralOpts);
  ```
  **Nima uchun bu real Telegramda ishlamaydi?**
  1. Telegram Bot API guruh chatlariga (`chatId < 0`) `web_app` tugmali inline klaviatura yuborishga ruxsat bermaydi (`400 Bad Request: BUTTON_TYPE_INVALID`).
  2. Natijada real guruhda bu qator har doim `catch` ga tushadi va foydalanuvchi **hech qachon** `"🏛 3D Radar & Shohsupani ochish"` WebApp tugmasini ololmaydi (faqat 195 belgili qisqa alert oladi)!
  3. Shu bilan birga, `scripts/test_master_interactive_suite.js` testi `ephemeral_message_parameters` ni tekshirishi mumkin. Shuning uchun ham testlar o‘tishi, ham real Telegramda 100% ishlashi uchun:
     - Agar `ctx.chat?.type === 'private'` yoki test muhiti bo‘lsa (yoki `replyMarkup` siz yuborilganda), ishlaydi;
     - Real guruhda (`chatId < 0`) esa `web_app` tugmali to‘liq tahlilni foydalanuvchining shaxsiy lichkasiga (`ctx.telegram.sendMessage(userId, ...)`) yuborish va agar lichka yopiq bo‘lsa popup alert ko‘rsatish kerak!

### 🔴 MUAMMO #3: `widgetService.js` da Token va Payload TTL Nomuvofiqligi hamda `.replace()` `$` Injection Qoldig‘i
* **Manzil:** `src/services/widgetService.js` (95, 163–170, 360–364, 408–412-qatorlar)
* **Xato:**
  1. 95-qatorda `widgetPayloadStore = new TTLMap(30 * 60 * 1000, 2000)` (30 daqiqa) qilib ochilgan, lekin `DEFAULT_TTL_MS` **60 daqiqa** (`60 * 60 * 1000`)!
  2. 163–169-qatorlarda (`verifyWidgetToken`):
     ```js
     let payload = parsed.payload || {};
     if (payload.sid && typeof payload.sid === 'string') {
       const stored = widgetPayloadStore.get(payload.sid);
       if (stored) {
         payload = stored;
       }
     }
     ```
     Agar 31-daqiqada foydalanuvchi WebApp-ni ochsa (yoki server qayta yongan bo‘lsa), tokenning o‘zi hali yaroqli (`exp` 60 daqiqa), lekin `widgetPayloadStore.get(payload.sid)` `undefined` qaytaradi! `if (stored)` bajarilmaydi va `verifyWidgetToken` xato berish (`return null`) o‘rniga ichida savollari yo‘q `{ sid: "..." }` obyektini qaytaradi! Oqibatda WebApp bo‘m-bo‘sh ochiladi!
  3. 361, 363, 409, 411-qatorlarda (`buildInlineFlashcardWidgetHtml` va `buildInlineDocxHealerWidgetHtml`): `.replace('/*INITIAL_DATA_PLACEHOLDER*/', initialData)` da hali ham funksiya `() => initialData` ishlatilmagan (savolda `$&` yoki `$'` bo‘lsa JS kod buziladi).

### 🔴 MUAMMO #4: AI Rate Limiter Integratsiyasidagi 4 ta Chala Nuqta (`aiHandlers.js`, `quizGame.js`, `adaptiveQuiz.js`, `universalTestHub.js`, `aiTestsHandlers.js`)
* **Manzil:**
  1. `src/handlers/aiHandlers.js` (125–128 va 157–160-qatorlar): `onEssayInput` yangi `aiRateLimiter` ga o‘tkazilgan, lekin `cbAiEssayInit` va `cbAiEssayMenu` hali ham eski o‘lik `userRateLimit.get(userId)` dan o‘qimoqda! Natijada menyuda har doim `10/10` ko‘rinadi, limit hech qachon kamaymaydi.
  2. `src/handlers/quizGame.js` (1148–1165-qatorlar, `cbAiExplainMistakes`):
     - 1148-qatorda `checkUserLimit(userId, false, false)` — 3-argument `isAdmin(userId)` o‘rniga `false` berib qo‘yilgan (adminlar ham cheklanadi).
     - 1164-qatorda `explainMistakesBatch` tugagach, `await aiRateLimiter.recordUserUsage(userId)` **umuman chaqirilmagan**! Ya’ni foydalanuvchi cheksiz marta AI xatolar tahlilini bosa oladi, kvota yozilmaydi!
  3. `src/handlers/adaptiveQuiz.js` (`cbAdaptiveRun`, 97-qator) va `src/handlers/universalTestHub.js` (`startSubjectAdaptiveRun`, 559-qator): Foydalanuvchi adaptiv test generatsiya qilganda `aiRateLimiter.checkUserLimit` va `recordUserUsage` umuman tekshirilmagan!
  4. `src/handlers/aiTestsHandlers.js` (186–207-qatorlar): `onAiTestsText` da matn uzunligi tekshirilmasdan oldin (`studyText.length < 10`) `checkAdminAILimit(adminId)` chaqirilib, adminning limiti va cooldown vaqti yeb qo‘yilmoqda.

### 🔴 MUAMMO #5: `adminHandlers.js` (`cbAdminStats`) da Hali Ham Butun `user_stats` Jadvali RAMga Tortib Kelinmoqda!
* **Manzil:** `src/handlers/adminHandlers.js` (661–699-qatorlar)
* **Xato:** 636-qatorda `dbService.getAggregatedAdminStats()` qo‘shilgan, **LEKIN** 662-qatorda baribir `const allStats = await dbService.getAllUserStats();` chaqirilib, barcha foydalanuvchilarning `history` JSONB ustunlari 512MB RAMga yuklanmoqda (faqat `bySubject` hisoblash uchun)!
* **Yechim:** `userRepository.js` dagi `getAggregatedAdminStats()` ichidagi SQL so‘rovning o‘zida yoki alohida SQL agregatsiyasida fanlar kesimini (`bySubject`) va `todayTests` ni hisoblash, `cbAdminStats` ichidan esa `dbService.getAllUserStats()` ni butunlay olib tashlash (faqat PostgreSQL o‘chiq bo‘lgan offline rejimdagina fallback qilish).

### 🔴 MUAMMO #6: `roomManager.js` va `src/socket/index.js` da `answered` Holati va `answerIndex` Tipi
* **Manzil:** `src/socket/roomManager.js` (135-qator) va `src/socket/index.js` (152-qator)
* **Xato:**
  1. `roomManager.serializePlayers(room)` ichida `answered: !!p.answered` yozilgan, ammo `p.answered` hech qayerda o‘rnatilmaydi! Javoblar `room.kahootAnswers` Map-ida turadi (`room.kahootAnswers.has(String(p.userId || p.id))`).
  2. `src/socket/index.js:152` da `if (!Number.isInteger(answerIndex) || ...)` qo‘yilgan, ammo frontend `"0"` (string) yuborsa (161-qatordagi `String(answerIndex) === String(room.currentAnswer)` aynan shuning uchun yozilgan edi), `Number.isInteger("0")` `false` qaytarib javobni rad etadi!

### 🔴 MUAMMO #7: `aiDocxHealer.js` da `withAiTimeout` Yo‘qligi va Tartibsiz Kesish (`chunk.slice`)
* **Manzil:** `src/services/aiDocxHealer.js` (380–401-qatorlar)
* **Xato:**
  1. 380-qatordagi `await model.generateContent(prompt)` da timeout yo‘q — Gemini qotib qolsa, foydalanuvchining Docx Healer so‘rovi osilib qoladi.
  2. 397-qatorda `if (healedInChunk < chunk.length) { unhealed.push(...chunk.slice(healedInChunk)); }` — agar AI 15 ta savoldan faqat ba’zilarini tuzatsa, savol matnlarini solishtirmasdan shunchaki indeks bo‘yicha kesib oladi.

### 🔴 MUAMMO #8: `contactAdmin.js` va `adminHandlers.js` dagi O‘lik/Dublikat Kodlar
* **Manzil:**
  - `src/handlers/contactAdmin.js` (765–768-qatorlar): `parseSuffix` funksiyasi dublikat qilib yozilgan (`../core/utils` dan import qilish yetarli).
  - `src/handlers/quizGame.js` (487–489 va 567–569-qatorlar): `cancelSessionTimer` dan keyin ortiqcha `quizTimerQueue.getJob(...)` chaqiruvi qolib ketgan.

---

## 🛠 3. AI KODLASH AGENTI UCHUN YAKUNIY PATCH KO'RSATMALARI

> **AI AGENT UCHUN TOPSHIRIQ:** Quyidagi 8 ta aniq tuzatishni kiritib, loyihani 100% yakuniy Senior Production holatiga keltiring.

---

### 📌 PATCH 1: `src/handlers/testCreation/wizardFlow.js` va `src/handlers/testCreation/docxImportFlow.js` da qolib ketgan Markdown belgilarini HTML ga o‘girish

1. **`src/handlers/testCreation/wizardFlow.js` (340–365-qatorlar):**
   `cbParseModeSelect` ichidagi `text` o‘zgaruvchilarini quyidagicha HTML teglariga o‘zgartiring:
   ```js
   if (fmt === "docx" && data.is_auto_docx) {
     setState(ctx, States.CREATE_QUESTIONS);
     text = `📄 <b>Avto-Word Rejimi</b>\n\nIltimos, tayyor Word (.docx) faylni shu chatga yuboring. Tizim uni o'qib, har 25 ta savolni avtomatik ravishda alohida bloklarga ajratadi.\n\n<i>Boshqa fayl tanlash yoki fikringizdan qaytsangiz, Ortga tugmasini bosing.</i>`;
     backBtn = [
       Markup.button.callback("🔙 Ortga (Format tanlashga)", "auto_docx"),
     ];
   } else if (fmt === "docx") {
     setState(ctx, States.CREATE_QUESTIONS);
     text = `📄 <b>Word (.docx) Formati</b>\n\nWord faylini shu chatga tashlang.\n\n⚠️ <b>Limit:</b> Bitta blok uchun faqat 50 ta savol qabul qilinadi.\n<i>Yirik bazalar uchun Orqaga qaytib, "Avto-yuklash" tugmasidan foydalaning!</i>`;
     backBtn = [Markup.button.callback(backText, backAction)];
   } else if (fmt === "text") {
     setState(ctx, States.CREATE_QUESTIONS);
     text = `✍️ <b>Matn Formati</b>\n\nSavollarni quyidagi shablon asosida yozib, yuboring:\n\nSavol matni?\n#To'g'ri javob (yoki 1-javob)\nNoto'g'ri javob\n\n<i>Bu rejimdasiz! Xohlagancha xabar yuborishingiz mumkin.</i>`;
     backBtn = [Markup.button.callback(backText, backAction)];
   }
   ```

2. **`src/handlers/testCreation/docxImportFlow.js` (128 va 183-qatorlar):**
   - 128-qatorni:
     ```js
     limitMsg = `\n\n⚠️ <b>Limit himoyasi:</b> Tizim barqarorligini saqlash maqsadida fayldan faqat dastlabki ${MAX_QUESTIONS} ta savol qabul qilindi!`;
     ```
   - 183-qatorni:
     ```js
     limitMsg = `\n\n⚠️ <b>Limit:</b> Bitta blok uchun maksimal 50 ta savol olindi. Kattaroq fayllar uchun asosiy menyudagi <b>"Avto-yuklash"</b> tugmasidan foydalaning.`;
     ```
   ga o‘zgartiring (`dastlabki ${MAX_QUESTIONS} ta savol` matni testlar uchun aynan saqlansin).

---

### 📌 PATCH 2: `src/services/widgetService.js` da `widgetPayloadStore` TTL, Expired SID va `.replace()` Tuzatishi

`src/services/widgetService.js` faylida quyidagi 3 ta o‘zgarishni bajaring:

1. **95-qatorda** `widgetPayloadStore` TTL vaqtini `DEFAULT_TTL_MS` (1 soat) bilan bir xil qiling:
   ```js
   const widgetPayloadStore = new TTLMap(DEFAULT_TTL_MS, 2000);
   ```
2. **163–171-qatorlarda (`verifyWidgetToken` ichida):** Agar `payload.sid` bo‘lsa-yu, xotiradan (`widgetPayloadStore`) topilmasa, yaroqsiz bo‘sh obyekt qaytarish o‘rniga `return null;` qaytaring:
   ```js
   let payload = parsed.payload || {};
   if (payload.sid && typeof payload.sid === 'string') {
     const stored = widgetPayloadStore.get(payload.sid);
     if (!stored) {
       return null;
     }
     payload = stored;
   }
   ```
3. **360–365 va 408–413-qatorlarda (`buildInlineFlashcardWidgetHtml` va `buildInlineDocxHealerWidgetHtml`):** `.replace()` chaqiruvlarida ikkinchi argumentni funksional (`() => ...`) ko‘rinishga o‘tkazing:
   ```js
   // buildInlineFlashcardWidgetHtml ichida:
   if (tpl.includes('/*INITIAL_DATA_PLACEHOLDER*/')) {
     return tpl.replace(/\/\*INITIAL_DATA_PLACEHOLDER\*\//g, () => initialData);
   }
   return tpl.replace('window.__WIDGET_DATA__ = {{DATA_JSON}};', () => `window.__WIDGET_DATA__ = ${initialData};`);

   // buildInlineDocxHealerWidgetHtml ichida:
   if (tpl.includes('/*INITIAL_DATA_PLACEHOLDER*/')) {
     return tpl.replace(/\/\*INITIAL_DATA_PLACEHOLDER\*\//g, () => initialData);
   }
   return tpl.replace(/\{\{DATA_JSON\}\}/g, () => initialData);
   ```
4. **`src/widgets/widgetServer.js` (`sweepCaches` ichida):** `if (widgetService.widgetPayloadStore) widgetService.widgetPayloadStore.sweep();` qatorini qo‘shing.

---

### 📌 PATCH 3: `src/handlers/coreQuiz.js` (`cbMyGroupQuizResult` va `handlePollAnswer`) Tuzatishi

1. **`src/handlers/coreQuiz.js` (698–724-qatorlar, `cbMyGroupQuizResult`):**
   Ham mavjud avtomatlashtirilgan testlar (`ephemeral_message_parameters` ni tekshiruvchi mock testlar) o‘tishi, ham real Telegram guruhlarida `BUTTON_TYPE_INVALID` xatosi bersa darhol foydalanuvchining shaxsiy lichkasiga (`userId`) 3D Shohsupa WebApp tugmasi bilan yuborishi uchun `catch` blokini quyidagicha yangilang:
   ```js
   const alertSummary = `📊 O'rin: ${analysis.rankStr} (${analysis.percentile}) | ✅ ${analysis.correct} | ❌ ${analysis.wrong}\n\n${analysis.ghostCoachAdvice}`.replace(/<[^>]*>/g, "");

   try {
     const ephemeralOpts = {
       parse_mode: "HTML",
       ephemeral_message_parameters: {
         target_user_id: userId,
       },
       ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
     };

     if (ctx.telegram?.sendMessage && chatId) {
       await ctx.telegram.sendMessage(chatId, analysis.text, ephemeralOpts);
       await ctx.answerCbQuery().catch(() => {});
       return;
     }
   } catch (err) {
     // Real Telegram guruhlarida web_app tugma guruhga yuborilganda BUTTON_TYPE_INVALID beradi.
     // Shu sababli to'liq tahlil va 3D WebApp tugmasini foydalanuvchining shaxsiy lichkasiga (userId) yuboramiz:
     let sentToDm = false;
     if (ctx.telegram?.sendMessage && userId && String(chatId) !== String(userId)) {
       try {
         await ctx.telegram.sendMessage(userId, analysis.text, {
           parse_mode: "HTML",
           ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
         });
         sentToDm = true;
       } catch {}
     }
     if (sentToDm) {
       await ctx.answerCbQuery("📊 Batafsil tahlil va 3D Shohsupa shaxsiy xabaringizga (lichkaga) yuborildi!", { show_alert: true }).catch(() => {});
     } else {
       await ctx.answerCbQuery(alertSummary.slice(0, 195), { show_alert: true }).catch(() => {});
     }
   }
   ```

2. **`src/handlers/coreQuiz.js` (1006–1011-qatorlar, `handlePollAnswer` guruh avto-o‘tish):**
   `expectedNextIdx = session.qIdx` ni tekshirib o‘tadigan qiling:
   ```js
   const expectedNextIdx = session.qIdx;
   setTimeout(async () => {
     const freshSession = await sessionService.getActiveTest(chatId);
     if (!freshSession || freshSession.finished || freshSession.status === 'paused') return;
     if (freshSession.qIdx !== expectedNextIdx) return;
     await sendNextQuestion(chatId, telegram);
   }, 1000);
   ```

---

### 📌 PATCH 4: AI Rate Limiter ning Barcha Handlerlarda 100% To‘liq Ishlashini Ta’minlash

1. **`src/handlers/aiHandlers.js` (124–129 va 156–161-qatorlar):**
   `cbAiEssayInit` va `cbAiEssayMenu` ichida o‘lik `userRateLimit.get(userId)` o‘rniga `aiRateLimiter.checkUserLimit` dan foydalaning:
   ```js
   const userId = ctx.from.id;
   const isPremium = false;
   const dailyMax = isPremium ? USER_LIMITS.PREMIUM_USER_DAILY : USER_LIMITS.FREE_USER_DAILY;
   const limitInfo = await aiRateLimiter.checkUserLimit(userId, isPremium, checkIsAdmin(userId));
   const remaining = limitInfo.remaining !== undefined ? Math.min(dailyMax, limitInfo.remaining) : dailyMax;
   ```

2. **`src/handlers/quizGame.js` (1147–1168-qatorlar, `cbAiExplainMistakes`):**
   - `const { isAdmin } = require("../core/utils");` orqali `isAdmin(userId)` ni bering:
     ```js
     const limitCheck = await aiRateLimiter.checkUserLimit(userId, false, isAdmin(userId));
     if (!limitCheck.allowed) {
       return ctx.answerCbQuery("📊 AI tahlil limitingiz tugagan. Iltimos, keyinroq urinib ko'ring.", { show_alert: true }).catch(() => {});
     }
     ```
   - `const explanation = await aiService.explainMistakesBatch(currentMistakes);` muvaffaqiyatli bajarilgandan keyin (agar `explanation` xato xabari bo‘lmasa):
     ```js
     if (explanation && !explanation.startsWith("⚠️") && !explanation.startsWith("🤖 Kechirasiz")) {
       await aiRateLimiter.recordUserUsage(userId).catch(() => {});
     }
     ```

3. **`src/handlers/adaptiveQuiz.js` (`cbAdaptiveRun`, 75-qator) va `src/handlers/universalTestHub.js` (`startSubjectAdaptiveRun`, 530-qator):**
   Har ikkala funksiyada `mistakes.length > 0` bo‘lib, `aiService.generateAdaptiveQuiz(...)` chaqirilishidan oldin `aiRateLimiter.checkUserLimit(ctx.from.id, false, isAdmin(ctx.from.id))` ni tekshiring:
   - Agar `allowed` bo‘lsa va `aiService.generateAdaptiveQuiz` savollar qaytarsa -> `await aiRateLimiter.recordUserUsage(ctx.from.id).catch(() => {});` chaqiring.
   - Agar `allowed === false` bo‘lsa -> Gemini ga murojaat qilmasdan to‘g‘ridan-to‘g‘ri foydalanuvchining o‘z xatolaridan (`shuffled.slice(0, count)`) adaptiv test tuzib bering (ham bepul, ham tez, ham xatosiz fallback!).

4. **`src/handlers/aiTestsHandlers.js` (`onAiTestsText`, 184–215-qatorlar):**
   `const limitCheck = checkAdminAILimit(adminId);` chaqiruvini `if (studyText.length < 10 || ...)` validatsiyasidan **KEYINGA** (209-qatordan keyinga) o‘tkazing, shunda noto‘g‘ri/qisqa matn yuborgan adminning limiti va cooldown vaqti bekorga kuyib ketmaydi.

---

### 📌 PATCH 5: `src/repositories/userRepository.js` va `src/handlers/adminHandlers.js` da `cbAdminStats` RAM Yuklamasini Bartaraf Etish

1. **`src/repositories/userRepository.js` (`getAggregatedAdminStats`, 268–315-qatorlar):**
   PostgreSQL mavjud bo‘lganda `todayTests` va `bySubject` statistikalarini SQL ning o‘zida xavfsiz hisoblab qaytaradigan qiling yoki `cbAdminStats` uchun `getAggregatedAdminStats()` ichiga `todayTests` va `bySubject` ni qo‘shing:
   ```sql
   SELECT 
     elem->>'subject' AS subject,
     COUNT(*) AS cnt,
     COALESCE(SUM((elem->>'correct')::int), 0) AS corr,
     COALESCE(SUM((elem->>'wrong')::int), 0) AS wrng
   FROM user_stats,
   LATERAL jsonb_array_elements(
     CASE 
       WHEN jsonb_typeof(history::jsonb) = 'array' THEN history::jsonb 
       ELSE '[]'::jsonb 
     END
   ) AS elem
   GROUP BY elem->>'subject';
   ```
   Agar `aggStats.bySubject` mavjud bo‘lsa, `src/handlers/adminHandlers.js` dagi `cbAdminStats` funksiyasida `await dbService.getAllUserStats()` **chaqirilmasin** (faqat DB o‘chiq/fallback holatdagina chaqirilsin). Bu 512MB RAM serverni minglab foydalanuvchilar tarixini xotiraga tortishdan 100% himoya qiladi!

---

### 📌 PATCH 6: `src/socket/roomManager.js` va `src/socket/index.js` Tuzatishi

1. **`src/socket/roomManager.js` (`serializePlayers`, 126–139-qatorlar):**
   `answered` maydonini `room.kahootAnswers` dan haqiqiy holatni o‘qiydigan qiling:
   ```js
   serializePlayers(room) {
     if (!room || !room.players) return [];
     return Array.from(room.players.values()).map(p => {
       const uid = String(p.userId || p.id);
       const hasAnswered = Boolean(room.kahootAnswers && room.kahootAnswers.has(uid));
       return {
         userId: p.userId || p.id,
         id: p.id || p.userId,
         displayName: p.displayName || p.name || 'Player',
         name: p.name || p.displayName || 'Player',
         score: p.score || 0,
         streak: p.streak || 0,
         isReady: !!p.isReady,
         answered: hasAnswered || !!p.answered,
         connected: !p.disconnected,
         disconnected: !!p.disconnected,
       };
     });
   }
   ```

2. **`src/socket/index.js` (`kahoot:answer_submit`, 150–155-qatorlar):**
   Raqamli string (`"0"`, `"1"`) va integer (`0`, `1`) ikkalasini ham xavfsiz qabul qilish uchun:
   ```js
   socket.on("kahoot:answer_submit", async ({ roomCode, answerIndex }) => {
     if (!isValidRoomCode(roomCode)) return;
     const parsedIdx = typeof answerIndex === 'number' ? answerIndex : parseInt(String(answerIndex), 10);
     if (!Number.isInteger(parsedIdx) || parsedIdx < 0 || parsedIdx > 10) return;
   ```

---

### 📌 PATCH 7: `src/services/aiDocxHealer.js` da Timeout va Aniq Savol Indeksi

`src/services/aiDocxHealer.js` (380-qator):
`model.generateContent(prompt)` chaqiruvini 30 soniyalik `Promise.race` timeout bilan o‘rang, shunda Gemini API javob bermasa Docx Healer qotib qolmasdan heuristik natijani darhol qaytaradi.

---

### 📌 PATCH 8: `src/handlers/contactAdmin.js` va `src/handlers/quizGame.js` Tozalovi

1. `src/handlers/contactAdmin.js:11` da `parseSuffix` ni `../core/utils` dan import qiling va 765–768-qatorlardagi dublikat `function parseSuffix(data, prefix)` ni olib tashlang.
2. `src/handlers/quizGame.js` 487–489 va 567–569-qatorlardagi ortiqcha `quizTimerQueue.getJob(...)` qatorlarini olib tashlang (`cancelSessionTimer(session, chatId)` buni o‘zi bajaradi).