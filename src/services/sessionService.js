'use strict';
const redis = require('./redisService');
const logger = require('../core/logger');
const { TTLMap } = require('../core/utils');

// 1 kun (86400 soniya) saqlanadi Redis ichida
const TTL = 86400; 
// Poll vaqtinchalik xaritasi uchun 1 soatlik TTL (xotira to'lishini oldini olish)
const POLL_TTL = 3600; 
// Lokal xotira keshida testlar 1 soat (3600 soniya) saqlanadi (tashlab ketilgan testlar RAMni to'ldirmasligi uchun)
const LOCAL_TEST_TTL = 3600;

// Bounded in-memory caches to prevent split-brain during transient Redis disconnects with zero memory leak
const localActiveTestCache = new TTLMap(LOCAL_TEST_TTL * 1000, 500);
const localPollMapCache = new TTLMap(POLL_TTL * 1000, 2000);
const localWaitingRoomCache = new TTLMap(300 * 1000, 500);

// ─── Active Tests ────────────────────────────────────────────
async function getActiveTest(chatId) {
  const cid = String(chatId);
  try {
    const data = await redis.get(`activeTest:${cid}`);
    if (data) {
      const parsed = JSON.parse(data);
      localActiveTestCache.set(cid, { data: parsed, expiresAt: Date.now() + TTL * 1000 });
      return parsed;
    }
  } catch (err) {
    logger.error('sessionService.getActiveTest failed, falling back to local memory', { chatId: cid, error: err.message });
  }
  const fallback = localActiveTestCache.get(cid);
  if (fallback && fallback.expiresAt > Date.now()) {
    return fallback.data;
  }
  return null;
}

async function setActiveTest(chatId, data) {
  const cid = String(chatId);
  if (!data || typeof data !== 'object') return;
  const safeData = { ...data };
  if (safeData.timer) delete safeData.timer;
  localActiveTestCache.set(cid, { data: safeData, expiresAt: Date.now() + TTL * 1000 });

  try {
    await redis.set(`activeTest:${cid}`, JSON.stringify(safeData), 'EX', TTL);
  } catch (err) {
    logger.error('sessionService.setActiveTest failed, preserved in local fallback', { chatId: cid, error: err.message });
  }
}

async function deleteActiveTest(chatId) {
  const cid = String(chatId);
  localActiveTestCache.delete(cid);
  try {
    await redis.del(`activeTest:${cid}`);
  } catch (err) {
    logger.error('sessionService.deleteActiveTest failed', { chatId: cid, error: err.message });
  }
}

// ─── Poll ↔ ChatId Mapping ──────────────────────────────────
async function getPollChat(pollId) {
  const pid = String(pollId);
  try {
    const chat = await redis.get(`pollMap:${pid}`);
    if (chat) {
      localPollMapCache.set(pid, { chatId: chat, expiresAt: Date.now() + POLL_TTL * 1000 });
      return chat;
    }
  } catch (err) {
    logger.error('sessionService.getPollChat failed, checking local backup', { pollId: pid, error: err.message });
  }
  const fallback = localPollMapCache.get(pid);
  if (fallback && fallback.expiresAt > Date.now()) {
    return fallback.chatId;
  }
  return null;
}

async function setPollChat(pollId, chatId) {
  const pid = String(pollId);
  const cid = String(chatId);
  localPollMapCache.set(pid, { chatId: cid, expiresAt: Date.now() + POLL_TTL * 1000 });
  try {
    await redis.set(`pollMap:${pid}`, cid, 'EX', POLL_TTL);
  } catch (err) {
    logger.error('sessionService.setPollChat failed, preserved in local fallback', { pollId: pid, error: err.message });
  }
}

async function deletePollChat(pollId) {
  const pid = String(pollId);
  localPollMapCache.delete(pid);
  try {
    await redis.del(`pollMap:${pid}`);
  } catch (err) {
    logger.error('sessionService.deletePollChat failed', { pollId: pid, error: err.message });
  }
}

// ─── Waiting Rooms ──────────────────────────────────────────
async function getWaitingRoom(chatId) {
  const cid = String(chatId);
  try {
    const data = await redis.get(`waitingRoom:${cid}`);
    if (data) {
      const room = JSON.parse(data);
      if (Array.isArray(room.readyUsers)) {
        const obj = {};
        room.readyUsers.forEach(id => obj[id] = 'Foydalanuvchi');
        room.readyUsers = obj;
      }
      localWaitingRoomCache.set(cid, { data: room, expiresAt: Date.now() + 300 * 1000 });
      return room;
    }
  } catch (err) {
    logger.error('sessionService.getWaitingRoom failed, checking local fallback', { chatId: cid, error: err.message });
  }
  const fallback = localWaitingRoomCache.get(cid);
  if (fallback && fallback.expiresAt > Date.now()) {
    return fallback.data;
  }
  return null;
}

async function setWaitingRoom(chatId, data) {
  const cid = String(chatId);
  localWaitingRoomCache.set(cid, { data, expiresAt: Date.now() + 300 * 1000 });
  try {
    await redis.set(`waitingRoom:${cid}`, JSON.stringify(data), 'EX', 300);
  } catch (err) {
    logger.error('sessionService.setWaitingRoom failed, preserved in local fallback', { chatId: cid, error: err.message });
  }
}

async function deleteWaitingRoom(chatId) {
  const cid = String(chatId);
  localWaitingRoomCache.delete(cid);
  try {
    await redis.del(`waitingRoom:${cid}`);
  } catch (err) {
    logger.error('sessionService.deleteWaitingRoom failed', { chatId: cid, error: err.message });
  }
}

function cleanupExpired(now = Date.now()) {
  if (typeof localActiveTestCache.cleanup === 'function') {
    localActiveTestCache.cleanup(now);
  }
  if (typeof localPollMapCache.cleanup === 'function') {
    localPollMapCache.cleanup(now);
  }
  if (typeof localWaitingRoomCache.cleanup === 'function') {
    localWaitingRoomCache.cleanup(now);
  }
}

module.exports = {
  getActiveTest, setActiveTest, deleteActiveTest,
  getPollChat, setPollChat, deletePollChat,
  getWaitingRoom, setWaitingRoom, deleteWaitingRoom,
  cleanupExpired,
  _localActiveTestCache: localActiveTestCache,
  _localPollMapCache: localPollMapCache,
  _localWaitingRoomCache: localWaitingRoomCache,
};