"use strict";

const fs = require("fs");
const path = require("path");
const { Markup } = require("telegraf");
const os = require("os");
const dbService = require("../services/dbService");
const {
  States,
  setState,
  clearState,
  updateData,
  getData,
  getState,
  safeEdit,
  safeDelete,
  backToMainKb,
  progressBar,
  parseSuffix,
  parseDocxQuestions,
  parseTextQuestions,
} = require("../core/utils");
const {
  SubjectSchema,
  BlockNameSchema,
  escapeMarkdown,
} = require("../validators/testValidators");
const AI_WARNING_TEXT = `\n\n⚠️ *Eslatma:* _Bu javoblar tezkor AI modellarida tayyorlanmoqda va xatolar ehtimolligi bor. Rasmiy imtihonga tayyorlanayotganlar yoki Pro modellar uchun adminga murojaat qiling:_ @AvazovM`;

// Input uzunligi chegaralari
const MAX_SUBJECT_LEN = 50;
const MAX_BLOCK_LEN = 50;

// ─── TUGMALAR GENERATORI ─────────────────────────────────────
function questionsSummaryKb() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🤖 AI test", "fmt_ai"),
      Markup.button.callback("📊 Quiz qo'shish", "fmt_quiz"),
    ],
    [
      Markup.button.callback("📝 Matn orqali", "fmt_text"),
      Markup.button.callback("📄 Docx fayl", "fmt_docx"),
    ],
    [Markup.button.callback("👁 Savollarni ko'rib chiqish", "preview_q_0")],
    [Markup.button.callback("✅ Yakunlash va Saqlash", "finish_test_creation")],
    [Markup.button.callback("❌ Bekor qilish", "cancel_creation")],
    [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
  ]);
}

function getDynamicKb(data) {
  if (data.is_editing) {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🔙 Tahrirlash paneliga qaytish",
          "back_to_edit_dash",
        ),
      ],
    ]);
  }
  return questionsSummaryKb();
}

function cancelKb(cb = "cancel_creation") {
  return Markup.inlineKeyboard([
    [Markup.button.callback("❌ Bekor qilish", cb)],
  ]);
}

const FORMAT_INSTRUCTIONS = {
  quiz: "📊 *Quiz Formati*\n\nTelegram'ning o'z quiz funksiyasidan foydalaning:\n\n1️⃣ 📎 (Biriktirish) belgisini bosing\n2️⃣ *Poll* → *Quiz* rejimini tanlang\n3️⃣ Savol va javob variantlarini kiriting\n4️⃣ To'g'ri javobni belgilab yuboring\n\n💡 _Har bir quiz ayrima xabar sifatida yuboriladi._",
  text: "📝 *Matn Formati*\n\nQuyidagi ko'rinishda yuboring (bir yoki bir nechta savol):\n```\nO'zbekiston poytaxti qayer?\n#Toshkent\nSamarqand\nBuxoro\nNamangan\n```\n\n💡 _To'g'ri javob oldiga # belgisi qo'yiladi. Savollar orasiga bo'sh qator qo'shing._",
  docx: "📄 *Word (.docx) Formati*\n\nFaylni quyidagicha tayyorlang:\n```\nSavol matni?\n#To'g'ri javob\nNoto'g'ri javob 1\nNoto'g'ri javob 2\nNoto'g'ri javob 3\n```\n\n💡 _Har bir savolda 2–6 ta javob varianti bo'lishi kerak. Tayyor .docx faylni shu chatga yuboring._",
};

// ─── TAHRIRLASH DASHBOARD ────────────────────────────────────
async function showEditDashboard(ctx) {
  const data = await getData(ctx);
  const questions = data.questions || [];
  const bar = progressBar(Math.min(questions.length, 50), 50);

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("➕ Yangi savol qo'shish", "edit_add_q")],
    [
      Markup.button.callback(
        `👁/🗑 Savollarni ko'rish va o'chirish`,
        "preview_q_0",
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
    `✏️ *Testni Tahrirlash*\n\n📚 Fan: ${data.subject}\n📝 Blok: ${data.block_name}\n📊 Jami savollar: *${questions.length} ta*\n${bar}\n\nQuyidagi menyudan kerakli amalni tanlang:`,
    { parse_mode: "Markdown", ...kb },
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
    block_name: testData.block_name,
    questions: testData.questions || [],
    is_editing: true,
  });
  setState(ctx, States.CREATE_QUESTIONS);
  await showEditDashboard(ctx);
}

async function cbBackToEditDash(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx, States.CREATE_QUESTIONS);
  await showEditDashboard(ctx);
}

async function cbEditAddQ(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(
    ctx,
    `📝 *Yangi savol formatini tanlang:*\n\n⬇️ Qaysi usulda savol qo'shmoqchisiz?`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🤖 AI Smart Quiz (Avtomatik)", "fmt_ai")],
      [Markup.button.callback("📊 Telegram Quiz", "fmt_quiz")],
      [Markup.button.callback("📝 Matn ko'rinishida", "fmt_text")],
      [Markup.button.callback("📄 Word fayl (.docx)", "fmt_docx")],
      [Markup.button.callback("🔙 Tahrirlash paneliga", "back_to_edit_dash")],
    ]),
  );
}

