'use strict';

const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');
const dbService = require('../services/dbService');
const edupageService = require('../services/edupageService');
const { escapeHtml, States, setState, clearState, safeAnswerCb, safeEdit } = require('../core/utils');

let VALID_GROUPS = [];
try {
  const rawGroups = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/groups.json'), 'utf8'));

  VALID_GROUPS = rawGroups.filter(g => {
    if (!g) return false;
    const cleanG = g.trim().toUpperCase();
    return cleanG !== '-' &&
           cleanG !== '--' &&
           cleanG !== '(RUS)' &&
           !cleanG.includes('FAKULTET') &&
           !cleanG.includes('KURS');
  });
} catch {
  console.error('⚠️ groups.json topilmadi. Qidiruv ishlamasligi mumkin.');
}

function normalize(str) {
  return str.toUpperCase().replace(/[^A-Z0-9*]/g, '');
}

function getLevenshteinDistance(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1] ? matrix[i - 1][j - 1] : Math.min(matrix[i - 1][j - 1], matrix[i][j - 1], matrix[i - 1][j]) + 1;
    }
  }
  return matrix[b.length][a.length];
}

async function getAvailableGroups() {
  try {
    const liveGroups = await edupageService.getAllClassNames();
    if (liveGroups && liveGroups.length > 0) return liveGroups;
  } catch {
    // fallback
  }
  return VALID_GROUPS;
}

function findBestMatch(input, groups = VALID_GROUPS) {
  const canonical = edupageService.getCanonicalGroupName(input);
  if (canonical) return canonical;

  const ni = normalize(input);
  if (!ni) return null;
  let best = null;
  let minDist = Infinity;
  for (const group of groups) {
    const ng = normalize(group);
    if (ni === ng) return group;
    const d = getLevenshteinDistance(ni, ng);
    if (d < minDist) {
      minDist = d;
      best = group;
    }
  }
  return minDist <= 2 ? best : null;
}

async function promptSetClass(ctx) {
  await safeAnswerCb(ctx);
  setState(ctx, States.SET_CLASS);

  const text = `⚙️ <b>Guruhni sozlash</b>\n\nIltimos, guruhingiz nomini yozing:\n\n💡 <i>Masalan: <code>MI-15</code>, <code>BHA-51k</code> yoki <code>MNP-80</code></i>\n\nOddiygina guruh nomini shu chatga yuboring 👇`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('❌ Bekor qilish', 'cancel_set_class')],
  ]);

  if (ctx.callbackQuery) {
    await safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...kb });
  }
}

async function onSetClassInput(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const rawText = (ctx.message?.text || '').trim();
  if (rawText.toLowerCase() === 'bekor qilish' || rawText === '/cancel') {
    clearState(ctx);
    return ctx.reply('❌ Guruhni sozlash bekor qilindi.', {
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Asosiy Menyu', callback_data: 'back_to_main' }]]
      }
    });
  }

  // Handle if user wrote /setclass MI-15 or just MI-15
  let cleanInput = rawText;
  if (cleanInput.toLowerCase().startsWith('/setclass')) {
    cleanInput = cleanInput.replace(/^\/setclass\s*/i, '').trim();
  }
  cleanInput = cleanInput.replace(/^[*#]/, '').trim();

  if (!cleanInput) {
    return ctx.reply('⚠️ Guruh nomi kiritilmadi.\n\nIltimos, guruhingiz nomini yozing (Masalan: <code>MI-15</code>):', { parse_mode: 'HTML' });
  }

  if (cleanInput.length > 50) {
    return ctx.reply('⚠️ Guruh nomi juda uzun (maksimal 50 ta belgi). Qaytadan kiriting:', { parse_mode: 'HTML' });
  }

  const groups = await getAvailableGroups();
  const matchedGroup = edupageService.getCanonicalGroupName(cleanInput) || findBestMatch(cleanInput, groups);

  if (!matchedGroup) {
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback('❌ Bekor qilish', 'cancel_set_class')],
    ]);
    return ctx.reply(
      `❌ "<b>${escapeHtml(cleanInput)}</b>" nomli guruh topilmadi.\n\n💡 Iltimos, guruh nomini to'g'ri yozganingizga ishonch hosil qilib qayta yuboring (Masalan: <code>MI-15</code> yoki <code>BHA-51k/24</code>):`,
      { parse_mode: 'HTML', ...kb }
    );
  }

  clearState(ctx);
  const isCorrected = (cleanInput.toUpperCase() !== matchedGroup.toUpperCase());
  const success = await dbService.updateUserClass(userId, matchedGroup);

  if (success) {
    const cleanGroup = escapeHtml(matchedGroup);
    const msg = isCorrected ? `✅ Guruhingiz aniqlandi va saqlandi: <b>${cleanGroup}</b>` : `✅ Guruhingiz saqlandi: <b>${cleanGroup}</b>`;
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('📅 Bugungi jadval', 'schedule_today'),
        Markup.button.callback('🖼 Haftalik jadval', 'schedule_week'),
      ],
      [
        Markup.button.callback('🏢 Bo\'sh xonalar', 'schedule_rooms'),
        Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'),
      ],
    ]);
    await ctx.reply(`${msg}\n\nEndi dars jadvalingizni bir zumda ko'rishingiz mumkin! 👇`, { parse_mode: 'HTML', ...kb });
  } else {
    await ctx.reply('⚠️ Saqlashda xatolik yuz berdi. Iltimos, bir ozdan so\'ng qaytadan urinib ko\'ring.');
  }
}

