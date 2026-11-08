'use strict';

const { Markup } = require('telegraf');
const { CARD_NUMBER, ADMIN_ID, ADMIN_IDS } = require('../config/config');
const dbService = require('../services/dbService');
const logger = require('../core/logger');
const {
  States, setState, clearState, safeAnswerCb,
  safeEdit, escapeHtml, sanitizeForTelegram
} = require('../core/utils');

const CARD_HOLDER = 'Avazov Muhammadamin';

function getTargetAdmins() {
  const raw = process.env.ADMIN_IDS || process.env.ADMIN_ID || (ADMIN_IDS && ADMIN_IDS.length ? ADMIN_IDS.join(',') : ADMIN_ID) || '';
  return String(raw)
    .split(',')
    .map((id) => parseInt(id.trim(), 10))
    .filter((id) => !Number.isNaN(id) && id > 0);
}

/**
 * Format card number for display and 1-tap copy
 */
function formatCardDisplay(cardNumber) {
  const raw = String(cardNumber || '').replace(/\s+/g, '');
  if (!raw) {
    return '⚠️ <i>Hozirda karta raqami sozlanmagan. Iltimos, keyinroq urinib ko\'ring.</i>';
  }

  // Format 16-digit card as 4x4 blocks for readability
  const formattedSpaced = raw.length === 16
    ? raw.replace(/(\d{4})/g, '$1 ').trim()
    : raw;

  return (
    `💳 <b>Karta raqami:</b>\n` +
    `<code>${raw}</code> <i>(nusxalash uchun ustiga bosing)</i>\n` +
    `🔢 <b>Karta formati:</b> <code>${formattedSpaced}</code>\n` +
    `👤 <b>Karta egasi:</b> <b>${escapeHtml(CARD_HOLDER)}</b>`
  );
}

/**
 * Render the main Donate menu
 */
async function cbDonateMenu(ctx) {
  await safeAnswerCb(ctx);
  clearState(ctx);

  const activeCardNumber = process.env.CARD_NUMBER || CARD_NUMBER || '';
  const cardInfo = formatCardDisplay(activeCardNumber);

  const text =
    `💖 <b>LOYIHANI QO'LLAB-QUVVATLASH (DONAT)</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Ushbu bot talabalar va o'quvchilar uchun <b>mutlaqo bepul</b> xizmat qiladi.\n\n` +
    `Server xarajatlari, sun'iy intellekt (AI) va dars jadvali xizmatlarini uzluksiz ushlab turish ko'p jihatdan sizning ixtiyoriy qo'llab-quvvatlovingizga tayanadi.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${cardInfo}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💡 <i>Ixtiyoriy miqdorda qo'llab-quvvatlashingiz mumkin. Har bir e'tiboringiz loyiha rivoji uchun juda qadrli!</i>\n\n` +
    `Agar to'lov qilgan bo'lsangiz, skrinshot yuborish uchun quyidagi <b>"📸 Tashladim (Chek yuborish)"</b> tugmasini bosing:`;

  const buttons = [];
  if (activeCardNumber) {
    buttons.push([Markup.button.callback('📸 Tashladim (Chek yuborish)', 'donate_sent')]);
  }
  buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]);

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

/**
 * Switch user to screenshot waiting state
 */
