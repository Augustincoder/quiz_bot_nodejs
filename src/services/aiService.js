'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GEMINI_API_KEY }     = require('../config/config');
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const logger                 = require('../core/logger');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite-preview" });
const fileManager = new GoogleAIFileManager(GEMINI_API_KEY);

// ============================================
// 📊 AI SERVICE INTERNAL RATE LIMITING
// ============================================

// Global AI service usage tracker
let aiServiceUsage = {
    daily: {
        count: 0,
        date: new Date().toDateString(),
        maxDaily: 500 // Kunlik maksimal AI so'rovlar
    },
    monthly: {
        count: 0,
        month: new Date().getMonth(),
        year: new Date().getFullYear(),
        maxMonthly: 1000 // Oylik limit
    },
    // Har bir funksiya uchun alohida counter
    byFunction: {
        explainMistakes: 100,
        generateQuiz: 100,
        analyzeEssay: 100,
        generateFromImage: 100,
        adaptiveQuiz: 100
    }
};

// Per-function limits (ixtiyoriy - funksiya tipiga qarab limit)
const FUNCTION_LIMITS = {
    explainMistakes: { daily: 100 },
    generateQuiz: { daily: 100 },
    analyzeEssay: { daily: 100 },
    generateFromImage: { daily: 100 }, // Rasmdan test - ko'proq resurs talab qiladi
    adaptiveQuiz: { daily: 100 }
};

/**
 * AI Service ichki limitni tekshirish
 * @param {string} functionName - Funksiya nomi
 * @returns {Object} { allowed: boolean, reason?: string }
 */
function checkAIServiceLimit(functionName) {
    const today = new Date().toDateString();
    const currentMonth = new Date().getMonth();
    const currentYear = new Date().getFullYear();

    // Daily reset
    if (aiServiceUsage.daily.date !== today) {
        aiServiceUsage.daily = {
            count: 0,
            date: today,
            maxDaily: aiServiceUsage.daily.maxDaily // 500 o'rniga o'zgarib qolmasligi uchun
        };
        // Har bir funksiya counterini ham reset qilamiz
        Object.keys(aiServiceUsage.byFunction).forEach(key => {
            aiServiceUsage.byFunction[key] = 0;
        });
    }

    // Monthly reset
    if (aiServiceUsage.monthly.month !== currentMonth || aiServiceUsage.monthly.year !== currentYear) {
        aiServiceUsage.monthly = {
            count: 0,
            month: currentMonth,
            year: currentYear,
            maxMonthly: aiServiceUsage.monthly.maxMonthly
        };
    }

    // Global daily limit check
    if (aiServiceUsage.daily.count >= aiServiceUsage.daily.maxDaily) {
        logger.warn('ai:limit_reached', { type: 'daily_global', count: aiServiceUsage.daily.count });
        return { 
            allowed: false, 
            reason: 'daily_limit',
            message: '⚠️ AI xizmati kunlik limitga yetdi. Ertaga qayta urinib ko\'ring.'
        };
    }

    // Global monthly limit check
    if (aiServiceUsage.monthly.count >= aiServiceUsage.monthly.maxMonthly) {
        logger.error('ai:limit_reached', { type: 'monthly_global', count: aiServiceUsage.monthly.count });
        return { 
            allowed: false, 
            reason: 'monthly_limit',
            message: '⚠️ AI xizmati oylik limitga yetdi. Admin bilan bog\'laning: @AvazovM'
        };
    }

    // Per-function limit check (agar mavjud bo'lsa)
    if (FUNCTION_LIMITS[functionName]) {
        const funcLimit = FUNCTION_LIMITS[functionName];
        const funcCount = aiServiceUsage.byFunction[functionName] || 0;

        if (funcLimit.daily && funcCount >= funcLimit.daily) {
            logger.warn('ai:function_limit', { function: functionName, count: funcCount });
            return {
                allowed: false,
                reason: 'function_daily_limit',
                message: `⚠️ "${functionName}" funksiyasi kunlik limitga yetdi.`
            };
        }
    }

    return { allowed: true };
}

/**
 * AI so'rovni ro'yxatdan o'tkazish
 */
