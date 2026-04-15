'use strict';

const dbService = require('../services/dbService');
const { getMainKeyboard } = require('../keyboards/keyboards');
const sessionService = require('../services/sessionService');
const logger = require('../core/logger');
const {
  userNameCache, clearState, safeEdit, safeAnswerCb, backToMainKb,
} = require('../core/utils');

async function cmdStart(ctx) {
  clearState(ctx);
  const chatId = ctx.chat.id;

  const fullName = ctx.from.first_name ? `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}` : 'Foydalanuvchi';

  await dbService.registerUser(ctx.from.id, fullName, ctx.from.username);
  userNameCache.set(ctx.from.id, fullName);

  // Telemetry
  logger.info('user:start', { userId: ctx.from.id, name: fullName });

  let cleared = false;
  const room = await sessionService.getWaitingRoom(chatId);
  if (room) {
    await sessionService.deleteWaitingRoom(chatId);
    cleared = true;
  }
  const session = await sessionService.getActiveTest(chatId);
  if (session) {
    if (session.pollId) await sessionService.deletePollChat(session.pollId);
    await sessionService.deleteActiveTest(chatId);
    cleared = true;
  }
  if (cleared) await ctx.reply('🔄 Oldingi tugallanmagan sessiya tozalandi. Yangi testga tayyorsiz!');

  // LINK ORQALI KIRGANDA (Deep Linking)
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

  // --- UX/UI Onboarding ---
  const firstName = ctx.from.first_name || 'Talaba';
  const welcomeText = `👋 Assalomu alaykum, <b>${firstName}</b>!

🎓 <b>Talabalar Imtihon Simulyatori</b>ga xush kelibsiz — imtihonga tayyorgarlikda sizning shaxsiy AI yordamchingiz.

━━━━━━━━━━━━━━━━
✨ <b>Sizning 4 ta superkuchingiz:</b>

📚 <b>Rasmiy Testlar</b> — Tasdiqlanagan test bazasidan yechib, bilimingizni sinab ko'ring
🤖 <b>AI Smart Quiz</b> — Darslik rasmi yoki matnini yuboring, AI bir zumda test tuzib beradi
📥 <b>Javon</b> — Testni to'xtatib, istalgan paytda qolgan joyidan davom eting
🧠 <b>AI Tutor</b> — Xatolaringizni batafsil tahlil qilib, har bir xatoni tushuntirib beradi

━━━━━━━━━━━━━━━━
📊 Har bir test natijalari reytingga qo'shiladi — eng yaxshilar o'nligiga kiring!

👇 <b>Quyidagi menyudan boshlang:</b>`;

  await ctx.reply(welcomeText, { parse_mode: 'HTML', ...getMainKeyboard() });
}

async function cbBackToMain(ctx) {
  clearState(ctx);
  await safeAnswerCb(ctx);
  const firstName = ctx.from.first_name || 'Talaba';
  const welcomeText = `🏛 <b>Asosiy Menyu</b>\n\nNimadan boshlaymiz, ${firstName}?`;
  await safeEdit(ctx, welcomeText, { parse_mode: 'HTML', ...getMainKeyboard() });
}

async function cmdStop(ctx) {
  clearState(ctx);
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  const sessionServiceLocal = require('../services/sessionService');
  const room = await sessionServiceLocal.getWaitingRoom(chatId);

  if (room) {
    if (userId === room.initiatorId || ctx.chat.type === 'private') {
      await sessionServiceLocal.deleteWaitingRoom(chatId);
      return ctx.reply('🛑 Test bekor qilindi. Asosiy menyudan yangisini boshlashingiz mumkin.', backToMainKb());
    }
    return ctx.reply('⚠️ Faqat testni boshlagan foydalanuvchi bekor qila oladi.');
  }

  const session = await sessionServiceLocal.getActiveTest(chatId);

  if (session) {
    if (ctx.chat.type !== 'private' && userId !== session.initiatorId) {
      return ctx.reply('⚠️ Faqat testni boshlagan foydalanuvchi to\'xtata oladi.');
    }

    const { cbStopTest, finishTest } = require('./quizGame');
    if (cbStopTest) {
      return cbStopTest(ctx);
    } else {
      await ctx.reply('🛑 <b>Test to\'xtatildi.</b> Natijalar hisoblanmoqda...', { parse_mode: 'HTML' });
      return finishTest(chatId, ctx.telegram);
    }
  }

  await ctx.reply('ℹ️ Hozirda faol test mavjud emas.\n\n👇 Asosiy menyuga qaytib yangi test boshlashingiz mumkin:', backToMainKb());
}

async function cmdMenu(ctx) {
  clearState(ctx);
  await ctx.reply('🏛 <b>Asosiy Menyu</b>\n\nQuyidagi bo\'limlardan birini tanlang:', { parse_mode: 'HTML', ...getMainKeyboard() });
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
  bot.action('ignore', ctx => safeAnswerCb(ctx));
}

module.exports = { register };