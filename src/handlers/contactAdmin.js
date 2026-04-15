'use strict';

const { Markup } = require('telegraf');
const { ADMIN_ID } = require('../config/config');
const sessionService = require('../services/sessionService');
const logger = require('../core/logger');
const {
  States, setState, clearState, safeAnswerCb,
  safeEdit, escapeHtml, buildUserContext,
} = require('../core/utils');

// ─── CONTACT ADMIN ENTRY POINT ───────────────────────────────
async function cbInitContact(ctx) {
  await safeAnswerCb(ctx);
  setState(ctx, States.USER_CONTACT);

  await safeEdit(
    ctx,
    `👨‍💻 <b>Adminga Murojaat</b>\n\nSavol, taklif yoki muammoingizni shu yerda yozib qoldiring.\n📷 <i>Matn, rasm, video, link yoki ovozli xabar yuborishingiz mumkin.</i>\n\nAdmin sizga tez orada javob beradi.`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Ortga', 'back_to_main')],
        [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
      ]),
    },
  );
}

// ─── CONTACT MESSAGE HANDLER (Context-Aware Routing) ─────────
async function handleContactMessages(ctx, next) {
  if (!ctx.message) return next();

  const userId = ctx.from.id;
  const state = ctx.session?.state;
  if (state !== States.USER_CONTACT) return next();

  // Clear state immediately
  clearState(ctx);

  // Telemetry
  logger.info('contact:admin', { userId });

  try {
    const userLink = `<a href="tg://user?id=${userId}">${escapeHtml(ctx.from.first_name)}</a>`;
    const username = ctx.from.username ? `@${ctx.from.username}` : 'yo\'q';

    // ─── Build Context Card ──────────────────────────────
    const contextInfo = buildUserContext(ctx.session);

    // 1. Rich context card for admin
    const adminHeader =
      `📩 <b>YANGI MUROJAAT</b>\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `👤 Kimdan: ${userLink}\n` +
      `🆔 ID: <code>${userId}</code>\n` +
      `📛 Username: ${username}\n` +
      `\n${contextInfo}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `👇 <b>Xabar mazmuni:</b>`;

    await ctx.telegram.sendMessage(ADMIN_ID, adminHeader, { parse_mode: 'HTML' });

    // 2. Copy the actual message content
    const copiedMsg = await ctx.copyMessage(ADMIN_ID);

    // 3. Quick-action buttons for admin
    const originalMsgText = ctx.message.text || ctx.message.caption || '';
    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `✏️ <i>Tanlang:</i>`,
      {
        parse_mode: 'HTML',
        reply_parameters: {
          message_id: copiedMsg.message_id,
          allow_sending_without_reply: true,
        },
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✉️ Javob yozish', `reply_${userId}_${ctx.message.message_id}`)],
          [
            Markup.button.callback('🚫 Testini bekor qilish', `cancel_user_test_${userId}`),
            Markup.button.callback('⛔ Ban', `ban_user_${userId}`),
          ],
        ]),
      },
    );

    // 4. Confirmation to user
    await ctx.reply(
      '✅ Xabaringiz adminga muvaffaqiyatli yuborildi!\n\n<i>Admin tez orada javob beradi.</i>',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📞 Yana yozish', 'contact_admin')],
          [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
        ]),
      },
    );
  } catch (e) {
    console.error('Adminga xabar yuborishda xato:', e);
    await ctx.reply('❌ Xatolik yuz berdi. Iltimos, keyinroq urinib ko\'ring.');
  }
}

// ─── ADMIN QUICK ACTIONS ─────────────────────────────────────

async function cbCancelUserTest(ctx) {
  await safeAnswerCb(ctx);
  const userId = ctx.callbackQuery.data.replace('cancel_user_test_', '');
  const chatId = parseInt(userId, 10);

  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session) {
      return ctx.answerCbQuery('ℹ️ Bu foydalanuvchida faol test yo\'q.', { show_alert: true }).catch(() => {});
    }

    if (session.pollId) await sessionService.deletePollChat(session.pollId).catch(() => {});
    await sessionService.deleteActiveTest(chatId);

    // Notify admin
    await safeEdit(ctx,
      `✅ Foydalanuvchi <code>${userId}</code> ning testi bekor qilindi.`,
      { parse_mode: 'HTML' },
    );

    // Notify user
    await ctx.telegram.sendMessage(
      chatId,
      '🛑 <b>Sizning testingiz admin tomonidan to\'xtatildi.</b>\n\nSavollaringiz bo\'lsa, adminga murojaat qiling.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📞 Adminga yozish', 'contact_admin')],
          [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
        ]),
      },
    ).catch(() => {});

    logger.info('admin:cancel_test', { targetUserId: userId });
  } catch (e) {
    console.error('cbCancelUserTest error:', e.message);
  }
}

async function cbBanUser(ctx) {
  await safeAnswerCb(ctx);
  const userId = ctx.callbackQuery.data.replace('ban_user_', '');

  try {
    // Confirm ban
    await safeEdit(ctx,
      `⛔ <b>Foydalanuvchini Ban qilish</b>\n\nID: <code>${userId}</code>\n\n⚠️ Ishonchingiz komilmi?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Ha, Ban qilish', `confirm_ban_${userId}`)],
          [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
        ]),
      },
    );
  } catch (e) {
    console.error('cbBanUser error:', e.message);
  }
}

async function cbConfirmBan(ctx) {
  await safeAnswerCb(ctx);
  const userId = ctx.callbackQuery.data.replace('confirm_ban_', '');

  try {
    // Mark as banned in Supabase
    const dbService = require('../services/dbService');
    await dbService.banUser(userId);

    await safeEdit(ctx,
      `⛔ Foydalanuvchi <code>${userId}</code> <b>ban qilindi.</b>`,
      { parse_mode: 'HTML' },
    );

    // Notify the user
    await ctx.telegram.sendMessage(
      parseInt(userId, 10),
      '⛔ <b>Sizning hisobingiz admin tomonidan bloklandi.</b>\n\nSavolllar bo\'lsa: @AvazovM',
      { parse_mode: 'HTML' },
    ).catch(() => {});

    logger.info('admin:ban', { targetUserId: userId });
  } catch (e) {
    console.error('cbConfirmBan error:', e.message);
  }
}

// ─── REGISTER ────────────────────────────────────────────────
function register(bot) {
  bot.action('contact_admin', cbInitContact);
  bot.action(/^cancel_user_test_/, cbCancelUserTest);
  bot.action(/^ban_user_/, cbBanUser);
  bot.action(/^confirm_ban_/, cbConfirmBan);
  bot.on('message', handleContactMessages);
}

module.exports = { register };