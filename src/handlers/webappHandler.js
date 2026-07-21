'use strict';

const { Markup } = require('telegraf');
const { WEBAPP_URL, SUBJECTS } = require('../config/config');
const { safeWebAppButton } = require('../core/utils');

/**
 * Register Telegram WebApp / Mini App commands and handlers with deep linking
 */
function registerWebappHandlers(bot) {
  const handleOpenWebApp = async (ctx) => {
    const welcomeText = 
      "🚀 *Quiz Bot Pro — Telegram Mini App (Vizual UI)*\n\n" +
      "Bizning yangi vizual interfeysimiz orqali testlarni yanada qulayroq va zamonaviy usulda yeching:\n\n" +
      "🔥 *Kunlik Streak* va reyting hisoblagich\n" +
      "🤖 *AI Shaxsiy Ustoz Yordamchisi* (Gemini 1.5 Flash orqali xatolarni izohlash)\n" +
      "📊 *Xatolar Hub & Flashcards* bilan avtomatik takrorlash\n" +
      "🎓 *Prava / Duolingo uslubidagi* silliq interaktiv test ekrani\n\n" +
      "👇 *Quyidagi tugmalardan birini bosib, to'g'ridan-to'g'ri kerakli bo'lim yoki fanni WebApp da oching:*";

    const subjectButtons = Object.entries(SUBJECTS).map(([key, name]) => [
      safeWebAppButton(`📲 ${name} (WebApp)`, `${WEBAPP_URL}?subject=${encodeURIComponent(key)}`)
    ]);

    const keyboard = Markup.inlineKeyboard([
      [safeWebAppButton("🚀 Asosiy WebApp Dashboard", WEBAPP_URL)],
      ...subjectButtons,
      [safeWebAppButton("💡 Xatolar Hub & Flashcard (WebApp)", `${WEBAPP_URL}?tab=mistakes`)],
      [Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]
    ]);

    try {
      await ctx.replyWithMarkdown(welcomeText, keyboard);
    } catch (e) {
      await ctx.reply(
        "🚀 Quiz Bot Pro WebApp ni ochish uchun quyidagi tugmalardan foydalaning:",
        keyboard
      );
    }
  };

  bot.command('webapp', handleOpenWebApp);
  bot.command('app', handleOpenWebApp);
  bot.command('miniapp', handleOpenWebApp);

  bot.action('open_webapp', async (ctx) => {
    try { await ctx.answerCbQuery(); } catch (e) {}
    await handleOpenWebApp(ctx);
  });
}

module.exports = {
  register: registerWebappHandlers,
  registerWebappHandlers,
};
