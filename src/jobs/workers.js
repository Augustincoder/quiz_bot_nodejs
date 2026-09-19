'use strict';

const { Worker } = require('bullmq');
const redisConnection = require('../services/redisService');
const { escapeHtml } = require('../core/utils');
const logger = require('../core/logger');

function initWorkers(bot, scheduleService) {
  const broadcastWorker = new Worker('broadcastQueue', async (job) => {
    if (job.name === 'schedule-change-alert') {
      const { userId, message } = job.data;
      try {
        await bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });
      } catch (err) {
        if (err?.message?.includes('blocked') || err?.message?.includes('deactivated')) {
          logger.info('User blocked bot or deactivated during alert', { userId });
        } else if (err?.parameters?.retry_after) {
          const retrySec = err.parameters.retry_after;
          logger.warn(`Alert rate limit hit. Waiting ${retrySec}s`, { userId });
          await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
          await bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' }).catch(() => {});
        } else {
          logger.error('Alert sending failed', { userId, error: err.message });
        }
      }
      return;
    }

    const { userId, className, dayOfWeek, isTomorrow } = job.data;

    const scheduleText = await scheduleService.fetchTodaySchedule(className, dayOfWeek);

    const isInvalid = !scheduleText ||
      scheduleText.includes('Jadval topilmadi') ||
      scheduleText.includes('xatolik') ||
      scheduleText.includes('topilmadi') ||
      scheduleText.includes('kiritilmagan');

    if (!isInvalid) {
      const greeting = isTomorrow ? '🌙 <b>Xayrli tun!</b> Ertangi dars jadvalingiz:' : '🌤 <b>Xayrli tong!</b> Bugungi dars jadvalingiz:';
      let msg = `${greeting}\n\n🎓 <b>Guruh: ${escapeHtml(className)}</b>\n\n${scheduleText}`;
      if (msg.length > 4000) {
        msg = msg.slice(0, 3950) + '\n\n<i>...(jadval qisqartirildi)</i>';
      }

      try {
        await bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
      } catch (err) {
        if (err?.message?.includes('blocked') || err?.message?.includes('deactivated')) {
          logger.info('Broadcast user blocked bot or deactivated', { userId });
        } else if (err?.parameters?.retry_after) {
          const retrySec = err.parameters.retry_after;
          logger.warn(`Broadcast rate limit hit. Waiting ${retrySec}s`, { userId });
          await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
          await bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' }).catch(() => {});
        } else {
          logger.error('Broadcast message sending failed', { userId, error: err.message });
        }
      }
    }
  }, {
    connection: redisConnection.createWorkerConnection(),
    limiter: { max: 25, duration: 1000 },
  });

  const quizTimerWorker = new Worker('quizTimerQueue', async (job) => {
    const { chatId, expectedIdx, pollId } = job.data;
    const quizGame = require('../handlers/quizGame');
    await quizGame.questionTimeout(chatId, expectedIdx, pollId, bot.telegram);
  }, {
    connection: redisConnection.createWorkerConnection(),
  });

  broadcastWorker.on('completed', job => {
    logger.debug('Broadcast job completed', { jobId: job.id });
  });
  broadcastWorker.on('failed', (job, err) => {
    logger.error('Broadcast job failed', { jobId: job?.id, error: err?.message });
  });
  broadcastWorker.on('error', err => {
    logger.error('Broadcast worker Redis error', { error: err?.message });
  });

  logger.info('👷 BullMQ workers initialized successfully');
  return { broadcastWorker, quizTimerWorker };
}

module.exports = initWorkers;