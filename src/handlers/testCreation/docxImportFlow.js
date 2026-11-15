"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { Markup } = require("telegraf");
const dbService = require("../../services/dbService");
const logger = require("../../core/logger");
const {
  States,
  setState,
  updateData,
  getData,
  safeEdit,
  safeAnswerCb,
  escapeHtml,
  parseSuffix,
  parseDocxQuestions,
  downloadFile,
} = require("../../core/utils");
const { extractQuestionCandidates } = require("../../validators/testValidators");
const widgetService = require("../../services/widgetService");
const aiDocxHealer = require("../../services/aiDocxHealer");
const featureFlagService = require("../../services/featureFlagService");

async function cbAutoDocxInit(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx, States.CREATE_NAME);
  await updateData(ctx, {
    format: "docx",
    is_auto_docx: true,
  });

  await safeEdit(
    ctx,
    `📁 <b>Avto-yuklash (Katta Word Fayl)</b>\n\nFaylni yuklashdan oldin test nomini kiriting.\nBot avtomatik tarzda: <code>Nom (1-qism)</code>, <code>Nom (2-qism)</code> qilib 25 tadan bo'lib chiqadi.\n\n💡 <i>Masalan: Tarix Majburiy, Terapiya Yakuniy, 500 talik Baza</i>`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔙 Ortga (Fan tanlashga)",
            "back_to_block_prompt",
          ),
        ],
      ]),
    },
  );
}

