'use strict';

const { Markup } = require('telegraf');
const aiService = require('../services/aiService');
const dbService = require('../services/dbService');
const { ADMIN_ID, SUBJECTS } = require('../config/config');
const { States, setState, clearState, updateData, getData, getState, safeEdit, backToMainKb, escapeHtml, sanitizeForTelegram } = require('../core/utils');

function isAdmin(userId) { return userId === ADMIN_ID; }

function adminGuard(fn) {
  return async (ctx, ...args) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ruxsat yo\'q!', { show_alert: true }).catch(() => {});
    return fn(ctx, ...args);
  };
}

// ─── AI TESTS MENU ─────────────────────────────────────────────
async function cbAdminAiTests(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const buttons = Object.entries(SUBJECTS).map(([k, v]) => [Markup.button.callback(v, `ai_tests_subj_${k}`)]);
  buttons.push([Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]);
  await safeEdit(ctx, "🤖 <b>AI Testlar</b>\n\nQaysi fanga AI test yaratmoqchisiz?", { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  setState(ctx, States.ADMIN_AI_TESTS_SUBJECT);
}

async function cbAiTestsSubj(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const subj = parseSuffix(ctx.callbackQuery.data, 'ai_tests_subj_');
  await updateData(ctx, { subject: subj });
  setState(ctx, States.ADMIN_AI_TESTS_TYPE);
  await safeEdit(ctx,
    `✅ Fan: <b>${escapeHtml(SUBJECTS[subj] || subj)}</b>\n\nAI test turini tanlang:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Matn asosida', 'ai_tests_type_text')],
        [Markup.button.callback('🖼 Rasmdan', 'ai_tests_type_image')],
        [Markup.button.callback('🔄 Adaptiv (xatolardan)', 'ai_tests_type_adaptive')],
        [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
      ]),
    },
  );
}

async function cbAiTestsType(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const type = parseSuffix(ctx.callbackQuery.data, 'ai_tests_type_');
  await updateData(ctx, { ai_test_type: type });
  
  if (type === 'text') {
    setState(ctx, States.ADMIN_AI_TESTS_TEXT);
    await safeEdit(ctx,
      `📝 <b>Matn asosida AI test</b>\n\nTest yaratish uchun matnni yuboring:\n\n<i>Yoki "auto" deb yozing, AI o'zi miqdorni belgilasin</i>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
    );
  } else if (type === 'image') {
    setState(ctx, States.ADMIN_AI_TESTS_IMAGE);
    await safeEdit(ctx,
      `🖼 <b>Rasmdan AI test</b>\n\nTest yaratish uchun rasm yuboring:\n\n<i>Yoki "auto" deb yozing, AI o'zi miqdorni belgilasin</i>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
    );
  } else if (type === 'adaptive') {
    setState(ctx, States.ADMIN_AI_TESTS_ADAPTIVE_USER);
    await safeEdit(ctx,
      `🔄 <b>Adaptiv AI test</b>\n\nFoydalanuvchi Telegram ID sini kiriting (xatolar asosida test yaratiladi):`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
    );
  }
}

// ─── TEXT BASED AI TEST ────────────────────────────────────────
async function onAiTestsText(ctx) {
  const text = ctx.message.text;
  if (!text) return;
  
  let count = 'auto';
  if (text.toLowerCase() === 'auto') {
    // AI o'zi belgilaydi
  } else {
    // Foydalanuvchi kiritgan miqdor
    count = text.trim();
  }
  
  await updateData(ctx, { ai_test_text: text, ai_test_count: count });
  setState(ctx, States.ADMIN_AI_TESTS_GENERATE);
  
  const status = await ctx.reply("⏳ <b>AI test yaratilmoqda...</b>", { parse_mode: 'HTML' });
  
  try {
    const questions = await aiService.generateQuizFromText(text, count);
    if (!questions || !questions.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "❌ AI test yaratishda xatolik yuz berdi.");
      clearState(ctx);
      return;
    }
    
    await updateData(ctx, { ai_generated_questions: questions });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `✅ <b>AI test yaratildi!</b>\n\n📊 Savollar soni: <b>${questions.length} ta</b>\n\nNima qilamiz?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👁 Ko\'rib chiqish', 'ai_tests_preview')],
          [Markup.button.callback('💾 Saqlash', 'ai_tests_save')],
          [Markup.button.callback('🔄 Qayta yaratish', 'ai_tests_regenerate')],
          [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
        ]),
      },
    );
  } catch (e) {
    console.error('onAiTestsText error:', e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "❌ Xatolik yuz berdi.");
    clearState(ctx);
  }
}

