'use strict';
const { Queue } = require('bullmq');
const redisConnection = require('../services/redisService');

// 1. Ertalabki dars jadvallarini tarqatish navbati
const broadcastQueue = new Queue('broadcastQueue', { connection: redisConnection });

// 2. Test yechishdagi 30 soniyalik taymerlar navbati (buni keyingi qadamda ulaymiz)
const quizTimerQueue = new Queue('quizTimerQueue', { connection: redisConnection });

module.exports = { broadcastQueue, quizTimerQueue };