async function onDocxFile(ctx) {
  const data = await getData(ctx);
  const doc = ctx.message.document;

  const validMime =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const MAX_FILE_SIZE = 2 * 1024 * 1024;

  if (!doc) return;

  if (!doc.file_name.endsWith(".docx") || doc.mime_type !== validMime) {
    return ctx.reply(
      "⚠️ <b>Xavfsizlik tizimi:</b> Faqat toza <code>.docx</code> (Word) formatidagi fayllar qabul qilinadi.",
      { parse_mode: "HTML" },
    );
  }

  if (doc.file_size > MAX_FILE_SIZE) {
    return ctx.reply(
      "⚠️ <b>Fayl hajmi juda katta!</b> Iltimos, xotirani ortiqcha zo'riqtirmaslik uchun 2 MB gacha bo'lgan fayl yuklang.",
      { parse_mode: "HTML" },
    );
  }

  let bName = data.block_name;
  if (!bName) {
    bName = doc.file_name
      .replace(/\.docx$/i, "")
      .replace(/_/g, " ")
      .replace(/[^\w\s\-\.\,\'\u0400-\u04FF\u0100-\u017F]/g, "")
      .trim()
      .substring(0, 50) || "Word Test";
    await updateData(ctx, { block_name: bName });
  }

  const statusMsg = await ctx.reply("⏳ Fayl o'qilmoqda...");
  const filePath = path.join(
    os.tmpdir(),
    `ugc_${ctx.from.id}_${Date.now()}.docx`,
  );

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    await downloadFile(link.href, filePath);

    const parsed = await parseDocxQuestions(
      filePath,
      data.parse_mode || "hash",
    );
    const validQs = parsed.valid || [];
    const invalidQs = parsed.invalid || [];

    if (validQs.length === 0 && invalidQs.length === 0) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        "❌ <b>Fayldan hech qanday savol topilmadi!</b>\n\nIltimos, Word fayl to'g'ri formatda ekanligini tekshirib, <b>boshqa fayl yuboring</b> (Men yana fayl kutyapman 👇).",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [
              Markup.button.callback(
                data.is_auto_docx
                  ? "🔙 Ortga (Format tanlashga)"
                  : "🔙 Panelga qaytish",
                data.is_auto_docx ? "auto_docx" : "back_to_dashboard",
              ),
            ],
          ]),
        },
      );
    }

    if (data.is_auto_docx) {
      const MAX_QUESTIONS = 300;
      let limitMsg = "";

      let finalValidQs = validQs;
      if (validQs.length > MAX_QUESTIONS) {
        finalValidQs = validQs.slice(0, MAX_QUESTIONS);
        limitMsg = `\n\n⚠️ <b>Limit himoyasi:</b> Tizim barqarorligini saqlash maqsadida fayldan faqat dastlabki ${MAX_QUESTIONS} ta savol qabul qilindi!`;
      }

      const chunks = [];
      for (let i = 0; i < finalValidQs.length; i += 25) {
        chunks.push(finalValidQs.slice(i, i + 25));
      }

      let startPart = 1;
      let existingBaseName = null;
      if (data.subject && ctx.from?.id) {
        try {
          const existingTests = await dbService.getUserCreatedTests(ctx.from.id, false);
          const subjectTests = (existingTests || []).filter((t) => t.subject === data.subject);
          let maxPart = 0;
          for (const t of subjectTests) {
            const name = t.block_name || "";
            const match = name.match(/(?:^|\D)(\d+)\s*-?\s*qism/i);
            if (match) {
              const num = parseInt(match[1], 10);
              if (num > maxPart) maxPart = num;
            }
          }
          if (maxPart > 0) {
            startPart = maxPart + 1;
          } else if (subjectTests.length > 0) {
            startPart = subjectTests.length + 1;
          }

          if (subjectTests.length > 0) {
            const baseMatches = subjectTests
              .map((t) => {
                const m = (t.block_name || "").match(/^(.*?)\s*\(\d+\s*-?\s*qism\)$/i);
                return m ? m[1].trim() : null;
              })
              .filter(Boolean);
            if (baseMatches.length > 0 && baseMatches.every((b) => b === baseMatches[0])) {
              existingBaseName = baseMatches[0];
            }
          }
        } catch (err) {
          logger.warn("startPart hisoblashda xatolik:", { error: err.message });
        }
      }

      const autoBlockName =
        data.block_name ||
        existingBaseName ||
        (doc.file_name ? doc.file_name.replace(/\.[^/.]+$/, "") : "Avto-test");
      await updateData(ctx, {
        chunks,
        invalidQs,
        questions: finalValidQs,
        block_name: autoBlockName,
        start_part: startPart,
      });

      await ctx.telegram
        .deleteMessage(ctx.chat.id, statusMsg.message_id)
        .catch(() => {});
      return showAutoDocxStatusMenu(ctx, chunks, invalidQs.length, limitMsg, startPart);
    } else {
      let finalQs = validQs;
      let limitMsg = "";

      if (validQs.length > 50) {
        finalQs = validQs.slice(0, 50);
        limitMsg = `\n\n⚠️ <b>Limit:</b> Bitta blok uchun maksimal 50 ta savol olindi. Kattaroq fayllar uchun asosiy menyudagi <b>"Avto-yuklash"</b> tugmasidan foydalaning.`;
      }

      const questions = [...(data.questions || []), ...finalQs];
      await updateData(ctx, {
        questions,
        invalidQs: [...(data.invalidQs || []), ...invalidQs],
      });

      await ctx.telegram
        .deleteMessage(ctx.chat.id, statusMsg.message_id)
        .catch(() => {});
      await ctx.reply(
        `✅ <b>Fayl muvaffaqiyatli o'qildi!</b> (Qo'shildi: ${finalQs.length} ta)${limitMsg}`,
        { parse_mode: "HTML" },
      );

      const wizardFlow = require("./wizardFlow");
      const questionEditor = require("./questionEditor");
      return data.is_editing ? questionEditor.showEditDashboard(ctx) : wizardFlow.showDraftDashboard(ctx);
    }
  } catch {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      "❌ Xatolik yuz berdi. Fayl buzilgan bo'lishi mumkin.",
    );
  } finally {
    if (fs.existsSync(filePath)) await fs.promises.unlink(filePath).catch(() => {});
  }
}