function incrementAIUsage(functionName, success = true) {
    if (success) {
        aiServiceUsage.daily.count++;
        aiServiceUsage.monthly.count++;
        
        if (functionName && aiServiceUsage.byFunction.hasOwnProperty(functionName)) {
            aiServiceUsage.byFunction[functionName]++;
        }
        
        logger.info('ai:usage_increment', {
            function: functionName,
            dailyTotal: aiServiceUsage.daily.count,
            monthlyTotal: aiServiceUsage.monthly.count
        });
    }
}

/**
 * AI usage statistikasini olish (admin uchun)
 */
function getAIUsageStats() {
    return {
        daily: {
            used: aiServiceUsage.daily.count,
            limit: aiServiceUsage.daily.maxDaily,
            remaining: aiServiceUsage.daily.maxDaily - aiServiceUsage.daily.count,
            date: aiServiceUsage.daily.date
        },
        monthly: {
            used: aiServiceUsage.monthly.count,
            limit: aiServiceUsage.monthly.maxMonthly,
            remaining: aiServiceUsage.monthly.maxMonthly - aiServiceUsage.monthly.count,
            month: aiServiceUsage.monthly.month + 1,
            year: aiServiceUsage.monthly.year
        },
        byFunction: aiServiceUsage.byFunction
    };
}

// ============================================
// 🛠 UTILITY FUNCTIONS
// ============================================

// AI matn ichidan JSON qismini tozalab oluvchi
function extractJSON(text) {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) { 
        try { 
            return JSON.parse(match[0]); 
        } catch (e) { 
            logger.error('ai:json_parse_error', { error: e.message });
            return null; 
        } 
    }
    return null;
}

// AI dan test yaratishda miqdor ko'rsatish uchun yordamchi
function getCountInstruction(count) {
    return count === 'auto' || !count 
        ? "Matn hajmiga qarab, eng muhim ma'lumotlar asosida munosib miqdorda (masalan 5-15 ta o'rtasida)" 
        : `Aynan ${count} ta`;
}

// AI matnini Telegram HTML parse_mode ga moslab tozalash
function sanitizeTelegramHtml(text) {
    if (!text) return text;
    // Barcha xavfli belgilarni escape qilamiz
    let sanitized = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    
    // Ruxsat etilgan teglarni tiklaymiz
    const tags = ['b', 'i', 'strong', 'em', 'code', 's', 'strike', 'del', 'u', 'pre'];
    tags.forEach(tag => {
        const regexOpen = new RegExp(`&lt;${tag}&gt;`, 'gi');
        const regexClose = new RegExp(`&lt;\\/${tag}&gt;`, 'gi');
        sanitized = sanitized.replace(regexOpen, `<${tag}>`).replace(regexClose, `</${tag}>`);
    });
    
    // Markdown yulduzchalarni HTML ga o'giramiz
    sanitized = sanitized.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
    sanitized = sanitized.replace(/\*/g, ''); // Eski kod mantiqini saqlash uchun
    
    return sanitized;
}

// ============================================
// 🤖 AI SERVICE FUNCTIONS (with rate limiting)
// ============================================

/**
 * 1. Test xatolarini tahlil qilish (HTML formatda)
 */
