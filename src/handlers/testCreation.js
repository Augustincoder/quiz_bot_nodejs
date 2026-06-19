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
function autoDocxKb() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "📄 Word fayl orqali avtomatik yuklash",
        "auto_docx",
      ),
    ],
    [Markup.button.callback("❌ Bekor qilish", "cancel_creation")],
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

// const FORMAT_INSTRUCTIONS = {
//   quiz: "📊 *Quiz Formati*\n\nTelegram'ning o'z quiz funksiyasidan foydalaning:\n\n1️⃣ 📎 (Biriktirish) belgisini bosing\n2️⃣ *Poll* → *Quiz* rejimini tanlang\n3️⃣ Savol va javob variantlarini kiriting\n4️⃣ To'g'ri javobni belgilab yuboring\n\n💡 _Har bir quiz ayrima xabar sifatida yuboriladi._",
//   text: "📝 *Matn Formati*\n\nQuyidagi ko'rinishda yuboring (bir yoki bir nechta savol):\n```\nO'zbekiston poytaxti qayer?\n#Toshkent\nSamarqand\nBuxoro\nNamangan\n```\n\n💡 _To'g'ri javob oldiga # belgisi qo'yiladi. Savollar orasiga bo'sh qator qo'shing._",
// docx: "📄 *Word (.docx) Formati*\n\n⚠️ *Muxim:* Fayl boshidagi kirish so'zlari, sarlavha yoki fanga oid boshqa ma'lumotlarni o'chirib tashlang. Matn to'g'ridan-to'g'ri *1-savoldan* boshlanishi shart!\n\nFaylni quyidagicha tayyorlang:\n```\nSavol matni?\n#To'g'ri javob\nNoto'g'ri javob 1\nNoto'g'ri javob 2\n```\n\n💡 _Tayyor .docx faylni shu chatga yuboring._",
// };

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
// ─── 1. YANGI TEST YARATISH BOSQICHLARI (YANGILANGAN) ────────
async function cbCreateTest(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery("✅ Test yaratish bo'limi ochildi!").catch(() => {});

  // Sahifani aniqlash (Default: 0)
  let page = 0;
  if (ctx.callbackQuery && ctx.callbackQuery.data && ctx.callbackQuery.data.startsWith("create_test_")) {
    page = parseInt(ctx.callbackQuery.data.replace("create_test_", ""), 10) || 0;
  }

  const tests = await dbService.getUserCreatedTests(ctx.from.id);
  const subjects = {};
  for (const t of tests) {
    if (!subjects[t.subject]) subjects[t.subject] = [];
    subjects[t.subject].push(t);
  }

  const uniqueSubjects = Object.keys(subjects);
  const buttons = [];

  if (uniqueSubjects.length > 0) {
    buttons.push([Markup.button.callback("── Mavjud fanlar (Tezkor tanlash) ──", "ignore")]);

    // Paginatsiya sozlamalari
    const ITEMS_PER_PAGE = 5;
    const totalPages = Math.ceil(uniqueSubjects.length / ITEMS_PER_PAGE);
    const validPage = Math.max(0, Math.min(page, totalPages - 1));

    // Joriy sahifadagi fanlarni qirqib olish
    const currentSubjects = uniqueSubjects.slice(
      validPage * ITEMS_PER_PAGE,
      (validPage + 1) * ITEMS_PER_PAGE
    );

    // Fanlar ro'yxatini tugmaga aylantirish
    for (const subj of currentSubjects) {
      const subTests = subjects[subj];
      buttons.push([
        Markup.button.callback(`📁 ${subj}  •  ${subTests.length} ta blok`, `ct_exist_${subTests[0].id}`)
      ]);
    }

    // Sahifalash (Navigatsiya) tugmalari
    const navRow = [];
    if (validPage > 0) navRow.push(Markup.button.callback("⬅️ Oldingi", `create_test_${validPage - 1}`));
    if (validPage < totalPages - 1) navRow.push(Markup.button.callback("Keyingi ➡️", `create_test_${validPage + 1}`));
    
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([Markup.button.callback("➕ Yangi fan yaratish", "ct_new")]);

  } else {
    buttons.push([Markup.button.callback("➕ Birinchi fanimni yarataman", "ct_new")]);
  }

  buttons.push([Markup.button.callback("🔙 Asosiy Menyu", "back_to_main")]);

  // Ekran matniga sahifa raqamini qo'shish
  let pageInfo = "";
  if (uniqueSubjects.length > 5) {
    const totalPages = Math.ceil(uniqueSubjects.length / 5);
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
    "📍 *[1/3] Bosqich: Fan tanlash*\n\n━━━━━━━━━━━━━━━━\nYangi fan nomini kiriting.\n\n💡 _Masalan: Ona tili, Tarix 1-qism, Kardiologiya_\n\n⚠️ Uzunligi: 2–50 belgi.",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔙 Ortga (Fanlar ro'yxatiga)", "create_test")],
      [Markup.button.callback("❌ Bekor qilish", "cancel_creation")],
    ]),
  );
}