async function showAutoDocxStatusMenu(
  ctx,
  chunks,
  invalidCount,
  limitMsg = "",
  startPartOverride,
) {
  await updateData(ctx, {
    editing_question_index: undefined,
    fixing_error_index: undefined,
  });
  const data = await getData(ctx);
  const startPart = startPartOverride || data.start_part || 1;
  const buttons = chunks.map((chunk, index) => [
    Markup.button.callback(
      `📁 ${startPart + index}-qism (${chunk.length} ta savol)`,
      `preview_chunk_${index}_0`,
    ),
  ]);

  if (invalidCount > 0)
    buttons.push([
      Markup.button.callback(
        `⚠️ Xatolarni to'g'rilash (${invalidCount} ta)`,
        "fix_errors_0",
      ),
    ]);
  buttons.push([
    Markup.button.callback("✅ Barchasini saqlash", "finish_auto_docx"),
  ]);
  buttons.push([Markup.button.callback("❌ Bekor qilish", "cancel_creation")]);

  const totalValid = chunks.reduce((a, b) => a + b.length, 0);

  const text = `✅ <b>Fayl muvaffaqiyatli o'qildi!</b>\n\n📊 Jami to'g'ri savollar: <b>${totalValid} ta</b>\n⚠️ Xato formatlar: <b>${invalidCount} ta</b>${limitMsg}\n\n<i>Tizim savollaringizni quyidagi qismlarga ajratdi. Ichiga kirib tekshirishingiz mumkin:</i>`;

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
}

async function cbPreviewChunk(ctx) {
  await safeAnswerCb(ctx);
  const match = ctx.callbackQuery?.data?.match(/^preview_chunk_(\d+)_(\d+)$/);
  if (!match) return;

  const chunkIdx = parseInt(match[1], 10);
  const page = parseInt(match[2], 10) || 0;

  const data = await getData(ctx);
  const chunks = data.chunks || [];
  const chunk = chunks[chunkIdx];

  if (!chunk || chunk.length === 0) {
    return safeEdit(
      ctx,
      "⚠️ Ushbu qismda savollar topilmadi!",
      Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Qismlar ro'yxatiga", "show_status_menu")],
      ]),
    );
  }

  const ITEMS_PER_PAGE = 10;
  const totalPages = Math.ceil(chunk.length / ITEMS_PER_PAGE);
  const validPage = Math.max(0, Math.min(page, totalPages - 1));

  const startIdx = validPage * ITEMS_PER_PAGE;
  const endIdx = Math.min(startIdx + ITEMS_PER_PAGE, chunk.length);
  const currentQs = chunk.slice(startIdx, endIdx);

  let text = `📁 <b>${(data.start_part || 1) + chunkIdx}-qism savollari</b> (Jami: ${chunk.length} ta)\n<i>Sahifa: ${validPage + 1} / ${totalPages}</i>\n\n`;

  currentQs.forEach((q, i) => {
    const actualNum = startIdx + i + 1;
    const correctAns = q.options[q.correct_index] || "Noma'lum";
    text += `<b>${actualNum}.</b> ${escapeHtml(q.question)}\n✅ <i>Javob:</i> ${escapeHtml(correctAns)}\n\n`;
  });

  const buttons = [];
  const navRow = [];
  if (validPage > 0) {
    navRow.push(
      Markup.button.callback(
        "⬅️ Oldingi 10 ta",
        `preview_chunk_${chunkIdx}_${validPage - 1}`,
      ),
    );
  }
  if (validPage < totalPages - 1) {
    navRow.push(
      Markup.button.callback(
        "Keyingi 10 ta ➡️",
        `preview_chunk_${chunkIdx}_${validPage + 1}`,
      ),
    );
  }
  if (navRow.length > 0) buttons.push(navRow);

  buttons.push([
    Markup.button.callback("🔙 Qismlar ro'yxatiga", "show_status_menu"),
  ]);

  await safeEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
}

