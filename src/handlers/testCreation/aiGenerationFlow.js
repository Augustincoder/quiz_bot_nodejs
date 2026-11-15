"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { Markup } = require("telegraf");
const {
  States,
  setState,
  updateData,
  getData,
  safeEdit,
  parseSuffix,
} = require("../../core/utils");

const AI_WARNING_TEXT = `\n\n⚠️ <b>Eslatma:</b> <i>Bu javoblar tezkor AI modellarida tayyorlanmoqda va xatolar ehtimolligi bor. Rasmiy imtihonga tayyorlanayotganlar yoki Pro modellar uchun adminga murojaat qiling:</i> @AvazovM`;

// Matn va savollar soni nisbatini tekshirish (1 savol = 8 so'z)
function validateAiRequest(text, requestedCount) {
  if (requestedCount === "auto") return { valid: true };

  const wordCount = text.trim().split(/\s+/).length;
  const count = parseInt(requestedCount, 10);
  const minWordsRequired = count * 8;

  if (wordCount < minWordsRequired) {
    return {
      valid: false,
      message: `⚠️ <b>Matn juda qisqa!</b>\n\nSiz ${count} ta savol so'radingiz, lekin matnda atigi ${wordCount} ta so'z bor. Sifatli test chiqishi uchun kamida ${minWordsRequired} ta so'z bo'lishi kerak.\n\nIltimos, uzunroq matn yuboring yoki kamroq savol so'rang.`,
    };
  }
  return { valid: true };
}

// Sanoqni so'rash menyusi
async function promptQuestionCount(ctx) {
  const data = await getData(ctx);

  await safeEdit(
    ctx,
    `🔢 <b>Nechta savol tuzamiz?</b>\n\nO'zingizga kerakli savollar sonini tanlang yoki AI o'zi matnga qarab munosib miqdorda tuzsin.`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("5 ta", "ai_cnt_5"),
          Markup.button.callback("10 ta", "ai_cnt_10"),
        ],
        [
          Markup.button.callback("15 ta", "ai_cnt_15"),
          Markup.button.callback("20 ta", "ai_cnt_20"),
        ],
        [Markup.button.callback("25 ta", "ai_cnt_25")],
        [Markup.button.callback("🤖 Matnga mos (Avto)", "ai_cnt_auto")],
        [
          Markup.button.callback(
            "🔙 Orqaga",
            data?.is_editing ? "back_to_edit_dash" : "fmt_ai",
          ),
        ],
      ]),
    },
  );
}

async function cbAiModeQuestions(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx, States.CREATE_AI_QUESTIONS);
  await safeEdit(
    ctx,
    `❓ *Savollardan test yasash*\n\nOchiq savollarni ro'yxat qilib yuboring.` +
      AI_WARNING_TEXT +
      `\n\n_Fikringizdan qaytgan bo'lsangiz, Ortga tugmasini bosing._`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Ortga (AI menyusiga)", "fmt_ai")],
      ]),
    },
  );
}

