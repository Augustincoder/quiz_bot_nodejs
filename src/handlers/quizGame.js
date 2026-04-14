"use strict";

const { Markup } = require("telegraf");
const mutex = require("../core/mutex");
const { SUBJECTS } = require("../config/config");
const dbService = require("../services/dbService");
const aiService = require("../services/aiService");
const { getBlocksKeyboard } = require("../keyboards/keyboards");
const {
  prepareShuffledQuestions,
  shuffleArray,
} = require("../core/questionUtils");
const {
  userNameCache,
  safeEdit,
  safeDelete,
  backToMainKb,
  progressBar,
  safePercent,
  grade,
  parseSuffix,
} = require("../core/utils");

const { pendingShelfSaves } = require("../core/pendingStore");
const { TTLMap } = require("../core/utils");
const sessionService = require("../services/sessionService");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// FIX #1: Race condition — finishTest async DB yozuvini kutmay cbReviewMistakes
// DB ga yozilishidan oldin foydalanuvchi "Xatolarni ko'rish" tugmasini bossayu,
// history[0] bo'sh chiqishi muammosi. Xatolar in-memory cache da saqlanadi.
// Endi xotira 1 soatdan keyin o'zini o'zi tozalaydi
const lastMistakesCache = new TTLMap(3600000);
async function cbOfficialTests(ctx) {
  await ctx.answerCbQuery();
  const memDb = require("../core/bot").memoryDb;
  const buttons = [];
  for (const [k, v] of Object.entries(SUBJECTS)) {
    const blocks = memDb[k] || {};
    const qCount = Object.values(blocks).reduce(
      (s, b) => s + (b.questions || []).length,
      0,
    );
    buttons.push([
      Markup.button.callback(
        `📘 ${v}  •  ${Object.keys(blocks).length} blok, ${qCount} savol`,
        `subj_${k}`,
      ),
    ]);
  }
  buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
  await safeEdit(
    ctx,
    "📚 *Rasmiy Testlar*\n\nAdmin tomonidan tayyorlangan testlar.\n\nFan tanlang:",
    Markup.inlineKeyboard(buttons),
  );
}

async function cbSubject(ctx) {
  await ctx.answerCbQuery();
  const subjectKey = parseSuffix(ctx.callbackQuery.data, "subj_");
  const subjName = SUBJECTS[subjectKey] || "Fan";
  await safeEdit(
    ctx,
    `📚 *${subjName}*\n\nBlok tanlang yoki Mock Exam yechib ko\'ring:`,
    getBlocksKeyboard(subjectKey, 0),
  );
}

async function cbPage(ctx) {
  await ctx.answerCbQuery();
  const parts = ctx.callbackQuery.data.split("_");
  const page = parseInt(parts[parts.length - 1], 10);
  const subjectKey = parts.slice(1, parts.length - 1).join("_");
  try {
    await ctx.editMessageReplyMarkup(
      getBlocksKeyboard(subjectKey, page).reply_markup,
    );
  } catch {
    /* no modification */
  }
}

async function showUgcSubjectBlocks(ctx, creatorId, subject) {
  const tests = await dbService.getUserCreatedTests(creatorId);
  const subjTests = tests.filter((t) => t.subject === subject);
  if (!subjTests.length)
    return ctx.reply("❌ Bu fanda bloklar topilmadi.", backToMainKb());
  const buttons = subjTests.map((t) => [
    Markup.button.callback(
      `📘 ${t.block_name}  •  ${(t.questions || []).length} savol`,
      `ugc_start_${t.id}`,
    ),
  ]);
  buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
  await ctx.reply(
    `📚 *${subject}*\n\n${subjTests.length} ta blok mavjud.\nBoshlash uchun blokni tanlang:`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) },
  );
}

async function startUgcTest(ctx, testDb) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  const existingSession = await sessionService.getActiveTest(chatId);
  
  if (existingSession) {
    return ctx.reply("⚠️ Sizda allaqachon faol test bor! Avval uni yakunlang: /stop");
  }

  // ⚠️ GURUH UCHUN MANTIQ (Kutish xonasi)
  if (ctx.chat?.type !== "private") {
    await sessionService.setWaitingRoom(chatId, {
      subjectKey: testDb.subject,
      testId: `ugc_${testDb.id}`,
      testData: testDb,
      initiatorId: ctx.from.id,
      readyUsers: new Set()
    });

    return ctx.reply(
      `👥 *Guruh Rejimi*\n\n📚 Fan: ${testDb.subject}\n📝 Blok: ${testDb.block_name || "Maxsus Test"}\n🔢 Savollar: ${(testDb.questions || []).length} ta\n\nKamida 2 kishi tayyor bo'lsa boshlanadi.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Tayyorman! (0)", "room_ready")],
          [Markup.button.callback("❌ Bekor qilish", "room_cancel")],
        ])
      }
    );
  }

  // 👤 SHAXSIY CHAT UCHUN MANTIQ
  const sessionQ = prepareShuffledQuestions(testDb.questions);
  await sessionService.setActiveTest(chatId, {
    chatType: "private",
    initiatorId: ctx.from.id,
    subjectKey: testDb.subject,
    testId: `ugc_${testDb.id}`,
    blockName: testDb.block_name || "",
    sessionQuestions: sessionQ,
    qIdx: 0,
    startTime: Date.now(),
    pollId: null,
    msgId: null,
    correct: 0,
    wrong: 0,
    mistakes: [],
    consecutiveTimeouts: 0,
    groupScores: {},
    finished: false,
    status: "preparing",
  });

  await ctx.reply(
    `🚀 *Testga tayyorgarlik*\n\n📚 Fan: ${testDb.subject}\n📝 Blok: ${testDb.block_name || ""}\n🔢 Jami: ${sessionQ.length} ta savol\n⏱ Har savolga 30 soniya\n\n_Boshlashga tayyor bo'lsangiz, quyidagi tugmani bosing:_`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Tayyorman!", "user_ready_start")],
      ]),
    },
  );
}

