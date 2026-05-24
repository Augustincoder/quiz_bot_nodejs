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
  safeAnswerCb,
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
  cbRoomReady,
  cbRoomStart,
  cbRoomCancel,
  cbRoomNextBlock,
} = require("./groupQuizLogic");
const { cbAdaptiveTest, cbAdaptiveRun } = require("./adaptiveQuiz");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── OFFICIAL TEST SELECTION ─────────────────────────────────

async function cbOfficialTests(ctx) {
  await safeAnswerCb(ctx);
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
    `📚 <b>Rasmiy Test Bazasi</b>\n\nProfessional tarzda tayyorlangan rasmiy test bloklari. Fan tanlang va bilimingizni sinab ko'ring!\n\n💡 <i>Har bir fanda Adaptiv test va Aralash (Mock Exam) rejimi mavjud.</i>`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
  );
}
async function sendWaitingRoomMessage(ctx, chatId, subjectKey, testId, qCount) {
  const room = await sessionService.getWaitingRoom(chatId);
  const users = Array.from(room.readyUsers || []);
  const text =
    `🎯 <b>Kutish Zali</b>\n\n` +
    `📚 Fan: <b>${subjectKey}</b>\n` +
    `🔢 Savollar: <b>${qCount} ta</b>\n\n` +
    `👥 Qatnashchilar: ${users.length}\n` +
    (users.length
      ? users.map((u, i) => `${i + 1}. ${u.name || "Foydalanuvchi"}`).join("\n")
      : "<i>Hali hech kim yo'q</i>");

  const buttons = [
    [Markup.button.callback("✋ Men ham qatnashaman", "room_ready")],
    [
      Markup.button.callback("▶️ Boshlash", "room_start"),
      Markup.button.callback("❌ Bekor qilish", "room_cancel"),
    ],
  ];

  await ctx.telegram.sendMessage(chatId, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
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
  const sessionQ = prepareShuffledQuestions(testData.questions || []);
  const subjName = SUBJECTS[subjectKey] || subjectKey;
  const blockName =
    testData.block_name ||
    (String(testId).startsWith("ugc_") ? "Maxsus Test" : `${testId}-Blok`);

  await sessionService.setActiveTest(chatId, {
    chatType,
    initiatorId,
    subjectKey,
    testId,
    blockName: blockName,
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

  if (chatType === "private") {
    const text = `📚 <b>Fan:</b> ${escapeHtml(subjName)}\n🔖 <b>Blok:</b> ${escapeHtml(blockName)}\n🔢 <b>Savollar:</b> ${sessionQ.length} ta\n\n🚀 <b>Testga tayyormisiz?</b>\nBoshlash uchun pastdagi tugmani bosing!`;

    await telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "▶️ Boshlash", callback_data: "user_ready_start" }],
        ],
      },
    });
  } else {
    // Guruh uchun darhol boshlash
    const session = await sessionService.getActiveTest(chatId);
    session.status = "running";
    session.startTime = Date.now();
    await sessionService.setActiveTest(chatId, session);
    await sendNextQuestion(chatId, telegram);
  }
}
async function cbSubject(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const subjectKey = parseSuffix(ctx.callbackQuery.data, "subj_");
  const subjName = escapeHtml(SUBJECTS[subjectKey] || "Fan");
  const botInfo = await ctx.telegram.getMe(); // Bot usernamesini olamiz

  // Asosiy tugmalar (Bloklar) ni olamiz
  const blocksKb = getBlocksKeyboard(subjectKey, 0);

  // Eng tepasiga "Guruhda Marafon o'ynash" tugmasini qo'shamiz
  blocksKb.reply_markup.inline_keyboard.unshift([
    Markup.button.url(
      "🏃 Butun fanni Guruhda o'ynash (Marafon)",
      `https://t.me/${botInfo.username}?startgroup=offs_${subjectKey}`,
    ),
  ]);

  await safeEdit(
    ctx,
    `📚 <b>${subjName}</b>\n\nQuyidagi blokdan birini tanlang yoki maxsus rejimlardan foydalaning:`,
    { parse_mode: "HTML", ...blocksKb },
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
      return ctx
        .answerCbQuery(
          "⚠️ Hozirda faol test mavjud. Avval uni yakunlang yoki /stop buyrug'i bilan to'xtating.",
          { show_alert: true },
        )
        .catch(() => {});

    const isMock = ctx.callbackQuery.data.startsWith("mock_");
    let subjectKey, testId, testData;

    if (isMock) {
      subjectKey = parseSuffix(ctx.callbackQuery.data, "mock_");
      const allQs = Object.values(memDb[subjectKey] || {}).flatMap(
        (t) => t.questions || [],
      );
      if (!allQs.length)
        return ctx
          .answerCbQuery("❌ Bu fanda savollar yo'q!", {
            show_alert: true,
          })
          .catch(() => {});
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
        return ctx
          .answerCbQuery("❌ Test topilmadi!", { show_alert: true })
          .catch(() => {});
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
      return ctx
        .answerCbQuery(
          "⚠️ Hozirda faol test mavjud. Avval uni yakunlang yoki /stop buyrug'i bilan to'xtating.",
          {
            show_alert: true,
          },
        )
        .catch(() => {});

    const memDb = require("../core/bot").memoryDb || {};
    const testData = (memDb[subjectKey] || {})[testId];
    if (!testData)
      return ctx
        .answerCbQuery("❌ Test topilmadi!", { show_alert: true })
        .catch(() => {});

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
        "⚠️ Sizda hozirda faol test mavjud. Avval uni yakunlang yoki /stop bilan to'xtating.",
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
      return ctx
        .answerCbQuery("⚠️ Test topilmadi yoki allaqachon boshlangan!", {
          show_alert: true,
        })
        .catch(() => {});
    }
    if (session.initiatorId !== ctx.from.id) {
      return ctx
        .answerCbQuery("⚠️ Bu sizning testingiz emas!", {
          show_alert: true,
        })
        .catch(() => {});
    }

    await ctx.answerCbQuery().catch(() => {});
    session.status = "running";
    session.startTime = Date.now();
    await sessionService.setActiveTest(chatId, session);

    // Fan va blok nomini olish
    const subjName = SUBJECTS[session.subjectKey] || session.subjectKey;
    const blockName = session.blockName || "Test";
    const header = `📚 <b>Fan:</b> ${escapeHtml(subjName)}\n🔖 <b>Blok:</b> ${escapeHtml(blockName)}\n\n`;

    await safeEdit(
      ctx,
      header + "⏳ <b>Diqqat! Test boshlanmoqda...</b>\n\n<b>3️⃣</b>",
      {
        parse_mode: "HTML",
      },
    );
    await wait(1000);
    await safeEdit(
      ctx,
      header + "⏳ <b>Diqqat! Test boshlanmoqda...</b>\n\n<b>2️⃣</b>",
      {
        parse_mode: "HTML",
      },
    );
    await wait(1000);
    await safeEdit(
      ctx,
      header + "⏳ <b>Diqqat! Test boshlanmoqda...</b>\n\n<b>1️⃣</b>",
      {
        parse_mode: "HTML",
      },
    );
    await wait(1000);
    await safeEdit(
      ctx,
      header +
        "🚀 <b>Kamarlarni taqing! BOSHLADIK!</b> Omad yor bo'lsin, muvaffaqiyat sizga! 🍀",
      {
        parse_mode: "HTML",
      },
    );

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
      return ctx
        .answerCbQuery("❌ Test topilmadi.", { show_alert: true })
        .catch(() => {});
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
    const isGroup = ctx.chat?.type !== "private"; // Guruhni aniqlaymiz

    if (!session) {
      if (!ctx.callbackQuery) await safeDelete(ctx);
      return;
    }

    // GURUH UCHUN: Shunchaki to'xtatib, Reyting (finishTest) ni chaqiramiz
    if (isGroup) {
      if (!ctx.callbackQuery) {
        await ctx.reply(
          "🛑 <b>O'yin muddatidan oldin to'xtatildi!</b> Natijalar hisoblanmoqda...",
          { parse_mode: "HTML" },
        );
      } else {
        await safeDelete(ctx);
        await ctx.telegram.sendMessage(
          chatId,
          "🛑 <b>O'yin muddatidan oldin to'xtatildi!</b> Natijalar hisoblanmoqda...",
          { parse_mode: "HTML" },
        );
      }
      const { finishTest } = require("./coreQuiz");
      return finishTest(chatId, ctx.telegram);
    }

    // SHAXSIY CHAT UCHUN: (Eski mantiq)
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
      `🛑 <b>Test to'xtatildi</b>\n\n` +
      `📝 Test: <b>${escapeHtml(tName)}</b>\n` +
      `📊 Holat: <b>${session.qIdx}</b>-savolda to'xtatildi\n` +
      `✅ To'g'ri: <b>${session.correct || 0}</b>  ❌ Xato: <b>${(session.mistakes || []).length}</b>`;

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

// ─── POST-TEST ACTIONS (ERROR REVIEW & AI TUTOR) ──────────────

async function cbReviewMistakes(ctx) {
  await ctx.answerCbQuery().catch(() => {});

  // Sahifani aniqlash (Default: 0)
  let page = 0;
  if (ctx.callbackQuery.data.startsWith("review_mistakes_")) {
    page = parseInt(ctx.callbackQuery.data.replace("review_mistakes_", ""), 10);
  }

  const mistakes = (await lastMistakesCache.get(ctx.chat.id)) || [];
  if (!mistakes.length) {
    return ctx
      .answerCbQuery("🎉 Bu testda xato yo'q edi!", { show_alert: true })
      .catch(() => {});
  }

  const ITEMS_PER_PAGE = 5; // Bitta sahifada 5 ta xato ko'rinadi
  const totalPages = Math.ceil(mistakes.length / ITEMS_PER_PAGE);
  const validPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = validPage * ITEMS_PER_PAGE;
  const currentMistakes = mistakes.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const parts = [
    `📑 <b>Xatolar Tahlili</b> — <i>${mistakes.length} ta xato topildi</i>\n` +
      `_Sahifa: ${validPage + 1} / ${totalPages}_\n`,
  ];

  currentMistakes.forEach((m, i) => {
    parts.push(
      `<b>${startIdx + i + 1}.</b> ${escapeHtml(m.question)}\n` +
        `❌ <i>Sizning javob: ${escapeHtml(m.wrong_ans)}</i>\n` +
        `✅ <b>To'g'ri javob: ${escapeHtml(m.correct_ans)}</b>`,
    );
  });

  const navRow = [];
  if (validPage > 0)
    navRow.push(
      Markup.button.callback(
        "⬅️ Oldingi 5 ta",
        `review_mistakes_${validPage - 1}`,
      ),
    );
  if (validPage < totalPages - 1)
    navRow.push(
      Markup.button.callback(
        "Keyingi 5 ta ➡️",
        `review_mistakes_${validPage + 1}`,
      ),
    );

  const buttons = [];
  if (navRow.length > 0) buttons.push(navRow);

  // AI faqat shu sahifadagi 5 ta xatoni tahlil qiladi (Token va kutish vaqti tejaladi)
  buttons.push([
    Markup.button.callback(
      "🤖 AI Tutor: Shu 5 ta xatoni tahlil qilish",
      `ai_explain_mistakes_${validPage}`,
    ),
  ]);

  buttons.push([Markup.button.callback("🔙 Asosiy Menyu", "post_main")]);

  await safeEdit(ctx, parts.join("\n\n"), {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

// AI Tutor Endi faqat kerakli sahifani tahlil qiladi
async function cbAiExplainMistakes(ctx) {
  await ctx.answerCbQuery().catch(() => {});

  let page = 0;
  if (ctx.callbackQuery.data.startsWith("ai_explain_mistakes_")) {
    page = parseInt(
      ctx.callbackQuery.data.replace("ai_explain_mistakes_", ""),
      10,
    );
  }

  const mistakes = (await lastMistakesCache.get(ctx.chat.id)) || [];
  if (!mistakes.length) return;

  const startIdx = page * 5;
  const currentMistakes = mistakes.slice(startIdx, startIdx + 5); // Faqat hozirgi sahifadagi 5 ta xato

  await safeEdit(
    ctx,
    `🧠 <i>AI Tutor hozirgi sahifadagi ${currentMistakes.length} ta xatolaringizni tahlil qilmoqda...</i>\n\n⏳ <i>Iltimos, kuting.</i>`,
    { parse_mode: "HTML" },
  );

  try {
    const explanation = await aiService.explainMistakesBatch(currentMistakes);

    await safeEdit(
      ctx,
      `🤖 <b>AI Tutor Tahlili (Sahifa: ${page + 1}):</b>\n\n${explanation}`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔙 Xatolarga qaytish",
              `review_mistakes_${page}`,
            ),
          ], // Tahlildan so'ng yana shu xatolar sahifasiga qaytish
          [Markup.button.callback("🏠 Asosiy Menyu", "post_main")],
        ]),
      },
    );
  } catch (e) {
    console.error("cbAiExplainMistakes error:", e.message);
    await safeEdit(
      ctx,
      "⚠️ AI tahlilida kutilmagan xatolik yuz berdi.\n\nIltimos, bir ozdan so'ng qaytadan urinib ko'ring.",
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔙 Xatolarga qaytish",
            `review_mistakes_${page}`,
          ),
        ],
      ]),
    );
  }
}