async function cbAiCount(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const count = parseSuffix(ctx.callbackQuery.data, "ai_cnt_");
  const data = await getData(ctx);
  const mode = data.ai_mode_pending;

  await updateData(ctx, { ai_count: count });
  const countText =
    count === "auto" ? "munosib miqdorda" : `aniq <b>${count} ta</b>`;

  const backBtn = [Markup.button.callback("🔙 Ortga (AI menyusiga)", "fmt_ai")];

  if (mode === "text") {
    setState(ctx, States.CREATE_AI_TEXT);
    await safeEdit(
      ctx,
      `📄 <b>Matndan test yasash</b>\n\nO'quv matnini (konspektni) shu yerga yuboring. AI ${countText} savol tuzib beradi.${AI_WARNING_TEXT}\n\n<i>Boshqa format tanlash uchun Ortga qayting.</i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([backBtn]) },
    );
  } else if (mode === "image") {
    setState(ctx, States.CREATE_AI_IMAGE);
    await safeEdit(
      ctx,
      `📸 <b>Rasmdan test yasash</b>\n\nKitob yoki matn rasmini yuboring. AI ${countText} savol tuzib beradi.${AI_WARNING_TEXT}\n\n<i>Boshqa format tanlash uchun Ortga qayting.</i>`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([backBtn]) },
    );
  }
}

async function cbAiModeText(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await updateData(ctx, { ai_mode_pending: "text" });
  await promptQuestionCount(ctx);
}

async function cbAiModeImage(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await updateData(ctx, { ai_mode_pending: "image" });
  await promptQuestionCount(ctx);
}

async function onAiTextInput(ctx) {
  const text = ctx.message.text;
  const data = await getData(ctx);

  const validation = validateAiRequest(text, data.ai_count);
  if (!validation.valid)
    return ctx.reply(validation.message, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Ortga (AI menyusiga)", "fmt_ai")],
      ]),
    });

  const msg = await ctx.reply("⏳ <i>AI matnni tahlil qilmoqda...</i>", {
    parse_mode: "HTML",
  });
  const aiService = require("../../services/aiService");
  const generatedQuestions = await aiService.generateQuizFromText(
    text,
    data.ai_count,
  );
  await processAiResult(ctx, msg.message_id, generatedQuestions);
}

async function onAiQuestionsInput(ctx) {
  const text = ctx.message.text;
  if (!text || text.length < 10) return ctx.reply("⚠️ Savollarni kiriting.");
  const msg = await ctx.reply("⏳ *AI javoblar tuzmoqda...*", {
    parse_mode: "Markdown",
  });
  const aiService = require("../../services/aiService");
  const generatedQuestions = await aiService.generateOptionsForQuestions(text);
  await processAiResult(ctx, msg.message_id, generatedQuestions);
}

async function onAiImageInput(ctx) {
  const photoArray = ctx.message.photo;
  if (!photoArray || photoArray.length === 0)
    return ctx.reply("⚠️ Iltimos, kitob yoki matnning rasmini yuboring.");

  const msg = await ctx.reply("⏳ *AI rasmni o'qimoqda va test tuzmoqda...*", {
    parse_mode: "Markdown",
  });

  const photo = photoArray[photoArray.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);
  const filePath = path.join(os.tmpdir(), `ai_img_${Date.now()}.jpg`);

  try {
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      https
        .get(fileLink.href, (res) => {
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
        })
        .on("error", reject);
    });

    const aiService = require("../../services/aiService");
    const data = await getData(ctx);
    const generatedQuestions = await aiService.generateQuizFromImage(
      filePath,
      "image/jpeg",
      data.ai_count,
    );

    await processAiResult(ctx, msg.message_id, generatedQuestions);
  } catch (e) {
    console.error("Rasm qabul qilishda xato:", e);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      "❌ Rasmni o'qishda xatolik yuz berdi. Iltimos qaytadan urinib ko'ring yoki Ortga qayting.",
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Ortga", "fmt_ai")],
        ]),
      },
    );
  } finally {
    if (filePath) await fs.promises.unlink(filePath).catch(() => {});
  }
}

async function processAiResult(ctx, msgId, generatedQuestions) {
  if (!generatedQuestions || !generatedQuestions.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      msgId,
      undefined,
      "❌ AI test tuzishda xato qildi. Boshqa matn bilan urinib ko'ring yoki Ortga qayting.",
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Ortga (AI menyusiga)", "fmt_ai")],
        ]),
      },
    );
  }
  const data = await getData(ctx);
  const questions = [...(data.questions || []), ...generatedQuestions];
  const subject = data.subject || "🤖 AI Smart Quiz";
  const block_name = data.block_name || "1-Blok";
  await updateData(ctx, { questions, subject, block_name });
  setState(ctx, States.CREATE_QUESTIONS);

  const finishAction = data.is_editing
    ? "back_to_edit_dash"
    : "back_to_dashboard";
  const finishText = data.is_editing
    ? "🔙 Tahrirlash paneliga (Yakunlash)"
    : "🔙 Asosiy Panelga (Yakunlash)";

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    msgId,
    undefined,
    `✅ *Savollar qo'shildi!*\n📊 Jami: *${questions.length} ta*\n\n_Yana yuborishingiz yoki yakunlash uchun Ortga qaytishingiz mumkin._`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback(finishText, finishAction)],
      ]),
    },
  );
}

module.exports = {
  AI_WARNING_TEXT,
  validateAiRequest,
  promptQuestionCount,
  cbAiModeQuestions,
  cbAiCount,
  cbAiModeText,
  cbAiModeImage,
  onAiTextInput,
  onAiQuestionsInput,
  onAiImageInput,
  processAiResult,
};