async function cbUgcStart(ctx) {
  await ctx.answerCbQuery();
  const testId = parseSuffix(ctx.callbackQuery.data, "ugc_start_");
  const testDb = await dbService.getUserTest(testId);
  if (!testDb)
    return ctx.reply("❌ Test topilmadi yoki o'chirilgan.", backToMainKb());
  await safeDelete(ctx);
  await startUgcTest(ctx, testDb);
}

async function cbStartTest(ctx) {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const memDb = require("../core/bot").memoryDb;

  const existingSession = await sessionService.getActiveTest(chatId);
  if (existingSession) {
    return ctx.answerCbQuery(
      "⚠️ Bu chatda faol test bor!\nAvval to'xtating: /stop",
      { show_alert: true },
    );
  } // <--- SIZDA SHU YOPUVCHI QAVS TUSHIB QOLGANDI

  const isMock = ctx.callbackQuery.data.startsWith("mock_");
  let subjectKey, testId, testData;

  if (isMock) {
    subjectKey = parseSuffix(ctx.callbackQuery.data, "mock_");
    const allQs = Object.values(memDb[subjectKey] || {}).flatMap(
      (t) => t.questions || [],
    );
    if (!allQs.length)
      return ctx.answerCbQuery("❌ Bu fanda savollar yo'q!", {
        show_alert: true,
      });
    shuffleArray(allQs);
    testData = { questions: allQs.slice(0, 25), block_name: "Aralash Test" };
    testId = "mock";
  } else {
    const suffix = parseSuffix(ctx.callbackQuery.data, "start_test_");
    const parts = suffix.split("_");
    testId = parseInt(parts[parts.length - 1], 10);
    subjectKey = parts.slice(0, -1).join("_");
    testData = (memDb[subjectKey] || {})[testId];
    if (!testData)
      return ctx.answerCbQuery("❌ Test topilmadi!", { show_alert: true });
  }

  await safeDelete(ctx);

  if (ctx.chat.type !== "private") {
    // ⚠️ YANGILANISH: waitingRooms.set emas, sessionService ishlatamiz
    await sessionService.setWaitingRoom(chatId, {
      subjectKey,
      testId,
      testData,
      initiatorId: ctx.from.id,
      readyUsers: new Set(),
    });

    const tLabel = testId === "mock" ? "Aralash" : `${testId}-Blok`;
    await ctx.telegram.sendMessage(
      chatId,
      `👥 *Guruh Rejimi*\n\n📚 ${SUBJECTS[subjectKey] || "Fan"} | ${tLabel}\n🔢 Savollar: ${testData.questions.length} ta\n\nKamida 2 kishi tayyor bo\'lsa boshlanadi.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Tayyorman! (0)", "room_ready")],
          [Markup.button.callback("❌ Bekor qilish", "room_cancel")],
        ]),
      },
    );
    return;
  }

  await initAndStartTest(
    chatId,
    ctx.telegram,
    subjectKey,
    testId,
    testData,
    ctx.from.id,
    "private",
  );
}

async function cbRoomReady(ctx) {
  const chatId = ctx.chat.id;
  // ⚠️ YANGILANISH: Redis'dan o'qiymiz
  const room = await sessionService.getWaitingRoom(chatId);
  if (!room)
    return ctx.answerCbQuery("Kutish zali yopilgan!", { show_alert: true });

  if (room.readyUsers.has(ctx.from.id))
    return ctx.answerCbQuery("✅ Siz allaqachon tayyorsiz!");

  room.readyUsers.add(ctx.from.id);

  // ⚠️ YANGILANISH: O'zgarishni Redis'ga saqlaymiz
  await sessionService.setWaitingRoom(chatId, room);

  const count = room.readyUsers.size;
  const buttons = [
    [Markup.button.callback(`✅ Tayyorman! (${count})`, "room_ready")],
  ];
  if (count >= 2)
    buttons.push([Markup.button.callback("🚀 Testni Boshlash!", "room_start")]);
  buttons.push([Markup.button.callback("❌ Bekor qilish", "room_cancel")]);

  try {
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard(buttons).reply_markup,
    );
  } catch {
    /* silent */
  }
  await ctx.answerCbQuery(`✅ Tayyor! Jami: ${count} kishi`);
}

async function cbRoomStart(ctx) {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  // YANGILANISH: Redis'dan o'qiymiz
  const room = await sessionService.getWaitingRoom(chatId);
  if (!room) return;

  // FIX #2: Faqat testni boshlagan kishi "Start" tugmasini bosa olishi kerak.
  // Avval bu tekshiruv yo'q edi — har qanday guruh a'zosi testi boshlay olardi.
  if (ctx.from.id !== room.initiatorId) {
    return ctx.answerCbQuery(
      "⚠️ Faqat testni boshlagan kishi ishga tushira oladi!",
      { show_alert: true },
    );
  }

  if (room.readyUsers.size < 2)
    return ctx.answerCbQuery("⚠️ Kamida 2 kishi tayyor bo'lishi kerak!", {
      show_alert: true,
    });
  // YANGILANISH: Redis'dan o'chiramiz
  await sessionService.deleteWaitingRoom(chatId);
  await safeDelete(ctx);

  const sessionQ = prepareShuffledQuestions(room.testData.questions);
  // YANGILANISH: Redis'ga saqlaymiz
  const sessionData = {
    chatType: "group",
    initiatorId: room.initiatorId,
    subjectKey: room.subjectKey,
    testId: room.testId,
    blockName: room.testData.block_name || "",
    sessionQuestions: sessionQ,
    qIdx: 0,
    startTime: Date.now(),
    pollId: null,
    msgId: null,
    timerTask: null,
    correct: 0,
    wrong: 0,
    mistakes: [],
    consecutiveTimeouts: 0,
    groupScores: {},
    finished: false,
    status: "running",
  };
  await sessionService.setActiveTest(chatId, sessionData);

  const msg = await ctx.telegram.sendMessage(
    chatId,
    `🚀 *Guruh Testi boshlanmoqda!*\n\n👥 ${room.readyUsers.size} kishi qatnashmoqda\n🔢 Jami: ${sessionQ.length} ta savol\n\n*3️⃣*`,
    { parse_mode: "Markdown" },
  );
  await wait(1000);
  await ctx.telegram.editMessageText(
    chatId,
    msg.message_id,
    undefined,
    `🚀 *Guruh Testi boshlanmoqda!*\n\n👥 ${room.readyUsers.size} kishi qatnashmoqda\n🔢 Jami: ${sessionQ.length} ta savol\n\n*2️⃣*`,
    { parse_mode: "Markdown" },
  );
  await wait(1000);
  await ctx.telegram.editMessageText(
    chatId,
    msg.message_id,
    undefined,
    `🚀 *Guruh Testi boshlanmoqda!*\n\n👥 ${room.readyUsers.size} kishi qatnashmoqda\n🔢 Jami: ${sessionQ.length} ta savol\n\n*1️⃣*`,
    { parse_mode: "Markdown" },
  );
  await wait(1000);
  await ctx.telegram.editMessageText(
    chatId,
    msg.message_id,
    undefined,
    `🚀 *BOSHLADIK!* Omad!`,
    { parse_mode: "Markdown" },
  );

  await sendNextQuestion(chatId, ctx.telegram);
}

async function cbRoomCancel(ctx) {
  const chatId = ctx.chat.id;
  // ⚠️ YANGILANISH: Redis'dan o'qiymiz
  const room = await sessionService.getWaitingRoom(chatId);

  if (!room)
    return ctx.answerCbQuery("Kutish zali allaqachon yopilgan.", {
      show_alert: true,
    });
  if (ctx.from.id !== room.initiatorId)
    return ctx.answerCbQuery(
      "⚠️ Faqat testni boshlagan kishi bekor qila oladi!",
      { show_alert: true },
    );

  // ⚠️ YANGILANISH: Redis'dan o'chiramiz
  await sessionService.deleteWaitingRoom(chatId);
  await safeDelete(ctx);

  await ctx.reply("❌ Test bekor qilindi.", backToMainKb());
}

async function initAndStartTest(
  chatId,
  telegram,
  subjectKey,
  testId,
  testData,
  initiatorId,
  chatType,
) {
  const sessionQ = prepareShuffledQuestions(testData.questions);

  // Ma'lumotni shakllantiramiz
  const sessionData = {
    chatType,
    initiatorId,
    subjectKey,
    testId,
    blockName: testData.block_name || "",
    sessionQuestions: sessionQ,
    qIdx: 0,
    startTime: Date.now(),
    pollId: null,
    msgId: null,
    correct: 0,
    wrong: 0,
    mistakes: [],
    consecutiveTimeouts: 0,
    groupScores: {},
    finished: false,
    status: "preparing",
  };

  // REDIS'GA YOZAMIZ
  await sessionService.setActiveTest(chatId, sessionData);

  const tLabel = testId === "mock" ? "Aralash Test" : `${testId}-Blok`;
  await telegram.sendMessage(
    chatId,
    `🚀 *Testga tayyorgarlik*\n\n📚 Fan: ${SUBJECTS[subjectKey] || subjectKey}\n📝 Blok: ${tLabel}\n🔢 Jami: ${sessionQ.length} ta savol\n⏱ Har savolga: 30 soniya\n\n_Boshlashga tayyor bo'lsangiz, quyidagi tugmani bosing:_`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Tayyorman!", "user_ready_start")],
      ]),
    },
  );
}

