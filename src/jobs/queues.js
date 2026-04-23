'use strict';
const { Queue } = require('bullmq');
const redisConnection = require('../services/redisService');

// ALOHIDA ulanishlardan foydalanamiz
const broadcastQueue = new Queue('broadcastQueue', { 
    connection: redisConnection.createWorkerConnection() 
});

const quizTimerQueue = new Queue('quizTimerQueue', { 
    connection: redisConnection.createWorkerConnection() 
});

module.exports = { broadcastQueue, quizTimerQueue };