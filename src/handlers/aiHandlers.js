'use strict';
const { Markup } = require('telegraf');
const aiService = require('../services/aiService');
const { States, setState, safeEdit, clearState, backToMainKb } = require('../core/utils');
const { ADMIN_ID } = require('../config/config');
const redisConnection = require('../services/redisService');

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
 * In-memory Map xotira tozaligi (memory leak oldini olish)
 */
function cleanupExpiredUserRateLimits() {
    const now = Date.now();
    for (const [userId, limit] of userRateLimit.entries()) {
        if (now > limit.dailyResetTime && now > limit.hourlyResetTime) {
            userRateLimit.delete(userId);
        }
    }
    if (userRateLimit.size > 10000) {
        const firstKey = userRateLimit.keys().next().value;
        if (firstKey !== undefined) {
            userRateLimit.delete(firstKey);
        }
    }
}

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
function checkUserLimit(userId, isPremium = false, isAdmin = false, autoIncrement = true) {
    if (isAdmin && USER_LIMITS.ADMIN_UNLIMITED) {
        return { allowed: true };
    }

    cleanupExpiredUserRateLimits();

    const now = Date.now();
    const userLimit = userRateLimit.get(userId);

    const dailyMax = isPremium ? USER_LIMITS.PREMIUM_USER_DAILY : USER_LIMITS.FREE_USER_DAILY;
    const hourlyMax = USER_LIMITS.FREE_USER_HOURLY;

    if (!userLimit) {
        // Birinchi marta foydalanayotgan user
        const newLimit = {
            dailyCount: autoIncrement ? 1 : 0,
            hourlyCount: autoIncrement ? 1 : 0,
            dailyResetTime: now + 24 * 60 * 60 * 1000, // 24 soat
            hourlyResetTime: now + 60 * 60 * 1000      // 1 soat
        };
        userRateLimit.set(userId, newLimit);
        return { allowed: true, remaining: dailyMax - newLimit.dailyCount };
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

    if (autoIncrement) {
        // Increment counters
        userLimit.dailyCount++;
        userLimit.hourlyCount++;
    }

    return { allowed: true, remaining: Math.max(0, dailyMax - userLimit.dailyCount) };
}

function isRedisAvailable() {
    if (!redisConnection) return false;
    if (typeof redisConnection.status === 'string') {
        return ['ready', 'connect'].includes(redisConnection.status);
    }
    return true;
}

/**
 * User-level va global rate limitni Redis orqali tekshirish (fallback: in-memory)
 */
async function checkUserLimitRedis(userId, isPremium = false, isAdmin = false) {
    if (isAdmin && USER_LIMITS.ADMIN_UNLIMITED) {
        return { allowed: true };
    }

    const dailyMax = isPremium ? USER_LIMITS.PREMIUM_USER_DAILY : USER_LIMITS.FREE_USER_DAILY;
    const hourlyMax = USER_LIMITS.FREE_USER_HOURLY;

    if (isRedisAvailable()) {
        try {
            const dailyKey = `ai:limit:user:${userId}:daily`;
            const hourlyKey = `ai:limit:user:${userId}:hourly`;

            const pipeline = redisConnection.pipeline();
            pipeline.get(dailyKey);
            pipeline.ttl(dailyKey);
            pipeline.get(hourlyKey);
            pipeline.ttl(hourlyKey);
            const results = await pipeline.exec();

            if (results) {
                const dailyCount = parseInt(results[0]?.[1] || '0', 10);
                const dailyTtl = parseInt(results[1]?.[1] || '-1', 10);
                const hourlyCount = parseInt(results[2]?.[1] || '0', 10);
                const hourlyTtl = parseInt(results[3]?.[1] || '-1', 10);

                if (hourlyCount >= hourlyMax) {
                    const minutesLeft = hourlyTtl > 0 ? Math.ceil(hourlyTtl / 60) : 60;
                    return { allowed: false, reason: 'hourly_limit', minutesLeft };
                }

                if (dailyCount >= dailyMax) {
                    const hoursLeft = dailyTtl > 0 ? Math.ceil(dailyTtl / 3600) : 24;
                    return { allowed: false, reason: 'daily_user_limit', hoursLeft };
                }

                return { allowed: true, remaining: Math.max(0, dailyMax - dailyCount) };
            }
        } catch (err) {
            console.error('❌ Redis checkUserLimit error, falling back to in-memory:', err.message);
        }
    }

    // Graceful in-memory fallback (autoIncrement=false, chunki tekshiruv va usage alohida)
    return checkUserLimit(userId, isPremium, isAdmin, false);
}

/**
 * Global usageni increment qilish
 */
function incrementGlobalUsage() {
    dailyUsage.count++;
    monthlyUsage.count++;
}

/**
 * User va global usage ni Redis orqali oshirish (fallback: in-memory)
 */
async function incrementUsageRedis(userId) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const dailyKey = `ai:limit:user:${userId}:daily`;
    const hourlyKey = `ai:limit:user:${userId}:hourly`;
    const globalDailyKey = `ai:usage:daily:${dateStr}`;

    if (isRedisAvailable()) {
        try {
            const pipeline = redisConnection.pipeline();
            pipeline.incr(dailyKey);
            pipeline.incr(hourlyKey);
            pipeline.incr(globalDailyKey);
            const results = await pipeline.exec();

            const expirePipeline = redisConnection.pipeline();
            if (results && results[0] && results[0][1] === 1) {
                expirePipeline.expire(dailyKey, 86400);
            }
            if (results && results[1] && results[1][1] === 1) {
                expirePipeline.expire(hourlyKey, 3600);
            }
            if (results && results[2] && results[2][1] === 1) {
                expirePipeline.expire(globalDailyKey, 86400);
            }
            if (expirePipeline.length > 0) {
                await expirePipeline.exec();
            }
            return;
        } catch (err) {
            console.error('❌ Redis incrementUsage error, falling back to in-memory:', err.message);
        }
    }

    // Graceful in-memory fallback
    incrementGlobalUsage();
    if (userId) {
        cleanupExpiredUserRateLimits();
        const now = Date.now();
        let userLimit = userRateLimit.get(userId);
        if (!userLimit) {
            userLimit = {
                dailyCount: 0,
                hourlyCount: 0,
                dailyResetTime: now + 24 * 60 * 60 * 1000,
                hourlyResetTime: now + 60 * 60 * 1000
            };
            userRateLimit.set(userId, userLimit);
        }
        userLimit.dailyCount++;
        userLimit.hourlyCount++;
    }
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
        const isPremium = false; // Bu yerda premium statusni tekshiring
        const limitCheck = await checkUserLimitRedis(userId, isPremium, false);
        const dailyMax = isPremium ? USER_LIMITS.PREMIUM_USER_DAILY : USER_LIMITS.FREE_USER_DAILY;
        const remaining = limitCheck.remaining !== undefined ? limitCheck.remaining : dailyMax;

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
    const limitCheck = await checkUserLimitRedis(userId, false, false);
    const dailyMax = USER_LIMITS.FREE_USER_DAILY;
    const remaining = limitCheck.remaining !== undefined ? limitCheck.remaining : dailyMax;

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
    const ADMIN_IDS = (ADMIN_ID !== undefined && ADMIN_ID !== null) ? [parseInt(ADMIN_ID, 10)] : [];
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
    const userCheck = await checkUserLimitRedis(userId, isPremium, isAdmin);
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

        // ✅ Muvaffaqiyatli so'rov — usage ni oshiramiz
        await incrementUsageRedis(userId);

        const remaining = userCheck.remaining !== undefined ? Math.max(0, userCheck.remaining - 1) : '∞';
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
    cleanupExpiredUserRateLimits();
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
    checkGlobalLimit,
    checkUserLimit,
    checkUserLimitRedis,
    incrementGlobalUsage,
    incrementUsageRedis
};