// ─── IMAGE BASED AI TEST ───────────────────────────────────────
async function onAiTestsImage(ctx) {
  const photo = ctx.message.photo;
  if (!photo) {
    // Agar "auto" deb yozgan bo'lsa
    const text = ctx.message.text;
    if (text && text.toLowerCase() === 'auto') {
      await updateData(ctx, { ai_test_count: 'auto' });
      setState(ctx, States.ADMIN_AI_TESTS_IMAGE_WAIT);
      await ctx.reply(
        "🖼 <b>Rasmdan AI test</b>\n\nEndi test yaratish uchun rasm yuboring:",
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
      );
      return;
    }
    return ctx.reply("⚠️ Iltimos, rasm yuboring yoki 'auto' deb yozing.");
  }
  
  const data = await getData(ctx);
  let count = data.ai_test_count || 'auto';
  
  // Agar avval "auto" deb yozgan bo'lsa, endi rasmni qabul qilamiz
  if (!data.ai_test_count) {
    count = 'auto';
  }
  
  await updateData(ctx, { ai_test_count: count });
  setState(ctx, States.ADMIN_AI_TESTS_GENERATE);
  
  const status = await ctx.reply("⏳ <b>AI test yaratilmoqda...</b>", { parse_mode: 'HTML' });
  
  try {
    // Rasmni temporary faylga yuklab olish
    const fileLink = await ctx.telegram.getFileLink(photo[photo.length - 1].file_id);
    const filePath = require('path').join(require('os').tmpdir(), `ai_test_${ctx.from.id}_${Date.now()}.jpg`);
    
    const fs = require('fs');
    const https = require('https');
    
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      https.get(fileLink.href, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', reject);
    });
    
    const questions = await aiService.generateQuizFromImage(filePath, 'image/jpeg', count);
    
    // Temporary faylni o'chirish
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    if (!questions || !questions.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "❌ AI test yaratishda xatolik yuz berdi.");
      clearState(ctx);
      return;
    }
    
    await updateData(ctx, { ai_generated_questions: questions });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `✅ <b>AI test yaratildi!</b>\n\n📊 Savollar soni: <b>${questions.length} ta</b>\n\nNima qilamiz?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👁 Ko\'rib chiqish', 'ai_tests_preview')],
          [Markup.button.callback('💾 Saqlash', 'ai_tests_save')],
          [Markup.button.callback('🔄 Qayta yaratish', 'ai_tests_regenerate')],
          [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
        ]),
      },
    );
  } catch (e) {
    console.error('onAiTestsImage error:', e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "❌ Xatolik yuz berdi.");
    clearState(ctx);
  }
}

// ─── ADAPTIVE AI TEST ───────────────────────────────────────────
async function onAiTestsAdaptiveUser(ctx) {
  const text = ctx.message.text;
  if (!text || !/^\d+$/.test(text)) {
    return ctx.reply("⚠️ Iltimos, foydalanuvchi Telegram ID sini kiriting (faqat raqam).");
  }
  
  const userId = parseInt(text, 10);
  await updateData(ctx, { adaptive_user_id: userId });
  setState(ctx, States.ADMIN_AI_TESTS_ADAPTIVE_COUNT);
  
  await ctx.reply(
    `🔄 <b>Adaptiv AI test</b>\n\nFoydalanuvchi ID: <b>${userId}</b>\n\nTestdagi savollar sonini kiriting yoki "auto" deb yozing:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
  );
}

