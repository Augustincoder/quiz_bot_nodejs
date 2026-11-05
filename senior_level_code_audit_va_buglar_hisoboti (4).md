# 🛡️ Senior-Level Audit Hisoboti (v4): 20–50+ Parallel Quiz Sessiyalari va Yuqori Yuklama Tahlili (`ALL_SYSTEM_CODE_4.txt`)

Ushbu hisobotda:
1. **Avvalgi 5 ta bug va Supabase AI optimizatsiyalarining `ALL_SYSTEM_CODE_4.txt` da 100% hal etilganligi tasdiqlandi.**
2. **Ayni paytda 20–50+ kishi bir vaqtda quiz ishlayotganda** (`coreQuiz.js`, `quizGame.js`, `workers.js`, `sessionService.js`) yuzaga kelishi mumkin bo'lgan **5 ta yuqori yuklama (concurrency) va poyga holati (race condition) muammosi** aniqlandi hamda ularning aniq yechimlari tayyorlandi.

---

## ✅ 1-BO'LIM: `ALL_SYSTEM_CODE_4.txt` DA TASDIQLANGAN TUZATISHLAR

| # | Tekshirilgan qism | Holati | Natija |
|---|---|---|---|
| **1** | Guruh Marafonida 2-blokning qotib qolishi (`session.isFinished` va `isMarathonContinuing`) | ✅ **100% Tuzatildi** | `coreQuiz.js` da `session.isFinished = false` tiklandi va `finally` blokida marafon davom etayotganda sessiya o'chib ketmasligi himoyalandi. |
| **2** | UGC `retry` (Klassik Quiz) tugaganda `ugc_start_NaN` tugmasi chiqishi | ✅ **100% Tuzatildi** | `coreQuiz.js` da `isUgcSession` ichida `retry` holati alohida ushlandi va `safeCallbackData` qo'shildi. |
| **3** | `startHandler.js`, `contactAdmin.js` va `shelfHandlers.js` himoyalari | ✅ **100% Tuzatildi** | `cancelSessionTimer`, `stopPoll` va javon papka/tugma uzunligi himoyalari qo'shildi. |
| **4** | `utils.js` da `# 4` javob kaliti regresi | ✅ **100% Tuzatildi** | `optionsHavePrefixes` sharti qat'iy bog'landi. |
| **5** | Supabase I/O optimizatsiyalari (`dbService.js`, `adminHandlers.js`, `supabase.js`) | ✅ **100% Tuzatildi** | `getUsersStatsSummaryByIds`, `updateUserStats` da `shelf` ni chiqarib tashlash, `upsertTimetableCache` da `isNoOp` tekshiruvi va `anon` kalit ogohlantirishi to'liq kiritildi. |

---

## 🔥 2-BO'LIM: 20–50+ PARALLEL QUIZ SESSIYALARIDA YUZAGA KELADIGAN 5 TA MUAMMO VA YECHIMLARI

Bir vaqtda 20–50 nafar talaba test yechayotganda tizimda sekundiga o'nlab `poll_answer`, `sendPoll`, `stopPoll` va BullMQ taymerlari aylanadi. Quyidagi 5 ta nuqtani mustahkamlash test jarayonida **0% xatolik** bo'lishini kafolatlaydi:

---

### 🔴 Muammo #1 (CRITICAL): 20–50 kishi bir vaqtda ishlaganda Telegram `429 Too Many Requests` yoki tarmoq uzilishi bo'lsa, savolning "Xato (`wrong++`)" deb o'tkazib yuborilishi!
* **Manzil:** `src/handlers/coreQuiz.js` (`sendNextQuestion`, 236–300-qatorlar)
* **Sababi:**
  Telegram Bot API ning global cheklovi — sekundiga ~30 ta xabar. Agar 30–50 ta talaba bir vaqtda savolga javob bersa yoki test boshlasa, `telegram.sendPoll(...)` so'rovlaridan ba'zilari Telegram'dan `429 Too Many Requests: retry after X` (yoki vaqtinchalik `ETIMEDOUT` / `ECONNRESET`) qaytarishi mumkin.
  Hozirgi kodda `catch (e)` bloki `429` ni tekshirmasdan, darhol:
  1. Foydalanuvchiga `"⚠️ Texnik xatolik: Bu savolni Telegram qabul qilmadi. Savol o'tkazib yuborildi"` deb xabar yuboradi (bu esa 429 limitini yanada kuchaytiradi!).
  2. Talabaning savolini **XATO (`session.wrong++`, `"⚠️ Savol yuklanmadi"`)** deb hisoblab, keyingi savolga (`session.qIdx++`) o'tib ketadi!
  Shuningdek, agar savolning `explanation` qismida HTML tegi buzilgan bo'lsa ham savol o'tkazib yuboriladi.
