'use strict';

/**
 * RoomManager - Manages live game states.
 * Simplified for Kahoot-only mode.
 */
class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  async createRoom(roomCode, hostId) {
    const room = {
      roomCode,
      mode: 'kahoot',
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
    return room;
  }

  async getRoom(roomCode) {
    return this.rooms.get(roomCode) || null;
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
    }
    return room;
  }

  async deleteRoom(roomCode) {
    const room = this.rooms.get(roomCode);
    if (room) {
      if (room.readTimer) clearTimeout(room.readTimer);
      if (room.actionTimer) clearTimeout(room.actionTimer);
      if (room.cooldownTimer) clearTimeout(room.cooldownTimer);
      this.rooms.delete(roomCode);
    }
  }
}

module.exports = new RoomManager();
