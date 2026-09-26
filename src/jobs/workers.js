'use strict';

const { Worker } = require('bullmq');
const redisConnection = require('../services/redisService');
const { escapeHtml } = require('../core/utils');
const logger = require('../core/logger');
const dbService = require('../services/dbService');

function initWorkers(bot, scheduleService) {
  if (!process.env.REDIS_URL || redisConnection.isDummy) {
    logger.info('REDIS_URL not configured. Background BullMQ queue workers will not run in standalone mode.');
    return { broadcastWorker: null, quizTimerWorker: null };
  }

  const broadcastWorker = new Worker('broadcastQueue', async (job) => {
    if (job.name === 'schedule-change-alert') {
      const { userId, message } = job.data;
      try {
        await bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });
      } catch (err) {
        const isBlocked = err?.message?.includes('blocked') ||
          err?.message?.includes('deactivated') ||
          err?.message?.includes('chat not found') ||
          err?.response?.error_code === 403;

        if (isBlocked) {
          logger.info('User blocked bot or deactivated during alert, marking blocked', { userId });
          dbService.markUserBlocked(userId, true).catch(() => {});
          return; // Terminal state, complete job without retrying
        } else if (err?.parameters?.retry_after && err.parameters.retry_after <= 10) {
          const retrySec = err.parameters.retry_after;
          logger.warn(`Alert rate limit hit. Waiting ${retrySec}s`, { userId });
          await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
          await bot.telegram.sendMessage(userId, message, { parse_mode: 'HTML' });
        } else {
          logger.error('Alert sending failed, flagging job for BullMQ retry', { userId, error: err.message });
          throw err; // Allow BullMQ attempts and backoff to retry
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
        const isBlocked = err?.message?.includes('blocked') ||
          err?.message?.includes('deactivated') ||
          err?.message?.includes('chat not found') ||
          err?.response?.error_code === 403;

        if (isBlocked) {
          logger.info('Broadcast user blocked bot or deactivated, marking blocked', { userId });
          dbService.markUserBlocked(userId, true).catch(() => {});
          return; // Terminal state, do not retry
        } else if (err?.parameters?.retry_after && err.parameters.retry_after <= 10) {
          const retrySec = err.parameters.retry_after;
          logger.warn(`Broadcast rate limit hit. Waiting ${retrySec}s`, { userId });
          await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
          await bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
        } else {
          logger.error('Broadcast message sending failed, flagging for BullMQ retry', { userId, error: err.message });
          throw err; // Trigger BullMQ retry
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

  quizTimerWorker.on('error', err => {
    logger.error('Quiz timer worker Redis error', { error: err?.message });
  });

  logger.info('👷 BullMQ workers initialized successfully');
  return { broadcastWorker, quizTimerWorker };
}

module.exports = initWorkers;