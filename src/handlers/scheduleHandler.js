'use strict';

const { Markup } = require('telegraf');
const dbService = require('../services/dbService');
const scheduleService = require('../services/scheduleService');
const edupageService = require('../services/edupageService');
const { getTimetableKeyboard, getTimetableInlineKeyboard } = require('../keyboards/keyboards');
const { TTLMap, escapeHtml, safeAnswerCb } = require('../core/utils');
const logger = require('../core/logger');

const roomsPaginationCache = new TTLMap(5 * 60 * 1000, 200); // 5-minute TTL, max 200 slots

// User-level concurrency control & debounce guards
const activeThemeSwitches = new Set();
const activeHaftaRequests = new Set();

const DAY_SHORT_NAMES = ['Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];

const PARA_KB = Markup.inlineKeyboard([
  [
    Markup.button.callback('⚡️ Hozirgi para', 'bosh_now'),
    Markup.button.callback('⏭️ Keyingi para', 'bosh_next'),
  ],
  [Markup.button.callback('1-para  08:00–09:20', 'bosh_1'), Markup.button.callback('2-para  09:30–10:50', 'bosh_2')],
  [Markup.button.callback('3-para  11:00–12:20', 'bosh_3'), Markup.button.callback('4-para  13:00–14:20', 'bosh_4')],
  [Markup.button.callback('5-para  14:30–15:50', 'bosh_5'), Markup.button.callback('6-para  16:00–17:20', 'bosh_6')],
  [Markup.button.callback('7-para  17:30–18:50', 'bosh_7'), Markup.button.callback('8-para  19:00–20:20', 'bosh_8')],
  [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
]);

function toBinoId(binoName) {
  if (!binoName) return 'all';
  if (binoName === 'my' || binoName === 'all') return binoName;
  if (/asosiy/i.test(binoName)) return 'asosiy';
  const bochka = binoName.match(/^(\d+)-bochka/i);
  if (bochka) return `${bochka[1]}-bochka`;
  const binoNum = binoName.match(/^(\d+)/);
  if (binoNum) return binoNum[1];
  return binoName.toLowerCase().replace(/\s+/g, '-');
}

function fromBinoId(binoId) {
  if (!binoId || binoId === 'all') return 'all';
  if (binoId === 'my') return 'my';
  if (binoId === 'asosiy') return 'Asosiy bino';
  if (binoId.endsWith('-bochka')) return binoId;
  if (/^\d+$/.test(binoId)) return `${binoId}-bino`;
  return binoId;
}

/**
 * Resolves current and next class periods according to Asia/Tashkent time
 */
function getPeriodNowAndNext() {
  const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  let dayOfWeek = (tzDate.getDay() + 6) % 7; // 0=Mon .. 5=Sat, 6=Sun
  const nowMins = tzDate.getHours() * 60 + tzDate.getMinutes();

  if (dayOfWeek === 6) {
    return {
      current: { periodNum: 1, dayIdx: 0, offsetDays: 1, isAfterHours: true },
      next: { periodNum: 2, dayIdx: 0, offsetDays: 1, isAfterHours: true },
    };
  }

  if (nowMins >= 1220) {
    const nextOffset = dayOfWeek === 5 ? 2 : 1;
    const nextDay = dayOfWeek === 5 ? 0 : dayOfWeek + 1;
    return {
      current: { periodNum: 1, dayIdx: nextDay, offsetDays: nextOffset, isAfterHours: true },
      next: { periodNum: 2, dayIdx: nextDay, offsetDays: nextOffset, isAfterHours: true },
    };
  }

  let currentPeriod = 1;
  if (nowMins < 560) currentPeriod = 1;
  else if (nowMins < 650) currentPeriod = 2;
  else if (nowMins < 740) currentPeriod = 3;
  else if (nowMins < 860) currentPeriod = 4;
  else if (nowMins < 950) currentPeriod = 5;
  else if (nowMins < 1040) currentPeriod = 6;
  else if (nowMins < 1130) currentPeriod = 7;
  else currentPeriod = 8;

  const currentInfo = { periodNum: currentPeriod, dayIdx: dayOfWeek, offsetDays: 0, isAfterHours: false };

  let nextInfo;
  if (currentPeriod < 8) {
    nextInfo = { periodNum: currentPeriod + 1, dayIdx: dayOfWeek, offsetDays: 0, isAfterHours: false };
  } else {
    const nextOffset = dayOfWeek === 5 ? 2 : 1;
    const nextDay = dayOfWeek === 5 ? 0 : dayOfWeek + 1;
    nextInfo = { periodNum: 1, dayIdx: nextDay, offsetDays: nextOffset, isAfterHours: true };
  }

  return { current: currentInfo, next: nextInfo };
}

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
function buildRoomPageKb(periodNum, currentBino, currentPage, totalPages, studentBinos = []) {
  const myLabel = currentBino === 'my' ? '• 🎓 Mening binolarim •' : '🎓 Mening binolarim';
  const allLabel = currentBino === 'all' ? '• 🏛 Barchasi •' : '🏛 Barchasi';

  const rows = [
    [
      Markup.button.callback(myLabel, `rm_${periodNum}_my_0`),
      Markup.button.callback(allLabel, `rm_${periodNum}_all_0`),
    ]
  ];

  if (studentBinos.length > 0) {
    const binoButtons = studentBinos.map(binoName => {
      const bId = toBinoId(binoName);
      const isActive = currentBino === bId || currentBino === binoName;
      const label = isActive ? `• ${binoName} •` : binoName;
      return Markup.button.callback(label, `rm_${periodNum}_${bId}_0`);
    });
    for (let i = 0; i < binoButtons.length; i += 3) {
      rows.push(binoButtons.slice(i, i + 3));
    }

    const POPULAR_BINOS = ['Asosiy bino', '1-bino', '2-bino', '3-bino', '4-bino'];
    const otherBinos = POPULAR_BINOS.filter(b => !studentBinos.includes(b)).slice(0, 3);
    if (otherBinos.length > 0) {
      const otherButtons = otherBinos.map(binoName => {
        const bId = toBinoId(binoName);
        const isActive = currentBino === bId || currentBino === binoName;
        const label = isActive ? `• ${binoName} •` : binoName;
        return Markup.button.callback(label, `rm_${periodNum}_${bId}_0`);
      });
      rows.push(otherButtons);
    }
  } else {
    const DEFAULT_BINOS = [
      { id: 'asosiy', label: '🏛 Asosiy' },
      { id: '1', label: '1-bino' },
      { id: '2', label: '2-bino' },
      { id: '3', label: '3-bino' },
      { id: '4', label: '4-bino' },
      { id: '5', label: '5-bino' },
    ];
    const defBtns = DEFAULT_BINOS.map(b => {
      const isActive = b.id === currentBino;
      const label = isActive ? `• ${b.label} •` : b.label;
      return Markup.button.callback(label, `rm_${periodNum}_${b.id}_0`);
    });
    rows.push(defBtns.slice(0, 3));
    rows.push(defBtns.slice(3, 6));
  }

  // Row 4: Pagination if needed
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

  // Row 5: Controls
  rows.push([
    Markup.button.callback('🔄 Boshqa para', 'back_to_rooms_menu'),
    Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'),
  ]);

  return Markup.inlineKeyboard(rows);
}

async function cmdJadval(ctx) {
  await safeAnswerCb(ctx);
  const rawClass = await dbService.getUserClass(ctx.from.id);
  if (!rawClass) {
    const profileHandler = require('./profileHandler');
    return profileHandler.promptSetClass(ctx);
  }
  const className = edupageService.getCanonicalGroupName(rawClass) || rawClass;

  const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  let dayOfWeek = (tzDate.getDay() + 6) % 7;
  let isSunday = false;
  if (dayOfWeek === 6) {
    dayOfWeek = 0; // Sunday defaults to Monday
    isSunday = true;
  }

  try {
    const scheduleText = await scheduleService.fetchTodaySchedule(className, dayOfWeek);
    const sundayNote = isSunday ? '<i>(Bugun yakshanba — Dushanba jadvali ko\'rsatilmoqda)</i>\n\n' : '';
    const text = `🎓 <b>Guruh: ${escapeHtml(className)}</b>\n${sundayNote}${scheduleText}`;
    const kb = buildSchedulePagerKeyboard(dayOfWeek);

    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb }).catch(async (e) => {
        if (!e?.message?.includes('message is not modified')) {
          await ctx.reply(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
        }
      });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...kb });
    }
  } catch (err) {
    logger.error('cmdJadval error', { error: err.message, className });
    await ctx.reply('⚠️ Jadval yuklanmadi. Iltimos birozdan so\'ng qayta urinib ko\'ring.');
  }
}

