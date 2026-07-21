'use strict';

const { Markup } = require('telegraf');
const { supabase } = require('../lib/supabase');
const { activatePremium } = require('../services/dbService');
const { ADMIN_ID } = require('../config/config');
const { setState, clearState, States, safeAnswerCb, safeEdit } = require('../core/utils');

async function cbPremiumMenu(ctx) {
  await safeAnswerCb(ctx);
  const text = `💎 <b>Premium Obuna</b>\n\n` +
    `🚀 <b>Premium obuna afzalliklari:</b>\n` +
    `• Cheklanmagan AI testlar yaratish\n` +
    `• Batafsil statistika va tahlillar\n` +
    `• Insho tahlili va barcha maxsus imkoniyatlar\n\n` +
    `💳 <b>To'lov ma'lumotlari:</b>\n` +
    `Karta raqami: <code>8600 0000 0000 0000</code>\n` +
    `Narxi (30 kun): <b>29 000 UZS</b>\n\n` +
    `To'lovni amalga oshirgach, chek (skrinshot) yuborish uchun quyidagi tugmani bosing:`;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📸 Chek yuborish', 'pay_send_receipt')],
    [Markup.button.callback('🔙 Ortga', 'back_to_main')]
  ]);

  await safeEdit(ctx, text, { reply_markup: keyboard.reply_markup });
}

async function onPaySendReceipt(ctx) {
  await safeAnswerCb(ctx);
  setState(ctx, States.WAITING_PAYMENT_RECEIPT);
  await ctx.reply(
    "📸 Iltimos, to'lov chekini (rasm/skrinshot) yuboring:",
    { parse_mode: 'HTML' }
  );
}

async function handlePaymentReceipt(ctx) {
  const photo = ctx.message?.photo;
  const doc = ctx.message?.document;
  let screenshotFileId = null;

  if (photo && photo.length > 0) {
    screenshotFileId = photo[photo.length - 1].file_id;
  } else if (doc && doc.mime_type && doc.mime_type.startsWith('image/')) {
    screenshotFileId = doc.file_id;
  }

  if (!screenshotFileId) {
    return ctx.reply("⚠️ Iltimos, to'lov chekini rasm (skrinshot) shaklida yuboring.");
  }

  const userId = ctx.from.id;
  const { data, error } = await supabase
    .from('payment_requests')
    .insert({
      user_id: String(userId),
      screenshot_file_id: screenshotFileId,
      amount_uzs: 29000,
      plan: 'premium',
      status: 'pending',
      created_at: new Date().toISOString()
    })
    .select('id');

  if (error || !data || data.length === 0) {
    console.error("To'lov so'rovini saqlashda xato:", error?.message);
    return ctx.reply("⚠️ Xatolik yuz berdi. Iltimos, keyinroq qayta urinib ko'ring.");
  }

  const requestId = data[0].id;
  clearState(ctx);

  await ctx.reply("✅ To'lov cheki qabul qilindi. Adminga yuborildi va tez orada ko'rib chiqiladi.");

  const adminMsg = `💳 <b>Yangi to'lov so'rovi!</b>\n\n` +
    `👤 Foydalanuvchi ID: <code>${userId}</code>\n` +
    `📝 Tarif: <b>Premium</b> (30 kun)\n` +
    `💰 Summa: <b>29 000 UZS</b>\n` +
    `🔖 So'rov ID: <code>${requestId}</code>`;

  const adminKb = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Tasdiqlash', `pay_approve_${requestId}`),
      Markup.button.callback('❌ Rad etish', `pay_reject_${requestId}`)
    ]
  ]);

  try {
    await ctx.telegram.sendPhoto(ADMIN_ID, screenshotFileId, {
      caption: adminMsg,
      parse_mode: 'HTML',
      reply_markup: adminKb.reply_markup
    });
  } catch (e) {
    console.error("Adminga rasm yuborishda xato:", e.message);
  }
}

async function onPayApprove(ctx) {
  await safeAnswerCb(ctx);
  const requestId = ctx.match[1];

  const { data: request, error: getErr } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (getErr || !request) {
    return ctx.reply("⚠️ To'lov so'rovi topilmadi.");
  }

  await supabase
    .from('payment_requests')
    .update({
      status: 'approved',
      reviewed_by: String(ctx.from.id)
    })
    .eq('id', requestId);

  await activatePremium(request.user_id, 30);

  await safeEdit(ctx, `✅ To'lov so'rovi (ID: ${requestId}) tasdiqlandi va Premium (30 kun) faollashtirildi.`);

  try {
    await ctx.telegram.sendMessage(
      request.user_id,
      "🎉 <b>Tabriklaymiz!</b> Sizning to'lovingiz tasdiqlandi va <b>Premium</b> obunangiz 30 kunga faollashtirildi! 💎",
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error("Foydalanuvchiga xabar yuborishda xato:", e.message);
  }
}

async function onPayReject(ctx) {
  await safeAnswerCb(ctx);
  const requestId = ctx.match[1];

  const { data: request, error: getErr } = await supabase
    .from('payment_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (getErr || !request) {
    return ctx.reply("⚠️ To'lov so'rovi topilmadi.");
  }

  await supabase
    .from('payment_requests')
    .update({
      status: 'rejected',
      reviewed_by: String(ctx.from.id)
    })
    .eq('id', requestId);

  await safeEdit(ctx, `❌ To'lov so'rovi (ID: ${requestId}) rad etildi.`);

  try {
    await ctx.telegram.sendMessage(
      request.user_id,
      "❌ Sizning to'lov chekingiz rad etildi. Iltimos, ma'lumotlarni tekshirib qayta urinib ko'ring yoki admin bilan bog'laning.",
      { parse_mode: 'HTML' }
    );
  } catch (e) {
    console.error("Foydalanuvchiga xabar yuborishda xato:", e.message);
  }
}

function register(bot) {
  bot.command('premium', cbPremiumMenu);
  bot.action('premium_menu', cbPremiumMenu);
  bot.action('pay_send_receipt', onPaySendReceipt);
  bot.action(/^pay_approve_(.+)$/, onPayApprove);
  bot.action(/^pay_reject_(.+)$/, onPayReject);
}

module.exports = {
  register,
  cbPremiumMenu,
  handlePaymentReceipt,
  onPaySendReceipt,
  onPayApprove,
  onPayReject,
};
