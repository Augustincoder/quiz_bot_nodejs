'use strict';
const redis = require('./redisService');
const logger = require('../core/logger');

// 1 kun (86400 soniya) saqlanadi
const TTL = 86400; 
// Poll vaqtinchalik xaritasi uchun 1 soatlik TTL (xotira to'lishini oldini olish)
const POLL_TTL = 3600; 

// ─── Active Tests ────────────────────────────────────────────
async function getActiveTest(chatId) {
  try {
    const data = await redis.get(`activeTest:${chatId}`);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.error('sessionService.getActiveTest failed', { chatId, error: err.message });
    return null;
  }
}

async function setActiveTest(chatId, data) {
  try {
    if (!data || typeof data !== 'object') return;
    const safeData = { ...data };
    if (safeData.timer) delete safeData.timer;
    await redis.set(`activeTest:${chatId}`, JSON.stringify(safeData), 'EX', TTL);
  } catch (err) {
    logger.error('sessionService.setActiveTest failed', { chatId, error: err.message });
  }
}

async function deleteActiveTest(chatId) {
  try {
    await redis.del(`activeTest:${chatId}`);
  } catch (err) {
    logger.error('sessionService.deleteActiveTest failed', { chatId, error: err.message });
  }
}

// ─── Poll ↔ ChatId Mapping ──────────────────────────────────
async function getPollChat(pollId) {
  try {
    return await redis.get(`pollMap:${pollId}`);
  } catch (err) {
    logger.error('sessionService.getPollChat failed', { pollId, error: err.message });
    return null;
  }
}

async function setPollChat(pollId, chatId) {
  try {
    await redis.set(`pollMap:${pollId}`, chatId, 'EX', POLL_TTL);
  } catch (err) {
    logger.error('sessionService.setPollChat failed', { pollId, error: err.message });
  }
}

async function deletePollChat(pollId) {
  try {
    await redis.del(`pollMap:${pollId}`);
  } catch (err) {
    logger.error('sessionService.deletePollChat failed', { pollId, error: err.message });
  }
}


// ─── Waiting Rooms ──────────────────────────────────────────
async function getWaitingRoom(chatId) {
  try {
    const data = await redis.get(`waitingRoom:${chatId}`);
    if (data) {
      const room = JSON.parse(data);
      // Agar eski kod qolib ketgan bo'lsa (Array bo'lsa), Object ga aylantiramiz
      if (Array.isArray(room.readyUsers)) {
        const obj = {};
        room.readyUsers.forEach(id => obj[id] = 'Foydalanuvchi');
        room.readyUsers = obj;
      }
      // Endi Set kerak emas, chunki ID va Ismlar Object da saqlanmoqda
      return room;
    }
    return null;
  } catch (err) {
    logger.error('sessionService.getWaitingRoom failed', { chatId, error: err.message });
    return null;
  }
}

async function setWaitingRoom(chatId, data) {
  try {
    // Array.from kerak emas, Object o'z holicha saqlanadi
    await redis.set(`waitingRoom:${chatId}`, JSON.stringify(data), 'EX', 300);
  } catch (err) {
    logger.error('sessionService.setWaitingRoom failed', { chatId, error: err.message });
  }
}

async function deleteWaitingRoom(chatId) {
  try {
    await redis.del(`waitingRoom:${chatId}`);
  } catch (err) {
    logger.error('sessionService.deleteWaitingRoom failed', { chatId, error: err.message });
  }
}

module.exports = {
  getActiveTest, setActiveTest, deleteActiveTest,
  getPollChat, setPollChat, deletePollChat,
  getWaitingRoom, setWaitingRoom, deleteWaitingRoom,
};