async function cbUserReadyStart(ctx) {
  const chatId = ctx.chat.id;
  // REDIS'DAN O'QIYMIZ
  const session = await sessionService.getActiveTest(chatId);

  if (!session || session.status !== "preparing")
    return ctx.answerCbQuery("⚠️ Test topilmadi yoki allaqachon boshlangan!", {
      show_alert: true,
    });
  if (session.initiatorId !== ctx.from.id)
    return ctx.answerCbQuery("⚠️ Bu sizning testingiz emas!", {
      show_alert: true,
    });

  await ctx.answerCbQuery();
  session.status = "running";
  session.startTime = Date.now();

  // O'ZGARISHNI REDIS'GA SAQLAYMIZ
  await sessionService.setActiveTest(chatId, session);

  await safeEdit(ctx, "⏳ *Diqqat! Test boshlanmoqda...* \n\n*3️⃣*", {
    parse_mode: "Markdown",
  });
  await wait(1000);
  await safeEdit(ctx, "⏳ *Diqqat! Test boshlanmoqda...* \n\n*2️⃣*", {
    parse_mode: "Markdown",
  });
  await wait(1000);
  await safeEdit(ctx, "⏳ *Diqqat! Test boshlanmoqda...* \n\n*1️⃣*", {
    parse_mode: "Markdown",
  });
  await wait(1000);
  await safeEdit(ctx, "🚀 *BOSHLADIK!* Omad yor bo'lsin!", {
    parse_mode: "Markdown",
  });

  await sendNextQuestion(chatId, ctx.telegram);
}

