'use strict';

const dbService = require('../services/dbService');
const { getMainKeyboard } = require('../keyboards/keyboards');
const sessionService = require('../services/sessionService');
const {
  userNameCache, clearState, safeEdit, backToMainKb,
} = require('../core/utils');

async function cmdStart(ctx) {
  clearState(ctx);
  const chatId = ctx.chat.id;

  await dbService.registerUser(
    ctx.from.id,
    ctx.from.first_name ? `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}` : 'Foydalanuvchi',
    ctx.from.username,
  );
  userNameCache.set(ctx.from.id, ctx.from.first_name ? `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}` : 'Foydalanuvchi');

  let cleared = false;
  // YANGILANISH: Redis'dan kutish xonalarini o'qiymiz va tozalaymiz
  const room = await sessionService.getWaitingRoom(chatId);
  if (room) {
    await sessionService.deleteWaitingRoom(chatId);
    cleared = true;
  }
  // YANGILANISH: Redis'dan faol testlarni o'qiymiz va tozalaymiz
  const session = await sessionService.getActiveTest(chatId);
  if (session) {
    if (session.pollId) await sessionService.deletePollChat(session.pollId);
    await sessionService.deleteActiveTest(chatId);
    cleared = true;
  }
  if (cleared) await ctx.reply('🔄 Tugallanmagan test tozalandi. Yangi boshlashingiz mumkin!');

  // LINK ORQALI KIRGANDA (Deep Linking) - O'zgarishsiz qoldirildi
  const args = (ctx.message.text || '').split(' ');
  if (args.length > 1) {
    const param = args[1];
    if (param.startsWith('s_')) {
      const testData = await dbService.getUserTest(param.slice(2));
      if (!testData) return ctx.reply('❌ Bu fan topilmadi yoki o\'chirilgan.', backToMainKb());
      const { showUgcSubjectBlocks } = require('./quizGame');
      return showUgcSubjectBlocks(ctx, testData.creator_id, testData.subject);
    }
    if (param.startsWith('t_')) {
      const testData = await dbService.getUserTest(param.slice(2));
      if (testData) {
        const { startUgcTest } = require('./quizGame');
        return startUgcTest(ctx, testData);
      }
      return ctx.reply('❌ Bu blok topilmadi yoki o\'chirilgan.', backToMainKb());
    }
  }

  // --- UX/UI YANGILANISHI (Onboarding) ---
  const firstName = ctx.from.first_name || 'Talaba';
  const welcomeText = `👋 Salom, *${firstName}*! 🏛 Talabalar Imtihon Trenajyoriga xush kelibsiz.

Bu bot sizga imtihonlarga tayyorgarlik ko'rishda yordam beradi — AI yordamida test yechib, xatolaringizni tahlil qilib va o'z reytingingizni ko'tarib, har kuni bir qadam oldinga siljishingiz mumkin.

━━━━━━━━━━━━━━━━
✨ *Nimalar qila olasiz?*
📚 *Rasmiy testlar* — Tayyor baza va Adaptiv testlar
🤖 *AI Tutor* — Matn/rasmdan test va xatolar tahlili
📝 *Test yaratish* — O'z bloklaringizni yaratish
📖 *Javon* — Testlarni saqlash va davom ettirish
📊 *Reyting* — Eng yaxshi talabalar qatorida bo'lish
━━━━━━━━━━━━━━━━

👇 *Quyidagi menyudan boshlang:*`;

  await ctx.reply(welcomeText, { parse_mode: 'Markdown', ...getMainKeyboard() });
}

async function cbBackToMain(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery().catch(() => {});
  const firstName = ctx.from.first_name || 'Talaba';
  const welcomeText = `🏛 *Asosiy Menyu* \n\nQuyidagi bo'limlardan birini tanlang, ${firstName}:`;
  await safeEdit(ctx, welcomeText, { parse_mode: 'Markdown', ...getMainKeyboard() });
}

async function cmdStop(ctx) {
  clearState(ctx);
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  // YANGILANISH: Redis'dan kutish xonalarini o'qiymiz
  const sessionService = require('../services/sessionService');
  const room = await sessionService.getWaitingRoom(chatId);
  
  if (room) {
    if (userId === room.initiatorId || ctx.chat.type === 'private') {
      await sessionService.deleteWaitingRoom(chatId);
      return ctx.reply('🛑 Test bekor qilindi.', backToMainKb());
    }
    return ctx.reply('⚠️ Faqat testni boshlagan kishi bekor qila oladi!');
  }

  // YANGILANISH: Redis'dan faol testlarni o'qiymiz
  const session = await sessionService.getActiveTest(chatId);
  
  if (session) {
    if (ctx.chat.type !== 'private' && userId !== session.initiatorId) {
      return ctx.reply('⚠️ Faqat testni boshlagan kishi to\'xtata oladi!');
    }

    // YANGILANISH: Testni yakunlash o'rniga, "Javonga saqlash (Pauza)" logic'ni chaqiramiz
    const { cbStopTest, finishTest } = require('./quizGame');
    if (cbStopTest) {
      return cbStopTest(ctx);
    } else {
      await ctx.reply('🛑 <b>Test to\'xtatildi!</b>', { parse_mode: 'HTML' });
      return finishTest(chatId, ctx.telegram);
    }
  }

  await ctx.reply('ℹ️ Hozir faol test yo\'q.\n\nAsosiy menyuga qaytish uchun tugmani bosing:', backToMainKb());
}

async function cmdMenu(ctx) {
  clearState(ctx);
  await ctx.reply('🏛 *Asosiy Menyu*', { parse_mode: 'Markdown', ...getMainKeyboard() });
}

async function cmdBackToMainReply(ctx) {
  await ctx.reply('🔙 Asosiy menyuga qaytilmoqda...', { reply_markup: { remove_keyboard: true } });
  await cmdStart(ctx);
}

function register(bot) {
  bot.start(cmdStart);
  bot.command('stop', cmdStop);
  bot.command('menu', cmdMenu);
  bot.hears('🔙 Asosiy menyu', cmdBackToMainReply);
  bot.action('back_to_main', cbBackToMain);
  bot.action('ignore', ctx => ctx.answerCbQuery()).catch(() => {});
}

module.exports = { register };