async function cbDonateSent(ctx) {
  await safeAnswerCb(ctx);
  setState(ctx, States.DONATE_SCREENSHOT);

  const text =
    `📸 <b>To'lov chekini / skrinshotini yuboring</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `Iltimos, o'tkazma chekining skrinshotini (rasm yoki fayl ko'rinishida) shu yerga yuboring.\n\n` +
    `Adminlarimiz chekni ko'rib chiqib, sizga o'z minnatdorchiligini bildirishadi! ✨\n\n` +
    `<i>💡 Agar fikringizdan qaytsangiz, bekor qilish tugmasini bosing.</i>`;

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Bekor qilish', 'cancel_donate')],
      [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
    ]),
  });
}

/**
 * Cancel donation receipt submission
 */
async function cbCancelDonate(ctx) {
  await safeAnswerCb(ctx);
  clearState(ctx);
  await cbDonateMenu(ctx);
}

/**
 * Handle incoming screenshot / document / text while in States.DONATE_SCREENSHOT
 */
async function onDonateScreenshot(ctx, next) {
  if (!ctx.message) return next ? next() : null;

  const rawText = (ctx.message.text || '').trim();
  const isCommand = rawText.startsWith('/');
  const isMenuButton = [
    '📅 Dars jadvali', '🧪 Testlar', '🤖 AI Yordamchi', '👤 Profil', '📊 Statistika',
    '🔍 Guruh qidirish', '🏢 Bo\'sh xonalar', '📚 Rasmiy Testlar', '📝 O\'z Testlarim',
    '🔙 Ortga', '🏠 Asosiy Menyu', '❌ Bekor qilish'
  ].some((btn) => rawText.includes(btn));

  // Stale wizard state cleanup if user chose to navigate away
  if (isCommand || isMenuButton) {
    clearState(ctx);
    return next ? next() : null;
  }

  const userId = ctx.from?.id;
  const isPhoto = Boolean(ctx.message.photo);
  const isDoc = Boolean(ctx.message.document);

  if (isPhoto || isDoc) {
    clearState(ctx);

    const firstName = ctx.from.first_name || 'Foydalanuvchi';
    const lastName = ctx.from.last_name ? ` ${ctx.from.last_name}` : '';
    const fullName = `${firstName}${lastName}`.trim();
    const username = ctx.from.username ? `@${sanitizeForTelegram(ctx.from.username)}` : '—';
    const userLink = `<a href="tg://user?id=${userId}">${escapeHtml(sanitizeForTelegram(fullName))}</a>`;

    let className = '—';
    try {
      const userRecord = await dbService.getUserByTelegramId(userId);
      if (userRecord && userRecord.class_name) {
        className = userRecord.class_name;
      }
    } catch {
      // Safe fallback
    }

    const tashkentTime = new Date().toLocaleString('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      hour12: false,
    });
    const caption = ctx.message.caption ? escapeHtml(ctx.message.caption) : '';

    const adminHeader =
      `💖 <b>YANGI DONAT / TO'LOV CHEKI!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 <b>Foydalanuvchi:</b> ${userLink}\n` +
      `🆔 <b>ID:</b> <code>${userId}</code>\n` +
      `📛 <b>Username:</b> ${username}\n` +
      `🎓 <b>Guruh:</b> ${className}\n` +
      `🕐 <b>Vaqt:</b> ${tashkentTime} (Toshkent)\n` +
      (caption ? `💬 <b>Izoh:</b> <i>${caption}</i>\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👇 <b>To'lov cheki quyida ilova qilinmoqda:</b>`;

    const targetAdmins = getTargetAdmins();
    if (targetAdmins.length === 0) {
      logger.warn('No ADMIN_ID configured to receive donation receipt.');
    }

    for (const adminId of targetAdmins) {
      try {
        await ctx.telegram.sendMessage(adminId, adminHeader, { parse_mode: 'HTML' });
        const copiedMsg = await ctx.copyMessage(adminId);

        const quickActions = Markup.inlineKeyboard([
          [
            Markup.button.callback('✉️ Rahmat aytish (Reply)', `reply_${userId}_${copiedMsg.message_id}`),
            Markup.button.callback('👤 Profil', `admin_show_user_${userId}`),
          ]
        ]);

        await ctx.telegram.sendMessage(adminId, '⚡ <b>Admin tezkor amallari:</b>', {
          parse_mode: 'HTML',
          ...quickActions,
        });
      } catch (err) {
        logger.error('Failed to forward donation check to admin', {
          adminId,
          userId,
          error: err.message,
        });
      }
    }

    // User confirmation
    return ctx.reply(
      `🎉 <b>Katta rahmat! To'lov chekingiz adminga yetkazildi.</b>\n\n` +
      `Loyihamizni qo'llab-quvvatlaganingiz va ko'rsatgan e'tiboringiz uchun cheksiz minnatdormiz! ` +
      `Sizning yordamingiz bot serverlari va tizimning uzluksiz, tez ishlashiga xizmat qiladi. 🚀`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
        ]),
      }
    );
  }

  // If text or other media sent instead of receipt photo
  return ctx.reply(
    `⚠️ <b>Iltimos, to'lov chekining skrinshotini (rasm) yuboring.</b>\n\n` +
    `Agar fikringizdan qaytgan bo'lsangiz, bekor qilish tugmasini bosing:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Bekor qilish', 'cancel_donate')],
        [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
      ]),
    }
  );
}

/**
 * Register bot actions and commands
 */
function register(bot) {
  bot.action('donate_menu', cbDonateMenu);
  bot.action('donate_sent', cbDonateSent);
  bot.action('cancel_donate', cbCancelDonate);
  bot.command(['donate', 'donat'], cbDonateMenu);
}

module.exports = {
  cbDonateMenu,
  cbDonateSent,
  cbCancelDonate,
  onDonateScreenshot,
  formatCardDisplay,
  register,
};