async function cbCancelSetClass(ctx) {
  clearState(ctx);
  await safeAnswerCb(ctx, 'Bekor qilindi');
  const scheduleHandler = require('./scheduleHandler');
  return scheduleHandler.cmdTimetable(ctx);
}

async function cmdSetClass(ctx) {
  clearState(ctx);
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = (ctx.message?.text || '').trim();
  const userInput = text.substring(text.indexOf(' ') + 1).trim();

  if (!userInput || userInput === text) {
    return promptSetClass(ctx);
  }

  // Length limit guard to prevent ReDoS / CPU starvation
  if (userInput.length > 50) {
    return ctx.reply('⚠️ Guruh nomi juda uzun (maksimal 50 ta belgi).', { parse_mode: 'HTML' });
  }

  const cleanInput = userInput.replace(/^[*#]/, '').trim();
  const groups = await getAvailableGroups();
  const matchedGroup = edupageService.getCanonicalGroupName(cleanInput) || findBestMatch(cleanInput, groups);

  if (!matchedGroup) {
    return ctx.reply(`❌ "<b>${escapeHtml(userInput)}</b>" nomli guruh topilmadi.\n\n💡 Guruh nomini to'g'ri yozganingizga ishonch hosil qiling. Masalan: <code>/setclass MNP-900/26</code> yoki <code>/setclass MI-15</code>`, { parse_mode: 'HTML' });
  }

  const isCorrected = (cleanInput.toUpperCase() !== matchedGroup.toUpperCase());
  const success = await dbService.updateUserClass(userId, matchedGroup);

  if (success) {
    const cleanGroup = escapeHtml(matchedGroup);
    const msg = isCorrected ? `✅ Guruhingiz aniqlandi va saqlandi: <b>${cleanGroup}</b>` : `✅ Guruhingiz saqlandi: <b>${cleanGroup}</b>`;
    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('📅 Bugungi jadval', 'schedule_today'),
        Markup.button.callback('🖼 Haftalik jadval', 'schedule_week'),
      ],
      [
        Markup.button.callback('🏢 Bo\'sh xonalar', 'schedule_rooms'),
        Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'),
      ],
    ]);
    await ctx.reply(`${msg}\n\nEndi dars jadvalingizni bir zumda ko'rishingiz mumkin! 👇`, { parse_mode: 'HTML', ...kb });
  } else {
    await ctx.reply('⚠️ Saqlashda xatolik yuz berdi. Iltimos, bir ozdan so\'ng qaytadan urinib ko\'ring.');
  }
}

async function cbProfile(ctx) {
  const statsHandlers = require('./statsHandlers');
  return statsHandlers.cbStatsMenu(ctx);
}

function register(bot) {
  bot.command('setclass', cmdSetClass);
  bot.command('profile', cbProfile);
  bot.action('prompt_set_class', promptSetClass);
  bot.action('cancel_set_class', cbCancelSetClass);
}

module.exports = {
  register,
  cbProfile,
  cmdProfile: cbProfile,
  cmdSetClass,
  promptSetClass,
  onSetClassInput,
  cbCancelSetClass,
};