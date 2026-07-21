'use strict';

const { Markup } = require('telegraf');
const { supabase } = require('../lib/supabase');
const { SUBJECTS } = require('../config/config');
const dbService = require('../services/dbService');
const aiService = require('../services/aiService');
const sessionService = require('../services/sessionService');
const { initAndStartTest } = require('./quizGame');
const { safeEdit, clearState, States } = require('../core/utils');

function buildDailyPlan(examDate, totalQuestions = 300) {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const start = new Date(todayStr);
  const end = new Date(examDate);
  const diffMs = end - start;
  let daysRemaining = Math.ceil(diffMs / 86400000);
  if (daysRemaining < 1) {
    daysRemaining = 1;
  }
  const rawPerDay = Math.ceil(totalQuestions / daysRemaining);
  const questionsPerDay = Math.min(30, rawPerDay);

  const plan = [];
  for (let i = 0; i < daysRemaining; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const dayStr = d.toISOString().split('T')[0];
    plan.push({
      day: dayStr,
      target_qty: questionsPerDay,
    });
  }
  return plan;
}

async function cbSessiyaMenu(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const userId = String(ctx.from.id);

  try {
    const { data, error } = await supabase
      .from('exam_sessions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('exam_date', { ascending: true });

    if (error) {
      console.error('cbSessiyaMenu query error:', error.message);
    }

    const sessions = data || [];

    if (sessions.length === 0) {
      const text =
        `📚 <b>Imtihon Sessiyalari (/sessiya)</b>\n\n` +
        `Hozircha sizda faol imtihon sessiyalari mavjud emas.\n` +
        `O'z imtihon sanangizni belgilang va har kuni avtomatik kunlik reja asosida mashg'ulot o'ting!`;

      const buttons = [
        [Markup.button.callback("➕ Imtihon qo'shish", "session_add")],
      ];

      return safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    }

    let text = `📚 <b>Faol Imtihon Sessiyalari (/sessiya)</b>\n\n`;
    const buttons = [];

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const start = new Date(todayStr);

    for (const session of sessions) {
      const subjName = SUBJECTS[session.subject] || session.subject;
      const end = new Date(session.exam_date);
      const diffDays = Math.ceil((end - start) / 86400000);

      let indicator = '🟢';
      if (diffDays <= 2) {
        indicator = '🔴';
      } else if (diffDays <= 5) {
        indicator = '🟡';
      }

      const readiness = session.readiness_pct || 0;
      text += `${indicator} <b>${subjName}</b> — Imtihon: ${session.exam_date} (<b>${diffDays > 0 ? diffDays : 0} kun qoldi</b>)\n`;
      text += `📊 Tayyorgarlik darajasi: <b>${readiness}%</b>\n\n`;

      buttons.push([
        Markup.button.callback(`▶️ ${subjName} (Bugungi vazifa)`, `session_run_${session.id}`),
      ]);
    }

    buttons.push([Markup.button.callback("➕ Imtihon qo'shish", "session_add")]);

    await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
  } catch (e) {
    console.error('cbSessiyaMenu xatosi:', e.message);
  }
}

async function cbSessionAdd(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const buttons = Object.entries(SUBJECTS).map(([key, name]) => [
    Markup.button.callback(name, `session_add_subj_${key}`),
  ]);
  buttons.push([Markup.button.callback("🔙 Orqaga", "sessiya_menu")]);

  await safeEdit(
    ctx,
    `➕ <b>Yangi Imtihon Sessiyasini Qo'shish</b>\n\nQaysi fan bo'yicha imtihonga tayyorgarlik ko'rasiz?`,
    Markup.inlineKeyboard(buttons)
  );
}

async function cbSessionAddSubject(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const subjectKey = ctx.match[1];
  const subjName = SUBJECTS[subjectKey] || subjectKey;

  if (!ctx.session) ctx.session = {};
  ctx.session.state = States.SESSION_EXAM_DATE || 'session:exam_date';
  ctx.session.data = { sessionSubject: subjectKey };

  const buttons = [
    [
      Markup.button.callback("7 kun", "session_add_days_7"),
      Markup.button.callback("14 kun", "session_add_days_14"),
    ],
    [
      Markup.button.callback("30 kun", "session_add_days_30"),
      Markup.button.callback("60 kun", "session_add_days_60"),
    ],
    [Markup.button.callback("🔙 Orqaga", "session_add")],
  ];

  await safeEdit(
    ctx,
    `📅 <b>${subjName}</b> bo'yicha imtihon sanasini belgilang:\n\n` +
      `Quyidagi tugmalardan birini tanlang yoki imtihon sanasini <code>YYYY-MM-DD</code> formatida (yoki qolgan kunlar sonini) yozib yuboring:`,
    Markup.inlineKeyboard(buttons)
  );
}

async function cbSessionAddDays(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const days = parseInt(ctx.match[1], 10);
  const subjectKey = ctx.session?.data?.sessionSubject;

  if (!subjectKey) {
    return cbSessionAdd(ctx);
  }

  const d = new Date();
  d.setDate(d.getDate() + days);
  const examDateStr = d.toISOString().split('T')[0];

  await createExamSessionRecord(ctx, subjectKey, examDateStr);
}

async function onExamDateInput(ctx) {
  const text = ctx.message?.text?.trim();
  const subjectKey = ctx.session?.data?.sessionSubject;

  if (!subjectKey) {
    clearState(ctx);
    return;
  }

  let examDateStr = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    examDateStr = text;
  } else if (/^\d+$/.test(text)) {
    const days = parseInt(text, 10);
    if (days > 0 && days <= 365) {
      const d = new Date();
      d.setDate(d.getDate() + days);
      examDateStr = d.toISOString().split('T')[0];
    }
  }

  if (!examDateStr) {
    return ctx.reply(
      `⚠️ Noto'g'ri format. Iltimos, sanani <code>YYYY-MM-DD</code> formatida (masalan: 2026-08-15) yoki qolgan kunlar sonini (masalan: 20) yozing.`,
      { parse_mode: 'HTML' }
    );
  }

  await createExamSessionRecord(ctx, subjectKey, examDateStr);
}

