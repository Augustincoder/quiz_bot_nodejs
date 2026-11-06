# 🔍 `quiz_bot_nodejs` Loyihasining To'liq Kod Bazasi Bo'yicha Chuqur Audit Hisoboti

Ushbu hisobot loyihadagi barcha **47 ta fayl** (test yaratish, shaxsiy va guruhda test o'ynash, marafon, javon/pauza tizimi, xatolar ustida ishlash, AI test generatori hamda WebApp/Socket Kahoot rejimi) ustida o'tkazilgan chuqur statik va mantiqiy tahlil natijalarini o'z ichiga oladi.

Aniqlangan muammolar xavflilik darajasi (**Critical**, **High**, **Medium**, **Low**) bo'yicha guruhlangan bo'lib, har biri uchun **fayl manzili, qator raqamlari, muammo sababi va aniq kod yechimi** keltirilgan.

---

## 🚨 1. CRITICAL (Kritik — Ma'lumot yo'qolishi yoki Tizim ishdan chiqishiga olib keluvchi xatolar)

### BUG-01: Admin foydalanuvchilar ro'yxatini ko'rganda talabalarning "Javon" (`shelf`) ma'lumotlari o'chib ketishi (Data Loss & Cache Poisoning)
* **Fayl:** `src/services/dbService.js` (70–96, 125–146, 723–810-qatorlar)
* **Muammo tavsifi:**
  1. `getUsersStatsSummaryByIds()` funksiyasi (Admin panelda foydalanuvchilar ro'yxatini ochganda chaqiriladi) bazadan tezkorlik uchun `shelf` ustunini tashlab ketib, faqat `user_id, tests_completed, total_correct, total_wrong, history` ustunlarini oladi.
  2. Ammo 143-qatorda ushbu `shelf` maydoni yo'q bo'lgan obyektni asosiy `cache:user_stats:${row.user_id}` Redis keshiga 300 soniyaga yozib qo'yadi.
  3. Shu 5 daqiqa ichida foydalanuvchi o'zining **"Javon"** bo'limiga kirsa (`getUserShelf` -> `getUserStats`), keshdan `shelf: undefined` qaytadi va javon bo'sh ko'rinadi.
  4. **Eng xavflisi:** Agar foydalanuvchi shu vaqt ichida yangi testni javonga saqlasa (`saveTestToShelf`), funksiya keshdagi `shelf` yo'q obyektni olib (`let shelf = stats.shelf || {}`), eski barcha papka va testlarni bo'sh obyekt bilan ustidan yozib (`supabase.from('user_stats').update({ shelf })`), foydalanuvchining avvalgi barcha saqlagan testlarini **butunlay o'chirib yuboradi**.
* **Tuzatish bo'yicha ko'rsatma:**
  `getUsersStatsSummaryByIds` funksiyasida to'liq bo'lmagan ma'lumotni `cache:user_stats:${uid}` kalitiga yozmaslik yoki alohida `cache:user_stats_summary:${uid}` kalitidan foydalanish shart:
  ```javascript
  // src/services/dbService.js (108 va 143-qatorlar)
  // 1. O'qishda:
  const cached = await redis.get(`cache:user_stats:${uid}`) || await redis.get(`cache:user_stats_summary:${uid}`);
  
  // 2. Yozishda (143-qator):
  if (redis) {
    redis.set(`cache:user_stats_summary:${row.user_id}`, JSON.stringify(row), 'EX', 300).catch(() => {});
  }
  ```
  Shuningdek, `saveTestToShelf` funksiyasida keshdan emas, to'g'ridan-to'g'ri Supabase'dan `shelf` ustunini o'qib yangilash tavsiya etiladi.

---

### BUG-02: Shaxsiy chatdagi aktiv Wizard holati (`ctx.session.state`) Guruh chatlaridagi oddiy yozishmalarni ushlab qolishi (State Bleed Across Chats)
* **Fayl:** `index.js` (108-qator va 317–379-qatorlar)
* **Muammo tavsifi:**
  1. `index.js` 108-qatorda sessiya kaliti `const userId = ctx.from?.id || ctx.chat?.id; const key = 'tg_session:' + userId;` ko'rinishida foydalanuvchi ID siga bog'langan.
  2. 317-qatordagi `bot.on("message", ...)` global state routerida `ctx.chat.type === "private"` tekshiruvi yo'q!
  3. Natijada: Agar foydalanuvchi botning shaxsiy chatida *"Test yaratish"*, *"Guruhni sozlash"*, *"AI Insho tahlili"* yoki *"Adminga murojaat"* bo'limiga kirib, uni tugatmasdan bot qatnashgan **guruhda** oddiy xabar yozsa, bot guruhdagi xabarni ushlab olib:
     - Guruh ichida *"❌ Kamida 2 ta belgi bo'lishi kerak"* yoki *"❌ Formatingiz xato! To'g'ri javob oldiga # qo'ying"* deb javob qaytaradi;
     - Yoki `States.USER_CONTACT` holatida bo'lsa, guruhga yozilgan xabarni adminga "Yangi murojaat" sifatida yuborib yuboradi!
* **Tuzatish bo'yicha ko'rsatma:**
  `index.js` 317-qatordagi `bot.on("message", ...)` boshiga guruh chatlarini o'tkazib yuboruvchi himoya qo'shing:
  ```javascript
  // index.js (317-qator)
  bot.on("message", async (ctx, next) => {
    // Wizard va state'lar faqat shaxsiy (private) chatda ishlashi shart
    if (ctx.chat?.type !== "private") return next();
  ```

---

### BUG-03: Javonda (`shelfHandlers.js`) uzun nomli yoki `_` belgili papkalarda testni o'chirish (`splice(NaN, 1)`) noto'g'ri testni o'chirib yuborishi
* **Fayl:** `src/handlers/shelfHandlers.js` (36, 221, 244, 305, 334, 351, 391-qatorlar)
* **Muammo tavsifi:**
  1. `cbShelfSaveInit` (36-qator) da fan nomi (`data.subject`, 50 tagacha belgi / Kirill alifbosida 100 baytgacha) papka nomi sifatida taklif qilinadi: `safeCallbackData('sh_save_' + data.subject, 64)`.
  2. `cbViewTest` (334-qator) da testni o'chirish tugmasi `safeCallbackData('sh_del_test_' + folderName + '_' + idx, 64)` ko'rinishida yasaladi.
  3. Agar `folderName` uzun bo'lsa (masalan, 25 ta kirill harfi = 50 bayt), `"sh_del_test_"` (12 bayt) + `folderName` (50 bayt) + `"_3"` (2 bayt) = **64 baytdan oshadi** va `safeCallbackData` oxiridagi `_${idx}` qismini kesib tashlaydi!
  4. Foydalanuvchi o'chirishni bosganda `cbDeleteTest` (351-qator) ishlaydi:
     ```javascript
     const suffix = ctx.callbackQuery.data.replace("sh_del_test_", "");
     const parts = suffix.split("_");
     const idx = parseInt(parts.pop(), 10);
     const folderName = parts.join("_");
     ```
     Kesilgan callback datada `_${idx}` yo'qligi (yoki papka nomida `_` bo'lmagani) sababli `parts.pop()` papka nomining o'zini oladi, `idx` esa `NaN` bo'ladi, `folderName` esa `""` bo'lib qoladi (yoki `_` qatnashgan papkada qolgan qismi bo'ladi).
     Agar papka nomida `_` bo'lsa va oxirgi qism harf bo'lsa, `shelf[folderName].splice(NaN, 1)` JavaScriptda `NaN` ni `0` ga aylantirib, **0-indeksdagi (birinchi) testni o'chirib yuboradi**!
