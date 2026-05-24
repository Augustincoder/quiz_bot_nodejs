"use strict";
const redisConnection = require("../services/redisService");
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
    if (existing) {
      await ctx
        .answerCbQuery("⚠️ Faol test mavjud!", { show_alert: false })
        .catch(() => {});
      return ctx.reply(
        "⚠️ <b>Sizda tugallanmagan (yoki qotib qolgan) test bor.</b>\n\nYangi test boshlashdan oldin uni to'xtatishingiz kerak:",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "🛑 Faol testni to'xtatish",
                "force_finish",
              ),
            ],
          ]),
        },
      );
    }
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

// ─── TESTNI TO'XTATISH VA JAVONGA YO'NALTIRISH ─────────────
// ─── 1. PAUZA MENYUSI (/stop Yoki To'xtatish bosilganda) ─────────────
async function cbStopTest(ctx) {
  const isCb = !!ctx.callbackQuery;
  if (isCb) await ctx.answerCbQuery("⏸ Pauza...").catch(() => {});
  const chatId = ctx.chat.id;

  const session = await sessionService.getActiveTest(chatId);
  if (!session) {
    const msg = "⚠️ Faol test topilmadi yoki allaqachon yakunlangan.";
    const kbd = {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
      ]),
    };
    return isCb ? safeEdit(ctx, msg, kbd) : ctx.reply(msg, kbd);
  }

  const total = session.sessionQuestions ? session.sessionQuestions.length : 0;
  const answered = session.qIdx || 0;

  const text =
    `⏸ <b>Test to'xtatib turildi (Pauza)!</b>\n\n` +
    `📊 <b>Hozirgi holat:</b>\n` +
    `Jami savollar: ${total} ta\n` +
    `Ishlandi: ${answered} ta\n` +
    `To'g'ri: ${session.correct || 0} ta\n\n` +
    `<i>Nima qilamiz? Quyidagilardan birini tanlang:</i>`;

  const buttons = [
    [Markup.button.callback("▶️ Davom etish", "pause_resume")],
    [
      Markup.button.callback(
        "🏁 Hozirgi natija bilan yakunlash",
        "pause_finish",
      ),
    ],
    [
      Markup.button.callback(
        "📥 Javonga saqlash (Keyin davom etish)",
        "pause_shelf",
      ),
    ],
    [Markup.button.callback("🗑 Butunlay bekor qilish", "force_finish")],
  ];

  if (isCb) {
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
}

// ─── 2. DAVOM ETISH (Resume) ─────────────
async function cbPauseResume(ctx) {
  await ctx.answerCbQuery("▶️ Test davom etmoqda...").catch(() => {});
  await safeDelete(ctx); // Pauza menyusini o'chiramiz
  await ctx.reply(
    "▶️ <b>Test davom etmoqda!</b>\n\n<i>Iltimos, yuqoridagi oxirgi faol savolga (so'rovnomaga) javob bering.</i>",
    { parse_mode: "HTML" },
  );
}

// ─── 3. SHU YERDA YAKUNLASH VA NATIJANI KO'RISH (Finish) ─────────────
async function cbPauseFinish(ctx) {
  await ctx.answerCbQuery("🏁 Yakunlanmoqda...").catch(() => {});
  await safeDelete(ctx); // Pauza menyusini o'chiramiz

  // Asosiy dvijokdagi yakunlash funksiyasini chaqiramiz
  const { finishTest } = require("./coreQuiz");
  await finishTest(ctx.chat.id, ctx.telegram);
}

