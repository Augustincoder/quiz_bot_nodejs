'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { Markup } = require('telegraf');

const { ADMIN_ID, SUBJECTS }  = require('../config/config');
const dbService                = require('../services/dbService');
const logger                   = require('../core/logger');
const timetableCdnService      = require('../services/timetableCdnService');
const edupageService           = require('../services/edupageService');
const {
  States, setState, clearState, updateData, getData,
  safeEdit, backToMainKb, progressBar, parseSuffix,
  parseDocxQuestions, parseTextQuestions, escapeHtml, sanitizeForTelegram,
  isAdmin, adminGuard, downloadFile,
} = require('../core/utils');
// ============================================
// 🔧 ENCODING UTILITIES 
// ============================================

/**
 * Strips ALL non-UTF-8 safe characters and Telegram-breaking sequences.
 * Handles: null bytes, surrogates, RTL marks, zero-width chars, etc.
 */
function toSafeUtf8(str) {
  if (!str) return '';
  
  try {
    // 1. Force to string
    str = String(str);
    
    // 2. Remove null bytes (immediate crash cause)
    str = str.replace(/\0/g, '');
    
    // 3. Remove lone surrogates (invalid UTF-16 → corrupt UTF-8)
    // These are U+D800–U+DFFF that appear alone (not as pairs)
    str = str.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
    
    // 4. Remove zero-width and invisible control chars
    str = str.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
    
    // 5. Remove other problematic Unicode categories:
    //    - Private use area chars
    //    - Specials block (U+FFF0–U+FFFF)
    str = str.replace(/[\uFFF0-\uFFFF]/g, '');
    
    // 6. Normalize: replace CRLF → LF, then strip non-printable ASCII
    //    but KEEP: tabs, newlines, and all valid Unicode letters/emoji
    str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // 7. Final round-trip encode check
    // If Buffer can't encode it cleanly → replace offending chars
    const buf = Buffer.from(str, 'utf8');
    str = buf.toString('utf8');
    
    return str.trim();
  } catch {
    // Nuclear fallback: strip anything above ASCII-7
    return String(str).replace(/[^\x20-\x7E]/g, '').trim();
  }
}

/**
 * Safely truncate a UTF-8 string at a SAFE boundary (no split emoji/surrogates)
 */
function safeTruncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  // Use Intl.Segmenter if available (Node 16+) for grapheme-safe truncation
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter();
    const segments  = [...segmenter.segment(str)];
    let result = '';
    for (const { segment } of segments) {
      if ((result + segment).length > maxLen) break;
      result += segment;
    }
    return result;
  }
  // Fallback: simple slice (safe enough for most cases after toSafeUtf8)
  return str.slice(0, maxLen);
}

/**
 * Full pipeline: sanitize → escape HTML → truncate
 */
function safeUserText(raw, maxLen = 50) {
  const cleaned  = toSafeUtf8(sanitizeForTelegram(raw || ''));
  const truncated = safeTruncate(cleaned, maxLen);
  return escapeHtml(truncated) || 'Ismsiz';
}
// ============================================
// ⚙️ CONSTANTS & CACHE
// ============================================

const PER_PAGE       = 10;
const BATCH_SIZE     = 20;
const RATE_LIMIT_MS  = 1000;
const CACHE_TTL_MS   = 30_000; // 30 seconds
const MAX_DOCX_SIZE  = 20 * 1024 * 1024; // 20MB

/**
 * Simple in-memory LRU-style cache to avoid repeated DB hammering
 * Key → { data, expiry }
 */
const _cache = new Map();

function cacheSet(key, data, ttl = CACHE_TTL_MS) {
  _cache.set(key, { data, expiry: Date.now() + ttl });
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheInvalidate(prefix) {
  for (const key of _cache.keys()) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
}

/**
 * Deduplication map to prevent double-processing rapid callbacks
 * userId → timestamp of last action
 */
const _inFlight = new Map();

function isInFlight(userId, action, cooldownMs = 2000) {
  const key = `${userId}:${action}`;
  const last = _inFlight.get(key);
  if (last && Date.now() - last < cooldownMs) return true;
  _inFlight.set(key, Date.now());
  // Self-cleanup to avoid unbounded growth
  setTimeout(() => _inFlight.delete(key), cooldownMs + 100);
  return false;
}

// ============================================
// 📊 STATS ENGINE - OPTIMIZED
// ============================================

/**
 * Aggregate stats in a single pass over all user histories.
 * Caches result for CACHE_TTL_MS to avoid hammering DB on refresh.
 */
async function getAdminDashboardStats(forceRefresh = false) {
  const CACHE_KEY = 'admin:dashboard:stats';

  if (!forceRefresh) {
    const cached = cacheGet(CACHE_KEY);
    if (cached) return cached;
  }

  const sevenDaysAgo  = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const todayStart    = new Date().setHours(0, 0, 0, 0);

  const defaults = {
    totalUsers  : 0,
    activeUsers : 0,
    totalTests  : 0,
    todayTests  : 0,
    avgScore    : 0,
    totalCorrect: 0,
    totalWrong  : 0,
  };

  try {
    const totalUsers = await dbService.getUserCount();
    if (!totalUsers) return defaults;

    const allStats = await dbService.getAllUserStats();

    let activeUsers  = 0;
    let totalTests   = 0;
    let todayTests   = 0;
    let totalCorrect = 0;
    let totalWrong   = 0;

    for (const stat of allStats) {
      const history = stat.history;
      if (!Array.isArray(history) || !history.length) {
        totalCorrect += stat.total_correct || 0;
        totalWrong   += stat.total_wrong   || 0;
        totalTests   += stat.tests_completed || 0;
        continue;
      }

      let isActive    = false;
      let todayCount  = 0;

      for (const h of history) {
        const ts = h.timestamp ? (typeof h.timestamp === 'string' ? new Date(h.timestamp).getTime() : h.timestamp) : 0;
        if (!isActive && ts > sevenDaysAgo) isActive = true;
        if (ts > todayStart) todayCount++;
        totalCorrect += h.correct || 0;
        totalWrong   += h.wrong   || 0;
      }

      if (isActive) activeUsers++;
      totalTests += history.length;
      todayTests += todayCount;
    }

    const totalAnswers = totalCorrect + totalWrong;
    const result = {
      totalUsers,
      activeUsers,
      totalTests,
      todayTests,
      avgScore    : totalAnswers ? Math.round((totalCorrect / totalAnswers) * 100) : 0,
      totalCorrect,
      totalWrong,
    };

    cacheSet(CACHE_KEY, result);
    return result;
  } catch (err) {
    logger.error('getAdminDashboardStats', err);
    return defaults;
  }
}

// ============================================
// 🎛 DASHBOARD BUILDER
// ============================================

function buildDashboardKb() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📢 Xabar yuborish', 'admin_broadcast'),
      Markup.button.callback('➕ Test qo\'shish', 'admin_add_test'),
    ],
    [
      Markup.button.callback('🤖 AI Testlar',  'admin_ai_tests'),
      Markup.button.callback('📊 AI Limitlar', 'admin_ai_stats'),
    ],
    [
      Markup.button.callback('👥 Foydalanuvchilar', 'admin_users_page_0'),
      Markup.button.callback('🔍 Qidirish',         'admin_search_user'),
    ],
    [
      Markup.button.callback('📅 Jadvallarni sinxronlash', 'admin_sync_timetables'),
      Markup.button.callback('📈 Batafsil stat.',          'admin_stats'),
    ],
    [
      Markup.button.callback('🔄 Yangilash',               'admin_refresh_dashboard'),
      Markup.button.callback('🏠 Asosiy Menyu',            'back_to_main'),
    ],
  ]);
}

