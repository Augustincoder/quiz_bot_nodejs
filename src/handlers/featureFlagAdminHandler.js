'use strict';

/**
 * In-Chat Interactive Feature Flag & Rollout Admin Dashboard
 * 
 * Provides:
 * - Real-time in-chat dashboard with current states and auto-kill warnings.
 * - 1-tap state cycling (OFF -> ADMIN_ONLY -> BETA_USERS -> PERCENT_20 -> PERCENT_50 -> PUBLIC -> OFF).
 * - Instant circuit breaker reset for tripped features.
 * - Beta tester cohort management commands (/beta_add, /beta_remove, /beta_list).
 */

const { Markup } = require('telegraf');
const logger = require('../core/logger');
const featureFlagService = require('../services/featureFlagService');
const { escapeHtml, safeEdit, isAdmin: checkIsAdmin, adminGuard } = require('../core/utils');

const { STATES } = featureFlagService;

// Ordered sequence for 1-tap state cycling
const STATE_CYCLE = Object.freeze([
  STATES.OFF,
  STATES.ADMIN_ONLY,
  STATES.BETA_USERS,
  STATES.PERCENT_20,
  STATES.PERCENT_50,
  STATES.PUBLIC,
]);

/**
 * Returns human-readable badge with brackets and emoji.
 *
 * @param {string} state 
 * @returns {string} e.g. "🔴 [OFF]", "🔒 [ADMIN]"
 */
function getStateBadge(state) {
  switch (state) {
    case STATES.OFF:
      return '🔴 [OFF]';
    case STATES.ADMIN_ONLY:
      return '🔒 [ADMIN]';
    case STATES.BETA_USERS:
      return '🧪 [BETA]';
    case STATES.PERCENT_10:
      return '📊 [10%]';
    case STATES.PERCENT_20:
      return '📊 [20%]';
    case STATES.PERCENT_25:
      return '📊 [25%]';
    case STATES.PERCENT_50:
      return '📊 [50%]';
    case STATES.PUBLIC:
      return '🟢 [PUBLIC]';
    default:
      return `⚙️ [${state || 'UNKNOWN'}]`;
  }
}

/**
 * Returns concise badge tag (e.g. "[OFF]", "[ADMIN]").
 *
 * @param {string} state 
 * @returns {string}
 */
function getShortBadge(state) {
  switch (state) {
    case STATES.OFF:
      return '[OFF]';
    case STATES.ADMIN_ONLY:
      return '[ADMIN]';
    case STATES.BETA_USERS:
      return '[BETA]';
    case STATES.PERCENT_10:
      return '[10%]';
    case STATES.PERCENT_20:
      return '[20%]';
    case STATES.PERCENT_25:
      return '[25%]';
    case STATES.PERCENT_50:
      return '[50%]';
    case STATES.PUBLIC:
      return '[PUBLIC]';
    default:
      return `[${state || 'UNKNOWN'}]`;
  }
}

/**
 * Returns user-friendly status description in Uzbek/English.
 *
 * @param {string} state 
 * @returns {string}
 */
function getStateDescription(state) {
  switch (state) {
    case STATES.OFF:
      return "O'chirilgan (Hech kimga ko'rinmaydi)";
    case STATES.ADMIN_ONLY:
      return 'Faqat adminlar (Dogfooding)';
    case STATES.BETA_USERS:
      return 'Beta testerlar guruhi';
    case STATES.PERCENT_10:
      return '10% foydalanuvchilar (Canary)';
    case STATES.PERCENT_20:
      return '20% foydalanuvchilar (Canary)';
    case STATES.PERCENT_25:
      return '25% foydalanuvchilar (Canary)';
    case STATES.PERCENT_50:
      return '50% foydalanuvchilar (Canary)';
    case STATES.PUBLIC:
      return "Hammaga ochiq (100% General Availability)";
    default:
      return state || 'Noma\'lum';
  }
}