// ─── GIBRID KIRTISH: BLOK NOMI YOKI AUTO-DOCX ─────────────────
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

// Auto-Docx dan Blok nomini yozishga qaytish uchun yangi funksiya (shu joyga qo'shib keting):
async function cbBackToBlockPrompt(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const data = await getData(ctx);
  if (!data.subject) return cbCreateTest(ctx); // Agar kesh o'chgan bo'lsa, boshiga otadi
  await promptBlockNameOrAutoDocx(ctx, data.subject);
}

async function onSubjectInput(ctx) {
  const result = SubjectSchema.safeParse(ctx.message.text || "");
  if (!result.success) {
    return ctx.reply(
      `❌ ${result.error.errors[0].message}\n\n💡 Iltimos, qaytadan kiriting:`,
    );
  }
  if (!ctx.session || !ctx.session.data) return cbCancelCreation(ctx);

  const subject = result.data;
  await updateData(ctx, { subject });

  // Eski kod o'rniga yangi gibrid oynani chaqiramiz
  await ctx
    .reply("⏳ Qabul qilindi...", { reply_markup: { remove_keyboard: true } })
    .then((m) =>
      ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}),
    );
  await promptBlockNameOrAutoDocx(ctx, subject);
}

async function cbCtExist(ctx) {
  const refId = parseSuffix(ctx.callbackQuery.data, "ct_exist_");
  const testData = await dbService.getUserTest(refId);
  if (!testData)
    return ctx.answerCbQuery("❌ Fan topilmadi", { show_alert: true });

  await ctx.answerCbQuery(`✅ ${testData.subject} tanlandi`).catch(() => {});
  await updateData(ctx, { subject: testData.subject });

  // Eski kod o'rniga yangi gibrid oynani chaqiramiz
  await promptBlockNameOrAutoDocx(ctx, testData.subject);
}

async function cbAutoDocxInit(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  // Format va holatni saqlab qo'yamiz, lekin hali fayl kutmaymiz
  await updateData(ctx, {
    is_auto_docx: true,
    block_name: null,
    format: "docx",
  });

  await safeEdit(
    ctx,
    `⚙️ *Qaysi usulda o'qiymiz?*\n\nWord fayldagi testlarda to'g'ri javob qanday belgilangan?\n\n🎯 *# bilan:* To'g'ri javob oldida # belgisi bor.\n🥇 *1-javob:* Har doim A (birinchi) variant to'g'ri.`,
    {
      parse_mode: "Markdown",
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
        [Markup.button.callback("🔙 Bekor qilish", "cancel_creation")],
      ]),
    },
  );
}

async function onNameInput(ctx) {
  const result = BlockNameSchema.safeParse(ctx.message.text || "");
  if (!result.success) return ctx.reply(`❌ ${result.error.errors[0].message}`);
  if (!ctx.session || !ctx.session.data) return cbCancelCreation(ctx);

  const block_name = result.data;
  await updateData(ctx, { block_name, is_auto_docx: false });

  // Format kutish holatiga o'tamiz
  setState(ctx, States.CREATE_QUESTIONS);
  await showDraftDashboard(ctx);
}

// ─── DRAFT DASHBOARD (BOSHQARUV PANELI) ──────────────────────

