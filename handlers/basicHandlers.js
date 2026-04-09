'use strict';
const fs = require('fs');
const path = require('path');
const { Markup } = require('telegraf');
const statsManager = require('../statsManager');
const { getMainKeyboard } = require('../keyboards');
const {
  activeTests, waitingRooms, pollChatMap,
  userNameCache, States, clearState,
  safeEdit, backToMainKb,
} = require('../utils');
// IMPORTLAR YANGILANDI:
const { getFormattedSchedule, getEmptyRoomsText, getRawSchedule } = require('../edupageApi');
const { generateScheduleImage } = require('../scheduleImage');

// Sahifalash uchun vaqtinchalik xotira
const roomsPaginationCache = new Map();

// ─── Guruhlar ro'yxatini yuklash ──────────────────────────────────────────────
let VALID_GROUPS = [];
try {
  const rawGroups = JSON.parse(fs.readFileSync(path.join(__dirname, '../groups.json'), 'utf8'));
  VALID_GROUPS = rawGroups.filter(g =>
    g && g !== '-' &&
    !g.toUpperCase().includes('FAKULTET') &&
    !g.toUpperCase().includes('KURS')
  );
  console.log(`✅ ${VALID_GROUPS.length} ta haqiqiy guruh yuklandi.`);
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
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1], matrix[i][j - 1], matrix[i - 1][j]) + 1;
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

// ─── Komandalar ───────────────────────────────────────────────────────────────

async function cmdStart(ctx) {
  clearState(ctx);
  const chatId = ctx.chat.id;

  await statsManager.registerUser(
    ctx.from.id,
    ctx.from.first_name
      ? `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}`
      : 'Foydalanuvchi',
    ctx.from.username,
  );
  userNameCache.set(
    ctx.from.id,
    ctx.from.first_name
      ? `${ctx.from.first_name}${ctx.from.last_name ? ' ' + ctx.from.last_name : ''}`
      : 'Foydalanuvchi',
  );

  let cleared = false;
  if (waitingRooms.has(chatId)) { waitingRooms.delete(chatId); cleared = true; }
  if (activeTests.has(chatId)) {
    const sess = activeTests.get(chatId);
    if (sess.timerTask) clearTimeout(sess.timerTask);
    if (sess.pollId) pollChatMap.delete(sess.pollId);
    activeTests.delete(chatId);
    cleared = true;
  }
  if (cleared) await ctx.reply('🔄 Tugallanmagan test tozalandi. Yangi boshlashingiz mumkin!');

  const args = (ctx.message.text || '').split(' ');
  if (args.length > 1) {
    const param = args[1];
    if (param.startsWith('s_')) {
      const testData = await statsManager.getUserTest(param.slice(2));
      if (!testData) {
        return ctx.reply(
          '❌ Bu fan topilmadi yoki egasi tomonidan o\'chirilgan.\n\nAsosiy menyuga qaytish uchun /start bosing.',
          backToMainKb(),
        );
      }
      const { showUgcSubjectBlocks } = require('./quizGame');
      return showUgcSubjectBlocks(ctx, testData.creator_id, testData.subject);
    }
    if (param.startsWith('t_')) {
      const testData = await statsManager.getUserTest(param.slice(2));
      if (testData) {
        const { startUgcTest } = require('./quizGame');
        return startUgcTest(ctx, testData);
      }
      return ctx.reply(
        '❌ Bu blok topilmadi yoki egasi tomonidan o\'chirilgan.\n\nAsosiy menyuga qaytish uchun /start bosing.',
        backToMainKb(),
      );
    }
  }

  const firstName = ctx.from.first_name || 'Talaba';
  await ctx.reply(
    `👋 Assalomu alaykum, <b>${firstName}</b>!\n\n` +
    `🏛 <b>Talabalar Imtihon Trenajyori</b>ga xush kelibsiz!\n\n` +
    `📌 Nima qilishingiz mumkin:\n` +
    `• 📚 Rasmiy testlar — Admin tomonidan tayyorlangan bloklar\n` +
    `• 📝 Test yaratish — O'z testingizni tuzing va ulashing\n` +
    `• 📊 Statistika — Natijalaringizni kuzating\n` +
    `• 🏆 Reyting — Top 10 talabalar\n\n` +
    `⬇️ Kerakli bo'limni tanlang:`,
    { parse_mode: 'HTML', ...getMainKeyboard() },
  );
}

async function cbBackToMain(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  await safeEdit(
    ctx,
    '🏛 <b>Talabalar Imtihon Trenajyori</b>\n\nKerakli bo\'limni tanlang:',
    { parse_mode: 'HTML', ...getMainKeyboard() },
  );
}