/**
 * Cycle to the next rollout state in the defined progression:
 * OFF -> ADMIN_ONLY -> BETA_USERS -> PERCENT_20 -> PERCENT_50 -> PUBLIC -> OFF.
 *
 * @param {string} currentState 
 * @returns {string} Next state
 */
function cycleState(currentState) {
  const idx = STATE_CYCLE.indexOf(currentState);
  if (idx === -1) {
    if (currentState === STATES.PERCENT_10) return STATES.PERCENT_20;
    if (currentState === STATES.PERCENT_25) return STATES.PERCENT_50;
    return STATES.ADMIN_ONLY;
  }
  return STATE_CYCLE[(idx + 1) % STATE_CYCLE.length];
}

/**
 * Render clean HTML dashboard text from features map.
 * Displays all features, current rollout states ([OFF], [ADMIN], [BETA], [20%], [50%], [PUBLIC]),
 * and active auto-kill warnings.
 *
 * @param {Object|Array} flagsMap 
 * @returns {string}
 */
function renderFlagsDashboardText(flagsMap) {
  const features = Array.isArray(flagsMap)
    ? flagsMap
    : Object.values(flagsMap || {});

  const total = features.length;
  const betaCount = (featureFlagService.getBetaUsers && featureFlagService.getBetaUsers())
    ? featureFlagService.getBetaUsers().length
    : 0;

  // Detect active auto-kill warnings
  const trippedFeatures = features.filter(f => Boolean(f.autoKillTriggered));

  let text = `🎛 <b>FEATURE FLAGS & ROLLOUT DASHBOARD</b>\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Auto-kill banner if any feature is tripped
  if (trippedFeatures.length > 0) {
    text += `🚨 <b>[AUTO-KILL / CIRCUIT BREAKER FAOL!]</b>\n`;
    text += `<i>Xatolar chegaradan oshgani sababli xavfsizlik rejimi yoqilgan:</i>\n\n`;
    for (const tf of trippedFeatures) {
      const reason = escapeHtml(tf.trippedReason || 'Error threshold exceeded');
      const timeStr = tf.trippedAt ? new Date(tf.trippedAt).toLocaleTimeString('uz-UZ') : 'Yaqinda';
      text += `⚠️ <b>${escapeHtml(tf.key)}</b>: Breaker tripped!\n`;
      text += `   ├─ Yangi holat: <code>${tf.state}</code> (Avval: <code>${tf.previousState || 'PUBLIC'}</code>)\n`;
      text += `   ├─ Sabab: <i>${reason}</i>\n`;
      text += `   └─ Vaqt: <code>${timeStr}</code>\n\n`;
    }
    text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  // Feature flags list
  if (total === 0) {
    text += `ℹ️ <i>Hozircha tizimda birorta ham feature flag ro'yxatga olinmagan.</i>\n\n`;
    text += `Koddagi <code>isFeatureEnabled('FEATURE_NAME', userId)</code> birinchi chaqirilganda flag avtomatik ro'yxatdan o'tadi.\n\n`;
  } else {
    text += `📋 <b>Mavjud Funksiyalar Ro'yxati (${total} ta):</b>\n\n`;
    for (const feat of features) {
      const badge = getStateBadge(feat.state);
      const desc = getStateDescription(feat.state);
      const errCount = feat.errorCount || 0;
      const threshold = feat.errorThreshold || 3;
      const windowMin = Math.round((feat.windowSeconds || 300) / 60);

      const featName = feat.name ? ` — <i>${escapeHtml(feat.name)}</i>` : '';
      text += `⚙️ <b>${escapeHtml(feat.key)}</b>${featName}\n`;
      text += `   ├─ Holat: <b>${badge}</b>\n`;
      text += `   ├─ Izoh: <i>${desc}</i>\n`;

      if (feat.autoKillTriggered) {
        text += `   └─ 🚨 <b>CIRCUIT BREAKER: O'chirilgan!</b> (Qayta tiklash tugmasini bosing)\n\n`;
      } else {
        text += `   └─ Xatolar: <code>${errCount}/${threshold}</code> (Oyna: ${windowMin}m)\n\n`;
      }
    }
  }

  // Summary footer
  text += `━━━━━━━━━━━━━━━━━━━━\n`;
  text += `👥 <b>Beta Testerlar:</b> <b>${betaCount}</b> ta\n`;
  text += `💡 <i>O'zgartirish uchun quyidagi tugmalarni 1 marta bosing.</i>\n`;
  text += `<i>Oxirgi yangilanish: ${new Date().toLocaleTimeString('uz-UZ')}</i>`;

  return text;
}