async function cbPostMain(ctx) {
  await safeAnswerCb(ctx);
  await safeEdit(
    ctx,
    "🏛 <b>Asosiy Menyu</b>\n\nQuyidagi bo'limlardan birini tanlang:",
    {
      parse_mode: "HTML",
      ...getMainKeyboard(),
    },
  );
}

async function cbPostSubj(ctx) {
  await safeAnswerCb(ctx);
  const subjectKey = parseSuffix(ctx.callbackQuery.data, "post_subj_");
  await safeEdit(
    ctx,
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
        "⚠️ Sizda hozirda faol test mavjud. Avval uni yakunlang yoki /stop bilan to'xtating.",
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
      `📥 <b>Javondan test yuklandi!</b>\n\n` +
        `📚 Fan: <b>${escapeHtml(savedTest.subject)}</b>\n` +
        `📝 Test: <b>${escapeHtml(savedTest.testName)}</b>\n\n` +
        `${startLabel}\n\n💡 <i>Oldingi natijalaringiz saqlanib qolgan.</i>`,
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

  bot.action(/^review_mistakes/, cbReviewMistakes);
  bot.action(/^ai_explain_mistakes/, cbAiExplainMistakes);

  bot.action("post_main", cbPostMain);
  bot.action(/^post_subj_/, cbPostSubj);
  bot.action(/^post_start_/, cbPostStart);
  bot.action(/^adaptive_/, cbAdaptiveTest);
  bot.action(/^adp_run_/, cbAdaptiveRun);
  bot.action("room_next_block", cbRoomNextBlock);
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