* **Tuzatish bo'yicha ko'rsatma:**
  Javon callbacklarida papka nomini (`folderName`) string sifatida emas, `Object.keys(shelf)` dagi **papka indeksi (`fIdx`)** orqali uzating:
  - `sh_open_${fIdx}`
  - `sh_view_${fIdx}_${tIdx}`
  - `sh_run_${fIdx}_${tIdx}`
  - `sh_del_test_${fIdx}_${tIdx}`
  - `sh_del_folder_${fIdx}`
  Bu callback uzunligini doim 15–20 bayt atrofida ushlab turadi va `_` hamda UTF-8 bayt kesilishi muammolarini 100% yo'qotadi.

---

### BUG-04: Ko'p qismli uzun matn (>4096 belgi) yuborilganda savolning o'rtasidan ikkiga bo'linib ketishi va `ctx.session` poygasi
* **Fayl:** `src/handlers/testCreation.js` (817–838-qatorlar)
* **Muammo tavsifi:**
  1. Foydalanuvchi 4096 belgidan uzun test matnini yuborganda, Telegram uni avtomatik 2 yoki 3 ta xabarga bo'lib yuboradi (ko'pincha bitta savol yoki variantning qoq o'rtasidan kesadi).
  2. 825-qatorda:
     ```javascript
     chunkState.text += (chunkState.text ? '\n\n' : '') + ctx.message.text;
     ```
     Bo'laklar orasiga majburiy `'\n\n'` (bo'sh qator) qo'shib birlashtirilmoqda!
  3. `parseTextQuestions` esa savollarni aynan `\n\s*\n` (bo'sh qator) bo'yicha ajratadi (`utils.js` 314-qator). Natijada Telegram 4096-belgida kesgan savol o'rtasiga `\n\n` tushib qoladi va bitta savol ikkita chala blokka bo'linib, `invalidQs` (xato savollar) ga tushib qoladi.
* **Tuzatish bo'yicha ko'rsatma:**
  825-qatorda xabar bo'laklarini `\n\n` bilan emas, agar birinchi bo'lakning uzunligi `>= 4000` bo'lsa (Telegram tomonidan avtomatik kesilgan bo'lsa) oddiy `''` yoki `'\n'` bilan ulash kerak:
  ```javascript
  const sep = chunkState.text
    ? (chunkState.lastMsgLen >= 4000 ? '' : '\n\n')
    : '';
  chunkState.text += sep + ctx.message.text;
  chunkState.lastMsgLen = ctx.message.text.length;
  ```

---

## 🟠 2. HIGH (Yuqori — Test o'ynash va yaratish mantiqini buzuvchi xatolar)

### BUG-05: Bir xil variantli savollarda (`POLL_OPTIONS_MUST_BE_UNIQUE`) testning o'z-o'zidan pauzaga tushib qolishi yoki savol o'tkazib yuborilishi
* **Fayl:** `src/handlers/coreQuiz.js` (225–365-qatorlar) va `src/core/utils.js` (`parseTextQuestions`, 365–405-qatorlar)
* **Muammo tavsifi:**
  1. `parseTextQuestions` orqali matn yoki Word fayldan test o'qilganda, bir savol ichida ikkita bir xil variant (masalan, imloviy xato tufayli ikkita `A) 15` va `C) 15`, yoki 100 belgidan uzun ikkita variant `.slice(0, 100)` qilinganda bir xil bo'lib qolishi) tekshirilmaydi.
  2. `sendNextQuestion` da `telegram.sendPoll` chaqirilganda Telegram API `400 Bad Request: poll options must be unique` xatosini qaytaradi.
  3. `sendNextQuestion` dagi `while (sendAttempts < maxSendAttempts)` sikli ichidagi `catch` bloki bu xatoni ushlab, **1-urinishdayoq** savolni xato (`session.wrong++`) deb belgilab keyingi savolga o'tib ketadi, va agar test davomida 3 ta shunday savol uchrasa (`session.sendErrors >= 3`), testni majburiy pauzaga tushiradi.