async function cbAutoDocx(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await updateData(ctx, {
    block_name: null,
    format: "docx",
    is_auto_docx: true,
  });

  await safeEdit(
    ctx,
    `⚙️ <b>Qaysi usulda o'qiymiz?</b>\n\nWord fayldagi testlarda to'g'ri javob qanday belgilangan?\n\n🎯 <b># bilan:</b> To'g'ri javob oldida # belgisi bor.\n🥇 <b>1-javob:</b> Har doim A (birinchi) variant to'g'ri.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🎯 To'g'ri javob oldida # bor",
            `parse_hash_docx`,
          ),
        ],
        [
          Markup.button.callback(
            "🥇 Har doim 1-javob to'g'ri",
            `parse_first_docx`,
          ),
        ],
        [
          Markup.button.callback(
            "🔙 Ortga (Blok yaratishga)",
            "back_to_block_prompt",
          ),
        ],
      ]),
    },
  );
}

async function cbFixErrors(ctx, targetIdx = null) {
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery().catch(() => {});
  }
  const idx = targetIdx !== null
    ? targetIdx
    : (parseInt(parseSuffix(ctx.callbackQuery?.data, "fix_errors_"), 10) || 0);
  const data = await getData(ctx);
  const invalidQs = data.invalidQs || [];

  if (invalidQs.length === 0 || idx >= invalidQs.length) {
    await updateData(ctx, { fixing_error_index: undefined });
    if (data.is_auto_docx && data.chunks) {
      return showAutoDocxStatusMenu(ctx, data.chunks, 0);
    }
    const wizardFlow = require("./wizardFlow");
    const questionEditor = require("./questionEditor");
    return data.is_editing ? questionEditor.showEditDashboard(ctx) : wizardFlow.showDraftDashboard(ctx);
  }

  const badText = invalidQs[idx];
  setState(ctx, States.CREATE_QUESTIONS);
  await updateData(ctx, { fixing_error_index: idx });

  const userId = ctx.from?.id;
  const isHealerEnabled = featureFlagService.isFeatureEnabledSync('FEATURE_DOCX_SMART_HEALER', userId);
  const backAction = data.is_auto_docx ? "show_status_menu" : "back_to_dashboard";

  if (!isHealerEnabled) {
    const text =
      `⚠️ <b>Xato Savolni To'g'rilash</b> (${idx + 1} / ${invalidQs.length})\n\n` +
      `Ushbu savol formatida xato bor (masalan, to'g'ri javob belgisi <code>#</code> unutilgan yoki variantlar kam).\n\n` +
      `<b>Matnni nusxalang (ustiga bossangiz nusxalanadi), to'g'rilang va menga qayta yuboring:</b>\n\n` +
      `<pre><code>${escapeHtml(badText)}</code></pre>`;

    return safeEdit(ctx, text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("⏭ O'tkazib yuborish", `fix_errors_${idx + 1}`),
          Markup.button.callback("🗑 O'chirish", `del_err_${idx}`),
        ],
        [Markup.button.callback("🔙 Ortga", backAction)],
      ]),
    });
  }

  const candidate = extractQuestionCandidates(badText);
  const options = candidate.options || [];

  let text =
    `⚠️ <b>Xato Savolni To'g'rilash</b> (${idx + 1} / ${invalidQs.length})\n\n` +
    `Savol matni:\n<b>${escapeHtml(candidate.questionText || badText)}</b>\n\n`;

  if (options.length >= 2) {
    text += `📋 <i>Variantlar aniqlandi. To'g'ri javobni 1 marta bosib tanlang:</i>\n\n`;
    options.forEach((opt, oIdx) => {
      const letter = String.fromCharCode(65 + oIdx);
      const isMarked = opt.isCorrect ? ' ✅' : '';
      text += `<b>${letter})</b> ${escapeHtml(opt.cleanText)}${isMarked}\n`;
    });
  } else {
    text +=
      `Ushbu savol formatida xato bor (variantlar kam yoki to'g'ri javob belgisi <code>#</code> unutilgan).\n\n` +
      `<i>1-Tap AI orqali avto-tuzatishingiz yoki Web Inspektorda ochishingiz mumkin:</i>\n\n` +
      `<pre><code>${escapeHtml(badText)}</code></pre>`;
  }

  const keyboardRows = [];

  if (options.length >= 2) {
    for (let i = 0; i < options.length; i += 2) {
      const row = [];
      const opt1 = options[i];
      const l1 = String.fromCharCode(65 + i);
      const short1 = (opt1.cleanText || opt1.text || '').slice(0, 16);
      row.push(Markup.button.callback(`✅ ${l1}) ${short1}`, `fix_pick_key_${idx}_${i}`));

      if (i + 1 < options.length) {
        const opt2 = options[i + 1];
        const l2 = String.fromCharCode(65 + i + 1);
        const short2 = (opt2.cleanText || opt2.text || '').slice(0, 16);
        row.push(Markup.button.callback(`✅ ${l2}) ${short2}`, `fix_pick_key_${idx}_${i + 1}`));
      }
      keyboardRows.push(row);
    }
  }

  keyboardRows.push([
    Markup.button.callback("✨ AI Barchasini Avto-Tuzatish", "fix_auto_all"),
    Markup.button.callback("🌐 Web Inspektor", "fix_open_inspector"),
  ]);

  keyboardRows.push([
    Markup.button.callback("⏭ O'tkazib yuborish", `fix_errors_${idx + 1}`),
    Markup.button.callback("🗑 O'chirish", `del_err_${idx}`),
  ]);

  keyboardRows.push([Markup.button.callback("🔙 Ortga", backAction)]);

  await safeEdit(ctx, text, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(keyboardRows),
  });
}

