"use strict";

const { Markup } = require("telegraf");
const { SUBJECTS } = require("../config/config");
const dbService = require("../services/dbService");
const aiService = require("../services/aiService");
const sessionService = require("../services/sessionService");
const {
  getBlocksKeyboard,
  getMainKeyboard,
} = require("../keyboards/keyboards");
const {
  prepareShuffledQuestions,
  shuffleArray,
} = require("../core/questionUtils");
const {
  safeEdit,
  safeDelete,
  backToMainKb,
  parseSuffix,
  escapeHtml,
} = require("../core/utils");

const {
  sendNextQuestion,
  finishTest,
  handlePollAnswer,
  questionTimeout,
  lastMistakesCache,
  resolveTestName,
} = require("./coreQuiz");
const {
  initAndStartTest,
  sendWaitingRoomMessage,
  cbRoomReady,
  cbRoomStart,
  cbRoomCancel,
} = require("./groupQuizLogic");
const { cbAdaptiveTest, cbAdaptiveRun } = require("./adaptiveQuiz");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── OFFICIAL TEST SELECTION ─────────────────────────────────

async function cbOfficialTests(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const memDb = require("../core/bot").memoryDb;
  const buttons = Object.entries(SUBJECTS).map(([k, v]) => {
    const blocks = memDb[k] || {};
    const qCount = Object.values(blocks).reduce(
      (s, b) => s + (b.questions || []).length,
      0,
    );
    return [
      Markup.button.callback(
        `📘 ${v}  •  ${Object.keys(blocks).length} blok, ${qCount} savol`,
        `subj_${k}`,
      ),
    ];
  });
  buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
  await safeEdit(
    ctx,
    `📚 <b>Rasmiy Testlar</b>\n\nAdmin tomonidan tayyorlangan testlar.\nFan tanlang:`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
  );
}

async function cbSubject(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const subjectKey = parseSuffix(ctx.callbackQuery.data, "subj_");
  const subjName = escapeHtml(SUBJECTS[subjectKey] || "Fan");
  await safeEdit(
    ctx,
    `📚 <b>${subjName}</b>\n\nBlok tanlang yoki Mock Exam yechib ko'ring:`,
    { parse_mode: "HTML", ...getBlocksKeyboard(subjectKey, 0) },
  );
}

async function cbPage(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const parts = ctx.callbackQuery.data.split("_");
  const page = parseInt(parts[parts.length - 1], 10);
  const subjectKey = parts.slice(1, parts.length - 1).join("_");
  try {
    await ctx.editMessageReplyMarkup(
      getBlocksKeyboard(subjectKey, page).reply_markup,
    );
  } catch {
    /* no change */
  }
}

// ─── TEST START ENTRY POINTS ─────────────────────────────────

async function cbStartTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  const memDb = require("../core/bot").memoryDb;

  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing)
      return ctx.answerCbQuery(
        "⚠️ Bu chatda faol test bor! Avval to'xtating: /stop",
        { show_alert: true },
      ).catch(() => {});

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
        }).catch(() => {});
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
        return ctx.answerCbQuery("❌ Test topilmadi!", { show_alert: true }).catch(() => {});
    }

    await safeDelete(ctx);

    if (ctx.chat.type !== "private") {
      await sessionService.setWaitingRoom(chatId, {
        subjectKey,
        testId,
        testData,
        initiatorId: ctx.from.id,
        readyUsers: new Set(),
      });
      return sendWaitingRoomMessage(
        ctx,
        chatId,
        subjectKey,
        testId,
        testData.questions.length,
      );
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
  } catch (e) {
    console.error("cbStartTest error:", e.message);
  }
}