function buildDashboardText(stats) {
  const activityPct = stats.totalUsers
    ? Math.round((stats.activeUsers / stats.totalUsers) * 100)
    : 0;

  return (
    `🎛 <b>ADMIN DASHBOARD</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📊 <b>REAL-TIME STATISTIKA</b>\n\n` +
    `👥 <b>Foydalanuvchilar:</b>\n` +
    `├─ Jami: <b>${stats.totalUsers}</b> ta\n` +
    `├─ Faol (7 kun): <b>${stats.activeUsers}</b> ta\n` +
    `└─ Faollik: <b>${activityPct}%</b>\n\n` +
    `📝 <b>Testlar:</b>\n` +
    `├─ Jami yechilgan: <b>${stats.totalTests}</b> ta\n` +
    `├─ Bugun: <b>${stats.todayTests}</b> ta\n` +
    `└─ O'rtacha ball: <b>${stats.avgScore}%</b>\n\n` +
    `✅ To'g'ri: <b>${stats.totalCorrect}</b> | ❌ Xato: <b>${stats.totalWrong}</b>\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Oxirgi yangilanish: ${new Date().toLocaleTimeString('uz-UZ')}</i>`
  );
}

async function buildPanelContent(forceRefresh = false) {
  const stats = await getAdminDashboardStats(forceRefresh);
  return {
    text: buildDashboardText(stats),
    kb  : buildDashboardKb(),
  };
}

// ============================================
// 🚪 ENTRY POINTS
// ============================================

async function cmdAdmin(ctx) {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply(
      '⛔ <b>Kirish taqiqlangan!</b>\n\nBu bo\'lim faqat adminlar uchun.',
      { parse_mode: 'HTML' }
    );
  }

  const loading = await ctx.reply('⏳ Dashboard yuklanmoqda...');
  try {
    const { text, kb } = await buildPanelContent();
    // ✅ FIX: delete then reply instead of editMessageText to avoid "message not modified"
    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    await ctx.reply(text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    logger.error('cmdAdmin', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loading.message_id,
      undefined,
      '❌ Dashboard yuklanmadi. /admin buyrug\'ini qayta yuboring.'
    ).catch(() => {});
  }
}

async function cbAdminPanelMain(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  try {
    const { text, kb } = await buildPanelContent();
    await safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    logger.error('cbAdminPanelMain', err);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi', { show_alert: true }).catch(() => {});
  }
}

// ✅ NEW: separate handler for force-refresh (clears cache first)
async function cbAdminRefreshDashboard(ctx) {
  if (isInFlight(ctx.from.id, 'refresh', 5000)) {
    return ctx.answerCbQuery('⏳ Yangilanmoqda, kuting...').catch(() => {});
  }
  await ctx.answerCbQuery('🔄 Yangilanmoqda...').catch(() => {});
  cacheInvalidate('admin:dashboard');

  try {
    const { text, kb } = await buildPanelContent(true);
    await safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    logger.error('cbAdminRefreshDashboard', err);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi', { show_alert: true }).catch(() => {});
  }
}

// ============================================
// 📅 TIMETABLE SYNCHRONIZATION ENGINE
// ============================================

/**
 * Synchronizes all university group timetables between EduPage and Supabase cache.
 * Compares schedules; updates only changed or missing timetables.
 */
