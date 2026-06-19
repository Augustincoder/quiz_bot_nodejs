'use strict';

const { Server } = require("socket.io");
const { socketAuthMiddleware } = require("./auth");
const roomManager = require("./roomManager");
const { supabase } = require("../lib/supabase");
const { advanceQuestion } = require('./gameLoop');

let io;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "*",
      methods: ["GET", "POST"]
    }
  });

  io.use(socketAuthMiddleware);

  io.on("connection", (socket) => {
    const userId = String(socket.user?.id);
    const displayName = socket.user?.first_name || socket.user?.id || "Player";
    
    console.log(`🔌 Socket connected: ${socket.id} (User: ${userId})`);

    // --- Room Management ---
    socket.on("room:create", async ({ hostId, roomCode }) => {
      try {
        let room = await roomManager.getRoom(roomCode);
        if (!room) {
          room = await roomManager.createRoom(roomCode, hostId, 'kahoot');
          console.log(`[room:create] Kahoot Room ${roomCode} created by ${hostId}.`);
        }
      } catch (error) {
        socket.emit("room:error", { code: 500, message: error.message });
      }
    });

    socket.on("room:join", async ({ roomCode, userId: reqUserId, displayName: reqDisplayName }) => {
      const idToJoin = String(reqUserId || userId);
      const nameToJoin = reqDisplayName || displayName;
      
      try {
        const room = await roomManager.getRoom(roomCode);
        if (!room) return socket.emit("room:error", { code: 404, message: "Room not found" });

        await roomManager.addPlayer(roomCode, idToJoin, nameToJoin, socket.id);
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
        const room = await roomManager.getRoom(roomCode);
        if (!room) return socket.emit("room:error", { code: 404, message: "Room not found" });

        const { data: questions, error } = await supabase.from('kahoot_questions').select('*');
        if (error) throw error;
        
        room.questions = questions || [];
        room.currentIndex = 0;
        
        console.log(`[room:start] Room ${roomCode}: Loaded ${room.questions.length} Kahoot questions.`);
        advanceQuestion(roomCode);
      } catch (error) {
        socket.emit("room:error", { code: 500, message: error.message });
      }
    });

    // --- Kahoot Game Logic ---
    socket.on("kahoot:answer_submit", async ({ roomCode, answerIndex }) => {
        const room = await roomManager.getRoom(roomCode);
        if (!room || room.status !== 'action') return;

        // Scoring based on time? For now, fixed points.
        if (String(answerIndex) === String(room.currentAnswer)) {
            const player = room.players.get(userId);
            if (player) player.score += 10;
        }

        room.kahootAnswers.set(userId, answerIndex);

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
    
    socket.on("game:leaderboard_ack", async ({ roomCode, userId: ackId }) => {
      const room = await roomManager.getRoom(roomCode);
      if (!room) return;
      
      room.leaderboardAcks = room.leaderboardAcks || new Set();
      room.leaderboardAcks.add(ackId);
      
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


