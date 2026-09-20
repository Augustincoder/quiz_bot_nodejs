'use strict';
const { Queue } = require('bullmq');
const redisConnection = require('../services/redisService');

let broadcastQueue;
let quizTimerQueue;

if (!process.env.REDIS_URL || redisConnection.isDummy) {
  const dummyQueue = {
    add: async () => ({ id: 'dummy' }),
    addBulk: async () => [],
    pause: async () => {},
    resume: async () => {},
    close: async () => {},
  };
  broadcastQueue = dummyQueue;
  quizTimerQueue = dummyQueue;
} else {
  broadcastQueue = new Queue('broadcastQueue', {
    connection: redisConnection.createWorkerConnection(),
  });
  quizTimerQueue = new Queue('quizTimerQueue', {
    connection: redisConnection.createWorkerConnection(),
  });
}

module.exports = { broadcastQueue, quizTimerQueue };