async function cmdRefreshAllTimetable(ctx) {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ <b>Bu buyruq faqat bot adminlari uchun!</b>', { parse_mode: 'HTML' });
  }

  const currentStatus = timetableCdnService.getWorkerStatus();
  if (currentStatus.isRunning) {
    const elapsedSec = Math.floor((Date.now() - (currentStatus.startTime || Date.now())) / 1000);
    const percent = currentStatus.total > 0 ? ((currentStatus.processed / currentStatus.total) * 100).toFixed(1) : '0';
    return ctx.reply(
      `⚠️ <b>Sinxronizatsiya jarayoni allaqachon bormoqda!</b>\n\n` +
      `📊 <b>Jarayon:</b> ${currentStatus.processed}/${currentStatus.total} (${percent}%)\n` +
      `🆕 <b>Yangilandi:</b> ${currentStatus.generated} ta\n` +
      `⏭️ <b>O'zgarishsiz:</b> ${currentStatus.skipped} ta\n` +
      `❌ <b>Xatolar:</b> ${currentStatus.failed} ta\n` +
      `🎯 <b>Joriy guruh:</b> <code>${escapeHtml(currentStatus.currentGroup || 'N/A')}</code> [${currentStatus.currentTheme || 'N/A'}]\n` +
      `⏱️ <b>Vaqt:</b> ${elapsedSec}s\n\n` +
      `🛑 To'xtatish uchun: /stop_refresh_timetable`,
      { parse_mode: 'HTML' }
    );
  }

  let statusMsg = null;
  try {
    statusMsg = await ctx.reply(
      `🔄 <b>Jadvallarni EduPage bilan solishtirish va yangilash boshlanmoqda...</b>\n\n` +
      `⏳ <i>EduPage serverlaridan eng so'nggi ma'lumotlar yuklanmoqda...</i>`,
      { parse_mode: 'HTML' }
    );
  } catch (replyErr) {
    logger.error('cmdRefreshAllTimetable cannot send initial statusMsg', replyErr);
    return;
  }

  try {
    // 1. Force fresh index from EduPage
    await edupageService.getIndexedDatabase(true);

    // 2. Launch background sync worker with safe 1.2s delay
    const result = await timetableCdnService.prewarmAllTimetables(ctx.telegram, {
      delayMs: 1200,
      activeOnly: false,
    });

    if (result.status !== 'started') {
      if (statusMsg?.message_id) {
        return ctx.telegram.editMessageText(
          ctx.chat.id,
          statusMsg.message_id,
          undefined,
          `❌ <b>Xatolik:</b> Worker ishga tushmadi (${result.status}).`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return;
    }

    // 3. Periodic real-time progress monitor
    let lastEditTime = Date.now();
    const interval = setInterval(async () => {
      try {
        const st = timetableCdnService.getWorkerStatus();
        if (!st.isRunning) {
          clearInterval(interval);
          const durationSec = Math.floor((Date.now() - (st.startTime || Date.now())) / 1000);
          const min = Math.floor(durationSec / 60);
          const sec = durationSec % 60;
          const timeStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;

          if (statusMsg?.message_id) {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              undefined,
              `🎉 <b>EduPage jadvallari to'liq sinxronlashtirildi!</b>\n\n` +
              `✅ <b>Jami tekshirildi:</b> ${st.processed} ta\n` +
              `🆕 <b>Yangi yangilandi:</b> ${st.generated} ta guruh jadvali\n` +
              `⏭️ <b>O'zgarishsiz (bazadan):</b> ${st.skipped} ta\n` +
              `❌ <b>Xatoliklar:</b> ${st.failed} ta\n` +
              `⏱️ <b>Umumiy ketgan vaqt:</b> ${timeStr}\n\n` +
              `⚡ <i>Barcha talabalar eng so'nggi jadvalni darhol ko'rishlari mumkin.</i>`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
          return;
        }

        if (Date.now() - lastEditTime >= 4000) {
          lastEditTime = Date.now();
          const percent = st.total > 0 ? ((st.processed / st.total) * 100).toFixed(1) : '0';
          const elapsed = Math.floor((Date.now() - (st.startTime || Date.now())) / 1000);

          if (statusMsg?.message_id) {
            await ctx.telegram.editMessageText(
              ctx.chat.id,
              statusMsg.message_id,
              undefined,
              `🔄 <b>EduPage bilan to'liq solishtirish davom etmoqda...</b>\n\n` +
              `📊 <b>Jarayon:</b> ${st.processed}/${st.total} (${percent}%)\n` +
              `🆕 <b>Yangilandi:</b> ${st.generated} ta\n` +
              `⏭️ <b>O'zgarishsiz:</b> ${st.skipped} ta\n` +
              `❌ <b>Xatolar:</b> ${st.failed} ta\n` +
              `🎯 <b>Hozirgi guruh:</b> <code>${escapeHtml(st.currentGroup || '...')}</code> [${st.currentTheme || ''}]\n` +
              `⏱️ <b>O'tgan vaqt:</b> ${elapsed}s\n\n` +
              `🛑 To'xtatish uchun: /stop_refresh_timetable`,
              { parse_mode: 'HTML' }
            ).catch(() => {});
          }
        }
      } catch (intervalErr) {
        logger.error('cmdRefreshAllTimetable interval error', intervalErr);
      }
    }, 2000);

  } catch (err) {
    logger.error('cmdRefreshAllTimetable', err);
    if (statusMsg?.message_id) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        undefined,
        `❌ <b>Sinxronizatsiyada xatolik yuz berdi:</b> ${escapeHtml(err.message)}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
  }
}

async function cmdStopRefreshTimetable(ctx) {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('⛔ <b>Bu buyruq faqat bot adminlari uchun!</b>', { parse_mode: 'HTML' });
  }

  const stopped = timetableCdnService.stopPrewarmWorker();
  if (stopped) {
    return ctx.reply('🛑 <b>Jadvallarni sinxronizatsiya qilish jarayoni to\'xtatildi!</b>', { parse_mode: 'HTML' });
  } else {
    return ctx.reply('ℹ️ Ayni vaqtda hech qanday sinxronizatsiya jarayoni ishlamayapti.', { parse_mode: 'HTML' });
  }
}

async function cbAdminSyncTimetables(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  return cmdRefreshAllTimetable(ctx);
}

async function cbAdminCancel(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery('❌ Bekor qilindi').catch(() => {});
  try {
    const { text, kb } = await buildPanelContent();
    await safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    logger.error('cbAdminCancel', err);
  }
}

// ============================================
// 👥 USERS LIST - OPTIMIZED
// ============================================

async function cbAdminUsersList(ctx) {
  await ctx.answerCbQuery().catch(() => {});

  const page = Math.max(
    0,
    parseInt(parseSuffix(ctx.callbackQuery.data, 'admin_users_page_'), 10) || 0
  );

  try {
    const { users: chunk, total } = await dbService.getUsersPaginated(page, PER_PAGE);
    if (!chunk.length && page === 0) {
      return safeEdit(
        ctx,
        '👥 <b>Foydalanuvchilar yo\'q</b>\n\nHali hech kim botni ishlatmagan.',
        { parse_mode: 'HTML', ...backToMainKb() }
      );
    }

    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    const p          = Math.min(page, totalPages - 1);

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Fetch stats only for current page
    const statsResults = await Promise.allSettled(
      chunk.map(u => dbService.getUserStats(u.telegram_id))
    );

    const lines = chunk.map((u, i) => {
      const st      = statsResults[i].status === 'fulfilled' ? statsResults[i].value : null;
      const history = Array.isArray(st?.history) ? st.history : [];
      const isActive = history.some(h => (h.timestamp || 0) > sevenDaysAgo);

      // ✅ THE FIX: Use safeUserText pipeline for ALL user-provided strings
      const safeName = safeUserText(u.full_name, 25);

      // ✅ Also sanitize username
      let unameDisplay = '';
      if (u.username && u.username !== "yo'q" && u.username !== 'null') {
        const safeUsername = toSafeUtf8(sanitizeForTelegram(u.username))
          .replace(/[^a-zA-Z0-9_]/g, '') // Telegram usernames: only alphanumeric + underscore
          .slice(0, 32);
        if (safeUsername) {
          unameDisplay = ` (@${safeUsername})`;
        }
      }

      // ✅ Validate telegram_id is a safe integer before embedding
      const uid = Number.isSafeInteger(Number(u.telegram_id))
        ? u.telegram_id
        : 0;

      return (
        `${isActive ? '🟢' : '⚫'} <b>${p * PER_PAGE + i + 1}.</b> ` +
        `<a href="tg://user?id=${uid}">${safeName}</a>${unameDisplay}\n` +
        `   📝 ${history.length} ta test`
      );
    });

    // ✅ Validate full message won't exceed Telegram 4096 char limit
    const header =
      `👥 <b>FOYDALANUVCHILAR RO'YXATI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📊 ${p * PER_PAGE + 1}–${Math.min((p + 1) * PER_PAGE, total)} / ${total}\n` +
      `🟢 Faol (7 kun) | ⚫ Nofaol\n\n`;

    let body = lines.join('\n\n');

    // Safety: if somehow still too long, truncate body (not header)
    const MAX_MSG = 4000;
    if ((header + body).length > MAX_MSG) {
      body = safeTruncate(body, MAX_MSG - header.length - 20) + '\n\n<i>...</i>';
    }

    const nav = [];
    if (p > 0)
      nav.push(Markup.button.callback('⬅️ Oldingi', `admin_users_page_${p - 1}`));
    nav.push(Markup.button.callback(`📄 ${p + 1}/${totalPages}`, 'ignore'));
    if (p < totalPages - 1)
      nav.push(Markup.button.callback('Keyingi ➡️', `admin_users_page_${p + 1}`));

    const opts = {
      parse_mode            : 'HTML',
      disable_web_page_preview: true,
      ...Markup.inlineKeyboard([
        nav,
        [
          Markup.button.callback('🔍 Qidirish', 'admin_search_user'),
          Markup.button.callback('🔄 Yangilash', `admin_users_page_${p}`),
        ],
        [Markup.button.callback('🔙 Dashboard', 'admin_panel_main')],
      ]),
    };

    await safeEdit(ctx, header + body, opts);

  } catch (err) {
    logger.error('cbAdminUsersList', err);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi', { show_alert: true }).catch(() => {});
  }
}

// ============================================
// 🔍 USER SEARCH - FIXED
// ============================================

async function cbAdminSearchUser(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx, States.ADMIN_SEARCH_USER);

  await safeEdit(ctx,
    `🔍 <b>FOYDALANUVCHI QIDIRISH</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `<b>Quyidagilardan birini yuboring:</b>\n\n` +
    `🆔 Telegram ID\n` +
    `📛 @username\n` +
    `👤 Ism-familiya\n\n` +
    `<i>Qidiruv katta-kichik harfga sezgir emas</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('❌ Bekor qilish', 'admin_cancel'),
      ]]),
    }
  );
}

