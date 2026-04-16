'use strict';
// const { safeEdit, backToMainKb } = require('../core/utils');
const { Markup } = require('telegraf');
const aiService = require('../services/aiService');
const { States, setState, safeEdit, clearState, backToMainKb } = require('../core/utils');

const AI_WARNING_TEXT = `\n\n⚠️ <i>Eslatma: Bu javoblar tezkor AI modellarida tayyorlanmoqda va xatolar ehtimolligi bor. Rasmiy imtihonga tayyorlanayotganlar yoki Pro darajadagi kuchli modellar uchun adminga murojaat qiling: @AvazovM</i>`;


// AI Tutor bosh menyusi
async function cbAiTutorMenu(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });

        const text = `🤖 *AI Tutor — Shaxsiy O'quv Yordamchingiz*

Sun'iy Intellekt sizga ikki xil yo'lda yordam beradi:

🧠 *Smart Quiz* — Matn yoki rasmdan avtomatik test tuzib beradi
📝 *Insho Tahlili* — Yozgan matningizni tekshirib, baho va maslahat beradi

━━━━━━━━━━━━━━━━
*Qaysi xizmatdan foydalanmoqchisiz?*`;

        const buttons = [
            [Markup.button.callback('🧠 Smart Quiz (Matn/Rasmdan test)', 'fmt_ai')], // TestCreation.js dagi funksiyaga ulanadi
            [Markup.button.callback('📝 Insho va Tarjima tahlili', 'ai_essay_init')],
            [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
        ];

        await safeEdit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {
        console.error(e);
    }
}

// Insho tekshirishga kirish
async function cbAiEssayInit(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });

        // Bu yerda States.AI_ESSAY_ANALYSIS ni yoqishimiz kerak
        const { setState, States } = require('../core/utils');
        setState(ctx, States.AI_ESSAY_ANALYSIS);

        const text = `📝 *Insho / Tarjima Tahlili*

Yozgan matningizni (IELTS essay, maqola, tarjima yoki boshqa yozma ish) shu chatga yuboring.

🤖 *AI Tutor quyidagilarni tahlil qiladi:*
• ✍️ Grammatik xatolar va ularni tuzatish
• 📚 So'z boyligi (Vocabulary) darajasi
• 🏗 Matn tuzilmasi va mantiqiy ketma-ketlik
• 💯 100 ballik tizimda umumiy baho

━━━━━━━━━━━━━━━━
💡 _Kamida 2–3 gapdan iborat matn yuboring. Uzunroq matn — batafsilroq tahlil!_`;

        await safeEdit(ctx, text, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Orqaga', 'ai_tutor_menu')],
                [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
            ])
        });
    } catch (e) {
        console.error(e);
    }
}



async function cbAiEssayMenu(ctx) {
    await ctx.answerCbQuery().catch(() => { });
    setState(ctx, States.AI_ESSAY_ANALYSIS);
    await safeEdit(
        ctx,
        `✍️ <b>Yozma matn tahlili (AI Tutor)</b>\n\nTekshirmoqchi bo'lgan matningizni (insho, tarjima, javobingiz) shu yerga yuboring.\n\n🤖 <b>AI Tutor:</b>\n• Xatolaringizni topadi va tushuntiradi\n• Matnni baholaydi (100 ball)\n• Yaxshilash bo'yicha maslahat beradi.\n\n👇 <b>Matnni quyiga yozing:</b>${AI_WARNING_TEXT}`,
        { parse_mode: 'HTML', ...backToMainKb() }
    );
}

async function onEssayInput(ctx) {
    const text = ctx.message.text;
    if (!text || text.length < 15) {
        return ctx.reply("⚠️ Matn juda qisqa.\n\nSifatli tahlil uchun kamida 2–3 gapdan iborat matn yuboring. Uzunroq matn — batafsilroq natija!");
    }

    const msg = await ctx.reply("⏳ <i>AI Tutor matningizni tekshirmoqda...</i>", { parse_mode: 'HTML' });

    const analysis = await aiService.analyzeEssay(text);

    // AIdan kelgan javobni HTML rejimida chiqaramiz
    try {
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            msg.message_id,
            undefined,
            `${analysis}${AI_WARNING_TEXT}`,
            { parse_mode: 'HTML', ...backToMainKb() }
        );
    } catch (e) {
        // Agar HTML da ham kutilmagan belgi o'tib ketsa, oddiy text qilib jo'natib yuboradi
        console.error("HTML tahlil xatosi:", e.message);
        await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, undefined, analysis + "\n\n@AvazovM", backToMainKb());
    }

    clearState(ctx);
}


function register(bot) {
    bot.action('ai_menu', cbAiTutorMenu);        // Main menu button
    bot.action('ai_tutor_menu', cbAiTutorMenu);   // Back button from sub-screens
    bot.action('ai_essay_menu', cbAiEssayMenu);
    bot.action('ai_essay_init', cbAiEssayInit);
}

module.exports = { register, onEssayInput, cbAiTutorMenu, cbAiEssayInit };