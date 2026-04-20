const { Server } = require("socket.io");
const { socketAuthMiddleware } = require("./auth");
const roomManager = require("./roomManager");
const { supabase } = require("../lib/supabase");

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

    // room:create { mode, hostId, roomCode, displayName }
    socket.on("room:create", async (data) => {
      const { mode, hostId, roomCode, displayName } = data;
      try {
        let room = await roomManager.getRoom(roomCode);
        if (!room) {
          room = await roomManager.createRoom(roomCode, hostId, mode);
          console.log(`[room:create] Room ${roomCode} created. Mode: ${mode}`);
        }
      } catch (error) {
        socket.emit("room:error", { code: 500, message: error.message });
      }
    });

    // room:join { roomCode, userId, displayName }
    socket.on("room:join", async (data) => {
      const { roomCode, userId: reqUserId, displayName: reqDisplayName } = data;
      const idToJoin = String(reqUserId || userId);
      const nameToJoin = reqDisplayName || displayName;
      
      try {
        let room = await roomManager.getRoom(roomCode);
        if (!room) {
          return socket.emit("room:error", { code: 404, message: "Room not found" });
        }

        await roomManager.addPlayer(roomCode, idToJoin, nameToJoin, socket.id);
        socket.join(roomCode);
        console.log(`[room:join] User ${idToJoin} joined room ${roomCode}`);

        socket.emit("room:state", {
          roomCode: room.roomCode,
          players: Array.from(room.players.values()),
          mode: room.mode,
          status: room.status
        });

        io.to(roomCode).emit("room:player_joined", {
          players: Array.from(room.players.values())
        });
      } catch (error) {
        socket.emit("room:error", { code: 500, message: error.message });
      }
    });

    // room:start { roomCode }
    socket.on("room:start", async (data) => {
      const { roomCode } = data;
      try {
        const room = await roomManager.getRoom(roomCode);
        if (!room) return socket.emit("room:error", { code: 404, message: "Room not found" });

        let table;
        switch (room.mode) {
          case 'brain-ring': table = 'brain_ring_questions'; break;
          case 'zakovat':    table = 'zakovat_questions'; break;
          case 'kahoot':     table = 'kahoot_questions'; break;
          case 'erudit':     table = 'erudit_questions'; break;
          default: throw new Error(`Invalid mode: ${room.mode}`);
        }

        const { data: questions, error } = await supabase.from(table).select('*');
        if (error) throw error;
        
        room.questions = questions || [];
        room.currentIndex = 0;
        
        console.log(`[room:start] Loaded ${room.questions.length} questions into Room ${roomCode} from ${table}`);

        // Phase 3 implementation: Advance to the first question to trigger reading timer
        const { advanceQuestion } = require('./gameLoop');
        advanceQuestion(roomCode);
        
      } catch (error) {
        console.error("room:start error", error);
        socket.emit("room:error", { code: 500, message: error.message });
      }
    });

    // --- Phase 3 Game Handlers ---
    const brainRing = require('./handlers/brainRing');
    const zakovat = require('./handlers/zakovat');

    socket.on("buzzer:press", (data) => brainRing.handleBuzzerPress(socket, data));
    socket.on("buzzer:answer_submit", (data) => brainRing.handleAnswerSubmit(socket, data));
    socket.on("zakovat:answer_submit", (data) => zakovat.handleAnswerSubmit(socket, data));
    
    // --- Phase 5 AI Appeal ---
    const appeal = require('./handlers/appeal');
    socket.on("request_ai_recheck", (data) => appeal.handleAIRecheck(socket, data));
    
    // Leaderboard ack logic (for progressing the game after the gate)
    socket.on("game:leaderboard_ack", async (data) => {
      const { roomCode, userId } = data;
      const room = await roomManager.getRoom(roomCode);
      if (!room) return;
      
      room.leaderboardAcks = room.leaderboardAcks || new Set();
      room.leaderboardAcks.add(userId);
      
      // If all players acknowledged, or timeout, advance to next question
      // A full implementation would use a timer, but for now we manually check
      if (room.leaderboardAcks.size >= room.players.size) {
         const { advanceQuestion } = require('./gameLoop');
         advanceQuestion(roomCode);
      }
    });

    // disconnect
    socket.on("disconnect", async () => {
      console.log(`🔴 Socket disconnected: ${socket.id}`);
      
      const allRooms = Array.from(roomManager.rooms.values());
      for (const room of allRooms) {
        for (const [pId, player] of room.players.entries()) {
          if (player.socketId === socket.id) {
            await roomManager.removePlayer(room.roomCode, pId);
            
            const activeRoom = await roomManager.getRoom(room.roomCode);
            if (activeRoom) {
              io.to(room.roomCode).emit("room:player_left", {
                players: Array.from(activeRoom.players.values())
              });
            }
          }
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