async function explainMistakesBatch(mistakes) {
    // 🔒 Ichki limit tekshiruvi
    const limitCheck = checkAIServiceLimit('explainMistakes');
    if (!limitCheck.allowed) {
        logger.warn('ai:request_blocked', { function: 'explainMistakes', reason: limitCheck.reason });
        return limitCheck.message || "⚠️ Xizmat vaqtincha mavjud emas.";
    }

    if (!GEMINI_API_KEY) {
        logger.error('ai:no_api_key');
        return "⚠️ API kalit kiritilmagan.";
    }

    try {
        const targetMistakes = mistakes.slice(0, 5); 
        let prompt = `Sen universitet o'qituvchisisan. Talaba testda quyidagi xatolarni qildi. Har bir xato uchun to'g'ri javobni tushuntirib ber.
        DIQQAT! Javobni FAKAT Telegram HTML formatida yoz! (Qalin qilish uchun <b>matn</b>, qiya uchun <i>matn</i> ishlating. Hech qanday ** yulduzcha yoki _ ishlatma!)\n\n`;
        
        targetMistakes.forEach((m, i) => { 
            prompt += `🔹 <b>${i+1}-Savol:</b> ${m.question}\n✅ To'g'ri: ${m.correct_ans}\n❌ Talaba: ${m.wrong_ans}\n\n`; 
        });
        
        if (mistakes.length > 5) prompt += `\n<i>(Faqat birinchi 5 ta asosiy xatoni tahlil qilindi)</i>`;

        const result = await model.generateContent(prompt);
        
        // ✅ Muvaffaqiyatli - usageni oshiramiz
        incrementAIUsage('explainMistakes', true);
        
        return sanitizeTelegramHtml(result.response.text());
    } catch (error) {
        logger.error('ai:explainMistakes_error', { error: error.message });
        incrementAIUsage('explainMistakes', false);
        return "🤖 Kechirasiz, tahlil qilishda xatolik yuz berdi.";
    }
}

/**
 * 2. Matndan test yaratish
 */
async function generateQuizFromText(text, count) {
    const limitCheck = checkAIServiceLimit('generateQuiz');
    if (!limitCheck.allowed) {
        logger.warn('ai:request_blocked', { function: 'generateQuiz', reason: limitCheck.reason });
        return null;
    }

    try {
        const prompt = `Matn asosida ${getCountInstruction(count)} variantli test tuz. Faqat JSON formatda qaytar. Boshqa so'z yozma.
        Struktura: [{"question": "Savol?", "options": ["A", "B", "C", "D"], "correct_index": 0}]\n\nMatn:\n${text}`;
        
        const result = await model.generateContent(prompt);
        const questions = extractJSON(result.response.text());
        
        incrementAIUsage('generateQuiz', questions !== null);
        logger.info('ai:generate', { type: 'text', count: questions?.length || 0 });
        
        return questions;
    } catch (e) { 
        logger.error('ai:generateQuiz_error', { error: e.message });
        incrementAIUsage('generateQuiz', false);
        return null; 
    }
}

/**
 * 3. Savollarga javoblar yaratish
 */
async function generateOptionsForQuestions(questionsText) {
    const limitCheck = checkAIServiceLimit('generateQuiz'); // Bir xil kategoriya
    if (!limitCheck.allowed) {
        return null;
    }

    try {
        const prompt = `Savollar ro'yxatiga 1 to'g'ri va 3 xato variant tuz. Faqat JSON formatda qaytar.
        Struktura: [{"question": "Savol?", "options": ["A", "B", "C", "D"], "correct_index": 0}]\n\nSavollar:\n${questionsText}`;
        
        const result = await model.generateContent(prompt);
        const questions = extractJSON(result.response.text());
        
        incrementAIUsage('generateQuiz', questions !== null);
        
        return questions;
    } catch (e) { 
        logger.error('ai:generateOptions_error', { error: e.message });
        incrementAIUsage('generateQuiz', false);
        return null; 
    }
}

/**
 * 4. Yozma ish (Insho/Tarjima) tahlili
 */
async function analyzeEssay(text) {
    const limitCheck = checkAIServiceLimit('analyzeEssay');
    if (!limitCheck.allowed) {
        return limitCheck.message || "⚠️ Xizmat vaqtincha mavjud emas.";
    }

    try {
        const prompt = `Sen til o'qituvchisisan. O'quvchi senga matn yubordi. Grammatik, mantiqiy xatolarni top, tushuntir va 100 ballik tizimda bahola.
        DIQQAT! Javobni FAKAT Telegram HTML formatida yoz! (Qalin uchun <b>matn</b>, qiya uchun <i>matn</i> ishlating. Hech qanday yulduzcha ** ishlatma!)\n\nO'quvchi matni:\n"${text}"`;

        const result = await model.generateContent(prompt);
        
        incrementAIUsage('analyzeEssay', true);
        
        return sanitizeTelegramHtml(result.response.text());
    } catch (error) {
        logger.error('ai:analyzeEssay_error', { error: error.message });
        incrementAIUsage('analyzeEssay', false);
        return "🤖 Kechirasiz, matnni tahlil qilishda xatolik yuz berdi.";
    }
}

