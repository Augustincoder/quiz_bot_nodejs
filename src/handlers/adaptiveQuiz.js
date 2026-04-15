'use strict';

const { Markup }        = require('telegraf');
const { SUBJECTS }      = require('../config/config');
const dbService         = require('../services/dbService');
const aiService         = require('../services/aiService');
const sessionService    = require('../services/sessionService');
const { safeEdit, parseSuffix } = require('../core/utils');
const { initAndStartTest }      = require('./groupQuizLogic');

async function cbAdaptiveTest(ctx) {
 await ctx.answerCbQuery().catch(() => {});
  const subjectKey = parseSuffix(ctx.callbackQuery.data, 'adaptive_');
  const subjName   = SUBJECTS[subjectKey] || subjectKey;

  try {
    const stats    = await dbService.getUserStats(ctx.from.id);
    const mistakes = (stats.history || [])
      .filter(r => (r.subject === subjectKey || r.subjectKey === subjectKey) && r.mistakes?.length)
      .flatMap(r => r.mistakes);

    if (!mistakes.length) {
      return safeEdit(ctx,
        `🎉 <b>Zo'r natija!</b>\n\n` +
        `<b>${subjName}</b> bo'yicha hech qanday xatoyingiz topilmadi.\n\n` +
        `<b>Nima qilish mumkin?</b>\n` +
        `✅ Rasmiy test bloklarini ishlang\n` +
        `✅ Aralash (Mock Exam) yechib ko'ring\n` +
        `✅ Xatolar to'plangach, bu sahifaga qaytib keling`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Fanga qaytish', `subj_${subjectKey}`)]]) },
      );
    }

    const topicCount = Math.max(1, Math.floor(mistakes.length / 2));
    await safeEdit(ctx,
      `🎯 <b>Moslashuvchi (Adaptiv) Test</b>\n\n` +
      `Avvalgi xatolaringiz asosida maxsus savollar yaratiladi.\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📊 <b>${subjName} bo'yicha holatingiz:</b>\n` +
      `❌ Topilgan xatolar: <b>${mistakes.length} ta</b>\n` +
      `📌 Taxminiy mavzular: <b>${topicCount} ta</b>\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `<b>Nechta savol ishlaylik?</b>\n` +
      `<i>💡 10–15 ta — diqqatni jamlash uchun optimal.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('5 ta',  `adp_run_${subjectKey}_5`),  Markup.button.callback('10 ta', `adp_run_${subjectKey}_10`)],
          [Markup.button.callback('15 ta', `adp_run_${subjectKey}_15`), Markup.button.callback('20 ta', `adp_run_${subjectKey}_20`)],
          [Markup.button.callback('🔙 Fanga qaytish', `subj_${subjectKey}`)],
        ]),
      },
    );
  } catch (e) {
    console.error('cbAdaptiveTest error:', e.message);
  }
}

async function cbAdaptiveRun(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const suffix     = parseSuffix(ctx.callbackQuery.data, 'adp_run_');
  const parts      = suffix.split('_');
  const count      = parts.pop();
  const subjectKey = parts.join('_');
  const subjName   = SUBJECTS[subjectKey] || subjectKey;
  const chatId     = ctx.chat.id;

  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing) return ctx.answerCbQuery("⚠️ Avvalgi testni to'xtating: /stop", { show_alert: true }).catch(() => {});

    const stats    = await dbService.getUserStats(ctx.from.id);
    const mistakes = (stats.history || [])
      .filter(r => (r.subject === subjectKey || r.subjectKey === subjectKey) && r.mistakes?.length)
      .flatMap(r => r.mistakes);

    if (!mistakes.length) return ctx.answerCbQuery("🎉 Bu fandan xatolar yo'q!", { show_alert: true }).catch(() => {});

    const msg = await ctx.reply(
      `⏳ <i>AI "${subjName}" fanidan ${count} ta maxsus savol tuzmoqda...</i>`,
      { parse_mode: 'HTML' },
    );

    const shuffled  = mistakes.sort(() => 0.5 - Math.random());
    const questions = await aiService.generateAdaptiveQuiz(subjName, shuffled, count);

    if (!questions?.length) {
      await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, '❌ AI test tuzishda xatolik yuz berdi.').catch(() => {});
      return;
    }

    await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    await initAndStartTest(chatId, ctx.telegram, subjectKey, 'adaptive', { questions, block_name: '🎯 Shaxsiy Adaptiv Test' }, ctx.from.id, 'private');
  } catch (e) {
    console.error('cbAdaptiveRun error:', e.message);
  }
}

module.exports = { cbAdaptiveTest, cbAdaptiveRun };