async function showDraftDashboard(ctx) {
  const data = await getData(ctx);
  const qCount = (data.questions || []).length;

  let text = `📝 *Blok:* ${escapeMarkdown(data.block_name)}\n`;
  text += `🛒 *Savatdagi savollar:* ${qCount} ta\n\n`;

  const buttons = [];

  if (qCount === 0) {
    text += `_Savat bo'sh. Qaysi usulda savol qo'shmoqchisiz? O'zingizga qulayini tanlang:_`;
  } else {
    text += `_Yana savol qo'shishingiz mumkin. Yoki jarayonni yakunlang:_`;
  }

  // Formatlar doim turadi
  buttons.push([
    Markup.button.callback("📝 Matn", "fmt_text"),
    Markup.button.callback("📊 Quiz", "fmt_quiz"),
  ]);
  buttons.push([
    Markup.button.callback("📄 Word fayl", "fmt_docx"),
    Markup.button.callback("🤖 AI Smart Quiz", "fmt_ai"),
  ]);

  // Agar savol bo'lsa, Global Preview va Saqlash chiqadi
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

// Spoke'dan (Formatdan) qaytish
async function cbBackToDashboard(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  // Joriy qo'shilganlar hisoblagichini tozalaymiz
  await updateData(ctx, { format_added: 0 });
  await showDraftDashboard(ctx);
}

async function cbFmt(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const fmt = parseSuffix(ctx.callbackQuery.data, "fmt_");
  const data = await getData(ctx);
  await updateData(ctx, { format: fmt, format_added: 0 });

  // 🤖 AQLLI MARSHRUT: Tahrirlash rejimidami yoki Yangi yaratishdami?
  const backAction = data.is_editing ? "edit_add_q" : "back_to_dashboard";
  const backText = data.is_editing
    ? "🔙 Ortga (Format tanlashga)"
    : "🔙 Ortga (Asosiy Panelga)";

  if (fmt === "ai") {
    const aiText = `🤖 *AI Smart Quiz — Sun'iy Intellekt bilan test yaratish*...`;
    return safeEdit(ctx, aiText, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback("📄 Matndan", "ai_mode_text"),
          Markup.button.callback("📸 Rasmdan", "ai_mode_image"),
        ],
        [Markup.button.callback("❓ Savollardan", "ai_mode_questions")],
        [Markup.button.callback(backText, backAction)], // <-- O'zgarish shu yerda
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
// Yangi format menyusini yuborish
async function sendFormatSelection(ctx) {
  const text = `📝 *Yangi savol formatini tanlang:*\n\n⬇️ Qaysi usulda savol qo'shmoqchisiz?`;
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
    await ctx.reply(text, { parse_mode: "Markdown", ...kb });
  }
}

// Ortga qaytish tugmasi ushlagichi (handler)
async function cbBackToFormats(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await sendFormatSelection(ctx);
}
// TANLANGAN REJIMNI QABUL QILISH VA YO'RIQNOMA BERISH

// ─── REJIM TANLANGANDAN KEYINGI IZOLYATSIYA ───
async function cbParseModeSelect(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const action = ctx.callbackQuery.data;
  const parts = action.split("_");
  const mode = parts[1];
  const fmt = parts[2];

  const data = await getData(ctx);
  await updateData(ctx, { parse_mode: mode });

  // 🤖 AQLLI MARSHRUT
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

// ─── AI INPUT HANDLERLARI (YANGILANGAN) ───

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

// Sanoq tanlanganda ishlaydigan funksiya
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
      "❌ Rasmni o'qishda xatolik yuz berdi. Iltimos qaytadan urinib ko'ring yoki Ortga qayting.",
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Ortga", "fmt_ai")],
        ]),
      },
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
  await updateData(ctx, { questions });
  setState(ctx, States.CREATE_QUESTIONS);

  // 🤖 AQLLI MARSHRUT
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

// ─── 1. FAYL VA MATNLARNI QABUL QILISH VA STATUS MENYUSI ────────

