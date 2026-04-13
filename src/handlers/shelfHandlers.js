'use strict';

const dbService = require('../services/dbService');
const { States, setState, clearState, safeEdit, backToMainKb } = require('../core/utils');
const { Markup } = require('telegraf');

// ==========================================
// 1. JAVONGA SAQLASH (SAVE) MANTIQI
// ==========================================
async function cbShelfSaveInit(ctx) {
    try {
        const chatId = ctx.chat?.id || ctx.from?.id;
        global.pendingShelfSaves = global.pendingShelfSaves || new Map();
        const pendingTest = global.pendingShelfSaves.get(chatId);

        if (!pendingTest) {
            return ctx.answerCbQuery("⚠️ Saqlash uchun test topilmadi yoki bu amaliyot eskirgan.", { show_alert: true }).catch(() => { });
        }
        await ctx.answerCbQuery().catch(() => { });

        const shelf = await dbService.getUserShelf(ctx.from.id);
        const folders = Object.keys(shelf || {});
        const buttons = [];

        folders.forEach(folder => {
            buttons.push([Markup.button.callback(`📁 ${folder} (${shelf[folder].length} ta)`, `sh_save_${folder}`)]);
        });

        buttons.push([Markup.button.callback('➕ Yangi papka yaratish', 'sh_new_folder')]);
        buttons.push([Markup.button.callback('❌ Bekor qilish', 'sh_cancel')]);

        await safeEdit(ctx, `📥 *Javonga saqlash*\n\nTest: *${pendingTest.testName}*\n\n⬇️ Qaysi papkaga saqlaymiz?`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch (error) {
        console.error("cbShelfSaveInit xatosi:", error);
        await ctx.answerCbQuery("❌ Tizimda xatolik yuz berdi.", { show_alert: true }).catch(() => { });
    }
}

async function cbShelfNewFolder(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });
        setState(ctx, States.CREATE_SHELF_FOLDER);
        await safeEdit(ctx, `📁 *Yangi papka*\n\nPapka nomini kiriting (Masalan: "Ertangi imtihon"):`, Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'sh_cancel')]]));
    } catch (e) { console.error(e); }
}

async function onNewFolderInput(ctx) {
    try {
        const folderName = ctx.message.text.trim();
        if (folderName.length > 30) return ctx.reply("⚠️ Papka nomi 30 ta belgidan oshmasligi kerak. Qaytadan yozing:");
        if (folderName.length < 2) return ctx.reply("⚠️ Papka nomi juda qisqa. Qaytadan yozing:");

        const msg = await ctx.reply("⏳ <i>Saqlanmoqda...</i>", { parse_mode: 'HTML' });
        await executeSave(ctx, folderName, msg.message_id);
    } catch (e) { console.error(e); }
}

async function cbShelfSaveFolder(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });
        const folderName = ctx.callbackQuery.data.replace('sh_save_', '');
        await safeEdit(ctx, "⏳ <i>Saqlanmoqda...</i>", { parse_mode: 'HTML' });
        await executeSave(ctx, folderName, ctx.callbackQuery.message.message_id);
    } catch (e) { console.error(e); }
}

async function executeSave(ctx, folderName, msgId) {
    try {
        const chatId = ctx.chat?.id || ctx.from?.id;
        global.pendingShelfSaves = global.pendingShelfSaves || new Map();
        const pendingTest = global.pendingShelfSaves.get(chatId);

        if (!pendingTest) {
            clearState(ctx);
            return ctx.telegram.editMessageText(chatId, msgId, undefined, "⚠️ Xatolik: Xotiradan test topilmadi.", backToMainKb()).catch(() => { });
        }

        const result = await dbService.saveTestToShelf(ctx.from.id, folderName, pendingTest);
        clearState(ctx);

        if (result === 'exist') {
            await ctx.telegram.editMessageText(chatId, msgId, undefined, `⚠️ Bu test *${folderName}* papkasida allaqachon mavjud!`, { parse_mode: 'Markdown', ...backToMainKb() }).catch(() => { });
        } else if (result === 'saved') {
            global.pendingShelfSaves.delete(chatId);
            await ctx.telegram.editMessageText(chatId, msgId, undefined, `✅ Test *${folderName}* papkasiga saqlandi!`, { parse_mode: 'Markdown', ...backToMainKb() }).catch(() => { });
        } else {
            await ctx.telegram.editMessageText(chatId, msgId, undefined, "❌ Saqlashda xatolik yuz berdi.", backToMainKb()).catch(() => { });
        }
    } catch (e) {
        console.error("executeSave xatosi:", e);
        clearState(ctx);
        await ctx.telegram.editMessageText(ctx.chat?.id, msgId, undefined, "❌ Kutilmagan tizim xatosi.", backToMainKb()).catch(() => { });
    }
}

async function cbShCancel(ctx) {
    clearState(ctx);
    await ctx.answerCbQuery().catch(() => { });
    await safeEdit(ctx, "❌ Bekor qilindi.", backToMainKb());
}

