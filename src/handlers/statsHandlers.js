"use strict";

const dbService = require("../services/dbService");
const { safeEdit, backToMainKb } = require("../core/utils");
const { Markup } = require("telegraf");

// 1. Asosiy Statistika Dashbaord'i
async function cbStatsMenu(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const userId = ctx.from.id;

    // Bazadan ma'lumotlarni olish
    const stats = await dbService.getUserStats(userId);
    const rank = await dbService.getUserRank(userId);

    const totalTests = stats.tests_completed || 0;
    const correct = stats.total_correct || 0;
    const wrong = stats.total_wrong || 0;
    const totalAnswers = correct + wrong;
    const accuracy =
      totalAnswers > 0 ? Math.round((correct / totalAnswers) * 100) : 0;

    const text = `📊 *Shaxsiy Statistika va Reyting*

Bu yerda sizning butun o'quv tarixingiz va o'sish ko'rsatkichlaringiz jamlangan.

━━━━━━━━━━━━━━━━
📈 *Umumiy ko'rsatkichlar:*
🎯 *Aniqlik:* ${accuracy}%
✅ *To'g'ri javoblar:* ${correct} ta
❌ *Xato javoblar:* ${wrong} ta
📝 *Tugallangan testlar:* ${totalTests} ta

🏆 *Sizning Reytingdagi o'rningiz:* ${rank !== "N/A" ? rank + "-o'rin" : "Hali aniqlanmadi"}
━━━━━━━━━━━━━━━━

💡 *Maslahat:* Reytingda ko'tarilish uchun "Adaptiv Test" larni ko'proq ishlang. Bu orqali ham bilimingiz, ham ballingiz tezroq oshadi.`;

    const buttons = [
      [
        Markup.button.callback(
          "🏆 Top-10 Reyting (Leaderboard)",
          "stats_leaderboard",
        ),
      ],
      [Markup.button.callback("📜 O'tgan testlar tarixi", "stats_history")],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
    ];

    await safeEdit(ctx, text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery("❌ Xatolik yuz berdi.", { show_alert: true });
  }
}

// 2. Top 10 Reyting doskasi
async function cbLeaderboard(ctx) {
  try {
    await ctx.answerCbQuery("🏆 Top-10 yuklanmoqda...").catch(() => {});
    const topUsers = await dbService.getTopUsers(10);

    if (!topUsers || topUsers.length === 0) {
      return safeEdit(
        ctx,
        "🏆 Hozircha reyting bo'sh. Birinchi bo'lish imkoniyati sizda!",
        backToMainKb(),
      );
    }

    let text = `🏆 *Kuchlilar O'nligi (Top-10)*\n\n━━━━━━━━━━━━━━━━\n`;
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

    // Ismlarni olish
    const allUsers = await dbService.getAllUsers();
    const userMap = {};
    if (allUsers) {
      allUsers.forEach(
        (u) => (userMap[u.telegram_id] = u.full_name || "Talaba"),
      );
    }

    topUsers.forEach((user, index) => {
      const name = userMap[user.user_id] || "Maxfiy Talaba";
      const medal = medals[index] || "🔸";
      text += `${medal} *${name}* — ${user.correct} ball\n`;
    });

    text += `━━━━━━━━━━━━━━━━\n💡 _Ballar faqat topilgan to'g'ri javoblar soniga qarab hisoblanadi._`;

    await safeEdit(ctx, text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("🔙 Orqaga", "stats_menu")],
      ]),
    });
  } catch (e) {
    console.error(e);
  }
}

// 3. Shaxsiy Testlar Tarixi
// 3. Shaxsiy Testlar Tarixi (Sahifalangan)
async function cbHistoryPage(ctx) {
  try {
    await ctx.answerCbQuery().catch(() => {});

    // Qaysi sahifadaligini aniqlaymiz (Default: 0)
    let page = 0;
    if (
      ctx.callbackQuery.data &&
      ctx.callbackQuery.data.startsWith("stats_history_")
    ) {
      page = parseInt(ctx.callbackQuery.data.replace("stats_history_", ""), 10);
    }

    const stats = await dbService.getUserStats(ctx.from.id);
    const history = stats.history || [];

    if (history.length === 0) {
      return safeEdit(
        ctx,
        "📜 *Testlar tarixi*\n\nSiz hali hech qanday testni yakunlamagansiz. O'quv tarixingiz hozircha bo'sh.",
        {
          parse_mode: "Markdown",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Orqaga", "stats_menu")],
          ]),
        },
      );
    }

    // Eng oxirgi ishlangan testlar birinchi chiqishi uchun ro'yxatni teskari o'giramiz
    const reversedHistory = [...history].reverse();

    const itemsPerPage = 5; // Har bitta sahifada 5 tadan test ko'rinadi
    const totalPages = Math.ceil(reversedHistory.length / itemsPerPage);
    const currentItems = reversedHistory.slice(
      page * itemsPerPage,
      (page + 1) * itemsPerPage,
    );

    let text = `📜 *Sizning Test Tarixingiz* (Sahifa ${page + 1}/${totalPages})\nJami ishlangan testlar: ${reversedHistory.length} ta\n\n`;

    currentItems.forEach((record, index) => {
      const globalIndex = page * itemsPerPage + index + 1;
      const date = new Date(record.date).toLocaleDateString("uz-UZ", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
      const totalAnswers = (record.correct || 0) + (record.wrong || 0);
      const percent =
        totalAnswers > 0
          ? Math.round((record.correct / totalAnswers) * 100)
          : 0;

      text += `*${globalIndex}. ${record.subject}* (${date})\n`;
      text += `✅ To'g'ri: ${record.correct || 0} | ❌ Xato: ${record.wrong || 0} | 🎯 Natija: ${percent}%\n`;
      text += `━━━━━━━━━━━━━━━━━━\n`;
    });

    // Navigatsiya (Sahifalash) tugmalari
    const buttons = [];
    const navRow = [];

    if (page > 0) {
      navRow.push(
        Markup.button.callback("⬅️ Oldingi", `stats_history_${page - 1}`),
      );
    }
    if (page < totalPages - 1) {
      navRow.push(
        Markup.button.callback("Keyingi ➡️", `stats_history_${page + 1}`),
      );
    }

    if (navRow.length > 0) buttons.push(navRow);

    buttons.push([Markup.button.callback("🔙 Orqaga", "stats_menu")]);

    await safeEdit(ctx, text, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.error(e);
  }
}

// 4. Asosiy botga ro'yxatdan o'tkazish
function register(bot) {
  bot.action("stats_menu", cbStatsMenu);
  bot.action("stats_leaderboard", cbLeaderboard);
  // Diqqat: Bu yerda Regex ishlatyapmiz, shunda stats_history_0, stats_history_1 hammasini ushlaydi
  bot.action(/^stats_history/, cbHistoryPage);
}

module.exports = { register, cbStatsMenu, cbLeaderboard, cbHistoryPage };
