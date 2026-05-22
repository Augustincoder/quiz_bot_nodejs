'use strict';

const { Markup } = require('telegraf');
const { ADMIN_ID } = require('../config/config');
const sessionService = require('../services/sessionService');
const dbService = require('../services/dbService');
const logger = require('../core/logger');
const {
  States, setState, clearState, safeAnswerCb,
  safeEdit, escapeHtml, buildUserContext,
  backToMainKb, sanitizeForTelegram
} = require('../core/utils');

// ============================================
// 📞 CONTACT ADMIN - ENHANCED UX
// ============================================

/**
 * Get user's recent activity for context
 */
async function getUserActivityContext(userId) {
  try {
    const stats = await dbService.getUserStats(userId);
    const history = stats?.history || [];
    
    if (!history.length) {
      return '📊 <i>Hali test yechmagan</i>';
    }
    
    const lastTest = history[history.length - 1];
    const lastDate = new Date(lastTest.timestamp).toLocaleString('uz-UZ');
    const totalTests = history.length;
    const avgScore = Math.round(
      history.reduce((sum, h) => sum + (h.percent || 0), 0) / history.length
    );
    
    return (
      `📊 <b>Faollik:</b>\n` +
      `├─ Jami testlar: ${totalTests} ta\n` +
      `├─ O'rtacha ball: ${avgScore}%\n` +
      `└─ Oxirgi test: ${lastDate}`
    );
  } catch (e) {
    console.error('getUserActivityContext error:', e);
    return '';
  }
}

/**
 * Enhanced contact admin entry point with tips
 */
async function cbInitContact(ctx) {
  await safeAnswerCb(ctx);
  setState(ctx, States.USER_CONTACT);

  const text = `
👨‍💻 <b>ADMINGA MUROJAAT</b>
━━━━━━━━━━━━━━━━━━━━

📝 <b>Murojaat qilish sabablari:</b>
├─ ❓ Savol yoki tushunmovchilik
├─ 💡 Taklif va fikrlar
├─ 🐛 Texnik muammo yoki xato
├─ 🎯 Maxsus test so'rash
└─ 📚 O'quv materiallari haqida

━━━━━━━━━━━━━━━━━━━━

✍️ <b>Xabaringizni yuboring:</b>

<i>💡 Maslahat: Muammoni batafsil yozib qoldiring — tezroq javob olasiz!</i>

📎 <b>Yuborish mumkin:</b>
• Matn xabar
• 📷 Rasm (screenshot)
• 📹 Video
• 🎤 Ovozli xabar
• 📄 Fayl
`;

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❌ Bekor qilish', 'back_to_main')],
      [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
    ])
  });
}

// ============================================
// 📨 MESSAGE HANDLER - ENHANCED
// ============================================

/**
 * Handle contact messages with enhanced context and validation
 */