async function onDocxFile(ctx) {
  const data = await getData(ctx);
  const doc = ctx.message.document;

  const validMime =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const MAX_FILE_SIZE = 2 * 1024 * 1024; // Maksimal 2 MB

  if (!doc) return;

  if (!doc.file_name.endsWith(".docx") || doc.mime_type !== validMime) {
    return ctx.reply(
      "⚠️ *Xavfsizlik tizimi:* Faqat toza `.docx` (Word) formatidagi fayllar qabul qilinadi.",
      { parse_mode: "Markdown" },
    );
  }

  if (doc.file_size > MAX_FILE_SIZE) {
    return ctx.reply(
      "⚠️ *Fayl hajmi juda katta!* Iltimos, xotirani ortiqcha zo'riqtirmaslik uchun 2 MB gacha bo'lgan fayl yuklang.",
      { parse_mode: "Markdown" },
    );
  }

  // ─── AVTO-NOMLASH: Agar nom yozilmagan bo'lsa fayl nomidan olamiz
  let bName = data.block_name;
  if (!bName) {
    bName = doc.file_name
      .replace(".docx", "")
      .replace(/_/g, " ")
      .substring(0, 50);
    await updateData(ctx, { block_name: bName });
  }

  const statusMsg = await ctx.reply("⏳ Fayl o'qilmoqda...");
  const filePath = require("path").join(
    require("os").tmpdir(),
    `ugc_${ctx.from.id}_${Date.now()}.docx`,
  );

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const https = require("https");
    const http = require("http");
    await new Promise((resolve, reject) => {
      const file = require("fs").createWriteStream(filePath);
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

    // ─── YANGI PARSER (xato va to'g'ri savollarni ajratadi)
    // ─── YANGI PARSER (xato va to'g'ri savollarni ajratadi)
    const parsed = await parseDocxQuestions(
      filePath,
      data.parse_mode || "hash",
    );
    const validQs = parsed.valid || [];
    const invalidQs = parsed.invalid || [];

    // XATONI TO'G'RILASH: Agar fayldan hech narsa topilmasa, holatni yopmaymiz! Yana fayl kutamiz.
    if (validQs.length === 0 && invalidQs.length === 0) {
      return ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        "❌ *Fayldan hech qanday savol topilmadi!*\n\nIltimos, Word fayl to'g'ri formatda ekanligini tekshirib, *boshqa fayl yuboring* (Men yana fayl kutyapman 👇).",
        {
          parse_mode: "Markdown",
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

    // ─── AVTO-DOCX REJIMI ───
    if (data.is_auto_docx) {
      const MAX_QUESTIONS = 350; // <--- 250 LIMIT MANA SHU YERDA!
      let limitMsg = "";

      let finalValidQs = validQs;
      if (validQs.length > MAX_QUESTIONS) {
        finalValidQs = validQs.slice(0, MAX_QUESTIONS);
        limitMsg = `\n\n⚠️ *Limit himoyasi:* Tizim barqarorligini saqlash maqsadida fayldan faqat dastlabki 250 ta savol qabul qilindi!`;
      }

      // 25 tadan qismlarga (chunks) bo'lamiz
      const chunks = [];
      for (let i = 0; i < finalValidQs.length; i += 25) {
        chunks.push(finalValidQs.slice(i, i + 25));
      }

      await updateData(ctx, { chunks, invalidQs, questions: finalValidQs });
      await ctx.telegram
        .deleteMessage(ctx.chat.id, statusMsg.message_id)
        .catch(() => {});
      return showAutoDocxStatusMenu(ctx, chunks, invalidQs.length, limitMsg);
    } else {
      // ─── NORMAL DOCX REJIMI (Limit 50) ───
      let finalQs = validQs;
      let limitMsg = "";

      if (validQs.length > 50) {
        finalQs = validQs.slice(0, 50);
        limitMsg = `\n\n⚠️ *Limit:* Bitta blok uchun maksimal 50 ta savol olindi. Kattaroq fayllar uchun asosiy menyudagi *"Avto-yuklash"* tugmasidan foydalaning.`;
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
        `✅ *Fayl muvaffaqiyatli o'qildi!* (Qo'shildi: ${finalQs.length} ta)${limitMsg}`,
        { parse_mode: "Markdown" },
      );

      // Asosiy Panelga (Draft Dashboard) qaytaramiz
      return showDraftDashboard(ctx);
    }
  } catch (e) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      statusMsg.message_id,
      undefined,
      "❌ Xatolik yuz berdi. Fayl buzilgan bo'lishi mumkin.",
    );
  } finally {
    if (require("fs").existsSync(filePath)) require("fs").unlinkSync(filePath);
  }
}

// ─── STATUS (KORIB CHIQISH) MENYULARI ───

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

async function showAutoDocxStatusMenu(
  ctx,
  chunks,
  invalidCount,
  limitMsg = "",
) {
  const buttons = chunks.map((chunk, index) => [
    Markup.button.callback(
      `📁 ${index + 1}-qism (${chunk.length} ta savol)`,
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

  const text = `✅ *Fayl muvaffaqiyatli o'qildi!*\n\n📊 Jami to'g'ri savollar: *${totalValid} ta*\n⚠️ Xato formatlar: *${invalidCount} ta*${limitMsg}\n\n_Tizim savollaringizni quyidagi qismlarga ajratdi. Ichiga kirib tekshirishingiz mumkin:_`;

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

async function onQuestionMessage(ctx) {
  const data = await getData(ctx);

  // Asosiy xotiradan barcha savollarni olamiz (XATOLIK SHU YERDA EDI)
  let questions = [...(data.questions || [])];

  // ─── 1. TAHRIRLASH REJIMI (EDIT) ───
  if (data.editing_question_index !== undefined) {
    if (!ctx.message.text) return ctx.reply("⚠️ Iltimos, matn yuboring.");

    // Yangilangan parser orqali o'qiymiz
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

    // Eski savol o'rniga yangisini joylaymiz
    const updatedIdx = data.editing_question_index;
    questions[updatedIdx] = added[0];

    // Xotirani tozalab, yangilangan savollarni saqlaymiz
    await updateData(ctx, { questions, editing_question_index: undefined });

    const msg = await ctx.reply("✅ Savol muvaffaqiyatli tahrirlandi!");
    setTimeout(
      () =>
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}),
      2000,
    );

    // Tahrir tugagach, bevosita 10 talik ro'yxatdagi to'g'ri sahifaga qaytamiz
    const page = Math.floor(updatedIdx / 10);
    ctx.update.callback_query = { data: `preview_grid_${page}` };
    return cbPreviewGrid(ctx);
  }
  // ─── XATONI TO'G'RILASH REJIMI (ERROR RECOVERY) ───
  if (data.fixing_error_index !== undefined) {
    if (!ctx.message.text) return ctx.reply("⚠️ Iltimos, matn yuboring.");

    // Yuborilgan matnni yana parserdan o'tkazamiz
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

    // 1. To'g'rilangan savolni asosiy To'g'rilar bazasiga qo'shamiz
    questions.push(added[0]);

    // 2. Uni Xatolar ro'yxatidan o'chiramiz
    if (fixIdx >= 0 && fixIdx < invalidQs.length) {
      invalidQs.splice(fixIdx, 1);
    }

    await updateData(ctx, { questions, invalidQs });

    const msg = await ctx.reply(
      "✅ Savol muvaffaqiyatli to'g'rilandi va qabul qilindi!",
    );
    setTimeout(
      () =>
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}),
      2000,
    );

    // Keyingi xatoga avtomatik o'tamiz (massiv qisqargani uchun indeks o'zgarmaydi)
    ctx.update.callback_query = { data: `fix_errors_${fixIdx}` };
    return cbFixErrors(ctx);
  }
  // ─── 2. YANGI SAVOL QO'SHISH REJIMI (CONTINUOUS INPUT) ───
  const fmt = data.format;
  let newQs = [];

  if (fmt === "text") {
    if (!ctx.message.text) return;
    const parsed = parseTextQuestions(
      ctx.message.text,
      data.parse_mode || "hash",
    );
    newQs = parsed.valid || [];

    // Kelajakda (2-bosqichda) bu yerga xato (invalidQs) matnlarni saqlash mantiqini qo'shamiz
  } else if (fmt === "quiz") {
    const poll = ctx.message.poll;
    if (!poll || poll.type !== "quiz") return;
    newQs.push({
      question: poll.question,
      options: poll.options.map((o) => o.text),
      correct_index: poll.correct_option_id,
    });
  }

  // Agar yangi savollar muvaffaqiyatli o'qilsa
  if (newQs.length > 0) {
    questions = [...questions, ...newQs];
    const format_added = (data.format_added || 0) + newQs.length;
    await updateData(ctx, { questions, format_added });

    // 🤖 AQLLI MARSHRUT
    const finishAction = data.is_editing
      ? "back_to_edit_dash"
      : "back_to_dashboard";
    const finishText = data.is_editing
      ? "🔙 Tahrirlash paneliga (Yakunlash)"
      : "🔙 Panelga qaytish (Yakunlash)";

    await ctx.reply(
      `✅ *${newQs.length} ta savol qo'shildi!*\n\nYana savol yuborishingiz mumkin.\n_Joriy formatda yig'ilganlar: ${format_added} ta_`,
      {
        parse_mode: "Markdown",
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
// ─── 3. KO'RIB CHIQISH (GRID PREVIEW), TAHRIRLASH VA O'CHIRISH ──────

// Asosiy 10 talik ro'yxatni chizuvchi funksiya
async function cbPreviewGrid(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const page =
    parseInt(parseSuffix(ctx.callbackQuery.data, "preview_grid_"), 10) || 0;
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

  let text = `👁 *Barcha savollar* (Jami: ${questions.length} ta)\n_Sahifa: ${validPage + 1} / ${totalPages}_\n\n`;

  // Har bir savolni to'liq o'qiymiz, faqat to'g'ri javobini chiqaramiz
  currentQs.forEach((q, i) => {
    const actualNum = startIdx + i + 1;
    const correctAns = q.options[q.correct_index] || "Noma'lum";
    text += `*${actualNum}.* ${escapeMarkdown(q.question)}\n✅ _Javob:_ ${escapeMarkdown(correctAns)}\n\n`;
  });

  text += `_Batafsil ko'rish yoki tahrirlash uchun pastdagi mos raqamni tanlang:_`;

  const buttons = [];

  // Raqamli tugmalar (Numpad) yozish (Har qatorda 5 tadan)
  let numpadRow = [];
  for (let i = 0; i < currentQs.length; i++) {
    const actualNum = startIdx + i + 1;
    const actualIdx = startIdx + i;
    numpadRow.push(
      Markup.button.callback(`${actualNum}`, `preview_q_${actualIdx}`),
    );

    // Qator to'lsa yoki oxirgi element bo'lsa yangi qatorga o'tkazamiz
    if (numpadRow.length === 5 || i === currentQs.length - 1) {
      buttons.push(numpadRow);
      numpadRow = [];
    }
  }

  // Sahifalash (Pagination) tugmalari
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

  buttons.push([
    Markup.button.callback(
      "🔙 Boshqaruv Paneliga qaytish",
      "back_to_dashboard",
    ),
  ]);

  await safeEdit(ctx, text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
}

// Bitta savolning ichiga kirilgandagi Detal oyna
async function cbPreviewQuestion(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "preview_q_"), 10);
  const data = await getData(ctx);
  const questions = data.questions || [];

  if (idx < 0 || idx >= questions.length) return cbPreviewGrid(ctx); // Xavfsizlik

  const q = questions[idx];
  let text = `👁 *Savol batafsil* (${idx + 1} / ${questions.length})\n\n*${escapeMarkdown(q.question)}*\n\n`;
  const labels = ["A", "B", "C", "D", "E", "F"];

  q.options.forEach((opt, i) => {
    text += `${i === q.correct_index ? "✅" : "❌"} *${labels[i]})* ${escapeMarkdown(opt)}\n`;
  });

  const page = Math.floor(idx / 10); // Qaysi sahifaga tegishliligini hisoblaymiz

  await safeEdit(ctx, text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("✏️ Tahrirlash", `edit_q_${idx}`),
        Markup.button.callback("🗑 O'chirish", `del_q_${idx}`),
      ],
      [Markup.button.callback("🔙 Ro'yxatga qaytish", `preview_grid_${page}`)],
    ]),
  });
}