async function cbScheduleDay(ctx) {
  await safeAnswerCb(ctx);
  const rawClass = await dbService.getUserClass(ctx.from.id);
  if (!rawClass) {
    const profileHandler = require('./profileHandler');
    return profileHandler.promptSetClass(ctx);
  }
  const className = edupageService.getCanonicalGroupName(rawClass) || rawClass;

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
    const text = `🎓 <b>Guruh: ${escapeHtml(className)}</b>\n\n${scheduleText}`;
    const kb = buildSchedulePagerKeyboard(targetDay);
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    if (!err?.message?.includes('message is not modified')) {
      logger.error('cbScheduleDay error', { error: err?.message, className });
    }
  }
}

function buildThemeSwitcherKeyboard(currentTheme = 'dark') {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(currentTheme === 'dark' ? '• 🌙 Tungi •' : '🌙 Tungi', 'sched_theme_dark'),
      Markup.button.callback(currentTheme === 'light' ? '• ☀️ Kunduzgi •' : '☀️ Kunduzgi', 'sched_theme_light'),
      Markup.button.callback(currentTheme === 'vibrant' ? '• ⚡ Neon •' : '⚡ Neon', 'sched_theme_vibrant'),
    ],
    [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
  ]);
}

async function cmdHafta(ctx) {
  await safeAnswerCb(ctx);
  const userId = ctx.from?.id;
  if (!userId) return;

  const rawClass = await dbService.getUserClass(userId);
  if (!rawClass) {
    const profileHandler = require('./profileHandler');
    return profileHandler.promptSetClass(ctx);
  }

  // Ensure canonical original group name ("asli ko'rinishi", e.g. "BHA-51k/24")
  const className = edupageService.getCanonicalGroupName(rawClass) || rawClass;

  // Prevent duplicate concurrent /hafta requests from the same user
  if (activeHaftaRequests.has(userId)) {
    return ctx.reply('⏳ Haftalik jadvalingiz tayyorlanmoqda, iltimos biroz kuting...').catch(() => {});
  }
  activeHaftaRequests.add(userId);

  const userTheme = await dbService.getUserScheduleTheme(userId);
  let msg = null;

  // Show loading notification only if not already cached in CDN
  const cached = await dbService.getTimetableCache(className, userTheme);
  if (!cached || !cached.file_id) {
    msg = await ctx.reply('⏳ Haftalik dars jadvali rasmga olinmoqda. Iltimos kuting...').catch(() => null);
  }

  try {
    const photoResult = await scheduleService.fetchWeeklySchedulePhoto(className, userTheme, ctx.telegram);
    if (!photoResult) {
      if (msg?.message_id) {
        return ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, `📭 "<b>${escapeHtml(className)}</b>" guruhi uchun haftalik jadval topilmadi.`, { parse_mode: 'HTML' });
      }
      return ctx.reply(`📭 "<b>${escapeHtml(className)}</b>" guruhi uchun haftalik jadval topilmadi.`, { parse_mode: 'HTML' });
    }

    const kb = buildThemeSwitcherKeyboard(userTheme);
    const themeLabel = userTheme === 'light' ? '☀️ Kunduzgi' : userTheme === 'vibrant' ? '⚡ Neon' : '🌙 Tungi';
    const media = photoResult.fileId ? photoResult.fileId : { source: photoResult.buffer };

    await ctx.replyWithPhoto(
      media,
      {
        caption: `🎓 <b>Haftalik Jadval: ${escapeHtml(className)}</b>\n<i>🎨 Mavzu: ${themeLabel}</i>`,
        parse_mode: 'HTML',
        ...kb,
      }
    );
    if (msg?.message_id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
    }
  } catch (err) {
    logger.error('cmdHafta error', { error: err.message, className });
    if (msg?.message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        msg.message_id,
        undefined,
        '⚠️ Jadval yuklanmadi.\n\nIltimos, bir ozdan so\'ng qaytadan urinib ko\'ring. Bugungi jadval uchun /jadval buyrug\'idan foydalaning.',
        Markup.inlineKeyboard([[Markup.button.callback('🔄 Qayta urinish', 'retry_hafta')]])
      ).catch(() => {});
    } else {
      await ctx.reply('⚠️ Jadval yuklanmadi. Iltimos birozdan so\'ng qayta urinib ko\'ring.').catch(() => {});
    }
  } finally {
    activeHaftaRequests.delete(userId);
  }
}