async function handleContactMessages(ctx, next) {
  if (!ctx.message) return next();

  const userId = ctx.from.id;
  const state = ctx.session?.state;

  // ─── ADMIN REPLY HANDLER ──────────────────────────────
  // Admin o'z chatida biror xabarga reply qilsa → foydalanuvchiga yuboradi
  if (userId === ADMIN_ID && ctx.message.reply_to_message) {
    return handleAdminReply(ctx, next);
  }

  if (state !== States.USER_CONTACT) return next();

  // Clear state immediately
  clearState(ctx);

  // Check if message is empty
  const hasText = ctx.message.text || ctx.message.caption;
  const hasMedia = ctx.message.photo || ctx.message.video || 
                   ctx.message.voice || ctx.message.document ||
                   ctx.message.audio || ctx.message.animation ||
                   ctx.message.sticker || ctx.message.video_note;
  
  if (!hasText && !hasMedia) {
    return ctx.reply(
      '⚠️ <b>Xabar bo\'sh!</b>\n\n' +
      'Iltimos, matn yoki media (rasm, video) yuboring.',
      { parse_mode: 'HTML' }
    );
  }

  // Show sending status
  const sending = await ctx.reply('📤 Yuborilmoqda...');

  // Telemetry
  logger.info('contact:admin', { 
    userId,
    messageType: ctx.message.text ? 'text' : 
                 ctx.message.photo ? 'photo' :
                 ctx.message.video ? 'video' :
                 ctx.message.voice ? 'voice' : 'other'
  });

  try {
    // ─── BUILD USER INFO ──────────────────────────────
    const userLink = `<a href="tg://user?id=${userId}">${escapeHtml(sanitizeForTelegram(ctx.from.first_name))}</a>`;
    const lastName = ctx.from.last_name 
      ? ` ${escapeHtml(sanitizeForTelegram(ctx.from.last_name))}` 
      : '';
    const username = ctx.from.username 
      ? `@${sanitizeForTelegram(ctx.from.username)}` 
      : '—';

    // ─── GET USER CONTEXT ──────────────────────────────
    const sessionContext = buildUserContext(ctx.session);
    const activityContext = await getUserActivityContext(userId);

    // ─── GET USER CLASS INFO ──────────────────────────
    const users = await dbService.getAllUsers();
    const userRecord = users?.find(u => u.telegram_id === userId);
    const className = userRecord?.class_name || '—';

    // ─── BUILD MESSAGE TYPE LABEL ──────────────────────
    let messageTypeLabel = '💬 Matn xabar';
    if (ctx.message.photo)       messageTypeLabel = '📷 Rasm';
    else if (ctx.message.video)  messageTypeLabel = '📹 Video';
    else if (ctx.message.voice)  messageTypeLabel = '🎤 Ovozli xabar';
    else if (ctx.message.audio)  messageTypeLabel = '🎵 Audio';
    else if (ctx.message.document)   messageTypeLabel = '📄 Fayl';
    else if (ctx.message.animation)  messageTypeLabel = '🎭 GIF';
    else if (ctx.message.sticker)    messageTypeLabel = '🎨 Sticker';
    else if (ctx.message.video_note) messageTypeLabel = '🎥 Video xabar';

    // ─── 1. ADMIN NOTIFICATION (Rich Context Card) ────
    const adminHeader = 
      `📨 <b>YANGI MUROJAAT!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 <b>Foydalanuvchi:</b> ${userLink}${lastName}\n` +
      `🆔 <b>ID:</b> <code>${userId}</code>\n` +
      `📛 <b>Username:</b> ${username}\n` +
      `🎓 <b>Guruh:</b> ${className}\n\n` +
      `${activityContext}\n` +
      `${sessionContext ? `\n🎯 <b>Joriy kontekst:</b>\n${sessionContext}\n` : ''}` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📩 <b>Xabar turi:</b> ${messageTypeLabel}\n` +
      `🕐 <b>Vaqt:</b> ${new Date().toLocaleString('uz-UZ')}\n\n` +
      `👇 <b>Xabar mazmuni:</b>`;

    // Send header
    await ctx.telegram.sendMessage(ADMIN_ID, adminHeader, { 
      parse_mode: 'HTML' 
    });

    // ─── 2. COPY ACTUAL MESSAGE ────────────────────────
    const copiedMsg = await ctx.copyMessage(ADMIN_ID);

    // ─── 3. ADMIN QUICK ACTIONS ────────────────────────
    // ⚠️ MUHIM: copiedMsg.message_id ni saqlab qo'yamiz
    // Admin shu xabarga reply qilsa → foydalanuvchiga yuboradi
    // Shuningdek "Javob yozish" button orqali ham ishlaydi

    const quickActionsKeyboard = Markup.inlineKeyboard([
      [
        // userId va copiedMsg.message_id ni saqlaymiz
        Markup.button.callback(
          '✉️ Javob yozish', 
          `reply_${userId}_${copiedMsg.message_id}`
        ),
        Markup.button.callback(
          '👤 Profil', 
          `admin_show_user_${userId}`
        )
      ],
      [
        Markup.button.callback(
          '🚫 Testni to\'xtatish', 
          `cancel_user_test_${userId}`
        ),
        Markup.button.callback(
          '📊 Statistika', 
          `admin_user_stats_${userId}`
        )
      ],
      [
        Markup.button.callback(
          '⚠️ Ogohlantirish', 
          `warn_user_${userId}`
        ),
        Markup.button.callback(
          '⛔ Ban', 
          `ban_user_${userId}`
        )
      ]
    ]);

    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `⚡️ <b>Tezkor harakatlar:</b>\n` +
      `<i>💡 Yoki ushbu xabarga to'g'ridan-to'g'ri reply qiling</i>`,
      {
        parse_mode: 'HTML',
        reply_parameters: {
          message_id: copiedMsg.message_id,
          allow_sending_without_reply: true
        },
        ...quickActionsKeyboard
      }
    );

    // ─── 4. USER CONFIRMATION (Enhanced) ───────────────
    await ctx.telegram.deleteMessage(ctx.chat.id, sending.message_id)
      .catch(() => {});
    
    await ctx.reply(
      `✅ <b>XABAR YUBORILDI!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `📬 <b>Sizning murojatingiz adminga yetkazildi.</b>\n\n` +
      `⏱ <i>Admin odatda 1-24 soat ichida javob beradi.</i>\n\n` +
      `💡 <b>Eslatma:</b>\n` +
      `• Javobni shu botdan olasiz\n` +
      `• Savollaringiz aniq bo'lsa, tezroq javob olasiz\n` +
      `• Yana murojaat qilishingiz mumkin`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📞 Yana yozish', 'contact_admin')],
          [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
        ])
      }
    );

    logger.info('contact:sent', { userId, adminId: ADMIN_ID });

  } catch (e) {
    console.error('handleContactMessages error:', e);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      sending.message_id,
      undefined,
      `❌ <b>XATOLIK!</b>\n\n` +
      `Xabar yuborishda muammo yuz berdi.\n\n` +
      `<i>Sabab: ${escapeHtml(e.message)}</i>\n\n` +
      `💡 Iltimos:\n` +
      `• Bir necha daqiqadan keyin qayta urinib ko'ring\n` +
      `• Muammo davom etsa, to'g'ridan-to'g'ri @AvazovM ga yozing`,
      {
        parse_mode: 'HTML',
        ...backToMainKb()
      }
    );

    logger.error('contact:error', { userId, error: e.message });
  }
}

