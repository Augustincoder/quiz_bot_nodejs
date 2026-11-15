"use strict";

const { Markup } = require("telegraf");
const dbService = require("../../services/dbService");
const {
  States,
  setState,
  updateData,
  getData,
  safeEdit,
  escapeHtml,
  progressBar,
  parseSuffix,
  parseTextQuestions,
} = require("../../core/utils");

// In-memory queue to debounce and coalesce multi-chunk pastes (>4096 chars split by Telegram)
const userTextChunks = new Map();

async function showEditDashboard(ctx) {
  await updateData(ctx, {
    editing_question_index: undefined,
    fixing_error_index: undefined,
  });
  const data = await getData(ctx);
  const questions = data.questions || [];
  const bar = progressBar(Math.min(questions.length, 50), 50);

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Yangi savol qo'shish", "edit_add_q")],
    [
      Markup.button.callback(
        `👁/🗑 Savollarni ko'rish va o'chirish`,
        "preview_grid_0",
      ),
    ],
    [
      Markup.button.callback(
        "✅ O'zgarishlarni saqlash",
        "finish_test_creation",
      ),
    ],
    [
      Markup.button.callback(
        "🔙 Saqlamasdan chiqish",
        `manage_test_${data.editing_test_id}`,
      ),
    ],
  ]);

  await safeEdit(
    ctx,
    `✏️ <b>Testni Tahrirlash</b>\n\n📚 Fan: <b>${escapeHtml(data.subject || '')}</b>\n📝 Blok: <b>${escapeHtml(data.block_name || '')}</b>\n📊 Jami savollar: <b>${questions.length} ta</b>\n${bar}\n\nQuyidagi menyudan kerakli amalni tanlang:`,
    { parse_mode: "HTML", ...kb },
  );
}

async function cbEditTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const testId = parseSuffix(ctx.callbackQuery.data, "edit_test_");
  const testData = await dbService.getUserTest(testId);

  if (!testData || String(testData.creator_id) !== String(ctx.from.id)) {
    return ctx
      .answerCbQuery("❌ Ruxsat yo'q!", { show_alert: true })
      .catch(() => {});
  }

  await updateData(ctx, {
    editing_test_id: testId,
    subject: testData.subject,
    subject_id: testData.subject_id || null,
    block_name: testData.block_name,
    questions: testData.questions || [],
    is_editing: true,
  });

  await showEditDashboard(ctx);
}

async function cbBackToEditDash(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await showEditDashboard(ctx);
}

