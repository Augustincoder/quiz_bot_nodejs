"use strict";

const { Markup } = require("telegraf");
const dbService = require("../../services/dbService");
const logger = require("../../core/logger");
const { buildShareLink } = require("../../services/shareService");
const {
  States,
  setState,
  clearState,
  updateData,
  getData,
  safeEdit,
  safeAnswerCb,
  escapeHtml,
  progressBar,
  parseSuffix,
  naturalSortBlocks,
} = require("../../core/utils");
const {
  SubjectSchema,
  BlockNameSchema,
  escapeMarkdown,
} = require("../../validators/testValidators");
const { userTextChunks, showEditDashboard } = require("./questionEditor");

// ─── 1. YANGI TEST YARATISH BOSQICHLARI ──────────────────────

async function cbCreateTest(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery("✅ Test yaratish bo'limi ochildi!").catch(() => {});

  let page = 0;
  if (ctx.callbackQuery && ctx.callbackQuery.data && ctx.callbackQuery.data.startsWith("create_test_")) {
    page = parseInt(ctx.callbackQuery.data.replace("create_test_", ""), 10) || 0;
  }

  const userSubjects = await dbService.getUserSubjects(ctx.from.id);
  const buttons = [];

  if (userSubjects.length > 0) {
    buttons.push([Markup.button.callback("── Mavjud fanlar (Tezkor tanlash) ──", "ignore")]);

    const ITEMS_PER_PAGE = 5;
    const totalPages = Math.ceil(userSubjects.length / ITEMS_PER_PAGE);
    const validPage = Math.max(0, Math.min(page, totalPages - 1));

    const currentSubjects = userSubjects.slice(
      validPage * ITEMS_PER_PAGE,
      (validPage + 1) * ITEMS_PER_PAGE
    );

    for (const subj of currentSubjects) {
      buttons.push([
        Markup.button.callback(`📁 ${subj.name}  •  ${subj.block_count || 0} ta blok`, `ct_exist_${subj.id}`)
      ]);
    }

    const navRow = [];
    if (validPage > 0) navRow.push(Markup.button.callback("⬅️ Oldingi", `create_test_${validPage - 1}`));
    if (validPage < totalPages - 1) navRow.push(Markup.button.callback("Keyingi ➡️", `create_test_${validPage + 1}`));

    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([Markup.button.callback("➕ Yangi fan yaratish", "ct_new")]);
  } else {
    buttons.push([Markup.button.callback("➕ Birinchi fanimni yarataman", "ct_new")]);
  }

  buttons.push([Markup.button.callback("🔙 Asosiy Menyu", "back_to_main")]);

  let pageInfo = "";
  if (userSubjects.length > 5) {
    const totalPages = Math.ceil(userSubjects.length / 5);
    const validPage = Math.max(0, Math.min(page, totalPages - 1));
    pageInfo = `\n\n_Sahifa: ${validPage + 1} / ${totalPages}_`;
  }

  await safeEdit(
    ctx,
    `✏️ *Test Yaratish*\n\nO'z shaxsiy testingizni yarating va do'stlaringiz bilan ulashing!\n\n💡 *Qanday ishlaydi:*\n1️⃣ Fan va blok nomini kiriting\n2️⃣ Savollarni matn, Word fayl, yoki AI orqali qo'shing\n3️⃣ Tayyor testni havola orqali ulashing\n\n👇 Boshlash uchun fan tanlang yoki yangi yarating:${pageInfo}`,
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(buttons) }
  );
}

async function cbCtNew(ctx) {
  await ctx.answerCbQuery("📍 1-qadamga o'tildi").catch(() => {});
  setState(ctx, States.CREATE_SUBJECT);
  await safeEdit(
    ctx,
    "📍 <b>[1/3] Bosqich: Fan tanlash</b>\n\n━━━━━━━━━━━━━━━━\nYangi fan nomini kiriting.\n\n💡 <i>Masalan: Ona tili, Tarix 1-qism, Kardiologiya</i>\n\n⚠️ Uzunligi: 2–50 belgi.",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔙 Ortga (Fanlar ro'yxatiga)", "create_test")],
      [Markup.button.callback("❌ Bekor qilish", "cancel_creation")],
    ]),
  );
}