// ─── 1. YANGI TEST YARATISH BOSQICHLARI ──────────────────────
async function cbCreateTest(ctx) {
  clearState(ctx);
  // Toast xabar: Foydalanuvchiga tugma ishlaganini bildiramiz
  await ctx.answerCbQuery("✅ Test yaratish bo'limi ochildi!").catch(() => {});

  const tests = await dbService.getUserCreatedTests(ctx.from.id);
  const subjects = {};
  for (const t of tests) {
    if (!subjects[t.subject]) subjects[t.subject] = [];
    subjects[t.subject].push(t);
  }

  const buttons = [];
  if (Object.keys(subjects).length > 0) {
    buttons.push([
      Markup.button.callback("── Mavjud fanlar (Tezkor tanlash) ──", "ignore"),
    ]);
    for (const [subj, subTests] of Object.entries(subjects)) {
      buttons.push([
        Markup.button.callback(
          `📁 ${subj}  •  ${subTests.length} ta blok`,
          `ct_exist_${subTests[0].id}`,
        ),
      ]);
    }
    buttons.push([Markup.button.callback("➕ Yangi fan yaratish", "ct_new")]);
  } else {
    buttons.push([
      Markup.button.callback("➕ Birinchi fanimni yarataman", "ct_new"),
    ]);
  }
  buttons.push([Markup.button.callback("🔙 Asosiy Menyu", "back_to_main")]);

  await safeEdit(
    ctx,
    "✏️ *Test Yaratish*\n\nO'z shaxsiy testingizni yarating va do'stlaringiz bilan ulashing!\n\n💡 *Qanday ishlaydi:*\n1️⃣ Fan va blok nomini kiriting\n2️⃣ Savollarni matn, Word fayl, yoki AI orqali qo'shing\n3️⃣ Tayyor testni havola orqali ulashing\n\n👇 Boshlash uchun fan tanlang yoki yangi yarating:",
    Markup.inlineKeyboard(buttons),
  );
}

async function cbCtNew(ctx) {
  await ctx.answerCbQuery("📍 1-qadamga o'tildi").catch(() => {});
  setState(ctx, States.CREATE_SUBJECT);
  await safeEdit(
    ctx,
    "📍 *[1/3] Bosqich: Fan tanlash*\n\n━━━━━━━━━━━━━━━━\nYangi fan nomini kiriting.\n\n💡 _Masalan: Ona tili, Tarix 1-qism, Kardiologiya_\n\n⚠️ Uzunligi: 2–50 belgi.",
    cancelKb(),
  );
}

async function cbCtExist(ctx) {
  const refId = parseSuffix(ctx.callbackQuery.data, "ct_exist_");
  const testData = await dbService.getUserTest(refId);
  if (!testData)
    return ctx.answerCbQuery("❌ Fan topilmadi", { show_alert: true });

  await ctx.answerCbQuery(`✅ ${testData.subject} tanlandi`).catch(() => {});

  await updateData(ctx, { subject: testData.subject });
  setState(ctx, States.CREATE_NAME);
  await safeEdit(
    ctx,
    `✅ Fan: *${testData.subject}*\n\n📍 *[2/3] Bosqich: Blok yaratish*\n\n━━━━━━━━━━━━━━━━\nUshbu fan uchun yangi blok nomini kiriting.\n\n💡 _Masalan: 1-Mavzu, Yakuniy test, 1-variant_`,
    cancelKb(),
  );
}

async function onSubjectInput(ctx) {
  const result = SubjectSchema.safeParse(ctx.message.text || "");

  if (!result.success) {
    return ctx.reply(
      `❌ ${result.error.errors[0].message}\n\n💡 Iltimos, qaytadan kiriting:`,
    );
  }
  if (!ctx.session || !ctx.session.data) {
    clearState(ctx);
    return ctx.reply(
      "⏳ Sessiya muddati tugadi. Iltimos, /start ni bosing.",
      backToMainKb(),
    );
  }

  const subject = result.data;
  await updateData(ctx, { subject });
  setState(ctx, States.CREATE_NAME);
  const safeSubject = escapeMarkdown(subject);

  await ctx.reply(
    `✅ Fan nomi qabul qilindi: *${safeSubject}*\n\n📍 *[2/3] Bosqich: Blok yaratish*\n\n━━━━━━━━━━━━━━━━\nBlok nomini kiriting (1–50 belgi).\n\n💡 _Masalan: 1-Bob, Midterm savollar, Laboratoriya_`,
    { parse_mode: "Markdown", ...cancelKb() },
  );
}