async function cbFixPickKey(ctx) {
  if (!featureFlagService.isFeatureEnabledSync('FEATURE_DOCX_SMART_HEALER', ctx.from?.id)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("ℹ️ Ushbu funksiya hozirda faol emas.", { show_alert: true }).catch(() => {});
    }
    return cbFixErrors(ctx);
  }
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery("✅ To'g'ri javob belgilandi!").catch(() => {});
  }
  const match = ctx.callbackQuery?.data?.match(/^fix_pick_key_(\d+)_(\d+)/);
  if (!match) return cbFixErrors(ctx);

  const idx = parseInt(match[1], 10);
  const optIdx = parseInt(match[2], 10);

  const data = await getData(ctx);
  const invalidQs = data.invalidQs || [];
  if (idx < 0 || idx >= invalidQs.length) return cbFixErrors(ctx);

  const badText = invalidQs[idx];
  const candidate = extractQuestionCandidates(badText);

  if (!candidate.options || candidate.options.length < 2 || optIdx >= candidate.options.length) {
    return cbFixErrors(ctx);
  }

  const healedQuestion = {
    question: candidate.questionText || badText.trim(),
    options: candidate.options.map(o => o.cleanText || o.text),
    correct_index: optIdx,
  };

  const questions = [...(data.questions || []), healedQuestion];
  invalidQs.splice(idx, 1);

  if (data.is_auto_docx) {
    const chunks = [];
    for (let i = 0; i < questions.length; i += 25) {
      chunks.push(questions.slice(i, i + 25));
    }
    await updateData(ctx, { questions, invalidQs, chunks });
  } else {
    await updateData(ctx, { questions, invalidQs });
  }

  return cbFixErrors(ctx, idx);
}

async function cbFixAutoAll(ctx) {
  if (!featureFlagService.isFeatureEnabledSync('FEATURE_DOCX_SMART_HEALER', ctx.from?.id)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("ℹ️ Ushbu funksiya hozirda faol emas.", { show_alert: true }).catch(() => {});
    }
    return cbFixErrors(ctx);
  }
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery("⏳ AI avto-tuzatmoqda...").catch(() => {});
  }
  const data = await getData(ctx);
  const invalidQs = data.invalidQs || [];
  if (!invalidQs.length) {
    return ctx.reply("ℹ️ Tuzatish uchun xato savollar mavjud emas.");
  }

  const questions = data.questions || [];
  const res = await aiDocxHealer.batchAutoHeal(invalidQs, process.env.GEMINI_API_KEY);
  const healed = res.healed || [];
  const remaining = res.remainingInvalid || [];

  if (healed.length > 0) {
    questions.push(...healed);
  }

  if (data.is_auto_docx) {
    const chunks = [];
    for (let i = 0; i < questions.length; i += 25) {
      chunks.push(questions.slice(i, i + 25));
    }
    await updateData(ctx, { questions, invalidQs: remaining, chunks });
  } else {
    await updateData(ctx, { questions, invalidQs: remaining });
  }

  const { showDraftDashboard } = require("./wizardFlow");
  const { showEditDashboard } = require("./questionEditor");

  if (remaining.length === 0) {
    await ctx.reply(`✨ AI barcha ${healed.length} ta savolni muvaffaqiyatli tuzatdi va testga qo'shdi!`);
    if (data.is_auto_docx && data.chunks) {
      return showAutoDocxStatusMenu(ctx, data.chunks, 0);
    }
    return data.is_editing ? showEditDashboard(ctx) : showDraftDashboard(ctx);
  } else {
    await ctx.reply(`✨ AI ${healed.length} ta savolni tuzatdi. ${remaining.length} ta savol qo'lda ko'rib chiqishni talab qiladi.`);
    return cbFixErrors(ctx, 0);
  }
}