async function promptBlockNameOrAutoDocx(ctx, subject) {
  await safeEdit(
    ctx,
    `✅ Fan: *${escapeMarkdown(subject)}*\n\n📍 *[2/3] Bosqich: Blok yaratish*\n\n━━━━━━━━━━━━━━━━\n📝 Ushbu fan uchun yangi blok nomini yozing (Masalan: *1-Mavzu, Kardiologiya*).\n\n📄 Yoki butun boshli test bazasini Word (.docx) orqali avtomatik qismlarga bo'lib yuklamoqchi bo'lsangiz, quyidagi tugmani bosing:`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📄 Word fayl orqali Avto-yuklash",
            "auto_docx",
          ),
        ],
        [Markup.button.callback("🔙 Ortga (Fan tanlashga)", "create_test")],
        [Markup.button.callback("❌ Bekor qilish", "cancel_creation")],
      ]),
    },
  );
  setState(ctx, States.CREATE_NAME);
}

async function cbBackToBlockPrompt(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const data = await getData(ctx);
  if (!data.subject) return cbCreateTest(ctx);
  await promptBlockNameOrAutoDocx(ctx, data.subject);
}

async function onSubjectInput(ctx) {
  const result = SubjectSchema.safeParse(ctx.message.text || "");
  if (!result.success) {
    const errMsg = result.error.issues?.[0]?.message || result.error.errors?.[0]?.message || "Noto'g'ri format";
    return ctx.reply(
      `❌ ${errMsg}\n\n💡 Iltimos, qaytadan kiriting:`,
    );
  }
  if (!ctx.session || !ctx.session.data) return cbCancelCreation(ctx);

  const subjectName = result.data;
  const subjectRecord = await dbService.getOrCreateSubject(ctx.from.id, subjectName);
  const resolvedName = subjectRecord ? subjectRecord.name : subjectName;
  const resolvedId = subjectRecord ? subjectRecord.id : null;

  await updateData(ctx, { subject: resolvedName, subject_id: resolvedId });

  await ctx
    .reply("⏳ Qabul qilindi...", { reply_markup: { remove_keyboard: true } })
    .then((m) =>
      ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}),
    );
  await promptBlockNameOrAutoDocx(ctx, resolvedName);
}

async function cbCtExist(ctx) {
  const refId = parseSuffix(ctx.callbackQuery.data, "ct_exist_");
  let subject = await dbService.getSubjectById(refId);
  let subjectName = subject?.name;
  let subjectId = subject?.id;

  if (!subject) {
    const testData = await dbService.getUserTest(refId);
    if (testData) {
      if (testData.subject_id) {
        subject = await dbService.getSubjectById(testData.subject_id);
        subjectId = subject ? subject.id : testData.subject_id;
        subjectName = subject ? subject.name : testData.subject;
      } else {
        subjectName = testData.subject;
        const s = await dbService.getOrCreateSubject(ctx.from.id, subjectName);
        subjectId = s?.id || null;
      }
    }
  }

  if (!subjectName)
    return ctx.answerCbQuery("❌ Fan topilmadi", { show_alert: true });

  await ctx.answerCbQuery(`✅ ${subjectName} tanlandi`).catch(() => {});
  await updateData(ctx, { subject: subjectName, subject_id: subjectId });

  await promptBlockNameOrAutoDocx(ctx, subjectName);
}

async function onNameInput(ctx) {
  const result = BlockNameSchema.safeParse(ctx.message.text || "");
  if (!result.success) {
    const errMsg = result.error.issues?.[0]?.message || result.error.errors?.[0]?.message || result.error.message;
    return ctx.reply(`❌ ${errMsg}`);
  }
  if (!ctx.session || !ctx.session.data) return cbCancelCreation(ctx);

  const block_name = result.data;
  await updateData(ctx, { block_name, is_auto_docx: false });

  setState(ctx, States.CREATE_QUESTIONS);
  await showDraftDashboard(ctx);
}