/**
 * Build inline keyboard with 1-tap state cycle buttons, breaker reset buttons, and refresh.
 *
 * @param {Object|Array} flagsMap 
 * @returns {Object} Telegraf Markup inline keyboard
 */
function buildFlagsKeyboard(flagsMap) {
  const features = Array.isArray(flagsMap)
    ? flagsMap
    : Object.values(flagsMap || {});

  const rows = [];

  for (const feat of features) {
    const badge = getShortBadge(feat.state);
    const key = feat.key;

    // Toggle button
    const toggleBtn = Markup.button.callback(
      `🔄 ${key}: ${badge}`,
      `flag_toggle_${key}`
    );
    rows.push([toggleBtn]);

    // If circuit breaker is tripped, offer instant reset button
    if (feat.autoKillTriggered) {
      const resetBtn = Markup.button.callback(
        `⚡ Breaker Reset: ${key}`,
        `flag_reset_${key}`
      );
      rows.push([resetBtn]);
    }
  }

  // Controls row
  rows.push([
    Markup.button.callback('🔄 Yangilash', 'flags_refresh'),
    Markup.button.callback('🔙 Dashboard', 'admin_panel_main'),
  ]);

  return Markup.inlineKeyboard(rows);
}

/**
 * Parse userId or username argument from command text.
 * Handles formats:
 * - "/beta_add 123456789" -> "123456789"
 * - "/beta_add @john_doe" -> "john_doe"
 * - "/beta_add   alice  " -> "alice"
 * - "123456789" -> "123456789"
 * - "@bob" -> "bob"
 *
 * @param {string} text 
 * @returns {string|null} Clean user identifier or null if missing
 */
function parseBetaUserArg(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // If text starts with a command (e.g. /beta_add or /beta_remove)
  const parts = trimmed.split(/\s+/);
  let rawArg = null;
  if (parts[0].startsWith('/')) {
    if (parts.length < 2) return null;
    rawArg = parts.slice(1).join(' ').trim();
  } else {
    rawArg = trimmed;
  }

  if (!rawArg) return null;

  // Clean @ prefix and spaces
  const clean = rawArg.replace(/^@/, '').trim();
  return clean || null;
}

/**
 * Resolve target user by ID or username from database if possible.
 *
 * @param {string} target 
 * @returns {Promise<{ id: string|null, username: string|null, fullName: string|null }>}
 */
async function resolveUserTarget(target) {
  if (!target) return { id: null, username: null, fullName: null };
  const clean = target.replace(/^@/, '').trim();

  // If already numeric ID
  if (/^\d+$/.test(clean)) {
    return { id: clean, username: null, fullName: null };
  }

  // Try DB search
  try {
    const dbService = require('../services/dbService');
    if (dbService && typeof dbService.searchUsers === 'function') {
      const found = await dbService.searchUsers(clean, 5);
      if (Array.isArray(found) && found.length > 0) {
        const exact = found.find(u => (u.username || '').toLowerCase() === clean.toLowerCase());
        const user = exact || found[0];
        if (user && user.telegram_id) {
          return {
            id: String(user.telegram_id),
            username: user.username || clean,
            fullName: user.full_name || null,
          };
        }
      }
    }
  } catch (err) {
    logger.debug('featureFlagAdminHandler: resolveUserTarget error', { error: err.message });
  }

  return { id: null, username: clean, fullName: null };
}