async function cbEditAddQ(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx, States.CREATE_QUESTIONS);

  await safeEdit(
    ctx,
    `➕ <b>Yangi savollar qo'shish</b>\n\nSavollarni matn ko'rinishida yuboring:\n\n<pre>Savol matni?\n#To'g'ri javob\nNoto'g'ri javob 1\nNoto'g'ri javob 2</pre>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Tahrirlash paneliga", "back_to_edit_dash")],
      ]),
    },
  );
}

async function processBatchedTextQuestions(ctx, fullText) {
  const data = await getData(ctx);
  let questions = [...(data.questions || [])];
  const parsed = parseTextQuestions(
    fullText,
    data.parse_mode || "hash",
  );
  const newQs = parsed.valid || [];
  const newInvalids = parsed.invalid || [];
  let currentInvalids = data.invalidQs || [];

  if (newInvalids.length > 0) {
    currentInvalids = [...currentInvalids, ...newInvalids];
    await updateData(ctx, { invalidQs: currentInvalids });
  }

  const finishAction = data.is_editing
    ? "back_to_edit_dash"
    : "back_to_dashboard";
  const finishText = data.is_editing
    ? "🔙 Tahrirlash paneliga (Yakunlash)"
    : "🔙 Panelga qaytish (Yakunlash)";

  if (newQs.length > 0) {
    questions = [...questions, ...newQs];
    const format_added = (data.format_added || 0) + newQs.length;
    await updateData(ctx, { questions, format_added });

    const redisConnection = require("../../services/redisService");
    const uid = ctx.from?.id || ctx.chat?.id;
    if (uid && ctx.session) {
      await redisConnection.set(`tg_session:${uid}`, JSON.stringify(ctx.session), "EX", 86400).catch(() => {});
    }

    const buttons = [
      [
        Markup.button.callback(
          `👁 Shu ${format_added} tasini ko'rib chiqish`,
          "preview_local_0",
        ),
      ],
    ];
    if (currentInvalids.length > 0) {
      buttons.push([
        Markup.button.callback(
          `⚠️ Xatolarni to'g'rilash (${currentInvalids.length} ta)`,
          "fix_errors_0",
        ),
      ]);
    }
    buttons.push([Markup.button.callback(finishText, finishAction)]);

    let statusMsg = `✅ <b>${newQs.length} ta savol qo'shildi!</b>\n\nYana savol yuborishingiz mumkin.\n<i>Joriy formatda yig'ilganlar: ${format_added} ta</i>`;
    if (newInvalids.length > 0) {
      statusMsg += `\n⚠️ <b>Xato formatdagi savollar:</b> ${newInvalids.length} ta`;
    }

    await ctx.reply(
      statusMsg,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(buttons),
      },
    );
  } else if (newInvalids.length > 0) {
    const redisConnection = require("../../services/redisService");
    const uid = ctx.from?.id || ctx.chat?.id;
    if (uid && ctx.session) {
      await redisConnection.set(`tg_session:${uid}`, JSON.stringify(ctx.session), "EX", 86400).catch(() => {});
    }

    await ctx.reply(
      `⚠️ <b>${newInvalids.length} ta savolda format xatosi aniqlandi!</b>\nSavollar saqlanmadi (masalan, to'g'ri javob oldida # belgisi yo'q yoki variantlar yetarli emas).`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              `⚠️ Xatolarni to'g'rilash (${currentInvalids.length} ta)`,
              "fix_errors_0",
            ),
          ],
          [Markup.button.callback(finishText, finishAction)],
        ]),
      },
    );
  } else {
    await ctx.reply("❌ Matndan savollar ajratib olinmadi. Iltimos, formatingizni tekshirib qayta yuboring (To'g'ri javob oldiga # qo'ying).");
  }
}

async function onQuestionMessage(ctx) {
  const data = await getData(ctx);
  let questions = [...(data.questions || [])];

  if (data.editing_question_index !== undefined) {
    if (!ctx.message.text) return ctx.reply("⚠️ Iltimos, matn yuboring.");

    const parsed = parseTextQuestions(
      ctx.message.text,
      data.parse_mode || "hash",
    );
    const added = parsed.valid || [];

    if (!added.length) {
      return ctx.reply(
        "❌ Formatingiz xato! Iltimos, to'g'ri javob oldiga # qo'yib qayta yuboring.",
      );
    }

    const updatedIdx = data.editing_question_index;
    questions[updatedIdx] = added[0];

    await updateData(ctx, { questions, editing_question_index: undefined });

    const msg = await ctx.reply("✅ Savol muvaffaqiyatli tahrirlandi!");
    setTimeout(
      () =>
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}),
      2000,
    );

    const page = Math.floor(updatedIdx / 10);
    return cbPreviewGrid(ctx, page);
  }

  if (data.fixing_error_index !== undefined) {
    if (!ctx.message.text) return ctx.reply("⚠️ Iltimos, matn yuboring.");

    const parsed = parseTextQuestions(
      ctx.message.text,
      data.parse_mode || "hash",
    );
    const added = parsed.valid || [];

    if (!added.length) {
      return ctx.reply(
        "❌ Hali ham xato! Iltimos, to'g'ri javob oldiga # qo'yib qayta yuboring.",
      );
    }

    const fixIdx = data.fixing_error_index;
    const invalidQs = data.invalidQs || [];

    questions.push(added[0]);

    if (fixIdx >= 0 && fixIdx < invalidQs.length) {
      invalidQs.splice(fixIdx, 1);
    }

    if (data.is_auto_docx) {
      const chunks = [];
      for (let i = 0; i < questions.length; i += 25) {
        chunks.push(questions.slice(i, i + 25));
      }
      await updateData(ctx, { questions, invalidQs, chunks });
    } else {
      await updateData(ctx, { questions, invalidQs });
    }

    const msg = await ctx.reply(
      "✅ Savol muvaffaqiyatli to'g'rilandi va qabul qilindi!",
    );
    setTimeout(
      () =>
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}),
      2000,
    );

    const docxImportFlow = require("./docxImportFlow");
    return docxImportFlow.cbFixErrors(ctx, fixIdx);
  }

  const fmt = data.format;
  let newQs = [];

  if (fmt === "text") {
    if (!ctx.message.text) return;
    const userId = ctx.from?.id;
    if (!userId) return;

    let chunkState = userTextChunks.get(userId);
    if (!chunkState) {
      chunkState = { text: '', timer: null, ctx, lastMsgLen: 0 };
      userTextChunks.set(userId, chunkState);
    }
    const msgLen = ctx.message?.text ? ctx.message.text.length : 0;
    const sep = chunkState.text
      ? (chunkState.lastMsgLen >= 4000 ? '' : '\n\n')
      : '';
    chunkState.text += sep + (ctx.message?.text || '');
    chunkState.lastMsgLen = msgLen;
    chunkState.ctx = ctx;

    if (chunkState.timer) clearTimeout(chunkState.timer);

    chunkState.timer = setTimeout(async () => {
      userTextChunks.delete(userId);
      await processBatchedTextQuestions(chunkState.ctx, chunkState.text);
    }, 400);
    return;
  } else if (fmt === "quiz") {
    const poll = ctx.message.poll;
    if (!poll || poll.type !== "quiz") return;
    newQs.push({
      question: poll.question,
      options: poll.options.map((o) => o.text),
      correct_index: poll.correct_option_id,
    });
  }

  if (newQs.length > 0) {
    questions = [...questions, ...newQs];
    const format_added = (data.format_added || 0) + newQs.length;
    await updateData(ctx, { questions, format_added });

    const finishAction = data.is_editing
      ? "back_to_edit_dash"
      : "back_to_dashboard";
    const finishText = data.is_editing
      ? "🔙 Tahrirlash paneliga (Yakunlash)"
      : "🔙 Panelga qaytish (Yakunlash)";

    await ctx.reply(
      `✅ <b>${newQs.length} ta savol qo'shildi!</b>\n\nYana savol yuborishingiz mumkin.\n<i>Joriy formatda yig'ilganlar: ${format_added} ta</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              `👁 Shu ${format_added} tasini ko'rib chiqish`,
              "preview_local_0",
            ),
          ],
          [Markup.button.callback(finishText, finishAction)],
        ]),
      },
    );
  }
}