async function sendNextQuestion(chatId, telegram) {
  const session = await sessionService.getActiveTest(chatId);
  if (!session) return;
  if (session.qIdx >= session.sessionQuestions.length)
    return finishTest(chatId, telegram);

  const q = session.sessionQuestions[session.qIdx];
  const progress = `[${session.qIdx + 1}/${session.sessionQuestions.length}]`;
  const qFull = `${progress} ${q.question}`;
  const needsSplit =
    qFull.length > 255 || q.options.some((o) => o.length > 100);
  let pollQ, pollOpts;

  if (needsSplit) {
    const labels = ["A", "B", "C", "D", "E", "F"];
    let text =
      `📑 *Savol ${progress}*\n\n${q.question}\n\n` +
      q.options.map((opt, i) => `*${labels[i]})* ${opt}`).join("\n");
    if (text.length > 4000) text = text.slice(0, 3900) + "\n_(Matn kesildi)_";
    await telegram.sendMessage(chatId, text, { parse_mode: "Markdown" });
    pollQ = `${progress} To\'g\'ri variantni belgilang:`;
    pollOpts = q.options.map((_, i) => `${labels[i]} varianti`);
  } else {
    pollQ = qFull;
    pollOpts = q.options;
  }

  let msg;
  try {
    msg = await telegram.sendPoll(chatId, pollQ, pollOpts, {
      type: "quiz",
      correct_option_id: q.correct_index,
      is_anonymous: false,
      open_period: 30,
    });
  } catch (e) {
    console.error(`sendPoll error [${chatId}]:`, e.message);
    return;
  }

  session.pollId = msg.poll.id;
  session.msgId = msg.message_id;

  // REDIS'GA SAQLASH
  await sessionService.setActiveTest(chatId, session);
  await sessionService.setPollChat(msg.poll.id, chatId);

  // BULLMQ TAYMERI
  const { quizTimerQueue } = require("../jobs/queues");
  await quizTimerQueue.add(
    "timeout",
    { chatId, expectedIdx: session.qIdx, pollId: msg.poll.id },
    {
      delay: 31000,
      jobId: `timeout:${chatId}:${session.qIdx}`,
      removeOnComplete: true,
    },
  );
}

async function questionTimeout(chatId, expectedIdx, pollId, telegram) {
  // QULFNI YOPAMIZ
  const unlock = await mutex.lock(`poll:${chatId}`);

  try {
    const existingSession = await sessionService.getActiveTest(chatId);
    if (
      !existingSession ||
      existingSession.qIdx !== expectedIdx ||
      existingSession.pollId !== pollId
    )
      return;

    try {
      await telegram.stopPoll(chatId, existingSession.msgId);
    } catch {
      /* silent */
    }

    const qData = existingSession.sessionQuestions[expectedIdx];
    existingSession.qIdx++; // Xavfsiz oshirish

    if (existingSession.chatType === "private") {
      existingSession.wrong++;
      existingSession.consecutiveTimeouts++;
      existingSession.mistakes.push({
        question: qData.question,
        correct_ans: qData.correct_text || qData.options[qData.correct_index],
        wrong_ans: "⏳ Vaqt tugadi",
      });

      if (
        existingSession.consecutiveTimeouts >= 2 &&
        existingSession.qIdx < existingSession.sessionQuestions.length
      ) {
        const doneCount = existingSession.correct + existingSession.wrong;
        const remaining =
          existingSession.sessionQuestions.length - existingSession.qIdx;
        await telegram.sendMessage(
          chatId,
          `⏸ *Test to\'xtatildi!*\n\nKetma-ket 2 ta savolga javob bermadingiz.\n\n📊 *Joriy natija:*\n✅ To\'g\'ri: *${existingSession.correct} ta*\n❌ Xato: *${existingSession.wrong} ta*\n📌 Qolgan savollar: *${remaining} ta*\n\nDavom etasizmi?`,
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("▶️ Davom etaman", "resume_test")],
              [Markup.button.callback("🏁 Yakunlash", "force_finish")],
            ]),
          },
        );
        return;
      }
    }
    await sendNextQuestion(chatId, telegram);
  } finally {
    // QULFNI OCHAMIZ
    unlock();
  }
}

async function handlePollAnswer(pollAnswer, telegram) {
  const pollId = pollAnswer.poll_id;
  const chatId = await sessionService.getPollChat(pollId); // REDIS'DAN O'QISH
  if (!chatId) return;

  const unlock = await mutex.lock(`poll:${chatId}`);

  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session || session.pollId !== pollId) return;

    const qData = session.sessionQuestions[session.qIdx];
    const isCorrect = pollAnswer.option_ids[0] === qData.correct_index;
    const uId = pollAnswer.user.id;
    const uName = pollAnswer.user.first_name
      ? `${pollAnswer.user.first_name}${pollAnswer.user.last_name ? " " + pollAnswer.user.last_name : ""}`
      : "Foydalanuvchi";
    userNameCache.set(uId, uName);

    if (session.chatType === "private") {
      session.consecutiveTimeouts = 0;
      try {
        await telegram.stopPoll(chatId, session.msgId);
      } catch {
        /* silent */
      }

      if (isCorrect) session.correct++;
      else {
        session.wrong++;
        session.mistakes.push({
          question: qData.question,
          correct_ans: qData.correct_text || qData.options[qData.correct_index],
          wrong_ans: qData.options[pollAnswer.option_ids[0]],
        });
      }

      session.qIdx++;
      await sessionService.setActiveTest(chatId, session); // REDIS'NI YANGILASH
      await sendNextQuestion(chatId, telegram);
    } else {
      if (!session.groupScores[uId])
        session.groupScores[uId] = {
          name: uName,
          correct: 0,
          wrong: 0,
          mistakes: [],
        };
      const score = session.groupScores[uId];
      if (isCorrect) score.correct++;
      else {
        score.wrong++;
        score.mistakes.push({
          question: qData.question,
          correct_ans: qData.correct_text || qData.options[qData.correct_index],
          wrong_ans: qData.options[pollAnswer.option_ids[0]],
        });
      }
      await sessionService.setActiveTest(chatId, session); // REDIS'NI YANGILASH
    }
  } finally {
    unlock();
  }
}

