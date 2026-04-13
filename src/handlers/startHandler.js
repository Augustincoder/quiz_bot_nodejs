'use strict';

const dbService = require('../services/dbService');
const { getMainKeyboard } = require('../keyboards/keyboards');
const {
  activeTests, waitingRooms, pollChatMap,
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
  if (waitingRooms.has(chatId)) { waitingRooms.delete(chatId); cleared = true; }
  if (activeTests.has(chatId)) {
    const sess = activeTests.get(chatId);
    if (sess.timerTask) clearTimeout(sess.timerTask);
    if (sess.pollId) pollChatMap.delete(sess.pollId);
    activeTests.delete(chatId);
    cleared = true;
  }
  if (cleared) await ctx.reply('🔄 Tugallanmagan test tozalandi. Yangi boshlashingiz mumkin!');

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

  const firstName = ctx.from.first_name || 'Talaba';
  await ctx.reply(
    `👋 Assalomu alaykum, <b>${firstName}</b>!\n\n🏛 <b>Talabalar Imtihon Trenajyori</b>ga xush kelibsiz!\n\n⬇️ Kerakli bo'limni tanlang:`,
    { parse_mode: 'HTML', ...getMainKeyboard() }
  );
}

async function cbBackToMain(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  await safeEdit(ctx, '🏛 <b>Talabalar Imtihon Trenajyori</b>\n\nKerakli bo\'limni tanlang:', { parse_mode: 'HTML', ...getMainKeyboard() });
}

async function cmdStop(ctx) {
  clearState(ctx);
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (waitingRooms.has(chatId)) {
    const room = waitingRooms.get(chatId);
    if (userId === room.initiatorId || ctx.chat.type === 'private') {
      waitingRooms.delete(chatId);
      return ctx.reply('🛑 Test bekor qilindi.', backToMainKb());
    }
    return ctx.reply('⚠️ Faqat testni boshlagan kishi bekor qila oladi!');
  }

  if (activeTests.has(chatId)) {
    const session = activeTests.get(chatId);
    if (ctx.chat.type !== 'private' && userId !== session.initiatorId) {
      return ctx.reply('⚠️ Faqat testni boshlagan kishi to\'xtatа oladi!');
    }
    await ctx.reply('🛑 <b>Test to\'xtatildi!</b>\nNatijalar hisoblanmoqda...', { parse_mode: 'HTML' });
    const { finishTest } = require('./quizGame');
    return finishTest(chatId, ctx.telegram);
  }

  await ctx.reply('ℹ️ Hozir faol test yo\'q.\n\nAsosiy menyuga qaytish uchun tugmani bosing:', backToMainKb());
}

async function cmdMenu(ctx) {
  clearState(ctx);
  await ctx.reply('🏛 <b>Asosiy Menyu</b>', { parse_mode: 'HTML', ...getMainKeyboard() });
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
  bot.action('ignore', ctx => ctx.answerCbQuery());
}

module.exports = { register };