async function cbSwitchScheduleTheme(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const data = ctx.callbackQuery?.data;
  const theme = data ? data.replace('sched_theme_', '') : 'dark';
  if (!['dark', 'light', 'vibrant'].includes(theme)) {
    return safeAnswerCb(ctx);
  }

  // Prevent multiple rapid clicks from the same user
  if (activeThemeSwitches.has(userId)) {
    return safeAnswerCb(ctx, 'Mavzu almashtirilmoqda, iltimos kuting...');
  }

  const currentTheme = await dbService.getUserScheduleTheme(userId);
  if (currentTheme === theme) {
    return safeAnswerCb(ctx, 'Ushbu mavzu allaqachon faol.');
  }

  activeThemeSwitches.add(userId);
  await safeAnswerCb(ctx, 'Mavzu almashtirilmoqda...');

  try {
    const rawClass = await dbService.getUserClass(userId);
    if (!rawClass) return;
    const className = edupageService.getCanonicalGroupName(rawClass) || rawClass;

    const photoResult = await scheduleService.fetchWeeklySchedulePhoto(className, theme, ctx.telegram);
    if (!photoResult) return;
    await dbService.setUserScheduleTheme(userId, theme);

    const kb = buildThemeSwitcherKeyboard(theme);
    const themeLabel = theme === 'light' ? '☀️ Kunduzgi' : theme === 'vibrant' ? '⚡ Neon' : '🌙 Tungi';
    const caption = `🎓 <b>Haftalik Jadval: ${escapeHtml(className)}</b>\n<i>🎨 Mavzu: ${themeLabel}</i>`;
    const media = photoResult.fileId ? photoResult.fileId : { source: photoResult.buffer };

    try {
      await ctx.editMessageMedia(
        {
          type: 'photo',
          media,
          caption,
          parse_mode: 'HTML',
        },
        kb
      );
    } catch (editErr) {
      if (editErr?.message?.includes('message is not modified')) return;
      // Fallback if media cannot be edited in-place
      await ctx.deleteMessage().catch(() => {});
      await ctx.replyWithPhoto(media, { caption, parse_mode: 'HTML', ...kb }).catch(() => {});
    }
  } catch (err) {
    logger.error('cbSwitchScheduleTheme error', { error: err.message, userId, theme });
  } finally {
    activeThemeSwitches.delete(userId);
  }
}