// ─── 4. JAVONGA SAQLASH UCHUN TAYYORLASH (Shelf) ─────────────
async function cbPauseShelf(ctx) {
  await ctx.answerCbQuery("📥 Javon uchun tayyorlanmoqda...").catch(() => {});
  const chatId = ctx.chat.id;
  const session = await sessionService.getActiveTest(chatId);

  if (!session) return safeEdit(ctx, "⚠️ Faol test topilmadi.");

  // Chala qolgan ma'lumotlarni yig'amiz
  const shelfData = {
    testId: session.testId,
    testName: session.blockName || "Noma'lum blok",
    subject: session.subjectKey || "Noma'lum fan",
    questions: session.sessionQuestions || [],
    progress: {
      current_index: session.qIdx || 0,
      correct: session.correct || 0,
      mistakes: session.mistakes || [],
    },
  };

  // 1. Redisga xavfsiz saqlaymiz (Oldingi qadamda qilgan himoyamiz)
  // const redisConnection = require("../services/redisService");
  await redisConnection
    .set(`shelf_pending:${chatId}`, JSON.stringify(shelfData), "EX", 86400)
    .catch(() => {});

  // 2. Faol testni tozalaymiz
  if (session.pollId)
    await sessionService.deletePollChat(session.pollId).catch(() => {});
  await sessionService.deleteActiveTest(chatId).catch(() => {});

  await safeEdit(
    ctx,
    `🛑 <b>Test to'xtatildi va Javon uchun tayyorlandi!</b>\n\nSiz testni oxirigacha ishlashni xohlamadingiz. Pastdagi tugmani bosib uni shaxsiy javoningizga saqlab qo'ying.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📥 Tasdiqlash va Javonga saqlash",
            "shelf_save_init",
          ),
        ],
        [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
      ]),
    },
  );
}

// ─── POST-TEST ACTIONS (ERROR REVIEW & MASTERY) ──────────────

async function cbReviewMistakes(ctx) {
  await ctx.answerCbQuery().catch(() => {});

  let page = 0;
  // Regex orqali page ni xavfsiz ajratib olamiz
  const match = ctx.callbackQuery.data.match(/review_mistakes_(\d+)/);
  if (match) page = parseInt(match[1], 10);

  const mistakes = (await lastMistakesCache.get(ctx.chat.id)) || [];
  if (!mistakes.length) {
    return ctx
      .answerCbQuery("🎉 Bu testda xato yo'q edi!", { show_alert: true })
      .catch(() => {});
  }

  const ITEMS_PER_PAGE = 5;
  const totalPages = Math.ceil(mistakes.length / ITEMS_PER_PAGE);
  const validPage = Math.max(0, Math.min(page, totalPages - 1));
  const startIdx = validPage * ITEMS_PER_PAGE;
  const currentMistakes = mistakes.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  const parts = [
    `📑 <b>Xatolar Tahlili</b> — <i>${mistakes.length} ta xato topildi</i>\n_Sahifa: ${validPage + 1} / ${totalPages}_\n`,
  ];

  currentMistakes.forEach((m, i) => {
    parts.push(
      `<b>${startIdx + i + 1}.</b> ${escapeHtml(String(m.question || "Savol matni yo'q"))}\n` +
        `❌ <i>Sizning javob: ${escapeHtml(String(m.wrong_ans || "-"))}</i>\n` +
        `✅ <b>To'g'ri javob: ${escapeHtml(String(m.correct_ans || "-"))}</b>`,
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
  buttons.push([
    Markup.button.callback(
      "🤖 AI Tutor: Shu 5 ta xatoni tahlil qilish",
      `ai_explain_mistakes_${validPage}`,
    ),
  ]);
  buttons.push([Markup.button.callback("🔙 Natijaga qaytish", "post_main")]);

  await safeEdit(ctx, parts.join("\n\n"), {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

const wmCache = {
  set: async (chatId, data) =>
    await redisConnection.set(
      `wm_state:${chatId}`,
      JSON.stringify(data),
      "EX",
      3600,
    ),
  get: async (chatId) => {
    const d = await redisConnection.get(`wm_state:${chatId}`);
    return d ? JSON.parse(d) : null;
  },
  del: async (chatId) => await redisConnection.del(`wm_state:${chatId}`),
};
// ─── ERROR MASTERY (XATOLAR USTIDA ISHLASH) ───────────────────

// 1. Format tanlash menyusi
async function cbWorkMistakesMenu(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});

    // 🤖 Fanni ajratib olamiz
    const subjectKey = ctx.callbackQuery.data.replace("wm_menu_", "");

    const mistakes = (await lastMistakesCache.get(ctx.chat.id)) || [];
    if (!mistakes || mistakes.length === 0)
      return ctx
        .answerCbQuery("🎉 Xatolar topilmadi!", { show_alert: true })
        .catch(() => {});

    await safeEdit(
      ctx,
      `🔄 <b>Xatolar ustida ishlash</b>\n\nSizda jami <b>${mistakes.length} ta</b> xato bor. Qaysi usulda qayta ishlamoqchisiz?`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🕹 Interaktiv Rejim",
              `wm_start_inline_${subjectKey}`,
            ),
          ],
          [
            Markup.button.callback(
              "📊 Klassik Quiz",
              `wm_start_quiz_${subjectKey}`,
            ),
          ],
          [
            Markup.button.callback(
              "🔙 Fan menyusiga",
              `post_subj_${subjectKey}`,
            ),
          ], // <-- Asosiy emas, Fanga qaytadi!
        ]),
      },
    );
  } catch (error) {
    console.error(`[wm_menu xatosi]:`, error);
  }
}
// 2. Klassik Quizni boshlash (Bor test tizimidan qayta foydalanish)
async function cbWmStartQuiz(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  const subjectKey = ctx.callbackQuery.data.replace("wm_start_quiz_", ""); // 🤖 Fanni ajratamiz

  const mistakes = (await lastMistakesCache.get(chatId)) || [];
  if (!mistakes.length) return;

  await safeDelete(ctx);
  const testData = {
    block_name: "Xatolar ustida ishlash",
    questions: mistakes,
  };

  const { initAndStartTest } = require("./coreQuiz");
  // "mistakes_subject" degan mavhum fan o'rniga, asl fanni beramiz!
  await initAndStartTest(
    chatId,
    ctx.telegram,
    subjectKey,
    "retry",
    testData,
    ctx.from.id,
    "private",
  );
}

// 3. Interaktiv Rejimni (Kardochkalar) boshlash
async function cbWmStartInline(ctx) {
  try {
    await ctx
      .answerCbQuery("⏳ Interaktiv rejim yuklanmoqda...")
      .catch(() => {});
    const chatId = ctx.chat.id;

    // 🤖 Fanni ajratamiz
    const subjectKey = ctx.callbackQuery.data.replace("wm_start_inline_", "");

    const mistakes = (await lastMistakesCache.get(chatId)) || [];
    if (!mistakes || mistakes.length === 0) return;

    const stateData = {
      queue: [...mistakes],
      total: mistakes.length,
      startTime: Date.now(),
      subjectKey: subjectKey, // <-- Fanni Interaktiv xotiraga yozib qo'yamiz!
    };

    const redisConnection = require("../services/redisService");
    await redisConnection.set(
      `wm_state:${chatId}`,
      JSON.stringify(stateData),
      "EX",
      3600,
    );

    await sendNextInlineMistake(ctx);
  } catch (error) {
    console.error(`[cbWmStartInline Xatosi]:`, error);
  }
}
// Interaktiv o'yin jarayoni
// Interaktiv savolni ekranga chiqarish (HIMOYALANGAN VA DINAMIK MARSHRUTLI)
async function sendNextInlineMistake(ctx) {
  try {
    const chatId = ctx.chat.id;
    const redisConnection = require("../services/redisService");

    // Redisdan ishonchli tarzda o'qiymiz
    const rawState = await redisConnection.get(`wm_state:${chatId}`);
    if (!rawState) {
      return ctx.reply(
        "⚠️ Sessiya eskirgan yoki topilmadi. Qaytadan boshlang.",
      );
    }

    const state = JSON.parse(rawState);
    const queue = state.queue || [];

    // 🤖 Qaysi fanga qaytishni aniqlaymiz
    const subjKey = state.subjectKey || "main";
    const backAction =
      subjKey !== "main" ? `post_subj_${subjKey}` : "back_to_main";

    // 🏆 G'alaba ekrani
    if (queue.length === 0) {
      await redisConnection.del(`wm_state:${chatId}`);
      return safeEdit(
        ctx,
        `🎉 <b>Tabriklaymiz! Barcha xatolarni yengdingiz!</b>\n\nSiz <b>${state.total} ta</b> xatoning barchasini qayta ishlab, to'g'ri javoblarni o'zlashtirdingiz! 🧠💪`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Fan menyusiga qaytish", backAction)],
          ]),
        },
      );
    }

    // 🎯 Navbatdagi savolni olamiz
    const q = queue[0];
    const qText = q.question || "Savol matni yo'q";

    // Variantlarni xavfsiz tiklash
    let options = q.options;
    let correctIdx = q.correct_index;

    if (!options || options.length === 0) {
      options = [String(q.correct_ans), String(q.wrong_ans)];
      // Aralashtirish (Shuffle)
      options.sort(() => Math.random() - 0.5);
      correctIdx = options.indexOf(String(q.correct_ans));
    }

    // Taymerni yangilab saqlaymiz (15 soniya shundan boshlab hisoblanadi)
    state.startTime = Date.now();
    await redisConnection.set(
      `wm_state:${chatId}`,
      JSON.stringify(state),
      "EX",
      3600,
    );

    // Ekranga chiziladigan matn
    let text =
      `🎯 <b>Xatolar ustida ishlash</b> (Qoldi: ${queue.length} ta)\n` +
      `⏱ <i>Vaqt limiti: 15 soniya</i>\n━━━━━━━━━━━━━━━━\n` +
      `<b>Savol:</b>\n${escapeHtml(String(qText))}\n\n`;

    const buttons = [];
    const labels = ["A", "B", "C", "D", "E", "F", "G", "H"];
    let row = [];

    // Tugmalarni yasash (Har qatorda 2 tadan)
    options.forEach((opt, i) => {
      const isCorrect = i === correctIdx;
      text += `<b>${labels[i]})</b> ${escapeHtml(String(opt))}\n`;
      row.push(
        Markup.button.callback(`${labels[i]}`, `wm_ans_${isCorrect ? 1 : 0}`),
      );

      if (row.length === 2 || i === options.length - 1) {
        buttons.push(row);
        row = [];
      }
    });

    // 🛑 To'xtatish tugmasi (U ham dinamik marshrut bilan Fanga qaytadi)
    buttons.push([Markup.button.callback("🛑 To'xtatish", backAction)]);

    // Ekran holatiga qarab xavfsiz jo'natish
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
  } catch (error) {
    console.error(
      `[sendNextInlineMistake Xatosi - Chat: ${ctx.chat.id}]:`,
      error,
    );
    await ctx
      .answerCbQuery("❌ Savolni chiqarishda xato yuz berdi!", {
        show_alert: true,
      })
      .catch(() => {});
  }
}