// ============================================
// ↩️ ADMIN REPLY HANDLERS
// ============================================

/**
 * "Javob yozish" button bosilganda
 * Admin state ga o'tadi va xabar kutadi
 */
async function cbAdminReplyToUser(ctx) {
  await safeAnswerCb(ctx);

  // Format: reply_{userId}_{originalMsgId}
  const parts = ctx.callbackQuery.data.split('_');
  // parts = ['reply', userId, originalMsgId]
  const targetUserId = parseInt(parts[1], 10);
  const originalMsgId = parseInt(parts[2], 10);

  if (isNaN(targetUserId)) {
    return ctx.answerCbQuery('❌ Noto\'g\'ri user ID', { show_alert: true });
  }

  // ─── Get user info ────────────────────────────────
  let userInfo = `<code>${targetUserId}</code>`;
  try {
    const users = await dbService.getAllUsers();
    const user = users?.find(u => u.telegram_id === targetUserId);
    if (user?.full_name) {
      userInfo = `${escapeHtml(sanitizeForTelegram(user.full_name))} (<code>${targetUserId}</code>)`;
    }
  } catch (_) {}

  // ─── Save reply state ─────────────────────────────
  // Admin sessiyasiga target user id ni yozamiz
  setState(ctx, States.ADMIN_REPLY);
  ctx.session.replyTargetUserId = targetUserId;
  ctx.session.replyOriginalMsgId = originalMsgId;

  await safeEdit(ctx,
    `✉️ <b>JAVOB YOZISH</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 <b>Kimga:</b> ${userInfo}\n\n` +
    `📎 <b>Yuborish mumkin:</b>\n` +
    `• Matn xabar\n` +
    `• 📷 Rasm\n` +
    `• 📹 Video\n` +
    `• 🎤 Ovozli xabar\n` +
    `• 📄 Fayl\n` +
    `• 🎵 Audio\n` +
    `• 🎭 GIF\n` +
    `• 🎥 Video xabar (Round)\n\n` +
    `✍️ <i>Javobingizni yuboring:</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('❌ Bekor qilish', 'admin_cancel_reply')]
      ])
    }
  );
}

/**
 * Admin reply state ni bekor qilish
 */
async function cbAdminCancelReply(ctx) {
  await safeAnswerCb(ctx);
  clearState(ctx);
  delete ctx.session.replyTargetUserId;
  delete ctx.session.replyOriginalMsgId;

  await safeEdit(ctx,
    `❌ <b>Javob bekor qilindi</b>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Admin Panel', 'admin_panel_main')]
      ])
    }
  );
}