async function cbPreviewGrid(ctx, targetPage = null) {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery().catch(() => {});
  }
  await updateData(ctx, {
    editing_question_index: undefined,
    fixing_error_index: undefined,
  });
  const page = targetPage !== null
    ? targetPage
    : (parseInt(parseSuffix(ctx.callbackQuery?.data, "preview_grid_"), 10) || 0);
  const data = await getData(ctx);
  const questions = data.questions || [];

  if (questions.length === 0) {
    return safeEdit(
      ctx,
      "⚠️ Hozircha savollar yo'q!",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Panelga qaytish", "back_to_dashboard")],
      ]),
    );
  }

  const ITEMS_PER_PAGE = 10;
  const totalPages = Math.ceil(questions.length / ITEMS_PER_PAGE);
  const validPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = validPage * ITEMS_PER_PAGE;
  const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, questions.length);
  const currentQs = questions.slice(startIdx, endIdx);

  let text = `👁 <b>Barcha savollar</b> (Jami: ${questions.length} ta)\n<i>Sahifa: ${validPage + 1} / ${totalPages}</i>\n\n`;

  currentQs.forEach((q, i) => {
    const actualNum = startIdx + i + 1;
    const correctAns = q.options[q.correct_index] || "Noma'lum";
    text += `<b>${actualNum}.</b> ${escapeHtml(q.question)}\n✅ <i>Javob:</i> ${escapeHtml(correctAns)}\n\n`;
  });

  text += `<i>Batafsil ko'rish yoki tahrirlash uchun pastdagi mos raqamni tanlang:</i>`;

  const buttons = [];

  let numpadRow = [];
  for (let i = 0; i < currentQs.length; i++) {
    const actualNum = startIdx + i + 1;
    const actualIdx = startIdx + i;
    numpadRow.push(
      Markup.button.callback(`${actualNum}`, `preview_q_${actualIdx}`),
    );

    if (numpadRow.length === 5 || i === currentQs.length - 1) {
      buttons.push(numpadRow);
      numpadRow = [];
    }
  }

  const navRow = [];
  if (validPage > 0)
    navRow.push(
      Markup.button.callback(
        "⬅️ Oldingi 10 ta",
        `preview_grid_${validPage - 1}`,
      ),
    );
  if (validPage < totalPages - 1)
    navRow.push(
      Markup.button.callback(
        "Keyingi 10 ta ➡️",
        `preview_grid_${validPage + 1}`,
      ),
    );
  if (navRow.length > 0) buttons.push(navRow);

  await updateData(ctx, {
    editing_question_index: undefined,
    fixing_error_index: undefined,
  });
  const backAction = data.is_editing ? "back_to_edit_dash" : "back_to_dashboard";
  const backText = data.is_editing ? "🔙 Tahrirlash paneliga qaytish" : "🔙 Boshqaruv Paneliga qaytish";
  buttons.push([
    Markup.button.callback(
      backText,
      backAction,
    ),
  ]);

  await safeEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function cbPreviewQuestion(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "preview_q_"), 10);
  await updateData(ctx, {
    editing_question_index: undefined,
    fixing_error_index: undefined,
  });
  const data = await getData(ctx);
  const questions = data.questions || [];

  if (idx < 0 || idx >= questions.length) return cbPreviewGrid(ctx);

  const q = questions[idx];
  let text = `👁 <b>Savol batafsil</b> (${idx + 1} / ${questions.length})\n\n<b>${escapeHtml(q.question)}</b>\n\n`;
  const labels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

  q.options.forEach((opt, i) => {
    const label = labels[i] || String.fromCharCode(65 + i);
    text += `${i === q.correct_index ? "✅" : "❌"} <b>${label})</b> ${escapeHtml(opt)}\n`;
  });

  const page = Math.floor(idx / 10);

  await safeEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("✏️ Tahrirlash", `edit_q_${idx}`),
        Markup.button.callback("🗑 O'chirish", `del_q_${idx}`),
      ],
      [Markup.button.callback("🔙 Ro'yxatga qaytish", `preview_grid_${page}`)],
    ]),
  });
}