/**
 * Action / Command Handler for Feature Flags Dashboard
 * Handles /flags command and flags_dash / flags_refresh callbacks.
 *
 * @param {Object} ctx 
 */
async function cbFlagsDashboard(ctx) {
  const userId = ctx.from?.id;

  // Permission check
  const isAuthorized = checkIsAdmin ? checkIsAdmin(userId) : featureFlagService.isAdmin(userId);
  if (!isAuthorized) {
    if (ctx.callbackQuery) {
      return ctx.answerCbQuery('⛔ Faqat bot adminlari uchun!', { show_alert: true }).catch(() => {});
    }
    return ctx.reply('⛔ <b>Kirish taqiqlangan!</b>\n\nBu bo\'lim faqat adminlar uchun.', { parse_mode: 'HTML' }).catch(() => {});
  }

  if (ctx.callbackQuery) {
    await ctx.answerCbQuery('🔄 Dashboard yangilanmoqda...').catch(() => {});
  }

  try {
    if (typeof featureFlagService.init === 'function') {
      await featureFlagService.init().catch(() => {});
    }
    const flagsMap = featureFlagService.getFeatureStates();
    const text = renderFlagsDashboardText(flagsMap);
    const kb = buildFlagsKeyboard(flagsMap);

    if (ctx.callbackQuery) {
      await safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
    } else {
      await ctx.reply(text, { parse_mode: 'HTML', ...kb });
    }
  } catch (err) {
    logger.error('cbFlagsDashboard error:', err);
    if (ctx.callbackQuery) {
      await ctx.answerCbQuery('❌ Dashboard yuklanmadi', { show_alert: true }).catch(() => {});
    } else {
      await ctx.reply('❌ <b>Xatolik yuz berdi:</b> Dashboard yuklanmadi.', { parse_mode: 'HTML' }).catch(() => {});
    }
  }
}

/**
 * 1-Tap Toggle Callback Handler
 * Handles flag_toggle_${featureKey}
 *
 * @param {Object} ctx 
 */
async function cbToggleFlag(ctx) {
  const userId = ctx.from?.id;
  const isAuthorized = checkIsAdmin ? checkIsAdmin(userId) : featureFlagService.isAdmin(userId);
  if (!isAuthorized) {
    return ctx.answerCbQuery('⛔ Ruxsat yo\'q!', { show_alert: true }).catch(() => {});
  }

  let featureKey = null;
  if (ctx.match && ctx.match[1]) {
    featureKey = ctx.match[1];
  } else if (ctx.callbackQuery?.data) {
    featureKey = ctx.callbackQuery.data.replace('flag_toggle_', '');
  }

  if (!featureKey) {
    return ctx.answerCbQuery('⚠️ Noma\'lum parametr').catch(() => {});
  }

  try {
    const currentState = featureFlagService.getFeatureState(featureKey) || STATES.ADMIN_ONLY;
    const nextState = cycleState(currentState);

    await featureFlagService.setFeatureState(featureKey, nextState);
    await ctx.answerCbQuery(`✅ ${featureKey} → ${nextState}`).catch(() => {});

    // Re-render dashboard in-place
    const flagsMap = featureFlagService.getFeatureStates();
    const text = renderFlagsDashboardText(flagsMap);
    const kb = buildFlagsKeyboard(flagsMap);

    await safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    logger.error('cbToggleFlag error:', err);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi', { show_alert: true }).catch(() => {});
  }
}

/**
 * Circuit Breaker Reset Callback Handler
 * Handles flag_reset_${featureKey}
 *
 * @param {Object} ctx 
 */
