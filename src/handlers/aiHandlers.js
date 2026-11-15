'use strict';
const { Markup } = require('telegraf');
const aiService = require('../services/aiService');
const aiRateLimiter = require('../services/aiRateLimiter');
const { States, setState, safeEdit, clearState, backToMainKb, isAdmin: checkIsAdmin, TTLMap } = require('../core/utils');

// ============================================
// 📊 RATE LIMITING VA USAGE TRACKING
// ============================================

// User-level rate limit (har bir user uchun xotira chegaralangan TTLMap)
const userRateLimit = new TTLMap(24 * 60 * 60 * 1000, 1000); // 24 soatlik TTL, max 1000 ta slot
// In-flight active request lock to prevent duplicate concurrent AI executions (Bug 45)
const activeAiUsers = new Set();

// Global daily usage tracker
let dailyUsage = {
    count: 0,
    date: new Date().toDateString(),
    maxDaily: 50 // kunlik maksimal so'rovlar soni
};

// Monthly usage tracker
let monthlyUsage = {
    count: 0,
    month: new Date().getMonth(),
    year: new Date().getFullYear(),
    maxMonthly: 200 // oylik maksimal so'rovlar
};

// User limit settings
const USER_LIMITS = {
    FREE_USER_DAILY: 10,        // oddiy user uchun kunlik limit
    FREE_USER_HOURLY: 5,       // soatlik limit
    PREMIUM_USER_DAILY: 50,    // premium user uchun kunlik
    ADMIN_UNLIMITED: true      // adminlar uchun cheksiz
};

const AI_WARNING_TEXT = `\n\n⚠️ <i>Eslatma: Bu javoblar tezkor AI modellarida tayyorlanmoqda va xatolar ehtimolligi bor. Rasmiy imtihonga tayyorlanayotganlar yoki Pro darajadagi kuchli modellar uchun adminga murojaat qiling: @AvazovM</i>`;

// ============================================
// 🔒 RATE LIMIT CHECK FUNCTIONS
// ============================================

/**
 * Global daily/monthly limitni tekshirish
 */
function checkGlobalLimit() {
    const today = new Date().toDateString();
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    // Yangi kun boshlansa, reset qilamiz
    if (dailyUsage.date !== today) {
        dailyUsage = { count: 0, date: today, maxDaily: dailyUsage.maxDaily };
    }

    // Yangi oy boshlansa, reset
    if (monthlyUsage.month !== currentMonth || monthlyUsage.year !== currentYear) {
        monthlyUsage = { count: 0, month: currentMonth, year: currentYear, maxMonthly: monthlyUsage.maxMonthly };
    }

    // Limitni tekshirish
    if (dailyUsage.count >= dailyUsage.maxDaily) {
        return { allowed: false, reason: 'daily_limit' };
    }

    if (monthlyUsage.count >= monthlyUsage.maxMonthly) {
        return { allowed: false, reason: 'monthly_limit' };
    }

    return { allowed: true };
}

/**
 * User-level rate limit tekshirish
 */
async function checkUserLimit(userId, isPremium = false, isAdmin = false) {
    return await aiRateLimiter.checkUserLimit(userId, isPremium, isAdmin);
}

/**
 * Global usageni increment qilish
 */
function incrementGlobalUsage() {
    dailyUsage.count++;
    monthlyUsage.count++;
}

// ============================================
// 🤖 AI TUTOR FUNCTIONS
// ============================================

