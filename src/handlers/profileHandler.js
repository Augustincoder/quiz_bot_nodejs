'use strict';

const fs = require('fs');
const path = require('path');
const dbService = require('../services/dbService');
const edupageService = require('../services/edupageService');
const { escapeHtml } = require('../core/utils');

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

async function cmdSetClass(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const text = (ctx.message?.text || '').trim();
  const userInput = text.substring(text.indexOf(' ') + 1).trim();

  if (!userInput || userInput === text) {
    return ctx.reply('⚠️ Guruh nomi kiritilmadi.\n\n👉 Namuna: <code>/setclass MNP-80</code>\n\n💡 <i>O\'z guruhingiz nomini aniq ko\'rsating.</i>', { parse_mode: 'HTML' });
  }

  // Length limit guard to prevent ReDoS / CPU starvation
  if (userInput.length > 50) {
    return ctx.reply('⚠️ Guruh nomi juda uzun (maksimal 50 ta belgi).', { parse_mode: 'HTML' });
  }

  const groups = await getAvailableGroups();
  const matchedGroup = userInput.startsWith('*') ? userInput : findBestMatch(userInput, groups);

  if (!matchedGroup) {
    return ctx.reply(`❌ "<b>${escapeHtml(userInput)}</b>" nomli guruh topilmadi.\n\n💡 Guruh nomini to'g'ri yozganingizga ishonch hosil qiling. Masalan: <code>/setclass MNP-900/26</code> yoki <code>/setclass MI-15</code>`, { parse_mode: 'HTML' });
  }

  const isCorrected = !userInput.startsWith('*') && (normalize(userInput) !== normalize(matchedGroup));
  const success = await dbService.updateUserClass(userId, matchedGroup);

  if (success) {
    const cleanGroup = escapeHtml(matchedGroup);
    const msg = isCorrected ? `✅ Yozuvdagi xatolik to'g'rilandi va saqlandi: <b>${cleanGroup}</b>` : `✅ Guruhingiz saqlandi: <b>${cleanGroup}</b>`;
    await ctx.reply(msg + '\nEndi dars jadvalingizni ko\'rishingiz mumkin. /jadval yoki /hafta ni bosing.', { parse_mode: 'HTML' });
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
}

module.exports = { register, cbProfile, cmdProfile: cbProfile, cmdSetClass };