// O'chirish logikasi (O'chirilgach, yana Grid ro'yxatiga qaytadi)
async function cbDeleteQuestion(ctx) {
  await ctx.answerCbQuery("🗑 O'chirildi!").catch(() => {});
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, "del_q_"), 10);
  const data = await getData(ctx);
  let questions = data.questions || [];

  if (idx >= 0 && idx < questions.length) {
    questions.splice(idx, 1);
    await updateData(ctx, { questions });
  }

  // O'chirilgandan so'ng bo'shab qolgan sahifaga emas, to'g'ri sahifaga qaytarish
  let page = Math.floor(idx / 10);
  const maxPage = Math.max(0, Math.ceil(questions.length / 10) - 1);
  if (page > maxPage) page = maxPage;

  ctx.callbackQuery.data = `preview_grid_${page}`;
  return cbPreviewGrid(ctx);
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
// ─── 4. YAKUNLASH VA MENYULAR ────────────────────────────────
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

  const CHUNK_SIZE = 25; // Har bir blokdagi maksimal savollar soni
  let testIds = [];

  if (data.editing_test_id) {
    // Agar eski testni tahrirlayotgan bo'lsa, shunchaki yangilaymiz
    await dbService.updateUserTestQuestions(
      data.editing_test_id,
      ctx.from.id,
      questions,
    );
    testIds.push(data.editing_test_id);
  } else {
    // YANGI TEST YARATISH: Avto-bo'lish (Chunking)
    if (questions.length <= CHUNK_SIZE) {
      // Savollar oz bo'lsa, bitta qilib saqlaymiz
      const tId = await dbService.saveUserTest(
        ctx.from.id,
        data.subject,
        data.block_name,
        questions,
      );
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
        const tId = await dbService.saveUserTest(
          ctx.from.id,
          data.subject,
          chunkName,
          chunks[i],
        );
        testIds.push(tId);
      }
    }
  }

  const botInfo = await ctx.telegram.getMe();
  const firstTestId = testIds[0];

  const chunkMsg =
    testIds.length > 1
      ? `\n⚠️ *Avto-bo'lish:* Savollar ko'pligi uchun tizim ularni avtomatik *${testIds.length} ta blokga* ajratdi va fanga joyladi.`
      : `\n🔗 *Faqat shu blok:*\n\`https://t.me/${botInfo.username}?start=t_${firstTestId}\``;

  await safeEdit(
    ctx,
    `🎉 *Muvaffaqiyatli saqlandi!*\n\n📚 Fan: *${data.subject}*\n📝 Asosiy Blok: *${data.block_name}*\n🔢 Jami Savollar: *${questions.length} ta*${chunkMsg}\n\n🔗 *Butun fanni o'ynash (Marafon):*\n\`https://t.me/${botInfo.username}?start=s_${firstTestId}\``,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "➕ Shu fanga yana blok qo'shish",
          `ct_exist_${firstTestId}`,
        ),
      ],
      [
        Markup.button.url(
          "↗️ Guruhda o'ynash",
          `https://t.me/${botInfo.username}?startgroup=s_${firstTestId}`,
        ),
      ],
      [Markup.button.callback("📂 Mening Testlarim", "my_tests")],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]),
  );
  clearState(ctx);
}
// ─── BEKOR QILISH (SMART CANCEL & CONFIRMATION) ──────────────

