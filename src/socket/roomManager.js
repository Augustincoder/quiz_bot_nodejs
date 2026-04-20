/**
 * RoomManager - Manages live game states.
 * Fully async signatures for seamless Redis scaling in the future.
 */
class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  async createRoom(roomCode, hostId, mode) {
    const room = {
      roomCode,
      mode,
      hostId,
      status: 'lobby', // lobby, reading, action, input, result, leaderboard, ended
      
      // Phase 2: Questions loaded from Supabase via room:start
      questions: [],
      currentIndex: 0,
      
      // Player registry: Map<userId, { userId, displayName, socketId, score, mmr }>
      players: new Map(),

      // Active timers
      readTimer: null,
      actionTimer: null,
      cooldownTimer: null,
      
      // Brain-Ring / Erudit
      buzzerLockedBy: null,
      strikesThisQuestion: 0,
      usedBuzzerThisQuestion: new Set(),
      
      // Zakovat Rush Module
      rushSubmissions: new Map(), // Map<userId, { answer, receivedTs }>
      
      // Kahoot
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
    
    // Check if player already exists to avoid resetting score
    if (!room.players.has(userId)) {
      room.players.set(userId, { 
        userId, 
        displayName, 
        socketId, 
        score: 0, 
        mmr: 1000 
      });
    } else {
      // Update socketId/displayName in case of reconnection
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

// Singleton export
module.exports = new RoomManager();