async function onNameInput(ctx) {
  const result = BlockNameSchema.safeParse(ctx.message.text || "");

  if (!result.success) {
    return ctx.reply(
      `❌ ${result.error.errors[0].message}\n\n💡 Iltimos, qaytadan kiriting:`,
    );
  }
  if (!ctx.session || !ctx.session.data) {
    clearState(ctx);
    return ctx.reply(
      "⏳ Sessiya muddati tugadi. Iltimos, /start ni bosing.",
      backToMainKb(),
    );
  }

  const block_name = result.data;
  await updateData(ctx, { block_name });
  setState(ctx, States.CREATE_QUESTIONS);
  const safeBlockName = escapeMarkdown(block_name);

  await ctx.reply(
    `✅ Blok saqlandi: *${safeBlockName}*\n\n📍 *[3/3] Bosqich: Savollar qo'shish*\n\n━━━━━━━━━━━━━━━━\nQuyidagi usullardan birini tanlang:\n🤖 *AI Smart Quiz* — matn/rasmdan avtomatik\n📊 *Telegram Quiz* — Telegram'ning o'z poll formati\n📝 *Matn* — yozma format (#belgi bilan)\n📄 *Word fayl* — .docx yuklash\n\n_Savollarni qo'shib bo'lgach, "✅ Yakunlash va Saqlash" tugmasini bosing._`,
    { parse_mode: "Markdown", ...questionsSummaryKb() },
  );
}

async function cbCtNew(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx, States.CREATE_SUBJECT);
  await safeEdit(
    ctx,
    "📝 *Yangi Fan — 1-qadam*\n\nFan nomini kiriting.\n\n💡 _Masalan: Anatomiya, Kirish testi, IELTS Reading_\n\n⚠️ Faqat harflar, raqamlar va tire ishlatiladi (2–50 belgi).",
    cancelKb(),
  );
}

async function cbCtExist(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const refId = parseSuffix(ctx.callbackQuery.data, "ct_exist_");
  const testData = await dbService.getUserTest(refId);
  if (!testData) return;
  await updateData(ctx, { subject: testData.subject });
  setState(ctx, States.CREATE_NAME);
  await safeEdit(
    ctx,
    `✅ Fan: *${testData.subject}*\n\n📝 *Yangi Blok — 2-qadam*\n\nBlok nomini kiriting.\n\n💡 _Masalan: 1-Mavzu, Biokimyo Lab, Final tayyorgarlik_`,
    cancelKb(),
  );
}

async function onSubjectInput(ctx) {
  const result = SubjectSchema.safeParse(ctx.message.text || "");

  if (!result.success) {
    return ctx.reply(
      `${result.error.errors[0].message}\n\n💡 Fan nomlari 2–50 belgidan iborat bo'lishi va faqat harf, raqam va tire o'z ichiga olishi kerak. Qaytadan kiriting:`,
    );
  }
  if (!ctx.session || !ctx.session.data) {
    clearState(ctx);
    return ctx.reply(
      "⏳ Sessiya muddati tugadi. Xavotir olmang — bu xavfsizlik uchun. Iltimos, qaytadan boshlang.",
      backToMainKb(),
    );
  }

  // 3. Tozalangan va xavfsiz matnni olamiz
  const subject = result.data;

  // 4. Ma'lumotni keshga saqlaymiz va keyingi qadamga o'tamiz
  await updateData(ctx, { subject });
  setState(ctx, States.CREATE_NAME);

  // Markdown qulab tushmasligi uchun maxsus funksiyamizdan o'tkazib chiqaramiz
  const safeSubject = escapeMarkdown(subject);

  await ctx.reply(
    `✅ Fan: *${safeSubject}*\n\n📝 *2-qadam: Blok nomi*\n\nBlok nomini kiriting (1–40 belgi).\n\n💡 _Masalan: 1-Bob, Midterm savollar, Laboratoriya_`,
    { parse_mode: "Markdown", ...cancelKb() },
  );
}

async function onNameInput(ctx) {
  // Zod orqali tekshirish
  const result = BlockNameSchema.safeParse(ctx.message.text || "");

  if (!result.success) {
    return ctx.reply(
      `${result.error.errors[0].message}\n\n💡 Blok nomi 1–40 belgidan iborat bo'lishi kerak. Qaytadan kiriting:`,
    );
  }
  if (!ctx.session || !ctx.session.data) {
    clearState(ctx);
    return ctx.reply(
      "⏳ Sessiya muddati tugadi. Xavotir olmang — bu xavfsizlik uchun. Iltimos, qaytadan boshlang.",
      backToMainKb(),
    );
  }

  const block_name = result.data;

  await updateData(ctx, { block_name });
  setState(ctx, States.CREATE_QUESTIONS);

  const safeBlockName = escapeMarkdown(block_name);

  await ctx.reply(
    `✅ Blok: *${safeBlockName}*\n\n📝 *3-qadam: Savollarni qo'shish*\n\nQuyidagi usullardan birini tanlang:\n🤖 *AI Smart Quiz* — matn/rasmdan avtomatik\n📊 *Telegram Quiz* — Telegram'ning o'z poll formati\n📝 *Matn* — yozma format (#belgi bilan)\n📄 *Word fayl* — .docx yuklash\n\n_Barcha savollarni qo'shib bo'lgach, "✅ Yakunlash va Saqlash" tugmasini bosing._`,
    { parse_mode: "Markdown", ...questionsSummaryKb() },
  );
}

