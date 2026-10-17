"use strict";
const redisConnection = require("../services/redisService");
const dbService = require("../services/dbService");
const {
  States,
  setState,
  clearState,
  safeEdit,
  escapeHtml,
} = require("../core/utils");
const { Markup } = require("telegraf");
const logger = require("../core/logger");
// ==========================================
// 1. JAVONGA SAQLASH (SAVE) MANTIQI
// ==========================================
// ─── TESTNI JAVONGA SAQLASH (REDIS ORQALI) ────────────────────
async function cbShelfSaveInit(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;

  try {
    const rawData = await redisConnection.get(`shelf_pending:${chatId}`);
    if (!rawData) {
      return safeEdit(
        ctx, 
        "⚠️ <b>Ma'lumot topilmadi!</b>\n\nBu test allaqachon saqlangan yoki xotira muddati tugagan. Iltimos, yangi test yakunlab qaytadan urinib ko'ring.", 
        { 
          parse_mode: "HTML", 
          ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]]) 
        }
      );
    }

    const data = JSON.parse(rawData);
    const shelf = await dbService.getUserShelf(ctx.from.id).catch(() => ({}));
    const folders = Object.keys(shelf || {});

    const buttons = [];
    folders.forEach(f => {
      buttons.push([Markup.button.callback(`📁 ${f} papkasiga`, `sh_save_${f}`)]);
    });
    if (data.subject && !folders.includes(data.subject)) {
      buttons.push([Markup.button.callback(`📁 "${data.subject}" papkasiga`, `sh_save_${data.subject}`)]);
    }
    buttons.push([Markup.button.callback("➕ Yangi papka ochish", "sh_new_folder")]);
    buttons.push([Markup.button.callback("❌ Bekor qilish", "back_to_main")]);

    return safeEdit(
      ctx,
      `📥 <b>Testni Javonga Saqlash</b>\n\n` +
      `📚 Fan: <b>${escapeHtml(data.subject || 'Noma\'lum')}</b>\n` +
      `🔖 Blok: <b>${escapeHtml(data.testName || data.block_name || 'Test')}</b>\n\n` +
      `Testni qaysi papkaga saqlamoqchisiz? Quyidagilardan tanlang yoki yangi papka oching:`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard(buttons),
      }
    );
  } catch (error) {
    console.error(`Javonga saqlashda xatolik [Chat: ${chatId}]:`, error.message);
    return safeEdit(
      ctx,
      "❌ <b>Xatolik yuz berdi!</b>\n\nIltimos, qaytadan urinib ko'ring.",
      { 
        parse_mode: "HTML", 
        ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]]) 
      }
    );
  }
}
async function cbShelfNewFolder(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    setState(ctx, States.CREATE_SHELF_FOLDER);
    await safeEdit(
      ctx,
      `📁 <b>Yangi papka yaratish</b>\n\nPapka nomini kiriting (2–30 belgi).\n\n💡 <i>Masalan: "Ertangi imtihon", "Biologiya takrorlash", "Final savollar"</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("❌ Bekor qilish", "sh_cancel")],
        ]),
      }
    );
  } catch (e) {
    console.error(e);
  }
}

async function onNewFolderInput(ctx) {
  try {
    const folderName = ctx.message.text.trim();
    if (folderName.length > 30)
      return ctx.reply(
        "⚠️ Papka nomi juda uzun! Iltimos, 30 ta belgidan oshmaydigan nom kiriting.\n\n💡 Qisqa va tushunarli nom tanlang.",
      );
    if (folderName.length < 2)
      return ctx.reply("⚠️ Papka nomi juda qisqa. Kamida 2 ta belgi kiriting.\n\n💡 Masalan: \"Midterm\", \"5-Bob\"");

    const msg = await ctx.reply("⏳ <i>Saqlanmoqda...</i>", {
      parse_mode: "HTML",
    });
    await executeSave(ctx, folderName, msg.message_id);
  } catch (e) {
    console.error(e);
  }
}

async function cbShelfSaveFolder(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const folderName = ctx.callbackQuery.data.replace("sh_save_", "");
    await safeEdit(ctx, "⏳ <i>Saqlanmoqda...</i>", { parse_mode: "HTML" });
    await executeSave(ctx, folderName, ctx.callbackQuery.message.message_id);
  } catch (e) {
    console.error(e);
  }
}

// src/handlers/shelfHandlers.js fayli ichida:

async function executeSave(ctx, folderName, msgId) {
  try {
    const chatId = ctx.chat?.id || ctx.from?.id;
    const rawPending = await redisConnection.get(`shelf_pending:${chatId}`);

    // Faqat inline tugma ishlatamiz (xatolik bermasligi uchun)
    const inlineMain = Markup.inlineKeyboard([
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]);

    if (!rawPending) {
      clearState(ctx);
      return ctx.telegram
        .editMessageText(
          chatId,
          msgId,
          undefined,
          "⚠️ Test ma'lumotlari topilmadi.\n\nBu test allaqachon saqlangan yoki sessiya muddati tugagan bo'lishi mumkin. Iltimos, yangi test yakunlab qaytadan urinib ko'ring.",
          inlineMain,
        )
        .catch(() => {});
    }

    const pendingTest = JSON.parse(rawPending);

    const result = await dbService.saveTestToShelf(
      ctx.from.id,
      folderName,
      pendingTest,
    );
    clearState(ctx);

    if (result === "exist") {
      await ctx.telegram
        .editMessageText(
          chatId,
          msgId,
          undefined,
          `⚠️ Bu test <b>${escapeHtml(folderName)}</b> papkasida allaqachon saqlangan.\n\n💡 Boshqa papka tanlang yoki yangi papka yarating.`,
          { parse_mode: "HTML", ...inlineMain },
        )
        .catch(() => {});
    } else if (result === "saved") {
      await redisConnection.del(`shelf_pending:${chatId}`).catch(() => {});
      logger.info('shelf:save', { userId: ctx.from.id, folder: folderName });
      await ctx.telegram
        .editMessageText(
          chatId,
          msgId,
          undefined,
          `✅ Test <b>${escapeHtml(folderName)}</b> papkasiga muvaffaqiyatli saqlandi!\n\n📥 Asosiy menyudagi <b>\"Javon\"</b> bo'limidan istalgan paytda qolgan joyidan davom ettirishingiz mumkin.`,
          { parse_mode: "HTML", ...inlineMain },
        )
        .catch(() => {});
    } else {
      await ctx.telegram
        .editMessageText(
          chatId,
          msgId,
          undefined,
          "⚠️ Saqlashda kutilmagan xatolik yuz berdi. Iltimos, bir ozdan so'ng qaytadan urinib ko'ring.",
          inlineMain,
        )
        .catch(() => {});
    }
  } catch (e) {
    console.error("executeSave xatosi:", e);
    clearState(ctx);
    const inlineMain = Markup.inlineKeyboard([
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]);
    await ctx.telegram
      .editMessageText(
        ctx.chat?.id,
        msgId,
        undefined,
        "⚠️ Kutilmagan tizim xatosi yuz berdi. Iltimos, keyinroq urinib ko'ring yoki adminga murojaat qiling.",
        inlineMain,
      )
      .catch(() => {});
  }
}

