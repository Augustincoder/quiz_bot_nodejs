'use strict';

/**
 * RoomManager - Manages live game states.
 * Simplified for Kahoot-only mode.
 */
const MAX_ROOMS = 100;
const ROOM_LOBBY_TTL_MS = 30 * 60 * 1000; // 30 minutes

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  async createRoom(roomCode, hostId) {
    if (this.rooms.size >= MAX_ROOMS) {
      throw new Error("Maksimal xonalar soni chegarasiga yetildi (100). Yangi xona ochishdan oldin mavjud xonalar tugashini kuting.");
    }

    const idleTimer = setTimeout(() => {
      this.deleteRoom(roomCode);
    }, ROOM_LOBBY_TTL_MS);
    idleTimer.unref();

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
      leaderboardTimer: null,
      idleTimer,
      kahootAnswers: new Map(),
      leaderboardAcks: new Set(),
      createdAt: Date.now(),
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
        score: 0,
        disconnected: false,
        disconnectTimer: null
      });
    } else {
      const player = room.players.get(userId);
      if (player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
      }
      player.disconnected = false;
      player.socketId = socketId;
      player.displayName = displayName;
    }
    
    return room;
  }

  async removePlayer(roomCode, userId) {
    const room = await this.getRoom(roomCode);
    if (room) {
      const player = room.players.get(userId);
      if (player?.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
      }
      room.players.delete(userId);

      // Bug 41 fix: Migrate host to next remaining active player if host departed
      if (String(room.hostId) === String(userId) && room.players.size > 0) {
        const nextPlayer = room.players.values().next().value;
        if (nextPlayer) {
          room.hostId = nextPlayer.userId;
        }
      }

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
      if (room.leaderboardTimer) clearTimeout(room.leaderboardTimer);
      if (room.idleTimer) clearTimeout(room.idleTimer);
      if (room.endTimer) clearTimeout(room.endTimer);
      if (room.players) {
        for (const player of room.players.values()) {
          if (player?.disconnectTimer) {
            clearTimeout(player.disconnectTimer);
            player.disconnectTimer = null;
          }
        }
      }
      this.rooms.delete(roomCode);
    }
  }

  /**
   * Cleans up dead, abandoned, or zombie rooms and frees associated timers/state
   */
  cleanupDeadRooms(now = Date.now()) {
    const MAX_LIFETIME = 30 * 60 * 1000; // 30 minutes
    for (const [roomCode, room] of this.rooms.entries()) {
      const age = now - (room.createdAt || 0);
      const isEnded = room.status === 'ended';
      const noPlayers = !room.players || room.players.size === 0;
      if (isEnded || age > MAX_LIFETIME || (noPlayers && age > 5 * 60 * 1000)) {
        this.deleteRoom(roomCode);
      }
    }
  }
}

module.exports = new RoomManager();