async function cbPostStart(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  const suffix = parseSuffix(ctx.callbackQuery.data, "post_start_");
  const parts = suffix.split("_");
  const testId = parseInt(parts[parts.length - 1], 10);
  const subjectKey = parts.slice(0, -1).join("_");

  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing)
      return ctx.answerCbQuery("⚠️ Avval joriy testni to'xtating: /stop", {
        show_alert: true,
      }).catch(() => {});

    const memDb = require("../core/bot").memoryDb || {};
    const testData = (memDb[subjectKey] || {})[testId];
    if (!testData)
      return ctx.answerCbQuery("❌ Test topilmadi!", { show_alert: true }).catch(() => {});

    try {
      await ctx.editMessageReplyMarkup({});
    } catch {
      /* silent */
    }

    if (ctx.chat.type !== "private") {
      await sessionService.setWaitingRoom(chatId, {
        subjectKey,
        testId,
        testData,
        initiatorId: ctx.from.id,
        readyUsers: new Set(),
      });
      return sendWaitingRoomMessage(
        ctx,
        chatId,
        subjectKey,
        testId,
        testData.questions.length,
      );
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
  } catch (e) {
    console.error("cbPostStart error:", e.message);
  }
}

// ─── UGC (USER-GENERATED TESTS) ──────────────────────────────

async function showUgcSubjectBlocks(ctx, creatorId, subject) {
  try {
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
      `📚 <b>${escapeHtml(subject)}</b>\n\n${subjTests.length} ta blok mavjud. Boshlash uchun blokni tanlang:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
    );
  } catch (e) {
    console.error("showUgcSubjectBlocks error:", e.message);
  }
}

async function startUgcTest(ctx, testDb) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing)
      return ctx.reply(
        "⚠️ Sizda allaqachon faol test bor! Avval uni yakunlang: /stop",
      );

    if (ctx.chat?.type !== "private") {
      await sessionService.setWaitingRoom(chatId, {
        subjectKey: testDb.subject,
        testId: `ugc_${testDb.id}`,
        testData: testDb,
        initiatorId: ctx.from.id,
        readyUsers: new Set(),
      });
      return sendWaitingRoomMessage(
        ctx,
        chatId,
        testDb.subject,
        `ugc_${testDb.id}`,
        testDb.questions?.length || 0,
      );
    }

    await initAndStartTest(
      chatId,
      ctx.telegram,
      testDb.subject,
      `ugc_${testDb.id}`,
      testDb,
      ctx.from.id,
      "private",
    );
  } catch (e) {
    console.error("startUgcTest error:", e.message);
  }
}

async function cbUgcStart(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const testId = parseSuffix(ctx.callbackQuery.data, "ugc_start_");
  try {
    const testDb = await dbService.getUserTest(testId);
    if (!testDb)
      return ctx.reply("❌ Test topilmadi yoki o'chirilgan.", backToMainKb());
    await safeDelete(ctx);
    await startUgcTest(ctx, testDb);
  } catch (e) {
    console.error("cbUgcStart error:", e.message);
  }
}

// ─── SESSION CONTROL ─────────────────────────────────────────

async function cbUserReadyStart(ctx) {
  const chatId = ctx.chat.id;
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session || session.status !== "preparing") {
      return ctx.answerCbQuery(
        "⚠️ Test topilmadi yoki allaqachon boshlangan!",
        { show_alert: true },
      ).catch(() => {});
    }
    if (session.initiatorId !== ctx.from.id) {
      return ctx.answerCbQuery("⚠️ Bu sizning testingiz emas!", {
        show_alert: true,
      }).catch(() => {});
    }

    await ctx.answerCbQuery().catch(() => {});
    session.status = "running";
    session.startTime = Date.now();
    await sessionService.setActiveTest(chatId, session);

    await safeEdit(ctx, "⏳ <b>Diqqat! Test boshlanmoqda...</b>\n\n<b>3️⃣</b>", {
      parse_mode: "HTML",
    });
    await wait(1000);
    await safeEdit(ctx, "⏳ <b>Diqqat! Test boshlanmoqda...</b>\n\n<b>2️⃣</b>", {
      parse_mode: "HTML",
    });
    await wait(1000);
    await safeEdit(ctx, "⏳ <b>Diqqat! Test boshlanmoqda...</b>\n\n<b>1️⃣</b>", {
      parse_mode: "HTML",
    });
    await wait(1000);
    await safeEdit(ctx, "🚀 <b>BOSHLADIK!</b> Omad yor bo'lsin! 🍀", {
      parse_mode: "HTML",
    });

    await sendNextQuestion(chatId, ctx.telegram);
  } catch (e) {
    console.error("cbUserReadyStart error:", e.message);
  }
}

async function cbResumeTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session)
      return ctx.answerCbQuery("❌ Test topilmadi.", { show_alert: true }).catch(() => {});
    session.consecutiveTimeouts = 0;
    await sessionService.setActiveTest(chatId, session);
    await safeDelete(ctx);
    await sendNextQuestion(chatId, ctx.telegram);
  } catch (e) {
    console.error("cbResumeTest error:", e.message);
  }
}

async function cbForceFinish(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await safeDelete(ctx);
  await finishTest(ctx.chat.id, ctx.telegram);
}

async function cbStopTest(ctx) {
  try {
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat?.id || ctx.from?.id;
    const session = await sessionService.getActiveTest(chatId);

    if (!session) {
      if (!ctx.callbackQuery) await safeDelete(ctx);
      return;
    }

    const tName = resolveTestName(session.testId, session.blockName);
    const { pendingShelfSaves } = require("../core/pendingStore");
    pendingShelfSaves.set(chatId, {
      testId: session.testId,
      testName: tName,
      subject: session.subjectKey,
      questions: session.sessionQuestions || [],
      progress: {
        current_index: session.qIdx || 0,
        correct: session.correct || 0,
        mistakes: session.mistakes || [],
      },
    });

    if (session.pollId)
      await sessionService.deletePollChat(session.pollId).catch(() => {});
    await sessionService.deleteActiveTest(chatId).catch(() => {});

    const text =
      `🛑 <b>Test to'xtatildi!</b>\n\n` +
      `Siz <b>${escapeHtml(tName)}</b> testini <b>${session.qIdx}-savolida</b> to'xtatdingiz.\n\n` +
      `Javonga saqlab, keyinroq davom ettirish mumkin.`;

    const buttons = [
      [Markup.button.callback("📥 Javonga saqlash (Pauza)", "shelf_save_init")],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ];

    if (ctx.callbackQuery) {
      await safeEdit(ctx, text, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(buttons),
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(buttons),
      });
    }
  } catch (e) {
    console.error("To'xtatishda xato:", e.message);
  }
}