// Launch interactive HTML Web Inspector Widget
async function cbOpenInspector(ctx) {
  if (!featureFlagService.isFeatureEnabledSync('FEATURE_DOCX_SMART_HEALER', ctx.from?.id)) {
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery("ℹ️ Ushbu funksiya hozirda faol emas.", { show_alert: true }).catch(() => {});
    }
    return cbFixErrors(ctx);
  }
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery().catch(() => {});
  }
  const data = await getData(ctx);
  const invalidQs = data.invalidQs || [];

  if (!invalidQs.length) {
    return ctx.reply("ℹ️ Tekshirish uchun xato savollar qolmadi.");
  }

  const widgetQuestions = invalidQs.map((raw, i) => {
    const cand = extractQuestionCandidates(raw);
    return {
      id: i + 1,
      questionText: cand.questionText || raw,
      raw,
      error: cand.options.length < 2 ? "Variantlar yetarli emas" : "To'g'ri javob kaliti belgilanmagan",
      options: (cand.options.length >= 2 ? cand.options : [
        { text: "Variant A", cleanText: "Variant A", isCorrect: false },
        { text: "Variant B", cleanText: "Variant B", isCorrect: false },
      ]).map((o, oi) => ({
        text: o.cleanText || o.text,
        isCorrect: cand.suggestedCorrectIdx === oi || Boolean(o.isCorrect),
      })),
    };
  });

  const userId = ctx.from?.id || 0;
  const isWidgetEngine = featureFlagService.isFeatureEnabledSync('FEATURE_WIDGET_ENGINE', userId);
  let widgetSent = false;

  // Try native Telegram Bot API 10.4 sendWidget in private chats
  const isSendWidgetAllowed = typeof widgetService.isNativeSendWidgetAllowed === 'function' ? widgetService.isNativeSendWidgetAllowed() : true;
  if (isWidgetEngine && isSendWidgetAllowed && ctx.chat?.type === 'private' && ctx.telegram && typeof ctx.telegram.callApi === 'function') {
    try {
      const inlineDocxHtml = widgetService.buildInlineDocxHealerWidgetHtml({
        questions: widgetQuestions,
        currentIndex: 0,
        total: widgetQuestions.length,
        fileName: data.block_name || 'test.docx',
      });
      const safePublicData = JSON.stringify({
        total: widgetQuestions.length,
        curIdx: 0,
        title: data.block_name || 'Docx Healer',
      });
      const safeChatData = JSON.stringify({
        userId,
        curIdx: 0,
      });

      const widgetPayload = {
        chat_id: ctx.chat.id,
        html: inlineDocxHtml,
        public_data: safePublicData,
        chat_data: safeChatData,
        is_shared: true,
        allow_queries: true,
      };

      const widgetKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("✨ AI Avto-Tuzatish", "fix_auto_all"),
          Markup.button.callback("💾 Yakunlash", "finish_test_creation"),
        ],
        [
          Markup.button.callback("🔙 Menyuga qaytish", data.is_auto_docx ? "show_status_menu" : "back_to_dashboard"),
        ],
      ]);

      if (widgetKeyboard?.reply_markup) {
        widgetPayload.reply_markup = widgetKeyboard.reply_markup;
      }

      const widgetRes = await ctx.telegram.callApi('sendWidget', widgetPayload);
      if (widgetRes && widgetRes.message_id) {
        widgetSent = true;
        await updateData(ctx, { docx_widget_msg_id: widgetRes.message_id });
        if (ctx.callbackQuery?.message) {
          await ctx.deleteMessage().catch(() => {});
        }
        return;
      }
    } catch (err) {
      const isNotAllowed = String(err?.message || '').includes('INPUT_MEDIA_WIDGET_NOT_ALLOWED');
      if (isNotAllowed) {
        if (typeof widgetService.markSendWidgetNotAllowed === 'function') {
          widgetService.markSendWidgetNotAllowed(60 * 60 * 1000);
        }
        logger.info('Telegram Bot API: native sendWidget is not whitelisted for docxHealer. Seamlessly using WebApp inspector.');
      } else {
        try {
          const featureFlagService = require('../../services/featureFlagService');
          featureFlagService.recordFeatureError('FEATURE_DOCX_SMART_HEALER', err);
        } catch {}
        logger.warn('sendWidget for docxHealer failed, falling back to WebApp message:', err.message);
      }
    }
  }

  const widgetMsg = widgetService.buildWidgetMessage(
    'docxHealer',
    {
      userId,
      title: "Docx Smart Healer",
      questions: widgetQuestions,
    },
    `🔧 <b>Smart Docx Visual Healer & Xatoliklar Inspektori</b>\n\n` +
    `Aniqlangan xatoliklar: <b>${invalidQs.length} ta</b>\n` +
    `To'g'ri javoblarni qulay interaktiv ko'rinishda belgilang yoki 1-bosishda AI yordamida tuzating:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🔙 Menyuga qaytish", data.is_auto_docx ? "show_status_menu" : "back_to_dashboard")],
    ]),
    { userId }
  );

  return safeEdit(ctx, widgetMsg.text, {
    parse_mode: "HTML",
    reply_markup: widgetMsg.reply_markup,
  });
}

/**
 * Creates safe, compact widget public data strictly bounded under 1024 bytes
 * to satisfy Telegram Bot API 10.4 sendWidget / editMessageWidgetData limits.
 */
function makeSafeDocxWidgetPublicData(remainingInvalid, curIdx = 0, blockName = 'Docx Healer') {
  const total = Array.isArray(remainingInvalid) ? remainingInvalid.length : 0;
  const safeIdx = Math.min(Math.max(0, curIdx), Math.max(0, total - 1));
  let currentQuestion = null;

  if (total > 0 && remainingInvalid[safeIdx]) {
    const raw = remainingInvalid[safeIdx];
    const cand = extractQuestionCandidates(raw);
    currentQuestion = {
      id: safeIdx + 1,
      q: String(cand.questionText || raw).slice(0, 240),
      err: cand.options.length < 2 ? "Variantlar kam" : "To'g'ri javob belgilanmagan",
      opts: (cand.options || []).slice(0, 6).map(o => ({
        t: String(o.cleanText || o.text || '').slice(0, 75),
        ok: Boolean(o.isCorrect),
      })),
    };
  }

  const payload = {
    title: String(blockName || 'Docx Healer').slice(0, 50),
    remaining: total,
    curIdx: safeIdx,
    isFinished: total === 0,
    currentQuestion,
  };

  return JSON.stringify(payload);
}

/**
 * Handles incoming `widget_query` for Docx Healer from Telegram Bot API 10.4.
 *
 * @param {object} ctx - Telegraf context
 * @param {object} query - widget_query object
 */
async function handleDocxWidgetQuery(ctx, query) {
  if (!query) return;

  const userId = query.from?.id || ctx.from?.id;
  const rawAction = String(query.data || '').trim();

  let action = 'docx_pick';
  let qIdx = 0;
  let optIdx = null;

  try {
    if (rawAction.startsWith('{')) {
      const parsed = JSON.parse(rawAction);
      action = parsed.action || parsed.a || 'docx_pick';
      qIdx = typeof parsed.qIdx === 'number' ? parsed.qIdx : 0;
      optIdx = typeof parsed.optIdx === 'number' ? parsed.optIdx : null;
    } else {
      action = rawAction;
    }
  } catch {}

  const fakeCtx = { from: { id: userId }, chat: { id: query.chat?.id || ctx.chat?.id || userId }, session: ctx.session };
  const data = await getData(fakeCtx);
  const invalidQs = Array.isArray(data.invalidQs) ? [...data.invalidQs] : [];
  const questions = Array.isArray(data.questions) ? [...data.questions] : [];

  if (action === 'docx_pick' && optIdx !== null && qIdx >= 0 && qIdx < invalidQs.length) {
    const badText = invalidQs[qIdx];
    const cand = extractQuestionCandidates(badText);
    const opts = (cand.options && cand.options.length >= 2)
      ? cand.options.map(o => o.cleanText || o.text)
      : [];

    if (opts.length >= 2 && optIdx >= 0 && optIdx < opts.length) {
      const resolved = {
        question: cand.questionText || badText.split('\n')[0].replace(/^(\d+[\)\.]|№\s*\d+[\)\.]?)\s*/, '').trim(),
        options: opts,
        correct_index: optIdx,
      };
      questions.push(resolved);
      invalidQs.splice(qIdx, 1);

      const chunks = [];
      if (data.is_auto_docx) {
        for (let i = 0; i < questions.length; i += 25) {
          chunks.push(questions.slice(i, i + 25));
        }
      }
      await updateData(fakeCtx, {
        questions,
        invalidQs,
        ...(data.is_auto_docx ? { chunks } : {}),
      });
    }
  } else if (action === 'docx_heal_all' && invalidQs.length > 0) {
    const healRes = await aiDocxHealer.batchAutoHeal(invalidQs, process.env.GEMINI_API_KEY);
    const healed = healRes.healed || [];
    const remaining = healRes.remainingInvalid || [];

    if (healed.length > 0) {
      questions.push(...healed);
      const chunks = [];
      if (data.is_auto_docx) {
        for (let i = 0; i < questions.length; i += 25) {
          chunks.push(questions.slice(i, i + 25));
        }
      }
      await updateData(fakeCtx, {
        questions,
        invalidQs: remaining,
        ...(data.is_auto_docx ? { chunks } : {}),
      });
    }
  }

  // Build updated compact widget data (<= 1024 bytes)
  const updatedData = await getData(fakeCtx);
  const remainingInvalid = updatedData.invalidQs || [];
  const nextCurIdx = Math.min(qIdx, Math.max(0, remainingInvalid.length - 1));
  const newPublicData = makeSafeDocxWidgetPublicData(
    remainingInvalid,
    nextCurIdx,
    updatedData.block_name || 'Docx Healer'
  );

  const chatId = query.message?.chat?.id || query.chat?.id || ctx.chat?.id || userId;
  const messageId = query.message?.message_id || query.message_id || updatedData.docx_widget_msg_id;

  if (chatId && messageId && ctx.telegram && typeof ctx.telegram.callApi === 'function') {
    await ctx.telegram.callApi('editMessageWidgetData', {
      chat_id: chatId,
      message_id: messageId,
      public_data: newPublicData,
      chat_data: newPublicData,
    }).catch(err => logger.debug('editMessageWidgetData error (docx):', err.message));
  }

  if (ctx.telegram && typeof ctx.telegram.callApi === 'function') {
    await ctx.telegram.callApi('answerWidgetQuery', {
      widget_query_id: query.id,
      data: newPublicData,
    }).catch(() => {});
  }
}

async function handleDocxSharedWidgetQuery(ctx, query) {
  return handleDocxWidgetQuery(ctx, query);
}

// Xatoni to'g'rilamasdan, umuman o'chirib yuborish
async function cbDeleteError(ctx) {
  await ctx.answerCbQuery("🗑 O'chirildi!").catch(() => {});
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "del_err_"), 10);
  const data = await getData(ctx);
  const invalidQs = data.invalidQs || [];

  if (idx >= 0 && idx < invalidQs.length) {
    invalidQs.splice(idx, 1);
    await updateData(ctx, { invalidQs });
  }

  // Xuddi shu indeksdagi keyingi xatoni ko'rsatamiz (chunki massiv siljidi)
  ctx.callbackQuery.data = `fix_errors_${idx}`;
  return cbFixErrors(ctx);
}

module.exports = {
  cbAutoDocxInit,
  onDocxFile,
  showAutoDocxStatusMenu,
  cbPreviewChunk,
  cbAutoDocx,
  cbFixErrors,
  cbFixPickKey,
  cbFixAutoAll,
  cbOpenInspector,
  makeSafeDocxWidgetPublicData,
  handleDocxWidgetQuery,
  handleDocxSharedWidgetQuery,
  cbDeleteError,
};
