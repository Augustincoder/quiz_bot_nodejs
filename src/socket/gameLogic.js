const roomManager = require("./roomManager");
const { getQuestionsByMode, getSecureQuestionPayload } = require("./questions");
const { getIo } = require("./index");

const ERUDIT_PENALTY = -10;

class GameLogic {
  constructor() {
    this.timers = new Map(); // roomId -> main question timer
    this.buzzerTimers = new Map(); // roomId -> 10s answering timer
    this.zakovatSubmissions = new Map(); // roomId -> array of submissions
  }

  async startGame(roomId) {
    const room = await roomManager.getRoom(roomId);
    if (!room) return;

    room.gameState.currentQuestionIndex = 0;
    room.gameState.phase = "playing";
    this.zakovatSubmissions.set(roomId, []);

    const io = getIo();
    io.to(roomId).emit("game_start", { roomId, mode: room.mode });

    // Slight delay before sending the first question
    setTimeout(() => this.sendNextQuestion(roomId), 2000);
  }

  async sendNextQuestion(roomId) {
    const room = await roomManager.getRoom(roomId);
    if (!room) return;

    await roomManager.resetBuzzer(roomId);
    this.zakovatSubmissions.set(roomId, []);

    const questions = getQuestionsByMode(room.mode);
    if (room.gameState.currentQuestionIndex >= questions.length) {
      return this.endGame(roomId);
    }

    const question = questions[room.gameState.currentQuestionIndex];
    room.gameState.phase = "question";

    const io = getIo();
    io.to(roomId).emit("question_start", {
      question: getSecureQuestionPayload(question),
      duration: question.timeLimit,
      questionNumber: room.gameState.currentQuestionIndex + 1,
      totalQuestions: questions.length,
    });

    // Start global question timer
    if (this.timers.has(roomId)) clearTimeout(this.timers.get(roomId));

    this.timers.set(
      roomId,
      setTimeout(() => this.handleGlobalTimeUp(roomId), question.timeLimit * 1000)
    );
  }

  async handleBuzzerPress(roomId, playerId, timestamp) {
    const room = await roomManager.getRoom(roomId);
    if (!room || room.gameState.phase !== "question") return false;

    // Zakovat has no buzzer
    if (room.mode === "zakovat") return false;

    const success = await roomManager.lockBuzzer(roomId, playerId, timestamp);
    if (success) {
      // Clear global question timer
      if (this.timers.has(roomId)) {
        clearTimeout(this.timers.get(roomId));
        this.timers.delete(roomId);
      }

      // Start 10s strict answering timer
      if (this.buzzerTimers.has(roomId)) clearTimeout(this.buzzerTimers.get(roomId));
      this.buzzerTimers.set(
        roomId,
        setTimeout(() => this.handleBuzzerTimeout(roomId, playerId), 10000)
      );

      const io = getIo();
      io.to(roomId).emit("buzzer_result", { winnerId: playerId, timestamp });
      return true;
    }
    return false;
  }

  async handleBuzzerTimeout(roomId, playerId) {
    const room = await roomManager.getRoom(roomId);
    if (!room) return;

    const io = getIo();

    // Player buzzed but failed to submit within 10s
    let pointsDelta = 0;
    if (room.mode === "erudit") {
      pointsDelta = ERUDIT_PENALTY;
      await roomManager.updateScore(roomId, playerId, pointsDelta);
    }

    const questions = getQuestionsByMode(room.mode);
    const question = questions[room.gameState.currentQuestionIndex];

    io.to(roomId).emit("answer_result", {
      playerId,
      isCorrect: false,
      correctAnswer: question.correctAnswer,
      pointsEarned: pointsDelta,
      timeout: true,
    });

    this.advanceQuestion(roomId);
  }

