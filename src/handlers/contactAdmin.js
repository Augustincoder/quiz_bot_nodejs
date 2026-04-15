'use strict';

const { Markup } = require('telegraf');

const ADMIN_ID = Number(process.env.ADMIN_ID) || 123456789;
const contactStates = new Map();

function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Foydalanuvchi "Adminga murojaat" tugmasini bosganda
async function cbInitContact(ctx) {
    await ctx.answerCbQuery().catch(() => {});
    contactStates.set(ctx.from.id, { step: 'WAITING_USER_MSG' });

    await ctx.editMessageText(
        `👨‍💻 <b>Adminga Murojaat</b>\n\nSavol, taklif yoki muammoingizni shu yerda yozib qoldiring.\n📷 <i>Matn, rasm, video, link yoki ovozli xabar yuborishingiz mumkin.</i>\n\nAdmin sizga tez orada javob beradi.`,
        {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'post_main')]])
        }
    );
}

// Barcha xabarlarni tutib oluvchi markaz
async function handleContactMessages(ctx, next) {
    if (!ctx.message) return next();

    const userId = ctx.from.id;
    const state = contactStates.get(userId);
    if (!state) return next();

    // ──────────────────────────────────────────
    // A) FOYDALANUVCHI → ADMIN
    // ──────────────────────────────────────────
    if (state.step === 'WAITING_USER_MSG') {
        contactStates.delete(userId);

        try {
            const userLink = `<a href="tg://user?id=${userId}">${escapeHtml(ctx.from.first_name)}</a>`;

            // 1. Kimdan kelgani haqida xabar
            await ctx.telegram.sendMessage(
                ADMIN_ID,
                `📩 <b>YANGI MUROJAAT</b>\n👤 Kimdan: ${userLink} (<code>${userId}</code>)\n👇 Xabar mazmuni:`,
                { parse_mode: 'HTML' }
            );

            // 2. Foydalanuvchining xabarini admin chatiga nusxalash
            const copiedMsg = await ctx.copyMessage(ADMIN_ID);

            // 3. Nusxalangan xabarga reply qilib "Javob yozish" tugmasini joylash
            //    callback dataga: targetId (user chat id) va targetMsgId (user chatidagi original msg id) saqlanadi
            await ctx.telegram.sendMessage(
                ADMIN_ID,
                `✏️ <i>Yuqoridagi xabarga javob berish uchun tugmani bosing:</i>`,
                {
                    parse_mode: 'HTML',
                    reply_parameters: {
                        message_id: copiedMsg.message_id,
                        allow_sending_without_reply: true
                    },
                    ...Markup.inlineKeyboard([[
                        Markup.button.callback('✉️ Javob yozish', `reply_${userId}_${ctx.message.message_id}`)
                    ]])
                }
            );

            await ctx.reply(
                "✅ Xabaringiz adminga muvaffaqiyatli yuborildi. Javobni kuting!",
                {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Asosiy Menyu', 'post_main')]])
                }
            );
        } catch (e) {
            console.error("Adminga xabar yuborishda xato:", e);
            await ctx.reply("❌ Xatolik yuz berdi. Iltimos, keyinroq urinib ko'ring.");
        }
        return;
    }

    return next();
}


function register(bot) {
    bot.action('contact_admin', cbInitContact);
    // reply_ action FAQAT adminHandlers.js da ro'yxatdan o'tkaziladi
    bot.on('message', handleContactMessages);
}

module.exports = { register };