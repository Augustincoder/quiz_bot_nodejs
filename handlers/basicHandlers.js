'use strict';

const { Markup }       = require('telegraf');
const statsManager     = require('../statsManager');
const { getMainKeyboard } = require('../keyboards');
const {
  activeTests, waitingRooms, pollChatMap,
  userNameCache, States, clearState,
  safeEdit, backToMainKb,
} = require('../utils');

async function cmdStart(ctx) {
  clearState(ctx);
  const chatId = ctx.chat.id;

  await statsManager.registerUser(
    ctx.from.id,
    ctx.from.first_name
      ? `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}`
      : 'Foydalanuvchi',
    ctx.from.username,
  );
  userNameCache.set(
    ctx.from.id,
    ctx.from.first_name
      ? `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}`
      : 'Foydalanuvchi',
  );

  // Eski testlarni tozalash
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

  // Deep-link
  const args = (ctx.message.text || '').split(' ');
  if (args.length > 1) {
    const param = args[1];
    if (param.startsWith('s_')) {
      const refId = param.slice(2);
      const testData = await statsManager.getUserTest(refId);
      if (!testData) {
        return ctx.reply(
          '❌ Bu fan topilmadi yoki egasi tomonidan o\'chirilgan.\n\nAsosiy menyuga qaytish uchun /start bosing.',
          backToMainKb(),
        );
      }
      // show_ugc_subject_blocks
      const { showUgcSubjectBlocks } = require('./quizGame');
      return showUgcSubjectBlocks(ctx, testData.creator_id, testData.subject);
    }
    if (param.startsWith('t_')) {
      const testData = await statsManager.getUserTest(param.slice(2));
      if (testData) {
        const { startUgcTest } = require('./quizGame');
        return startUgcTest(ctx, testData);
      }
      return ctx.reply(
        '❌ Bu blok topilmadi yoki egasi tomonidan o\'chirilgan.\n\nAsosiy menyuga qaytish uchun /start bosing.',
        backToMainKb(),
      );
    }
  }

  const firstName = ctx.from.first_name || 'Talaba';
  await ctx.reply(
    `👋 Assalomu alaykum, *${firstName}*!\n\n` +
    `🏛 *Talabalar Imtihon Trenajyori*ga xush kelibsiz!\n\n` +
    `📌 Nima qilishingiz mumkin:\n` +
    `• 📚 Rasmiy testlar — Admin tomonidan tayyorlangan bloklar\n` +
    `• 📝 Test yaratish — O'z testingizni tuzing va ulashing\n` +
    `• 📊 Statistika — Natijalaringizni kuzating\n` +
    `• 🏆 Reyting — Top 10 talabalar\n\n` +
    `⬇️ Kerakli bo'limni tanlang:`,
    { parse_mode: 'Markdown', ...getMainKeyboard() },
  );
}

async function cbBackToMain(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  await safeEdit(
    ctx,
    '🏛 *Talabalar Imtihon Trenajyori*\n\nKerakli bo\'limni tanlang:',
    getMainKeyboard(),
  );
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
    await ctx.reply('🛑 *Test to\'xtatildi!*\nNatijalar hisoblanmoqda...', { parse_mode: 'Markdown' });
    const { finishTest } = require('./quizGame');
    return finishTest(chatId, ctx.telegram);
  }

  await ctx.reply(
    'ℹ️ Hozir faol test yo\'q.\n\nAsosiy menyuga qaytish uchun tugmani bosing:',
    backToMainKb(),
  );
}

async function cmdMenu(ctx) {
  clearState(ctx);
  await ctx.reply('🏛 *Asosiy Menyu*', { parse_mode: 'Markdown', ...getMainKeyboard() });
}

function register(bot) {
  bot.start(cmdStart);
  bot.command('stop', cmdStop);
  bot.command('menu', cmdMenu);
  bot.action('back_to_main', cbBackToMain);
  bot.action('ignore', ctx => ctx.answerCbQuery());
}

module.exports = { register };