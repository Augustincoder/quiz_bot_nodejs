'use strict';

const { Server } = require("socket.io");
const { socketAuthMiddleware } = require("./auth");
const roomManager = require("./roomManager");
const { supabase } = require("../lib/supabase");
const { advanceQuestion, showLeaderboard } = require('./gameLoop');

let io;

function isValidRoomCode(code) {
  return typeof code === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(code.trim());
}

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? false : "*"),
      methods: ["GET", "POST"]
    }
  });

  io.use(socketAuthMiddleware);

  io.on("connection", (socket) => {
    const userId = String(socket.user?.id);
    const displayName = socket.user?.first_name || socket.user?.id || "Player";
    
    console.log(`🔌 Socket connected: ${socket.id} (User: ${userId})`);

    // --- Room Management ---
    socket.on("room:create", async ({ roomCode }) => {
      try {
        if (!isValidRoomCode(roomCode)) {
          return socket.emit("room:error", { code: 400, message: "Noto'g'ri xona kodi (Invalid room code)" });
        }
        let room = await roomManager.getRoom(roomCode);
        if (!room) {
          room = await roomManager.createRoom(roomCode, userId, 'kahoot');
          console.log(`[room:create] Kahoot Room ${roomCode} created by ${userId}.`);
        }
      } catch (error) {
        socket.emit("room:error", { code: 500, message: error.message });
      }
    });

    socket.on("room:join", async ({ roomCode, displayName: reqDisplayName }) => {
      if (!isValidRoomCode(roomCode)) {
        return socket.emit("room:error", { code: 400, message: "Noto'g'ri xona kodi (Invalid room code)" });
      }
      const idToJoin = userId;
      const cleanName = (reqDisplayName && typeof reqDisplayName === 'string')
        ? reqDisplayName.trim().substring(0, 30)
        : displayName;
      
      try {
        const room = await roomManager.getRoom(roomCode);
        if (!room) return socket.emit("room:error", { code: 404, message: "Room not found" });

        const existingPlayer = room.players.get(idToJoin);
        const wasReconnecting = existingPlayer && existingPlayer.disconnected;

        await roomManager.addPlayer(roomCode, idToJoin, cleanName, socket.id);
        socket.join(roomCode);

        socket.emit("room:state", {
          roomCode: room.roomCode,
          players: Array.from(room.players.values()),
          mode: 'kahoot',
          status: room.status,
          currentIndex: room.currentIndex,
        });

        if (wasReconnecting) {
          io.to(roomCode).emit("room:player_reconnected", {
            userId: idToJoin,
            players: Array.from(room.players.values())
          });
        } else {
          io.to(roomCode).emit("room:player_joined", {
            players: Array.from(room.players.values())
          });
        }
      } catch (error) {
        socket.emit("room:error", { code: 500, message: error.message });
      }
    });

    socket.on("room:start", async ({ roomCode }) => {
      try {
        if (!isValidRoomCode(roomCode)) {
          return socket.emit("room:error", { code: 400, message: "Noto'g'ri xona kodi (Invalid room code)" });
        }
        const room = await roomManager.getRoom(roomCode);
        if (!room) return socket.emit("room:error", { code: 404, message: "Room not found" });

        if (room.hostId && String(room.hostId) !== userId) {
          return socket.emit("room:error", { code: 403, message: "Faqat xona egasi o'yinni boshlay oladi" });
        }

        if (room.status !== 'lobby') {
          return socket.emit("room:error", { code: 400, message: "O'yin allaqachon boshlangan yoki tugatilgan" });
        }

        room.status = 'starting';
        if (room.idleTimer) {
          clearTimeout(room.idleTimer);
          room.idleTimer = null;
        }

        if (!supabase) {
          room.status = 'lobby';
          return socket.emit("room:error", { code: 503, message: "Supabase bazasi ulanmagan yoki mavjud emas" });
        }

        const { data: questions, error } = await supabase
          .from('kahoot_questions')
          .select('*')
          .limit(30);

        if (error) {
          room.status = 'lobby';
          throw error;
        }

        if (!questions || questions.length === 0) {
          room.status = 'lobby';
          return socket.emit("room:error", { code: 404, message: "Kahoot uchun savollar topilmadi" });
        }
        
        room.questions = questions;
        room.currentIndex = 0;
        
        console.log(`[room:start] Room ${roomCode}: Loaded ${room.questions.length} Kahoot questions.`);
        advanceQuestion(roomCode);
      } catch (error) {
        socket.emit("room:error", { code: 500, message: error.message });
      }
    });

    // --- Kahoot Game Logic ---
    socket.on("kahoot:answer_submit", async ({ roomCode, answerIndex }) => {
        if (!isValidRoomCode(roomCode)) return;
        // Synchronous lookup from in-memory Map (Bug 39 fix: zero async tick delay)
        const room = roomManager.rooms?.get(roomCode);
        if (!room || room.status !== 'action') return;

        // Atomic synchronous guard against double-submit (Bug 39 fix)
        if (room.kahootAnswers.has(userId)) return;
        room.kahootAnswers.set(userId, answerIndex);

        if (String(answerIndex) === String(room.currentAnswer)) {
            const player = room.players.get(userId);
            if (player) player.score += 10;
        }

        // If all players answered, cancel active timer and show leaderboard (Bug 38 fix)
        if (room.kahootAnswers.size >= room.players.size) {
            showLeaderboard(roomCode, room);
        }
    });
    
    socket.on("game:leaderboard_ack", async ({ roomCode }) => {
      if (!isValidRoomCode(roomCode)) return;
      const room = await roomManager.getRoom(roomCode);
      if (!room || room.status !== 'leaderboard') return;
      
      // Use authenticated socket userId instead of untrusted client payload ackId
      room.leaderboardAcks = room.leaderboardAcks || new Set();
      room.leaderboardAcks.add(userId);
      
      const activePlayersCount = Array.from(room.players.values()).filter(p => !p.disconnected).length;
      const targetCount = activePlayersCount > 0 ? activePlayersCount : room.players.size;

      if (room.leaderboardAcks.size >= targetCount) {
         if (room.leaderboardTimer) {
           clearTimeout(room.leaderboardTimer);
           room.leaderboardTimer = null;
         }
         advanceQuestion(roomCode);
      }
    });

    socket.on("disconnect", async () => {
      console.log(`🔴 Socket disconnected: ${socket.id} (User: ${userId})`);
      for (const room of roomManager.rooms.values()) {
        const player = room.players.get(userId);
        if (player && player.socketId === socket.id) {
          player.disconnected = true;
          player.disconnectedAt = Date.now();
          if (player.disconnectTimer) {
            clearTimeout(player.disconnectTimer);
          }

          // 10-second grace period for network flap / socket reconnection
          player.disconnectTimer = setTimeout(async () => {
            const currentRoom = await roomManager.getRoom(room.roomCode);
            const p = currentRoom?.players.get(userId);
            if (p && p.disconnected) {
              console.log(`⏱️ Grace period expired for User ${userId} in Room ${room.roomCode}. Removing player.`);
              const oldHostId = currentRoom?.hostId;
              await roomManager.removePlayer(room.roomCode, userId);
              const updatedRoom = await roomManager.getRoom(room.roomCode);
              if (updatedRoom && updatedRoom.hostId !== oldHostId) {
                io.to(room.roomCode).emit("room:host_changed", {
                  hostId: updatedRoom.hostId,
                });
              }
              io.to(room.roomCode).emit("room:player_left", {
                players: updatedRoom?.players ? Array.from(updatedRoom.players.values()) : []
              });
            }
          }, 10000);
          player.disconnectTimer.unref();

          io.to(room.roomCode).emit("room:player_disconnected", {
            userId,
            players: Array.from(room.players.values())
          });
        }
      }
    });
  });

  return io;
}

function getIo() {
  if (!io) throw new Error("Socket.io not initialized!");
  return io;
}

module.exports = { initSocket, getIo };