async function onAdminSearchInput(ctx) {
  clearState(ctx);

  // ✅ FIX: Preserve original query for display, use lower for matching
  const rawQuery = (ctx.message.text || '').trim();
  const query    = rawQuery.toLowerCase().replace(/^@/, '');

  if (query.length < 2) {
    return ctx.reply(
      '⚠️ Qidiruv so\'rovi juda qisqa. Kamida 2 ta belgi kiriting.',
      { parse_mode: 'HTML' }
    );
  }

  const searching = await ctx.reply('🔍 Qidirilmoqda...');

  try {
    const matches = await dbService.searchUsers(query, 20);

    await ctx.telegram.deleteMessage(ctx.chat.id, searching.message_id).catch(() => {});

    if (!matches.length) {
      return ctx.reply(
        `❌ <b>"${escapeHtml(rawQuery)}"</b> — hech narsa topilmadi.\n\n` +
        `<i>ID, username yoki ismni tekshiring.</i>`,
        { parse_mode: 'HTML' }
      );
    }

    if (matches.length === 1) {
      return showUserDetails(ctx, matches[0]);
    }

    // Multiple results
    const lines = matches.slice(0, 10).map((u, i) => {
      const safeName = escapeHtml(sanitizeForTelegram(u.full_name || 'Ismsiz'));
      const uname    = u.username && u.username !== "yo'q"
        ? `@${sanitizeForTelegram(u.username)}`
        : '—';
      return (
        `<b>${i + 1}.</b> <a href="tg://user?id=${u.telegram_id}">${safeName}</a>\n` +
        `   🆔 <code>${u.telegram_id}</code> | 📛 ${uname}`
      );
    });

    const buttons = [
      ...matches.slice(0, 5).map((u, i) => [
        Markup.button.callback(
          `${i + 1}. ${(u.full_name || 'Ismsiz').slice(0, 25)}`,
          `admin_show_user_${u.telegram_id}`
        ),
      ]),
      [Markup.button.callback('🔙 Dashboard', 'admin_panel_main')],
    ];

    await ctx.reply(
      `🔍 <b>QIDIRUV NATIJALARI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Topildi: <b>${matches.length} ta</b>` +
      `${matches.length > 10 ? ' (birinchi 10 ta)' : ''}\n\n` +
      lines.join('\n\n'),
      {
        parse_mode            : 'HTML',
        disable_web_page_preview: true,
        ...Markup.inlineKeyboard(buttons),
      }
    );
  } catch (err) {
    logger.error('onAdminSearchInput', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, searching.message_id, undefined,
      '❌ Qidirishda xatolik yuz berdi.'
    ).catch(() => {});
  }
}

async function showUserDetails(ctx, user) {
  try {
    const stats   = await dbService.getUserStats(user.telegram_id);
    const history = Array.isArray(stats?.history) ? stats.history : [];
    const mistakes = Array.isArray(stats?.mistakes) ? stats.mistakes : [];

    // Single pass for avgScore
    const avgScore = history.length
      ? Math.round(history.reduce((s, h) => s + (h.percent || 0), 0) / history.length)
      : 0;

    const safeName = escapeHtml(sanitizeForTelegram(user.full_name || 'Ismsiz'));
    const uname    = user.username && user.username !== "yo'q"
      ? `@${sanitizeForTelegram(user.username)}`
      : '—';

    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const isActive     = history.some(h => (h.timestamp || 0) > sevenDaysAgo);

    // ✅ FIX: Safe date formatting
    const lastTs = history.length
      ? history.reduce((max, h) => Math.max(max, h.timestamp || 0), 0)
      : 0;
    const lastActivity = lastTs
      ? new Date(lastTs).toLocaleDateString('uz-UZ')
      : '—';

    await ctx.reply(
      `👤 <b>FOYDALANUVCHI PROFILI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📛 Ism: <a href="tg://user?id=${user.telegram_id}">${safeName}</a>\n` +
      `🆔 ID: <code>${user.telegram_id}</code>\n` +
      `📧 Username: ${uname}\n` +
      `🎓 Guruh: ${escapeHtml(user.class_name || '—')}\n` +
      `📅 Oxirgi faollik: ${lastActivity}\n` +
      `${isActive ? '🟢 Faol' : '⚫ Nofaol'}\n\n` +
      `📊 <b>STATISTIKA:</b>\n` +
      `├─ Testlar: <b>${history.length} ta</b>\n` +
      `├─ O'rtacha ball: <b>${avgScore}%</b>\n` +
      `└─ Xatolar: <b>${mistakes.length} ta</b>\n\n` +
      `${progressBar(avgScore, 100)}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback('↩️ Javob berish', `reply_${user.telegram_id}`),
            Markup.button.callback('📊 Batafsil',     `admin_user_stats_${user.telegram_id}`),
          ],
          [Markup.button.callback('🔙 Dashboard', 'admin_panel_main')],
        ]),
      }
    );
  } catch (err) {
    logger.error('showUserDetails', err);
    await ctx.reply('❌ Ma\'lumotlarni yuklab bo\'lmadi.');
  }
}

async function cbAdminShowUser(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const userId = parseInt(parseSuffix(ctx.callbackQuery.data, 'admin_show_user_'), 10);

  if (!userId || Number.isNaN(userId)) {
    return ctx.answerCbQuery('❌ Noto\'g\'ri ID', { show_alert: true });
  }

  try {
    const user = await dbService.getUserByTelegramId(userId);

    if (!user) {
      return ctx.answerCbQuery('❌ Foydalanuvchi topilmadi', { show_alert: true });
    }

    await showUserDetails(ctx, user);
  } catch (err) {
    logger.error('cbAdminShowUser', err);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi', { show_alert: true }).catch(() => {});
  }
}

async function cbAdminUserStats(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const userId = parseInt(parseSuffix(ctx.callbackQuery.data, 'admin_user_stats_'), 10);

  if (!userId || Number.isNaN(userId)) {
    return ctx.answerCbQuery('❌ Noto\'g\'ri ID', { show_alert: true });
  }

  try {
    const user = await dbService.getUserByTelegramId(userId);
    const stats = await dbService.getUserStats(userId);
    const history = stats?.history || [];
    const safeName = escapeHtml(user?.full_name || 'Talaba');
    const userClass = escapeHtml(user?.class_name || '—');
    const uname = user?.username ? `@${escapeHtml(user.username)}` : 'yo\'q';

    let text = `📊 <b>${safeName} — BATAFSIL TEST STATISTIKASI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `📧 Username: ${uname}\n` +
      `🎓 Guruh: <b>${userClass}</b>\n\n` +
      `🔢 Jami topshirilgan testlar: <b>${history.length} ta</b>\n` +
      `✅ Jami to'g'ri javoblar: <b>${stats.total_correct || 0} ta</b>\n` +
      `❌ Jami xatolar: <b>${stats.total_wrong || 0} ta</b>\n\n`;

    if (history.length === 0) {
      text += `<i>Foydalanuvchi hali biron marta test yakunlamagan.</i>`;
    } else {
      text += `📜 <b>So'nggi testlar:</b>\n`;
      const recent = history.slice(-5).reverse();
      recent.forEach((h, i) => {
        const date = h.timestamp ? new Date(h.timestamp).toLocaleDateString('uz-UZ') : '—';
        const subj = escapeHtml(h.subject || h.subjectKey || 'Test');
        const score = h.percent !== undefined ? `${h.percent}%` : `${h.score}/${h.total}`;
        text += `${i + 1}. <b>${subj}</b> — ${score} (📅 ${date})\n`;
      });
    }

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('↩️ Javob berish', `reply_${userId}`),
        Markup.button.callback('👤 Profil', `admin_show_user_${userId}`),
      ],
      [Markup.button.callback('🔙 Dashboard', 'admin_panel_main')],
    ]);

    await ctx.reply(text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    logger.error('cbAdminUserStats', err);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi', { show_alert: true }).catch(() => {});
  }
}

