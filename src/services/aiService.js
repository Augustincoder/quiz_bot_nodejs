'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GEMINI_API_KEY } = require('../config/config');

// Gemini modelini initsializatsiya qilish
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Tez va yengil ishlashi uchun 'gemini-1.5-flash' modelidan foydalanamiz
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

async function explainMistakesBatch(mistakes) {
    if (!GEMINI_API_KEY) {
        return "⚠️ API kalit kiritilmagan. Admin bilan bog'laning.";
    }

    try {
        // Token va xotira chegarasidan oshmasligi uchun maksimal 5 ta xatoni olamiz
        const targetMistakes = mistakes.slice(0, 5);

        let prompt = `Sen mehribon va aqlli universitet o'qituvchisisan. Talaba testda quyidagi xatolarni qildi. 
        Iltimos, har bir xato uchun nima sababdan talabaning javobi xato ekanligini va to'g'ri javob nega aynan shu ekanligini o'zbek tilida qisqa, tushunarli (har biriga 1-2 gap) qilib tushuntirib ber.
        Matnni Telegram uchun chiroyli formatla (emoji, qalin harflar bilan).\n\n`;

        targetMistakes.forEach((m, i) => {
            prompt += `🔹 ${i + 1}-Savol: ${m.question}\n✅ To'g'ri: ${m.correct_ans}\n❌ Talaba javobi: ${m.wrong_ans}\n\n`;
        });

        if (mistakes.length > 5) {
            prompt += `\n_(Talabaning jami xatolari ko'p, lekin faqat shu eng birinchi 5 ta asosiy xatoni tahlil qil)_`;
        }

        const result = await model.generateContent(prompt);
        return result.response.text();

    } catch (error) {
        console.error("AI Tahlil xatosi:", error.message);
        return "🤖 Kechirasiz, sun'iy intellekt xizmatida vaqtincha uzilish yuz berdi. Iltimos keyinroq urinib ko'ring.";
    }
}
// ... tepadagi explainMistakesBatch kodi ...

// AI dan kelgan matn ichidan JSON qismini tozalab oluvchi yordamchi funksiya
function extractJSON(text) {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
        try { return JSON.parse(match[0]); } catch (e) { return null; }
    }
    return null;
}

// 1. Matndan test yaratish funksiyasi
async function generateQuizFromText(text) {
    try {
        const prompt = `Sen professional o'qituvchisan. Quyidagi matn asosida 10 ta variantli test tuz.
        Javobing QAT'IY ravishda faqat quyidagi JSON formatida bo'lishi shart. Boshqa hech qanday izoh yozma!
        Struktura: [{"question": "Savol matni?", "options": ["A javob", "B javob", "C javob", "D javob"], "correct_index": 0}]
        To'g'ri javob indeksi (correct_index) 0 dan 3 gacha bo'lgan raqam.

        Matn:
        ${text}`;

        const result = await model.generateContent(prompt);
        return extractJSON(result.response.text());
    } catch (error) {
        console.error("AI Matndan test xatosi:", error);
        return null;
    }
}

// 2. Savollarga variantlar yaratish funksiyasi
async function generateOptionsForQuestions(questionsText) {
    try {
        const prompt = `Sen professional o'qituvchisan. Quyida berilgan savollar ro'yxatiga har biri uchun 1 ta to'g'ri va 3 ta mantiqiy, lekin xato variant tuz.
        Javobing QAT'IY ravishda faqat JSON formatida bo'lishi shart. Boshqa izoh yozma!
        Struktura: [{"question": "Savol matni?", "options": ["A javob", "B javob", "C javob", "D javob"], "correct_index": 0}]
        
        Savollar ro'yxati:
        ${questionsText}`;

        const result = await model.generateContent(prompt);
        return extractJSON(result.response.text());
    } catch (error) {
        console.error("AI Savoldan test xatosi:", error);
        return null;
    }
}

module.exports = {
    explainMistakesBatch,
    generateQuizFromText,
    generateOptionsForQuestions
};