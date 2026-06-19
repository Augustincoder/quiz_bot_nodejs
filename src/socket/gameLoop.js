'use strict';

const roomManager = require("./roomManager");
const { getIo } = require("./index");
const { supabase } = require('../lib/supabase');

async function advanceQuestion(roomCode) {
  const io = getIo();
  const room = await roomManager.getRoom(roomCode);
  if (!room) return;

  // Clear all timers
  [room.readTimer, room.actionTimer, room.cooldownTimer].forEach(t => t && clearTimeout(t));

  // Reset room state for new question
  room.lockedPlayers = new Set();
  room.kahootAnswers = new Map();
  room.leaderboardAcks = new Set();

  room.currentIndex++;

  // End of game check
  if (room.currentIndex > room.questions.length) {
    return handleGameEnd(roomCode, room);
  }

  const qIndex = room.currentIndex - 1;
  const q = room.questions[qIndex];
  if (!q) return;

  room.status = 'reading';
  
  // Prepare Kahoot Question
  const subQ = Array.isArray(q.questions) ? q.questions[0] : q;
  const text = subQ.question || q.question || "";
  const options = subQ.options || q.options;
  room.currentAnswer = subQ.correct_option || q.correct_option || q.answer || "";
  room.currentExplanation = subQ.explanation || q.explanation;
  room.currentPointValue = 10; // Default Kahoot points

  const questionPayload = {
    id: `q_${qIndex}`,
    text,
    points: room.currentPointValue,
    options,
    timeLimit: 20
  };
  
  const readTimerMs = Math.min(text.length * 100, 15000);
  
  io.to(roomCode).emit('game:question', {
    index: qIndex,
    total: room.questions.length,
    question: questionPayload,
    readTimerMs,
    mode: 'kahoot'
  });

  room.readTimer = setTimeout(() => {
    room.status = 'action';
    io.to(roomCode).emit('game:phase_action', { index: qIndex });
    
    // Auto-advance if no one answers? Usually Kahoot waits for everyone or timer.
    // For now, let the action timer handle the timeout.
    room.actionTimer = setTimeout(() => {
        if (room.status === 'action') {
            io.to(roomCode).emit('game:leaderboard', { 
                correctAnswer: room.currentAnswer,
                explanation: room.currentExplanation,
                leaderboard: Array.from(room.players.values()).sort((a,b) => b.score - a.score)
            });
        }
    }, 20000); // 20s Kahoot timer
  }, readTimerMs);
}

async function handleGameEnd(roomCode, room) {
    const io = getIo();
    room.status = 'ended';
    const finalLeaderboard = Array.from(room.players.values()).sort((a,b) => b.score - a.score);
    
    if (supabase) {
        await Promise.allSettled(finalLeaderboard.map(async (player) => {
            try {
                const { data: profile } = await supabase.from('user_profiles').select('kahoot_score').eq('user_id', player.userId).single();
                const currentScore = profile ? (profile.kahoot_score || 0) : 0;
                await supabase.from('user_profiles').upsert({
                    user_id: player.userId,
                    display_name: player.displayName,
                    kahoot_score: currentScore + player.score
                });
            } catch (e) {
                console.error(`Stats persist error for ${player.userId}:`, e);
            }
        }));
    }

    io.to(roomCode).emit('game:end', { finalLeaderboard, mmrDelta: [] });
}

module.exports = { advanceQuestion };


