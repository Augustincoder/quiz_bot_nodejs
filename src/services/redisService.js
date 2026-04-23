'use strict';
require('dotenv').config();
const Redis = require('ioredis');

if (!process.env.REDIS_URL) {
    console.error("🛑 DIQQAT: .env faylida REDIS_URL topilmadi! Iltimos uni qo'shing.");
    process.exit(1); 
}

// Ssilka SSL talab qiladimi-yo'qmi tekshiramiz (rediss:// vs redis://)
const isSecureRedis = process.env.REDIS_URL.startsWith('rediss://');

// Barcha ulanishlar uchun umumiy sozlamalar
const redisOptions = {
    maxRetriesPerRequest: null,
    family: 0 // IPv4 ni afzal ko'rish
};

// Agar ssilka xavfsiz bo'lsa (Upstash/Render kabi), TLS ni qo'shamiz
if (isSecureRedis) {
    redisOptions.tls = { rejectUnauthorized: false };
}

// 1. Asosiy ulanish
const redisConnection = new Redis(process.env.REDIS_URL, redisOptions);

redisConnection.on('error', (err) => console.error('❌ Redis Xatosi:', err.message));
redisConnection.on('connect', () => {
    console.log(`✅ Redis muvaffaqiyatli ulandi! (SSL: ${isSecureRedis ? 'Yoniq' : "O'chiq"})`);
});

// 2. BullMQ navbatlari uchun ALOHIDA ulanish
redisConnection.createWorkerConnection = () => {
    return new Redis(process.env.REDIS_URL, redisOptions);
};

module.exports = redisConnection;