async function cbResetBreaker(ctx) {
  const userId = ctx.from?.id;
  const isAuthorized = checkIsAdmin ? checkIsAdmin(userId) : featureFlagService.isAdmin(userId);
  if (!isAuthorized) {
    return ctx.answerCbQuery('⛔ Ruxsat yo\'q!', { show_alert: true }).catch(() => {});
  }

  let featureKey = null;
  if (ctx.match && ctx.match[1]) {
    featureKey = ctx.match[1];
  } else if (ctx.callbackQuery?.data) {
    featureKey = ctx.callbackQuery.data.replace('flag_reset_', '');
  }

  if (!featureKey) {
    return ctx.answerCbQuery('⚠️ Noma\'lum parametr').catch(() => {});
  }

  try {
    const resetResult = featureFlagService.resetFeatureBreaker(featureKey);
    const restoredState = resetResult ? resetResult.state : 'ADMIN_ONLY';

    await ctx.answerCbQuery(`⚡ ${featureKey} circuit breaker qayta tiklandi! (${restoredState})`, { show_alert: true }).catch(() => {});

    // Re-render dashboard in-place
    const flagsMap = featureFlagService.getFeatureStates();
    const text = renderFlagsDashboardText(flagsMap);
    const kb = buildFlagsKeyboard(flagsMap);

    await safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  } catch (err) {
    logger.error('cbResetBreaker error:', err);
    await ctx.answerCbQuery('❌ Breaker tiklanmadi', { show_alert: true }).catch(() => {});
  }
}

/**
 * Command Handler: /beta_add <userId or @username>
 *
 * @param {Object} ctx 
 */