async function onAiTestsAdaptiveCount(ctx) {
  const text = ctx.message.text;
  let count = 'auto';
  if (text && text.toLowerCase() !== 'auto') {
    count = text.trim();
  }
  
  await updateData(ctx, { ai_test_count: count });
  setState(ctx, States.ADMIN_AI_TESTS_GENERATE);
  
  const data = await getData(ctx);
  const userId = data.adaptive_user_id;
  
  const status = await ctx.reply("⏳ <b>AI test yaratilmoqda...</b>", { parse_mode: 'HTML' });
  
  try {
    // Foydalanuvchi statistikasidan xatolarni olish
    const userStats = await dbService.getUserStats(userId);
    const mistakes = userStats?.mistakes || [];
    
    if (!mistakes.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
        `⚠️ <b>Foydalanuvchida hali xatolar yo'q</b>\n\nID: ${userId}\n\nAdaptiv test yaratish uchun avval foydalanuvchi test yechishi kerak.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
      );
      clearState(ctx);
      return;
    }
    
    const questions = await aiService.generateAdaptiveQuiz(data.subject, mistakes, count);
    if (!questions || !questions.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "❌ AI test yaratishda xatolik yuz berdi.");
      clearState(ctx);
      return;
    }
    
    await updateData(ctx, { ai_generated_questions: questions });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `✅ <b>Adaptiv AI test yaratildi!</b>\n\n📊 Savollar soni: <b>${questions.length} ta</b>\n\nNima qilamiz?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👁 Ko\'rib chiqish', 'ai_tests_preview')],
          [Markup.button.callback('💾 Saqlash', 'ai_tests_save')],
          [Markup.button.callback('🔄 Qayta yaratish', 'ai_tests_regenerate')],
          [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
        ]),
      },
    );
  } catch (e) {
    console.error('onAiTestsAdaptiveCount error:', e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "❌ Xatolik yuz berdi.");
    clearState(ctx);
  }
}

// ─── AI TESTS ACTIONS ──────────────────────────────────────────
async function cbAiTestsPreview(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const data = await getData(ctx);
  const questions = data.ai_generated_questions || [];
  
  if (!questions.length) {
    return ctx.answerCbQuery('❌ Hali savol yo\'q!', { show_alert: true }).catch(() => {});
  }
  
  const lines = questions.slice(0, 10).map((q, i) =>
    `<b>${i + 1}.</b> ${escapeHtml(q.question)}\n✅ ${escapeHtml(q.options[q.correct_index])}`,
  );
  let text = `👁 <b>AI Test Preview — ${questions.length} ta savol:</b>\n\n` + lines.join('\n\n');
  if (text.length > 4000) text = text.slice(0, 3900) + `\n\n<i>...va yana ${questions.length - 10} ta savol</i>`;
  
  await ctx.reply(text, { parse_mode: 'HTML' });
}