// ─── POST-TEST ACTIONS ────────────────────────────────────────

async function cbReviewMistakes(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const mistakes = await lastMistakesCache.get(ctx.chat.id) || [];
  if (!mistakes.length)
    return ctx.answerCbQuery("🎉 Bu testda xato yo'q edi!", {
      show_alert: true,
    }).catch(() => {});

  const parts = [`📑 <b>So'nggi testdagi xatolar (${mistakes.length} ta):</b>`];
  for (let i = 0; i < Math.min(mistakes.length, 20); i++) {
    parts.push(
      `<b>${i + 1}.</b> ${escapeHtml(mistakes[i].question)}\n` +
        `❌ ${escapeHtml(mistakes[i].wrong_ans)}\n` +
        `✅ ${escapeHtml(mistakes[i].correct_ans)}`,
    );
  }
  if (mistakes.length > 20)
    parts.push(`<i>...va yana ${mistakes.length - 20} ta xato</i>`);

  await safeEdit(ctx, parts.join("\n\n"), {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🤖 AI Tutor: Xatolarni tahlil qilish",
          "ai_explain_mistakes",
        ),
      ],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]),
  });
}

async function cbAiExplainMistakes(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const mistakes = await lastMistakesCache.get(ctx.chat.id) || [];
  if (!mistakes.length)
    return ctx.answerCbQuery("Xatolar topilmadi!", { show_alert: true }).catch(() => {});

  await safeEdit(
    ctx,
    "🤖 <i>AI Tutor xatolaringizni tahlil qilmoqda... Iltimos, bir oz kuting</i> ⏳",
    { parse_mode: "HTML" },
  );

  try {
    const explanation = await aiService.explainMistakesBatch(mistakes);
    await safeEdit(ctx, `🤖 <b>AI Tutor Tahlili:</b>\n\n${explanation}`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
      ]),
    });
  } catch (e) {
    console.error("cbAiExplainMistakes error:", e.message);
    await safeEdit(ctx, "❌ AI tahlilida xatolik yuz berdi.", backToMainKb());
  }
}

