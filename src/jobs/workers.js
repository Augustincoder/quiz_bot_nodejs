'use strict';

const { Worker } = require('bullmq');
const redisConnection = require('../services/redisService');
const { escapeHtml, truncateText } = require('../core/utils');
const logger = require('../core/logger');
const dbService = require('../services/dbService');

// Idempotency tracking to prevent duplicate message sends when BullMQ retries failed jobs (Bug 52)
async function isUserSentInJob(jobId, userId) {
  if (!jobId || !userId) return false;
  try {
    const key = `bullmq:job_sent:${jobId}`;
    if (typeof redisConnection.sismember === 'function') {
      return (await redisConnection.sismember(key, String(userId))) === 1;
    }
    const mem = await redisConnection.smembers(key);
    return Array.isArray(mem) && mem.includes(String(userId));
  } catch (err) {
    logger.warn('Failed to check job sent status in Redis', { jobId, userId, error: err.message });
    return false;
  }
}

async function markUserSentInJob(jobId, userId) {
  if (!jobId || !userId) return;
  try {
    const key = `bullmq:job_sent:${jobId}`;
    await redisConnection.sadd(key, String(userId));
    await redisConnection.expire(key, 86400); // 24-hour TTL for idempotency record
  } catch (err) {
    logger.warn('Failed to mark user sent in Redis', { jobId, userId, error: err.message });
  }
}