// ─── DRAFT DASHBOARD ─────────────────────────────────────────

async function showDraftDashboard(ctx) {
  await updateData(ctx, {
    editing_question_index: undefined,
    fixing_error_index: undefined,
  });
  const data = await getData(ctx);
  const qCount = (data.questions || []).length;
  const invalidCount = (data.invalidQs || []).length;
  const subject = data.subject || "🤖 AI Smart Quiz";
  const blockName = data.block_name || "1-Blok";

  let text = `📚 *Fan:* ${escapeMarkdown(subject)}\n`;
  text += `📝 *Blok:* ${escapeMarkdown(blockName)}\n`;
  text += `🛒 *Savatdagi savollar:* ${qCount} ta\n`;
  if (invalidCount > 0) {
    text += `⚠️ *Xato formatdagi savollar:* ${invalidCount} ta\n`;
  }
  text += `\n`;

  const buttons = [];

  if (qCount === 0 && invalidCount === 0) {
    text += `_Savat bo'sh. Qaysi usulda savol qo'shmoqchisiz? O'zingizga qulayini tanlang:_`;
  } else {
    text += `_Yana savol qo'shishingiz mumkin. Yoki jarayonni yakunlang:_`;
  }

  buttons.push([
    Markup.button.callback("📝 Matn", "fmt_text"),
    Markup.button.callback("📊 Quiz", "fmt_quiz"),
  ]);
  buttons.push([
    Markup.button.callback("📄 Word fayl", "fmt_docx"),
    Markup.button.callback("🤖 AI Smart Quiz", "fmt_ai"),
  ]);

  if (invalidCount > 0) {
    buttons.push([
      Markup.button.callback(
        `⚠️ Xatolarni to'g'rilash (${invalidCount} ta)`,
        "fix_errors_0",
      ),
    ]);
  }

  if (qCount > 0) {
    buttons.push([
      Markup.button.callback("👁 Barchasini ko'rib chiqish", "preview_grid_0"),
    ]);
    buttons.push([
      Markup.button.callback("✅ Yakunlash va Saqlash", "finish_test_creation"),
    ]);
  }

  buttons.push([Markup.button.callback("❌ Bekor qilish", "cancel_creation")]);

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
}

async function cbBackToDashboard(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await updateData(ctx, { format_added: 0 });
  await showDraftDashboard(ctx);
}

async function cbFmt(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const fmt = parseSuffix(ctx.callbackQuery.data, "fmt_");
  const data = await getData(ctx);
  await updateData(ctx, {
    format: fmt,
    format_added: 0,
    editing_question_index: undefined,
    fixing_error_index: undefined,
  });

  const backAction = data.is_editing ? "edit_add_q" : "back_to_dashboard";
  const backText = data.is_editing
    ? "🔙 Ortga (Format tanlashga)"
    : "🔙 Ortga (Asosiy Panelga)";

  if (fmt === "ai") {
    if (!data.subject) {
      await updateData(ctx, {
        subject: "🤖 AI Smart Quiz",
        block_name: data.block_name || "1-Blok",
      });
    }
    const aiText = `🤖 <b>AI Smart Quiz — Sun'iy Intellekt bilan test yaratish</b>\n\nQaysi manba orqali test tuzmoqchisiz? Quyidagilardan birini tanlang:`;
    return safeEdit(ctx, aiText, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📄 Matndan", "ai_mode_text"),
          Markup.button.callback("📸 Rasmdan", "ai_mode_image"),
        ],
        [Markup.button.callback("❓ Savollardan", "ai_mode_questions")],
        [Markup.button.callback(backText, backAction)],
      ]),
    });
  }

  if (fmt === "quiz") {
    setState(ctx, States.CREATE_QUESTIONS);
    const text = `📊 *Telegram Quiz*\n\n📎 Pastdagi qisqich belgisini bosib, *Poll -> Quiz* orqali savollaringizni bittalab yuboring.\n\n_Bu rejimdasiz! Savollarni ketma-ket yuboravering._`;
    return safeEdit(ctx, text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(backText, backAction)],
      ]),
    });
  }

  if (fmt === "text" || fmt === "docx") {
    await safeEdit(
      ctx,
      `⚙️ *Qaysi usulda o'qiymiz?*\n\nSavollarda to'g'ri javob qanday belgilangan?\n\n🎯 *# bilan:* To'g'ri javob oldida # belgisi bor.\n🥇 *1-javob:* Har doim A (birinchi) variant to'g'ri qilib yozilgan.`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🎯 To'g'ri javob oldida # bor",
              `parse_hash_${fmt}`,
            ),
          ],
          [
            Markup.button.callback(
              "🥇 Har doim 1-javob to'g'ri",
              `parse_first_${fmt}`,
            ),
          ],
          [Markup.button.callback(backText, backAction)],
        ]),
      },
    );
  }
}