async function cbPostMain(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  try {
    await ctx.editMessageReplyMarkup({});
  } catch {
    /* silent */
  }
  await ctx.reply("🏛 <b>Asosiy Menyu</b>", {
    parse_mode: "HTML",
    ...getMainKeyboard(),
  });
}

async function cbPostSubj(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const subjectKey = parseSuffix(ctx.callbackQuery.data, "post_subj_");
  try {
    await ctx.editMessageReplyMarkup({});
  } catch {
    /* silent */
  }
  await ctx.reply(
    `📚 <b>${escapeHtml(SUBJECTS[subjectKey] || "Fan")}</b>\n\nBlokni tanlang:`,
    { parse_mode: "HTML", ...getBlocksKeyboard(subjectKey, 0) },
  );
}

// ─── SHELF RESUME ─────────────────────────────────────────────

async function resumeTestFromShelf(ctx, savedTest) {
  const chatId = ctx.chat.id;
  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing)
      return ctx.reply(
        "⚠️ Sizda allaqachon faol test bor! Avval uni yakunlang: /stop",
      );

    await safeDelete(ctx);
    const prog = savedTest.progress || {
      current_index: 0,
      correct: 0,
      mistakes: [],
    };
    await sessionService.setActiveTest(chatId, {
      chatType: "private",
      initiatorId: ctx.from.id,
      subjectKey: savedTest.subject,
      testId: savedTest.testId,
      blockName: savedTest.testName,
      sessionQuestions: savedTest.questions,
      qIdx: prog.current_index || 0,
      startTime: Date.now(),
      pollId: null,
      msgId: null,
      correct: prog.correct || 0,
      wrong: (prog.mistakes || []).length,
      mistakes: prog.mistakes || [],
      consecutiveTimeouts: 0,
      groupScores: {},
      finished: false,
      status: "running",
    });

    const startLabel =
      prog.current_index > 0
        ? `<b>${prog.current_index + 1}-savoldan davom etamiz!</b>`
        : "<b>Test boshlanmoqda!</b>";

    await ctx.telegram.sendMessage(
      chatId,
      `🚀 <b>Javondagi test yuklandi</b>\n\n` +
        `📚 Fan: ${escapeHtml(savedTest.subject)}\n` +
        `📝 Test: ${escapeHtml(savedTest.testName)}\n\n` +
        `${startLabel}`,
      { parse_mode: "HTML" },
    );

    await wait(1500);
    await sendNextQuestion(chatId, ctx.telegram);
  } catch (e) {
    console.error("resumeTestFromShelf error:", e.message);
  }
}

// ─── REGISTER ────────────────────────────────────────────────

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
  bot.action("user_ready_start", cbUserReadyStart);
  bot.action("resume_test", cbResumeTest);
  bot.action("force_finish", cbForceFinish);
  bot.action("review_mistakes", cbReviewMistakes);
  bot.action("ai_explain_mistakes", cbAiExplainMistakes);
  bot.action("post_main", cbPostMain);
  bot.action(/^post_subj_/, cbPostSubj);
  bot.action(/^post_start_/, cbPostStart);
  bot.action(/^adaptive_/, cbAdaptiveTest);
  bot.action(/^adp_run_/, cbAdaptiveRun);
}

module.exports = {
  register,
  // Backward-compatible re-exports for workers.js / index.js
  finishTest,
  handlePollAnswer,
  questionTimeout,
  cbStopTest,
  cbReviewMistakes,
  cbAiExplainMistakes,
  cbAdaptiveTest,
  cbAdaptiveRun,
  showUgcSubjectBlocks,
  startUgcTest,
  resumeTestFromShelf,
  sendNextQuestion,
};