async function cbFmt(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const fmt = parseSuffix(ctx.callbackQuery.data, "fmt_");
  const data = await getData(ctx);

  const patch = { format: fmt };
  if (!data.is_editing && !data.questions) patch.questions = [];
  await updateData(ctx, patch);

  const backBtnAction = data.is_editing ? "back_to_edit_dash" : "preview_back";
  const backBtnText = data.is_editing
    ? "🔙 Orqaga"
    : "🔙 Format tanlashga qaytish";

  // 1. AI REJIMI (Sizning kodingiz, o'zgarishsiz qoldi)
  if (fmt === "ai") {
    const aiText = `🤖 *AI Smart Quiz — Sun'iy Intellekt bilan test yaratish*

AI sizning matn yoki rasmingizdan professional darajada test savollarini yaratib beradi.

━━━━━━━━━━━━━━━━
📄 *Matndan test* — Konspekt, darslik yoki maqola matnini yuboring
📸 *Rasmdan test* — Darslik sahifasini rasmga olib yuboring
❓ *Savollardan test* — O'zingiz yozgan ochiq savollarni yuboring, AI javob variantlarini tuzib beradi

━━━━━━━━━━━━━━━━
💡 *Eng sifatli natija uchun maslahatlar:*
• Matn kamida *150–200 so'z* bo'lishi tavsiya etiladi
• 10 ta savol uchun kamida *80 so'z* matn kerak
• 📸 Rasmda matn *aniq, tekis va to'liq* ko'rinishi kerak
• Qiya, xira yoki qisman rasmlardan savollar sifatsiz chiqadi

⚠️ _AI tomonidan yaratilgan savollar xatolik o'z ichiga olishi mumkin. Rasmiy imtihon oldidan doimo tekshirib oling._`;

    await safeEdit(ctx, aiText, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("📄 Matndan test yasash", "ai_mode_text")],
        [
          Markup.button.callback(
            "❓ Savollardan test yasash",
            "ai_mode_questions",
          ),
        ],
        [Markup.button.callback("📸 Rasmdan test yasash", "ai_mode_image")],
        [Markup.button.callback(backBtnText, backBtnAction)],
      ]),
    });
    return;
  }

  // 2. QUIZ REJIMI (To'g'ridan-to'g'ri o'tkazadi)
  if (fmt === "quiz") {
    setState(ctx, States.CREATE_QUESTIONS);
    await safeEdit(ctx, FORMAT_INSTRUCTIONS[fmt], getDynamicKb(data));
    return;
  }

  // 3. TEXT VA DOCX REJIMI (Shu yerda format so'raymiz)
  if (fmt === "text" || fmt === "docx") {
    await safeEdit(
      ctx,
      `⚙️ *Qaysi usulda o'qiymiz?*\n\nSiz kiritayotgan testlarda to'g'ri javob qanday belgilangan?\n\n🎯 *# bilan:* To'g'ri javob oldida # belgisi bor.\n🥇 *1-javob:* Har doim A (birinchi) variant to'g'ri qilib yozilgan.`,
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
          [Markup.button.callback(backBtnText, backBtnAction)],
        ]),
      },
    );
  }
}
// TANLANGAN REJIMNI QABUL QILISH VA YO'RIQNOMA BERISH
async function cbParseModeSelect(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const action = ctx.callbackQuery.data;
  const parts = action.split("_");
  const mode = parts[1]; // hash yoki first
  const fmt = parts[2]; // text yoki docx

  const data = await getData(ctx);
  // Rejimni xotiraga yozib qo'yamiz (utils.js shundan foydalanadi)
  await updateData(ctx, { parse_mode: mode });

  // Jarayonni davom ettiramiz
  setState(ctx, States.CREATE_QUESTIONS);
  await safeEdit(ctx, FORMAT_INSTRUCTIONS[fmt], getDynamicKb(data));
}
// ─── 2. AI YORDAMCHI FUNKSIYALARI (GLOBAL) ─────────────────────

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
  const data = await getData(ctx); // <--- XATONI TO'G'RILOVCHI QATOR SHU

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

// Sanoq tanlanganda ishlaydigan funksiya
async function cbAiCount(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const count = parseSuffix(ctx.callbackQuery.data, "ai_cnt_");
  const data = await getData(ctx);
  const mode = data.ai_mode_pending;

  await updateData(ctx, { ai_count: count });
  const countText =
    count === "auto" ? "munosib miqdorda" : `aniq <b>${count} ta</b>`;

  if (mode === "text") {
    setState(ctx, States.CREATE_AI_TEXT);
    await safeEdit(
      ctx,
      `📄 <b>Matndan test yasash</b>\n\nO'quv matnini (konspektni) shu yerga yuboring. AI ${countText} savol tuzib beradi.${AI_WARNING_TEXT}`,
      { parse_mode: "HTML" },
    );
  } else if (mode === "image") {
    setState(ctx, States.CREATE_AI_IMAGE);
    await safeEdit(
      ctx,
      `📸 <b>Rasmdan test yasash</b>\n\nKitob yoki matn rasmini yuboring. AI ${countText} savol tuzib beradi.${AI_WARNING_TEXT}`,
      { parse_mode: "HTML" },
    );
  }
}

