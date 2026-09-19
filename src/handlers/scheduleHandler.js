'use strict';

const { Markup } = require('telegraf');
const dbService = require('../services/dbService');
const scheduleService = require('../services/scheduleService');
const { getTimetableKeyboard, getTimetableInlineKeyboard } = require('../keyboards/keyboards');
const { TTLMap } = require('../core/utils');

const roomsPaginationCache = new TTLMap(5 * 60 * 1000); // 5-minute TTL

const PARA_KB = Markup.inlineKeyboard([
  [Markup.button.callback('1-para  08:30–09:50', 'bosh_1'), Markup.button.callback('2-para  10:00–11:20', 'bosh_2')],
  [Markup.button.callback('3-para  11:30–12:50', 'bosh_3'), Markup.button.callback('4-para  13:30–14:50', 'bosh_4')],
  [Markup.button.callback('5-para  15:00–16:20', 'bosh_5'), Markup.button.callback('6-para  16:30–17:50', 'bosh_6')],
]);

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

async function cmdJadval(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const className = await dbService.getUserClass(ctx.from.id);
  if (!className) {
    return ctx.reply('⚠️ Avval guruhingizni saqlashingiz kerak!\n\n👉 <code>/setclass MI-21</code>', { parse_mode: 'HTML' });
  }

  const msg = await ctx.reply('⏳ Dars jadvali olinmoqda...');
  try {
    const scheduleText = await scheduleService.fetchTodaySchedule(className);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      `🎓 <b>Guruh: ${className}</b>\n\n${scheduleText}\n\n<i>Barcha kunlarni ko'rish uchun /hafta bosing</i>`,
      { parse_mode: 'HTML' }
    );
  } catch {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      msg.message_id,
      undefined,
      '⚠️ Jadval yuklanmadi. Iltimos birozdan so\'ng qayta urinib ko\'ring.'
    );
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

async function cbBoshXona(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const periodNum = parseInt(ctx.callbackQuery.data.split('_')[1], 10);
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

  const DAY_NAMES_LOCAL = ['Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];
  await ctx.editMessageText(`⏳ <b>${DAY_NAMES_LOCAL[dayIdx]}</b> kungi <b>${periodNum}-para</b> uchun bo'sh xonalar qidirilmoqda...`, { parse_mode: 'HTML' });

  const className = await dbService.getUserClass(ctx.from.id);
  const searchKey = className || '*3';
  const binfoNote = className
    ? ''
    : '\n\n<i>💡 Guruhingiz aniqlanmagan. Barcha binolar ko\'rsatilmoqda. Aniq natija uchun /setclass orqali guruhingizni kiriting.</i>';

  const pages = await scheduleService.fetchEmptyRooms(searchKey, dayIdx, periodNum, offsetDays);
  roomsPaginationCache.set(ctx.from.id, pages);

  const firstPage = (pages[0] || '⚠️ Bo\'sh xonalar topilmadi') + binfoNote;
  await ctx.editMessageText(firstPage, { parse_mode: 'HTML', ...buildRoomPageKb(0, pages.length) });
}

async function cbRoomPage(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const targetPage = parseInt(ctx.callbackQuery.data.split('_')[1], 10);
  const pages = roomsPaginationCache.get(ctx.from.id);
  if (!pages?.[targetPage]) return ctx.reply('⚠️ Ma\'lumot eskirgan, qaytadan yozing.');
  await ctx.editMessageText(pages[targetPage], { parse_mode: 'HTML', ...buildRoomPageKb(targetPage, pages.length) });
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

  bot.action(/^bosh_/, cbBoshXona);
  bot.action('back_to_rooms_menu', cbBackToRoomsMenu);
  bot.action(/^roompage_/, cbRoomPage);
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