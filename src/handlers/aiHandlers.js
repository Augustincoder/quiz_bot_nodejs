'use strict';

const aiService = require('../services/aiService');
const { States, setState, safeEdit, clearState, backToMainKb } = require('../core/utils');

const AI_WARNING_TEXT = `\n\n⚠️ <i>Eslatma: Bu javoblar tezkor AI modellarida tayyorlanmoqda va xatolar ehtimolligi bor. Rasmiy imtihonga tayyorlanayotganlar yoki Pro darajadagi kuchli modellar uchun adminga murojaat qiling: @AvazovM</i>`;

async function cbAiEssayMenu(ctx) {
    await ctx.answerCbQuery();
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
        return ctx.reply("⚠️ Matn juda qisqa. Kamida 1-2 gapdan iborat matn yuboring.");
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
    bot.action('ai_essay_menu', cbAiEssayMenu);
}

module.exports = { register, onEssayInput };