/**
 * 5. Rasmdan test yasash (Gemini Vision)
 */
async function generateQuizFromImage(localFilePath, mimeType, count) {
    const limitCheck = checkAIServiceLimit('generateFromImage');
    if (!limitCheck.allowed) {
        logger.warn('ai:image_request_blocked', { reason: limitCheck.reason });
        return null;
    }

    try {
        const uploadResponse = await fileManager.uploadFile(localFilePath, { 
            mimeType: mimeType, 
            displayName: "Test Image" 
        });
        
        const prompt = `Sen professional o'qituvchisan. Ushbu rasmdagi matnni diqqat bilan o'qi va tahlil qil.
        Shu rasmdagi ma'lumotlar asosida ${getCountInstruction(count)} variantli test tuz.
        Javobing QAT'IY ravishda faqat quyidagi JSON formatida bo'lishi shart. Boshqa izoh yozma!
        Struktura: [{"question": "Savol matni?", "options": ["A", "B", "C", "D"], "correct_index": 0}]`;
        
        let questions = null;
        try {
            const result = await model.generateContent([
                { fileData: { mimeType: uploadResponse.file.mimeType, fileUri: uploadResponse.file.uri } },
                { text: prompt }
            ]);
            
            questions = extractJSON(result.response.text());
        } finally {
            // Memory/Storage leak ni oldini olish uchun faylni Google API'dan o'chiramiz
            await fileManager.deleteFile(uploadResponse.file.name).catch(e => logger.error('ai:file_delete_error', { error: e.message }));
        }
        
        incrementAIUsage('generateFromImage', questions !== null);
        logger.info('ai:generate', { type: 'image', count: questions?.length || 0 });
        
        return questions;
    } catch (error) { 
        logger.error('ai:generateFromImage_error', { error: error.message });
        incrementAIUsage('generateFromImage', false);
        return null; 
    }
}

/**
 * 6. Adaptiv (Shaxsiy) test
 */
async function generateAdaptiveQuiz(subject, mistakes, count) {
    const limitCheck = checkAIServiceLimit('adaptiveQuiz');
    if (!limitCheck.allowed) {
        return null;
    }

    try {
        const targetMistakes = mistakes.slice(0, 20); 
        let prompt = `Sen mehribon o'qituvchisan. O'quvchi "${subject}" fanidan quyidagi savollarda xato qildi:\n\n`;
        
        targetMistakes.forEach((m, i) => { 
            prompt += `❌ ${i+1}: ${m.question} (To'g'ri: ${m.correct_ans})\n`; 
        });
        
        prompt += `\nVazifang: Shu xatolar mavzusini tahlil qil va o'quvchi shularni yaxshilashi uchun xuddi shu mavzularga oid ${getCountInstruction(count)} YANGI savoldan iborat test tuz.
        Javobing QAT'IY faqat JSON formatda bo'lsin.
        Struktura: [{"question": "Yangi savol?", "options": ["A", "B", "C", "D"], "correct_index": 0}]`;

        const result = await model.generateContent(prompt);
        const questions = extractJSON(result.response.text());
        
        incrementAIUsage('adaptiveQuiz', questions !== null);
        logger.info('ai:generate', { type: 'adaptive', count: questions?.length || 0 });
        
        return questions;
    } catch (error) { 
        logger.error('ai:adaptiveQuiz_error', { error: error.message });
        incrementAIUsage('adaptiveQuiz', false);
        return null; 
    }
}

// ============================================
// 📤 EXPORTS
// ============================================

module.exports = { 
    explainMistakesBatch, 
    generateQuizFromText, 
    generateOptionsForQuestions, 
    analyzeEssay, 
    generateQuizFromImage, 
    generateAdaptiveQuiz,
    
    // Admin funksiyalari
    getAIUsageStats,
    
    // Ichki funksiyalar (agar boshqa joydan kerak bo'lsa)
    checkAIServiceLimit,
    incrementAIUsage
};