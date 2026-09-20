'use strict';

const { Markup } = require('telegraf');
const dbService = require('../services/dbService');
const scheduleService = require('../services/scheduleService');
const { getTimetableKeyboard, getTimetableInlineKeyboard } = require('../keyboards/keyboards');
const { TTLMap } = require('../core/utils');
const logger = require('../core/logger');

const roomsPaginationCache = new TTLMap(5 * 60 * 1000); // 5-minute TTL

const DAY_SHORT_NAMES = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];

const BINOLAR = [
  { id: 'all', label: '🏛 Barchasi' },
  { id: 'asosiy', label: '🏛 Asosiy' },
  { id: '1', label: '1-bino' },
  { id: '2', label: '2-bino' },
  { id: '3', label: '3-bino' },
  { id: '4', label: '4-bino' },
];

const PARA_KB = Markup.inlineKeyboard([
  [Markup.button.callback('1-para  08:30–09:50', 'bosh_1'), Markup.button.callback('2-para  10:00–11:20', 'bosh_2')],
  [Markup.button.callback('3-para  11:30–12:50', 'bosh_3'), Markup.button.callback('4-para  13:30–14:50', 'bosh_4')],
  [Markup.button.callback('5-para  15:00–16:20', 'bosh_5'), Markup.button.callback('6-para  16:30–17:50', 'bosh_6')],
  [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
]);

/**
 * Builds interactive 6-day timetable pager inline keyboard
 */
function buildSchedulePagerKeyboard(dayIdx) {
  const prevDay = (dayIdx - 1 + 6) % 6;
  const nextDay = (dayIdx + 1) % 6;

  // Row 1: Fast Navigation
  const navRow = [
    Markup.button.callback('◀️ Oldingi', `sched_day_${prevDay}`),
    Markup.button.callback('📅 Bugun', 'sched_day_today'),
    Markup.button.callback('Keyingi ▶️', `sched_day_${nextDay}`),
  ];

  // Row 2: 6 Days Direct Jump
  const daysRow = DAY_SHORT_NAMES.map((name, idx) => {
    const label = idx === dayIdx ? `• ${name} •` : name;
    return Markup.button.callback(label, `sched_day_${idx}`);
  });

  // Row 3: Action Shortcuts
  const actionRow = [
    Markup.button.callback('🖼 Haftalik rasm', 'schedule_week'),
    Markup.button.callback('🏢 Bo\'sh xonalar', 'schedule_rooms'),
  ];

  // Row 4: Back to menu
  const menuRow = [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')];

  return Markup.inlineKeyboard([navRow, daysRow, actionRow, menuRow]);
}

/**
 * Builds empty rooms keyboard with building filters and pagination
 */
function buildRoomPageKb(periodNum, currentBino, currentPage, totalPages) {
  // Row 1 & 2: Building Filters
  const binoBtns = BINOLAR.map(b => {
    const isActive = b.id === currentBino;
    const label = isActive ? `• ${b.label} •` : b.label;
    return Markup.button.callback(label, `rm_${periodNum}_${b.id}_0`);
  });

  const row1 = binoBtns.slice(0, 3);
  const row2 = binoBtns.slice(3, 6);
  const rows = [row1, row2];

  // Row 3: Pagination if needed
  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 0) {
      nav.push(Markup.button.callback('⬅️ Oldingi', `rm_${periodNum}_${currentBino}_${currentPage - 1}`));
    }
    nav.push(Markup.button.callback(`${currentPage + 1} / ${totalPages}`, 'ignore'));
    if (currentPage < totalPages - 1) {
      nav.push(Markup.button.callback('Keyingi ➡️', `rm_${periodNum}_${currentBino}_${currentPage + 1}`));
    }
    rows.push(nav);
  }

  // Row 4: Controls
  rows.push([
    Markup.button.callback('🔄 Boshqa para', 'back_to_rooms_menu'),
    Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'),
  ]);

  return Markup.inlineKeyboard(rows);
}

