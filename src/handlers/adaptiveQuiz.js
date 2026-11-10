'use strict';

const { Markup }        = require('telegraf');
const mutex             = require('../core/mutex');
const { SUBJECTS }      = require('../config/config');
const dbService         = require('../services/dbService');
const aiService         = require('../services/aiService');
const sessionService    = require('../services/sessionService');
const { safeEdit, parseSuffix } = require('../core/utils');
const { shuffleArray }   = require('../core/questionUtils');

async function cbAdaptiveTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const rawKey     = parseSuffix(ctx.callbackQuery.data, 'adaptive_');
  let subjectKey   = rawKey;
  let subjName     = SUBJECTS[subjectKey] || subjectKey;
  let backTarget   = `subj_${subjectKey}`;

  const numericId = parseInt(String(subjectKey).replace(/^ugc_/, ''), 10);
  if (!SUBJECTS[subjectKey] && !isNaN(numericId) && numericId > 0) {
    backTarget = `hub_subj_ugc_${numericId}`;
    try {
      const subj = await dbService.getSubjectById(numericId);
      if (subj?.name) subjName = subj.name;
    } catch {}
  }

  try {
    const stats    = await dbService.getUserStats(ctx.from.id);
    const mistakes = (stats.history || [])
      .filter(r => (r.subject === subjectKey || r.subjectKey === subjectKey || r.subject === subjName) && r.mistakes?.length)
      .flatMap(r => r.mistakes);

    if (!mistakes.length) {
      return safeEdit(ctx,
        `🎯 <b>AI Adaptiv Diagnostika — ${subjName}</b>\n\n` +
        `Ushbu fandan hali xatolaringiz qayd etilmagan.\n` +
        `AI siz uchun fanning barcha bloklaridan bilim darajangizni aniqlovchi <b>Diagnostik Adaptiv Test</b> tuzib beradi!\n\n` +
        `<b>Nechta savol ishlashni tanlang:</b>`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('10 ta', `adp_run_${subjectKey}_10`), Markup.button.callback('15 ta', `adp_run_${subjectKey}_15`)],
            [Markup.button.callback('🔙 Fanga qaytish', backTarget)],
          ]),
        },
      );
    }

    const topicCount = Math.max(1, Math.floor(mistakes.length / 2));
    await safeEdit(ctx,
      `🎯 <b>AI Adaptiv Test</b>\n\n` +
      `AI sizning <b>avvalgi xatolaringiz</b> asosida maxsus test yaratadi — zaif joylaringizni mustahkamlash uchun eng samarali usul!\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📊 <b>${subjName} bo'yicha tahlil:</b>\n` +
      `❌ Jamg'arilgan xatolar: <b>${mistakes.length} ta</b>\n` +
      `📌 Taxminiy zaif mavzular: <b>${topicCount} ta</b>\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `<b>Nechta savol ishlashni tanlang:</b>\n` +
      `<i>💡 10–15 ta — diqqat va samaradorlik uchun eng maqbul.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('5 ta',  `adp_run_${subjectKey}_5`),  Markup.button.callback('10 ta', `adp_run_${subjectKey}_10`)],
          [Markup.button.callback('15 ta', `adp_run_${subjectKey}_15`), Markup.button.callback('20 ta', `adp_run_${subjectKey}_20`)],
          [Markup.button.callback('🔙 Fanga qaytish', backTarget)],
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
  const rawSubject = parts.join('_');
  let subjectKey   = rawSubject;
  let subjName     = SUBJECTS[subjectKey] || subjectKey;
  let backTarget   = `subj_${subjectKey}`;
  const numericId  = parseInt(String(subjectKey).replace(/^ugc_/, ''), 10);
  if (!SUBJECTS[subjectKey] && !isNaN(numericId) && numericId > 0) {
    backTarget = `hub_subj_ugc_${numericId}`;
    try {
      const subj = await dbService.getSubjectById(numericId);
      if (subj?.name) subjName = subj.name;
    } catch {}
  }
  const chatId     = ctx.chat.id;

  const unlock = await mutex.lock(`start_test:${chatId}`);
  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing) {
      if (existing.status === 'preparing') {
        await sessionService.deleteActiveTest(chatId);
      } else {
        const kb = existing.status === 'paused'
          ? Markup.inlineKeyboard([
              [Markup.button.callback("▶️ Davom etish", "resume_test")],
              [Markup.button.callback("🛑 Faol testni to'xtatish", "force_finish")],
            ])
          : Markup.inlineKeyboard([
              [Markup.button.callback("🛑 Faol testni to'xtatish", "force_finish")],
            ]);
        return ctx.reply(
          "⚠️ <b>Sizda tugallanmagan test bor.</b>\n\nYangi adaptiv test boshlashdan oldin uni davom ettirishingiz yoki to'xtatishingiz kerak:",
          {
            parse_mode: "HTML",
            ...kb,
          }
        );
      }
    }

    const stats    = await dbService.getUserStats(ctx.from.id);
    const mistakes = (stats.history || [])
      .filter(r => (r.subject === subjectKey || r.subjectKey === subjectKey || r.subject === subjName) && r.mistakes?.length)
      .flatMap(r => r.mistakes);

    let validQuestions = [];

    if (mistakes.length > 0) {
      const msg = await ctx.reply(
        `⏳ <i>AI "${subjName}" fanidan sizning zaif joylaringiz asosida ${count} ta maxsus savol tuzmoqda...</i> 🧠`,
        { parse_mode: 'HTML' },
      );

      const shuffled  = shuffleArray(mistakes);
      try {
        const questions = await aiService.generateAdaptiveQuiz(subjName, shuffled, count);
        validQuestions = (questions || []).filter(q =>
          q && q.question && Array.isArray(q.options) && q.options.length >= 2
        );
      } catch (aiErr) {
        console.warn('AI generation error, using raw mistakes:', aiErr.message);
      }

      if (!validQuestions.length) {
        validQuestions = shuffled.slice(0, count);
      }

      await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    } else {
      // Diagnostic test from available subject questions
      let subjectPool = [];
      const memDb = require('../core/bot').memoryDb || {};
      if (memDb[subjectKey]) {
        subjectPool = Object.values(memDb[subjectKey] || {}).flatMap(t => t.questions || []);
      } else if (!isNaN(numericId) && numericId > 0) {
        const blocks = await dbService.getSubjectBlocks(numericId);
        subjectPool = (blocks || []).flatMap(b => b.questions || []);
      }

      if (subjectPool.length > 0) {
        const shuffled = shuffleArray([...subjectPool]);
        validQuestions = shuffled.slice(0, count);
      }
    }

    if (!validQuestions.length) {
      return ctx.reply("❌ Ushbu fandan test savollari topilmadi!", {
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🔙 Fanga qaytish", backTarget)],
        ]),
      });
    }

    const { initAndStartTest } = require('./quizGame');
    await initAndStartTest(chatId, ctx.telegram, subjName, 'adaptive', { questions: validQuestions, block_name: `🎯 AI Adaptiv Test (${validQuestions.length} ta)` }, ctx.from.id, 'private');
  } catch (e) {
    console.error('cbAdaptiveRun error:', e.message);
  } finally {
    unlock();
  }
}

module.exports = { cbAdaptiveTest, cbAdaptiveRun };