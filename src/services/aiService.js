'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GEMINI_API_KEY }     = require('../config/config');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
// Eng so'nggi kuchli model (Lite versiyasi tez va limitlar keng)
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
const fileManager = new GoogleAIFileManager(GEMINI_API_KEY);
// 1. Test xatolarini tahlil qilish (HTML formatda)
async function explainMistakesBatch(mistakes) {
    if (!GEMINI_API_KEY) return "⚠️ API kalit kiritilmagan.";
    try {
        const targetMistakes = mistakes.slice(0, 5); 
        let prompt = `Sen universitet o'qituvchisisan. Talaba testda quyidagi xatolarni qildi. Har bir xato uchun to'g'ri javobni tushuntirib ber.
        DIQQAT! Javobni FAKAT Telegram HTML formatida yoz! (Qalin qilish uchun <b>matn</b>, qiya uchun <i>matn</i> ishlating. Hech qanday ** yulduzcha yoki _ ishlatma!)\n\n`;
        
        targetMistakes.forEach((m, i) => { prompt += `🔹 <b>${i+1}-Savol:</b> ${m.question}\n✅ To'g'ri: ${m.correct_ans}\n❌ Talaba: ${m.wrong_ans}\n\n`; });
        if (mistakes.length > 5) prompt += `\n<i>(Faqat birinchi 5 ta asosiy xatoni tahlil qilindi)</i>`;

        const result = await model.generateContent(prompt);
        // AI adashib yulduzcha qo'shsa ham uni HTML ga o'giramiz yoki o'chiramiz
        return result.response.text().replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*/g, '');
    } catch (error) {
        return "🤖 Kechirasiz, tahlil qilishda xatolik yuz berdi.";
    }
}

// AI matn ichidan JSON qismini tozalab oluvchi
function extractJSON(text) {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) { try { return JSON.parse(match[0]); } catch (e) { return null; } }
    return null;
}

// AI dan test yaratishda miqdor ko'rsatish uchun yordamchi
function getCountInstruction(count) {
    return count === 'auto' || !count 
        ? "Matn hajmiga qarab, eng muhim ma'lumotlar asosida munosib miqdorda (masalan 5-15 ta o'rtasida)" 
        : `Aynan ${count} ta`;
}
// 2. Matndan test yaratish
async function generateQuizFromText(text, count) { // <-- count qo'shildi
    try {
        const prompt = `Matn asosida ${getCountInstruction(count)} variantli test tuz. Faqat JSON formatda qaytar. Boshqa so'z yozma.
        Struktura: [{"question": "Savol?", "options": ["A", "B", "C", "D"], "correct_index": 0}]\n\nMatn:\n${text}`;
        const result = await model.generateContent(prompt);
        return extractJSON(result.response.text());
    } catch (e) { return null; }
}
// 3. Savollarga javoblar yaratish
async function generateOptionsForQuestions(questionsText) {
    try {
        const prompt = `Savollar ro'yxatiga 1 to'g'ri va 3 xato variant tuz. Faqat JSON formatda qaytar.
        Struktura: [{"question": "Savol?", "options": ["A", "B", "C", "D"], "correct_index": 0}]\n\nSavollar:\n${questionsText}`;
        const result = await model.generateContent(prompt);
        return extractJSON(result.response.text());
    } catch (e) { return null; }
}

// 4. YANGI: Yozma ish (Insho/Tarjima) tahlili
async function analyzeEssay(text) {
    try {
        const prompt = `Sen til o'qituvchisisan. O'quvchi senga matn yubordi. Grammatik, mantiqiy xatolarni top, tushuntir va 100 ballik tizimda bahola.
        DIQQAT! Javobni FAKAT Telegram HTML formatida yoz! (Qalin uchun <b>matn</b>, qiya uchun <i>matn</i> ishlating. Hech qanday yulduzcha ** ishlatma!)\n\nO'quvchi matni:\n"${text}"`;

        const result = await model.generateContent(prompt);
        return result.response.text().replace(/\*\*(.*?)\*\*/g, '<b>$1</b>').replace(/\*/g, '');
    } catch (error) {
        return "🤖 Kechirasiz, matnni tahlil qilishda xatolik yuz berdi.";
    }
}

// YANGI: Rasmdan test yasash (Gemini Vision imkoniyatlaridan foydalanib)
async function generateQuizFromImage(localFilePath, mimeType, count) { // <-- count qo'shildi
    try {
        const uploadResponse = await fileManager.uploadFile(localFilePath, { mimeType: mimeType, displayName: "Test Image" });
        const prompt = `Sen professional o'qituvchisan. Ushbu rasmdagi matnni diqqat bilan o'qi va tahlil qil.
        Shu rasmdagi ma'lumotlar asosida ${getCountInstruction(count)} variantli test tuz.
        Javobing QAT'IY ravishda faqat quyidagi JSON formatida bo'lishi shart. Boshqa izoh yozma!
        Struktura: [{"question": "Savol matni?", "options": ["A", "B", "C", "D"], "correct_index": 0}]`;
        const result = await model.generateContent([
            { fileData: { mimeType: uploadResponse.file.mimeType, fileUri: uploadResponse.file.uri } },
            { text: prompt }
        ]);
        return extractJSON(result.response.text());
    } catch (error) { return null; }
}

// 3. Adaptiv (Shaxsiy) test
async function generateAdaptiveQuiz(subject, mistakes, count) { // <-- count qo'shildi
    try {
        const targetMistakes = mistakes.slice(0, 20); 
        let prompt = `Sen mehribon o'qituvchisan. O'quvchi "${subject}" fanidan quyidagi savollarda xato qildi:\n\n`;
        targetMistakes.forEach((m, i) => { prompt += `❌ ${i+1}: ${m.question} (To'g'ri: ${m.correct_ans})\n`; });
        prompt += `\nVazifang: Shu xatolar mavzusini tahlil qil va o'quvchi shularni yaxshilashi uchun xuddi shu mavzularga oid ${getCountInstruction(count)} YANGI savoldan iborat test tuz.
        Javobing QAT'IY faqat JSON formatda bo'lsin.
        Struktura: [{"question": "Yangi savol?", "options": ["A", "B", "C", "D"], "correct_index": 0}]`;

        const result = await model.generateContent(prompt);
        return extractJSON(result.response.text());
    } catch (error) { return null; }
}

module.exports = { explainMistakesBatch, generateQuizFromText, generateOptionsForQuestions, analyzeEssay, generateQuizFromImage, generateAdaptiveQuiz };