async function finishTest(chatId, telegram) {
  const session = await sessionService.getActiveTest(chatId);
  if (!session || session.finished) return;
  session.finished = true;

  const tId = session.testId;
  const tName =
    String(tId) === "mock"
      ? "🎲 Aralash Test"
      : String(tId) === "adaptive"
        ? "🎯 AI Adaptiv Test"
        : String(tId).startsWith("ugc_")
          ? `📝 ${session.blockName || "Maxsus Test"}`
          : `${tId}-Blok`;
  const subjName = SUBJECTS[session.subjectKey] || session.subjectKey;
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const mins = Math.floor(elapsed / 60)
    .toString()
    .padStart(2, "0");
  const secs = (elapsed % 60).toString().padStart(2, "0");

  let text,
    buttons = [];

  if (session.chatType === "private") {
    lastMistakesCache.set(chatId, [...session.mistakes]);

    dbService
      .updateUserStats(
        chatId,
        session.correct,
        session.wrong,
        session.subjectKey,
        tId,
        session.mistakes,
      )
      .catch((e) => console.error("Stats error:", e.message));

    const total = session.correct + session.wrong;
    const skipped = session.sessionQuestions.length - total;
    const pct = safePercent(session.correct, total);
    text = `🏁 *Test Yakunlandi!*\n\n📚 ${subjName} | ${tName}\n\n✅ To\'g\'ri: *${session.correct} ta*\n❌ Xato: *${session.wrong} ta*\n⏭ O\'tkazildi: *${skipped} ta*\n\n🎯 Natija: *${pct}%* — ${grade(pct)}\n${progressBar(parseInt(pct), 100)}\n\n⏱ Vaqt: *${mins}:${secs}*`;

    pendingShelfSaves.set(chatId, {
      testId: tId,
      testName: tName,
      subject: session.subjectKey,
      questions: session.testData?.questions || session.sessionQuestions || [],
      progress: null,
    });

    if (session.mistakes.length)
      buttons.push([
        Markup.button.callback("❌ Xatolarni ko'rish", "review_mistakes"),
      ]);

    if (String(tId).startsWith("ugc_")) {
      const rawId = String(tId).replace("ugc_", "");
      buttons.push([
        Markup.button.callback("🔁 Qayta ishlash", `ugc_start_${rawId}`),
      ]);
      buttons.push([
        Markup.button.callback("📥 Javonga saqlash", `shelf_save_init`),
      ]);
      buttons.push([
        Markup.button.callback(
          "🔙 Fanga qaytish",
          `post_subj_${session.subjectKey}`,
        ),
        Markup.button.callback("🏠 Asosiy", "post_main"),
      ]);
    } else if (tId === "mock" || tId === "adaptive") {
      if (tId === "mock")
        buttons.push([
          Markup.button.callback(
            "🎲 Yana aralash",
            `mock_${session.subjectKey}`,
          ),
        ]);
      if (tId === "adaptive")
        buttons.push([
          Markup.button.callback(
            "🎯 Yana adaptiv",
            `adaptive_${session.subjectKey}`,
          ),
        ]);
      buttons.push([
        Markup.button.callback("📥 Javonga saqlash", `shelf_save_init`),
      ]);
      buttons.push([
        Markup.button.callback(
          "🔙 Fan menyusi",
          `post_subj_${session.subjectKey}`,
        ),
      ]);
      buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "post_main")]);
    } else {
      buttons.push([
        Markup.button.callback(
          "🔁 Qayta ishlash",
          `post_start_${session.subjectKey}_${tId}`,
        ),
      ]);
      const memDb = require("../core/bot").memoryDb || {};
      if ((memDb[session.subjectKey] || {})[tId + 1])
        buttons.push([
          Markup.button.callback(
            `➡️ Keyingi (${tId + 1}-Blok)`,
            `post_start_${session.subjectKey}_${tId + 1}`,
          ),
        ]);
      buttons.push([
        Markup.button.callback("📥 Javonga saqlash", `shelf_save_init`),
      ]);
      buttons.push([
        Markup.button.callback(
          "🔙 Fan menyusi",
          `post_subj_${session.subjectKey}`,
        ),
      ]);
      buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "post_main")]);
    }
  } else {
    await Promise.allSettled(
      Object.entries(session.groupScores).map(([uid, sc]) =>
        dbService.updateUserStats(
          uid,
          sc.correct,
          sc.wrong,
          session.subjectKey,
          tId,
          sc.mistakes,
        ),
      ),
    );
    let body;
    if (!Object.keys(session.groupScores).length)
      body = "😔 Hech kim javob bermadi.";
    else {
      const medals = ["🥇", "🥈", "🥉"];
      const sorted = Object.values(session.groupScores).sort(
        (a, b) => b.correct - a.correct,
      );
      body = sorted
        .map(
          (s, i) =>
            `${medals[i] ?? "🔸"} *${s.name}*: ${s.correct} to\'g\'ri, ${s.wrong} xato`,
        )
        .join("\n");
    }
    text = `🏁 *Test Yakunlandi!*\n\n📚 ${subjName} | ${tName}\n⏱ Vaqt: *${mins}:${secs}*\n\n🏆 *NATIJALAR:*\n${body}`;
    buttons.push([
      Markup.button.callback(
        "🔙 Fan menyusi",
        `post_subj_${session.subjectKey}`,
      ),
    ]);
    buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "post_main")]);
  }

  try {
    await telegram.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.error(`finishTest error [${chatId}]:`, e.message);
  } finally {
    if (session.pollId) await sessionService.deletePollChat(session.pollId);
    await sessionService.deleteActiveTest(chatId);
  }
}