async function cbAiTestsSave(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const data = await getData(ctx);
  const questions = data.ai_generated_questions || [];
  const subject = data.subject;
  const type = data.ai_test_type;
  
  if (!questions.length || !subject) {
    return ctx.answerCbQuery('❌ Ma\'lumotlar yetishmaydi!', { show_alert: true }).catch(() => {});
  }
  
  try {
    // AI testlarni maxsus nom bilan saqlash
    const testId = Date.now(); // Vaqt belgisi orqali noyob ID
    const success = await dbService.saveOfficialTest(subject, testId, questions);
    
    if (!success) {
      return ctx.answerCbQuery("❌ Supabase'ga saqlashda xatolik.", { show_alert: true }).catch(() => {})     ;
    }
    
    await safeEdit(ctx,
      `✅ <b>AI test saqlandi!</b>\n\n` +
      `📚 Fan: <b>${escapeHtml(SUBJECTS[subject] || subject)}</b>\n` +
      `🏷 Turi: <b>${type === 'text' ? 'Matn asosida' : type === 'image' ? 'Rasmdan' : 'Adaptiv'}</b>\n` +
      `🔖 ID: <b>${testId}</b>\n` +
      `🔢 Savollar: <b>${questions.length} ta</b>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) },
    );
    clearState(ctx);
  } catch (e) {
    console.error('cbAiTestsSave error:', e.message);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi.', { show_alert: true }).catch(() => {});
  }
}

async function cbAiTestsRegenerate(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const data = await getData(ctx);
  const subject = data.subject;
  const type = data.ai_test_type;
  
  if (!subject || !type) {
    return ctx.answerCbQuery('❌ Ma\'lumotlar yetishmaydi!', { show_alert: true }).catch(() => {}).catch(() => {});
  }
  
  const status = await ctx.reply("⏳ <b>AI test qayta yaratilmoqda...</b>", { parse_mode: 'HTML' });
  
  try {
    let questions = null;
    const count = data.ai_test_count || 'auto';
    
    if (type === 'text') {
      questions = await aiService.generateQuizFromText(data.ai_test_text, count);
    } else if (type === 'image') {
      // Rasmni qayta yuklash kerak bo'ladi, shu sababli oddiygina xabar beramiz
      await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
        "⚠️ <b>Rasmni qayta yuklang</b>\n\nRasm asosida test qayta yaratish uchun rasmni qayta yuboring.",
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
      );
      return;
    } else if (type === 'adaptive') {
      const userStats = await dbService.getUserStats(data.adaptive_user_id);
      const mistakes = userStats?.mistakes || [];
      questions = await aiService.generateAdaptiveQuiz(subject, mistakes, count);
    }
    
    if (!questions || !questions.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "❌ AI test yaratishda xatolik yuz berdi.");
      return;
    }
    
    await updateData(ctx, { ai_generated_questions: questions });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      `✅ <b>AI test qayta yaratildi!</b>\n\n📊 Savollar soni: <b>${questions.length} ta</b>\n\nNima qilamiz?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('👁 Ko\'rib chiqish', 'ai_tests_preview')],
          [Markup.button.callback('💾 Saqlash', 'ai_tests_save')],
          [Markup.button.callback('🔄 Qayta yaratish', 'ai_tests_regenerate')],
          [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
        ]),
      },
    );
  } catch (e) {
    console.error('cbAiTestsRegenerate error:', e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, "❌ Xatolik yuz berdi.");
  }
}

// ─── HELPERS ───────────────────────────────────────────────────
function parseSuffix(data, prefix) {
  return data.startsWith(prefix) ? data.slice(prefix.length) : null;
}

// ─── REGISTER ──────────────────────────────────────────────────
function register(bot) {
  bot.action('admin_ai_tests', adminGuard(cbAdminAiTests));
  bot.action(/^ai_tests_subj_/, adminGuard(cbAiTestsSubj));
  bot.action(/^ai_tests_type_/, adminGuard(cbAiTestsType));
  bot.action('ai_tests_preview', adminGuard(cbAiTestsPreview));
  bot.action('ai_tests_save', adminGuard(cbAiTestsSave));
  bot.action('ai_tests_regenerate', adminGuard(cbAiTestsRegenerate));
  
  // Wire text handlers inside register to avoid modifying index.js
  bot.on('message', async (ctx, next) => {
    const state = getState(ctx);
    if (state === States.ADMIN_AI_TESTS_TEXT && ctx.message?.text && isAdmin(ctx.from?.id)) {
      return onAiTestsText(ctx);
    }
    if (state === States.ADMIN_AI_TESTS_IMAGE && ctx.message?.photo && isAdmin(ctx.from?.id)) {
      return onAiTestsImage(ctx);
    }
    if (state === States.ADMIN_AI_TESTS_IMAGE_WAIT && ctx.message?.photo && isAdmin(ctx.from?.id)) {
      return onAiTestsImage(ctx);
    }
    if (state === States.ADMIN_AI_TESTS_ADAPTIVE_USER && ctx.message?.text && isAdmin(ctx.from?.id)) {
      return onAiTestsAdaptiveUser(ctx);
    }
    if (state === States.ADMIN_AI_TESTS_ADAPTIVE_COUNT && ctx.message?.text && isAdmin(ctx.from?.id)) {
      return onAiTestsAdaptiveCount(ctx);
    }
    return next();
  });
}

module.exports = {
  register,
  cbAdminAiTests,
  cbAiTestsSubj,
  cbAiTestsType,
  onAiTestsText,
  onAiTestsImage,
  onAiTestsAdaptiveUser,
  onAiTestsAdaptiveCount,
  cbAiTestsPreview,
  cbAiTestsSave,
  cbAiTestsRegenerate,
};