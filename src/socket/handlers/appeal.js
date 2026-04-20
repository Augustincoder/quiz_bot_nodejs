const { GoogleGenerativeAI } = require('@google/generative-ai');
const roomManager = require("../roomManager");
const { getIo } = require("../index");

async function handleAIRecheck(socket, data) {
  const { questionId, answer: userAnswer, correctAnswer: providedCorrect } = data;
  
  const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
  const room = roomId ? await roomManager.getRoom(roomId) : null;
  
  const correctAnswer = providedCorrect || (room ? room.currentAnswer : '');
  if (!correctAnswer || !userAnswer) return;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash", 
      generationConfig: { responseMimeType: "application/json" } 
    });

    const prompt = `You are a fair trivia judge. The correct answer is "${correctAnswer}". The user typed "${userAnswer}". If the user's answer is a minor typo, a direct synonym, or conceptually identical, reply with valid JSON: { "isCorrect": true, "reason": "..." }. Otherwise, { "isCorrect": false, "reason": "..." }.`;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const json = JSON.parse(responseText);

    if (json.isCorrect && room) {
       // Retroactively award the points based on room mode
       const player = room.players.get(socket.user.id);
       const points = room.mode === "erudit" ? (room.currentPointValue || 10) : 1;
       if (player) player.score += points;
    }

    getIo().to(roomId || socket.id).emit("ai_recheck_result", {
       isValid: json.isCorrect,
       explanation: json.reason,
       confidence: 100
    });

  } catch (error) {
    console.error("AI Recheck Error:", error);
    getIo().to(roomId || socket.id).emit("ai_recheck_result", {
       isValid: false,
       explanation: "Tizimda xatolik yuz berdi yoki javob topilmadi.",
       confidence: 0
    });
  }
}

module.exports = { handleAIRecheck };