async function cmdTimetable(ctx) {
  await safeAnswerCb(ctx);
  const rawClass = await dbService.getUserClass(ctx.from.id);
  const className = rawClass ? (edupageService.getCanonicalGroupName(rawClass) || rawClass) : null;
  const status = className ? `✅ Sizning guruhingiz: <b>${escapeHtml(className)}</b>` : '⚠️ <b>Guruh tanlanmagan.</b>';
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
  await safeAnswerCb(ctx);
  const profileHandler = require('./profileHandler');
  return profileHandler.promptSetClass(ctx);
}

async function cmdXonalar(ctx) {
  await safeAnswerCb(ctx);
  await ctx.reply('🏢 Qaysi para uchun bo\'sh xonalarni ko\'rmoqchisiz?', PARA_KB);
}

async function renderRoomView(ctx, periodNum, binoId = 'all', pageIdx = 0, explicitDayIdx = null, explicitOffsetDays = null, explicitTimeMode = null) {
  const tzDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  let dayIdx = explicitDayIdx !== null ? explicitDayIdx : (tzDate.getDay() + 6) % 7;
  let offsetDays = explicitOffsetDays !== null ? explicitOffsetDays : 0;

  if (explicitDayIdx === null) {
    if (dayIdx === 6) {
      offsetDays = 1;
      dayIdx = 0;
    } else {
      const nowMins = tzDate.getHours() * 60 + tzDate.getMinutes();
      const periodEnd = {
        1: 9 * 60 + 20,   // 09:20 -> 560
        2: 10 * 60 + 50,  // 10:50 -> 650
        3: 12 * 60 + 20,  // 12:20 -> 740
        4: 14 * 60 + 20,  // 14:20 -> 860
        5: 15 * 60 + 50,  // 15:50 -> 950
        6: 17 * 60 + 20,  // 17:20 -> 1040
        7: 18 * 60 + 50,  // 18:50 -> 1130
        8: 20 * 60 + 20,  // 20:20 -> 1220
      };
      if (nowMins > (periodEnd[periodNum] ?? 1440)) {
        offsetDays = 1;
        dayIdx = (dayIdx + 1) % 7;
        if (dayIdx === 6) {
          offsetDays = 2;
          dayIdx = 0;
        }
      }
    }
  }

  let timeMode = explicitTimeMode;
  if (!timeMode) {
    const { current, next } = getPeriodNowAndNext();
    if (current.periodNum === periodNum && current.dayIdx === dayIdx) {
      timeMode = 'now';
    } else if (next.periodNum === periodNum && next.dayIdx === dayIdx) {
      timeMode = 'next';
    }
  }

  const rawClass = await dbService.getUserClass(ctx.from.id);
  const className = rawClass ? (edupageService.getCanonicalGroupName(rawClass) || rawClass) : null;
  const studentBinos = className ? await edupageService.getGroupBuildings(className) : [];

  const cacheKey = `${ctx.from.id}:${dayIdx}:${periodNum}:${binoId}:${timeMode || 'std'}`;
  let pages = roomsPaginationCache.get(cacheKey);

  if (!pages) {
    const filterParam = binoId === 'all' ? null : (binoId === 'my' ? 'my' : fromBinoId(binoId));
    pages = await scheduleService.fetchEmptyRooms(className, dayIdx, periodNum, offsetDays, filterParam, timeMode);
    roomsPaginationCache.set(cacheKey, pages);
  }

  const safePage = Math.max(0, Math.min(pageIdx, (pages.length || 1) - 1));
  let pageText = pages[safePage] || '⚠️ Bo\'sh xonalar topilmadi.';
  if (!rawClass && binoId !== 'my') {
    pageText += '\n\n💡 <i>O\'zingiz o\'qiydigan binolardagi bo\'sh xonalarni ko\'rish uchun /setclass orqali guruhingizni sozlang.</i>';
  }

  const kb = buildRoomPageKb(periodNum, binoId, safePage, pages.length, studentBinos);

  try {
    await ctx.editMessageText(pageText, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    if (!err?.message?.includes('message is not modified')) {
      logger.error('renderRoomView error', { error: err?.message });
    }
  }
}

async function cbBoshXonaNow(ctx) {
  await safeAnswerCb(ctx);
  const { current } = getPeriodNowAndNext();
  const rawClass = await dbService.getUserClass(ctx.from.id);
  const className = rawClass ? (edupageService.getCanonicalGroupName(rawClass) || rawClass) : null;
  const studentBinos = className ? await edupageService.getGroupBuildings(className) : [];
  const defaultBino = studentBinos.length > 0 ? 'my' : 'all';
  await renderRoomView(ctx, current.periodNum, defaultBino, 0, current.dayIdx, current.offsetDays, 'now');
}

async function cbBoshXonaNext(ctx) {
  await safeAnswerCb(ctx);
  const { next } = getPeriodNowAndNext();
  const rawClass = await dbService.getUserClass(ctx.from.id);
  const className = rawClass ? (edupageService.getCanonicalGroupName(rawClass) || rawClass) : null;
  const studentBinos = className ? await edupageService.getGroupBuildings(className) : [];
  const defaultBino = studentBinos.length > 0 ? 'my' : 'all';
  await renderRoomView(ctx, next.periodNum, defaultBino, 0, next.dayIdx, next.offsetDays, 'next');
}

async function cbBoshXona(ctx) {
  await safeAnswerCb(ctx);
  const periodNum = parseInt(ctx.callbackQuery.data.replace('bosh_', ''), 10);
  if (Number.isNaN(periodNum) || periodNum < 1 || periodNum > 8) return;

  const rawClass = await dbService.getUserClass(ctx.from.id);
  const className = rawClass ? (edupageService.getCanonicalGroupName(rawClass) || rawClass) : null;
  const studentBinos = className ? await edupageService.getGroupBuildings(className) : [];
  const defaultBino = studentBinos.length > 0 ? 'my' : 'all';
  await renderRoomView(ctx, periodNum, defaultBino, 0);
}

async function cbRoomAction(ctx) {
  const parts = ctx.callbackQuery.data.split('_');
  const periodNum = parseInt(parts[1], 10);
  const binoId = parts[2];
  const page = parseInt(parts[3], 10);

  if (binoId === 'my') {
    const rawClass = await dbService.getUserClass(ctx.from.id);
    if (!rawClass) {
      return safeAnswerCb(ctx, '⚠️ Avval /setclass orqali guruhingizni sozlang (Masalan: /setclass MI-15)', true);
    }
  }

  await safeAnswerCb(ctx);
  await renderRoomView(ctx, periodNum, binoId, page);
}

async function cbBackToRoomsMenu(ctx) {
  await safeAnswerCb(ctx);
  await ctx.editMessageText('🏢 Qaysi para uchun bo\'sh xonalarni ko\'rmoqchisiz?', PARA_KB);
}

async function cbRetryHafta(ctx) {
  await safeAnswerCb(ctx);
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
  bot.action(/^sched_theme_/, cbSwitchScheduleTheme);

  // Empty rooms triggers
  bot.action('bosh_now', cbBoshXonaNow);
  bot.action('bosh_next', cbBoshXonaNext);
  bot.action(/^bosh_\d+$/, cbBoshXona);
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