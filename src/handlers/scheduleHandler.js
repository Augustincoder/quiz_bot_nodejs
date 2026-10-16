'use strict';

const { Markup } = require('telegraf');
const dbService = require('../services/dbService');
const scheduleService = require('../services/scheduleService');
const edupageService = require('../services/edupageService');
const { getTimetableInlineKeyboard } = require('../keyboards/keyboards');
const { TTLMap, escapeHtml, safeAnswerCb, safeEdit, clearState, getTashkentDate, getTashkentDayOfWeek, safeCallbackData } = require('../core/utils');
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
  [
    Markup.button.callback('🎓 Jadval Markazi', 'schedule_menu'),
    Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'),
  ],
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
  const tzDate = getTashkentDate();
  let dayOfWeek = getTashkentDayOfWeek();
  const nowMins = tzDate.getHours() * 60 + tzDate.getMinutes();

  if (dayOfWeek === 6) {
    return {
      current: { periodNum: 1, dayIdx: 0, offsetDays: 1, isAfterHours: true },
      next: { periodNum: 1, dayIdx: 0, offsetDays: 1, isAfterHours: true },
    };
  }

  if (nowMins >= 1220) {
    const nextOffset = dayOfWeek === 5 ? 2 : 1;
    const nextDay = dayOfWeek === 5 ? 0 : dayOfWeek + 1;
    return {
      current: { periodNum: 1, dayIdx: nextDay, offsetDays: nextOffset, isAfterHours: true },
      next: { periodNum: 1, dayIdx: nextDay, offsetDays: nextOffset, isAfterHours: true },
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

  // Row 4: Back navigation
  const menuRow = [
    Markup.button.callback('🎓 Jadval Markazi', 'schedule_menu'),
    Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'),
  ];

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
      return Markup.button.callback(label, safeCallbackData(`rm_${periodNum}_${bId}_0`));
    });
    for (let i = 0; i < binoButtons.length; i += 3) {
      rows.push(binoButtons.slice(i, i + 3));
    }
  } else {
    const DEFAULT_BINOS = [
      { id: '4', label: '4-bino' },
      { id: '5', label: '5-bino' },
      { id: '8', label: '8-bino' },
      { id: '10', label: '10-bino' },
      { id: '7', label: '7-bino' },
      { id: '3', label: '3-bino' },
    ];
    const defBtns = DEFAULT_BINOS.map(b => {
      const isActive = b.id === currentBino;
      const label = isActive ? `• ${b.label} •` : b.label;
      return Markup.button.callback(label, safeCallbackData(`rm_${periodNum}_${b.id}_0`));
    });
    rows.push(defBtns.slice(0, 3));
    rows.push(defBtns.slice(3, 6));
  }

  // Row 4: Pagination if needed
  if (totalPages > 1) {
    const nav = [];
    if (currentPage > 0) {
      nav.push(Markup.button.callback('⬅️ Oldingi', safeCallbackData(`rm_${periodNum}_${currentBino}_${currentPage - 1}`)));
    }
    nav.push(Markup.button.callback(`${currentPage + 1} / ${totalPages}`, 'ignore'));
    if (currentPage < totalPages - 1) {
      nav.push(Markup.button.callback('Keyingi ➡️', safeCallbackData(`rm_${periodNum}_${currentBino}_${currentPage + 1}`)));
    }
    rows.push(nav);
  }

  // Row 5: Controls
  rows.push([
    Markup.button.callback('🔄 Boshqa para', 'back_to_rooms_menu'),
    Markup.button.callback('🎓 Jadval Markazi', 'schedule_menu'),
  ]);
  rows.push([
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

  const currentDay = getTashkentDayOfWeek();
  let dayOfWeek = currentDay;
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
    targetDay = getTashkentDayOfWeek();
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
    [
      Markup.button.callback('📅 Bugungi matn', 'schedule_today'),
      Markup.button.callback('🎓 Jadval Markazi', 'schedule_menu'),
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

  let msg = null;
  try {
    const userTheme = await dbService.getUserScheduleTheme(userId);

    // Show loading notification only if not already cached in CDN
    const cached = await dbService.getTimetableCache(className, userTheme);
    if (!cached || !cached.file_id) {
      msg = await ctx.reply('⏳ Haftalik dars jadvali rasmga olinmoqda. Iltimos kuting...').catch(() => null);
    }
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

    const changeNotice = photoResult?.wasStale
      ? "\n\n🔔 <b>DIQQAT:</b> Guruhingiz dars jadvalida o'zgarishlar aniqlanganligi sababli jadval yangilandi!"
      : '';

    try {
      const sentMsg = await ctx.replyWithPhoto(
        media,
        {
          caption: `🎓 <b>Haftalik Jadval: ${escapeHtml(className)}</b>\n<i>🎨 Mavzu: ${themeLabel}</i>${changeNotice}`,
          parse_mode: 'HTML',
          ...kb,
        }
      );
      if (msg?.message_id) {
        await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
      }
      // Bug 31 fix: When photo is rendered from buffer (local fallback due to 429), save Telegram's returned file_id to cache!
      if (!photoResult.fileId && sentMsg?.photo?.length > 0) {
        const bestPhoto = sentMsg.photo[sentMsg.photo.length - 1];
        if (bestPhoto?.file_id) {
          dbService.upsertTimetableCache({
            groupName: className,
            groupNormalized: edupageService.normalizeGroupName(className),
            theme: userTheme,
            fileId: bestPhoto.file_id,
            channelMessageId: null,
            scheduleHash: null,
          }).catch(() => {});
        }
      }
    } catch (sendErr) {
      const errStr = String(sendErr?.message || sendErr);
      const isFileIdError =
        errStr.includes('wrong file identifier') ||
        errStr.includes('wrong remote file') ||
        errStr.includes('FILE_ID_INVALID') ||
        errStr.includes('failed to get HTTP URL content');

      if (isFileIdError && photoResult?.fileId) {
        logger.warn(`[scheduleHandler] Detected stale/invalid CDN file_id for ${className}. Triggering self-healing fallback...`, { error: errStr });
        await scheduleService.invalidateImageCache(className);
        const freshBuffer = await scheduleService.fetchWeeklyScheduleImage(className, userTheme);
        if (freshBuffer) {
          await ctx.replyWithPhoto(
            { source: freshBuffer },
            {
              caption: `🎓 <b>Haftalik Jadval: ${escapeHtml(className)}</b>\n<i>🎨 Mavzu: ${themeLabel}</i>${changeNotice}`,
              parse_mode: 'HTML',
              ...kb,
            }
          );
          if (msg?.message_id) {
            await ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
          }
          // Non-blocking CDN re-warm in background
          try {
            const timetableCdnService = require('../services/timetableCdnService');
            timetableCdnService.getOrGenerateTimetablePhoto(ctx.telegram, className, userTheme).catch(() => {});
          } catch {}
          return;
        }
      }
      throw sendErr;
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
    if (!rawClass) {
      await ctx.reply('⚠️ Avval /setclass orqali guruhingizni sozlang (Masalan: /setclass MI-15)').catch(() => {});
      return;
    }
    const className = edupageService.getCanonicalGroupName(rawClass) || rawClass;

    const photoResult = await scheduleService.fetchWeeklySchedulePhoto(className, theme, ctx.telegram);
    if (!photoResult) {
      await ctx.reply('⚠️ Ushbu mavzudagi dars jadvalini tayyorlab bo\'lmadi.').catch(() => {});
      return;
    }
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

      const errStr = String(editErr?.message || editErr);
      const isFileIdError =
        errStr.includes('wrong file identifier') ||
        errStr.includes('wrong remote file') ||
        errStr.includes('FILE_ID_INVALID');

      if (isFileIdError && photoResult?.fileId) {
        logger.warn(`[scheduleHandler] Detected stale/invalid CDN file_id in theme switch for ${className}. Self-healing...`, { error: errStr });
        await scheduleService.invalidateImageCache(className);
        const freshBuffer = await scheduleService.fetchWeeklyScheduleImage(className, theme);
        if (freshBuffer) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.replyWithPhoto({ source: freshBuffer }, { caption, parse_mode: 'HTML', ...kb }).catch(() => {});
          return;
        }
      }

      // Fallback if media cannot be edited in-place
      await ctx.deleteMessage().catch(() => {});
      await ctx.replyWithPhoto(media, { caption, parse_mode: 'HTML', ...kb }).catch(() => {});
    }
  } catch (err) {
    logger.error('cbSwitchScheduleTheme error', { error: err.message, userId, theme });
    await ctx.reply('⚠️ Mavzuni almashtirishda xatolik yuz berdi. Iltimos keyinroq qayta urinib ko\'ring.').catch(() => {});
  } finally {
    activeThemeSwitches.delete(userId);
  }
}

async function cmdTimetable(ctx) {
  clearState(ctx);
  await safeAnswerCb(ctx);
  const rawClass = await dbService.getUserClass(ctx.from.id);
  const className = rawClass ? (edupageService.getCanonicalGroupName(rawClass) || rawClass) : null;
  
  const tzDate = getTashkentDate();
  const timeStr = `${String(tzDate.getHours()).padStart(2, '0')}:${String(tzDate.getMinutes()).padStart(2, '0')}`;
  
  let header = `🎓 <b>Dars Jadvali Markazi</b>\n━━━━━━━━━━━━━━━━━━━━\n`;
  if (className) {
    header += `👤 Guruhingiz: <b>${escapeHtml(className)}</b>\n`;
  } else {
    header += `⚠️ Guruhingiz belgilanmagan!\n💡 <i>Jadvalingizni avtomatik olish uchun guruhingizni bir marta kiriting.</i>\n`;
  }
  header += `🕐 Toshkent vaqti: <b>${timeStr}</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚡️ <b>Tezkor imkoniyatlar:</b>\n` +
    `• <b>Bugungi jadval:</b> Bugungi barcha darslar, xonalar va o'qituvchilar\n` +
    `• <b>Haftalik jadval:</b> HD sifatli to'liq haftalik rasm (3 xil mavzuda)\n` +
    `• <b>Bo'sh xonalar:</b> Hozirgi yoki keyingi parada bo'sh turgan xonalar ro'yxati\n\n` +
    `👇 <i>Kerakli bo'limni tanlang:</i>`;

  const inlineKb = getTimetableInlineKeyboard(className);

  if (ctx.callbackQuery) {
    await safeEdit(ctx, header, {
      parse_mode: 'HTML',
      ...inlineKb,
    });
  } else {
    // Agar /timetable buyrug'i yozilgan bo'lsa, ham reply tugmalar, ham inline tugmalar beriladi (maksimal qulaylik)
    await ctx.reply(header, {
      parse_mode: 'HTML',
      ...inlineKb,
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

async function renderRoomView(ctx, periodNum, requestedBinoId = 'all', pageIdx = 0, explicitDayIdx = null, explicitOffsetDays = null, explicitTimeMode = null) {
  const tzDate = getTashkentDate();
  let dayIdx = explicitDayIdx !== null ? explicitDayIdx : getTashkentDayOfWeek();
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
  const binoId = requestedBinoId === 'default' ? (studentBinos.length > 0 ? 'my' : 'all') : requestedBinoId;

  const cacheKey = `${ctx.from.id}:${dayIdx}:${periodNum}:${binoId}:${timeMode || 'std'}`;
  let pages = roomsPaginationCache.get(cacheKey);

  if (!pages) {
    const filterParam = binoId === 'all' ? null : (binoId === 'my' ? 'my' : fromBinoId(binoId));
    pages = await scheduleService.fetchEmptyRooms(className, dayIdx, periodNum, offsetDays, filterParam, timeMode);
    if (Array.isArray(pages) && pages.length > 0 && !pages[0]?.startsWith('❌')) {
      roomsPaginationCache.set(cacheKey, pages);
    }
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
  await renderRoomView(ctx, current.periodNum, 'default', 0, current.dayIdx, current.offsetDays, 'now');
}

async function cbBoshXonaNext(ctx) {
  await safeAnswerCb(ctx);
  const { next } = getPeriodNowAndNext();
  await renderRoomView(ctx, next.periodNum, 'default', 0, next.dayIdx, next.offsetDays, 'next');
}

async function cbBoshXona(ctx) {
  await safeAnswerCb(ctx);
  const periodNum = parseInt(ctx.callbackQuery.data.replace('bosh_', ''), 10);
  if (Number.isNaN(periodNum) || periodNum < 1 || periodNum > 8) return;
  await renderRoomView(ctx, periodNum, 'default', 0);
}

async function cbRoomAction(ctx) {
  const parts = ctx.callbackQuery?.data?.split('_') || [];
  const periodNum = parseInt(parts[1], 10);
  const binoId = parts[2];
  const page = parseInt(parts[3], 10);

  if (Number.isNaN(periodNum) || periodNum < 1 || periodNum > 8) {
    return safeAnswerCb(ctx);
  }

  if (binoId === 'my') {
    const rawClass = await dbService.getUserClass(ctx.from?.id);
    if (!rawClass) {
      return safeAnswerCb(ctx, '⚠️ Avval /setclass orqali guruhingizni sozlang (Masalan: /setclass MI-15)', { show_alert: true });
    }
  }

  await safeAnswerCb(ctx);
  await renderRoomView(ctx, periodNum, binoId, Number.isNaN(page) ? 0 : page);
}

async function cbBackToRoomsMenu(ctx) {
  await safeAnswerCb(ctx);
  try {
    await ctx.editMessageText('🏢 Qaysi para uchun bo\'sh xonalarni ko\'rmoqchisiz?', PARA_KB);
  } catch (err) {
    if (!err?.message?.includes('message is not modified')) {
      await ctx.reply('🏢 Qaysi para uchun bo\'sh xonalarni ko\'rmoqchisiz?', PARA_KB).catch(() => {});
    }
  }
}

async function cbRetryHafta(ctx) {
  await safeAnswerCb(ctx);
  await ctx.deleteMessage().catch(() => {});
  await cmdHafta(ctx);
}

const PREF_LABELS = {
  shift_aware: '🌗 Smenaga mos (1-smena 07:00 / 2-smena 11:30)',
  offset_before_first: '⏱ Birinchi darsdan oldin (Dinamik)',
  custom_time: '🎯 Aniq belgilangan vaqtda',
  standard_both: '🌅+🌙 Standart (07:30 va 20:00)',
  disabled: '🔕 Kunlik eslatmalar o\'chirilgan',
  both: '🌅+🌙 Standart (07:30 va 20:00)',
  morning: '🌤 Faqat ertalab (07:30)',
  evening: '🌙 Faqat kechqurun (20:00)',
  silent: '🔕 Faqat o\'zgarishlar (Sokin rejim)',
};

async function renderNotifySettings(ctx, alertMessage = null) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const prefs = await dbService.getUserScheduleSettings(userId);
  const { getScheduleV2SettingsKeyboard } = require('../keyboards/keyboards');

  const modeLabel = PREF_LABELS[prefs.notify_mode] || PREF_LABELS.shift_aware;
  const offsetText = prefs.notify_mode === 'offset_before_first'
    ? `\n⏱ <b>Offset:</b> Darsdan ${prefs.offset_minutes} daqiqa oldin`
    : '';
  const customTimeText = prefs.notify_mode === 'custom_time'
    ? `\n🎯 <b>Tanlangan vaqt:</b> ${prefs.custom_morning_time || '07:00'} (ertalab) / ${prefs.custom_evening_time || '20:00'} (kechki)`
    : '';

  const text =
    `⚙️ <b>Aqlli Dars Jadvali Eslatmalari (v2.0)</b>\n━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 <b>Guruhingiz:</b> <code>${escapeHtml(prefs.group_name || 'Tanlanmagan')}</code>\n` +
    `📡 <b>Joriy rejim:</b> <b>${escapeHtml(modeLabel)}</b>${offsetText}${customTimeText}\n` +
    `🔔 <b>5 daqiqalik qo‘ng‘iroq eslatmasi:</b> ${prefs.pre_class_5min_bell ? '✅ Yoqilgan' : '❌ O‘chirilgan'}\n` +
    `🏢 <b>Bino almashinuvi ogohlantirishi:</b> ${prefs.building_change_alert ? '✅ Yoqilgan' : '❌ O‘chirilgan'}\n\n` +
    `👇 <i>O‘zingizga eng qulay eslatma rejimini tanlang:</i>`;

  const kb = getScheduleV2SettingsKeyboard(prefs);

  if (ctx.callbackQuery) {
    if (alertMessage) {
      await safeAnswerCb(ctx, alertMessage);
    } else {
      await safeAnswerCb(ctx);
    }

    try {
      await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb });
    } catch (e) {
      if (!e?.message?.includes('message is not modified')) {
        await ctx.reply(text, { parse_mode: 'HTML', ...kb }).catch(() => {});
      }
    }
  } else {
    await ctx.reply(text, { parse_mode: 'HTML', ...kb });
  }
}

async function cbNotifySettings(ctx) {
  return renderNotifySettings(ctx);
}

async function cbSetPref(ctx, pref) {
  const userId = ctx.from?.id;
  if (!userId) return;

  await dbService.setUserNotificationPreference(userId, pref);
  const label = PREF_LABELS[pref] || pref;
  return renderNotifySettings(ctx, `✅ Saqlandi: ${label}`);
}

async function cbV2ModeShift(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  await dbService.upsertUserScheduleSettings(userId, { notify_mode: 'shift_aware' });
  return renderNotifySettings(ctx, '✅ Smenaga mos avto-rejim saqlandi!');
}

async function cbV2Offset(ctx, mins) {
  const userId = ctx.from?.id;
  if (!userId) return;
  await dbService.upsertUserScheduleSettings(userId, {
    notify_mode: 'offset_before_first',
    offset_minutes: Number(mins),
  });
  return renderNotifySettings(ctx, `✅ Darsdan ${mins} daqiqa oldin eslatish belgilandi!`);
}

async function cbV2ModeStandard(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  await dbService.upsertUserScheduleSettings(userId, { notify_mode: 'standard_both' });
  return renderNotifySettings(ctx, '✅ Standart rejim saqlandi!');
}

async function cbV2ToggleBell(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const prefs = await dbService.getUserScheduleSettings(userId);
  const nextVal = !prefs.pre_class_5min_bell;
  await dbService.upsertUserScheduleSettings(userId, { pre_class_5min_bell: nextVal });
  return renderNotifySettings(ctx, nextVal ? '🔔 5 daqiqalik qo‘ng‘iroq yoqildi!' : '🔕 5 daqiqalik qo‘ng‘iroq o‘chirildi');
}

async function cbV2ToggleBld(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const prefs = await dbService.getUserScheduleSettings(userId);
  const nextVal = !prefs.building_change_alert;
  await dbService.upsertUserScheduleSettings(userId, { building_change_alert: nextVal });
  return renderNotifySettings(ctx, nextVal ? '🏢 Bino almashinuvi ogohlantirishi yoqildi!' : '🏢 Bino almashinuvi o‘chirildi');
}

async function cbV2ModeDisabled(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  await dbService.upsertUserScheduleSettings(userId, { notify_mode: 'disabled' });
  return renderNotifySettings(ctx, '🔕 Kunlik eslatmalar o‘chirildi');
}

async function cbV2ModeCustom(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;
  const { setState, States } = require('../core/utils');
  if (ctx.session) {
    ctx.session.state = 'sched:custom_time';
  }
  await safeAnswerCb(ctx);
  return ctx.reply(
    '🎯 <b>Dars jadvali uchun qulay vaqtni kiriting:</b>\n\n' +
    '• <b>00:00 – 17:59:</b> Bugungi kun jadvali uchun (ertalabki/kunduzgi)\n' +
    '• <b>18:00 – 23:59:</b> Ertangi kun jadvali anonsi uchun (kechki)\n\n' +
    'Format: <code>HH:mm</code> (masalan: <code>07:15</code> yoki <code>20:30</code>)',
    { parse_mode: 'HTML' }
  );
}

async function onCustomTimeInput(ctx) {
  const text = (ctx.message?.text || '').trim();
  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;
  if (!timeRegex.test(text)) {
    return ctx.reply('⚠️ Noto‘g‘ri vaqt formati! Iltimos, <code>HH:mm</code> formatida kiriting (Masalan: <code>07:00</code> yoki <code>20:30</code>):', { parse_mode: 'HTML' });
  }

  const [hh] = text.split(':').map(Number);
  const userId = ctx.from?.id;
  if (ctx.session) ctx.session.state = null;

  if (hh < 18) {
    await dbService.upsertUserScheduleSettings(userId, {
      notify_mode: 'custom_time',
      custom_morning_time: text,
    });
    return ctx.reply(
      `✅ <b>Eslatma vaqti saqlandi:</b> <code>${text}</code>\n\n` +
      `Har kuni soat <code>${text}</code> da <b>bugungi</b> dars jadvalingiz yuboriladi (ertalabki/kunduzgi rejim: 00:00–17:59).`,
      { parse_mode: 'HTML' }
    );
  } else {
    await dbService.upsertUserScheduleSettings(userId, {
      notify_mode: 'custom_time',
      custom_evening_time: text,
    });
    return ctx.reply(
      `✅ <b>Eslatma vaqti saqlandi:</b> <code>${text}</code>\n\n` +
      `Har kuni soat <code>${text}</code> da <b>ertangi</b> dars jadvalingiz yuboriladi (kechki anons rejimi: 18:00–23:59).`,
      { parse_mode: 'HTML' }
    );
  }
}

function register(bot) {
  bot.command('jadval', cmdJadval);
  bot.command('hafta', cmdHafta);
  bot.command('xonalar', cmdXonalar);
  bot.command('timetable', cmdTimetable);
  bot.command('schedule', cmdTimetable);
  bot.command('notify_settings', cbNotifySettings);

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

  // Notification preference triggers (Legacy + V2)
  bot.action('schedule_notify_settings', cbNotifySettings);
  bot.action('set_pref_both', (ctx) => cbSetPref(ctx, 'both'));
  bot.action('set_pref_morning', (ctx) => cbSetPref(ctx, 'morning'));
  bot.action('set_pref_evening', (ctx) => cbSetPref(ctx, 'evening'));
  bot.action('set_pref_silent', (ctx) => cbSetPref(ctx, 'silent'));

  // Smart Schedule v2 interactive triggers
  bot.action('v2_mode_shift', cbV2ModeShift);
  bot.action('v2_offset_15', (ctx) => cbV2Offset(ctx, 15));
  bot.action('v2_offset_30', (ctx) => cbV2Offset(ctx, 30));
  bot.action('v2_offset_60', (ctx) => cbV2Offset(ctx, 60));
  bot.action('v2_offset_120', (ctx) => cbV2Offset(ctx, 120));
  bot.action('v2_mode_standard', cbV2ModeStandard);
  bot.action('v2_mode_custom', cbV2ModeCustom);
  bot.action('v2_toggle_bell', cbV2ToggleBell);
  bot.action('v2_toggle_bld', cbV2ToggleBld);
  bot.action('v2_mode_disabled', cbV2ModeDisabled);
}


module.exports = {
  register,
  cmdTimetable,
  cbSchedule: cmdTimetable,
  cmdJadval,
  cmdHafta,
  cmdXonalar,
  buildRoomPageKb,
  getPeriodNowAndNext,
  onCustomTimeInput,
};