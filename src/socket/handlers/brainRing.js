const roomManager = require("../roomManager");
const { getIo } = require("../index");
const { judge } = require("../judger");

async function handleBuzzerPress(socket, data) {
  const { roomCode, userId } = data;
  const room = await roomManager.getRoom(roomCode);
  if (!room) return;

  if (room.status !== 'action') return;
  if (room.buzzerLockedBy !== null) return;
  if (room.lockedPlayers && room.lockedPlayers.has(userId)) return;

  room.buzzerLockedBy = userId;
  room.status = 'input';
  
  getIo().to(roomCode).emit('buzzer:locked', {
    userId,
    displayName: room.players.get(userId)?.displayName
  });
  
  // Enforce server-side Answer Input limit (10s + 1s grace)
  if (room.inputTimer) clearTimeout(room.inputTimer);
  room.inputTimer = setTimeout(() => {
    if (room.status === 'input' && room.buzzerLockedBy === userId) {
      handleAnswerSubmit(socket, { roomCode, userId, answer: '' });
    }
  }, 11000);
}

async function handleAnswerSubmit(socket, data) {
  const { roomCode, userId, answer } = data;
  const room = await roomManager.getRoom(roomCode);
  if (!room) return;
  
  if (room.inputTimer) clearTimeout(room.inputTimer);
  if (room.buzzerLockedBy !== userId) return;

  let correctAnswer = room.currentAnswer;
  let pointValue = room.mode === 'erudit' ? (room.currentPointValue || 10) : 1;

  const isCorrect = judge(answer, correctAnswer);

  if (isCorrect) {
    const player = room.players.get(userId);
    if (player) player.score += pointValue;

    // Emit answer_result for frontend compatibility
    getIo().to(roomCode).emit('answer_result', {
      playerId: userId,
      isCorrect: true,
      correctAnswer: room.currentAnswer,
      pointsEarned: pointValue
    });
    
    // Also emit buzzer:result for any legacy listeners
    getIo().to(roomCode).emit('buzzer:result', {
      userId,
      correct: true,
      pointsAwarded: pointValue
    });
    
    triggerLeaderboardGate(room);
  } else {
    room.strikes = (room.strikes || 0) + 1;
    if (!room.lockedPlayers) room.lockedPlayers = new Set();
    room.lockedPlayers.add(userId);
    room.buzzerLockedBy = null;

    // Emit answer_result for frontend compatibility
    getIo().to(roomCode).emit('answer_result', {
      playerId: userId,
      isCorrect: false,
      correctAnswer: room.currentAnswer,
      pointsEarned: 0
    });

    // Also emit buzzer:result for any legacy listeners
    getIo().to(roomCode).emit('buzzer:result', {
      userId,
      correct: false,
      strikeCount: room.strikes
    });

    if (room.strikes >= 3) {
      getIo().to(roomCode).emit('buzzer:question_fail', { correctAnswer });
      triggerLeaderboardGate(room);
    } else {
      room.status = 'cooldown';
      room.cooldownTimer = setTimeout(() => {
        room.status = 'action';
        const eligiblePlayers = Array.from(room.players.values())
          .filter(p => !room.lockedPlayers.has(p.userId))
          .map(p => p.userId);
        getIo().to(roomCode).emit('buzzer:reactivate', { eligiblePlayers });
      }, 2000);
    }
  }
}

function triggerLeaderboardGate(room) {
  room.status = 'result';
  const scores = Array.from(room.players.values()).map(p => ({
    userId: p.userId,
    score: p.score
  }));
  
  const appealEligible = Array.from(room.lockedPlayers || []);
  
  getIo().to(room.roomCode).emit('game:round_result', {
    correctAnswer: room.currentAnswer,
    explanation: room.currentExplanation,
    scores,
    appealEligible
  });
}

module.exports = {
  handleBuzzerPress,
  handleAnswerSubmit,
  triggerLeaderboardGate
};