async function cbPostMain(ctx) {
  await ctx.answerCbQuery();
  try {
    await ctx.editMessageReplyMarkup({});
  } catch {
    /* silent */
  }
  const { getMainKeyboard } = require("../keyboards/keyboards");
  await ctx.reply("🏛 *Asosiy Menyu*", {
    parse_mode: "Markdown",
    ...getMainKeyboard(),
  });
}

async function cbPostSubj(ctx) {
  await ctx.answerCbQuery();
  const subjectKey = parseSuffix(ctx.callbackQuery.data, "post_subj_");
  try {
    await ctx.editMessageReplyMarkup({});
  } catch {
    /* silent */
  }
  await ctx.reply(`📚 *${SUBJECTS[subjectKey] || "Fan"}*\n\nBlokni tanlang:`, {
    parse_mode: "Markdown",
    ...getBlocksKeyboard(subjectKey, 0),
  });
}

async function cbPostStart(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const suffix = parseSuffix(ctx.callbackQuery.data, "post_start_");
  const parts = suffix.split("_");
  const testId = parseInt(parts[parts.length - 1], 10);
  const subjectKey = parts.slice(0, -1).join("_");
  const chatId = ctx.chat.id;

  const existingSession = await sessionService.getActiveTest(chatId);
  if (existingSession) {
    return ctx.answerCbQuery("⚠️ Avval joriy testni to'xtating: /stop", { show_alert: true });
  }

  const memDb = require("../core/bot").memoryDb || {};
  const testData = (memDb[subjectKey] || {})[testId];
  if (!testData) return ctx.answerCbQuery("❌ Test topilmadi!", { show_alert: true });

  try { await ctx.editMessageReplyMarkup({}); } catch { /* silent */ }

  // ⚠️ GURUH UCHUN MANTIQ (Kutish xonasi)
  if (ctx.chat.type !== "private") {
    await sessionService.setWaitingRoom(chatId, {
      subjectKey,
      testId,
      testData,
      initiatorId: ctx.from.id,
      readyUsers: new Set()
    });

    return ctx.telegram.sendMessage(
      chatId,
      `👥 *Guruh Rejimi*\n\n📚 ${SUBJECTS[subjectKey] || subjectKey} | ${testId}-Blok\n🔢 Savollar: ${testData.questions.length} ta\n\nKamida 2 kishi tayyor bo'lsa boshlanadi.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("✅ Tayyorman! (0)", "room_ready")],
          [Markup.button.callback("❌ Bekor qilish", "room_cancel")],
        ])
      }
    );
  }

  // 👤 SHAXSIY CHAT UCHUN MANTIQ
  await initAndStartTest(chatId, ctx.telegram, subjectKey, testId, testData, ctx.from.id, "private");
}

async function cbResumeTest(ctx) {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const existingSession = await sessionService.getActiveTest(chatId);
  if (!existingSession)
    return ctx.answerCbQuery("❌ Test topilmadi.", { show_alert: true });
  existingSession.consecutiveTimeouts = 0;
  await safeDelete(ctx);
  await sendNextQuestion(chatId, ctx.telegram);
}

async function cbForceFinish(ctx) {
  await ctx.answerCbQuery();
  await safeDelete(ctx);
  await finishTest(ctx.chat.id, ctx.telegram);
}

async function cbReviewMistakes(ctx) {
  await ctx.answerCbQuery();

  // FIX #1 (davomi): DB o'rniga in-memory cache dan o'qiymiz — race condition yo'q.
  const mistakes = lastMistakesCache.get(ctx.chat.id) || [];

  if (!mistakes.length)
    return ctx.answerCbQuery("🎉 Bu testda xato yo'q edi!", {
      show_alert: true,
    });

  const parts = [`📑 *So\'nggi testdagi xatolar (${mistakes.length} ta):*`];
  for (let i = 0; i < Math.min(mistakes.length, 20); i++) {
    parts.push(
      `*${i + 1}.* ${mistakes[i].question}\n❌ ${mistakes[i].wrong_ans}\n✅ ${mistakes[i].correct_ans}`,
    );
  }
  if (mistakes.length > 20)
    parts.push(`_...va yana ${mistakes.length - 20} ta xato_`);

  await safeEdit(
    ctx,
    parts.join("\n\n"),
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🤖 AI Tutor: Xatolarni tahlil qilish",
          "ai_explain_mistakes",
        ),
      ],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]),
  );
}