/**
 * Admin "Javob yozish" state da xabar yuborganda
 * Barcha media turlarini qo'llab-quvvatlaydi
 */
async function handleAdminReplyState(ctx) {
  const targetUserId = ctx.session?.replyTargetUserId;

  if (!targetUserId) {
    clearState(ctx);
    return ctx.reply('❌ Xatolik: Manzil topilmadi. Qayta urinib ko\'ring.');
  }

  // Clear state
  clearState(ctx);
  const savedTargetUserId = targetUserId;
  delete ctx.session.replyTargetUserId;
  delete ctx.session.replyOriginalMsgId;

  return sendAdminMessageToUser(ctx, savedTargetUserId);
}

/**
 * Admin o'z chatida xabarga to'g'ridan-to'g'ri reply qilganda
 * Xabarning caption/text'idan userId ni aniqlab yuboradi
 * 
 * Qanday ishlaydi:
 * 1. Admin foydalanuvchi xabarining COPY'siga reply qiladi
 * 2. Biz o'sha xabar ustidagi "Tezkor harakatlar" xabarini topamiz
 * 3. Undan userId ni o'qiymiz
 * 
 * YOKI: reply qilingan xabarning text'idan parse qilamiz
 */
async function handleAdminReply(ctx, next) {
  // Faqat admin uchun
  if (ctx.from.id !== ADMIN_ID) return next();

  const replyToMsg = ctx.message.reply_to_message;
  if (!replyToMsg) return next();

  // ─── State orqali ishlash (ustuvor) ──────────────
  if (ctx.session?.state === States.ADMIN_REPLY) {
    return handleAdminReplyState(ctx);
  }

  // ─── To'g'ridan-to'g'ri reply orqali ishlash ─────
  // Admin foydalanuvchi xabariga yoki header xabariga reply qildi
  // userId ni text'dan topishga harakat qilamiz

  const replyText = replyToMsg.text || replyToMsg.caption || '';
  
  // "Tezkor harakatlar" xabaridan yoki header xabaridan userId topish
  // Format: "ID: `123456789`" yoki callback data: reply_123456789_...
  let targetUserId = extractUserIdFromAdminMessage(replyText, replyToMsg);

  if (!targetUserId) {
    // userId topilmadi - oddiy xabar, keyingi handlerlarga yuborish
    return next();
  }

  return sendAdminMessageToUser(ctx, targetUserId);
}

/**
 * Admin xabar matnidan userId ni ajratib oladi
 */
