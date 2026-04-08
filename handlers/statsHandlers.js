'use strict';

const { Markup }   = require('telegraf');
const { SUBJECTS } = require('../config');
const statsManager = require('../statsManager');
const {
  safeEdit, backToMainKb, progressBar, safePercent, grade,
  parseSuffix, getUserName, leaderboardCache, LEADERBOARD_TTL,
} = require('../utils');

async function cbShowLeaderboard(ctx) {
  await ctx.answerCbQuery();
  const now = Date.now();

  if (leaderboardCache.text && now - leaderboardCache.ts < LEADERBOARD_TTL) {
    return safeEdit(ctx, leaderboardCache.text,
      Markup.inlineKeyboard([[Markup.button.callback('🔙 Asosiy Menyu', 'back_to_main')]]));
  }

  await safeEdit(ctx, '⏳ Reyting yuklanmoqda...');
  const top = await statsManager.getTopUsers(10);

  let text;
  if (!top.length) {
    text =
      '🏆 *TOP REYTING*\n\n' +
      'Hozircha hech kim yo\'q.\n' +
      'Test ishlang va birinchi o\'ringa chiqing!';
  } else {
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const names  = await Promise.allSettled(
      top.map(u => getUserName(ctx.telegram, u.user_id))
    );
    const lines = top.map((user, i) => {
      const display = names[i].status === 'fulfilled' ? names[i].value : 'Sirli Talaba';
      const pct     = safePercent(user.correct, user.correct);
      return (
        `${medals[i] ?? '🔸'} *${display}*\n` +
        `      ✅ ${user.correct}  📝 ${user.completed} test`
      );
    });
    text = '🏆 *TOP 10 TALABALAR*\n\n' + lines.join('\n\n');
  }

  leaderboardCache.text = text;
  leaderboardCache.ts   = now;

  await safeEdit(ctx, text,
    Markup.inlineKeyboard([[Markup.button.callback('🔙 Asosiy Menyu', 'back_to_main')]]));
}

async function cbShowStats(ctx) {
  await ctx.answerCbQuery();
  if (ctx.chat.type !== 'private') {
    return ctx.answerCbQuery('📊 Statistika faqat shaxsiy chatda ko\'rsatiladi!', { show_alert: true });
  }

  const stats = await statsManager.getUserStats(ctx.from.id);
  const rank  = await statsManager.getUserRank(ctx.from.id);
  const total = stats.total_correct + stats.total_wrong;
  const pct   = safePercent(stats.total_correct, total);

  const buttons = [];
  if ((stats.history || []).length) {
    buttons.push([Markup.button.callback('📜 Test tarixim', 'hist_page_0')]);
  }
  buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]);

  await safeEdit(ctx,
    `📊 *Shaxsiy Statistika*\n\n` +
    `🏆 Reyting: *${rank}-o\'rin*\n\n` +
    `✅ To\'g\'ri: *${stats.total_correct} ta*\n` +
    `❌ Xato: *${stats.total_wrong} ta*\n` +
    `📝 Testlar: *${(stats.history || []).length} ta*\n\n` +
    `🎯 O\'zlashtirish: *${pct}%*\n` +
    `${progressBar(parseInt(pct), 100, 20)}`,
    Markup.inlineKeyboard(buttons),
  );
}

async function cbHistPage(ctx) {
  await ctx.answerCbQuery();
  const page    = parseInt(parseSuffix(ctx.callbackQuery.data, 'hist_page_'), 10);
  const stats   = await statsManager.getUserStats(ctx.from.id);
  const history = stats.history || [];

  if (!history.length) {
    return safeEdit(ctx, '📜 Tarix bo\'sh. Hali test ishlamadingiz.', backToMainKb());
  }

  const totalPages = Math.max(1, Math.ceil(history.length / 5));
  const p          = Math.max(0, Math.min(page, totalPages - 1));
  const chunk      = history.slice(p * 5, (p + 1) * 5);

  const buttons = chunk.map((item, i) => {
    const tId   = String(item.test_id);
    const label = tId === 'mock' ? '🎲 Aralash'
      : tId.startsWith('ugc_') ? '📝 Maxsus'
      : `${tId}-Blok`;
    const subj = SUBJECTS[item.subject] || item.subject;
    const tot  = item.correct + (item.wrong || 0);
    const pct  = Math.round(safePercent(item.correct, tot));
    return [Markup.button.callback(
      `${String(item.date).slice(0, 10)} | ${subj} ${label} | ${item.correct}/${tot} (${pct}%)`,
      `hist_det_${p * 5 + i}`,
    )];
  });

  const nav = [];
  if (p > 0)            nav.push(Markup.button.callback('⬅️ Oldingi', `hist_page_${p - 1}`));
  if (p < totalPages-1) nav.push(Markup.button.callback('Keyingi ➡️', `hist_page_${p + 1}`));
  if (nav.length) buttons.push(nav);
  buttons.push([Markup.button.callback('🔙 Statistikaga', 'show_stats')]);

  await safeEdit(ctx,
    `📜 *Test Tarixi* (${p + 1}/${totalPages})\n\nBatafsil ko\'rish uchun tanlang:`,
    Markup.inlineKeyboard(buttons),
  );
}

async function cbHistDetail(ctx) {
  await ctx.answerCbQuery();
  const idx     = parseInt(parseSuffix(ctx.callbackQuery.data, 'hist_det_'), 10);
  const stats   = await statsManager.getUserStats(ctx.from.id);
  const history = stats.history || [];

  if (idx >= history.length) return ctx.answerCbQuery('❌ Ma\'lumot topilmadi!', { show_alert: true });

  const item  = history[idx];
  const tId   = String(item.test_id);
  const label = tId === 'mock' ? '🎲 Aralash'
    : tId.startsWith('ugc_') ? '📝 Maxsus'
    : `${tId}-Blok`;
  const tot   = item.correct + (item.wrong || 0);
  const pct   = safePercent(item.correct, tot);

  const parts = [
    `📅 *Sana:* ${String(item.date).slice(0, 10)}\n` +
    `📚 *Fan:* ${SUBJECTS[item.subject] || item.subject}\n` +
    `📝 *Test:* ${label}\n\n` +
    `✅ To\'g\'ri: *${item.correct}*  ❌ Xato: *${item.wrong || 0}*\n` +
    `🎯 Natija: *${pct}%*\n${progressBar(parseInt(pct), 100)}`,
  ];

  const mistakes = item.mistakes || [];
  if (mistakes.length) {
    parts.push(`📑 *Xatolar (${mistakes.length} ta):*`);
    for (let i = 0; i < Math.min(mistakes.length, 15); i++) {
      const m = mistakes[i];
      parts.push(`*${i + 1}.* ${m.question}\n❌ ${m.wrong_ans}\n✅ ${m.correct_ans}`);
    }
    if (mistakes.length > 15) parts.push(`_...va yana ${mistakes.length - 15} ta xato_`);
  } else {
    parts.push('🎉 *Bu testda xato qilmadingiz!*');
  }

  let text = parts.join('\n\n');
  if (text.length > 4000) text = text.slice(0, 3900) + '\n\n_(Matn kesildi)_';

  await safeEdit(ctx, text,
    Markup.inlineKeyboard([[Markup.button.callback('🔙 Tarixga', `hist_page_${Math.floor(idx / 5)}`)]]),
  );
}

function register(bot) {
  bot.action('show_leaderboard', cbShowLeaderboard);
  bot.action('show_stats',       cbShowStats);
  bot.action(/^hist_page_/,      cbHistPage);
  bot.action(/^hist_det_/,       cbHistDetail);
}

module.exports = { register };