async function sendFormatSelection(ctx) {
  const text = `📝 <b>Yangi savol formatini tanlang:</b>\n\n⬇️ Qaysi usulda savol qo'shmoqchisiz?`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🤖 AI Smart Quiz (Avtomatik)", "fmt_ai")],
    [Markup.button.callback("📊 Telegram Quiz", "fmt_quiz")],
    [Markup.button.callback("📝 Matn ko'rinishida", "fmt_text")],
    [Markup.button.callback("📄 Word fayl (.docx)", "fmt_docx")],
    [Markup.button.callback("🔙 Tahrirlash paneliga", "back_to_edit_dash")],
  ]);

  if (ctx.callbackQuery) {
    await safeEdit(ctx, text, kb);
  } else {
    await ctx.reply(text, { parse_mode: "HTML", ...kb });
  }
}

async function cbBackToFormats(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await sendFormatSelection(ctx);
}

async function cbParseModeSelect(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const action = ctx.callbackQuery.data;
  const parts = action.split("_");
  const mode = parts[1];
  const fmt = parts[2];

  const data = await getData(ctx);
  await updateData(ctx, { parse_mode: mode });

  const backAction = data.is_editing ? "edit_add_q" : "back_to_dashboard";
  const backText = data.is_editing
    ? "🔙 Ortga (Format tanlashga)"
    : "🔙 Ortga (Asosiy Panelga)";

  let text = "";
  let backBtn = [];

  if (fmt === "docx" && data.is_auto_docx) {
    setState(ctx, States.CREATE_QUESTIONS);
    text = `📄 *Avto-Word Rejimi*\n\nIltimos, tayyor Word (.docx) faylni shu chatga yuboring. Tizim uni o'qib, har 25 ta savolni avtomatik ravishda alohida bloklarga ajratadi.\n\n_Boshqa fayl tanlash yoki fikringizdan qaytsangiz, Ortga tugmasini bosing._`;
    backBtn = [
      Markup.button.callback("🔙 Ortga (Format tanlashga)", "auto_docx"),
    ];
  } else if (fmt === "docx") {
    setState(ctx, States.CREATE_QUESTIONS);
    text = `📄 *Word (.docx) Formati*\n\nWord faylini shu chatga tashlang.\n\n⚠️ *Limit:* Bitta blok uchun faqat 50 ta savol qabul qilinadi.\n_Yirik bazalar uchun Orqaga qaytib, "Avto-yuklash" tugmasidan foydalaning!_`;
    backBtn = [Markup.button.callback(backText, backAction)];
  } else if (fmt === "text") {
    setState(ctx, States.CREATE_QUESTIONS);
    text = `✍️ *Matn Formati*\n\nSavollarni quyidagi shablon asosida yozib, yuboring:\n\nSavol matni?\n#To'g'ri javob (yoki 1-javob)\nNoto'g'ri javob\n\n_Bu rejimdasiz! Xohlagancha xabar yuborishingiz mumkin._`;
    backBtn = [Markup.button.callback(backText, backAction)];
  }

  await safeEdit(ctx, text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([backBtn]),
  });
}

