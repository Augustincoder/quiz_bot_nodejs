const roomManager = require("../roomManager");
const { getIo } = require("../index");
const { judge } = require("../judger");
const { triggerLeaderboardGate } = require("./brainRing");

async function handleAnswerSubmit(socket, data) {
  const { roomCode, userId, answer } = data;
  const room = await roomManager.getRoom(roomCode);
  if (!room) return;

  if (room.status !== 'action') return;
  
  if (!room.rushSubmissions) room.rushSubmissions = new Map();
  if (room.rushSubmissions.has(userId)) return;

  const receivedTs = Date.now();
  room.rushSubmissions.set(userId, { answer, receivedTs });
  
  socket.emit('zakovat:ack', { userId, receivedTs });
}

function startActionTimer(roomCode) {
  const io = getIo();
  roomManager.getRoom(roomCode).then((room) => {
    if (!room) return;
    
    const timerMs = 60000; // Configurable action timer duration
    room.actionTimer = setTimeout(() => {
      evaluateZakovat(room);
    }, timerMs);
  });
}

function evaluateZakovat(room) {
  const io = getIo();
  
  let correctAnswer = room.currentAnswer;
  
  const submissions = Array.from(room.rushSubmissions.entries()).map(([userId, sub]) => ({
    userId,
    displayName: room.players.get(userId)?.displayName,
    answer: sub.answer,
    receivedTs: sub.receivedTs
  }));

  const correct = submissions.filter(sub => judge(sub.answer, correctAnswer));
  
  correct.sort((a, b) => a.receivedTs - b.receivedTs);
  
  correct.forEach(sub => {
    const p = room.players.get(sub.userId);
    if (p) p.score += 1;
  });

  const scores = Array.from(room.players.values()).map(p => ({
    userId: p.userId,
    score: p.score
  }));

  io.to(room.roomCode).emit('zakovat:rush_result', {
    rankedCorrect: correct,
    scores
  });
  
  triggerLeaderboardGate(room);
}

module.exports = {
  handleAnswerSubmit,
  startActionTimer
};