async function cmdJadval(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const className = await dbService.getUserClass(ctx.from.id);
  if (!className) {
    return ctx.reply('⚠️ Avval guruhingizni saqlashingiz kerak!\n\n👉 <code>/setclass MI-21</code>', { parse_mode: 'HTML' });
  }

  const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  let dayOfWeek = (tzDate.getDay() + 6) % 7;
  if (dayOfWeek === 6) dayOfWeek = 0; // Sunday defaults to Monday

  try {
    const scheduleText = await scheduleService.fetchTodaySchedule(className, dayOfWeek);
    const text = `🎓 <b>Guruh: ${className}</b>\n\n${scheduleText}`;
    const kb = buildSchedulePagerKeyboard(dayOfWeek);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...kb });
    }
  } catch (err) {
    logger.error('cmdJadval error', { error: err.message });
    await ctx.reply('⚠️ Jadval yuklanmadi. Iltimos birozdan so\'ng qayta urinib ko\'ring.');
  }
}

async function cbScheduleDay(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const className = await dbService.getUserClass(ctx.from.id);
  if (!className) {
    return ctx.reply('⚠️ Avval guruhingizni saqlashingiz kerak!\n\n👉 <code>/setclass MI-21</code>', { parse_mode: 'HTML' });
  }

  const data = ctx.callbackQuery.data;
  let targetDay;
  if (data === 'sched_day_today') {
    const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
    targetDay = (tzDate.getDay() + 6) % 7;
    if (targetDay === 6) targetDay = 0;
  } else {
    targetDay = parseInt(data.replace('sched_day_', ''), 10);
  }

  if (Number.isNaN(targetDay) || targetDay < 0 || targetDay > 5) targetDay = 0;

  try {
    const scheduleText = await scheduleService.fetchTodaySchedule(className, targetDay);
    const text = `🎓 <b>Guruh: ${className}</b>\n\n${scheduleText}`;
    const kb = buildSchedulePagerKeyboard(targetDay);
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    if (!err?.message?.includes('message is not modified')) {
      logger.error('cbScheduleDay error', { error: err?.message });
    }
  }
}

async function cmdHafta(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const className = await dbService.getUserClass(ctx.from.id);
  if (!className) {
    return ctx.reply('⚠️ Avval <code>/setclass</code> komandasidan foydalaning (Masalan: <code>/setclass MI-21</code>).', { parse_mode: 'HTML' });
  }

  const msg = await ctx.reply('⏳ Haftalik dars jadvali rasmga olinmoqda. Iltimos kuting...');
  try {
    const imageBuffer = await scheduleService.fetchWeeklyScheduleImage(className);
    if (!imageBuffer) {
      return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, '📭 Ushbu guruh uchun jadval topilmadi.');
    }
    await ctx.replyWithPhoto({ source: imageBuffer }, { caption: `🎓 <b>Haftalik Jadval: ${className}</b>`, parse_mode: 'HTML' });
    await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
  } catch {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      '⚠️ Jadval yuklanmadi.\n\nIltimos, bir ozdan so\'ng qaytadan urinib ko\'ring. Bugungi jadval uchun /jadval buyrug\'idan foydalaning.',
      Markup.inlineKeyboard([[Markup.button.callback('🔄 Qayta urinish', 'retry_hafta')]])
    );
  }
}

async function cmdTimetable(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const className = await dbService.getUserClass(ctx.from.id);
  const status = className ? `✅ Sizning guruhingiz: <b>${className}</b>` : '⚠️ <b>Guruh tanlanmagan.</b>';
  const text = `🎓 <b>Dars jadvali bo'limi</b>\n\n${status}\n\nQuyidagi menyudan kerakli bo'limni tanlang:`;

  if (ctx.callbackQuery) {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...getTimetableInlineKeyboard(),
    });
  } else {
    await ctx.reply(text, {
      parse_mode: 'HTML',
      ...getTimetableKeyboard(),
    });
  }
}

async function cmdTimetableHelp(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('⚙️ <b>Guruhni qanday sozlash mumkin?</b>\n\n👉 <code>/setclass MNP-81</code>\n\n💡 Guruhingiz nomini aniq yozing, shunda bot har kuni jadvalingizni eslatib turadi.', { parse_mode: 'HTML' });
}

async function cmdXonalar(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('🏢 Qaysi para uchun bo\'sh xonalarni ko\'rmoqchisiz?', PARA_KB);
}