function extractUserIdFromAdminMessage(text, msg) {
  if (!text && !msg) return null;

  // "🆔 ID: `123456789`" formatidan
  const idMatch = text.match(/🆔\s*<b>ID:<\/b>\s*<code>(\d+)<\/code>/) ||
                  text.match(/🆔\s*ID:\s*`?(\d+)`?/) ||
                  text.match(/ID:\s*(\d+)/);
  
  if (idMatch) {
    const id = parseInt(idMatch[1], 10);
    if (!isNaN(id) && id > 0) return id;
  }

  // Inline keyboard'dan (reply_markup) userId topish
  if (msg?.reply_markup?.inline_keyboard) {
    for (const row of msg.reply_markup.inline_keyboard) {
      for (const btn of row) {
        if (btn.callback_data) {
          // "reply_123456_..." yoki "ban_user_123456" formatlaridan
          const cbMatch = btn.callback_data.match(
            /(?:reply|ban_user|warn_user|cancel_user_test|admin_show_user|admin_user_stats)_(\d+)/
          );
          if (cbMatch) {
            const id = parseInt(cbMatch[1], 10);
            if (!isNaN(id) && id > 0) return id;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Admin xabarini foydalanuvchiga yuboradi (barcha media turlari)
 */
async function sendAdminMessageToUser(ctx, targetUserId) {
  const msg = ctx.message;

  // ─── Media turini aniqlash ─────────────────────────
  const mediaType = getMediaType(msg);

  // ─── Sending indicator ────────────────────────────
  const sending = await ctx.reply(`📤 Yuborilmoqda → <code>${targetUserId}</code>...`, {
    parse_mode: 'HTML'
  });

  try {
    // ─── Foydalanuvchiga xabar yuborish ───────────────
    // Admin xabarini to'liq copy qilamiz (caption, media barchasi)
    const sentToUser = await ctx.copyMessage(targetUserId, {
      // Caption bo'lsa, ustiga admin tag qo'shmaymiz - xabar clean bo'lsin
    });

    // ─── Admin headerni foydalanuvchiga yuborish ──────
    // Foydalanuvchiga "Admin javob berdi" bildirishnomasi
    await ctx.telegram.sendMessage(
      targetUserId,
      `👨‍💻 <b>ADMIN JAVOB BERDI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⬆️ <i>Yuqoridagi xabar admin tomonidan yuborildi</i>`,
      {
        parse_mode: 'HTML',
        reply_parameters: {
          message_id: sentToUser.message_id,
          allow_sending_without_reply: true
        },
        ...Markup.inlineKeyboard([
          [Markup.button.callback('↩️ Javob berish', 'contact_admin')],
          [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
        ])
      }
    );

    // ─── Admin tasdiqi ─────────────────────────────────
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      sending.message_id,
      undefined,
      `✅ <b>XABAR YUBORILDI!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 <b>Kimga:</b> <code>${targetUserId}</code>\n` +
      `📩 <b>Xabar turi:</b> ${getMediaLabel(mediaType)}\n` +
      `🕐 <b>Vaqt:</b> ${new Date().toLocaleString('uz-UZ')}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              '↩️ Yana javob', 
              `reply_${targetUserId}_0`
            ),
            Markup.button.callback('🔙 Panel', 'admin_panel_main')
          ]
        ])
      }
    );

    logger.info('admin:reply_sent', { 
      targetUserId, 
      adminId: ctx.from.id,
      mediaType 
    });

  } catch (e) {
    console.error('sendAdminMessageToUser error:', e);

    // ─── Xatolik turi bo'yicha xabar ─────────────────
    let errorText = escapeHtml(e.message);
    let hint = '';

    if (e.description?.includes('blocked') || e.message?.includes('blocked')) {
      hint = '⚠️ <i>Foydalanuvchi botni bloklagan!</i>';
    } else if (e.description?.includes('not found') || e.message?.includes('not found')) {
      hint = '⚠️ <i>Foydalanuvchi topilmadi!</i>';
    } else if (e.description?.includes('deactivated')) {
      hint = '⚠️ <i>Foydalanuvchi hisobi o\'chirilgan!</i>';
    }

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      sending.message_id,
      undefined,
      `❌ <b>XATOLIK!</b>\n\n` +
      `${hint}\n` +
      `<code>${errorText}</code>\n\n` +
      `👤 User ID: <code>${targetUserId}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Panel', 'admin_panel_main')]
        ])
      }
    );

    logger.error('admin:reply_error', { 
      targetUserId, 
      error: e.message 
    });
  }
}

/**
 * Xabar turini aniqlash
 */
function getMediaType(msg) {
  if (msg.photo)       return 'photo';
  if (msg.video)       return 'video';
  if (msg.voice)       return 'voice';
  if (msg.audio)       return 'audio';
  if (msg.document)    return 'document';
  if (msg.animation)   return 'animation';
  if (msg.sticker)     return 'sticker';
  if (msg.video_note)  return 'video_note';
  if (msg.text)        return 'text';
  return 'unknown';
}

/**
 * Media turi labeli
 */
function getMediaLabel(type) {
  const labels = {
    text:       '💬 Matn',
    photo:      '📷 Rasm',
    video:      '📹 Video',
    voice:      '🎤 Ovoz',
    audio:      '🎵 Audio',
    document:   '📄 Fayl',
    animation:  '🎭 GIF',
    sticker:    '🎨 Sticker',
    video_note: '🎥 Video xabar',
    unknown:    '❓ Noma\'lum'
  };
  return labels[type] || labels.unknown;
}

// ============================================
// 🚫 ADMIN QUICK ACTIONS - ENHANCED
// ============================================

/**
 * Cancel user's active test
 */
async function cbCancelUserTest(ctx) {
  await safeAnswerCb(ctx);
  const userId = parseSuffix(ctx.callbackQuery.data, 'cancel_user_test_');
  const chatId = parseInt(userId, 10);

  if (isNaN(chatId)) {
    return ctx.answerCbQuery('❌ Noto\'g\'ri user ID', { show_alert: true });
  }

  const checking = await ctx.reply('⏳ Tekshirilmoqda...');

  try {
    const session = await sessionService.getActiveTest(chatId);
    
    if (!session) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        checking.message_id,
        undefined,
        `ℹ️ <b>Faol test yo'q</b>\n\n` +
        `User ID: <code>${userId}</code>\n\n` +
        `<i>Bu foydalanuvchi hozir test yechmayapti.</i>`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    if (session.pollId) {
      await sessionService.deletePollChat(session.pollId).catch(() => {});
    }
    
    await sessionService.deleteActiveTest(chatId);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      checking.message_id,
      undefined,
      `✅ <b>TEST TO'XTATILDI!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 User ID: <code>${userId}</code>\n` +
      `📝 Test turi: ${session.subject || '—'}\n` +
      `📊 Savol: ${session.currentQuestion || 0}/${session.totalQuestions || 0}\n\n` +
      `<i>Foydalanuvchiga xabar yuborildi.</i>`,
      { parse_mode: 'HTML' }
    );

    await ctx.telegram.sendMessage(
      chatId,
      `🛑 <b>TEST TO'XTATILDI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `⚠️ Sizning testingiz admin tomonidan to'xtatildi.\n\n` +
      `📞 Savollaringiz bo'lsa, adminga murojaat qiling.\n\n` +
      `<i>Yangi test boshlashingiz mumkin.</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📞 Adminga yozish', 'contact_admin')],
          [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
        ])
      }
    ).catch(() => {});

    logger.info('admin:cancel_test', { targetUserId: userId, adminId: ctx.from.id });

  } catch (e) {
    console.error('cbCancelUserTest error:', e.message);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      checking.message_id,
      undefined,
      `❌ <b>Xatolik!</b>\n\n${escapeHtml(e.message)}`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * Warn user
 */
async function cbWarnUser(ctx) {
  await safeAnswerCb(ctx);
  const userId = parseSuffix(ctx.callbackQuery.data, 'warn_user_');

  await safeEdit(ctx,
    `⚠️ <b>OGOHLANTIRISH YUBORISH</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 User ID: <code>${userId}</code>\n\n` +
    `📝 Ogohlantirish matnini yozing:`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📋 Shablon ishlatish', `warn_template_${userId}`)],
        [Markup.button.callback('❌ Bekor qilish', 'admin_panel_main')]
      ])
    }
  );

  setState(ctx, States.ADMIN_WARNING);
  await ctx.session.save({ warning_target_id: userId });
}

/**
 * Send warning template
 */
async function cbWarnTemplate(ctx) {
  await safeAnswerCb(ctx);
  const userId = parseSuffix(ctx.callbackQuery.data, 'warn_template_');
  const chatId = parseInt(userId, 10);

  try {
    const warningText = 
      `⚠️ <b>OGOHLANTIRISH</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Hurmatli foydalanuvchi,\n\n` +
      `Siz bot qoidalarini buzganingiz uchun ogohlantirish olmoqdasiz.\n\n` +
      `📋 <b>Qoidalar:</b>\n` +
      `• Spamdan saqlaning\n` +
      `• Faqat o'quvchilik maqsadida foydalaning\n` +
      `• Boshqa foydalanuvchilarga to'sqinlik qilmang\n\n` +
      `⚠️ Keyingi buzilish ban bilan yakunlanadi.\n\n` +
      `<i>Savol bo'lsa: /admin</i>`;

    await ctx.telegram.sendMessage(chatId, warningText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Tushundim', 'back_to_main')],
        [Markup.button.callback('📞 Tushuntirish so\'rash', 'contact_admin')]
      ])
    });

    await safeEdit(ctx,
      `✅ <b>Ogohlantirish yuborildi!</b>\n\n` +
      `User ID: <code>${userId}</code>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Orqaga', 'admin_panel_main')]
        ])
      }
    );

    logger.info('admin:warn', { targetUserId: userId });

  } catch (e) {
    console.error('cbWarnTemplate error:', e);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi', { show_alert: true });
  }
}

/**
 * Ban user (enhanced confirmation)
 */
async function cbBanUser(ctx) {
  await safeAnswerCb(ctx);
  const userId = parseSuffix(ctx.callbackQuery.data, 'ban_user_');

  try {
    const users = await dbService.getAllUsers();
    const user = users?.find(u => u.telegram_id === parseInt(userId, 10));
    
    const userName = user?.full_name 
      ? escapeHtml(sanitizeForTelegram(user.full_name))
      : 'Noma\'lum';

    await safeEdit(ctx,
      `⛔ <b>BAN TASDIQLASH</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 <b>Foydalanuvchi:</b> ${userName}\n` +
      `🆔 <b>ID:</b> <code>${userId}</code>\n\n` +
      `⚠️ <b>OGOHLANTIRISH:</b>\n` +
      `Bu amal qaytarilmaydi!\n\n` +
      `Foydalanuvchi:\n` +
      `• Botdan foydalana olmaydi\n` +
      `• Barcha ma'lumotlari saqlanadi\n` +
      `• Faqat admin unban qila oladi\n\n` +
      `❓ <b>Ishonchingiz komilmi?</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ HA, Ban qilish', `confirm_ban_${userId}`)],
          [Markup.button.callback('❌ YO\'Q, Bekor qilish', 'admin_panel_main')]
        ])
      }
    );
  } catch (e) {
    console.error('cbBanUser error:', e.message);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi', { show_alert: true });
  }
}

/**
 * Confirm ban with notification
 */
async function cbConfirmBan(ctx) {
  await safeAnswerCb(ctx);
  const userId = parseSuffix(ctx.callbackQuery.data, 'confirm_ban_');
  const chatId = parseInt(userId, 10);

  const banning = await ctx.reply('⏳ Ban qilinmoqda...');

  try {
    await dbService.banUser(chatId);

    const users = await dbService.getAllUsers();
    const user = users?.find(u => u.telegram_id === chatId);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      banning.message_id,
      undefined,
      `⛔ <b>FOYDALANUVCHI BAN QILINDI!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 ${user?.full_name || 'Noma\'lum'}\n` +
      `🆔 <code>${userId}</code>\n\n` +
      `✅ Foydalanuvchiga xabar yuborildi.`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔙 Dashboard', 'admin_panel_main')]
        ])
      }
    );

    await ctx.telegram.sendMessage(
      chatId,
      `⛔ <b>HISOBINGIZ BLOKLANDI</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Sizning hisobingiz admin tomonidan bloklandi.\n\n` +
      `📞 <b>Savol bo'lsa:</b> @AvazovM\n\n` +
      `<i>Ban sababi haqida ma'lumot olish uchun adminga murojaat qiling.</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});

    logger.info('admin:ban', { 
      targetUserId: userId,
      adminId: ctx.from.id,
      userName: user?.full_name
    });

  } catch (e) {
    console.error('cbConfirmBan error:', e.message);
    
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      banning.message_id,
      undefined,
      `❌ <b>Xatolik!</b>\n\n${escapeHtml(e.message)}`,
      { parse_mode: 'HTML' }
    );
  }
}

// ============================================
// 🛠 HELPER FUNCTIONS
// ============================================

/**
 * Parse suffix from callback data
 */
function parseSuffix(data, prefix) {
  if (!data || !data.startsWith(prefix)) return '';
  return data.slice(prefix.length);
}

// ============================================
// 🔗 REGISTRATION
// ============================================

function register(bot) {
  // Contact admin
  bot.action('contact_admin', cbInitContact);
  
  // ─── Admin reply actions ─────────────────────────
  bot.action(/^reply_\d+_\d+$/, cbAdminReplyToUser);
  bot.action('admin_cancel_reply', cbAdminCancelReply);

  // ─── Admin quick actions ─────────────────────────
  bot.action(/^cancel_user_test_/, cbCancelUserTest);
  bot.action(/^warn_user_/, cbWarnUser);
  bot.action(/^warn_template_/, cbWarnTemplate);
  bot.action(/^ban_user_/, cbBanUser);
  bot.action(/^confirm_ban_/, cbConfirmBan);
  
  // ─── Message handler ─────────────────────────────
  // ⚠️ MUHIM: Bu handler eng oxirida bo'lishi kerak
  bot.on('message', handleContactMessages);
}

module.exports = { 
  register,
  cbInitContact,
  handleContactMessages
};