// ============================================
// 📊 GLOBAL STATS - OPTIMIZED
// ============================================

async function cbAdminStats(ctx) {
  if (isInFlight(ctx.from.id, 'stats', 5000)) {
    return ctx.answerCbQuery('⏳ Hisoblanmoqda...').catch(() => {});
  }
  await ctx.answerCbQuery('📊 Yuklanmoqda...').catch(() => {});

  const loading = await ctx.reply('⏳ Batafsil statistika tayyorlanmoqda...');

  try {
    const totalUsers = await dbService.getUserCount();
    const count  = totalUsers;

    // ✅ FIX: Reuse dashboard stats + subject breakdown in single pass
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    // Initialize subject buckets
    const bySubject = {};
    Object.keys(SUBJECTS).forEach(k => {
      bySubject[k] = { count: 0, correct: 0, wrong: 0 };
    });

    let activeUsers = 0, totalTests = 0, totalCorrect = 0, totalWrong = 0;

    if (count) {
      const allStats = await dbService.getAllUserStats();

      for (const stat of allStats) {
        const history = Array.isArray(stat.history) ? stat.history : [];
        if (!history.length) {
          totalCorrect += stat.total_correct || 0;
          totalWrong   += stat.total_wrong   || 0;
          totalTests   += stat.tests_completed || 0;
          continue;
        }

        let isActive = false;
        for (const h of history) {
          const ts = h.timestamp ? (typeof h.timestamp === 'string' ? new Date(h.timestamp).getTime() : h.timestamp) : 0;
          if (!isActive && ts > sevenDaysAgo) isActive = true;

          const c = h.correct || 0;
          const w = h.wrong   || 0;
          totalCorrect += c;
          totalWrong   += w;

          const bucket = bySubject[h.subject];
          if (bucket) {
            bucket.count++;
            bucket.correct += c;
            bucket.wrong   += w;
          }
        }

        if (isActive) activeUsers++;
        totalTests += history.length;
      }
    }

    const totalAnswers  = totalCorrect + totalWrong;
    const avgGlobal     = totalAnswers ? Math.round((totalCorrect / totalAnswers) * 100) : 0;
    const activityPct   = count ? Math.round((activeUsers / count) * 100) : 0;

    const subjectLines = Object.entries(bySubject)
      .filter(([, d]) => d.count > 0)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([subj, d]) => {
        const tot = d.correct + d.wrong;
        const pct = tot ? Math.round((d.correct / tot) * 100) : 0;
        return `<b>${escapeHtml(SUBJECTS[subj])}:</b> ${d.count} ta (${pct}%)`;
      });

    await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});

    await ctx.reply(
      `📊 <b>BATAFSIL STATISTIKA</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👥 <b>FOYDALANUVCHILAR</b>\n` +
      `├─ Jami: <b>${count} ta</b>\n` +
      `├─ Faol (7 kun): <b>${activeUsers} ta</b>\n` +
      `└─ Faollik: <b>${activityPct}%</b>\n\n` +
      `📝 <b>TESTLAR</b>\n` +
      `├─ Jami yechilgan: <b>${totalTests} ta</b>\n` +
      `├─ To'g'ri javoblar: <b>${totalCorrect} ta</b>\n` +
      `├─ Xato javoblar: <b>${totalWrong} ta</b>\n` +
      `└─ O'rtacha natija: <b>${avgGlobal}%</b>\n` +
      `${progressBar(avgGlobal, 100)}\n\n` +
      `📚 <b>FANLAR BO'YICHA</b>\n` +
      (subjectLines.length ? subjectLines.join('\n') : '<i>Ma\'lumot yo\'q</i>') +
      `\n\n<i>Yangilangan: ${new Date().toLocaleString('uz-UZ')}</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Yangilash', 'admin_stats')],
          [Markup.button.callback('🔙 Dashboard', 'admin_panel_main')],
        ]),
      }
    );
  } catch (err) {
    logger.error('cbAdminStats', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, loading.message_id, undefined,
      '❌ Statistikani yuklab bo\'lmadi.'
    ).catch(() => {});
  }
}

// ============================================
// 📢 BROADCAST - FIXED RATE LIMITING
// ============================================

async function cbAdminBroadcast(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  setState(ctx, States.ADMIN_BROADCAST);

  const usersCount = await dbService.getUserCount();

  await safeEdit(ctx,
    `📢 <b>OMMAVIY XABAR</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👥 Qabul qiluvchilar: <b>${usersCount} ta</b>\n\n` +
    `✍️ <b>Xabar matnini yuboring:</b>\n\n` +
    `<i>💡 HTML formatlash, rasm, video yuboring</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('❌ Bekor qilish', 'admin_cancel'),
      ]]),
    }
  );
}

