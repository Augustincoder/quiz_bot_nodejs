'use strict';

const dbService = require('../services/dbService');
const { safeEdit, backToMainKb } = require('../core/utils');
const { Markup } = require('telegraf');

// 1. Asosiy Statistika Dashbaord'i
async function cbStatsMenu(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => { });
    const userId = ctx.from.id;

    // Bazadan ma'lumotlarni olish
    const stats = await dbService.getUserStats(userId);
    const rank = await dbService.getUserRank(userId);

    const totalTests = stats.tests_completed || 0;
    const correct = stats.total_correct || 0;
    const wrong = stats.total_wrong || 0;
    const totalAnswers = correct + wrong;
    const accuracy = totalAnswers > 0 ? Math.round((correct / totalAnswers) * 100) : 0;

    const text = `📊 *Shaxsiy Statistika va Reyting*

Bu yerda sizning butun o'quv tarixingiz va o'sish ko'rsatkichlaringiz jamlangan.

━━━━━━━━━━━━━━━━
📈 *Umumiy ko'rsatkichlar:*
🎯 *Aniqlik:* ${accuracy}%
✅ *To'g'ri javoblar:* ${correct} ta
❌ *Xato javoblar:* ${wrong} ta
📝 *Tugallangan testlar:* ${totalTests} ta

🏆 *Sizning Reytingdagi o'rningiz:* ${rank !== 'N/A' ? rank + '-o\'rin' : 'Hali aniqlanmadi'}
━━━━━━━━━━━━━━━━

💡 *Maslahat:* Reytingda ko'tarilish uchun "Adaptiv Test" larni ko'proq ishlang. Bu orqali ham bilimingiz, ham ballingiz tezroq oshadi.`;

    const buttons = [
      [Markup.button.callback('🏆 Top-10 Reyting (Leaderboard)', 'stats_leaderboard')],
      [Markup.button.callback('📜 O\'tgan testlar tarixi', 'stats_history')],
      [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
    ];

    await safeEdit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery("❌ Xatolik yuz berdi.", { show_alert: true });
  }
}

// 2. Top 10 Reyting doskasi
async function cbLeaderboard(ctx) {
  try {
    await ctx.answerCbQuery("🏆 Top-10 yuklanmoqda...").catch(() => { });
    const topUsers = await dbService.getTopUsers(10);

    if (!topUsers || topUsers.length === 0) {
      return safeEdit(ctx, "🏆 Hozircha reyting bo'sh. Birinchi bo'lish imkoniyati sizda!", backToMainKb());
    }

    let text = `🏆 *Kuchlilar O'nligi (Top-10)*\n\n━━━━━━━━━━━━━━━━\n`;
    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

    // Ismlarni olish
    const allUsers = await dbService.getAllUsers();
    const userMap = {};
    if (allUsers) {
      allUsers.forEach(u => userMap[u.telegram_id] = u.full_name || 'Talaba');
    }

    topUsers.forEach((user, index) => {
      const name = userMap[user.user_id] || 'Maxfiy Talaba';
      const medal = medals[index] || '🔸';
      text += `${medal} *${name}* — ${user.correct} ball\n`;
    });

    text += `━━━━━━━━━━━━━━━━\n💡 _Ballar faqat topilgan to'g'ri javoblar soniga qarab hisoblanadi._`;

    await safeEdit(ctx, text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Orqaga', 'stats_menu')]])
    });

  } catch (e) { console.error(e); }
}

// 3. Shaxsiy Testlar Tarixi
async function cbHistory(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => { });
    const stats = await dbService.getUserStats(ctx.from.id);
    const history = stats.history || [];

    if (history.length === 0) {
      return safeEdit(ctx, "📜 *Testlar tarixi*\n\nSiz hali hech qanday testni yakunlamagansiz. O'quv tarixingiz hozircha bo'sh.", {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Orqaga', 'stats_menu')]])
      });
    }

    let text = `📜 *So'nggi testlar tarixi*\n\n`;
    const limit = Math.min(history.length, 5); // Oxirgi 5 ta testni ko'rsatamiz tiqilinch bo'lmasligi uchun

    for (let i = 0; i < limit; i++) {
      const h = history[i];
      const dateStr = String(h.date).slice(0, 10);
      text += `*${i + 1}. Fan:* ${h.subject}\n✅ ${h.correct} ta to'g'ri | ❌ ${h.wrong} ta xato\n📅 ${dateStr}\n\n`;
    }

    if (history.length > 5) {
      text += `_...va yana ${history.length - 5} ta avvalgi testlar._`;
    }

    await safeEdit(ctx, text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Orqaga', 'stats_menu')]])
    });

  } catch (e) { console.error(e); }
}

// 4. Asosiy botga ro'yxatdan o'tkazish
function register(bot) {
  bot.action('stats_menu', cbStatsMenu);
  bot.action('stats_leaderboard', cbLeaderboard);
  bot.action('stats_history', cbHistory);
}

module.exports = { register, cbStatsMenu, cbLeaderboard, cbHistory };