async function showCreationStatusMenu(ctx) {
  const data = await getData(ctx);
  const validCount = (data.questions || []).length;
  const invalidCount = (data.invalidQs || []).length;

  const buttons = [];
  if (validCount > 0)
    buttons.push([
      Markup.button.callback("👁 Savollarni ko'rib chiqish", "preview_grid_0"),
    ]);
  if (invalidCount > 0)
    buttons.push([
      Markup.button.callback(
        `⚠️ Xatolarni to'g'rilash (${invalidCount} ta)`,
        "fix_errors_0",
      ),
    ]);
  if (validCount > 0)
    buttons.push([
      Markup.button.callback("✅ Yakunlash va Saqlash", "finish_test_creation"),
    ]);

  if (!data.is_auto_docx)
    buttons.push([
      Markup.button.callback("🔙 Boshqa format qo'shish", "back_to_formats"),
    ]);
  buttons.push([Markup.button.callback("❌ Bekor qilish", "cancel_creation")]);

  const text = `📊 *Holat Hisoboti*\n\n✅ Qabul qilingan savollar: *${validCount} ta*\n⚠️ Xato formatdagi savollar: *${invalidCount} ta*\n\nQuyidagi menyudan amaliyotni tanlang:`;

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
}

async function cbFinishCreation(ctx) {
  const data = await getData(ctx);
  const questions = data.questions || [];
  if (!questions.length)
    return ctx
      .answerCbQuery("❌ Kamida 1 ta savol qo'shishingiz kerak!", {
        show_alert: true,
      })
      .catch(() => {});

  await ctx.answerCbQuery("✅ Test muvaffaqiyatli saqlandi!").catch(() => {});

  const CHUNK_SIZE = 25;
  let testIds = [];

  const subject = data.subject || "🤖 AI Smart Quiz";
  const baseBlockName = data.block_name || "1-Blok";

  if (data.editing_test_id) {
    await dbService.updateUserTestQuestions(
      data.editing_test_id,
      ctx.from.id,
      questions,
    );
    testIds.push(data.editing_test_id);
  } else {
    let startPart = data.start_part || 1;
    if (!data.start_part && subject && ctx.from?.id && !data.editing_test_id) {
      try {
        const existingTests = await dbService.getUserCreatedTests(ctx.from.id, false);
        const subjectTests = (existingTests || []).filter((t) => t.subject === subject);
        let maxPart = 0;
        for (const t of subjectTests) {
          const name = t.block_name || "";
          const match = name.match(/(?:^|\D)(\d+)\s*-?\s*qism/i);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxPart) maxPart = num;
          }
        }
        if (maxPart > 0) startPart = maxPart + 1;
        else if (subjectTests.length > 0) startPart = subjectTests.length + 1;
      } catch {}
    }

    let resolvedSubjectId = data.subject_id;
    if (!resolvedSubjectId && subject) {
      try {
        const s = await dbService.getOrCreateSubject(ctx.from.id, subject);
        if (s?.id) {
          resolvedSubjectId = s.id;
          data.subject_id = resolvedSubjectId;
        }
      } catch {}
    }

    const SINGLE_BLOCK_MAX = data.is_auto_docx ? 25 : 50;
    if (questions.length <= SINGLE_BLOCK_MAX && !data.is_auto_docx) {
      const tId = await dbService.saveUserTest(
        ctx.from.id,
        subject,
        baseBlockName,
        questions,
        resolvedSubjectId,
      );
      if (tId) testIds.push(tId);
    } else {
      const chunks = [];
      for (let i = 0; i < questions.length; i += CHUNK_SIZE) {
        chunks.push(questions.slice(i, i + CHUNK_SIZE));
      }
      const blocksToSave = chunks.map((chunk, i) => ({
        blockName: `${baseBlockName} (${startPart + i}-qism)`,
        questions: chunk,
      }));
      const ids = await dbService.saveUserTestsBatch(
        ctx.from.id,
        subject,
        blocksToSave,
        resolvedSubjectId,
      );
      if (ids && ids.length) {
        testIds.push(...ids.filter(Boolean));
      } else {
        for (let i = 0; i < chunks.length; i++) {
          const chunkName = `${baseBlockName} (${startPart + i}-qism)`;
          const tId = await dbService.saveUserTest(
            ctx.from.id,
            subject,
            chunkName,
            chunks[i],
            resolvedSubjectId,
          );
          if (tId) testIds.push(tId);
        }
      }
    }
  }

  testIds = testIds.filter(Boolean);
  if (!testIds.length) {
    logger.error("cbFinishCreation: failed to save test to DB", { userId: ctx.from.id, subject });
    return ctx.reply("❌ Testni saqlashda xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.", {
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Qaytadan saqlash", "finish_test_creation")],
        [Markup.button.callback("🔙 Savatga qaytish", "back_to_dashboard")],
      ]),
    });
  }

  const botInfo = await ctx.telegram.getMe();
  const firstTestId = testIds[0];
  const shareSubjectId = data.subject_id || firstTestId;

  const testShareUrl = buildShareLink(botInfo.username, 't', firstTestId);
  const subjShareUrl = buildShareLink(botInfo.username, 's', shareSubjectId);
  const groupSubjShareUrl = buildShareLink(botInfo.username, 's', shareSubjectId, true);

  const chunkMsg =
    testIds.length > 1
      ? `\n\n⚠️ <b>Avto-bo'lish:</b> Savollar ko'pligi uchun tizim ularni avtomatik <b>${testIds.length} ta blokga</b> ajratdi va fanga joyladi.`
      : `\n\n🔗 <b>Faqat shu blok:</b>\n<code>${testShareUrl}</code>`;

  await safeEdit(
    ctx,
    `🎉 <b>Muvaffaqiyatli saqlandi!</b>\n\n📚 Fan: <b>${escapeHtml(subject)}</b>\n📝 Asosiy Blok: <b>${escapeHtml(baseBlockName)}</b>\n🔢 Jami Savollar: <b>${questions.length} ta</b>${chunkMsg}\n\n🔗 <b>Butun fanni o'ynash (Marafon):</b>\n<code>${subjShareUrl}</code>`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "➕ Shu fanga yana blok qo'shish",
          `ct_exist_${shareSubjectId}`,
        ),
      ],
      [
        Markup.button.url(
          "↗️ Guruhda o'ynash",
          groupSubjShareUrl,
        ),
      ],
      [Markup.button.callback("📂 Mening Testlarim", "my_tests")],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]),
  );
  clearState(ctx);
}

