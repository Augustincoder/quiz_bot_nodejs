'use strict';

const fs = require('fs');
const path = require('path');
const dbService = require('../services/dbService');

let VALID_GROUPS = [];
try {
  const rawGroups = JSON.parse(fs.readFileSync(path.join(__dirname, '../../groups.json'), 'utf8'));
  VALID_GROUPS = rawGroups.filter(g => g && g !== '-' && !g.toUpperCase().includes('FAKULTET') && !g.toUpperCase().includes('KURS'));
} catch {
  console.error('⚠️ groups.json topilmadi. Qidiruv ishlamasligi mumkin.');
}

function normalize(str) { return str.toUpperCase().replace(/[^A-Z0-9*]/g, ''); }

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

function findBestMatch(input) {
  const ni = normalize(input);
  if (!ni) return null;
  let best = null;
  let minDist = Infinity;
  for (const group of VALID_GROUPS) {
    const ng = normalize(group);
    if (ni === ng) return group;
    const d = getLevenshteinDistance(ni, ng);
    if (d < minDist) { minDist = d; best = group; }
  }
  return minDist <= 2 ? best : null;
}

async function cmdSetClass(ctx) {
  const text = (ctx.message.text || '').trim();
  const userInput = text.substring(text.indexOf(' ') + 1).trim();

  if (!userInput || userInput === text) {
    return ctx.reply('⚠️ Guruh nomi kiritilmadi.\n\n👉 Namuna: <code>/setclass MNP-80</code>\n\n💡 <i>O\'z guruhingiz nomini aniq ko\'rsating.</i>', { parse_mode: 'HTML' });
  }

  let matchedGroup = userInput.startsWith('*') ? userInput : findBestMatch(userInput);

  if (!matchedGroup) return ctx.reply(`❌ \"<b>${userInput}</b>\" nomli guruh topilmadi.\n\n💡 Guruh nomini to'g'ri yozganingizga ishonch hosil qiling. Masalan: <code>/setclass MI-21</code>`, { parse_mode: 'HTML' });

  const isCorrected = !userInput.startsWith('*') && (normalize(userInput) !== normalize(matchedGroup));
  const success = await dbService.updateUserClass(ctx.from.id, matchedGroup);

  if (success) {
    const msg = isCorrected ? `✅ Yozuvdagi xatolik to'g'rilandi va saqlandi: <b>${matchedGroup}</b>` : `✅ Guruhingiz saqlandi: <b>${matchedGroup}</b>`;
    await ctx.reply(msg + '\nEndi jadvallarni ko\'rishingiz mumkin. /hafta ni bosing.', { parse_mode: 'HTML' });
  } else {
    await ctx.reply("⚠️ Saqlashda xatolik yuz berdi. Iltimos, bir ozdan so'ng qaytadan urinib ko'ring.");
  }
}

function register(bot) { bot.command('setclass', cmdSetClass); }

module.exports = { register };