// ─── AI INPUT HANDLERLARI ──────────────────────────────────────
async function cbAiModeText(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await updateData(ctx, { ai_mode_pending: "text" });
  await promptQuestionCount(ctx);
}

async function cbAiModeQuestions(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx, States.CREATE_AI_QUESTIONS);
  await safeEdit(
    ctx,
    `❓ *Savollardan test yasash*\n\nOchiq savollarni ro'yxat qilib yuboring.` +
      AI_WARNING_TEXT,
    { parse_mode: "Markdown" },
  );
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
    return ctx.reply(validation.message, { parse_mode: "HTML" });

  const msg = await ctx.reply("⏳ <i>AI matnni tahlil qilmoqda...</i>", {
    parse_mode: "HTML",
  });
  const aiService = require("../services/aiService");
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
  const aiService = require("../services/aiService");
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
    const https = require("https");
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

    const aiService = require("../services/aiService");
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
      "❌ Rasmni o'qishda xatolik yuz berdi.",
    );
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

async function processAiResult(ctx, msgId, generatedQuestions) {
  if (!generatedQuestions || !generatedQuestions.length) {
    return ctx.telegram.editMessageText(
      ctx.chat.id,
      msgId,
      undefined,
      "❌ AI test tuzishda xato qildi.",
    );
  }
  const data = await getData(ctx);
  const questions = [...(data.questions || []), ...generatedQuestions];
  await updateData(ctx, { questions });

  // XATONI TO'G'RILOVCHI QATOR: AI ishlab bo'lgach oddiy holatga qaytaramiz
  setState(ctx, States.CREATE_QUESTIONS);

  await ctx.telegram.editMessageText(
    ctx.chat.id,
    msgId,
    undefined,
    `✅ *Savollar qo'shildi!*\n📊 Jami: *${questions.length} ta*\nYana yuborishingiz yoki menyudan foydalanishingiz mumkin.` +
      AI_WARNING_TEXT,
    { parse_mode: "Markdown", ...getDynamicKb(data) },
  );
}

// ─── 2.5 BOSHQA FORMATLAR (DOCX, TEXT, QUIZ) ──────────────────
async function onDocxFile(ctx) {
  const data = await getData(ctx);
  const doc = ctx.message.document;
  if (!doc || !doc.file_name.endsWith(".docx"))
    return ctx.reply("⚠️ Faqat `.docx` fayl yuboring.");

  const status = await ctx.reply("⏳ Fayl o'qilmoqda...");
  const filePath = require('path').join(
    require("os").tmpdir(),
    `ugc_${ctx.from.id}_${Date.now()}.docx`,
  );
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const https = require("https");
    const http = require("http");
    await new Promise((resolve, reject) => {
      const file = require('fs').createWriteStream(filePath);
      const req = link.href.startsWith("https") ? https : http;
      req
        .get(link.href, (res) => {
          res.pipe(file);
          file.on("finish", () => {
            file.close();
            resolve();
          });
        })
        .on("error", reject);
    });

    // ─── O'ZGARISH SHU YERDA: parse_mode ni berib yuboramiz ───
    const newQs = await parseDocxQuestions(filePath, data.parse_mode || "hash");
    
    if (!newQs.length)
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        status.message_id,
        undefined,
        "❌ Fayldan savol topilmadi! Formatni to'g'ri tanlaganingizga ishonch hosil qiling.",
      );

    const questions = [...(data.questions || []), ...newQs];
    await updateData(ctx, { questions });
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      `✅ *Fayl o'qildi!* (${newQs.length} ta qo'shildi)\n📊 Jami: *${questions.length} ta*`,
      { parse_mode: "Markdown", ...getDynamicKb(data) },
    );
  } catch (e) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      status.message_id,
      undefined,
      "❌ Xatolik yuz berdi.",
    );
  } finally {
    if (require('fs').existsSync(filePath)) require('fs').unlinkSync(filePath);
  }
}