async function cbAiExplainMistakes(ctx) {
  await ctx.answerCbQuery();

  // FIX #1 (davomi): Bu yerda ham cache ishlatiladi.
  const mistakes = lastMistakesCache.get(ctx.chat.id) || [];

  if (!mistakes.length)
    return ctx.answerCbQuery("Xatolar topilmadi!", { show_alert: true });

  await safeEdit(
    ctx,
    "🤖 <i>AI Tutor xatolaringizni tahlil qilmoqda... Iltimos, bir oz kuting</i> ⏳",
    { parse_mode: "HTML" },
  );

  const explanation = await aiService.explainMistakesBatch(mistakes);

  await safeEdit(ctx, `🤖 <b>AI Tutor Tahlili:</b>\n\n${explanation}`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]),
  });
}
// Testni darhol boshlamay, nechta xato ustida ishlashni so'raymiz
async function cbAdaptiveTest(ctx) {
  await ctx.answerCbQuery();
  const subjectKey = parseSuffix(ctx.callbackQuery.data, "adaptive_");
  const subjName = SUBJECTS[subjectKey] || subjectKey;

  // Xatolarni birinchi bo'lib tekshiramiz
  const stats = await require("../services/dbService").getUserStats(
    ctx.from.id,
  );
  const history = stats.history || [];
  let subjectMistakes = [];
  for (const record of history) {
    if (
      (record.subject === subjectKey || record.subjectKey === subjectKey) &&
      record.mistakes
    ) {
      subjectMistakes.push(...record.mistakes);
    }
  }

  // UX: Agar xato bo'lmasa, ruhlantiruvchi xabar!
  if (subjectMistakes.length === 0) {
    const emptyText = `🎉 *Ajoyib! ${subjName} bo'yicha hozircha xatolaringiz topilmadi.*

Bu yaxshi emas, bu zo'r! Lekin bu shuni anglatadiki, moslashuvchi test uchun material yo'q.

*Nima qilish mumkin?*
✅ Rasmiy test bloklarini ishlang
✅ Aralash (Mock Exam) yechib ko'ring
✅ Xatolar to'plangach, bu sahifaga qaytib keling`;

    return safeEdit(ctx, emptyText, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Fanga qaytish", `subj_${subjectKey}`)],
      ]),
    });
  }

  const mistakeCount = subjectMistakes.length;
  const topicCount = Math.max(1, Math.floor(mistakeCount / 2)); // Taxminiy mavzular soni

  const text = `🎯 *Moslashuvchi (Adaptiv) Test*

Bu test siz uchun maxsus tayyor — avvalgi testlardagi xatolaringiz tahlil qilinib, aynan shu mavzular bo'yicha yangi savollar yaratiladi.

━━━━━━━━━━━━━━━━
📊 *${subjName} bo'yicha holatingiz:*
❌ Topilgan xatolar: *${mistakeCount} ta*
📌 Qamrab olinadigan mavzular: taxminan *${topicCount} ta*
━━━━━━━━━━━━━━━━

*Nechta savol ishlaylik?*
💡 _Maslahat: 10-15 ta savol — diqqatni jamlash uchun optimal. Bir seansda ko'p savol qilsangiz, charchoq ortib, natija pasayib ketishi mumkin._`;

  await safeEdit(ctx, text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("5 ta", `adp_run_${subjectKey}_5`),
        Markup.button.callback("10 ta", `adp_run_${subjectKey}_10`),
      ],
      [
        Markup.button.callback("15 ta", `adp_run_${subjectKey}_15`),
        Markup.button.callback("20 ta", `adp_run_${subjectKey}_20`),
      ],
      [Markup.button.callback("🔙 Fanga qaytish", `subj_${subjectKey}`)],
    ]),
  });
}

