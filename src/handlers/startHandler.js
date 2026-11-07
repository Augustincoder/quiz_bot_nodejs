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
    const param = args[1];
    const resolved = resolveShareParam(param);

    if (resolved.type === 's') {
      if (resolved.isInvalid || !resolved.id) {
        return ctx.reply("❌ Fan topilmadi yoki havola yaroqsiz.", backToMainKb());
      }

      ctx.sendChatAction('typing').catch(() => {});
      const loadingMsg = await ctx.reply(
        '⏳ <b>Fan bloklari yuklanmoqda...</b>\n<i>Iltimos, kuting...</i>',
        { parse_mode: 'HTML' }
      ).catch(() => null);

      const rawId = resolved.id;
      const { showUgcSubjectBlocks } = require('./quizGame');

      // 1. Avval rawId ni subject_id deb tekshiramiz
      const subject = await dbService.getSubjectById(rawId);
      if (subject) {
        return showUgcSubjectBlocks(ctx, subject.id, subject.name, loadingMsg?.message_id);
      }

      // 2. Agar subject topilmasa, eski havola bo'lishi mumkin (rawId = test_id)
      const testData = await dbService.getUserTest(rawId);
      if (testData) {
        if (testData.subject_id) {
          const s = await dbService.getSubjectById(testData.subject_id);
          return showUgcSubjectBlocks(ctx, testData.subject_id, s?.name || testData.subject, loadingMsg?.message_id);
        }
        return showUgcSubjectBlocks(ctx, testData.creator_id, testData.subject, loadingMsg?.message_id);
      }

      const isDbDown = dbService.isRecentDbError();
      const notFoundText = isDbDown
        ? '⚠️ <b>Ma\'lumotlar bazasida vaqtinchalik uzilish yuz berdi.</b>\n\nIltimos, 1-2 daqiqadan so\'ng qayta urinib ko\'ring.'
        : '❌ Bu fan topilmadi yoki o\'chirilgan.';
      const notFoundOpts = { parse_mode: 'HTML', ...backToMainKb() };
      if (loadingMsg) {
        return ctx.telegram.editMessageText(
          chatId,
          loadingMsg.message_id,
          undefined,
          notFoundText,
          notFoundOpts
        ).catch(() => ctx.reply(notFoundText, notFoundOpts));
      }
      return ctx.reply(notFoundText, notFoundOpts);
    }
    if (resolved.type === 't') {
      if (resolved.isInvalid || !resolved.id) {
        return ctx.reply("❌ Bu blok topilmadi yoki havola yaroqsiz.", backToMainKb());
      }
      const testData = await dbService.getUserTest(resolved.id);
      if (testData) {
        const { startUgcTest } = require('./quizGame');
        return startUgcTest(ctx, testData);
      }
      const isDbDown = dbService.isRecentDbError();
      const testErrText = isDbDown
        ? '⚠️ <b>Ma\'lumotlar bazasida vaqtinchalik uzilish yuz berdi.</b>\n\nIltimos, 1-2 daqiqadan so\'ng qayta urinib ko\'ring.'
        : '❌ Bu blok topilmadi yoki o\'chirilgan.';
      return ctx.reply(testErrText, { parse_mode: 'HTML', ...backToMainKb() });
    }
    if (param.startsWith('offt_')) {
      const parts = param.split('_');
      const testId = parseInt(parts.pop(), 10);
      const subject = parts.slice(1).join('_');
      const memDb = require('../core/bot').memoryDb || {};
      const testData = (memDb[subject] || {})[testId];
      if (testData) {
        const { initAndStartTest } = require('./quizGame');
        return initAndStartTest(chatId, ctx.telegram, subject, testId, testData, ctx.from.id, 'private');
      }
      return ctx.reply("❌ Rasmiy test topilmadi yoki o'chirilgan.", backToMainKb());
    }
    if (param.startsWith('offs_')) {
      const subject = param.replace('offs_', '');
      const memDb = require('../core/bot').memoryDb || {};
      if (memDb[subject]) {
        const { cbSubject } = require('./quizGame');
        ctx.callbackQuery = { data: `subj_${subject}` };
        return cbSubject(ctx);
      }
      return ctx.reply("❌ Bu fanda rasmiy testlar topilmadi.", backToMainKb());
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

async function canManageLobbyOrGame(ctx, chatId, userId, initiatorId) {
  if (userId === initiatorId) return true;
  const config = require('../config/config');
  if (config.ADMIN_IDS && config.ADMIN_IDS.map(Number).includes(Number(userId))) return true;
  if (ctx.chat?.type !== 'private') {
    try {
      const member = await ctx.telegram.getChatMember(chatId, userId);
      if (member && (member.status === 'creator' || member.status === 'administrator')) {
        return true;
      }
    } catch {}
  }
  return false;
}

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