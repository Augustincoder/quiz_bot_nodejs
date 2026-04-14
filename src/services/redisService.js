'use strict';
require('dotenv').config(); // Eng birinchi .env ni o'qiymiz
const Redis = require('ioredis');

// Agar REDIS_URL topilmasa, bot kompyuterdan qidirib qotib qolmasligi uchun darhol to'xtatamiz
if (!process.env.REDIS_URL) {
    console.error("🛑 DIQQAT: .env faylida REDIS_URL topilmadi! Iltimos uni qo'shing.");
    process.exit(1); 
}

const redisConnection = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: null, // BullMQ uchun majburiy
    family: 0 // IPv4 va IPv6 muammosini oldini olish uchun
});

redisConnection.on('error', (err) => console.error('❌ Redis Xatosi:', err.message));
redisConnection.on('connect', () => console.log('✅ Redis (Upstash) muvaffaqiyatli ulandi!'));

module.exports = redisConnection;