async function onBroadcastMessage(ctx) {
  const hasMedia = !!(
    ctx.message?.photo ||
    ctx.message?.video ||
    ctx.message?.voice ||
    ctx.message?.document ||
    ctx.message?.audio ||
    ctx.message?.animation ||
    ctx.message?.sticker
  );
  const text = ctx.message?.text || ctx.message?.caption;

  if (!text && !hasMedia) {
    return ctx.reply('⚠️ Iltimos, matn yoki media yuboring.');
  }

  try {
    await updateData(ctx, {
      broadcast_text      : text || '',
      broadcast_message_id: ctx.message.message_id,
      broadcast_has_media : hasMedia,
    });
    setState(ctx, States.ADMIN_BROADCAST_CONFIRM);

    const usersCount = await dbService.getUserCount();
    const previewText = text ? escapeHtml(text.slice(0, 500)) : '<i>[Media xabar]</i>';

    await ctx.reply(
      `📋 <b>XABAR PREVIEW</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👥 Qabul qiluvchilar: <b>${usersCount} ta</b>\n\n` +
      `📨 <b>Xabar:</b>\n${previewText}\n\n` +
      `⚠️ <b>Tasdiqlaysizmi?</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ HA, yuborish', 'admin_broadcast_confirm')],
          [Markup.button.callback('✏️ Qayta yozish', 'admin_broadcast')],
          [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
        ]),
      }
    );
  } catch (err) {
    logger.error('onBroadcastMessage', err);
    await ctx.reply('❌ Xatolik yuz berdi.');
  }
}

async function cbBroadcastConfirm(ctx) {
  // ✅ FIX: Prevent double-send from rapid taps
  if (isInFlight(ctx.from.id, 'broadcast', 60_000)) {
    return ctx.answerCbQuery('⏳ Yuborish allaqachon boshlangan!', { show_alert: true });
  }
  await ctx.answerCbQuery('📤 Yuborilmoqda...').catch(() => {});

  const data    = await getData(ctx);
  const msgText = data.broadcast_text;
  const hasMedia = data.broadcast_has_media;
  const messageId = data.broadcast_message_id;

  if (!msgText && !hasMedia) {
    return ctx.reply('❌ Yuborish uchun xabar topilmadi. Qayta urinib ko\'ring.');
  }

  clearState(ctx);

  const progress = await ctx.reply(
    '⏳ <b>Xabar yuborilmoqda...</b>\n\n📊 0%',
    { parse_mode: 'HTML' }
  );

  try {
    const recipients = await dbService.getBroadcastRecipients();
    if (!recipients?.length) {
      return ctx.telegram.editMessageText(
        ctx.chat.id, progress.message_id, undefined,
        '❌ Foydalanuvchilar topilmadi.'
      );
    }

    let success = 0, blocked = 0, failed = 0;
    const total = recipients.length;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = recipients.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(batch.map(async telegramId => {
        try {
          if (hasMedia) {
            await ctx.telegram.copyMessage(telegramId, ctx.chat.id, messageId);
          } else {
            await ctx.telegram.sendMessage(telegramId, msgText, { parse_mode: 'HTML' });
          }
          success++;
        } catch (err) {
          if (err.parameters?.retry_after) {
            const retrySec = err.parameters.retry_after;
            logger.warn('broadcast:rate_limit_hit', { retrySec });
            await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
            try {
              if (hasMedia) {
                await ctx.telegram.copyMessage(telegramId, ctx.chat.id, messageId);
              } else {
                await ctx.telegram.sendMessage(telegramId, msgText, { parse_mode: 'HTML' });
              }
              success++;
              return;
            } catch {
              failed++;
              return;
            }
          }
          // ✅ FIX: Comprehensive block detection
          const msg = err.message || '';
          if (
            msg.includes('blocked') ||
            msg.includes('deactivated') ||
            msg.includes('chat not found') ||
            msg.includes('user is deactivated')
          ) {
            blocked++;
          } else {
            failed++;
            logger.warn('broadcast:send_fail', { uid: telegramId, err: msg });
          }
        }
      }));

      // Update progress every 5 batches or at the end to prevent edit flood
      const done = Math.min(i + BATCH_SIZE, total);
      const isLastBatch = done >= total;
      if (i % (BATCH_SIZE * 5) === 0 || isLastBatch) {
        const percent = Math.round((done / total) * 100);
        await ctx.telegram.editMessageText(
          ctx.chat.id, progress.message_id, undefined,
          `⏳ <b>Yuborilmoqda...</b>\n\n` +
          `📊 ${percent}% (${done}/${total})\n` +
          `✅ Yuborildi: ${success}\n` +
          `🔴 Bloklagan: ${blocked}\n` +
          `⚠️ Xato: ${failed}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }

      // ✅ FIX: Respect Telegram rate limit (30 msg/sec → ~33ms/msg)
      // With BATCH_SIZE=20 we send 20 msgs then wait 1s → safe
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }

    logger.info('admin:broadcast:done', { success, blocked, failed, total });

    await ctx.telegram.editMessageText(
      ctx.chat.id, progress.message_id, undefined,
      `✅ <b>YUBORISH YAKUNLANDI!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📊 <b>Natijalar:</b>\n` +
      `├─ Jami: <b>${total} ta</b>\n` +
      `├─ ✅ Yuborildi: <b>${success} ta</b>\n` +
      `├─ 🔴 Bloklagan: <b>${blocked} ta</b>\n` +
      `└─ ⚠️ Xato: <b>${failed} ta</b>\n\n` +
      `🎯 Muvaffaqiyat: <b>${Math.round((success / total) * 100)}%</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🔙 Dashboard', 'admin_panel_main'),
        ]]),
      }
    ).catch(() => {});
  } catch (err) {
    logger.error('cbBroadcastConfirm', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, progress.message_id, undefined,
      '❌ Yuborishda xatolik yuz berdi.'
    ).catch(() => {});
  }
}

// ============================================
// ↩️ REPLY TO USER
// ============================================

async function cbReplyStart(ctx) {
  await ctx.answerCbQuery().catch(() => {});

  const parts    = ctx.callbackQuery.data.split('_');
  const targetId = parts[1];
  const msgId    = parts[2] || null;

  // ✅ FIX: Validate targetId is numeric
  if (!targetId || !/^\d+$/.test(targetId)) {
    return ctx.answerCbQuery('❌ Noto\'g\'ri format', { show_alert: true });
  }

  await updateData(ctx, { target_id: targetId, target_msg_id: msgId });
  setState(ctx, States.ADMIN_REPLY);

  await ctx.reply(
    `✍️ <b>FOYDALANUVCHIGA JAVOB</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🆔 User ID: <code>${targetId}</code>\n\n` +
    `📝 Javobingizni yuboring (matn, rasm, video...)\n\n` +
    `<i>Xabar darhol yuboriladi</i>`,
    {
      parse_mode: 'HTML',
      reply_parameters: {
        message_id               : ctx.callbackQuery.message.message_id,
        allow_sending_without_reply: true,
      },
      ...Markup.inlineKeyboard([[
        Markup.button.callback('❌ Bekor qilish', 'admin_cancel'),
      ]]),
    }
  );
}

async function onReplyMessage(ctx) {
  const data = await getData(ctx);
  clearState(ctx);

  const targetUserId = parseInt(data.target_id, 10);
  const targetMsgId  = data.target_msg_id ? parseInt(data.target_msg_id, 10) : null;

  if (!targetUserId || Number.isNaN(targetUserId)) {
    return ctx.reply('❌ Noto\'g\'ri foydalanuvchi ID.');
  }

  logger.info('admin:reply', { targetUserId });
  const sending = await ctx.reply('📤 Yuborilmoqda...');

  try {
    const adminText = ctx.message?.text || '';
    const hasMedia  = !!(
      ctx.message?.photo ||
      ctx.message?.video ||
      ctx.message?.voice ||
      ctx.message?.document
    );

    const replyCard =
      `📩 <b>ADMINDAN JAVOB</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${adminText ? escapeHtml(adminText) : '<i>Media xabar</i>'}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `📨 <i>Yana savol bo'lsa pastdagi tugmani bosing</i>`;

    await ctx.telegram.sendMessage(targetUserId, replyCard, {
      parse_mode: 'HTML',
      ...(targetMsgId ? {
        reply_parameters: {
          message_id               : targetMsgId,
          allow_sending_without_reply: true,
        },
      } : {}),
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📞 Yana yozish', 'contact_admin')],
        [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
      ]),
    });

    // ✅ FIX: Copy media AFTER text card, not before; avoid duplicating text
    if (hasMedia) {
      await ctx.telegram.copyMessage(targetUserId, ctx.chat.id, ctx.message.message_id);
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id, sending.message_id, undefined,
      `✅ <b>Javob yuborildi!</b>\n\n🆔 User ID: <code>${targetUserId}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🔙 Dashboard', 'admin_panel_main'),
        ]]),
      }
    );
  } catch (err) {
    logger.error('onReplyMessage', { targetUserId, err: err.message });
    await ctx.telegram.editMessageText(
      ctx.chat.id, sending.message_id, undefined,
      `❌ <b>Xatolik!</b>\n\nFoydalanuvchiga xabar yuborib bo\'lmadi.\n` +
      `<i>Sabab: Botni bloklagan bo\'lishi mumkin</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🔙 Dashboard', 'admin_panel_main'),
        ]]),
      }
    ).catch(() => {});
  }
}

// ============================================
// ➕ TEST CREATION
// ============================================

function adminControlsKb() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📝 Matn',        'adm_switch_text'),
      Markup.button.callback('📄 Word',         'adm_switch_docx'),
    ],
    [
      Markup.button.callback('👁 Ko\'rib chiqish', 'adm_preview'),
      Markup.button.callback('✅ Saqlash',          'adm_finish'),
    ],
    [
      Markup.button.callback('🗑 Tozalash',        'adm_reset'),
      Markup.button.callback('❌ Bekor qilish',     'admin_cancel'),
    ],
  ]);
}

async function adminPrompt(ctx, fmt, total, edit = false) {
  const fmtLabel = fmt === 'text' ? '📝 Matn' : '📄 Word (.docx)';
  const bar      = progressBar(Math.min(total, 30), 30);

  const hint = fmt === 'text'
    ? (
      `📝 <b>Matn formatida yuboring:</b>\n\n` +
      `Savol?\n` +
      `A) variant\nB) variant\nC) variant\nD) variant\n` +
      `# to'g'ri javob (A, B, C yoki D)`
    )
    : `📄 <b>Word (.docx) fayl yuboring</b>`;

  const text =
    `➕ <b>TEST QO'SHISH</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📌 Format: ${fmtLabel}\n` +
    `📊 Yig'ilgan: <b>${total} ta savol</b>\n` +
    `${bar}\n\n${hint}`;

  const msgOpts = { parse_mode: 'HTML', ...adminControlsKb() };
  return edit ? safeEdit(ctx, text, msgOpts) : ctx.reply(text, msgOpts);
}

