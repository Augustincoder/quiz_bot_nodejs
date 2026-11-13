'use strict';

const dbService = require('../services/dbService');
const { resolveShareParam } = require('../services/shareService');
const { getMainKeyboard } = require('../keyboards/keyboards');
const sessionService = require('../services/sessionService');
const {
  userNameCache, resetUserFlows, safeEdit, safeAnswerCb, backToMainKb, escapeHtml,
} = require('../core/utils');

async function cmdStart(ctx) {
  await resetUserFlows(ctx.from?.id, ctx);
  const chatId = ctx.chat.id;

  // ─── GURUHLAR UCHUN TOZA INTERFEYS VA KUTISH ZALI ────────────
  if (ctx.chat.type !== 'private') {
    const botInfo = await ctx.telegram.getMe();
    const args = (ctx.message.text || '').trim().split(/\s+/);

    // Agar deeplink orqali guruhga qo'shilsa (startgroup=t_...)
    if (args.length > 1) {
      // Ba'zan argument t_123@bot_nomi bo'lib kelishi mumkin, tozalab olamiz:
      const param = args[1].split('@')[0];
      const { createLobby } = require('./groupQuizLogic');
      return createLobby(ctx, param);
    }

    // Oddiy /start bosilsa
    return ctx.reply(
      "👋 <b>Salom, guruh a'zolari!</b>\n\nMen orqali guruhda do'stlar bilan qiziqarli test musobaqalarini o'tkazishingiz mumkin.\n\n👇 Test yaratish yoki profilni ko'rish uchun botning o'ziga o'ting:",
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: "🤖 Shaxsiy chatga o'tish", url: `https://t.me/${botInfo.username}` }]]
        }
      }
    );
  }
  // ──────────────────────────────────────────────────────────

  const fullName = ctx.from.first_name ? `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}` : 'Foydalanuvchi';

  await dbService.registerUser(ctx.from.id, fullName, ctx.from.username);
  userNameCache.set(ctx.from.id, fullName);

  const logger = require('../core/logger');
  logger.info('user:start', { userId: ctx.from.id, name: fullName });

  let cleared = false;
  let savedToShelf = false;
  const room = await sessionService.getWaitingRoom(chatId);
  if (room) {
    await sessionService.deleteWaitingRoom(chatId);
    cleared = true;
  }
  const session = await sessionService.getActiveTest(chatId);
  if (session) {
    if (session.msgId) {
      await ctx.telegram.stopPoll(chatId, session.msgId).catch(() => {});
    }
    if (session.pollId) {
      await sessionService.deletePollChat(session.pollId).catch(() => {});
    }
    try {
      const { cancelSessionTimer } = require('./coreQuiz');
      await cancelSessionTimer(session, chatId);
      const { quizTimerQueue } = require('../jobs/queues');
      await quizTimerQueue.getJob(`timeout:${chatId}:${session?.qIdx}`).then(j => j && j.remove()).catch(() => {});
    } catch {}
    
    // Testni o'chirish o'rniga javonga saqlaymiz (faqat boshlangan va preparing bo'lmagan testlar)
    if (
      session.status !== 'preparing' &&
      (session.qIdx > 0 || (session.correct || 0) > 0 || (session.wrong || 0) > 0) &&
      session.sessionQuestions &&
      session.sessionQuestions.length > 0 &&
      session.qIdx < session.sessionQuestions.length
    ) {
      let folderName = session.subjectKey || "Boshqalar";
      if (folderName.length > 20) folderName = folderName.slice(0, 20);
      let shelfTestId = session.testId || Date.now();
      if (shelfTestId === "mock" || shelfTestId === "adaptive" || shelfTestId === "retry") {
        shelfTestId = `${shelfTestId}_${Date.now()}`;
      }
      await dbService.saveTestToShelf(ctx.from.id, folderName, {
        testId: shelfTestId,
        testName: session.blockName || session.testData?.block_name || "Tugallanmagan test",
        subject: session.subjectKey || "Noma'lum",
        subjectId: session.subjectId || null,
        creatorId: session.creatorId || null,
        isUgc: Boolean(session.isUgc),
        questions: session.sessionQuestions,
        progress: {
          current_index: session.qIdx || 0,
          correct: session.correct || 0,
          mistakes: session.mistakes || [],
        },
      });
      savedToShelf = true;
    }
    
    await sessionService.deleteActiveTest(chatId);
    cleared = true;
  }
  
  if (savedToShelf) {
    await ctx.reply('📥 Sizda avvalgi tugallanmagan test bor edi. U xavfsizlik uchun "Javon"ingizga saqlab qo\'yildi! Istalgan vaqt davom ettirishingiz mumkin.');
  } else if (cleared) {
    await ctx.reply('🔄 Oldingi tugallanmagan sessiya tozalandi. Yangi testga tayyorsiz!');
  }

  // LINK ORQALI KIRGANDA (Deep Linking - Shaxsiy chat uchun)
  const args = (ctx.message.text || '').trim().split(/\s+/);
  if (args.length > 1) {
    if (dbService.isRecentDbError()) {
      return ctx.reply(
        "⚠️ <b>Ma'lumotlar bazasida vaqtinchalik uzilish yuz berdi.</b>\n\nIltimos, 1-2 daqiqadan so'ng qayta urinib ko'ring.",
        { parse_mode: 'HTML', ...backToMainKb() }
      );
    }

    const param = args[1];
    const resolved = resolveShareParam(param);
    const universalTestHub = require('./universalTestHub');

    if (resolved.type === 's') {
      if (resolved.isInvalid || !resolved.id) {
        return ctx.reply("❌ Fan topilmadi yoki havola yaroqsiz.", backToMainKb());
      }

      ctx.sendChatAction('typing').catch(() => {});
      const loadingMsg = await ctx.reply(
        '⏳ <b>Fan ma\'lumotlari yuklanmoqda...</b>\n<i>Iltimos, kuting...</i>',
        { parse_mode: 'HTML' }
      ).catch(() => null);

      return universalTestHub.showSubjectHub(ctx, resolved.id, {
        isOfficial: false,
        loadingMsgId: loadingMsg?.message_id,
      });
    }
    if (resolved.type === 't') {
      if (resolved.isInvalid || !resolved.id) {
        return ctx.reply("❌ Bu blok topilmadi yoki havola yaroqsiz.", backToMainKb());
      }
      return universalTestHub.showBlockHub(ctx, resolved.id, { isOfficial: false });
    }
    if (param.startsWith('offt_')) {
      return universalTestHub.showBlockHub(ctx, param, { isOfficial: true });
    }
    if (param.startsWith('offs_')) {
      return universalTestHub.showSubjectHub(ctx, param.replace('offs_', ''), { isOfficial: true });
    }
  }

  // --- UX/UI Onboarding ---
  const rawFirstName = ctx.from.first_name || 'Talaba';
  const firstName = escapeHtml(rawFirstName);
  const userClass = await dbService.getUserClass(ctx.from.id);
  const classNotice = userClass
    ? `🎓 Guruhingiz: <b>${escapeHtml(userClass)}</b>\n`
    : `💡 <i>Tavsiya: Dars jadvalingizni avtomatik olish uchun guruhingizni bir marta sozlab oling (/setclass)</i>\n`;

  const welcomeText = `👋 Assalomu alaykum, <b>${firstName}</b>!

🎓 <b>Talabalar Imtihon Simulyatori</b>ga xush kelibsiz — imtihonga tayyorgarlikda sizning shaxsiy AI yordamchingiz.

${classNotice}━━━━━━━━━━━━━━━━
✨ <b>Sizning 4 ta superkuchingiz:</b>

📚 <b>Rasmiy Testlar</b> — Tasdiqlangan test bazasidan yechib, bilimingizni sinab ko'ring
🤖 <b>AI Smart Quiz</b> — Darslik rasmi yoki matnini yuboring, AI bir zumda test tuzib beradi
📥 <b>Javon</b> — Testni to'xtatib, istalgan paytda qolgan joyidan davom eting
🧠 <b>AI Tutor</b> — Xatolaringizni batafsil tahlil qilib, har bir xatoni tushuntirib beradi

━━━━━━━━━━━━━━━━
📊 Har bir test natijalari reytingga qo'shiladi — eng yaxshilar o'nligiga kiring!

👇 <b>Quyidagi menyudan boshlang:</b>`;

  await ctx.reply(welcomeText, { parse_mode: 'HTML', ...getMainKeyboard() });
}

