'use strict';
const redis = require('./redisService');

// 1 kun (86400 soniya) saqlanadi
const TTL = 86400; 

// Active Tests uchun funksiyalar
async function getActiveTest(chatId) {
    const data = await redis.get(`activeTest:${chatId}`);
    return data ? JSON.parse(data) : null;
}

async function setActiveTest(chatId, data) {
    await redis.set(`activeTest:${chatId}`, JSON.stringify(data), 'EX', TTL);
}

async function deleteActiveTest(chatId) {
    await redis.del(`activeTest:${chatId}`);
}

// Poll va ChatId ni bog'lovchi funksiyalar (Poll_Answer uchun kerak)
async function getPollChat(pollId) {
    return await redis.get(`pollMap:${pollId}`);
}

async function setPollChat(pollId, chatId) {
    await redis.set(`pollMap:${pollId}`, chatId, 'EX', TTL);
}

async function deletePollChat(pollId) {
    await redis.del(`pollMap:${pollId}`);
}

// Waiting Rooms (Kutish zallari) uchun
async function getWaitingRoom(chatId) {
    const data = await redis.get(`waitingRoom:${chatId}`);
    // Set obyektini JSON dan qayta tiklaymiz
    if (data) {
        const room = JSON.parse(data);
        room.readyUsers = new Set(room.readyUsers); 
        return room;
    }
    return null;
}

async function setWaitingRoom(chatId, data) {
    // Set obyektini Array qilib saqlaymiz
    const roomToSave = { ...data, readyUsers: Array.from(data.readyUsers) };
    await redis.set(`waitingRoom:${chatId}`, JSON.stringify(roomToSave), 'EX', 300); // Kutish zali 5 minut saqlanadi
}

async function deleteWaitingRoom(chatId) {
    await redis.del(`waitingRoom:${chatId}`);
}

module.exports = {
    getActiveTest, setActiveTest, deleteActiveTest,
    getPollChat, setPollChat, deletePollChat,
    getWaitingRoom, setWaitingRoom, deleteWaitingRoom
};