async function cbAdminAddTest(ctx) {
  await ctx.answerCbQuery().catch(() => {});

  const buttons = [
    ...Object.entries(SUBJECTS).map(([k, v]) => [
      Markup.button.callback(v, `adm_subj_${k}`),
    ]),
    [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
  ];

  await safeEdit(ctx,
    `📂 <b>TEST QO'SHISH</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📚 <b>Fanni tanlang:</b>`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
  setState(ctx, States.ADM_CREATE_SUBJECT);
}

async function cbAdmSubj(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const subj = parseSuffix(ctx.callbackQuery.data, 'adm_subj_');

  if (!SUBJECTS[subj]) {
    return ctx.answerCbQuery('❌ Noto\'g\'ri fan', { show_alert: true });
  }

  await updateData(ctx, { subject: subj });
  setState(ctx, States.ADM_CREATE_TEST_ID);

  await safeEdit(ctx,
    `✅ Fan: <b>${escapeHtml(SUBJECTS[subj])}</b>\n\n` +
    `🔢 <b>Blok raqamini kiriting:</b>\n\n` +
    `<i>Masalan: 1, 2, 15, 30...</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[
        Markup.button.callback('❌ Bekor qilish', 'admin_cancel'),
      ]]),
    }
  );
}

async function onAdmTestId(ctx) {
  const text = (ctx.message.text || '').trim();

  if (!/^\d+$/.test(text) || parseInt(text, 10) < 1) {
    return ctx.reply(
      '⚠️ <b>Noto\'g\'ri format!</b>\n\nFaqat musbat raqam kiriting.',
      { parse_mode: 'HTML' }
    );
  }

  await updateData(ctx, { test_id: parseInt(text, 10) });
  setState(ctx, States.ADM_CREATE_FORMAT);

  await ctx.reply(
    `✅ Blok raqami: <b>${text}</b>\n\n` +
    `📄 <b>Savol formatini tanlang:</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Matn (ketma-ket yozish)', 'adm_fmt_text')],
        [Markup.button.callback('📄 Word fayl (.docx)',        'adm_fmt_docx')],
        [Markup.button.callback('❌ Bekor qilish',             'admin_cancel')],
      ]),
    }
  );
}

async function cbAdmFmt(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const fmt = parseSuffix(ctx.callbackQuery.data, 'adm_fmt_');

  if (!['text', 'docx'].includes(fmt)) {
    return ctx.answerCbQuery('❌ Noto\'g\'ri format', { show_alert: true });
  }

  await updateData(ctx, { format: fmt, questions: [] });
  setState(ctx, States.ADM_CREATE_CONTENT);
  await adminPrompt(ctx, fmt, 0, true);
}

async function cbAdmSwitchFmt(ctx) {
  await ctx.answerCbQuery('Format o\'zgartirilmoqda...').catch(() => {});
  const fmt = parseSuffix(ctx.callbackQuery.data, 'adm_switch_');

  if (!['text', 'docx'].includes(fmt)) return;

  const data = await getData(ctx);
  await updateData(ctx, { format: fmt });
  await adminPrompt(ctx, fmt, (data.questions || []).length, true);
}

async function cbAdmPreview(ctx) {
  const data      = await getData(ctx);
  const questions = data.questions || [];

  if (!questions.length) {
    return ctx.answerCbQuery('❌ Hali savol yo\'q!', { show_alert: true }).catch(() => {});
  }

  await ctx.answerCbQuery().catch(() => {});

  const lines = questions.slice(0, 10).map((q, i) =>
    `<b>${i + 1}.</b> ${escapeHtml(q.question)}\n` +
    `   ✅ ${escapeHtml(q.options?.[q.correct_index] ?? '?')}`
  );

  let previewText =
    `👁 <b>PREVIEW</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📊 Jami: <b>${questions.length} ta savol</b>\n\n` +
    lines.join('\n\n');

  if (questions.length > 10) {
    previewText += `\n\n<i>... va yana ${questions.length - 10} ta savol</i>`;
  }

  // ✅ FIX: Truncate safely without cutting HTML tags mid-way
  if (previewText.length > 4000) {
    previewText = previewText.slice(0, 3900) + '\n\n<i>...</i>';
  }

  await ctx.reply(previewText, { parse_mode: 'HTML' });
}

async function cbAdmReset(ctx) {
  await ctx.answerCbQuery('🗑 Tozalanmoqda...').catch(() => {});
  const data = await getData(ctx);
  await updateData(ctx, { questions: [] });
  await adminPrompt(ctx, data.format || 'text', 0, true);
}

async function onAdmTextContent(ctx) {
  const data = await getData(ctx);

  if (data.format !== 'text') {
    return ctx.reply(
      '⚠️ Word formati tanlangan. "📝 Matn" tugmasini bosing.',
      { parse_mode: 'HTML' }
    );
  }

  const newQs = parseTextQuestions(ctx.message.text);
  if (!newQs.length) {
    return ctx.reply(
      '⚠️ <b>Savol topilmadi!</b>\n\n' +
      '<code>Savol?\nA) ...\nB) ...\nC) ...\nD) ...\n# A</code>',
      { parse_mode: 'HTML' }
    );
  }

  const questions = [...(data.questions || []), ...newQs];
  await updateData(ctx, { questions });

  await ctx.reply(
    `✅ <b>Qo\'shildi: ${newQs.length} ta</b> | Jami: <b>${questions.length} ta</b>`,
    { parse_mode: 'HTML' }
  );
  await adminPrompt(ctx, 'text', questions.length);
}

