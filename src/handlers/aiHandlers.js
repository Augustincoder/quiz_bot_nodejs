'use strict';
const { Markup } = require('telegraf');
const aiService = require('../services/aiService');
const { States, setState, safeEdit, clearState, backToMainKb } = require('../core/utils');
const { config } = require('dotenv');
const { ADMIN_ID } = require('../config/config');
const { request } = require('express');

// ============================================
// 📊 RATE LIMITING VA USAGE TRACKING
// ============================================

// User-level rate limit (har bir user uchun)
const userRateLimit = new Map(); // { userId: { count: 0, resetTime: timestamp } }

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
        dailyUsage = { count: 0, date: today, maxDaily: maxDaily };
    }

    // Yangi oy boshlansa, reset
    if (monthlyUsage.month !== currentMonth || monthlyUsage.year !== currentYear) {
        monthlyUsage = { count: 0, month: currentMonth, year: currentYear, maxMonthly: maxMonthly };
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
function checkUserLimit(userId, isPremium = false, isAdmin = false) {
    if (isAdmin && USER_LIMITS.ADMIN_UNLIMITED) {
        return { allowed: true };
    }

    const now = Date.now();
    const userLimit = userRateLimit.get(userId);

    const dailyMax = isPremium ? USER_LIMITS.PREMIUM_USER_DAILY : USER_LIMITS.FREE_USER_DAILY;
    const hourlyMax = USER_LIMITS.FREE_USER_HOURLY;

    if (!userLimit) {
        // Birinchi marta foydalanayotgan user
        userRateLimit.set(userId, {
            dailyCount: 1,
            hourlyCount: 1,
            dailyResetTime: now + 24 * 60 * 60 * 1000, // 24 soat
            hourlyResetTime: now + 60 * 60 * 1000      // 1 soat
        });
        return { allowed: true };
    }

    // Hourly reset
    if (now > userLimit.hourlyResetTime) {
        userLimit.hourlyCount = 0;
        userLimit.hourlyResetTime = now + 60 * 60 * 1000;
    }

    // Daily reset
    if (now > userLimit.dailyResetTime) {
        userLimit.dailyCount = 0;
        userLimit.dailyResetTime = now + 24 * 60 * 60 * 1000;
    }

    // Check limits
    if (userLimit.hourlyCount >= hourlyMax) {
        const minutesLeft = Math.ceil((userLimit.hourlyResetTime - now) / 60000);
        return { allowed: false, reason: 'hourly_limit', minutesLeft };
    }

    if (userLimit.dailyCount >= dailyMax) {
        const hoursLeft = Math.ceil((userLimit.dailyResetTime - now) / 3600000);
        return { allowed: false, reason: 'daily_user_limit', hoursLeft };
    }

    // Increment counters
    userLimit.dailyCount++;
    userLimit.hourlyCount++;

    return { allowed: true, remaining: dailyMax - userLimit.dailyCount };
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
    try {
        await ctx.answerCbQuery().catch(() => { });

        const text = `🤖 *AI Tutor — Shaxsiy O'quv Yordamchingiz*

Sun'iy Intellekt sizga ikki xil yo'lda yordam beradi:

🧠 *Smart Quiz* — Matn yoki rasmdan avtomatik test tuzib beradi
📝 *Insho Tahlili* — Yozgan matningizni tekshirib, baho va maslahat beradi

━━━━━━━━━━━━━━━━
*Qaysi xizmatdan foydalanmoqchisiz?*`;

        const buttons = [
            [Markup.button.callback('🧠 Smart Quiz (Matn/Rasmdan test)', 'fmt_ai')],
            [Markup.button.callback('📝 Insho va Tarjima tahlili', 'ai_essay_init')],
            [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
        ];

        await safeEdit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
    } catch (e) {
        console.error(e);
    }
}

async function cbAiEssayInit(ctx) {
    try {
        await ctx.answerCbQuery().catch(() => { });

        setState(ctx, States.AI_ESSAY_ANALYSIS);

        const userId = ctx.from.id;
        const userLimit = userRateLimit.get(userId);
        const isPremium = false; // Bu yerda premium statusni tekshiring
        const dailyMax = isPremium ? USER_LIMITS.PREMIUM_USER_DAILY : USER_LIMITS.FREE_USER_DAILY;
        const remaining = userLimit ? dailyMax - userLimit.dailyCount : dailyMax;

        const text = `📝 *Insho / Tarjima Tahlili*

Yozgan matningizni (IELTS essay, maqola, tarjima yoki boshqa yozma ish) shu chatga yuboring.

🤖 *AI Tutor quyidagilarni tahlil qiladi:*
• ✍️ Grammatik xatolar va ularni tuzatish
• 📚 So'z boyligi (Vocabulary) darajasi
• 🏗 Matn tuzilmasi va mantiqiy ketma-ketlik
• 💯 100 ballik tizimda umumiy baho

━━━━━━━━━━━━━━━━
💡 _Kamida 2–3 gapdan iborat matn yuboring. Uzunroq matn — batafsilroq tahlil!_

📊 *Sizning limitingiz:* ${remaining}/${dailyMax} (bugun)`;

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
    
    const userId = ctx.from.id;
    const userLimit = userRateLimit.get(userId);
    const dailyMax = USER_LIMITS.FREE_USER_DAILY;
    const remaining = userLimit ? dailyMax - userLimit.dailyCount : dailyMax;

    await safeEdit(
        ctx,
        `✍️ <b>Yozma matn tahlili (AI Tutor)</b>\n\nTekshirmoqchi bo'lgan matningizni (insho, tarjima, javobingiz) shu yerga yuboring.\n\n🤖 <b>AI Tutor:</b>\n• Xatolaringizni topadi va tushuntiradi\n• Matnni baholaydi (100 ball)\n• Yaxshilash bo'yicha maslahat beradi.\n\n👇 <b>Matnni quyiga yozing:</b>\n\n📊 Limitingiz: ${remaining}/${dailyMax} (bugun)${AI_WARNING_TEXT}`,
        { parse_mode: 'HTML', ...backToMainKb() }
    );
}

async function onEssayInput(ctx) {
    const text = ctx.message.text;
    const userId = ctx.from.id;
    
    // Admin ro'yxati (o'zingizning admin ID larni qo'shing)
    const ADMIN_IDS = config.ADMIN_ID ? [parseInt(config.ADMIN_ID, 10)] : [];
   // Sizning admin ID
    const isAdmin = ADMIN_IDS.includes(userId);
    const isPremium = false; // Premium statusni DB dan olish kerak

    // Matn uzunligini tekshirish
    if (!text || text.length < 15) {
        return ctx.reply("⚠️ Matn juda qisqa.\n\nSifatli tahlil uchun kamida 2–3 gapdan iborat matn yuboring. Uzunroq matn — batafsilroq natija!");
    }

    // 🔒 Global limitni tekshirish
    const globalCheck = checkGlobalLimit();
    if (!globalCheck.allowed) {
        if (globalCheck.reason === 'daily_limit') {
            return ctx.reply(
                "⚠️ *Kunlik limit to'ldi!*\n\n" +
                "Tizim bugun maksimal so'rovlar soniga yetdi. Iltimos, ertaga qayta urinib ko'ring.\n\n" +
                "Premium foydalanuvchilar uchun: @AvazovM",
                { parse_mode: 'Markdown' }
            );
        } else if (globalCheck.reason === 'monthly_limit') {
            return ctx.reply(
                "⚠️ *Oylik limit to'ldi!*\n\nKeyingi oy uchun admindan yangi kvota so'rang: @AvazovM",
                { parse_mode: 'Markdown' }
            );
        }
    }

    // 🔒 User-level limitni tekshirish
    const userCheck = checkUserLimit(userId, isPremium, isAdmin);
    if (!userCheck.allowed) {
        if (userCheck.reason === 'hourly_limit') {
            return ctx.reply(
                `⏳ *Soatlik limit tugadi!*\n\n` +
                `Keyingi so'rovni ${userCheck.minutesLeft} daqiqadan keyin yuborishingiz mumkin.\n\n` +
                `💎 Ko'proq limit uchun: @AvazovM`,
                { parse_mode: 'Markdown' }
            );
        } else if (userCheck.reason === 'daily_user_limit') {
            return ctx.reply(
                `📊 *Bugungi limitingiz tugadi!*\n\n` +
                `Keyingi tekshiruvni ${userCheck.hoursLeft} soatdan keyin amalga oshirishingiz mumkin.\n\n` +
                `💎 Premium foydalanuvchilar kuniga 50 tagacha tekshiruv oladi: @AvazovM`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    const msg = await ctx.reply("⏳ <i>AI Tutor matningizni tekshirmoqda...</i>", { parse_mode: 'HTML' });

    try {
        const analysis = await aiService.analyzeEssay(text);

        // ✅ Muvaffaqiyatli so'rov — global usageni oshiramiz
        incrementGlobalUsage();

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
    getUsageStats  // Admin uchun statistika
};