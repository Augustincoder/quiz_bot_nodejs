'use strict';

const redis = require('../services/redisService');

/**
 * RoomManager - Manages live game states with Redis-backed persistence.
 * Hydrates rooms from Redis on server restarts and syncs changes automatically.
 */
class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  // Serializes room data for Redis storage (excluding functions/timers)
  _serializeRoom(room) {
    return JSON.stringify({
      roomCode: room.roomCode,
      mode: room.mode,
      hostId: room.hostId,
      status: room.status,
      questions: room.questions,
      currentIndex: room.currentIndex,
      players: Array.from(room.players.entries()),
      kahootAnswers: Array.from(room.kahootAnswers.entries()),
      leaderboardAcks: Array.from(room.leaderboardAcks)
    });
  }

  // Hydrates a room object from Redis stored snapshot
  _deserializeRoom(dataStr) {
    if (!dataStr) return null;
    try {
      const parsed = JSON.parse(dataStr);
      return {
        roomCode: parsed.roomCode,
        mode: parsed.mode || 'kahoot',
        hostId: parsed.hostId,
        status: parsed.status || 'lobby',
        questions: parsed.questions || [],
        currentIndex: parsed.currentIndex || 0,
        players: new Map(parsed.players || []),
        readTimer: null,
        actionTimer: null,
        cooldownTimer: null,
        kahootAnswers: new Map(parsed.kahootAnswers || []),
        leaderboardAcks: new Set(parsed.leaderboardAcks || [])
      };
    } catch (e) {
      console.error('RoomManager hydration error:', e.message);
      return null;
    }
  }

  async _saveToRedis(room) {
    if (!room || !room.roomCode) return;
    try {
      const serialized = this._serializeRoom(room);
      await redis.set(`quiz:room:${room.roomCode}`, serialized, 'EX', 86400); // 24 saot TTL
    } catch (e) {
      console.error(`Failed to save room ${room.roomCode} to Redis:`, e.message);
    }
  }

  async createRoom(roomCode, hostId, mode = 'kahoot') {
    const room = {
      roomCode,
      mode,
      hostId,
      status: 'lobby',
      questions: [],
      currentIndex: 0,
      players: new Map(),
      readTimer: null,
      actionTimer: null,
      cooldownTimer: null,
      kahootAnswers: new Map(),
      leaderboardAcks: new Set(),
    };
    
    this.rooms.set(roomCode, room);
    await this._saveToRedis(room);
    return room;
  }

  async getRoom(roomCode) {
    let room = this.rooms.get(roomCode);
    if (!room) {
      // Server restart bo'lgan bo'lsa, Redis dan tiklab ko'ramiz
      try {
        const cached = await redis.get(`quiz:room:${roomCode}`);
        if (cached) {
          room = this._deserializeRoom(cached);
          if (room) {
            this.rooms.set(roomCode, room);
          }
        }
      } catch (e) {
        console.error(`Redis getRoom error for ${roomCode}:`, e.message);
      }
    }
    return room || null;
  }

  async addPlayer(roomCode, userId, displayName, socketId) {
    const room = await this.getRoom(roomCode);
    if (!room) throw new Error("Room not found");
    
    if (!room.players.has(userId)) {
      room.players.set(userId, { 
        userId, 
        displayName, 
        socketId, 
        score: 0
      });
    } else {
      const player = room.players.get(userId);
      player.socketId = socketId;
      player.displayName = displayName;
    }
    
    await this._saveToRedis(room);
    return room;
  }

  async removePlayer(roomCode, userId) {
    const room = await this.getRoom(roomCode);
    if (room) {
      room.players.delete(userId);
      if (room.players.size === 0) {
        await this.deleteRoom(roomCode);
        return null;
      }
      await this._saveToRedis(room);
    }
    return room;
  }

  async syncRoomState(room) {
    if (room && room.roomCode) {
      await this._saveToRedis(room);
    }
  }

  async deleteRoom(roomCode) {
    const room = this.rooms.get(roomCode);
    if (room) {
      if (room.readTimer) clearTimeout(room.readTimer);
      if (room.actionTimer) clearTimeout(room.actionTimer);
      if (room.cooldownTimer) clearTimeout(room.cooldownTimer);
      this.rooms.delete(roomCode);
    }
    try {
      await redis.del(`quiz:room:${roomCode}`);
    } catch (e) {
      console.error(`Failed to delete room ${roomCode} from Redis:`, e.message);
    }
  }
}

module.exports = new RoomManager();