async function onQuestionMessage(ctx) {
  const data = await getData(ctx);
  const questions = [...(data.questions || [])];
  
  // ─── TAHRIRLASH REJIMI ───
  if (data.editing_question_index !== undefined) {
     if (!ctx.message.text) return ctx.reply("⚠️ Iltimos, matn yuboring.");
     
     const added = parseTextQuestions(ctx.message.text, data.parse_mode || 'hash');
     if (!added.length) {
         return ctx.reply("❌ Formatingiz xato! Iltimos, to'g'ri javob oldiga # qo'yib qayta yuboring.");
     }
     
     // Eski savol o'rniga yangisini joylaymiz
     const updatedIdx = data.editing_question_index;
     questions[updatedIdx] = added[0]; 
     
     // Xotirani tozalaymiz (tahrirlashdan chiqamiz)
     await updateData(ctx, { questions, editing_question_index: undefined });
     
     const msg = await ctx.reply("✅ Savol muvaffaqiyatli tahrirlandi!");
     setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(()=>{}), 2000);
     
     // XATOLIK TO'G'RILANGAN QISM: Telegraf'da callback_query ni xavfsiz chaqirish
     ctx.update.callback_query = { data: `preview_q_${updatedIdx}` }; 
     return cbPreviewQuestion(ctx);
  }

  // ─── YANGI SAVOL QO'SHISH REJIMI ───
  const fmt = data.format;

  if (fmt === "quiz") {
    const poll = ctx.message.poll;
    if (!poll || poll.type !== "quiz") return;
    questions.push({
      question: poll.question,
      options: poll.options.map((o) => o.text),
      correct_index: poll.correct_option_id,
    });
  } else if (fmt === "text") {
    if (!ctx.message.text) return;
    const added = parseTextQuestions(ctx.message.text, data.parse_mode || 'hash');
    if (!added.length) return ctx.reply("⚠️ Savol formati xato.");
    questions.push(...added);
  } else return;

  await updateData(ctx, { questions });
  await ctx.reply(`✅ Qabul qilindi! Jami: *${questions.length} ta*`, {
    parse_mode: "Markdown",
    ...getDynamicKb(data),
  });
}

// ─── 3. KO'RIB CHIQISH (PREVIEW), TAHRIRLASH VA O'CHIRISH ──────

async function cbPreviewQuestion(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "preview_q_"), 10);
  const data = await getData(ctx);

  // Har ehtimolga qarshi tahrirlash rejimini tozalab qo'yamiz
  await updateData(ctx, { editing_question_index: undefined });

  const questions = data.questions || [];

  if (questions.length === 0) {
    return safeEdit(ctx, "⚠️ Hozircha savollar yo'q!", getDynamicKb(data));
  }

  const validIdx = Math.max(0, Math.min(idx, questions.length - 1));
  const q = questions[validIdx];

  let text = `👁 *Savol* (${validIdx + 1} / ${questions.length})\n\n*${q.question}*\n\n`;
  const labels = ["A", "B", "C", "D", "E", "F"];
  q.options.forEach((opt, i) => {
    text += `${i === q.correct_index ? "✅" : "❌"} *${labels[i]})* ${opt}\n`;
  });

  const nav = [];
  if (validIdx > 0)
    nav.push(Markup.button.callback("⬅️ Oldingi", `preview_q_${validIdx - 1}`));
  if (validIdx < questions.length - 1)
    nav.push(Markup.button.callback("Keyingi ➡️", `preview_q_${validIdx + 1}`));

  await safeEdit(ctx, text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      nav,
      [
        Markup.button.callback("✏️ Tahrirlash", `edit_q_${validIdx}`),
        Markup.button.callback("🗑 O'chirish", `del_q_${validIdx}`),
      ],
      [Markup.button.callback("🔙 Orqaga qaytish", "preview_back")],
    ]),
  });
}

async function cbEditQuestionStart(ctx) {
  await ctx.answerCbQuery("✏️ Savol matni tayyorlanmoqda...").catch(() => {});
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "edit_q_"), 10);
  const data = await getData(ctx);
  const q = data.questions[idx];

  let textFormat = `${q.question}\n`;
  q.options.forEach((opt, i) => {
    if (i === q.correct_index) textFormat += `#${opt}\n`;
    else textFormat += `${opt}\n`;
  });

  await updateData(ctx, { editing_question_index: idx });

  // XATONI TO'G'RILOVCHI QATOR: Tahrirlash bosilganda bot aniq to'g'ri rejimga o'tishini ta'minlaymiz
  setState(ctx, States.CREATE_QUESTIONS);

  await safeEdit(
    ctx,
    `✏️ *Savolni Tahrirlash* (${idx + 1}-savol)\n\nQuyidagi matnni nusxalang (ustiga bossangiz nusxalanadi), xatoni to'g'rilab, botga qayta yuboring:\n\n\`\`\`\n${textFormat}\`\`\`\n\n💡 _To'g'ri javob oldida # bo'lishi shart._`,
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("❌ Bekor qilish", `preview_q_${idx}`)],
      ]),
    },
  );
}
async function cbDeleteQuestion(ctx) {
  await ctx.answerCbQuery().catch(() => {});

  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "del_q_"), 10);
  const data = await getData(ctx);
  const questions = data.questions || [];

  if (idx >= 0 && idx < questions.length) {
    questions.splice(idx, 1);
    await updateData(ctx, { questions });
  }

  if (questions.length === 0) return cbPreviewBack(ctx);
  ctx.callbackQuery.data = `preview_q_${Math.min(idx, questions.length - 1)}`;
  await cbPreviewQuestion(ctx);
}

