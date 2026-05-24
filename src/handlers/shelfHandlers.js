"use strict";
const redisConnection = require("../services/redisService");
const dbService = require("../services/dbService");
const {
  States,
  setState,
  clearState,
  safeEdit,
  backToMainKb,
  safeAnswerCb,
} = require("../core/utils");
const { Markup } = require("telegraf");
const { pendingShelfSaves } = require("../core/pendingStore");
const logger = require("../core/logger");
// ==========================================
// 1. JAVONGA SAQLASH (SAVE) MANTIQI
// ==========================================
// ─── TESTNI JAVONGA SAQLASH (REDIS ORQALI) ────────────────────
async function cbShelfSaveInit(ctx) {
  await ctx.answerCbQuery("⏳ Saqlanmoqda...").catch(() => {});
  const chatId = ctx.chat.id;

  try {
    // 1. RAM o'rniga ishonchli Redis xotirasidan o'qiymiz
    const rawData = await redisConnection.get(`shelf_pending:${chatId}`);
    
    // Agar xotira muddati tugagan bo'lsa yoki allaqachon saqlangan bo'lsa
    if (!rawData) {
      return safeEdit(
        ctx, 
        "⚠️ <b>Ma'lumot topilmadi!</b>\n\nBu test allaqachon saqlangan yoki xotira muddati (24 soat) tugagan. Iltimos, menyudan yangi test ishlashni boshlang.", 
        { 
          parse_mode: "HTML", 
          ...Markup.inlineKeyboard([[Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]]) 
        }
      );
    }

    const data = JSON.parse(rawData);

    // 2. Ma'lumotlarni asosiy bazaga (PostgreSQL) yozamiz
    // (Loyihangizdagi dbService funksiyasiga moslab yozilgan)
    await dbService.saveToShelf(ctx.from.id, {
      test_id: data.testId,
      test_name: data.testName,
      subject: data.subject,
      questions: data.questions,
      progress: data.progress
    });

    // 3. Saqlab bo'lingach, qulupnaydek toza bo'lishi uchun Redis'dan tozalab tashlaymiz
    await redisConnection.del(`shelf_pending:${chatId}`);

    // 4. Foydalanuvchiga muvaffaqiyatli saqlanganini bildiramiz
    await safeEdit(
      ctx,
      `📥 <b>Muvaffaqiyatli saqlandi!</b>\n\n📚 Fan: <b>${data.subject}</b>\n🔖 Blok: <b>${data.testName}</b>\n\nSiz bu testni shaxsiy javoningizga saqladingiz. Xohlagan vaqtingiz <i>"Javon"</i> menyusi orqali qayta ishlashingiz mumkin. ✅`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("📚 Javonga o'tish", "menu_shelf")],
          [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]
        ])
      }
    );

  } catch (error) {
    console.error(`Javonga saqlashda xatolik [Chat: ${chatId}]:`, error.message);
    
    await safeEdit(
      ctx,
      "❌ <b>Tizimli xatolik!</b>\n\nJavonga saqlashda kutilmagan xatolik yuz berdi. Iltimos, birozdan so'ng yana urinib ko'ring.",
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
      `📁 *Yangi papka yaratish*\n\nPapka nomini kiriting (2–30 belgi).\n\n💡 _Masalan: "Ertangi imtihon", "Biologiya takrorlash", "Final savollar"_`,
      Markup.inlineKeyboard([
        [Markup.button.callback("❌ Bekor qilish", "sh_cancel")],
      ]),
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
    const pendingTest = pendingShelfSaves.get(chatId);

    // Faqat inline tugma ishlatamiz (xatolik bermasligi uchun)
    const inlineMain = Markup.inlineKeyboard([
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ]);

    if (!pendingTest) {
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
          `⚠️ Bu test <b>${folderName}</b> papkasida allaqachon saqlangan.\n\n💡 Boshqa papka tanlang yoki yangi papka yarating.`,
          { parse_mode: "HTML", ...inlineMain },
        )
        .catch(() => {});
    } else if (result === "saved") {
      pendingShelfSaves.delete(chatId);
      logger.info('shelf:save', { userId: ctx.from.id, folder: folderName });
      await ctx.telegram
        .editMessageText(
          chatId,
          msgId,
          undefined,
          `✅ Test <b>${folderName}</b> papkasiga muvaffaqiyatli saqlandi!\n\n📥 Asosiy menyudagi <b>\"Javon\"</b> bo'limidan istalgan paytda qolgan joyidan davom ettirishingiz mumkin.`,
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
  await ctx.answerCbQuery().catch(() => {});
  await safeEdit(ctx, "❌ Bekor qilindi.", backToMainKb());
}

// ==========================================
// 2. MENING JAVONIM (DASHBOARD) MANTIQI
// ==========================================
async function cbMyShelf(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const shelf = await dbService.getUserShelf(ctx.from.id);
    const folders = Object.keys(shelf || {});

    if (folders.length === 0) {
      const emptyText = `📥 *Javon — Sizning shaxsiy arxivingiz*

📭 Hozircha bu yerda hech narsa yo'q.

━━━━━━━━━━━━━━━━
*Javon nima?*
Javon — bu sizning testlaringiz uchun shaxsiy arxiv. Istalgan testni to'xtatib, saqlang va keyinroq qolgan joyidan davom eting.

✨ *Nimalar mumkin:*
• Testni to'xtatib, keyinroq davom ettirish
• Testlarni papkalarga ajratib tartibga solish
• Imtihon oldidan saqlangan testlarni qayta yechish

━━━━━━━━━━━━━━━━
💡 *Qanday saqlash mumkin?*
Test yakunlangach yoki /stop orqali to'xtatganda "📥 Javonga saqlash" tugmasi paydo bo'ladi.`;

      return safeEdit(ctx, emptyText, {
        parse_mode: "Markdown",
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

    await safeEdit(ctx, `📥 *Javon — Papkalaringiz*\n\n${folders.length} ta papka mavjud. Ochish uchun tanlang:`, {
      parse_mode: "Markdown",
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

    await safeEdit(ctx, `📁 *Papka:* ${folderName}\n\nSaqlangan testlar:`, {
      parse_mode: "Markdown",
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

    const text = `📝 *Test Tafsilotlari*

🔖 *Test nomi:* ${test.testName}
📚 *Fan:* ${test.subject}
🔢 *Jami savollar:* ${qCount} ta

━━━━━━━━━━━━━━━━
📊 *Hozirgi holat:*
${progressText}
📅 *Saqlangan sana:* ${String(test.saved_at).slice(0, 10)}
━━━━━━━━━━━━━━━━

💡 *Maslahat:* Testni qolgan joyidan davom ettirganingizda, oldingi natijalaringiz (to'g'ri/xatolar) saqlanib qoladi va test vaqti asabingizni buzmaydi.`;

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
      parse_mode: "Markdown",
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

module.exports = { register, onNewFolderInput };