async function cmdStop(ctx) {
  clearState(ctx);
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (waitingRooms.has(chatId)) {
    const room = waitingRooms.get(chatId);
    if (userId === room.initiatorId || ctx.chat.type === 'private') {
      waitingRooms.delete(chatId);
      return ctx.reply('🛑 Test bekor qilindi.', backToMainKb());
    }
    return ctx.reply('⚠️ Faqat testni boshlagan kishi bekor qila oladi!');
  }

  if (activeTests.has(chatId)) {
    const session = activeTests.get(chatId);
    if (ctx.chat.type !== 'private' && userId !== session.initiatorId) {
      return ctx.reply('⚠️ Faqat testni boshlagan kishi to\'xtatа oladi!');
    }
    await ctx.reply('🛑 <b>Test to\'xtatildi!</b>\nNatijalar hisoblanmoqda...', { parse_mode: 'HTML' });
    const { finishTest } = require('./quizGame');
    return finishTest(chatId, ctx.telegram);
  }

  await ctx.reply(
    'ℹ️ Hozir faol test yo\'q.\n\nAsosiy menyuga qaytish uchun tugmani bosing:',
    backToMainKb(),
  );
}

async function cmdMenu(ctx) {
  clearState(ctx);
  await ctx.reply('🏛 <b>Asosiy Menyu</b>', { parse_mode: 'HTML', ...getMainKeyboard() });
}

async function cmdSetClass(ctx) {
  const text = (ctx.message.text || '').trim();
  const userInput = text.substring(text.indexOf(' ') + 1).trim();

  if (!userInput || userInput === text) {
    return ctx.reply(
      '⚠️ Iltimos, guruh nomini komanda bilan birga kiriting:\n\n' +
      '👉 <code>/setclass MNP-80</code>\n' +
      '👉 <code>/setclass MO-81/25</code>\n' +
      '👉 <code>/setclass *3</code>',
      { parse_mode: 'HTML' },
    );
  }

  const matchedGroup = findBestMatch(userInput);

  if (!matchedGroup) {
    return ctx.reply(
      `❌ Kechirasiz, "<b>${userInput}</b>" guruhini topa olmadim.\nIltimos, guruh nomini tekshirib qayta yozing.`,
      { parse_mode: 'HTML' },
    );
  }

  const isCorrected = normalize(userInput) !== normalize(matchedGroup);
  const success = await statsManager.updateUserClass(ctx.from.id, matchedGroup);

  if (success) {
    const msg = isCorrected
      ? `✅ Yozuvdagi xatolik avtomatik to'g'rilandi va guruhingiz saqlandi: <b>${matchedGroup}</b>`
      : `✅ Guruhingiz muvaffaqiyatli saqlandi: <b>${matchedGroup}</b>`;
    await ctx.reply(
      msg + '\nEndi bot orqali jadvallarni to\'g\'ridan-to\'g\'ri ko\'rishingiz mumkin.',
      { parse_mode: 'HTML' },
    );
  } else {
    await ctx.reply("❌ Xatolik yuz berdi. Iltimos keyinroq urinib ko'ring.");
  }
}

async function cmdJadval(ctx) {
  const className = await statsManager.getUserClass(ctx.from.id);

  if (!className) {
    return ctx.reply(
      '⚠️ Avval guruhingizni saqlashingiz kerak!\n\n' +
      'Iltimos, botga guruhingizni yuboring:\n' +
      '👉 <code>/setclass MI-21</code>',
      { parse_mode: 'HTML' },
    );
  }

  const msg = await ctx.reply('⏳ Dars jadvali olinmoqda...');

  const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  const dayOfWeek = (date.getDay() + 6) % 7;

  const scheduleText = await getFormattedSchedule(className, dayOfWeek < 6 ? dayOfWeek : 0);

  await ctx.telegram.editMessageText(
    ctx.chat.id, msg.message_id, undefined,
    `🎓 <b>Guruh: ${className}</b>\n\n${scheduleText}\n\n<i>Barcha kunlarni ko'rish uchun /hafta bosing</i>`,
    { parse_mode: 'HTML' },
  );
}

// BU YER TO'LIQ RASMLI JADVAL YUBORISHGA O'ZGARTIRILDI
async function cmdHafta(ctx) {
  const className = await statsManager.getUserClass(ctx.from.id);
  if (!className) return ctx.reply('⚠️ Avval <code>/setclass</code> komandasidan foydalaning.', { parse_mode: 'HTML' });

  const msg = await ctx.reply('⏳ Haftalik dars jadvali rasmga olinmoqda. Iltimos kuting...');

  try {
    const schedule = await getRawSchedule(className);
    if (!schedule || Object.keys(schedule).length === 0) {
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, '📭 Ushbu guruh uchun jadval topilmadi.');
      return;
    }

    const imageBuffer = await generateScheduleImage(className, schedule);

    await ctx.replyWithPhoto(
      { source: imageBuffer },
      { 
        caption: `🎓 <b>Haftalik Jadval: ${className}</b>\n\n📌 <i>Siz ham o'z jadvalingizni bilishni istasangiz, botdan foydalaning.</i>`, 
        parse_mode: 'HTML' 
      }
    );
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id);

  } catch (error) {
    console.error('Rasm yasashda xatolik:', error);
    await ctx.telegram.editMessageText(
      ctx.chat.id, 
      msg.message_id, 
      undefined, 
      '❌ Jadval rasmini tayyorlashda texnik xatolik yuz berdi. Iltimos keyinroq urinib ko\'ring.'
    );
  }
}