async function createExamSessionRecord(ctx, subjectKey, examDateStr) {
  const userId = String(ctx.from.id);
  const dailyPlan = buildDailyPlan(examDateStr, 300);

  clearState(ctx);

  const { error } = await supabase.from('exam_sessions').insert({
    user_id: userId,
    subject: subjectKey,
    exam_date: examDateStr,
    status: 'active',
    daily_plan: dailyPlan,
    readiness_pct: 0,
  });

  if (error) {
    console.error('createExamSessionRecord xatosi:', error.message);
    const errorMsg = `❌ Imtihon sessiyasini saqlashda xatolik yuz berdi.`;
    if (ctx.callbackQuery) {
      return safeEdit(ctx, errorMsg);
    }
    return ctx.reply(errorMsg, { parse_mode: 'HTML' });
  }

  const subjName = SUBJECTS[subjectKey] || subjectKey;
  const firstDayQty = dailyPlan[0]?.target_qty || 15;
  const successText =
    `✅ <b>${subjName}</b> bo'yicha imtihon sessiyasi muvaffaqiyatli qo'shildi!\n\n` +
    `📅 <b>Imtihon sanasi:</b> ${examDateStr}\n` +
    `📈 <b>Kunlik reja:</b> kuniga ~${firstDayQty} ta savol\n\n` +
    `Har kuni <code>/sessiya</code> orqali kunlik vazifangizni bajarib boring!`;

  const extra = Markup.inlineKeyboard([
    [Markup.button.callback("🔙 Sessiyalar ro'yxati", "sessiya_menu")],
  ]);

  if (ctx.callbackQuery) {
    return safeEdit(ctx, successText, extra);
  }
  return ctx.reply(successText, { parse_mode: 'HTML', ...extra });
}

async function cbSessionRun(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const sessionId = ctx.match[1];
  const userId = String(ctx.from.id);
  const chatId = ctx.chat.id;

  try {
    const existing = await sessionService.getActiveTest(chatId);
    if (existing) {
      return ctx
        .answerCbQuery("⚠️ Avvalgi testni to'xtating: /stop", { show_alert: true })
        .catch(() => {});
    }

    const { data: session, error } = await supabase
      .from('exam_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('user_id', userId)
      .single();

    if (error || !session) {
      return safeEdit(ctx, "❌ Imtihon sessiyasi topilmadi.");
    }

    const todayStr = new Date().toISOString().split('T')[0];
    const planList = Array.isArray(session.daily_plan) ? session.daily_plan : [];
    const todayPlan = planList.find((p) => p.day === todayStr) || planList[0];
    const targetQty = todayPlan?.target_qty || 15;

    const mistakes = await dbService.getUserMistakes(ctx.from.id, session.subject, 30);
    const subjName = SUBJECTS[session.subject] || session.subject;

    if (mistakes.length >= 5) {
      const msg = await ctx.reply(
        `⏳ <i>AI "${subjName}" fanidan sizning zaif joylaringiz (xatolar) asosida ${targetQty} ta maxsus adaptiv savol tuzmoqda...</i> 🧠`,
        { parse_mode: 'HTML' }
      );

      const shuffledMistakes = [...mistakes].sort(() => 0.5 - Math.random());
      const questions = await aiService.generateAdaptiveQuiz(
        subjName,
        shuffledMistakes,
        targetQty
      );

      if (questions && questions.length > 0) {
        await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
        await initAndStartTest(
          chatId,
          ctx.telegram,
          session.subject,
          'adaptive',
          { questions, block_name: '🎯 Sessiya Adaptiv Test' },
          ctx.from.id,
          'private'
        );
        return;
      }
      await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
    }

    const memDb = require('../core/bot').memoryDb || {};
    let allQs = Object.values(memDb[session.subject] || {}).flatMap(
      (t) => t.questions || []
    );

    if (!allQs.length) {
      const db = await dbService.loadAllOfficialTests();
      allQs = Object.values(db[session.subject] || {}).flatMap(
        (t) => t.questions || []
      );
    }

    if (!allQs.length) {
      return safeEdit(ctx, `❌ <b>${subjName}</b> bo'yicha savollar topilmadi.`);
    }

    const shuffledQs = [...allQs].sort(() => 0.5 - Math.random());
    const questions = shuffledQs.slice(0, targetQty);

    await initAndStartTest(
      chatId,
      ctx.telegram,
      session.subject,
      'session_practice',
      { questions, block_name: "📚 Sessiya Kunlik Mashg'ulot" },
      ctx.from.id,
      'private'
    );
  } catch (e) {
    console.error('cbSessionRun xatosi:', e.message);
  }
}

function register(bot) {
  bot.action('sessiya_menu', cbSessiyaMenu);
  bot.action('session_add', cbSessionAdd);
  bot.action(/^session_add_subj_(.+)$/, cbSessionAddSubject);
  bot.action(/^session_add_days_(\d+)$/, cbSessionAddDays);
  bot.action(/^session_run_(\d+)$/, cbSessionRun);
}

module.exports = {
  register,
  buildDailyPlan,
  cbSessiyaMenu,
  cbSessionAdd,
  cbSessionAddSubject,
  cbSessionAddDays,
  onExamDateInput,
  cbSessionRun,
};