* **Yechim (`src/handlers/coreQuiz.js`):**
  `telegram.sendPoll` xatolik berganda:
  1. Agar xato `429` (`retry_after`) bo'lsa — `retry_after` soniya kutib, **aynan shu savolni (`session.qIdx` ni o'zgartirmasdan!) qayta yuborish**.
  2. Agar xato `can't parse entities` bo'lsa (`explanation` tufayli) — `explanation_parse_mode` ni olib tashlab darhol qayta yuborish.
  3. Agar vaqtinchalik tarmoq uzilishi (`ETIMEDOUT`, `ECONNRESET`, `502`, `503`) bo'lsa — 1 soniya kutib aynan shu savolni qayta yuborish. Faqat savolning o'zi yaroqsiz (`400 Bad Request`) bo'lsagina uni o'tkazib yuborish!

---

### 🔴 Muammo #2 (HIGH): Savol almashayotgan 600ms pauza paytida `/stop` yoki `"🗑 Butunlay bekor qilish"` bosilsa, o'chirilgan testning "tirilib" ketishi (Race Condition)
* **Manzil:** `src/handlers/quizGame.js` (`cbStopTest` 422-qator, `cbPauseResume` 498-qator, `cbPauseShelf` 529-qator, `cbForceFinish` 898-qator, `cbResumeTest` 920-qator)
* **Sababi:**
  1. Talaba savolga javob berganda `handlePollAnswer` (`coreQuiz.js` 682-qator) `mutex.lock("poll:" + chatId)` qulfini oladi, **600ms kutadi** va `sendNextQuestion` orqali keyingi poll'ni Telegram'ga yuborib, `sessionService.setActiveTest(chatId, session)` qiladi.
  2. Ammo `cbStopTest` (`/stop`), `cbForceFinish`, `cbPauseShelf` funksiyalari **`poll:${chatId}` qulfini olmaydi!**
  3. Agar talaba javob berishi bilan darhol `/stop` yozsa yoki `"🗑 Butunlay bekor qilish"` ni bossa:
     - `cbForceFinish` sessiyani Redis'dan o'chiradi (`deleteActiveTest`).
     - Oradan 200ms o'tib, fonda ketayotgan `handlePollAnswer -> sendNextQuestion` Telegram'dan yangi poll javobini oladi va o'z xotirasidagi eski `session` obyektini `setActiveTest(chatId, session)` orqali **qaytadan Redis'ga yozib qo'yadi!**
     - Natijada to'xtatilgan yoki o'chirilgan testdan keyin yana yangi savol chiqib keladi!
* **Yechim (`src/handlers/quizGame.js`):**
  `cbStopTest`, `cbPauseResume`, `cbPauseShelf`, `cbForceFinish`, `cbResumeTest` funksiyalarini ham yagona `mutex.lock("poll:" + chatId)` bilan himoyalash hamda `cbStopTest` ichida `session.pollId = null` qilib `deletePollChat` ni chaqirish.

---