function initWorkers(bot, scheduleService) {
  if (!process.env.REDIS_URL || redisConnection.isDummy) {
    logger.info('REDIS_URL not configured. Background BullMQ queue workers will not run in standalone mode.');
    return { broadcastWorker: null, quizTimerWorker: null };
  }

  const broadcastWorker = new Worker('broadcastQueue', async (job) => {
    if (job.name === 'schedule-change-alert') {
      const { userId, message, users, recipients } = job.data;
      const targetUsers = Array.isArray(users)
        ? users
        : Array.isArray(recipients)
          ? recipients
          : userId ? [userId] : [];

      for (const target of targetUsers) {
        const uid = typeof target === 'object' ? (target.id || target.telegram_id || target.userId) : target;
        if (!uid) continue;

        if (job.id && await isUserSentInJob(job.id, uid)) {
          logger.info('User already received alert in previous attempt of this job, skipping duplicate send', { jobId: job.id, userId: uid });
          continue;
        }

        try {
          await bot.telegram.sendMessage(uid, message, { parse_mode: 'HTML' });
          if (job.id) await markUserSentInJob(job.id, uid);
        } catch (err) {
          const isBlocked = err?.message?.includes('blocked') ||
            err?.message?.includes('deactivated') ||
            err?.message?.includes('chat not found') ||
            err?.response?.error_code === 403;

          if (isBlocked) {
            logger.info('User blocked bot or deactivated during alert, marking blocked', { userId: uid });
            dbService.markUserBlocked(uid, true).catch(() => {});
            if (job.id) await markUserSentInJob(job.id, uid);
            continue; // Terminal state, continue to next user without failing whole batch
          }
          const retrySec = err?.response?.parameters?.retry_after || err?.parameters?.retry_after;
          if (retrySec && retrySec <= 30) {
            logger.warn(`Alert rate limit hit. Waiting ${retrySec}s`, { userId: uid });
            await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
            try {
              await bot.telegram.sendMessage(uid, message, { parse_mode: 'HTML' });
              if (job.id) await markUserSentInJob(job.id, uid);
            } catch (retryErr) {
              const retryBlocked = retryErr?.message?.includes('blocked') ||
                retryErr?.message?.includes('deactivated') ||
                retryErr?.message?.includes('chat not found') ||
                retryErr?.response?.error_code === 403;
              if (retryBlocked) {
                logger.info('User blocked bot during rate limit retry, marking blocked', { userId: uid });
                dbService.markUserBlocked(uid, true).catch(() => {});
                if (job.id) await markUserSentInJob(job.id, uid);
              } else {
                logger.error('Alert retry failed after backoff, re-throwing for BullMQ', { userId: uid, error: retryErr.message });
                throw retryErr;
              }
            }
          } else {
            logger.error('Alert sending failed, flagging job for BullMQ retry', { userId: uid, error: err.message });
            throw err; // Allow BullMQ attempts and backoff to retry remaining users
          }
        }
      }
      return;
    }

    if (job.name === 'batch-broadcast' || Array.isArray(job.data.users) || Array.isArray(job.data.recipients)) {
      const { message, users, recipients } = job.data;
      const targetUsers = Array.isArray(users) ? users : Array.isArray(recipients) ? recipients : [];
      for (const target of targetUsers) {
        const uid = typeof target === 'object' ? (target.id || target.telegram_id || target.userId) : target;
        if (!uid) continue;

        if (job.id && await isUserSentInJob(job.id, uid)) {
          logger.info('User already received batch broadcast in previous attempt, skipping duplicate', { jobId: job.id, userId: uid });
          continue;
        }

        try {
          await bot.telegram.sendMessage(uid, message, { parse_mode: 'HTML' });
          if (job.id) await markUserSentInJob(job.id, uid);
        } catch (err) {
          const isBlocked = err?.message?.includes('blocked') ||
            err?.message?.includes('deactivated') ||
            err?.message?.includes('chat not found') ||
            err?.response?.error_code === 403;

          if (isBlocked) {
            logger.info('User blocked bot during batch broadcast, marking blocked', { userId: uid });
            dbService.markUserBlocked(uid, true).catch(() => {});
            if (job.id) await markUserSentInJob(job.id, uid);
            continue;
          }
          const retrySec = err?.response?.parameters?.retry_after || err?.parameters?.retry_after;
          if (retrySec && retrySec <= 30) {
            logger.warn(`Batch broadcast rate limit hit. Waiting ${retrySec}s`, { userId: uid });
            await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
            try {
              await bot.telegram.sendMessage(uid, message, { parse_mode: 'HTML' });
              if (job.id) await markUserSentInJob(job.id, uid);
            } catch (retryErr) {
              const retryBlocked = retryErr?.message?.includes('blocked') ||
                retryErr?.message?.includes('deactivated') ||
                retryErr?.message?.includes('chat not found') ||
                retryErr?.response?.error_code === 403;
              if (retryBlocked) {
                logger.info('User blocked bot during batch broadcast retry, marking blocked', { userId: uid });
                dbService.markUserBlocked(uid, true).catch(() => {});
                if (job.id) await markUserSentInJob(job.id, uid);
              } else {
                logger.error('Batch broadcast retry failed after backoff, re-throwing for BullMQ', { userId: uid, error: retryErr.message });
                throw retryErr;
              }
            }
          } else {
            logger.error('Batch broadcast failed for user, throwing for BullMQ retry', { userId: uid, error: err.message });
            throw err;
          }
        }
      }
      return;
    }

    const { userId, className, dayOfWeek, isTomorrow } = job.data;
    if (!userId || !className) {
      logger.warn('Broadcast job skipped: missing userId or className', { data: job.data });
      return;
    }

    if (job.id && await isUserSentInJob(job.id, userId)) {
      logger.info('User already received broadcast in previous attempt of this job, skipping duplicate send', { jobId: job.id, userId });
      return;
    }

    // 1. Sunday is a universal day off — never broadcast
    if (dayOfWeek === 6) {
      logger.debug('Broadcast schedule skipped: Sunday is a day off', { className, userId });
      return;
    }

    const scheduleText = await scheduleService.fetchTodaySchedule(className, dayOfWeek);

    // 2. If an error occurred while generating schedule, throw so BullMQ can retry
    if (scheduleText && (scheduleText.includes('xatolik') || scheduleText.startsWith('❌'))) {
      logger.warn('Schedule fetch error during broadcast, throwing for BullMQ retry', { className, userId });
      throw new Error(`Schedule fetch error for group ${className}: ${scheduleText}`);
    }

    // 3. If there are NO lessons scheduled for this group on this day, DO NOT send empty "dars yo'q" notification!
    const hasNoLessons = !scheduleText ||
      scheduleText.includes('Jadval topilmadi') ||
      scheduleText.includes('kiritilmagan') ||
      scheduleText.includes("darslar yo'q") ||
      scheduleText.includes("dars yo'q") ||
      scheduleText.includes("dam olish kuni") ||
      !scheduleText.includes('-para');

    if (hasNoLessons) {
      logger.debug('Broadcast schedule skipped: no lessons for group on this day', {
        className,
        dayOfWeek,
        isTomorrow,
        userId,
      });
      return;
    }
      const greeting = isTomorrow ? '🌙 <b>Xayrli tun!</b> Ertangi dars jadvalingiz:' : '🌤 <b>Xayrli tong!</b> Bugungi dars jadvalingiz:';
      let msg = `${greeting}\n\n🎓 <b>Guruh: ${escapeHtml(className)}</b>\n\n${scheduleText}`;
      if (msg.length > 4000) {
        msg = truncateText(msg, 3950);
      }

      try {
        await bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
        if (job.id) await markUserSentInJob(job.id, userId);
      } catch (err) {
        const isBlocked = err?.message?.includes('blocked') ||
          err?.message?.includes('deactivated') ||
          err?.message?.includes('chat not found') ||
          err?.response?.error_code === 403;

        if (isBlocked) {
          logger.info('Broadcast user blocked bot or deactivated, marking blocked', { userId });
          dbService.markUserBlocked(userId, true).catch(() => {});
          if (job.id) await markUserSentInJob(job.id, userId);
          return; // Terminal state, do not retry
        }
        const retrySec = err?.response?.parameters?.retry_after || err?.parameters?.retry_after;
        if (retrySec && retrySec <= 30) {
          logger.warn(`Broadcast rate limit hit. Waiting ${retrySec}s`, { userId });
          await new Promise(r => setTimeout(r, (retrySec + 1) * 1000));
          await bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' });
          if (job.id) await markUserSentInJob(job.id, userId);
        } else {
          logger.error('Broadcast message sending failed, flagging for BullMQ retry', { userId, error: err.message });
          throw err; // Trigger BullMQ retry
        }
      }
  }, {
    connection: redisConnection.createWorkerConnection(),
    concurrency: 10,
    limiter: { max: 25, duration: 1000 },
    lockDuration: 60000,
    maxStalledCount: 2,
  });

  const quizGame = require('../handlers/quizGame');
  const quizTimerWorker = new Worker('quizTimerQueue', async (job) => {
    const { chatId, expectedIdx, pollId } = job.data;
    await quizGame.questionTimeout(chatId, expectedIdx, pollId, bot.telegram);
  }, {
    connection: redisConnection.createWorkerConnection(),
    concurrency: 5,
    lockDuration: 60000,
    maxStalledCount: 2,
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

initWorkers.isUserSentInJob = isUserSentInJob;
initWorkers.markUserSentInJob = markUserSentInJob;

module.exports = initWorkers;