async function cbBackToMain(ctx) {
  await resetUserFlows(ctx.from?.id, ctx);
  await safeAnswerCb(ctx);
  const firstName = escapeHtml(ctx.from.first_name || 'Talaba');
  const welcomeText = `🏛 <b>Asosiy Menyu</b>\n\nNimadan boshlaymiz, ${firstName}?`;
  await safeEdit(ctx, welcomeText, { parse_mode: 'HTML', ...getMainKeyboard() });
}

const { canManageLobbyOrGame } = require('./groupQuizLogic');

async function cmdStop(ctx) {
  await resetUserFlows(ctx.from?.id, ctx);
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const isGroup = ctx.chat.type !== 'private';

  const sessionServiceLocal = require('../services/sessionService');
  const room = await sessionServiceLocal.getWaitingRoom(chatId);

  if (room) {
    const canManage = await canManageLobbyOrGame(ctx, chatId, userId, room.initiatorId);
    if (canManage || !isGroup) {
      await sessionServiceLocal.deleteWaitingRoom(chatId);
      return ctx.reply('🛑 Test bekor qilindi.', isGroup ? undefined : backToMainKb());
    }
    return ctx.reply('⚠️ Faqat testni boshlagan foydalanuvchi yoki guruh admini bekor qila oladi.');
  }

  const session = await sessionServiceLocal.getActiveTest(chatId);

  if (session) {
    if (isGroup) {
      const canManage = await canManageLobbyOrGame(ctx, chatId, userId, session.initiatorId);
      if (!canManage) {
        return ctx.reply('⚠️ Faqat testni boshlagan foydalanuvchi yoki guruh admini to\'xtata oladi.');
      }

      session.forceStopped = true;
      await sessionServiceLocal.setActiveTest(chatId, session);

      await ctx.reply('🛑 <b>Test majburiy to\'xtatildi!</b> Yakuniy reyting hisoblanmoqda...', { parse_mode: 'HTML' });
      const { finishTest } = require('./quizGame');
      return finishTest(chatId, ctx.telegram);
    }

    const { cbStopTest } = require('./quizGame');
    return cbStopTest(ctx);
  }

  await ctx.reply('ℹ️ Hozirda faol test mavjud emas.', isGroup ? undefined : backToMainKb());
}

async function cmdMenu(ctx) {
  await resetUserFlows(ctx.from?.id, ctx);
  await ctx.reply('🏛 <b>Asosiy Menyu</b>\n\nQuyidagi bo\'limlardan birini tanlang:', { parse_mode: 'HTML', ...getMainKeyboard() });
}

async function cmdBackToMainReply(ctx) {
  await ctx.reply('🔙 Asosiy menyuga qaytilmoqda...', { reply_markup: { remove_keyboard: true } });
  await cmdStart(ctx);
}

function register(bot) {
  bot.start(cmdStart);
  bot.command(['stop', 'cancel'], cmdStop);
  bot.command('menu', cmdMenu);
  bot.hears('🔙 Asosiy menyu', cmdBackToMainReply);
  bot.action('back_to_main', cbBackToMain);
  bot.action('ignore', ctx => safeAnswerCb(ctx));
}

module.exports = { register, cmdStart, cbStart: cmdStart };