// Interaktiv javobni tekshirish (HIMOYALANGAN)
async function cbWmAns(ctx) {
  try {
    const chatId = ctx.chat.id;

    // Redisdan o'qiymiz
    const rawState = await redisConnection.get(`wm_state:${chatId}`);
    if (!rawState) {
      return ctx
        .answerCbQuery(
          "⚠️ Sessiya eskirgan yoki o'yin yakunlangan. Qayta boshlang.",
          { show_alert: true },
        )
        .catch(() => {});
    }

    const state = JSON.parse(rawState);
    const queue = state.queue || [];
    if (!queue.length) return ctx.answerCbQuery().catch(() => {});

    const isCorrect = parseSuffix(ctx.callbackQuery.data, "wm_ans_") === "1";
    const q = queue.shift();

    // Taymer tekshiruvi (15 soniya)
    const elapsed = Date.now() - (state.startTime || Date.now());
    const isTimeout = elapsed > 15000;

    if (isCorrect && !isTimeout) {
      await ctx.answerCbQuery("✅ Ajoyib! To'g'ri.").catch(() => {});
      // Holatni yangilab saqlaymiz
      await redisConnection.set(
        `wm_state:${chatId}`,
        JSON.stringify(state),
        "EX",
        3600,
      );
      return sendNextInlineMistake(ctx);
    } else {
      // Xato yoki Taymer tugagan bo'lsa
      queue.push(q);
      await redisConnection.set(
        `wm_state:${chatId}`,
        JSON.stringify(state),
        "EX",
        3600,
      );

      const correctText =
        q.correct_ans || (q.options ? q.options[q.correct_index] : "Noma'lum");
      const failMsg = isTimeout
        ? `⏳ <b>Vaqt tugadi!</b> (15 soniyadan o'tib ketdi)`
        : `❌ <b>Yana xato qildingiz!</b>`;

      await safeEdit(
        ctx,
        `${failMsg}\n\nTo'g'ri javob:\n<b>✅ ${escapeHtml(String(correctText))}</b>\n\n<i>Bu savol ro'yxat oxiriga tushdi, uni to'g'ri topmaguningizcha o'yin tugamaydi!</i>`,
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("➡️ Davom etish", "wm_next")],
          ]),
        },
      );
    }
  } catch (error) {
    console.error(`[cbWmAns Xatosi - Chat: ${ctx.chat.id}]:`, error);
    await ctx
      .answerCbQuery("❌ Javobni tekshirishda xatolik yuz berdi!", {
        show_alert: true,
      })
      .catch(() => {});
  }
}