async function cmdBetaAdd(ctx) {
  const userId = ctx.from?.id;
  const isAuthorized = checkIsAdmin ? checkIsAdmin(userId) : featureFlagService.isAdmin(userId);
  if (!isAuthorized) {
    return ctx.reply('⛔ <b>Kirish taqiqlangan!</b>\n\nBu buyruq faqat bot adminlari uchun.', { parse_mode: 'HTML' }).catch(() => {});
  }

  const rawArg = parseBetaUserArg(ctx.message?.text);
  if (!rawArg) {
    return ctx.reply(
      'ℹ️ <b>Foydalanish:</b>\n\n' +
      '<code>/beta_add &lt;user_id yoki @username&gt;</code>\n\n' +
      '<i>Masalan:</i>\n' +
      '• <code>/beta_add 123456789</code>\n' +
      '• <code>/beta_add @student_user</code>',
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  try {
    const resolved = await resolveUserTarget(rawArg);
    if (!resolved.id) {
      return ctx.reply(
        `❌ <b>Foydalanuvchi topilmadi!</b>\n\n` +
        `<code>@${escapeHtml(rawArg)}</code> foydalanuvchisi bot ma'lumotlar bazasidan topilmadi.\n` +
        `Iltimos, uning raqamli Telegram ID sini kiriting:\n` +
        `<code>/beta_add &lt;user_id&gt;</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    await featureFlagService.addBetaUser(resolved.id);

    let msg = `✅ <b>Beta tester qo'shildi!</b>\n\n`;
    msg += `🆔 <b>Telegram ID:</b> <code>${resolved.id}</code>\n`;
    if (resolved.username) {
      msg += `👤 <b>Username:</b> @${escapeHtml(resolved.username)}\n`;
    }
    if (resolved.fullName) {
      msg += `🏷 <b>Ism:</b> ${escapeHtml(resolved.fullName)}\n`;
    }
    msg += `\nEndi ushbu foydalanuvchi <code>[BETA]</code> holatidagi yangi funksiyalardan foydalana oladi.`;

    await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
  } catch (err) {
    logger.error('cmdBetaAdd error:', err);
    await ctx.reply(`❌ Xatolik yuz berdi: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
  }
}

/**
 * Command Handler: /beta_remove <userId or @username>
 *
 * @param {Object} ctx 
 */
async function cmdBetaRemove(ctx) {
  const userId = ctx.from?.id;
  const isAuthorized = checkIsAdmin ? checkIsAdmin(userId) : featureFlagService.isAdmin(userId);
  if (!isAuthorized) {
    return ctx.reply('⛔ <b>Kirish taqiqlangan!</b>\n\nBu buyruq faqat bot adminlari uchun.', { parse_mode: 'HTML' }).catch(() => {});
  }

  const rawArg = parseBetaUserArg(ctx.message?.text);
  if (!rawArg) {
    return ctx.reply(
      'ℹ️ <b>Foydalanish:</b>\n\n' +
      '<code>/beta_remove &lt;user_id yoki @username&gt;</code>\n\n' +
      '<i>Masalan:</i>\n' +
      '• <code>/beta_remove 123456789</code>',
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }

  try {
    const resolved = await resolveUserTarget(rawArg);
    const targetId = resolved.id || rawArg;

    await featureFlagService.removeBetaUser(targetId);

    const msg = `🗑 <b>Beta tester o'chirildi!</b>\n\n` +
      `🆔 <b>ID:</b> <code>${targetId}</code>\n` +
      `Ushbu foydalanuvchi beta cohort ro'yxatidan chiqarildi.`;

    await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
  } catch (err) {
    logger.error('cmdBetaRemove error:', err);
    await ctx.reply(`❌ Xatolik yuz berdi: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
  }
}

/**
 * Command Handler: /beta_list
 *
 * @param {Object} ctx 
 */
async function cmdBetaList(ctx) {
  const userId = ctx.from?.id;
  const isAuthorized = checkIsAdmin ? checkIsAdmin(userId) : featureFlagService.isAdmin(userId);
  if (!isAuthorized) {
    return ctx.reply('⛔ <b>Kirish taqiqlangan!</b>\n\nBu buyruq faqat bot adminlari uchun.', { parse_mode: 'HTML' }).catch(() => {});
  }

  try {
    const betaUsers = featureFlagService.getBetaUsers();

    if (!betaUsers || betaUsers.length === 0) {
      return ctx.reply(
        '🧪 <b>BETA TESTERLAR COHORT</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━\n\n' +
        'ℹ️ <i>Hozircha hech qanday beta tester ro\'yxatga olinmagan.</i>\n\n' +
        '➕ Qo\'shish uchun: <code>/beta_add &lt;user_id yoki @username&gt;</code>',
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    let msg = `🧪 <b>BETA TESTERLAR RO'YXATI</b>\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    msg += `Jami: <b>${betaUsers.length}</b> ta tester\n\n`;

    betaUsers.forEach((id, index) => {
      msg += `${index + 1}. <code>${id}</code>\n`;
    });

    msg += `\n━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `➕ Qo'shish: <code>/beta_add &lt;user_id&gt;</code>\n`;
    msg += `➖ O'chirish: <code>/beta_remove &lt;user_id&gt;</code>`;

    await ctx.reply(msg, { parse_mode: 'HTML' }).catch(() => {});
  } catch (err) {
    logger.error('cmdBetaList error:', err);
    await ctx.reply(`❌ Xatolik yuz berdi: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' }).catch(() => {});
  }
}

/**
 * Register all routes, commands, and interactive callbacks on the bot instance.
 *
 * @param {Object} bot 
 */
function register(bot) {
  if (!bot || typeof bot.command !== 'function') return;

  const guard = adminGuard ? adminGuard : (fn => fn);

  // Commands
  bot.command('flags', guard(cbFlagsDashboard));
  bot.command('beta_add', guard(cmdBetaAdd));
  bot.command('beta_remove', guard(cmdBetaRemove));
  bot.command('beta_list', guard(cmdBetaList));

  // Inline Callbacks
  bot.action('flags_dash', guard(cbFlagsDashboard));
  bot.action('flags_refresh', guard(cbFlagsDashboard));
  bot.action(/^flag_toggle_(.+)$/, guard(cbToggleFlag));
  bot.action(/^flag_reset_(.+)$/, guard(cbResetBreaker));
}

module.exports = {
  cycleState,
  getStateBadge,
  getShortBadge,
  renderFlagsDashboardText,
  buildFlagsKeyboard,
  parseBetaUserArg,
  resolveUserTarget,
  cbFlagsDashboard,
  cbToggleFlag,
  cbResetBreaker,
  cmdBetaAdd,
  cmdBetaRemove,
  cmdBetaList,
  register,
};
