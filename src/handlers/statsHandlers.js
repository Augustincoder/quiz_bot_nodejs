"use strict";

const { Markup } = require("telegraf");
const dbService = require("../services/dbService");
const {
  safeEdit,
  backToMainKb,
  progressBar,
  escapeHtml,
  safeAnswerCb,
} = require("../core/utils");

const ITEMS_PER_PAGE = 5;

// ─── 1. STATS DASHBOARD ──────────────────────────────────────

async function cbStatsMenu(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const [stats, rank] = await Promise.all([
      dbService.getUserStats(ctx.from.id),
      dbService.getUserRank(ctx.from.id),
    ]);

    const correct = stats.total_correct || 0;
    const wrong = stats.total_wrong || 0;
    const totalAnswers = correct + wrong;
    const accuracy =
      totalAnswers > 0 ? Math.round((correct / totalAnswers) * 100) : 0;
    const completed = stats.tests_completed || 0;
    const rankLabel = rank !== "N/A" ? `${rank}-o'rin` : "Hali aniqlanmadi";

    await safeEdit(
      ctx,
      `📊 <b>Shaxsiy Statistika</b>\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🎯 Aniqlik:            <b>${accuracy}%</b>\n` +
        `${progressBar(accuracy, 100)}\n` +
        `✅ To'g'ri javoblar:   <b>${correct} ta</b>\n` +
        `❌ Xato javoblar:      <b>${wrong} ta</b>\n` +
        `📝 Yakunlangan testlar:<b>${completed} ta</b>\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `🏆 Reytingdagi o'rin: <b>${rankLabel}</b>\n\n` +
        `<i>💡 Ko'proq test yeching va to'g'ri javoblar bilan reytingda o'rningizni oshiring!</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("🏆 Top-10 Reyting", "stats_leaderboard")],
          [Markup.button.callback("📜 O'tgan testlar", "stats_history_0")],
          [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")],
        ]),
      },
    );
  } catch (e) {
    console.error("cbStatsMenu error:", e.message);
    await ctx.answerCbQuery("❌ Xatolik yuz berdi.", { show_alert: true }).catch(() => {});
  }
}

// ─── 2. LEADERBOARD ──────────────────────────────────────────

async function cbLeaderboard(ctx) {
  await safeAnswerCb(ctx, "🏆 Top-10 yuklanmoqda...");
  try {
    const [topUsers, allUsers] = await Promise.all([
      dbService.getTopUsers(10),
      dbService.getAllUsers(),
    ]);

    if (!topUsers?.length) {
      return safeEdit(
        ctx,
        "🏆 Reyting jadvali hozircha bo'sh.\n\n💡 Birinchi bo'lib test yechib, reytingda 🥇 o'rin egallang!",
        { parse_mode: "HTML", ...backToMainKb() },
      );
    }

    const userMap = {};
    (allUsers || []).forEach(
      (u) => (userMap[u.telegram_id] = u.full_name || "Talaba"),
    );

    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
    const lines = topUsers.map((user, i) => {
      const name = escapeHtml(userMap[user.user_id] || "Maxfiy Talaba");
      return `${medals[i] ?? "🔸"} <b>${name}</b> — ${user.correct} ball`;
    });

    await safeEdit(
      ctx,
      `🏆 <b>Kuchlilar O'nligi (Top-10)</b>\n\n━━━━━━━━━━━━━━━━\n` +
        lines.join("\n") +
        `\n━━━━━━━━━━━━━━━━\n<i>💡 Ballar to'g'ri javoblar soniga qarab hisoblanadi.</i>`,
      {
        parse_mode: "HTML",
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback("🔙 Orqaga", "stats_menu"),
            Markup.button.callback("🏠 Asosiy Menyu", "back_to_main"),
          ],
        ]),
      },
    );
  } catch (e) {
    console.error("cbLeaderboard error:", e.message);
  }
}

// ─── 3. TEST HISTORY (PAGINATED) ─────────────────────────────

async function cbHistoryPage(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const raw = ctx.callbackQuery.data.replace("stats_history_", "");
    const page = Math.max(0, parseInt(raw, 10) || 0);

    const stats = await dbService.getUserStats(ctx.from.id);
    const history = (stats.history || []).slice().reverse(); // newest first

    if (!history.length) {
      return safeEdit(
        ctx,
        "📜 <b>Test Tarixi</b>\n\n📭 Siz hali hech qanday testni yakunlamagansiz.\n\n💡 Rasmiy testlar yoki AI Smart Quiz orqali birinchi testingizni yeching — natijalar shu yerda ko'rinadi!",
        {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("🔙 Orqaga", "stats_menu")],
          ]),
        },
      );
    }

    const totalPages = Math.ceil(history.length / ITEMS_PER_PAGE);
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const currentItems = history.slice(
      safePage * ITEMS_PER_PAGE,
      (safePage + 1) * ITEMS_PER_PAGE,
    );

    const lines = currentItems.map((record, idx) => {
      const globalIdx = safePage * ITEMS_PER_PAGE + idx + 1;
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
      const emoji = percent >= 75 ? "🟢" : percent >= 50 ? "🟡" : "🔴";
      return (
        `<b>${globalIdx}. ${escapeHtml(record.subject)}</b> <i>(${date})</i>\n` +
        `${emoji} ✅ ${record.correct || 0}  ❌ ${record.wrong || 0}  🎯 <b>${percent}%</b>`
      );
    });

    const navRow = [];
    if (safePage > 0)
      navRow.push(
        Markup.button.callback("⬅️ Oldingi", `stats_history_${safePage - 1}`),
      );
    navRow.push(
      Markup.button.callback(`${safePage + 1} / ${totalPages}`, "ignore"),
    );
    if (safePage < totalPages - 1)
      navRow.push(
        Markup.button.callback("Keyingi ➡️", `stats_history_${safePage + 1}`),
      );

    const buttons = [];
    if (navRow.length > 1) buttons.push(navRow);
    buttons.push([
      Markup.button.callback("🔙 Orqaga", "stats_menu"),
      Markup.button.callback("🏠 Asosiy Menyu", "back_to_main"),
    ]);

    await safeEdit(
      ctx,
      `📜 <b>Test Tarixi</b>  <i>(${safePage + 1} / ${totalPages})</i>\n` +
        `Jami: <b>${history.length} ta test</b>\n\n` +
        lines.join("\n━━━━━━━━━━━\n"),
      { parse_mode: "HTML", ...Markup.inlineKeyboard(buttons) },
    );
  } catch (e) {
    console.error("cbHistoryPage error:", e.message);
  }
}

// ─── REGISTER ────────────────────────────────────────────────

function register(bot) {
  bot.action("stats_menu", cbStatsMenu);
  bot.action("stats_leaderboard", cbLeaderboard);
  bot.action(/^stats_history/, cbHistoryPage);
  bot.action("ignore", (ctx) => ctx.answerCbQuery()).catch(() => {});
}

module.exports = { register, cbStatsMenu, cbLeaderboard, cbHistoryPage };
