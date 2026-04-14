'use strict';
const { Worker } = require('bullmq');
const redisConnection = require('../services/redisService');

function initWorkers(bot, scheduleService) {
    // 1. Ertalabki jadvallar tarqatish ishchisi (Buni oldingi xabarda yozgandik)
    const broadcastWorker = new Worker('broadcastQueue', async (job) => {
        const { userId, className, dayOfWeek } = job.data;
        try {
            const scheduleText = await scheduleService.fetchTodaySchedule(className, dayOfWeek);
            if (!scheduleText.includes('Jadval topilmadi') && !scheduleText.includes('xatolik')) {
                await bot.telegram.sendMessage(userId, `🌤 <b>Xayrli tong! Bugungi darsingiz:</b>\n\n🎓 <b>Guruh: ${className}</b>\n${scheduleText}`, { parse_mode: 'HTML' });
            }
        } catch (err) {
            if (err.message.includes('429') || err.message.includes('Too Many Requests')) throw err; 
        }
    }, { connection: redisConnection, limiter: { max: 20, duration: 1000 } });

    // 2. YANGI: Test Taymerlari ishchisi
    const quizTimerWorker = new Worker('quizTimerQueue', async (job) => {
        const { chatId, expectedIdx, pollId } = job.data;
        // Circular dependency (aylanma qaramlik) xatosi bermasligi uchun aynan shu yerda chaqiramiz:
        const quizGame = require('../handlers/quizGame'); 
        await quizGame.questionTimeout(chatId, expectedIdx, pollId, bot.telegram);
    }, { connection: redisConnection });

    console.log('👷 BullMQ Ishchilari (Workers) tayyor!');
    return { broadcastWorker, quizTimerWorker };
}

module.exports = initWorkers;