async function cbCancelCreation(ctx) {
  const data = await getData(ctx) || {};
  const qCount = (data.questions || []).length;

  // 1. Agar xotirada savollar bo'lsa va hali "Tasdiqlash" bosilmagan bo'lsa
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

  // 2. Agar savat bo'sh bo'lsa Yoki foydalanuvchi "Ha, o'chirish" tugmasini bosgan bo'lsa
  clearState(ctx);
  await ctx.answerCbQuery("❌ Barchasi bekor qilindi va tozalandi.").catch(() => {});
  
  // 3. Quruq "Bekor qilindi" degan ekran o'rniga, silliq qilib "Test yaratish" (Fanlar) oynasiga qaytaramiz
  ctx.callbackQuery.data = "create_test_0";
  return cbCreateTest(ctx);
}

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
async function cbAutoDocx(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await updateData(ctx, {
    block_name: null,
    format: "docx",
    is_auto_docx: true,
  });

  await safeEdit(
    ctx,
    `⚙️ *Qaysi usulda o'qiymiz?*\n\nWord fayldagi testlarda to'g'ri javob qanday belgilangan?\n\n🎯 *# bilan:* To'g'ri javob oldida # belgisi bor.\n🥇 *1-javob:* Har doim A (birinchi) variant to'g'ri.`,
    {
      parse_mode: "Markdown",
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

// ─── 4. XATOLARNI TO'G'RILASH (ERROR RECOVERY) ──────────────

async function cbFixErrors(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const idx =
    parseInt(parseSuffix(ctx.callbackQuery.data, "fix_errors_"), 10) || 0;
  const data = await getData(ctx);
  const invalidQs = data.invalidQs || [];

  // Agar xatolar tugagan bo'lsa, panelga qaytamiz
  if (invalidQs.length === 0 || idx >= invalidQs.length) {
    await updateData(ctx, { fixing_error_index: undefined });
    return showDraftDashboard(ctx);
  }

  const badText = invalidQs[idx];
  await updateData(ctx, { fixing_error_index: idx });

  const text =
    `⚠️ *Xato Savolni To'g'rilash* (${idx + 1} / ${invalidQs.length})\n\n` +
    `Ushbu savol formatida xato bor (masalan, to'g'ri javob belgisi \`#\` unutilgan yoki variantlar kam).\n\n` +
    `*Matnni nusxalang (ustiga bossangiz nusxalanadi), to'g'rilang va menga qayta yuboring:*\n\n` +
    `\`\`\`\n${escapeMarkdown(badText)}\n\`\`\``;

  await safeEdit(ctx, text, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("⏭ O'tkazib yuborish", `fix_errors_${idx + 1}`),
        Markup.button.callback("🗑 O'chirish", `del_err_${idx}`),
      ],
      [Markup.button.callback("🔙 Panelga qaytish", "back_to_dashboard")],
    ]),
  });
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