async function cbCancelCreation(ctx) {
  const data = await getData(ctx) || {};
  const qCount = (data.questions || []).length;

  if (qCount > 0 && ctx.callbackQuery?.data !== "confirm_cancel_creation") {
    return safeEdit(
      ctx,
      `⚠️ *Diqqat!*\n\nSavatingizda *${qCount} ta* saqlanmagan savol bor. Agar bekor qilsangiz, barcha mehnatingiz o'chib ketadi.\n\nHaqiqatan ham bekor qilmoqchimisiz?`,
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🗑 Ha, barchasini o'chirish", "confirm_cancel_creation")],
          [Markup.button.callback("🔙 Yo'q, Panelga qaytish", "back_to_dashboard")]
        ])
      }
    );
  }

  const cancelUserId = ctx.from?.id;
  if (cancelUserId && userTextChunks.has(cancelUserId)) {
    const chunkState = userTextChunks.get(cancelUserId);
    if (chunkState?.timer) clearTimeout(chunkState.timer);
    userTextChunks.delete(cancelUserId);
  }
  clearState(ctx);
  await ctx.answerCbQuery("❌ Barchasi bekor qilindi va tozalandi.").catch(() => {});

  if (ctx.callbackQuery) {
    ctx.callbackQuery.data = "create_test_0";
  }
  return cbCreateTest(ctx);
}