async function renderRoomView(ctx, periodNum, binoId, pageIdx) {
  const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  let dayIdx = (tzDate.getDay() + 6) % 7;
  let offsetDays = 0;

  if (dayIdx === 6) {
    offsetDays = 1;
    dayIdx = 0;
  } else {
    const nowMins = tzDate.getHours() * 60 + tzDate.getMinutes();
    const periodEnd = { 1: 590, 2: 680, 3: 770, 4: 890, 5: 980, 6: 1070 };
    if (nowMins > (periodEnd[periodNum] ?? 1440)) {
      offsetDays = 1;
      dayIdx = (dayIdx + 1) % 7;
      if (dayIdx === 6) {
        offsetDays = 2;
        dayIdx = 0;
      }
    }
  }

  const className = await dbService.getUserClass(ctx.from.id);
  const cacheKey = `${ctx.from.id}:${periodNum}:${binoId}`;
  let pages = roomsPaginationCache.get(cacheKey);

  if (!pages) {
    const binoFilter = binoId === 'all' ? null : (binoId === 'asosiy' ? 'Asosiy' : `${binoId}-bino`);
    pages = await scheduleService.fetchEmptyRooms(className, dayIdx, periodNum, offsetDays, binoFilter);
    roomsPaginationCache.set(cacheKey, pages);
  }

  const safePage = Math.max(0, Math.min(pageIdx, (pages.length || 1) - 1));
  const binoTitle = BINOLAR.find(b => b.id === binoId)?.label || 'Barcha binolar';
  const pageText = pages[safePage] || `⚠️ <b>${binoTitle}</b> bo'yicha bo'sh xonalar topilmadi.`;
  const kb = buildRoomPageKb(periodNum, binoId, safePage, pages.length);

  try {
    await ctx.editMessageText(pageText, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    if (!err?.message?.includes('message is not modified')) {
      logger.error('renderRoomView error', { error: err?.message });
    }
  }
}

async function cbBoshXona(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const periodNum = parseInt(ctx.callbackQuery.data.split('_')[1], 10);
  await renderRoomView(ctx, periodNum, 'all', 0);
}

async function cbRoomAction(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const parts = ctx.callbackQuery.data.split('_');
  const periodNum = parseInt(parts[1], 10);
  const binoId = parts[2];
  const page = parseInt(parts[3], 10);
  await renderRoomView(ctx, periodNum, binoId, page);
}

async function cbBackToRoomsMenu(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.editMessageText('🏢 Qaysi para uchun bo\'sh xonalarni ko\'rmoqchisiz?', PARA_KB);
}

async function cbRetryHafta(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  await ctx.deleteMessage().catch(() => {});
  await cmdHafta(ctx);
}

function register(bot) {
  bot.command('jadval', cmdJadval);
  bot.command('hafta', cmdHafta);
  bot.command('xonalar', cmdXonalar);
  bot.command('timetable', cmdTimetable);
  bot.command('schedule', cmdTimetable);

  // Reply Keyboard triggers
  bot.hears('📅 Bugungi jadval', cmdJadval);
  bot.hears('🖼 Haftalik jadval', cmdHafta);
  bot.hears('🏢 Bo\'sh xonalar', cmdXonalar);
  bot.hears('⚙️ Guruhni sozlash', cmdTimetableHelp);

  // Inline Button triggers
  bot.action('schedule_menu', cmdTimetable);
  bot.action('schedule_today', cmdJadval);
  bot.action('schedule_week', cmdHafta);
  bot.action('schedule_rooms', cmdXonalar);
  bot.action('schedule_settings', cmdTimetableHelp);

  // Interactive Timetable Pager actions
  bot.action(/^sched_day_/, cbScheduleDay);

  // Empty rooms building & pagination actions
  bot.action(/^bosh_/, cbBoshXona);
  bot.action(/^rm_/, cbRoomAction);
  bot.action('back_to_rooms_menu', cbBackToRoomsMenu);
  bot.action('retry_hafta', cbRetryHafta);
}

module.exports = {
  register,
  cmdTimetable,
  cbSchedule: cmdTimetable,
  cmdJadval,
  cmdHafta,
  cmdXonalar,
};