// ─── Bo'sh xonalar ────────────────────────────────────────────────────────────

const PARA_KB = Markup.inlineKeyboard([
  [Markup.button.callback('1-para  08:30–09:50', 'bosh_1'), Markup.button.callback('2-para  10:00–11:20', 'bosh_2')],
  [Markup.button.callback('3-para  11:30–12:50', 'bosh_3'), Markup.button.callback('4-para  13:30–14:50', 'bosh_4')],
  [Markup.button.callback('5-para  15:00–16:20', 'bosh_5'), Markup.button.callback('6-para  16:30–17:50', 'bosh_6')],
]);

async function cmdXonalar(ctx) {
  await ctx.reply('🏢 Qaysi para uchun bo\'sh xonalarni ko\'rmoqchisiz?', PARA_KB);
}

async function cbBoshXona(ctx) {
  await ctx.answerCbQuery();
  const periodNum = parseInt(ctx.callbackQuery.data.split('_')[1]);

  const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  let dayIdx = (tzDate.getDay() + 6) % 7;
  let offsetDays = 0;

  if (dayIdx === 6) { offsetDays = 1; dayIdx = 0; }
  else {
    const nowMins = tzDate.getHours() * 60 + tzDate.getMinutes();
    const periodEnd = { 1: 590, 2: 680, 3: 770, 4: 890, 5: 980, 6: 1070 };
    if (nowMins > (periodEnd[periodNum] ?? 1440)) {
      offsetDays = 1;
      dayIdx = (dayIdx + 1) % 7;
      if (dayIdx === 6) { offsetDays = 2; dayIdx = 0; }
    }
  }

  const DAY_NAMES_LOCAL = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
  await ctx.editMessageText(
    `⏳ <b>${DAY_NAMES_LOCAL[dayIdx]}</b> kungi <b>${periodNum}-para</b> uchun bo'sh xonalar qidirilmoqda...`,
    { parse_mode: 'HTML' },
  );

  const className = await statsManager.getUserClass(ctx.from.id) || '*3';
  const pages = await getEmptyRoomsText(className, dayIdx, periodNum, offsetDays);

  roomsPaginationCache.set(ctx.from.id, pages);

  await ctx.editMessageText(pages[0], {
    parse_mode: 'HTML',
    ...buildRoomPageKb(0, pages.length),
  });
}

async function cbRoomPage(ctx) {
  await ctx.answerCbQuery();
  const targetPage = parseInt(ctx.callbackQuery.data.split('_')[1]);
  const pages = roomsPaginationCache.get(ctx.from.id);

  if (!pages?.[targetPage]) {
    return ctx.reply("⚠️ Ma'lumot eskirgan, iltimos /xonalar komandasini qaytadan yozing.");
  }

  await ctx.editMessageText(pages[targetPage], {
    parse_mode: 'HTML',
    ...buildRoomPageKb(targetPage, pages.length),
  });
}

function buildRoomPageKb(current, total) {
  const nav = [];
  if (current > 0) nav.push(Markup.button.callback('⬅️ Oldingi', `roompage_${current - 1}`));
  if (total > 1) nav.push(Markup.button.callback(`${current + 1} / ${total}`, 'ignore'));
  if (current < total - 1) nav.push(Markup.button.callback('Keyingi ➡️', `roompage_${current + 1}`));

  const rows = [];
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('🔙 Orqaga', 'back_to_rooms_menu')]);
  return Markup.inlineKeyboard(rows);
}

async function cbBackToRoomsMenu(ctx) {
  await ctx.answerCbQuery();
  await ctx.editMessageText('🏢 Qaysi para uchun bo\'sh xonalarni ko\'rmoqchisiz?', PARA_KB);
}

// ─── Ro'yxatdan o'tish ────────────────────────────────────────────────────────

function register(bot) {
  bot.start(cmdStart);
  bot.command('stop', cmdStop);
  bot.command('menu', cmdMenu);
  bot.command('setclass', cmdSetClass);
  bot.command('jadval', cmdJadval);
  bot.command('hafta', cmdHafta);
  bot.command('xonalar', cmdXonalar);
  bot.action('back_to_main', cbBackToMain);
  bot.action('ignore', ctx => ctx.answerCbQuery());
  bot.action(/^bosh_/, cbBoshXona);
  bot.action('back_to_rooms_menu', cbBackToRoomsMenu);
  bot.action(/^roompage_/, cbRoomPage);
}

module.exports = { register };