* **Tuzatish bo'yicha ko'rsatma:**
  1. `parseTextQuestions` (`src/core/utils.js`) va `sendNextQuestion` (`src/handlers/coreQuiz.js` 255-qator) da `pollOpts` tayyorlanayotganda bir xil variantlar bo'lsa, ularning oxiriga farqlovchi indeks yoki bo'sh belgi (masalan, ` (2)`) qo'shib unikal qilish lozim:
     ```javascript
     const seenOpts = new Set();
     pollOpts = pollOpts.map((opt, idx) => {
       let candidate = opt;
       if (seenOpts.has(candidate.toLowerCase())) {
         const suffix = ` (${idx + 1})`;
         candidate = candidate.slice(0, 100 - suffix.length) + suffix;
       }
       seenOpts.add(candidate.toLowerCase());
       return candidate;
     });
     ```

---

### BUG-06: Guruh testlarida qatnashchilar javob berganda savolni erta yakunlash (Auto-Advance) majburiy ekanligi va Kutish zalida ixtiyoriy (optional) tanlanmasligi
* **Fayllar:**
  * `src/handlers/groupQuizLogic.js` (10–49, 109–129, 169–280-qatorlar)
  * `src/handlers/quizGame.js` (38–68, 209–223, 276–290, 396–410, 1495–1538-qatorlar)
  * `src/handlers/coreQuiz.js` (370–377, 702–742-qatorlar)
* **Muammo va Talab tavsifi:**
  1. **Majburiy erta yopilish muammosi:** Hozirgi kodda (`coreQuiz.js` 702–742-qatorlar) guruhda ovoz berganlar soni `expectedParticipantsCount` ga yetishi bilan poll darhol to'xtatilib (`stopPoll`), keyingi savolga o'tib ketadi. Bu rejim doim majburiy yoqilgan.
  2. **Chetdan ovoz berish xatosi:** Kutish zalida 2 kishi *"✋ Qatnashish"* ni bosgan bo'lsa (`expectedParticipantsCount = 2`), lekin guruhdagi ro'yxatdan o'tmagan boshqa 2 kishi ovoz bersa ham `voterCount >= 2` bajarilib, savol muddatidan oldin yopiladi va ro'yxatdan o'tgan qatnashchilar javob berishga ulgurmay qoladi.
  3. **Chiqib ketgan o'yinchi muammosi:** Agar ro'yxatdan o'tgan 5 kishidan 1 nafari o'yin o'rtasida javob bermay qo'ysa, qolgan 4 kishi javob bersa ham har savolda 30 soniya kutishga majbur bo'ladi.
  4. **Yangi Funktsional Talab:** Guruhda test boshlanishidan oldin (**Kutish zalida / Lobby ekranida**) qatnashchilar belgilaganda savolni darhol yakunlab keyingisiga o'tish (`autoAdvance`) **ixtiyoriy (optional toggle)** bo'lishi shart! Test muallifi yoki guruh admini o'yinni boshlashdan oldin:
     * **⚡ Avto-o'tish: YOQILGAN** (Ro'yxatdan o'tgan qatnashchilar javob berishi bilan keyingi savolga o'tadi);
     * **⏱ Avto-o'tish: O'CHIQ (30s)** (Qatnashchilar javob bersa ham savol yopilmaydi, 30 soniya to'liq kutadi — guruhdagi barcha a'zolar bemalol qatnashishi uchun) rejimlaridan birini tanlay olishi kerak.

