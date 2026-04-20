const roomManager = require("./roomManager");
const { getIo } = require("./index");

async function advanceQuestion(roomCode) {
  const io = getIo();
  const room = await roomManager.getRoom(roomCode);
  if (!room) return;

  if (room.readTimer) clearTimeout(room.readTimer);
  if (room.actionTimer) clearTimeout(room.actionTimer);
  if (room.cooldownTimer) clearTimeout(room.cooldownTimer);

  room.buzzerLockedBy = null;
  room.strikes = 0;
  room.lockedPlayers = new Set();
  
  room.rushSubmissions = new Map();
  room.kahootAnswers = new Map();
  room.leaderboardAcks = new Set();

  room.currentIndex++;

  if (room.currentIndex >= room.questions.length) {
    room.status = 'ended';
    const finalLeaderboard = Array.from(room.players.values()).sort((a,b)=>b.score - a.score);
    
    // Phase 5: Execute UPDATE on user_profiles
    const { supabase } = require('../lib/supabase');
    let scoreColumn = '';
    if (room.mode === 'brain-ring') scoreColumn = 'brain_ring_score';
    if (room.mode === 'erudit') scoreColumn = 'erudit_score';
    if (room.mode === 'zakovat') scoreColumn = 'zakovat_score';
    if (room.mode === 'kahoot') scoreColumn = 'kahoot_score';

    if (scoreColumn && supabase) {
      for (const player of finalLeaderboard) {
        try {
          const { data: profile } = await supabase.from('user_profiles').select(scoreColumn).eq('user_id', player.userId).single();
          const currentScore = profile ? (profile[scoreColumn] || 0) : 0;
          await supabase.from('user_profiles').upsert({
            user_id: player.userId,
            display_name: player.displayName,
            [scoreColumn]: currentScore + player.score
          });
        } catch (e) {
          console.error("Stats persist error:", e);
        }
      }
    }

    io.to(roomCode).emit('game:end', { finalLeaderboard, mmrDelta: [] });
    return;
  }

  // Handle first start or next
  const qIndex = room.currentIndex - 1; 
  if (qIndex < 0 || qIndex >= room.questions.length) return;

  room.status = 'reading';
  const q = room.questions[qIndex];
  
  let pointValue = undefined;
  let text = "";
  let options = undefined;
  
  // Mode extraction patch (QA audit)
  if (room.mode === 'erudit') {
    const tiers = Object.keys(q.questions || {}).sort((a, b) => parseInt(a) - parseInt(b));
    const activeTier = tiers[0]; // Simplified for now
    const qData = q.questions?.[activeTier];
    if (qData) {
      text = qData.q;
      pointValue = parseInt(activeTier);
      room.currentPointValue = pointValue;
      room.currentAnswer = qData.a;
      room.currentExplanation = qData.e;
    } else {
      text = "";
      room.currentAnswer = "";
      room.currentExplanation = "";
    }
  } else if (room.mode === 'kahoot') {
    const kahootSubIndex = 0;
    const subQ = Array.isArray(q.questions) ? q.questions[kahootSubIndex] : undefined;
    if (subQ) {
      text = subQ.question;
      options = subQ.options;
      room.currentAnswer = subQ.correct_option;
      room.currentExplanation = subQ.explanation;
    } else {
      text = q.question || "";
      options = q.options;
      room.currentAnswer = q.correct_option || q.answer || "";
      room.currentExplanation = q.explanation;
    }
  } else {
    // brain-ring / zakovat
    text = q.question;
    room.currentAnswer = q.answer;
    room.currentExplanation = q.explanation;
  }
  
  const readTimerMs = Math.min((text || "").length * 100, 15000);
  
  io.to(roomCode).emit('game:question', {
    index: qIndex,
    total: room.questions.length,
    question: {
      id: `q_${qIndex}`,
      text: text,
      category: 'General',
      difficulty: 'medium',
      timeLimit: room.mode === 'kahoot' ? 20 : 15,
      points: pointValue || 1,
      correctAnswer: room.currentAnswer,
      options: options ?? undefined
    },
    readTimerMs,
    mode: room.mode,
    pointValue
  });

  room.readTimer = setTimeout(() => {
    room.status = 'action';
    io.to(roomCode).emit('game:phase_action', { index: qIndex });
    
    if (room.mode === 'zakovat') {
       const zakovatHandler = require('./handlers/zakovat');
       zakovatHandler.startActionTimer(roomCode);
    } else if (room.mode === 'brain-ring' || room.mode === 'erudit') {
       room.actionTimer = setTimeout(() => {
          if (room.status === 'action') {
             const brainRingHandler = require('./handlers/brainRing');
             brainRingHandler.triggerLeaderboardGate(room);
          }
       }, 25000); // 25s limit to buzz
    }
  }, readTimerMs);
}

module.exports = { advanceQuestion };