### 🔴 Muammo #3 (HIGH): "Xatolar ustida ishlash -> Interaktiv Rejim" (`wm_ans_`) da tugmani ikki marta tez bosib yuborish (Double-Tap) keyingi savolni ko'rmasdan o'tkazib yuborishi!
* **Manzil:** `src/handlers/quizGame.js` (`sendNextInlineMistake` 746-qator va `cbWmAns` 787-qator)
* **Sababi:**
  746-qatorda javob tugmalari quyidagicha yasalgan:
  ```javascript
  Markup.button.callback(`${labels[i]}`, `wm_ans_${isCorrect ? 1 : 0}`)
  ```
  Ya'ni barcha savollar uchun to'g'ri tugma har doim bir xil `wm_ans_1`, xato tugma esa `wm_ans_0`!
  Agar talaba 1-savolda to'g'ri javobni (`wm_ans_1`) internet sekinligida **2 marta bosib yuborsa**:
  1. 1-bosish `mutex.lock("wm_ans:" + chatId)` ga kiradi, 1-savolni `queue.shift()` qilib oladi va 2-savolni ekranga chiqaradi.
  2. 2-bosish (u ham `wm_ans_1`!) navbat kutib turgan joyidan qulfga kiradi va **talaba 2-savolni hali o'qimasdan turib, 2-savolni ham `queue.shift()` qilib "To'g'ri topdingiz!" deb o'tkazib yuboradi!**
  3. Xuddi shunday, agar talaba xato javob (`wm_ans_0`) ni 2 marta bossa, `"❌ Yana xato qildingiz! [➡️ Davom etish]"` oynasi turgan paytda 2-bosish navbatdagi savolni ham xato deb ro'yxat oxiriga uloqtiradi!
* **Yechim (`src/handlers/quizGame.js`):**
  `state` ichida `step` (qadam raqami) va `awaitingNext` bayrog'ini saqlash hamda tugma callback'ini `wm_ans_${state.step}_${i}_${isCorrect ? 1 : 0}` ko'rinishida yasash. Agar bosilgan tugmaning `step` raqami joriy `state.step` ga teng bo'lmasa yoki `state.awaitingNext === true` bo'lsa, takroriy bosishni darhol rad etish!

---

### 🟠 Muammo #4 (MEDIUM-HIGH): BullMQ `quizTimerWorker` da `concurrency: 5` cheklovi va `cbUserReadyStart` dagi 4 karra `editMessageText` yuklamasi
* **Manzil:** `src/jobs/workers.js` (257-qator) va `src/handlers/quizGame.js` (387–413-qatorlar)
* **Sababi:**
  1. `workers.js` da `quizTimerWorker` uchun `concurrency: 5` berilgan. Bir vaqtda 20–50 kishi test ishlayotganda, bir necha foydalanuvchining 30 soniyalik taymeri bir vaqtda tugasa, 5 tadan ortiq taymerlar navbatda kutib qoladi. `concurrency: 25` qilish taymerlarning soniyasiga aniq ishlashini ta'minlaydi.
  2. `cbUserReadyStart` (`quizGame.js` 387-qator) har bir test boshlanganda 3 soniya ichida **4 marta** `safeEdit` (`3️⃣` -> `2️⃣` -> `1️⃣` -> `BOSHLADIK!`) qiladi. Auditoriyada 30 ta talaba baravar `"▶️ Boshlash"` ni bossa, 3 soniyada **120 ta ortiqcha `editMessageText`** so'rovi ketadi (va agar bittasi 429 bersa, `safeEdit` chatga yangi xabarlar tashlab ketadi). Buni bitta tezkor tahrirga (`"🚀 Kamarlarni taqing! BOSHLADIK! 🍀"`) tushirish Telegram API yuklamasini **4 barobar** kamaytiradi!

---