async function cbMyTests(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  clearState(ctx);

  let page = 0;
  if (ctx.callbackQuery && ctx.callbackQuery.data && ctx.callbackQuery.data.startsWith("my_tests_")) {
    page = parseInt(ctx.callbackQuery.data.replace("my_tests_", ""), 10) || 0;
  }

  const userSubjects = await dbService.getUserSubjects(ctx.from.id);
  if (!userSubjects || userSubjects.length === 0) {
    const isDbDown = dbService.isRecentDbError();
    const emptyMsg = isDbDown
      ? "⚠️ <b>Ma'lumotlar bazasida vaqtinchalik uzilish yuz berdi.</b>\n\nIltimos, birozdan so'ng qayta urinib ko'ring."
      : "📭 <b>Siz hali hech qanday test yaratmagansiz.</b>\n\nBu bo'limda siz AI yordamida yoki o'zingiz qo'lda yaratgan shaxsiy testlaringiz saqlanadi.";
    return safeEdit(
      ctx,
      emptyMsg,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
        ]),
      },
    );
  }

  const itemsPerPage = 5;
  const totalPages = Math.ceil(userSubjects.length / itemsPerPage);
  const currentSubjects = userSubjects.slice(
    page * itemsPerPage,
    (page + 1) * itemsPerPage,
  );

  const buttons = currentSubjects.map((subj) => {
    return [
      Markup.button.callback(
        `📁 ${subj.name}  •  ${subj.block_count || 0} ta blok`,
        `manage_subj_${subj.id}`,
      ),
    ];
  });

  const navButtons = [];
  if (page > 0)
    navButtons.push(
      Markup.button.callback("⬅️ Oldingi", `my_tests_${page - 1}`),
    );
  if (page < totalPages - 1)
    navButtons.push(
      Markup.button.callback("Keyingi ➡️", `my_tests_${page + 1}`),
    );

  if (navButtons.length > 0) buttons.push(navButtons);
  buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);

  const totalBlocks = userSubjects.reduce((acc, s) => acc + (s.block_count || 0), 0);

  await safeEdit(
    ctx,
    `📂 <b>Mening Testlarim</b> (Sahifa ${page + 1}/${totalPages}):\n\nQaysi fan bo'yicha testlarni ko'rmoqchisiz?\n\n📊 Jami: ${userSubjects.length} ta fan, ${totalBlocks} ta test`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
  );
}

async function cbManageSubj(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const rawSuffix = parseSuffix(ctx.callbackQuery.data, "manage_subj_");
  const parts = rawSuffix.split("_");
  const refId = parts[0];
  const page = parseInt(parts[1], 10) || 0;

  let subject = await dbService.getSubjectById(refId);
  let subjTests = [];

  if (subject) {
    subjTests = await dbService.getSubjectBlocks(subject.id);
  } else {
    const testData = await dbService.getUserTest(refId);
    if (!testData) return;
    if (testData.subject_id) {
      subject = await dbService.getSubjectById(testData.subject_id);
      subjTests = await dbService.getSubjectBlocks(testData.subject_id);
    } else {
      const tests = await dbService.getUserCreatedTests(ctx.from.id);
      subjTests = naturalSortBlocks((tests || []).filter((t) => t.subject === testData.subject));
      subject = { id: refId, name: testData.subject };
    }
  }

  const subjectId = subject?.id || refId;
  const subjectName = subject?.name || 'Fan';
  const botInfo = await ctx.telegram.getMe();

  const PAGE_SIZE = 10;
  const totalPages = Math.ceil((subjTests || []).length / PAGE_SIZE) || 1;
  const currentPage = Math.max(0, Math.min(page, totalPages - 1));
  const pageSlice = (subjTests || []).slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const buttons = pageSlice.map((t) => [
    Markup.button.callback(
      `📝 ${t.block_name}  •  ${(t.questions || []).length} savol`,
      `manage_test_${t.id}`,
    ),
  ]);

  if (totalPages > 1) {
    const navRow = [];
    if (currentPage > 0) {
      navRow.push(Markup.button.callback("⬅️ Oldingi", `manage_subj_${refId}_${currentPage - 1}`));
    }
    navRow.push(Markup.button.callback(`${currentPage + 1} / ${totalPages}`, "noop"));
    if (currentPage < totalPages - 1) {
      navRow.push(Markup.button.callback("Keyingi ➡️", `manage_subj_${refId}_${currentPage + 1}`));
    }
    buttons.push(navRow);
  }

  const subjShareUrl = buildShareLink(botInfo.username, 's', subjectId);
  const groupSubjShareUrl = buildShareLink(botInfo.username, 's', subjectId, true);

  buttons.push([
    Markup.button.url(
      "🏃 Bu fanni guruhda Marafon qilish",
      groupSubjShareUrl,
    ),
  ]);
  buttons.push([
    Markup.button.callback("➕ Bu fanga blok qo'shish", `ct_exist_${subjectId}`),
  ]);
  buttons.push([Markup.button.callback("🔙 Mening Testlarimga", "my_tests")]);

  await safeEdit(
    ctx,
    `📚 <b>Fan:</b> ${escapeHtml(subjectName)}\n🔗 <b>Fan havolasi:</b>\n<code>${subjShareUrl}</code>\n\n📋 Bloklar:`,
    Markup.inlineKeyboard(buttons),
  );
}