  async submitAnswer(roomId, playerId, answer, timestamp = Date.now()) {
    const room = await roomManager.getRoom(roomId);
    if (!room) return;

    const questions = getQuestionsByMode(room.mode);
    const question = questions[room.gameState.currentQuestionIndex];
    if (!question) return;

    if (room.mode === "zakovat") {
      // Zakovat: collect submissions globally until time is up
      const submissions = this.zakovatSubmissions.get(roomId) || [];
      submissions.push({ playerId, answer, timestamp });
      this.zakovatSubmissions.set(roomId, submissions);
      return; 
    }

    // Standard Buzzer Modes / Kahoot
    // Clear buzzer answering timer
    if (this.buzzerTimers.has(roomId)) {
      clearTimeout(this.buzzerTimers.get(roomId));
      this.buzzerTimers.delete(roomId);
    }
    if (this.timers.has(roomId)) {
      clearTimeout(this.timers.get(roomId));
      this.timers.delete(roomId);
    }

    const isCorrect =
      question.correctAnswer.toLowerCase().includes(answer.toLowerCase()) ||
      answer.toLowerCase().includes(question.correctAnswer.toLowerCase());

    let pointsDelta = 0;
    if (isCorrect) {
      pointsDelta = question.points;
    } else {
      if (room.mode === "erudit") pointsDelta = ERUDIT_PENALTY;
    }

    await roomManager.updateScore(roomId, playerId, pointsDelta);

    const io = getIo();
    io.to(roomId).emit("answer_result", {
      playerId,
      isCorrect,
      correctAnswer: question.correctAnswer,
      pointsEarned: pointsDelta,
    });

    this.advanceQuestion(roomId);
  }

  async handleGlobalTimeUp(roomId) {
    const room = await roomManager.getRoom(roomId);
    if (!room) return;

    const questions = getQuestionsByMode(room.mode);
    const question = questions[room.gameState.currentQuestionIndex];
    const io = getIo();

    if (room.mode === "zakovat") {
      // Evaluate all collected submissions in Zakovat
      const submissions = this.zakovatSubmissions.get(roomId) || [];
      // Sort by ms timestamp (Rush Module priority)
      submissions.sort((a, b) => a.timestamp - b.timestamp);

      const results = [];
      submissions.forEach(sub => {
        const isCorrect =
          question.correctAnswer.toLowerCase().includes(sub.answer.toLowerCase()) ||
          sub.answer.toLowerCase().includes(question.correctAnswer.toLowerCase());

        let points = isCorrect ? question.points : 0;
        room.gameState.scores[sub.playerId] = (room.gameState.scores[sub.playerId] || 0) + points;

        results.push({
          playerId: sub.playerId,
          isCorrect,
          pointsEarned: points,
        });
      });

      io.to(roomId).emit("zakovat_results", {
        correctAnswer: question.correctAnswer,
        results
      });
    } else {
      // No one answered in Kahoot, Brain-Ring, or Erudit
      io.to(roomId).emit("answer_result", {
        playerId: null,
        isCorrect: false,
        correctAnswer: question.correctAnswer,
        pointsEarned: 0,
      });
    }

    this.advanceQuestion(roomId);
  }

  advanceQuestion(roomId) {
    roomManager.getRoom(roomId).then(room => {
      if (!room) return;
      room.gameState.currentQuestionIndex++;
      setTimeout(() => this.sendNextQuestion(roomId), 4000);
    });
  }

  async endGame(roomId) {
    const room = await roomManager.getRoom(roomId);
    const io = getIo();

    let maxScore = -9999;
    let winnerId = null;
    for (const [playerId, score] of Object.entries(room.gameState.scores)) {
      if (score > maxScore) {
        maxScore = score;
        winnerId = playerId;
      }
    }

    room.gameState.phase = "finished";
    io.to(roomId).emit("game_end", {
      finalScores: room.gameState.scores,
      mmrChanges: {},
      winner: winnerId
    });

    // Clean up timers
    if (this.timers.has(roomId)) clearTimeout(this.timers.get(roomId));
    if (this.buzzerTimers.has(roomId)) clearTimeout(this.buzzerTimers.get(roomId));
  }
}

const gameLogic = new GameLogic();
module.exports = gameLogic;