// ==========================================
// 2. MENING JAVONIM (DASHBOARD) MANTIQI
// ==========================================
async function cbMyShelf(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });
        const shelf = await dbService.getUserShelf(ctx.from.id);
        const folders = Object.keys(shelf || {});

        if (folders.length === 0) {
            return safeEdit(ctx, `📚 *Sizning Javoningiz bo'sh*\n\nTestlarni ishlash jarayonida "Javonga saqlash" tugmasi orqali bu yerda o'z kutubxonangizni yaratishingiz mumkin.`,
                Markup.inlineKeyboard([[Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]]));
        }

        const buttons = [];
        folders.forEach(folder => {
            buttons.push([Markup.button.callback(`📁 ${folder} (${shelf[folder].length} ta)`, `sh_open_${folder}`)]);
        });
        buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]);

        await safeEdit(ctx, `📚 *Sizning Javoningiz*\n\nPapkalar ro'yxati:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch (e) { console.error(e); }
}

async function cbOpenFolder(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });
        const folderName = ctx.callbackQuery.data.replace('sh_open_', '');
        const shelf = await dbService.getUserShelf(ctx.from.id);
        const folderTests = shelf[folderName] || [];

        const buttons = [];
        folderTests.forEach((test, idx) => {
            const displayName = test.testName.length > 25 ? test.testName.slice(0, 22) + '...' : test.testName;
            buttons.push([Markup.button.callback(`📝 ${displayName}`, `sh_view_${folderName}_${idx}`)]);
        });

        buttons.push([Markup.button.callback('🗑 Papkani o\'chirish', `sh_del_folder_${folderName}`)]);
        buttons.push([Markup.button.callback('🔙 Orqaga', 'my_shelf')]);

        await safeEdit(ctx, `📁 *Papka:* ${folderName}\n\nSaqlangan testlar:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch (e) { console.error(e); }
}

async function cbViewTest(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });
        const suffix = ctx.callbackQuery.data.replace('sh_view_', '');
        const parts = suffix.split('_');
        const idx = parseInt(parts.pop(), 10);
        const folderName = parts.join('_');

        const shelf = await dbService.getUserShelf(ctx.from.id);
        const test = (shelf[folderName] || [])[idx];

        if (!test) return safeEdit(ctx, "❌ Test topilmadi.", Markup.inlineKeyboard([[Markup.button.callback('🔙 Javonga', 'my_shelf')]]));

        const qCount = test.questions ? test.questions.length : 0;
        let progressText = "Noldan boshlanadi";
        let resumeBtnText = "▶️ Boshlash";

        if (test.progress && test.progress.current_index > 0) {
            const mCount = test.progress.mistakes ? test.progress.mistakes.length : 0;
            progressText = `${test.progress.current_index}-savolga kelgan.\n(✅ ${test.progress.correct} to'g'ri | ❌ ${mCount} xato)`;
            resumeBtnText = "▶️ Qolgan joyidan davom etish";
        }

        const buttons = [
            [Markup.button.callback(resumeBtnText, `sh_run_${folderName}_${idx}`)],
            [Markup.button.callback('🗑 Javondan o\'chirish', `sh_del_test_${folderName}_${idx}`)],
            [Markup.button.callback('🔙 Papkaga qaytish', `sh_open_${folderName}`)]
        ];

        await safeEdit(ctx, `📝 *Test:* ${test.testName}\n📚 *Fan:* ${test.subject}\n🔢 *Savollar:* ${qCount} ta\n📊 *Holat:* ${progressText}\n📅 *Saqlangan:* ${String(test.saved_at).slice(0, 10)}\n\nNima qilamiz?`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch (e) { console.error(e); }
}

async function cbDeleteTest(ctx) {
    try {
        await ctx.answerCbQuery("✅ Test o'chirildi!").catch(() => { });
        const suffix = ctx.callbackQuery.data.replace('sh_del_test_', '');
        const parts = suffix.split('_');
        const idx = parseInt(parts.pop(), 10);
        const folderName = parts.join('_');

        const shelf = await dbService.getUserShelf(ctx.from.id);
        if (shelf[folderName]) {
            shelf[folderName].splice(idx, 1);
            if (shelf[folderName].length === 0) delete shelf[folderName];
            await dbService.supabase.from('user_stats').update({ shelf }).eq('user_id', String(ctx.from.id));
        }

        ctx.callbackQuery.data = `sh_open_${folderName}`;
        await cbOpenFolder(ctx);
    } catch (e) { console.error(e); }
}

async function cbDeleteFolder(ctx) {
    try {
        await ctx.answerCbQuery("✅ Papka o'chirildi!").catch(() => { });
        const folderName = ctx.callbackQuery.data.replace('sh_del_folder_', '');
        const shelf = await dbService.getUserShelf(ctx.from.id);
        if (shelf[folderName]) {
            delete shelf[folderName];
            await dbService.supabase.from('user_stats').update({ shelf }).eq('user_id', String(ctx.from.id));
        }
        await cbMyShelf(ctx);
    } catch (e) { console.error(e); }
}

async function cbRunTest(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });
        const suffix = ctx.callbackQuery.data.replace('sh_run_', '');
        const parts = suffix.split('_');
        const idx = parseInt(parts.pop(), 10);
        const folderName = parts.join('_');

        const shelf = await dbService.getUserShelf(ctx.from.id);
        const test = (shelf[folderName] || [])[idx];

        if (!test) return safeEdit(ctx, "❌ Test topilmadi.");

        const quizGame = require('./quizGame');
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
    bot.action('my_shelf', cbMyShelf);
    bot.action('shelf_save_init', cbShelfSaveInit);
    bot.action('sh_new_folder', cbShelfNewFolder);
    bot.action('sh_cancel', cbShCancel);

    // RegEx orqali ishlaydigan dinamik tugmalar
    bot.action(/^sh_save_/, cbShelfSaveFolder);
    bot.action(/^sh_open_/, cbOpenFolder);
    bot.action(/^sh_view_/, cbViewTest);
    bot.action(/^sh_del_test_/, cbDeleteTest);
    bot.action(/^sh_del_folder_/, cbDeleteFolder);
    bot.action(/^sh_run_/, cbRunTest);
}

module.exports = { register, onNewFolderInput };