* **Tuzatish bo'yicha aniq ko'rsatma:**

  **1-qadam: Kutish zaliga (`groupQuizLogic.js` va `quizGame.js`) `autoAdvance` sozlamasi va tugmasini qo'shish**
  `createLobby` (`groupQuizLogic.js` 109-qator) hamda `quizGame.js` dagi `setWaitingRoom` chaqiruvlarida `room` obyektiga `autoAdvance: true` (default) xususiyatini qo'shing va `renderLobby` (`groupQuizLogic.js` 10-qator) hamda `sendWaitingRoomMessage` (`quizGame.js` 38-qator) da tugmani chiqaring:
  ```javascript
  // src/handlers/groupQuizLogic.js — renderLobby ichida:
  const isAuto = room.autoAdvance !== false; // default: true (yoki false)
  const autoModeText = isAuto
    ? '⚡ <b>Savol almashishi:</b> Hamma qatnashchilar javob berganda (Avto)'
    : '⏱ <b>Savol almashishi:</b> Faqat vaqt tugaganda (30 soniya)';

  const text = `🎯 <b>MUSOBAQA KUTISH ZALI</b>\n\n` +
               `${modeText}\n` +
               `📚 <b>Fan:</b> ${escapeHtml(room.testData.subject || '')} ${room.mode === 'block' ? '| 🔖 ' + escapeHtml(room.testData.block_name || '') : ''}\n` +
               `${autoModeText}\n\n` +
               `👥 <b>Qatnashchilar (${users.length}):</b>\n${usersList}\n\n` +
               `<i>⚠️ Sozlamani o'zgartirish va testni boshlash faqat muallif (${escapeHtml(room.initiatorName || 'Muallif')}) yoki guruh adminiga ruxsat etilgan.</i>`;

  const buttons = [
    [Markup.button.callback('✋ Qatnashish', 'room_ready')],
    [
      Markup.button.callback(
        isAuto ? '⚡ Avto-o\'tish: YOQILGAN ✅' : '⏱ Avto-o\'tish: O\'CHIQ (30s) ❌',
        'room_toggle_auto'
      )
    ],
    [
      Markup.button.callback('▶️ Boshlash', 'room_start'),
      Markup.button.callback('❌ Bekor qilish', 'room_cancel')
    ]
  ];
  ```

  **2-qadam: `cbRoomToggleAuto` handlerini qo'shish (`groupQuizLogic.js` va `quizGame.js`)**
  ```javascript
  // src/handlers/groupQuizLogic.js
  async function cbRoomToggleAuto(ctx) {
    const chatId = ctx.chat.id;
    const unlock = await mutex.lock(`room_ready:${chatId}`);
    try {
      const room = await sessionService.getWaitingRoom(chatId);
      if (!room) {
        return ctx.answerCbQuery('Kutish zali yopilgan!', { show_alert: true }).catch(() => {});
      }

      const canManage = await canManageLobbyOrGame(ctx, chatId, ctx.from.id, room.initiatorId);
      if (!canManage) {
        return ctx.answerCbQuery('⚠️ Faqat test muallifi yoki guruh admini bu sozlamani o\'zgartira oladi!', { show_alert: true }).catch(() => {});
      }

      room.autoAdvance = room.autoAdvance === false ? true : false;
      await sessionService.setWaitingRoom(chatId, room);

      await renderLobby(ctx, chatId, room, ctx.callbackQuery.message.message_id);
      const statusMsg = room.autoAdvance
        ? '⚡ Yoqildi: Barcha qatnashchilar javob berganda keyingi savolga o\'tiladi!'
        : '⏱ O\'chirildi: Har bir savol to\'liq 30 soniya davom etadi!';
      await ctx.answerCbQuery(statusMsg, { show_alert: false }).catch(() => {});
    } catch (e) {
      console.error('cbRoomToggleAuto error:', e.message);
    } finally {
      unlock();
    }
  }
  ```
  Va `src/handlers/quizGame.js` dagi `register(bot)` ichiga `bot.action("room_toggle_auto", cbRoomToggleAuto);` ni ro'yxatdan o'tkazing.

  **3-qadam: `cbRoomStart` da `autoAdvance` va `readyUserIds` ni sessiyaga uzatish (`groupQuizLogic.js` 199-qator)**
  ```javascript
  // src/handlers/groupQuizLogic.js — cbRoomStart ichida setActiveTest:
  const readyUserIds = Object.keys(room.readyUsers || {}).map(String);
  await sessionService.setActiveTest(chatId, {
    ...
    expectedParticipantsCount: readyUserIds.length,
    readyUserIds,
    autoAdvance: room.autoAdvance !== false,
    ...
  });
  ```

  **4-qadam: `coreQuiz.js` da `autoAdvance` va `readyUserIds` asosida erta o'tishni boshqarish**
  ```javascript
  // 1. sendNextQuestion ichida (src/handlers/coreQuiz.js 371-qator):
  if (session.chatType !== "private") {
    await activePollsCache.set(msg.poll.id, {
      chatId: chatId,
      correct_index: q.correct_index,
      qData: q,
      expectedParticipantsCount: session.expectedParticipantsCount || 0,
      readyUserIds: session.readyUserIds || [],
      autoAdvance: session.autoAdvance !== false,
    });
  }

  // 2. handlePollAnswer ichida (src/handlers/coreQuiz.js 702-qator):
  // Agar Kutish zalida "Avto-o'tish" O'CHIRILGAN bo'lsa, 30 soniyalik taymer o'zi yakunlaydi:
  if (!cachedPoll.autoAdvance) {
    return;
  }

  // Agar "Avto-o'tish" YOQILGAN bo'lsa, ro'yxatdan o'tgan qatnashchilarni sanaymiz:
  const readySet = Array.isArray(cachedPoll.readyUserIds) && cachedPoll.readyUserIds.length > 0
    ? new Set(cachedPoll.readyUserIds.map(String))
    : null;

  let readyVoterCount = 0;
  if (readySet) {
    if (readySet.has(String(uId))) {
      await redisConnection.sadd(`poll_ready_voters:${pollId}`, String(uId)).catch(() => {});
      redisConnection.expire(`poll_ready_voters:${pollId}`, 600).catch(() => {});
    }
    readyVoterCount = typeof redisConnection.scard === 'function'
      ? await redisConnection.scard(`poll_ready_voters:${pollId}`).catch(() => 0)
      : 0;
  } else {
    readyVoterCount = typeof redisConnection.scard === 'function'
      ? await redisConnection.scard(`poll_voters:${pollId}`).catch(() => 0)
      : 0;
  }

  const expCount = readySet ? readySet.size : (cachedPoll.expectedParticipantsCount || 0);
  if (expCount < 2 || readyVoterCount < expCount) {
    return;
  }
  ```

---

### BUG-07: Guruh Marafonida bloklar orasida guruhning "osilib" qolishi va yakuniy pollning yopilmasligi
* **Fayl:** `src/handlers/coreQuiz.js` (567–605-qatorlar) va `src/handlers/groupQuizLogic.js` (55–59, 255–281-qatorlar)
* **Muammo tavsifi:**
  1. Guruh marafonida 1-blok tugaganda (`coreQuiz.js` 572-qator), `session.questionState = "PREPARING"` qilinadi, lekin `session.status` `"running"` holatida qoladi va `"▶️ Keyingi blokni boshlash"` tugmasi chiqadi. Agar muallif tugmani bosishni unutsa yoki ketib qolsa, hech qanday taymer yo'q — guruhda yangi test boshlab bo'lmaydi (24 soat bloklanib qoladi).
  2. `createLobby` (`groupQuizLogic.js` 56-qator) faqat `activeSession.status === 'running'` ni tekshiradi, lekin `cbRoomNextBlock` (266-qator) da `session.qIdx` 0 ga tushirilgani uchun 1-savolga hech kim javob bermay turgan paytda (`qIdx === 0`), `if (session.questionState === "ACTIVE" || session.qIdx > 0)` sharti `session.questionState` `"ACTIVE"` bo'lishidan oldin (masalan, 3 soniyalik sanoq paytida) qayta bosilsa, 2-blok ikki marta parallel boshlanib ketadi!
  3. Guruhda `/stop` bosilganda (`cmdStop` -> `finishTest`), joriy ochiq turgan poll (`telegram.stopPoll(chatId, session.msgId)`) yopilmay qoladi.
* **Tuzatish bo'yicha ko'rsatma:**
  1. `finishTest` ichida (437-qatordan keyin) agar `session.msgId` mavjud bo'lsa, `await telegram.stopPoll(chatId, session.msgId).catch(() => {});` chaqiring.
  2. `cbRoomNextBlock` da tugma bosilishi bilan `session.questionState = "STARTING"` qilib saqlang va `if (session.questionState !== "PREPARING")` bo'lsa rad eting.
  3. Marafon bloklari orasida 5 daqiqalik kutish taymeri qo'shing (5 daqiqa ichida keyingi blok boshlanmasa, marafon yakuniy natijasini chiqarib sessiyani yoping).

---

### BUG-08: Mavjud testni tahrirlash (`cbEditTest`) jarayonidagi 4 ta bog'liq mantiqiy xato
* **Fayl:** `src/handlers/testCreation.js` (31–88, 627, 903–985, 1051, 1126-qatorlar)
* **Muammo tavsifi:**
  1. **"Saqlamasdan chiqish" sessiyani tozalamaydi:** `showEditDashboard` (48-qator) dagi `"🔙 Saqlamasdan chiqish"` tugmasi `manage_test_${data.editing_test_id}` ga yo'naltiradi. Lekin `cbManageTest` (1051-qator) `clearState(ctx)` ni chaqirmaydi! Natijada foydalanuvchi tahrirlashdan chiqsa ham, `ctx.session.state` `States.CREATE_QUESTIONS` va `is_editing: true` holatida qolib ketadi.
  2. **Tahrirlash paytida Word fayl yuklansa `showDraftDashboard` ga o'tib ketadi:** `onDocxFile` (627-qator) va `cbFixErrors` (1126-qator) da `data.is_editing` tekshirilmasdan to'g'ridan-to'g'ri `showDraftDashboard(ctx)` chaqirilgan.
  3. **`subject_id` yo'qolishi:** `cbEditTest` (58-qator) da `subject_id: testData.subject_id` sessiyaga saqlanmaydi. Natijada tahrirlash yakunida (`cbFinishCreation` 972-qator) `shareSubjectId` sifatida `subject_id` emas, `test_id` olinib, marafon ulashish havolasi (`s_...`) noto'g'ri generatsiya qilinadi.
  4. **Bo'sh testda `preview_q_0` xatosi:** `showEditDashboard` (38-qator) `"👁/🗑 Savollarni ko'rish va o'chirish"` tugmasini `preview_grid_0` o'rniga `preview_q_0` ga bog'lagan.
* **Tuzatish bo'yicha ko'rsatma:**
  - `cbManageTest` boshiga `clearState(ctx);` qo'shing.
  - `cbEditTest` ichida `updateData(ctx, { ..., subject_id: testData.subject_id })` ni qo'shing.
  - `showEditDashboard` dagi `preview_q_0` ni `preview_grid_0` ga o'zgartiring.
  - `onDocxFile` (627-qator) va `cbFixErrors` (1126-qator) da `return data.is_editing ? showEditDashboard(ctx) : showDraftDashboard(ctx);` qilib o'zgartiring.

---

### BUG-09: Javonga saqlashda (`saveTestToShelf`) UGC testlarning `subjectId`, `creatorId` va `isUgc` atributlari tushib qolishi
* **Fayl:** `src/services/dbService.js` (771–795-qatorlar), `src/handlers/coreQuiz.js` (513-qator), `src/handlers/startHandler.js` (66-qator)
* **Muammo tavsifi:**
  1. Foydalanuvchi shaxsiy (UGC) testni yechayotib pauza qilib javonga saqlaganda (`cbPauseShelf`), `shelfData` ichida `subjectId` va `creatorId` beriladi, biroq `dbService.saveTestToShelf` funksiyasi bazaga yozishda faqat `{ testId, testName, subject, questions, saved_at, progress }` maydonlarini olib qolib, `subjectId`, `creatorId`, `isUgc` maydonlarini tashlab yuboradi!
  2. Shuningdek, `finishTest` (513-qator) va `cmdStart` (66-qator) da `shelfData` obyektiga `subjectId` va `creatorId` umuman qo'shilmagan.
  3. Natijada javondan davom ettirilgan test yakunlanganda *"📚 Fan bloklari"* va *"➡️ Keyingi blok"* tugmalari chiqmaydi, aksincha rasmiy testlar menyusiga (`post_subj_...`) yuborib yuboradi.
* **Tuzatish bo'yicha ko'rsatma:**
  `dbService.saveTestToShelf` (`src/services/dbService.js` 771–795-qatorlar) da `subjectId: testInfo.subjectId || null`, `creatorId: testInfo.creatorId || null`, `isUgc: Boolean(testInfo.isUgc)` maydonlarini ham saqlang hamda `finishTest` va `cmdStart` dagi `shelfData` ga ushbu maydonlarni qo'shing.

---

### BUG-10: Testni "Pauza -> Javonga saqlash" bosqichidan bekor qilganda (`back_to_main`) yoki "Testga tayyormisiz?" ekranidan chiqilganda sessiya bloklanib qolishi
* **Fayl:** `src/handlers/quizGame.js` (95–127, 473–529-qatorlar) va `src/handlers/shelfHandlers.js` (40-qator)
* **Muammo tavsifi:**
  1. Foydalanuvchi testni boshlash uchun blok ustiga bosganda (`initAndStartTest`), bot `"🚀 Testga tayyormisiz? [▶️ Boshlash]"` xabarini chiqaradi va Redisda `activeTest:${chatId}` ni `status: "preparing"` holatida yaratadi. Bu ekranda **"❌ Bekor qilish"** tugmasi yo'q! Agar foydalanuvchi fikridan qaytib boshqa testni bosmoqchi bo'lsa, bot *"⚠️ Sizda tugallanmagan test bor"* deb ruxsat bermaydi. Agar `/start` bossa, hali 1 ta ham savol ishlanmagan (`qIdx === 0`) testni Javonga "Tugallanmagan test" deb saqlab qo'yadi!
  2. Foydalanuvchi test paytida `/stop` -> `"📥 Javonga saqlash"` -> `"📥 Tasdiqlash va Javonga saqlash"` (`shelf_save_init`) tugmasini bossa va papka tanlash ekranida `"❌ Bekor qilish"` (`back_to_main`) ni bossa, `activeTest:${chatId}` Redisda `paused` holatida qolib ketadi va yangi test boshlashni bloklaydi.
* **Tuzatish bo'yicha ko'rsatma:**
  1. `initAndStartTest` (`quizGame.js` 118-qator) dagi `"▶️ Boshlash"` tugmasi yoniga `[{ text: "❌ Bekor qilish", callback_data: "force_finish" }]` tugmasini qo'shing.
  2. `cmdStart` (`startHandler.js` 57-qator) da testni javonga avto-saqlash shartini `if (session.status !== 'preparing' && (session.qIdx > 0 || session.correct > 0 || session.wrong > 0) && ...)` qilib o'zgartiring (boshlanmagan test javonni to'ldirmasligi uchun).
  3. `cbStartTest`, `cbPostStart`, `startUgcTest`, `resumeTestFromShelf`, `cbAdaptiveRun` funksiyalarida agar `existing && existing.status === 'preparing'` bo'lsa, uni avtomatik bekor qilib yangi testni boshlashga ruxsat bering; agar `existing.status === 'paused'` bo'lsa, `"▶️ Davom etish"` va `"🛑 Faol testni to'xtatish"` tugmalarini chiqaring.

---

## 🟡 3. MEDIUM (O'rta — Xatolar tahlili, Savol parseri, Interaktiv rejim va WebApp/Socket xatoliklari)

### BUG-11: Savol parserida (`parseTextQuestions`) oxirgi qatordagi `#A` kaliti 5-variant sifatida qo'shilib qolishi va `A)Javob` (probelsiz) prefiksining tozalanmasligi
* **Fayl:** `src/core/utils.js` (335–385-qatorlar)
* **Muammo tavsifi:**
  1. `adminHandlers.js` (868 va 998-qatorlar) adminlarga to'g'ri javobni oxirgi qatorda `# A` ko'rinishida yozishni tavsiya qiladi.
  2. Lekin `parseTextQuestions` (345-qator) da `trailingHashMatch` faqat barcha variantlarda `A)`, `B)` prefiksi bo'lsagina (`optionsHavePrefixes === true`) ishlaydi. Agar foydalanuvchi variantlarni prefikssiz yozib, oxirida `# A` yoki `# 1` yozsa, parser `# A` ni **5-variant (`"A"`)** sifatida variantlar ro'yxatiga qo'shadi va uni to'g'ri javob qilib belgilaydi!
  3. 375-qatordagi `.replace(/^(?:[a-zA-Z][\)\.]|\d+\))\s+/, '')` regulyar ifodasida `\s+` majburiy bo'lgani uchun `A)Toshkent` yoki `#A)Toshkent` (qavsdan keyin probel qo'yilmagan) holatlarida `A)` prefiksi o'chirilmasdan qolib ketadi.