async function cbAiTutorMenu(ctx) {
    clearState(ctx);
    try {
        await ctx.answerCbQuery().catch(() => { });

        const text = `🤖 <b>AI Tutor — Shaxsiy O'quv Yordamchingiz</b>\n\n` +
            `Sun'iy Intellekt sizga ikki xil yo'lda yordam beradi:\n\n` +
            `🧠 <b>Smart Quiz</b> — Matn yoki rasmdan avtomatik test tuzib beradi\n` +
            `📝 <b>Insho Tahlili</b> — Yozgan matningizni tekshirib, baho va maslahat beradi\n\n` +
            `━━━━━━━━━━━━━━━━\n` +
            `<b>Qaysi xizmatdan foydalanmoqchisiz?</b>`;

        const buttons = [
            [Markup.button.callback('🧠 Smart Quiz (Matn/Rasmdan test)', 'fmt_ai')],
            [Markup.button.callback('📝 Insho va Tarjima tahlili', 'ai_essay_init')],
            [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
        ];

        await safeEdit(ctx, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {
        console.error(e);
    }
}

async function cbAiEssayInit(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });

        setState(ctx, States.AI_ESSAY_ANALYSIS);

        const userId = ctx.from.id;
        const isPremium = false; // Bu yerda premium statusni tekshiring
        const dailyMax = isPremium ? USER_LIMITS.PREMIUM_USER_DAILY : USER_LIMITS.FREE_USER_DAILY;
        const limitInfo = await aiRateLimiter.checkUserLimit(userId, isPremium, checkIsAdmin(userId));
        const remaining = limitInfo.remaining !== undefined ? Math.min(dailyMax, limitInfo.remaining) : dailyMax;

        const text = `📝 <b>Insho / Tarjima Tahlili</b>\n\n` +
`Yozgan matningizni (IELTS essay, maqola, tarjima yoki boshqa yozma ish) shu chatga yuboring.\n\n` +
`🤖 <b>AI Tutor quyidagilarni tahlil qiladi:</b>\n` +
`• ✍️ Grammatik xatolar va ularni tuzatish\n` +
`• 📚 So'z boyligi (Vocabulary) darajasi\n` +
`• 🏗 Matn tuzilmasi va mantiqiy ketma-ketlik\n` +
`• 💯 100 ballik tizimda umumiy baho\n\n` +
`━━━━━━━━━━━━━━━━\n` +
`💡 <i>Kamida 2–3 gapdan iborat matn yuboring. Uzunroq matn — batafsilroq tahlil!</i>\n\n` +
`📊 <b>Sizning limitingiz:</b> ${remaining}/${dailyMax} (bugun)`;

        await safeEdit(ctx, text, {
            parse_mode: 'HTML',
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
    
    const userId = ctx.from.id;
    const isPremium = false;
    const dailyMax = USER_LIMITS.FREE_USER_DAILY;
    const limitInfo = await aiRateLimiter.checkUserLimit(userId, isPremium, checkIsAdmin(userId));
    const remaining = limitInfo.remaining !== undefined ? Math.min(dailyMax, limitInfo.remaining) : dailyMax;

    await safeEdit(
        ctx,
        `✍️ <b>Yozma matn tahlili (AI Tutor)</b>\n\nTekshirmoqchi bo'lgan matningizni (insho, tarjima, javobingiz) shu yerga yuboring.\n\n🤖 <b>AI Tutor:</b>\n• Xatolaringizni topadi va tushuntiradi\n• Matnni baholaydi (100 ball)\n• Yaxshilash bo'yicha maslahat beradi.\n\n👇 <b>Matnni quyiga yozing:</b>\n\n📊 Limitingiz: ${remaining}/${dailyMax} (bugun)${AI_WARNING_TEXT}`,
        { parse_mode: 'HTML', ...backToMainKb() }
    );
}

async function onEssayInput(ctx) {
    const text = ctx.message?.text?.trim();
    const userId = ctx.from?.id;
    if (!userId) return;

    if (activeAiUsers.has(userId)) {
        return ctx.reply("⏳ Sizning oldingi AI tahlil so'rovingiz bajarilmoqda, iltimos biroz kuting...");
    }
    activeAiUsers.add(userId);
    
    try {
        const isAdminUser = checkIsAdmin(userId);
        const isPremium = false; // Premium statusni DB dan olish kerak

        // Matn uzunligini tekshirish
        if (!text || text.length < 15) {
            return ctx.reply("⚠️ Matn juda qisqa.\n\nSifatli tahlil uchun kamida 2–3 gapdan iborat matn yuboring. Uzunroq matn — batafsilroq natija!");
        }
        if (text.length > 5000) {
            return ctx.reply("⚠️ Matn juda uzun.\n\nMaksimal 5000 ta belgi yuborishingiz mumkin.");
        }

        // 🔒 Global limitni tekshirish
        const globalCheck = checkGlobalLimit();
        if (!globalCheck.allowed) {
            if (globalCheck.reason === 'daily_limit') {
                return ctx.reply(
                    "⚠️ <b>Kunlik limit to'ldi!</b>\n\n" +
                    "Tizim bugun maksimal so'rovlar soniga yetdi. Iltimos, ertaga qayta urinib ko'ring.\n\n" +
                    "Premium foydalanuvchilar uchun: @AvazovM",
                    { parse_mode: 'HTML' }
                );
            } else if (globalCheck.reason === 'monthly_limit') {
                return ctx.reply(
                    "⚠️ <b>Oylik limit to'ldi!</b>\n\nKeyingi oy uchun admindan yangi kvota so'rang: @AvazovM",
                    { parse_mode: 'HTML' }
                );
            }
        }

        // 🔒 User-level limitni tekshirish
        const userCheck = await checkUserLimit(userId, isPremium, isAdminUser);
        if (!userCheck.allowed) {
            if (userCheck.reason === 'hourly_limit') {
                return ctx.reply(
                    `⏳ <b>Soatlik limit tugadi!</b>\n\n` +
                    `Keyingi so'rovni ${userCheck.minutesLeft} daqiqadan keyin yuborishingiz mumkin.\n\n` +
                    `💎 Ko'proq limit uchun: @AvazovM`,
                    { parse_mode: 'HTML' }
                );
            } else if (userCheck.reason === 'daily_user_limit') {
                return ctx.reply(
                    `📊 <b>Bugungi limitingiz tugadi!</b>\n\n` +
                    `Keyingi tekshiruvni ${userCheck.hoursLeft} soatdan keyin amalga oshirishingiz mumkin.\n\n` +
                    `💎 Premium foydalanuvchilar kuniga 50 tagacha tekshiruv oladi: @AvazovM`,
                    { parse_mode: 'HTML' }
                );
            }
        }

        const msg = await ctx.reply("⏳ <i>AI Tutor matningizni tekshirmoqda...</i>", { parse_mode: 'HTML' });

        try {
            const analysis = await aiService.analyzeEssay(text);

            // ✅ Muvaffaqiyatli so'rov — usageni oshiramiz
            incrementGlobalUsage();
            await aiRateLimiter.recordUserUsage(userId).catch(() => {});

            const remaining = userCheck.remaining !== undefined ? userCheck.remaining : '∞';
            const footer = `\n\n📊 Qolgan limitingiz: ${remaining}\n${AI_WARNING_TEXT}`;

            await ctx.telegram.editMessageText(
                ctx.chat.id,
                msg.message_id,
                undefined,
                `${analysis}${footer}`,
                { parse_mode: 'HTML', ...backToMainKb() }
            );
        } catch (e) {
            console.error("AI tahlil xatosi:", e.message);
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                msg.message_id,
                undefined,
                "❌ Xatolik yuz berdi. Iltimos, keyinroq urinib ko'ring.\n\nAdmin: @AvazovM",
                backToMainKb()
            );
        }

        clearState(ctx);
    } finally {
        activeAiUsers.delete(userId);
    }
}

// ============================================
// 📋 ADMIN COMMANDS (ixtiyoriy)
// ============================================

function getUsageStats() {
    return {
        daily: dailyUsage,
        monthly: monthlyUsage,
        activeUsers: userRateLimit.size
    };
}

// ============================================
// 🔗 REGISTRATION
// ============================================

function register(bot) {
    bot.action('ai_menu', cbAiTutorMenu);
    bot.action('ai_tutor_menu', cbAiTutorMenu);
    bot.action('ai_essay_menu', cbAiEssayMenu);
    bot.action('ai_essay_init', cbAiEssayInit);
}

module.exports = { 
    register, 
    onEssayInput, 
    cbAiTutorMenu, 
    cbAiEssayInit,
    getUsageStats,  // Admin uchun statistika
    _activeAiUsers: activeAiUsers,
};