// Tanlangandan keyin ishga tushadigan funksiya
async function cbAdaptiveRun(ctx) {
  await ctx.answerCbQuery();
  const suffix = parseSuffix(ctx.callbackQuery.data, "adp_run_"); // masalan: "moliyaviy_10"
  const parts = suffix.split("_");
  const count = parts.pop(); // oxirgisi "10"
  const subjectKey = parts.join("_");
  const subjName = SUBJECTS[subjectKey] || subjectKey;
  const chatId = ctx.chat.id;

  const existingSession = await sessionService.getActiveTest(chatId);
  if (existingSession) {
    return ctx.answerCbQuery("⚠️ Avvalgi testni to'xtating!", {
      show_alert: true,
    });
  }

  // Xatolarni qidirish (Avvalgidek)
  const stats = await dbService.getUserStats(ctx.from.id);
  const history = stats.history || [];
  let subjectMistakes = [];
  for (const record of history) {
    if (
      (record.subject === subjectKey || record.subjectKey === subjectKey) &&
      record.mistakes
    ) {
      subjectMistakes.push(...record.mistakes);
    }
  }

  if (subjectMistakes.length === 0)
    return ctx.answerCbQuery("🎉 Sizda bu fandan xatolar yo'q!", {
      show_alert: true,
    });

  const msg = await ctx.reply(
    `⏳ <i>AI Tutor "${subjName}" fanidan xatolaringizni tahlil qilib, ${count} ta maxsus test tuzmoqda...</i>`,
    { parse_mode: "HTML" },
  );

  const aiService = require("../services/aiService");
  const shuffledMistakes = subjectMistakes.sort(() => 0.5 - Math.random());

  // AI ga count qismini uzatamiz
  const adaptiveQuestions = await aiService.generateAdaptiveQuiz(
    subjName,
    shuffledMistakes,
    count,
  );

  if (!adaptiveQuestions || adaptiveQuestions.length === 0) {
    return ctx.telegram.editMessageText(
      chatId,
      msg.message_id,
      undefined,
      "❌ AI test tuzishda xatolik yuz berdi.",
    );
  }

  await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
  const testData = {
    questions: adaptiveQuestions,
    block_name: "🎯 Shaxsiy Adaptiv Test",
  };
  await initAndStartTest(
    chatId,
    ctx.telegram,
    subjectKey,
    "adaptive",
    testData,
    ctx.from.id,
    "private",
  );
}
// quizGame.js ichidagi cbStopTest:
async function cbStopTest(ctx) {
  try {
    // Agar bu yozuv (/stop) orqali kelsa ctx.callbackQuery bo'lmaydi
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery().catch(() => {});
    }

    const chatId = ctx.chat?.id || ctx.from?.id;

    // ⚠️ YANGILANISH: Sessiyani eski Map'dan emas, Redis'dan o'qiymiz!
    const session = await sessionService.getActiveTest(chatId);

    if (!session) {
      if (!ctx.callbackQuery) await safeDelete(ctx);
      return;
    }

    const tId = session.testId;
    const tName =
      String(tId) === "mock"
        ? "🎲 Aralash Test"
        : String(tId) === "adaptive"
          ? "🎯 AI Adaptiv Test"
          : String(tId).startsWith("ugc_")
            ? `📝 ${session.blockName || "Maxsus Test"}`
            : `${tId}-Blok`;

    // 🎯 Progressni xavfsiz TTLMap (pendingShelfSaves) ga saqlaymiz
    const { pendingShelfSaves } = require("../core/pendingStore");
    pendingShelfSaves.set(chatId, {
      testId: tId,
      testName: tName,
      subject: session.subjectKey,
      questions: session.testData?.questions || session.sessionQuestions || [],
      progress: {
        current_index: session.qIdx || 0,
        correct: session.correct || 0,
        mistakes: session.mistakes || [],
      },
    });

    // ⚠️ YANGILANISH: Redis'dagi testni va poll bog'lamasini tozalaymiz
    if (session.pollId) await sessionService.deletePollChat(session.pollId);
    await sessionService.deleteActiveTest(chatId);

    const text = `🛑 *Test to'xtatildi!*\n\nSiz *${tName}* testini *${session.qIdx}-savolida* to'xtatdingiz.\n\nBu testni keyinroq qolgan joyidan davom ettirish uchun shaxsiy javoningizga saqlab qo'yishingiz mumkin.`;
    const buttons = [
      [Markup.button.callback("📥 Javonga saqlash (Pauza)", `shelf_save_init`)],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ];

    if (ctx.callbackQuery) {
      await safeEdit(ctx, text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons),
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard(buttons),
      });
    }
  } catch (error) {
    // Endi xatolar Sentry/Winston'ga tushishi uchun konsolni o'zgartirsak ham bo'ladi
    console.error("To'xtatishda xato:", error);
  }
}
// YANGI: Javondan testni chala qolgan joyidan davom ettirish
async function resumeTestFromShelf(ctx, savedTest) {
  const chatId = ctx.chat.id;
  const initiatorId = ctx.from.id;

  const existingSession = await sessionService.getActiveTest(chatId);
  if (existingSession) {
    return ctx.reply(
      "⚠️ Sizda allaqachon faol test bor! Avval uni yakunlang: /stop",
    );
  }

  await safeDelete(ctx);

  const sessionQuestions = savedTest.questions;
  const prog = savedTest.progress || {
    current_index: 0,
    correct: 0,
    mistakes: [],
  };
  const wrongCount = prog.mistakes ? prog.mistakes.length : 0;

  // ⚠️ YANGILANISH: Eski activeTests.set o'rniga Redis'ga saqlaymiz
  const sessionData = {
    chatType: "private",
    initiatorId: initiatorId,
    subjectKey: savedTest.subject,
    testId: savedTest.testId,
    blockName: savedTest.testName,
    sessionQuestions: sessionQuestions,
    qIdx: prog.current_index || 0,
    startTime: Date.now(),
    pollId: null,
    msgId: null,
    correct: prog.correct || 0,
    wrong: wrongCount,
    mistakes: prog.mistakes || [],
    consecutiveTimeouts: 0,
    groupScores: {},
    finished: false,
    status: "running",
  };

  await sessionService.setActiveTest(chatId, sessionData);

  const startMsg =
    prog.current_index > 0
      ? `*${prog.current_index + 1}-savoldan davom etamiz!*`
      : `*Test boshlanmoqda!*`;

  await ctx.telegram.sendMessage(
    chatId,
    `🚀 *Javondagi test yuklandi...*\n\n📚 Fan: ${savedTest.subject}\n📝 Test: ${savedTest.testName}\n\n${startMsg}`,
    { parse_mode: "Markdown" },
  );

  // 1.5 soniya kutib, keyingi (navbatdagi) savolni jo'natamiz
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(1500);
  await sendNextQuestion(chatId, ctx.telegram);
}

// register(bot) ichiga qo'shing:
function register(bot) {
  bot.action("official_tests", cbOfficialTests);
  bot.action(/^subj_/, cbSubject);
  bot.action(/^page_/, cbPage);
  bot.action(/^start_test_/, cbStartTest);
  bot.action(/^mock_/, cbStartTest);
  bot.action(/^ugc_start_/, cbUgcStart);
  bot.action("room_ready", cbRoomReady);
  bot.action("room_start", cbRoomStart);
  bot.action("room_cancel", cbRoomCancel);
  bot.action("resume_test", cbResumeTest);
  bot.action("force_finish", cbForceFinish);
  bot.action("review_mistakes", cbReviewMistakes);
  bot.action("user_ready_start", cbUserReadyStart);
  bot.action("ai_explain_mistakes", cbAiExplainMistakes);
  bot.action("post_main", cbPostMain);
  bot.action(/^post_subj_/, cbPostSubj);
  bot.action(/^post_start_/, cbPostStart);
  bot.action(/^adaptive_/, cbAdaptiveTest);
  bot.action(/^adp_run_/, cbAdaptiveRun);
}

module.exports = {
  register,
  finishTest,
  sendNextQuestion,
  handlePollAnswer,
  showUgcSubjectBlocks,
  startUgcTest,
  resumeTestFromShelf,
  cbStopTest,
  cbReviewMistakes,
  cbAiExplainMistakes,
  cbAdaptiveTest,
  cbAdaptiveRun,
  questionTimeout,
};