function register(bot) {
  bot.action(/^create_test/, cbCreateTest);
  bot.action("ct_new", cbCtNew);
  bot.action(/^ct_exist_/, cbCtExist);
  bot.action(/^fmt_/, cbFmt);
  bot.action("finish_test_creation", cbFinishCreation);
  bot.action("confirm_cancel_creation", cbCancelCreation);
  bot.action("cancel_creation", cbCancelCreation);

  bot.action(/^my_tests/, cbMyTests);
  bot.action(/^manage_subj_/, cbManageSubj);
  bot.action(/^manage_test_/, cbManageTest);
  bot.action(/^delete_test_/, cbDeleteTest);
  bot.action(/^confirm_delete_/, cbConfirmDelete);

  bot.action(/^edit_test_/, cbEditTest);
  bot.action("back_to_edit_dash", cbBackToEditDash);
  bot.action("edit_add_q", cbEditAddQ);

  bot.action("back_to_block_prompt", cbBackToBlockPrompt);

  bot.action(/^preview_grid_/, cbPreviewGrid);
  bot.action(/^preview_q_/, cbPreviewQuestion);
  bot.action(/^del_q_/, cbDeleteQuestion);

  // Local Preview (Faqatgina joriy qo'shilganlarni ko'rish uchun oxirgi sahifaga otadi)
  bot.action("preview_local_0", async (ctx) => {
    const data = await getData(ctx);
    const qCount = (data.questions || []).length;
    const lastPage = Math.max(0, Math.ceil(qCount / 10) - 1);

    // Soxta so'rov yasab, to'g'ridan-to'g'ri Gridning eng oxirgi sahifasini ochamiz!
    ctx.callbackQuery.data = `preview_grid_${lastPage}`;
    return cbPreviewGrid(ctx);
  });

  bot.action(/^edit_q_/, cbEditQuestionStart);

  bot.action("ai_mode_text", cbAiModeText);
  bot.action("ai_mode_questions", cbAiModeQuestions);
  bot.action("ai_mode_image", cbAiModeImage);
  bot.action(/^ai_cnt_/, cbAiCount);

  bot.action("auto_docx", cbAutoDocx);
  bot.action("back_to_dashboard", cbBackToDashboard);

  bot.action(/^parse_(hash|first)_(text|docx)/, cbParseModeSelect);
  bot.action("ignore", (ctx) => ctx.answerCbQuery().catch(() => {}));

  bot.action("auto_docx_init", cbAutoDocxInit); // YANGI
  bot.action("back_to_formats", cbBackToFormats); // YANGI
  bot.action("show_status_menu", async (ctx) => {
    // YANGI
    await ctx.answerCbQuery().catch(() => {});
    await showCreationStatusMenu(ctx);
  });

  bot.action(/^fix_errors_/, cbFixErrors);
  bot.action(/^del_err_/, cbDeleteError);
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