async function cbWmNext(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  return sendNextInlineMistake(ctx);
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
  const currentMistakes = mistakes.slice(startIdx, startIdx + 5);

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
          ],
          [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
        ]),
      },
    );
  } catch (e) {
    console.error("cbAiExplainMistakes error:", e.message);
    await safeEdit(
      ctx,
      "⚠️ AI tahlilida kutilmagan xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🔙 Xatolarga qaytish",
              `review_mistakes_${page}`,
            ),
          ],
        ]),
      },
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
// ─── MAJBURIY TO'XTATISH (FORCE FINISH) ───
async function cbForceFinish(ctx) {
  await ctx.answerCbQuery("🛑 Test to'xtatildi!").catch(() => {});

  // Faol test xotirasini butunlay tozalab tashlaymiz
  await sessionService.deleteActiveTest(ctx.chat.id).catch(() => {});

  await safeEdit(
    ctx,
    "✅ <b>Faol test majburiy to'xtatildi va xotira tozalandi.</b>\n\nEndi hech qanday xatoliksiz bemalol yangi test boshlashingiz mumkin.",
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("➕ Yangi test boshlash", "menu_test")],
        [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
      ]),
    },
  );
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

  // Bularni eskisining o'rniga qo'ying:
  bot.action(/^wm_menu_/, cbWorkMistakesMenu);
  bot.action(/^wm_start_inline_/, cbWmStartInline);
  bot.action(/^wm_start_quiz_/, cbWmStartQuiz);
  bot.action(/^wm_ans_/, cbWmAns);
  bot.action("wm_next", cbWmNext);

  bot.action("post_main", cbPostMain);
  bot.action(/^post_subj_/, cbPostSubj);
  bot.action(/^post_start_/, cbPostStart);
  bot.action(/^adaptive_/, cbAdaptiveTest);
  bot.action(/^adp_run_/, cbAdaptiveRun);
  bot.action("room_next_block", cbRoomNextBlock);

  bot.action("force_finish", cbForceFinish);
  bot.action("pause_resume", cbPauseResume);
  bot.action("pause_finish", cbPauseFinish);
  bot.action("pause_shelf", cbPauseShelf);
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