* **Tuzatish bo'yicha ko'rsatma:**
  - 348-qatorda `trailingHashMatch` uchun `optionsBefore.every(line => !/^[#*]/.test(line.trim()))` shartining o'zi yetarli (variantlarning birortasida `#` bo'lmasa va oxirgi qator `^[#*]\s*([a-dA-D1-4])$` bo'lsa, u javob kalitidir).
  - 331 va 375-qatorlardagi variant prefiksi regexini `/^(?:[a-zA-Z][\)\.]|\d+\))\s*/` (`\s+` o'rniga `\s*`) ga o'zgartiring.

---

### BUG-12: Interaktiv "Xatolar ustida ishlash" (`wm_start_inline`) va Asosiy menyu / Taymer to'qnashuvlari
* **Fayl:** `src/handlers/quizGame.js` (623–875-qatorlar) va `src/core/utils.js` (`resetUserFlows`, 100-qator)
* **Muammo tavsifi:**
  1. Foydalanuvchi interaktiv rejimda (`wm_start_inline`) savol ustida o'ylayotganda (20 soniyalik `activeWmTimers` ishlab turganda) `/start`, `/menu` bossa yoki boshqa bo'limga o'tib ketsa, `resetUserFlows` funksiyasi `activeWmTimers` ni to'xtatmaydi (`clearWmTimer` chaqirilmagan). 20 soniyadan keyin taymer ishga tushib, foydalanuvchiga kutilmaganda *"⏳ Vaqt tugadi!"* xabarini chiqaradi.
  2. `sendNextInlineMistake` (664-qator) da G'alaba ekranidagi `"🔙 Fan menyusiga qaytish"` tugmasi `backAction` (`post_subj_${subjKey}`) ni `safeCallbackData(..., 64)` siz yaratadi. Agar test Javondan yoki uzun nomli fandan olingan bo'lsa, 64 baytdan oshib ketib G'alaba xabari chiqmay qoladi, yoki `cbPostSubj` da `SUBJECTS[subjectKey]` topilmagani sababli rasmiy testlar ro'yxatiga otib yuboradi.
* **Tuzatish bo'yicha ko'rsatma:**
  - `quizGame.js` dan `clearWmTimer` ni eksport qilib, `src/core/utils.js` dagi `resetUserFlows(userId, ctx)` ichida `clearWmTimer(uid)` va `redisConnection.del('wm_state:' + uid)` ni chaqiring.
  - `sendNextInlineMistake` (676-qator) da `safeCallbackData(backAction, 64)` ishlating.

---

### BUG-13: Uzun savol bo'laklanganda (`needsSplit = true`) matn xabari yuborilmay qolsa, savolsiz bo'sh Poll chiqishi
* **Fayl:** `src/handlers/coreQuiz.js` (237–253-qatorlar)
* **Muammo tavsifi:**
  Savol matni 255 belgidan yoki varianti 100 belgidan uzun bo'lganda (`needsSplit === true`), bot avval savol matni va variantlarini oddiy xabar qilib yuboradi:
  ```javascript
  await telegram.sendMessage(chatId, text, splitOpts).catch(() => {});
  pollQ = `${progress} To'g'ri variantni belgilang:`.slice(0, 300);
  pollOpts = options.map((_, i) => `${labels[i] || i + 1} varianti`);
  ```
  Agar `sendMessage` Telegram rate-limit (429) yoki tarmoq uzilishi sababli xato bersa, `.catch(() => {})` xatoni yutib yuboradi va bot darhol *"To'g'ri variantni belgilang: A varianti, B varianti..."* degan bo'sh so'rovnomani yuboradi. O'quvchi savolni ko'rmasdan taxminiy belgilashga majbur bo'ladi.
* **Tuzatish bo'yicha ko'rsatma:**
  `telegram.sendMessage` ni ham `sendPoll` bilan bir xil retry (429 va tarmoq xatolarida qayta urinish) blokiga kiriting.

---

### BUG-14: `testCreation.js` da `HTML` va `Markdown` parse_mode'larining aralashib ketishi
* **Fayl:** `src/handlers/testCreation.js` (24, 282, 425, 433, 1022-qatorlar) va `src/core/utils.js` (`truncateText`, 207-qator)
* **Muammo tavsifi:**
  1. `AI_WARNING_TEXT` (24-qator) Markdown sintaksisida (`*Eslatma:* _Bu javoblar..._`) yozilgan, lekin `cbAiCount` (425 va 433-qatorlar) da `parse_mode: "HTML"` bilan yuboriladi.
  2. `cbFmt` (282-qator) da `const aiText = "🤖 *AI Smart Quiz — Sun'iy Intellekt bilan test yaratish*...";` matni chala kesilib qolgan.
  3. `safeEdit` (`utils.js` 217-qator) barcha matnlarni `truncateText(text, 4000)` dan o'tkazadi. `truncateText` matn oxiriga HTML tegli `\n\n<i>...(matn qisqartirildi)</i>` qo'shadi, bu esa `parse_mode: "Markdown"` ishlatilgan xabarlarda xom `<i>` tegini chiqarib qo'yadi.
  4. `cbManageSubj` (1022-qator) da fandagi bloklar soni ko'p bo'lganda sahifalash (pagination) yo'q.
* **Tuzatish bo'yicha ko'rsatma:**
  `testCreation.js` dagi barcha xabarlarni yagona `parse_mode: "HTML"` va `escapeHtml` standartiga o'tkazing hamda `cbManageSubj` ga 10 tadan sahifalash qo'shing.

---

### BUG-15: WebApp / Socket.io Kahoot rejimida xavfsizlik va sinxronizatsiya xatolari
* **Fayl:** `src/socket/index.js` (31–48, 144–160-qatorlar), `src/socket/gameLoop.js` (69–82-qatorlar), `src/api/admin.js` (79–85-qatorlar)
* **Muammo tavsifi:**
  1. `kahoot:answer_submit` (`src/socket/index.js` 144-qator) da `if (!room.players.has(userId)) return;` tekshiruvi yo'q. Xonaga kirmagan foydalanuvchi javob yuborib `room.kahootAnswers.size` ni oshirishi mumkin.
  2. `if (room.kahootAnswers.size >= room.players.size)` (157-qator) tekshiruvida uzilgan (`p.disconnected === true`) o'yinchilar hisobdan chiqarilmagan (`game:leaderboard_ack` da esa hisobdan chiqarilgan). Natijada bitta o'yinchi uzilib qolsa, qolganlar har savolda 20 soniya kutadi.
  3. `room:create` (`src/socket/index.js` 35-qator) da xona allaqachon mavjud bo'lsa ham boshqa foydalanuvchiga `room:created` qaytaradi.
  4. `src/api/admin.js` (82-qator) da `SingleKahootQuestionSchema` ichida `correct_index` faqat `.min(0)` bilan tekshirilgan, `correct_index < options.length` sharti (`.refine(d => d.correct_index < d.options.length)`) qo'yilmagan.
* **Tuzatish bo'yicha ko'rsatma:**
  ```javascript
  // src/socket/index.js (148-qator)
  if (!room.players.has(userId)) return;
  if (room.kahootAnswers.has(userId)) return;
  room.kahootAnswers.set(userId, answerIndex);

  if (String(answerIndex) === String(room.currentAnswer)) {
    const player = room.players.get(userId);
    if (player) player.score += 10;
  }

  const activeCount = Array.from(room.players.values()).filter(p => !p.disconnected).length;
  if (room.kahootAnswers.size >= Math.max(1, activeCount)) {
    showLeaderboard(roomCode, room);
  }
  ```

---

## 🟢 4. LOW (Quyi — UX, Xotira va Mayda kamchiliklar)

### BUG-16: `index.js` Sessiya Middleware'ida `updateData` dan keyin kalit o'chirilsa eski qiymatning qaytib qolishi
* **Fayl:** `index.js` (135–148-qatorlar) va `src/core/utils.js` (118–127-qatorlar)
* **Muammo tavsifi:**
  `updateData(ctx, patch)` funksiyasi har chaqirilganda Redis'dagi `tg_session:${uid}` ni darhol yangilaydi. So'rov yakunida (`index.js` `finally` blokida) middleware `latestRedisStr !== originalSessionStr` ekanini ko'rib, `sess.data = { ...(latestSess.data || {}), ...(sess.data || {}) }` orqali birlashtiradi. Agar handler `updateData` dan keyin `delete ctx.session.data.someKey` qilgan bo'lsa, u kalit `latestSess.data` dan qayta tiklanib qoladi.
* **Tuzatish bo'yicha ko'rsatma:**
  `updateData` ichida Redis'ga yozilganda `ctx._lastSyncedSessionStr = JSON.stringify(ctx.session)` ni belgilab ketish va `index.js` da `originalSessionStr` o'rniga `ctx._lastSyncedSessionStr || originalSessionStr` bilan solishtirish lozim.

### BUG-17: Javondan tugatilgan testni qayta boshlaganda (`resumeTestFromShelf`) savollar va variantlar aralashtirilmasligi
* **Fayl:** `src/handlers/quizGame.js` (783–805-qatorlar)
* **Muammo tavsifi:**
  Javondagi 100% yakunlangan testda *"🔁 Qaytadan boshlash"* bosilganda (`isCompleted === true`), savollar `prepareShuffledQuestions(savedTest.questions)` orqali aralashtirilmasdan to'g'ridan-to'g'ri yuboriladi.
* **Tuzatish bo'yicha ko'rsatma:**
  `isCompleted` bo'lganda `sessionQuestions: prepareShuffledQuestions(savedTest.questions)` dan foydalaning.

---

## 📋 Tuzatishlarni Amalga Oshirish Tartibi (Action Plan)

1. **1-navbatda (Critical):**
   - `src/services/dbService.js`: `getUsersStatsSummaryByIds` da `cache:user_stats:${uid}` keshini zaharlamaslik (`cache:user_stats_summary:${uid}` ga ajratish) va `saveTestToShelf` da `subjectId`, `creatorId`, `isUgc` maydonlarini saqlash.
   - `index.js`: Global message state routerda `if (ctx.chat?.type !== "private") return next();` tekshiruvini qo'shish.
   - `src/handlers/shelfHandlers.js`: Callback datalarni papka nomi (`folderName`) o'rniga papka indeksi (`fIdx`) ga o'tkazish.
   - `src/handlers/testCreation.js`: Ko'p qismli uzun matnlar (`userTextChunks`) birlashtirilishida 4096-belgi kesimini to'g'ri ulash.
2. **2-navbatda (High — Guruh va Shaxsiy o'yin mantiqi):**
   - `src/handlers/groupQuizLogic.js`, `src/handlers/quizGame.js` va `src/handlers/coreQuiz.js`: Kutish zaliga (test boshlanishidan oldin) **`⚡ Avto-o'tish: YOQILGAN / O'CHIQ (30s)`** ixtiyoriy (optional) tugmasini qo'shish va faqat u yoqilgandagina ro'yxatdan o'tgan qatnashchilar (`readyUserIds`) javob berib bo'lishi bilan keyingi savolga o'tkazish (**BUG-06**).
   - `src/handlers/coreQuiz.js` va `src/core/utils.js`: Bir xil variantlarni (`pollOpts`) unikal qilish va `finishTest` da ochiq poll'ni yopish (**BUG-05**, **BUG-07**).
   - `src/handlers/quizGame.js`: `"🚀 Testga tayyormisiz?"` ekraniga `"❌ Bekor qilish"` tugmasini qo'shish va `preparing` holatidagi testlarni `/start` bosilganda javonga saqlamaslik (**BUG-10**).
   - `src/handlers/testCreation.js`: `cbManageTest` da `clearState(ctx)` chaqirish va `is_editing` rejimini `onDocxFile` hamda `cbFixErrors` da hisobga olish (**BUG-08**).
3. **3-navbatda (Medium & Low):**
   - `src/core/utils.js`: `resetUserFlows` ichida `clearWmTimer` va `wm_state` tozalashni qo'shish, `parseTextQuestions` regexlarini takomillashtirish.
   - `src/socket/index.js` va `src/api/admin.js`: Kahoot o'yinchi tekshiruvi va Zod sxemasiga `.refine()` qo'shish.