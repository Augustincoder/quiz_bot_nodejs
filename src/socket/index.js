'use strict';

const { Server } = require("socket.io");
const { socketAuthMiddleware } = require("./auth");
const roomManager = require("./roomManager");
const { supabase } = require("../lib/supabase");
const { advanceQuestion } = require('./gameLoop');

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

        await roomManager.addPlayer(roomCode, idToJoin, cleanName, socket.id);
        socket.join(roomCode);

        socket.emit("room:state", {
          roomCode: room.roomCode,
          players: Array.from(room.players.values()),
          mode: 'kahoot',
          status: room.status
        });

        io.to(roomCode).emit("room:player_joined", {
          players: Array.from(room.players.values())
        });
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
        const room = await roomManager.getRoom(roomCode);
        if (!room || room.status !== 'action') return;

        // Prevent duplicate answers / race condition score tampering
        if (room.kahootAnswers.has(userId)) return;

        room.kahootAnswers.set(userId, answerIndex);

        if (String(answerIndex) === String(room.currentAnswer)) {
            const player = room.players.get(userId);
            if (player) player.score += 10;
        }

        // If all players answered, show leaderboard
        if (room.kahootAnswers.size >= room.players.size) {
            if (room.actionTimer) clearTimeout(room.actionTimer);
            io.to(roomCode).emit('game:leaderboard', { 
                correctAnswer: room.currentAnswer,
                explanation: room.currentExplanation,
                leaderboard: Array.from(room.players.values()).sort((a,b) => b.score - a.score)
            });
        }
    });
    
    socket.on("game:leaderboard_ack", async ({ roomCode }) => {
      if (!isValidRoomCode(roomCode)) return;
      const room = await roomManager.getRoom(roomCode);
      if (!room) return;
      
      // Use authenticated socket userId instead of untrusted client payload ackId
      room.leaderboardAcks = room.leaderboardAcks || new Set();
      room.leaderboardAcks.add(userId);
      
      if (room.leaderboardAcks.size >= room.players.size) {
         advanceQuestion(roomCode);
      }
    });

    socket.on("disconnect", async () => {
      console.log(`🔴 Socket disconnected: ${socket.id}`);
      for (const room of roomManager.rooms.values()) {
        const player = Array.from(room.players.values()).find(p => p.socketId === socket.id);
        if (player) {
          await roomManager.removePlayer(room.roomCode, player.userId);
          io.to(room.roomCode).emit("room:player_left", {
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