async function cbPreviewBack(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const data = await getData(ctx);
  if (data.is_editing) return showEditDashboard(ctx);

  await safeEdit(
    ctx,
    `✅ *Holat*\nJami savollar: *${(data.questions || []).length} ta*\n\nQo'shimcha savollar qo'shish uchun formatni tanlang yoki yakunlang:`,
    { parse_mode: "Markdown", ...questionsSummaryKb() },
  );
}

// ─── 4. YAKUNLASH VA MENYULAR ────────────────────────────────
async function cbFinishCreation(ctx) {
  const data = await getData(ctx);
  const questions = data.questions || [];
  if (!questions.length)
    return ctx.answerCbQuery("❌ Kamida 1 ta savol qo'shishingiz kerak!", { show_alert: true }).catch(() => {});
  
  await ctx.answerCbQuery("✅ Test muvaffaqiyatli saqlandi!").catch(() => {});

  const CHUNK_SIZE = 25; // Har bir blokdagi maksimal savollar soni
  let testIds = [];

  if (data.editing_test_id) {
    // Agar eski testni tahrirlayotgan bo'lsa, shunchaki yangilaymiz
    await dbService.updateUserTestQuestions(data.editing_test_id, ctx.from.id, questions);
    testIds.push(data.editing_test_id);
  } else {
    // YANGI TEST YARATISH: Avto-bo'lish (Chunking)
    if (questions.length <= CHUNK_SIZE) {
      // Savollar oz bo'lsa, bitta qilib saqlaymiz
      const tId = await dbService.saveUserTest(ctx.from.id, data.subject, data.block_name, questions);
      testIds.push(tId);
    } else {
      // 25 tadan bo'lib chiqamiz
      const chunks = [];
      for (let i = 0; i < questions.length; i += CHUNK_SIZE) {
        chunks.push(questions.slice(i, i + CHUNK_SIZE));
      }
      
      // Har bir qismni alohida blok qilib yozamiz
      for (let i = 0; i < chunks.length; i++) {
        const chunkName = `${data.block_name} (${i + 1}-qism)`;
        const tId = await dbService.saveUserTest(ctx.from.id, data.subject, chunkName, chunks[i]);
        testIds.push(tId);
      }
    }
  }

  const botInfo = await ctx.telegram.getMe();
  const firstTestId = testIds[0];
  
  const chunkMsg = testIds.length > 1 
    ? `\n⚠️ *Avto-bo'lish:* Savollar ko'pligi uchun tizim ularni avtomatik *${testIds.length} ta blokga* ajratdi va fanga joyladi.`
    : `\n🔗 *Faqat shu blok:*\n\`https://t.me/${botInfo.username}?start=t_${firstTestId}\``;

  await safeEdit(
    ctx,
    `🎉 *Muvaffaqiyatli saqlandi!*\n\n📚 Fan: *${data.subject}*\n📝 Asosiy Blok: *${data.block_name}*\n🔢 Jami Savollar: *${questions.length} ta*${chunkMsg}\n\n🔗 *Butun fanni o'ynash (Marafon):*\n\`https://t.me/${botInfo.username}?start=s_${firstTestId}\``,
    Markup.inlineKeyboard([
      [Markup.button.callback("➕ Shu fanga yana blok qo'shish", `ct_exist_${firstTestId}`)],
      [Markup.button.url("↗️ Guruhda o'ynash", `https://t.me/${botInfo.username}?startgroup=s_${firstTestId}`)],
      [Markup.button.callback("📂 Mening Testlarim", "my_tests")],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]),
  );
  clearState(ctx);
}
async function cbCancelCreation(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(ctx, "❌ Bekor qilindi.", backToMainKb());
}

// src/handlers/testCreation.js fayli ichida:

async function cbMyTests(ctx) {
  await ctx.answerCbQuery("📂 Testlaringiz yuklanmoqda...").catch(() => {});

  let page = 0;
  if (ctx.callbackQuery.data.startsWith("my_tests_")) {
    page = parseInt(ctx.callbackQuery.data.replace("my_tests_", ""), 10);
  }

  const tests = await dbService.getUserCreatedTests(ctx.from.id);
  if (!tests || tests.length === 0) {
    return safeEdit(
      ctx,
      "📭 <b>Siz hali hech qanday test yaratmagansiz.</b>\n\nBu bo'limda siz AI yordamida yoki o'zingiz qo'lda yaratgan shaxsiy testlaringiz saqlanadi.",
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
        ]),
      },
    );
  }

  // Fanlar bo'yicha guruhlaymiz
  const subjectsMap = {};
  for (const t of tests) {
    if (!subjectsMap[t.subject]) subjectsMap[t.subject] = [];
    subjectsMap[t.subject].push(t);
  }

  const uniqueSubjects = Object.keys(subjectsMap);
  const itemsPerPage = 5;
  const totalPages = Math.ceil(uniqueSubjects.length / itemsPerPage);
  const currentSubjects = uniqueSubjects.slice(
    page * itemsPerPage,
    (page + 1) * itemsPerPage,
  );

  const buttons = currentSubjects.map((subj) => {
    const subjTests = subjectsMap[subj];
    const firstTestId = subjTests[0].id;
    return [
      Markup.button.callback(
        `📁 ${subj}  •  ${subjTests.length} ta blok`,
        `manage_subj_${firstTestId}`,
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

  await safeEdit(
    ctx,
    `📂 <b>Mening Testlarim</b> (Sahifa ${page + 1}/${totalPages}):\n\nQaysi fan bo'yicha testlarni ko'rmoqchisiz?\n\n📊 Jami: ${uniqueSubjects.length} ta fan, ${tests.length} ta test`,
    { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
  );
}
async function cbManageSubj(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const refId = parseSuffix(ctx.callbackQuery.data, "manage_subj_");
  const testData = await dbService.getUserTest(refId);
  if (!testData) return;

  const tests = await dbService.getUserCreatedTests(ctx.from.id);
  const subjTests = tests.filter((t) => t.subject === testData.subject);
  const botInfo = await ctx.telegram.getMe();

  const buttons = subjTests.map((t) => [
    Markup.button.callback(
      `📝 ${t.block_name}  •  ${(t.questions || []).length} savol`,
      `manage_test_${t.id}`,
    ),
  ]);
  // cbManageSubj oxiridagi tugmalar:
  buttons.push([
    Markup.button.url(
      "🏃 Bu fanni guruhda Marafon qilish",
      `https://t.me/${botInfo.username}?startgroup=s_${refId}`,
    ),
  ]);
  buttons.push([
    Markup.button.callback("➕ Bu fanga blok qo'shish", `ct_exist_${refId}`),
  ]);
  buttons.push([Markup.button.callback("🔙 Mening Testlarimga", "my_tests")]);
  await safeEdit(
    ctx,
    `📚 *Fan:* ${testData.subject}\n🔗 *Fan havolasi:*\nhttps://t.me/${botInfo.username}?start=s_${refId}\n\n📋 Bloklar:`,
    Markup.inlineKeyboard(buttons),
  );
}

async function cbManageTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const testId = parseSuffix(ctx.callbackQuery.data, "manage_test_");
  const testData = await dbService.getUserTest(testId);
  if (!testData) return;
  const botInfo = await ctx.telegram.getMe();

  await safeEdit(
    ctx,
    `📝 * Blok Ma\'lumotlari *\n📚 Fan: ${testData.subject}\n🔖 Blok: * ${testData.block_name} *\n🔢 Savollar: *${(testData.questions || []).length} ta*\n\n🔗 *Havola:*\nhttps://t.me/${botInfo.username}?start=t_${testId}`,

    Markup.inlineKeyboard([
      [
        Markup.button.url(
          "↗️ Guruhda o'ynash",
          `https://t.me/${botInfo.username}?startgroup=t_${testId}`,
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
      [Markup.button.callback("🔙 Fanga qaytish", `manage_subj_${testId}`)],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]),
  );
}

async function cbDeleteTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const testId = parseSuffix(ctx.callbackQuery.data, "delete_test_");
  await safeEdit(
    ctx,
    `⚠️ *Ishonchingiz komilmi?*\n⛔ Bu amalni qaytarib bo'lmaydi!`,
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

function register(bot) {
  bot.action("create_test", cbCreateTest);
  bot.action("ct_new", cbCtNew);
  bot.action(/^ct_exist_/, cbCtExist);
  bot.action(/^fmt_/, cbFmt);
  bot.action("finish_test_creation", cbFinishCreation);
  bot.action("cancel_creation", cbCancelCreation);

  bot.action(/^my_tests/, cbMyTests);
  bot.action(/^manage_subj_/, cbManageSubj);
  bot.action(/^manage_test_/, cbManageTest);
  bot.action(/^delete_test_/, cbDeleteTest);
  bot.action(/^confirm_delete_/, cbConfirmDelete);

  bot.action(/^edit_test_/, cbEditTest);
  bot.action("back_to_edit_dash", cbBackToEditDash);
  bot.action("edit_add_q", cbEditAddQ);

  bot.action(/^preview_q_/, cbPreviewQuestion);
  bot.action(/^del_q_/, cbDeleteQuestion);
  bot.action("preview_back", cbPreviewBack);

  bot.action("ai_mode_text", cbAiModeText);
  bot.action("ai_mode_questions", cbAiModeQuestions);
  bot.action("ai_mode_image", cbAiModeImage);
  bot.action(/^ai_cnt_/, cbAiCount);

  bot.action(/^edit_q_/, cbEditQuestionStart);

  bot.action(/^parse_(hash|first)_(text|docx)/, cbParseModeSelect);
  bot.action("ignore", (ctx) => ctx.answerCbQuery().catch(() => {}));
}

module.exports = {
  register,
  onSubjectInput,
  onNameInput,
  onDocxFile,
  onQuestionMessage,
  onAiTextInput,
  onAiQuestionsInput,
  onAiImageInput,
};