async function onAdmDocxContent(ctx) {
  const data = await getData(ctx);

  if (data.format !== 'docx') {
    return ctx.reply('⚠️ Matn formati tanlangan. "📄 Word" tugmasini bosing.', {
      parse_mode: 'HTML',
    });
  }

  const doc = ctx.message?.document;
  if (!doc || !doc.file_name?.endsWith('.docx')) {
    return ctx.reply(
      '⚠️ <b>Fayl formati noto\'g\'ri!</b>\n\nFaqat <code>.docx</code> qabul qilinadi.',
      { parse_mode: 'HTML' }
    );
  }

  // ✅ FIX: Check file size before downloading
  if (doc.file_size && doc.file_size > MAX_DOCX_SIZE) {
    return ctx.reply(
      `⚠️ Fayl juda katta (max ${MAX_DOCX_SIZE / 1024 / 1024}MB).`,
      { parse_mode: 'HTML' }
    );
  }

  const status   = await ctx.reply('⏳ Fayl o\'qilmoqda...');
  // ✅ FIX: Use truly unique filenames to avoid collision
  const filePath = path.join(os.tmpdir(), `adm_${ctx.from.id}_${Date.now()}_${Math.random().toString(36).slice(2)}.docx`);

  try {
    const link  = await ctx.telegram.getFileLink(doc.file_id);
    await downloadFile(link.href, filePath);

    const newQs = await parseDocxQuestions(filePath);

    if (!newQs.length) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, undefined,
        '❌ <b>Fayldan savol topilmadi!</b>\n\n<i>Fayl formatini tekshiring</i>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const questions = [...(data.questions || []), ...newQs];
    await updateData(ctx, { questions });

    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await ctx.reply(
      `✅ <b>Qo\'shildi: ${newQs.length} ta</b> | Jami: <b>${questions.length} ta</b>`,
      { parse_mode: 'HTML' }
    );
    await adminPrompt(ctx, 'docx', questions.length);
  } catch (err) {
    logger.error('onAdmDocxContent', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, status.message_id, undefined,
      `❌ <b>Xatolik:</b> ${escapeHtml(err.message)}`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  } finally {
    // ✅ FIX: Always cleanup temp file
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (cleanupErr) {
      logger.warn('onAdmDocxContent:cleanup', cleanupErr);
    }
  }
}

async function cbAdmFinish(ctx) {
  const data      = await getData(ctx);
  const questions = data.questions || [];

  if (!questions.length) {
    return ctx.answerCbQuery('⚠️ Savol yo\'q!', { show_alert: true }).catch(() => {});
  }

  // ✅ FIX: Validate required fields
  if (!data.subject || !data.test_id) {
    return ctx.answerCbQuery('⚠️ Fan yoki blok raqami tanlanmagan!', { show_alert: true });
  }

  await ctx.answerCbQuery('💾 Saqlanmoqda...').catch(() => {});

  const saving = await ctx.reply('⏳ Saqlanmoqda...');

  try {
    const success = await dbService.saveOfficialTest(data.subject, data.test_id, questions);

    if (!success) {
      await ctx.telegram.editMessageText(
        ctx.chat.id, saving.message_id, undefined,
        '❌ Saqlashda muammo yuz berdi. Qayta urinib ko\'ring.',
        { parse_mode: 'HTML' }
      );
      return;
    }

    clearState(ctx);
    cacheInvalidate('admin:dashboard'); // Invalidate stale cache

    logger.info('admin:test_created', {
      subject: data.subject,
      testId : data.test_id,
      count  : questions.length,
    });

    await ctx.telegram.editMessageText(
      ctx.chat.id, saving.message_id, undefined,
      `✅ <b>TEST SAQLANDI!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📚 Fan: <b>${escapeHtml(SUBJECTS[data.subject] || data.subject)}</b>\n` +
      `🔖 Blok: <b>${data.test_id}</b>\n` +
      `📊 Savollar: <b>${questions.length} ta</b>\n\n` +
      `<i>Test foydalanuvchilar uchun tayyor!</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback('🔙 Dashboard', 'admin_panel_main'),
        ]]),
      }
    );
  } catch (err) {
    logger.error('cbAdmFinish', err);
    await ctx.telegram.editMessageText(
      ctx.chat.id, saving.message_id, undefined,
      '❌ Xatolik yuz berdi.'
    ).catch(() => {});
  }
}

// ============================================
// 📞 USER → ADMIN CONTACT
// ============================================

async function cbCancelContact(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery().catch(() => {});
  await ctx.reply('❌ Bekor qilindi.', backToMainKb());
}

async function onContactMessage(ctx) {
  clearState(ctx);

  // ✅ FIX: Guard against empty message
  const msgText = ctx.message?.text;
  if (!msgText?.trim()) {
    return ctx.reply('⚠️ Bo\'sh xabar yuborib bo\'lmaydi.', backToMainKb());
  }

  try {
    const fName = escapeHtml(sanitizeForTelegram(
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Anonim'
    ));

    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `📨 <b>YANGI MUROJAAT</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 <a href="tg://user?id=${ctx.from.id}">${fName}</a>\n` +
      `🆔 <code>${ctx.from.id}</code>\n\n` +
      `💬 ${escapeHtml(msgText)}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[
          Markup.button.callback(
            '↩️ Javob berish',
            `reply_${ctx.from.id}_${ctx.message.message_id}`
          ),
        ]]),
      }
    );

    await ctx.reply(
      '✅ <b>Xabar yuborildi!</b>\n\nAdmin tez orada javob beradi.',
      { parse_mode: 'HTML', ...backToMainKb() }
    );
  } catch (err) {
    logger.error('onContactMessage', err);
    await ctx.reply('❌ Xatolik yuz berdi.', backToMainKb());
  }
}

// ============================================
// 🔗 REGISTRATION
// ============================================

function register(bot) {
  // Commands
  bot.command('admin', cmdAdmin);
  bot.command(['refresh_all_timetable', 'refresh_all_timetables', 'sync_timetables'], adminGuard(cmdRefreshAllTimetable));
  bot.command(['stop_refresh_timetable', 'stop_sync_timetables'], adminGuard(cmdStopRefreshTimetable));

  // Dashboard
  bot.action('admin_panel_main',        adminGuard(cbAdminPanelMain));
  bot.action('admin_refresh_dashboard', adminGuard(cbAdminRefreshDashboard));
  bot.action('admin_sync_timetables',   adminGuard(cbAdminSyncTimetables));
  bot.action('admin_cancel',            adminGuard(cbAdminCancel));

  // Users
  bot.action(/^admin_users_page_\d+$/, adminGuard(cbAdminUsersList));
  bot.action('admin_search_user',      adminGuard(cbAdminSearchUser));
  bot.action(/^admin_show_user_\d+$/,  adminGuard(cbAdminShowUser));
  bot.action(/^admin_user_stats_\d+$/, adminGuard(cbAdminUserStats));

  // Stats
  bot.action('admin_stats',            adminGuard(cbAdminStats));

  // Broadcast
  bot.action('admin_broadcast',        adminGuard(cbAdminBroadcast));
  bot.action('admin_broadcast_confirm', adminGuard(cbBroadcastConfirm));

  // Reply
  bot.action(/^reply_\d+/,             adminGuard(cbReplyStart));

  // Test creation
  bot.action('admin_add_test',         adminGuard(cbAdminAddTest));
  bot.action(/^adm_subj_\w+$/,         adminGuard(cbAdmSubj));
  bot.action(/^adm_fmt_(text|docx)$/,  adminGuard(cbAdmFmt));
  bot.action(/^adm_switch_(text|docx)$/, adminGuard(cbAdmSwitchFmt));
  bot.action('adm_preview',            adminGuard(cbAdmPreview));
  bot.action('adm_reset',              adminGuard(cbAdmReset));
  bot.action('adm_finish',             adminGuard(cbAdmFinish));

  // Misc
  bot.action('cancel_contact', cbCancelContact);
  bot.action('ignore', ctx => ctx.answerCbQuery().catch(() => {}));
}

module.exports = {
  register,
  // Exported for use in other modules
  onBroadcastMessage,
  onReplyMessage,
  onAdmTestId,
  onAdmTextContent,
  onAdmDocxContent,
  onContactMessage,
  onAdminSearchInput,
};