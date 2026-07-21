'use strict';
const redis = require('./redisService');
const logger = require('../core/logger');

// 1 kun (86400 soniya) saqlanadi
const TTL = 86400; 

// ─── Compact / Expand Session Helper (T1 Memory Optimization) ───
function compactSessionData(data) {
  if (!data || !Array.isArray(data.sessionQuestions)) return data;
  const compact = { ...data };
  compact.sessionQuestions = data.sessionQuestions.map(item => ({
    q: item.question,
    o: item.options,
    ci: item.correct_index,
    ct: item.correct_text,
  }));
  return compact;
}

function expandSessionData(data) {
  if (!data || !Array.isArray(data.sessionQuestions)) return data;
  data.sessionQuestions = data.sessionQuestions.map(item => ({
    question: item.question || item.q,
    options: item.options || item.o,
    correct_index: item.correct_index ?? item.ci,
    correct_text: item.correct_text || item.ct,
  }));
  return data;
}

// ─── Active Tests ────────────────────────────────────────────
async function getActiveTest(chatId) {
  try {
    const raw = await redis.get(`activeTest:${chatId}`);
    return raw ? expandSessionData(JSON.parse(raw)) : null;
  } catch (err) {
    logger.error('sessionService.getActiveTest failed', { chatId, error: err.message });
    return null;
  }
}

async function setActiveTest(chatId, data) {
  try {
    const compacted = compactSessionData(data);
    await redis.set(`activeTest:${chatId}`, JSON.stringify(compacted), 'EX', TTL);
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
    await redis.set(`pollMap:${pollId}`, chatId, 'EX', TTL);
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

// ─── High-Load Atomic Pipeline Operations ───────────────────
async function setActiveTestAndPoll(chatId, sessionData, pollId) {
  try {
    const compacted = compactSessionData(sessionData);
    const pipeline = redis.pipeline();
    pipeline.set(`activeTest:${chatId}`, JSON.stringify(compacted), 'EX', TTL);
    if (pollId) {
      pipeline.set(`pollMap:${pollId}`, String(chatId), 'EX', TTL);
    }
    await pipeline.exec();
  } catch (err) {
    logger.error('sessionService.setActiveTestAndPoll failed', { chatId, pollId, error: err.message });
  }
}

async function deleteActiveTestAndPoll(chatId, pollId) {
  try {
    const pipeline = redis.pipeline();
    pipeline.del(`activeTest:${chatId}`);
    if (pollId) {
      pipeline.del(`pollMap:${pollId}`);
    }
    await pipeline.exec();
  } catch (err) {
    logger.error('sessionService.deleteActiveTestAndPoll failed', { chatId, pollId, error: err.message });
  }
}

module.exports = {
  getActiveTest, setActiveTest, deleteActiveTest,
  getPollChat, setPollChat, deletePollChat,
  getWaitingRoom, setWaitingRoom, deleteWaitingRoom,
  setActiveTestAndPoll, deleteActiveTestAndPoll,
};