'use strict';
const { Queue } = require('bullmq');
const redisConnection = require('../services/redisService');

let broadcastQueue;
let quizTimerQueue;

if (!process.env.REDIS_URL || redisConnection.isDummy) {
  const dummyQueue = {
    isDummy: true,
    add: async () => ({ id: 'dummy' }),
    addBulk: async () => [],
    getJob: async () => null,
    pause: async () => {},
    resume: async () => {},
    close: async () => {},
  };
  broadcastQueue = dummyQueue;
  quizTimerQueue = dummyQueue;
} else {
  const defaultJobOptions = {
    removeOnComplete: { count: 100, age: 3600 }, // Keep last 100 or 1 hour
    removeOnFail: { count: 200, age: 86400 },     // Keep last 200 or 24 hours
  };
  broadcastQueue = new Queue('broadcastQueue', {
    connection: redisConnection.createWorkerConnection(),
    defaultJobOptions,
  });
  quizTimerQueue = new Queue('quizTimerQueue', {
    connection: redisConnection.createWorkerConnection(),
    defaultJobOptions,
  });
}

module.exports = { broadcastQueue, quizTimerQueue };