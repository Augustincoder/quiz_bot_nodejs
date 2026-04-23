'use strict';
const { Worker } = require('bullmq');
const redisConnection = require('../services/redisService');

function initWorkers(bot, scheduleService) {
    const broadcastWorker = new Worker('broadcastQueue', async (job) => {
        const { userId, className, dayOfWeek, isTomorrow } = job.data;
        console.log(`\n▶️ [Worker BOSHILANDI] Vazifa ID: ${job.id} | Foydalanuvchi: ${userId} | Guruh: ${className}`);
        
        const scheduleText = await scheduleService.fetchTodaySchedule(className, dayOfWeek);
        console.log(`🔍 [Worker QIDIRUV] Jadval matni olindi, uzunligi: ${scheduleText?.length || 0} belgi.`);
        
        if (!scheduleText.includes('Jadval topilmadi') && !scheduleText.includes('xatolik')) {
            const greeting = isTomorrow ? '🌙 Xayrli tun! Ertangi darsingiz:' : '🌤 Xayrli tong! Bugungi darsingiz:';
            await bot.telegram.sendMessage(
                userId, 
                `<b>${greeting}</b>\n\n🎓 <b>Guruh: ${className}</b>\n${scheduleText}`, 
                { parse_mode: 'HTML' }
            );
            console.log(`✅ [Worker TUGADI] Xabar Telegramga jo'natildi!`);
        } else {
            console.log(`⚠️ [Worker TUGADI] Jadval bo'sh bo'lgani uchun yuborilmadi.`);
        }
    }, { 
        connection: redisConnection.createWorkerConnection(), 
        limiter: { max: 20, duration: 1000 } 
    });

    const quizTimerWorker = new Worker('quizTimerQueue', async (job) => {
        const { chatId, expectedIdx, pollId } = job.data;
        const quizGame = require('../handlers/quizGame'); 
        await quizGame.questionTimeout(chatId, expectedIdx, pollId, bot.telegram);
    }, { 
        connection: redisConnection.createWorkerConnection() 
    });

    // 🔴 AYG'OQCHILAR (Xatolarni ushlovchilar) - SHU QISMNI QO'SHING
    broadcastWorker.on('completed', job => console.log(`🟢 [BULLMQ] Job ${job.id} muvaffaqiyatli yakunlandi.`));
    broadcastWorker.on('failed', (job, err) => console.error(`🔴 [BULLMQ] Job ${job.id} XATO QILDI:`, err));
    broadcastWorker.on('error', err => console.error(`🔥 [BULLMQ] WORKERNI O'ZIDA XATO (Redis ulanish uzildi va h.k):`, err));
    broadcastWorker.on('active', job => console.log(`🟡 [BULLMQ] Job ${job.id} ishga tushdi!`));

    console.log('👷 BullMQ Ishchilari (Workers) tayyor!');
    return { broadcastWorker, quizTimerWorker };
}

module.exports = initWorkers;