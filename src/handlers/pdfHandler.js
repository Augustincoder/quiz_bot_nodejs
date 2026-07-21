'use strict';

const mammoth = require('mammoth');
let pdfParse = null;
try {
  pdfParse = require('pdf-parse');
} catch (e) {
  // pdf-parse o'rnatilmagan bo'lsa graceful fallback
}
const { Markup } = require('telegraf');
const aiService = require('../services/aiService');
const dbService = require('../services/dbService');
const redisConnection = require('../services/redisService');

/**
 * Hujjat (.pdf yoki .docx) yuklanganda test tuzish
 */
async function onDocumentUpload(ctx) {
  try {
    const file = ctx.message?.document;
    if (!file) return;

    const mimeType = file.mime_type || '';
    const fileName = (file.file_name || '').toLowerCase();
    const isPdf = mimeType === 'application/pdf' || fileName.endsWith('.pdf');
    const isDocx =
      mimeType.includes('wordprocessingml') || fileName.endsWith('.docx');

    if (!isPdf && !isDocx) {
      return;
    }

    const userId = String(ctx.from.id);
    const isPremium = await dbService.isUserPremium(userId);
    const todayStr = new Date().toISOString().split('T')[0];
    const usageKey = `pdf_gen:${userId}:${todayStr}`;

    const rawCount = await redisConnection.get(usageKey);
    const todayCount = parseInt(rawCount || '0', 10);

    if (!isPremium && todayCount >= 1) {
      return ctx.reply(
        `⚠️ <b>Kunlik limitga yetdingiz!</b>\n\n` +
          `Free foydalanuvchilar kuniga 1 ta hujjatdan (PDF/DOCX) AI test yasa oladi.\n` +
          `💎 Cheksiz testlar yaratish uchun Premium obunani faollashtiring: /premium`,
        { parse_mode: 'HTML' }
      );
    }

    const waitingMsg = await ctx.reply(
      `⏳ <b>Hujjat yuklanmoqda va AI tomonidan tahlil qilinmoqda...</b>\n\n` +
        `<i>Bu jarayon 10-20 soniya vaqt oladi. Iltimos, kutib turing...</i>`,
      { parse_mode: 'HTML' }
    );

    const fileUrl = await ctx.telegram.getFileLink(file.file_id);
    const response = await fetch(fileUrl.href);
    if (!response.ok) {
      throw new Error(`Faylni yuklashda xatolik: status ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let extractedText = '';
    if (isPdf) {
      if (!pdfParse) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          waitingMsg.message_id,
          undefined,
          `⚠️ PDF tahlil moduli o'rnatilmadi. Iltimos, hozircha .docx (Word) formatidagi hujjat yuboring.`
        );
        return;
      }
      const pdfData = await pdfParse(buffer);
      extractedText = (pdfData.text || '').trim();
    } else {
      const docxData = await mammoth.extractRawText({ buffer });
      extractedText = (docxData.value || '').trim();
    }

    if (!extractedText || extractedText.length < 50) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitingMsg.message_id,
        undefined,
        `⚠️ Hujjat ichidan yetarlicha matn topilmadi. Iltimos, matnli PDF yoki DOCX fayl yuboring.`
      );
      return;
    }

    const cleanText = extractedText.slice(0, 8000);
    const questions = await aiService.generateQuizFromText(cleanText, 15);

    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitingMsg.message_id,
        undefined,
        `❌ Hujjat asosida test savollarini tuzib bo'lmadi. Matn juda murakkab yoki qisqa bo'lishi mumkin.`
      );
      return;
    }

    const title = file.file_name
      ? `PDF: ${file.file_name.slice(0, 30)}`
      : 'Hujjat Testi';
    const testId = await dbService.saveUserTest(
      userId,
      'ai_generated',
      title,
      questions
    );

    await redisConnection.incr(usageKey);
    await redisConnection.expire(usageKey, 86400);

    const successText =
      `✅ <b>Hujjat asosida ${questions.length} ta savoldan iborat test yaratildi!</b>\n\n` +
      `📌 <b>Test ID:</b> #${testId}\n` +
      `📄 <b>Manba:</b> ${file.file_name || 'Hujjat'}\n\n` +
      `<i>Testni hozir yechish uchun quyidagi tugmani bosing:</i>`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('▶️ Hozir boshlash', `ugc_start_${testId}`)],
      [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
    ]);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      waitingMsg.message_id,
      undefined,
      successText,
      {
        parse_mode: 'HTML',
        ...keyboard,
      }
    );
  } catch (error) {
    console.error('onDocumentUpload xatosi:', error.message);
    await ctx.reply(
      `❌ Hujjatni qayta ishlashda xatolik yuz berdi. Iltimos, fayl formatini tekshirib qayta urinib ko'ring.`
    );
  }
}

function register(bot) {
  bot.on('document', onDocumentUpload);
}

module.exports = {
  register,
  onDocumentUpload,
};