async function cbManageTest(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery().catch(() => {});
  const testId = parseSuffix(ctx.callbackQuery.data, "manage_test_");
  const testData = await dbService.getUserTest(testId);
  if (!testData) return;
  const botInfo = await ctx.telegram.getMe();

  const testShareUrl = buildShareLink(botInfo.username, 't', testId);
  const groupTestShareUrl = buildShareLink(botInfo.username, 't', testId, true);

  await safeEdit(
    ctx,
    `📝 <b>Blok Ma'lumotlari</b>\n📚 Fan: <b>${escapeHtml(testData.subject)}</b>\n🔖 Blok: <b>${escapeHtml(testData.block_name)}</b>\n🔢 Savollar: <b>${(testData.questions || []).length} ta</b>\n\n🔗 <b>Havola:</b>\n<code>${testShareUrl}</code>`,
    Markup.inlineKeyboard([
      [
        Markup.button.url(
          "↗️ Guruhda o'ynash",
          groupTestShareUrl,
        ),
      ],
      [
        Markup.button.callback(
          "▶️ O'zim boshlash (Shaxsiy)",
          `ugc_start_${testId}`,
        ),
      ],
      [Markup.button.callback("✏️ Tahrirlash", `edit_test_${testId}`)],
      [Markup.button.callback("🗑 Blokni o'chirish", `delete_test_${testId}`)],
      [Markup.button.callback("🔙 Fanga qaytish", `manage_subj_${testData.subject_id || testId}`)],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]),
  );
}

async function cbDeleteTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const testId = parseSuffix(ctx.callbackQuery.data, "delete_test_");
  await safeEdit(
    ctx,
    `⚠️ <b>Ishonchingiz komilmi?</b>\n⛔ Bu amalni qaytarib bo'lmaydi!`,
    Markup.inlineKeyboard([
      [Markup.button.callback("✅ Ha, o'chiraman", `confirm_delete_${testId}`)],
      [Markup.button.callback("❌ Bekor qilish", `manage_test_${testId}`)],
    ]),
  );
}

async function cbConfirmDelete(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const testId = parseSuffix(ctx.callbackQuery.data, "confirm_delete_");
  await dbService.deleteUserTest(testId, ctx.from.id);
  await safeEdit(
    ctx,
    "✅ O'chirildi.",
    Markup.inlineKeyboard([
      [Markup.button.callback("📂 Mening Testlarim", "my_tests")],
    ]),
  );
}

module.exports = {
  cbCreateTest,
  cbCtNew,
  promptBlockNameOrAutoDocx,
  cbBackToBlockPrompt,
  onSubjectInput,
  cbCtExist,
  onNameInput,
  showDraftDashboard,
  cbBackToDashboard,
  cbFmt,
  sendFormatSelection,
  cbBackToFormats,
  cbParseModeSelect,
  showCreationStatusMenu,
  cbFinishCreation,
  cbCancelCreation,
  cbMyTests,
  cbManageSubj,
  cbManageTest,
  cbDeleteTest,
  cbConfirmDelete,
};