async function cbShCancel(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery("Bekor qilindi").catch(() => {});
  return cbMyShelf(ctx);
}

// ==========================================
// 2. MENING JAVONIM (DASHBOARD) MANTIQI
// ==========================================
async function cbMyShelf(ctx) {
  clearState(ctx);
  try {
    await ctx.answerCbQuery().catch(() => {});
    const shelf = await dbService.getUserShelf(ctx.from.id);
    const folders = Object.keys(shelf || {});

    if (folders.length === 0) {
      const emptyText = `📥 <b>Javon — Sizning shaxsiy arxivingiz</b>\n\n` +
        `📭 Hozircha bu yerda hech narsa yo'q.\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `<b>Javon nima?</b>\n` +
        `Javon — bu sizning testlaringiz uchun shaxsiy arxiv. Istalgan testni to'xtatib, saqlang va keyinroq qolgan joyidan davom eting.\n\n` +
        `✨ <b>Nimalar mumkin:</b>\n` +
        `• Testni to'xtatib, keyinroq davom ettirish\n` +
        `• Testlarni papkalarga ajratib tartibga solish\n` +
        `• Imtihon oldidan saqlangan testlarni qayta yechish\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `💡 <b>Qanday saqlash mumkin?</b>\n` +
        `Test yakunlangach yoki /stop orqali to'xtatganda "📥 Javonga saqlash" tugmasi paydo bo'ladi.`;

      return safeEdit(ctx, emptyText, {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
        ]),
      });
    }

    const buttons = [];
    folders.forEach((folder) => {
      buttons.push([
        Markup.button.callback(
          `📁 ${folder} (${shelf[folder].length} ta)`,
          `sh_open_${folder}`,
        ),
      ]);
    });
    buttons.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);

    await safeEdit(ctx, `📥 <b>Javon — Papkalaringiz</b>\n\n${folders.length} ta papka mavjud. Ochish uchun tanlang:`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.error(e);
  }
}

async function cbOpenFolder(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const folderName = ctx.callbackQuery.data.replace("sh_open_", "");
    const shelf = await dbService.getUserShelf(ctx.from.id);
    const folderTests = shelf[folderName] || [];

    const buttons = [];
    folderTests.forEach((test, idx) => {
      const displayName =
        test.testName.length > 25
          ? test.testName.slice(0, 22) + "..."
          : test.testName;
      buttons.push([
        Markup.button.callback(
          `📝 ${displayName}`,
          `sh_view_${folderName}_${idx}`,
        ),
      ]);
    });

    buttons.push([
      Markup.button.callback(
        "🗑 Papkani o'chirish",
        `sh_del_folder_${folderName}`,
      ),
    ]);
    buttons.push([
      Markup.button.callback("🔙 Orqaga", "my_shelf"),
      Markup.button.callback("🏠 Asosiy Menyu", "back_to_main"),
    ]);

    await safeEdit(ctx, `📁 <b>Papka:</b> ${escapeHtml(folderName)}\n\nSaqlangan testlar:`, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.error(e);
  }
}
async function cbViewTest(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const suffix = ctx.callbackQuery.data.replace("sh_view_", "");
    const parts = suffix.split("_");
    const idx = parseInt(parts.pop(), 10);
    const folderName = parts.join("_");

    const shelf = await dbService.getUserShelf(ctx.from.id);
    const test = (shelf[folderName] || [])[idx];

    if (!test)
      return safeEdit(
        ctx,
        "❌ Test topilmadi yoki o'chirilgan.",
        Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Javonga", "my_shelf")],
        ]),
      );

    const qCount = test.questions ? test.questions.length : 0;
    let progressText = "▶️ Hali boshlanmagan (Noldan boshlanadi)";
    let resumeBtnText = "▶️ Testni Boshlash";

    if (test.progress && test.progress.current_index > 0) {
      const mCount = test.progress.mistakes ? test.progress.mistakes.length : 0;
      progressText = `⏳ ${test.progress.current_index}-savolga kelgan.\n(✅ ${test.progress.correct} to'g'ri | ❌ ${mCount} xato)`;
      resumeBtnText = "▶️ Qolgan joyidan davom etish";
    }

    const text = `📝 <b>Test Tafsilotlari</b>\n\n` +
      `🔖 <b>Test nomi:</b> ${escapeHtml(test.testName || "Noma'lum")}\n` +
      `📚 <b>Fan:</b> ${escapeHtml(test.subject || "Noma'lum")}\n` +
      `🔢 <b>Jami savollar:</b> ${qCount} ta\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📊 <b>Hozirgi holat:</b>\n${progressText}\n` +
      `📅 <b>Saqlangan sana:</b> ${escapeHtml(String(test.saved_at || '').slice(0, 10))}\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `💡 <b>Maslahat:</b> Testni qolgan joyidan davom ettirganingizda, oldingi natijalaringiz (to'g'ri/xatolar) saqlanib qoladi va test vaqti asabingizni buzmaydi.`;

    const buttons = [
      [Markup.button.callback(resumeBtnText, `sh_run_${folderName}_${idx}`)],
      [
        Markup.button.callback(
          "🗑 Javondan o'chirish",
          `sh_del_test_${folderName}_${idx}`,
        ),
      ],
      [Markup.button.callback("🔙 Papkaga qaytish", `sh_open_${folderName}`)],
    ];

    await safeEdit(ctx, text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.error(e);
  }
}

async function cbDeleteTest(ctx) {
  try {
    await ctx.answerCbQuery("✅ Test o'chirildi!").catch(() => {});
    const suffix = ctx.callbackQuery.data.replace("sh_del_test_", "");
    const parts = suffix.split("_");
    const idx = parseInt(parts.pop(), 10);
    const folderName = parts.join("_");

    const shelf = await dbService.getUserShelf(ctx.from.id);
    if (shelf[folderName]) {
      shelf[folderName].splice(idx, 1);
      if (shelf[folderName].length === 0) delete shelf[folderName];
      await dbService.updateUserShelf(ctx.from.id, shelf);
    }

    ctx.callbackQuery.data = `sh_open_${folderName}`;
    await cbOpenFolder(ctx);
  } catch (e) {
    console.error(e);
  }
}

async function cbDeleteFolder(ctx) {
  try {
    await ctx.answerCbQuery("✅ Papka o'chirildi!").catch(() => {});
    const folderName = ctx.callbackQuery.data.replace("sh_del_folder_", "");
    const shelf = await dbService.getUserShelf(ctx.from.id);
    if (shelf[folderName]) {
      delete shelf[folderName];
      await dbService.updateUserShelf(ctx.from.id, shelf);
    }
    await cbMyShelf(ctx);
  } catch (e) {
    console.error(e);
  }
}

async function cbRunTest(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const suffix = ctx.callbackQuery.data.replace("sh_run_", "");
    const parts = suffix.split("_");
    const idx = parseInt(parts.pop(), 10);
    const folderName = parts.join("_");

    const shelf = await dbService.getUserShelf(ctx.from.id);
    const test = (shelf[folderName] || [])[idx];

    if (!test) return safeEdit(ctx, "❌ Test topilmadi.");

    const quizGame = require("./quizGame");
    await quizGame.resumeTestFromShelf(ctx, test);
  } catch (e) {
    console.error(e);
    await ctx.reply("❌ Testni yuklashda xato yuz berdi.");
  }
}

// ==========================================
// BARCHA TUGMALARNI RO'YXATDAN O'TKAZISH
// ==========================================
function register(bot) {
  bot.action("my_shelf", cbMyShelf);
  bot.action("menu_shelf", cbMyShelf);
  bot.action("shelf_save_init", cbShelfSaveInit);
  bot.action("sh_new_folder", cbShelfNewFolder);
  bot.action("sh_cancel", cbShCancel);

  // RegEx orqali ishlaydigan dinamik tugmalar
  bot.action(/^sh_save_/, cbShelfSaveFolder);
  bot.action(/^sh_open_/, cbOpenFolder);
  bot.action(/^sh_view_/, cbViewTest);
  bot.action(/^sh_del_test_/, cbDeleteTest);
  bot.action(/^sh_del_folder_/, cbDeleteFolder);
  bot.action(/^sh_run_/, cbRunTest);
}

module.exports = { register, onNewFolderInput, cbMyShelf };