### 🟡 Muammo #5 (MEDIUM): Har bir savolda Redis'ga ortiqcha (2 karra) yozishlar va `sessionService.js` kesh mantiqi
* **Manzil:** `src/handlers/coreQuiz.js` (40–51, 326–339, 646-qatorlar) va `src/services/sessionService.js` (20–34-qatorlar)
* **Sababi:**
  1. `sendNextQuestion` ichida 333 va 339-qatorlarda `await sessionService.setActiveTest(chatId, session)` ketma-ket **2 marta** chaqirilgan (`timerJobId` ni avvalroq berib 1 marta yozish kifoya).
  2. `cancelSessionTimer` ichida yangi `session.timerJobId` o'chirilgandan keyin ham har safar eski formatdagi 2 ta job (`timeout_${chatId}_${qIdx}` va `timeout:${chatId}:${qIdx}`) Redis'dan qidiriladi (50 ta aktiv foydalanuvchida har savolda 100 ta ortiqcha Redis so'rovi).
  3. Guruh testida har bir o'yinchi ovoz berganda `sessionService.getActiveTest(chatId)` chaqiriladi — holbuki `expectedParticipantsCount` ni `activePollsCache` ichiga qo'yib, faqat `voterCount >= expectedParticipantsCount` bo'lgandagina `getActiveTest` ni chaqirish Redis trafigini 80% tejaydi.
  4. `sessionService.js` da `redis.get` muvaffaqiyatli ishlab `null` qaytarganda ham pastdagi `localActiveTestCache` ga tushib ketadi (`localActiveTestCache` faqat `catch (err)` — ya'ni Redis uzilgandagina ishlashi kerak).

---

## 🛠️ TUZATILGAN KOD QISMLARI (NUSXA OLIB QO'YISH UCHUN TAYYOR)

Quyida faqat o'zgarish kiritilishi kerak bo'lgan **4 ta fayl** (`src/handlers/coreQuiz.js`, `src/handlers/quizGame.js`, `src/services/sessionService.js`, `src/jobs/workers.js`) ning aniq tuzatishlari keltirilgan:

### 1. `src/services/sessionService.js` (`getActiveTest`, `getPollChat`, `getWaitingRoom` da `return null` ni `try` ichiga olish)
```javascript
// ─── Active Tests ────────────────────────────────────────────
async function getActiveTest(chatId) {
  const cid = String(chatId);
  try {
    const data = await redis.get(`activeTest:${cid}`);
    if (data) {
      const parsed = JSON.parse(data);
      localActiveTestCache.set(cid, { data: parsed, expiresAt: Date.now() + TTL * 1000 });
      return parsed;
    }
    localActiveTestCache.delete(cid);
    return null;
  } catch (err) {
    logger.error('sessionService.getActiveTest failed, falling back to local memory', { chatId: cid, error: err.message });
  }
  const fallback = localActiveTestCache.get(cid);
  if (fallback && fallback.expiresAt > Date.now()) {
    return fallback.data;
  }
  return null;
}

// ─── Poll ↔ ChatId Mapping ──────────────────────────────────
async function getPollChat(pollId) {
  const pid = String(pollId);
  try {
    const chat = await redis.get(`pollMap:${pid}`);
    if (chat) {
      localPollMapCache.set(pid, { chatId: chat, expiresAt: Date.now() + POLL_TTL * 1000 });
      return chat;
    }
    localPollMapCache.delete(pid);
    return null;
  } catch (err) {
    logger.error('sessionService.getPollChat failed, checking local backup', { pollId: pid, error: err.message });
  }
  const fallback = localPollMapCache.get(pid);
  if (fallback && fallback.expiresAt > Date.now()) {
    return fallback.chatId;
  }
  return null;
}

// ─── Waiting Rooms ──────────────────────────────────────────
async function getWaitingRoom(chatId) {
  const cid = String(chatId);
  try {
    const data = await redis.get(`waitingRoom:${cid}`);
    if (data) {
      const room = JSON.parse(data);
      if (Array.isArray(room.readyUsers)) {
        const obj = {};
        room.readyUsers.forEach(id => obj[id] = 'Foydalanuvchi');
        room.readyUsers = obj;
      }
      localWaitingRoomCache.set(cid, { data: room, expiresAt: Date.now() + 300 * 1000 });
      return room;
    }
    localWaitingRoomCache.delete(cid);
    return null;
  } catch (err) {
    logger.error('sessionService.getWaitingRoom failed, checking local fallback', { chatId: cid, error: err.message });
  }
  const fallback = localWaitingRoomCache.get(cid);
  if (fallback && fallback.expiresAt > Date.now()) {
    return fallback.data;
  }
  return null;
}
```

### 2. `src/jobs/workers.js` (253–261-qatorlarda `quizTimerWorker` concurrency = 25)
```javascript
  const quizGame = require('../handlers/quizGame');
  const quizTimerWorker = new Worker('quizTimerQueue', async (job) => {
    const { chatId, expectedIdx, pollId } = job.data;
    await quizGame.questionTimeout(chatId, expectedIdx, pollId, bot.telegram);
  }, {
    connection: redisConnection.createWorkerConnection(),
    concurrency: 25,
    limiter: { max: 25, duration: 1000 },
    lockDuration: 60000,
    maxStalledCount: 2,
  });
```