async function cbDeleteQuestion(ctx) {
  await ctx.answerCbQuery("🗑 O'chirildi!").catch(() => {});
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "del_q_"), 10);
  const data = await getData(ctx);
  let questions = data.questions || [];

  if (idx >= 0 && idx < questions.length) {
    questions.splice(idx, 1);
    await updateData(ctx, { questions });
  }

  let page = Math.floor(idx / 10);
  const maxPage = Math.max(0, Math.ceil(questions.length / 10) - 1);
  if (page > maxPage) page = maxPage;

  ctx.callbackQuery.data = `preview_grid_${page}`;
  return cbPreviewGrid(ctx);
}

async function cbEditQuestionStart(ctx) {
  await ctx.answerCbQuery("✏️ Savol matni tayyorlanmoqda...").catch(() => {});
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "edit_q_"), 10);
  const data = (await getData(ctx)) || {};
  const questions = data.questions || [];

  if (isNaN(idx) || idx < 0 || idx >= questions.length || !questions[idx]) {
    return cbPreviewGrid(ctx);
  }

  const q = questions[idx];

  let textFormat = `${q.question}\n`;
  q.options.forEach((opt, i) => {
    if (i === q.correct_index) textFormat += `#${opt}\n`;
    else textFormat += `${opt}\n`;
  });

  await updateData(ctx, { editing_question_index: idx });
  setState(ctx, States.CREATE_QUESTIONS);

  await safeEdit(
    ctx,
    `✏️ <b>Savolni Tahrirlash</b> (${idx + 1}-savol)\n\nQuyidagi matnni nusxalang (ustiga bossangiz nusxalanadi), xatoni to'g'rilab, botga qayta yuboring:\n\n<pre><code>${escapeHtml(textFormat)}</code></pre>\n\n💡 <i>To'g'ri javob oldida # bo'lishi shart.</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ Bekor qilish", `preview_q_${idx}`)],
      ]),
    },
  );
}

module.exports = {
  showEditDashboard,
  cbEditTest,
  cbBackToEditDash,
  cbEditAddQ,
  userTextChunks,
  processBatchedTextQuestions,
  onQuestionMessage,
  cbPreviewGrid,
  cbPreviewQuestion,
  cbDeleteQuestion,
  cbEditQuestionStart,
};
