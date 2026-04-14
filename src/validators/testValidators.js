'use strict';
const { z } = require('zod');

// Fan nomi uchun qat'iy qoida
const SubjectSchema = z.string()
  .trim()
  .min(2, "⚠️ Fan nomi kamida 2 ta belgi bo'lishi kerak")
  .max(50, "⚠️ Fan nomi 50 ta belgidan oshmasligi kerak")
  .regex(/^[a-zA-ZА-Яа-яЎўҚқҒғҲҳ0-9\s\-]+$/, "⚠️ Fan nomida faqat harf, raqam va tire ruxsat etilgan (maxsus belgilarsiz)");

// Blok yoki Papka nomi uchun qoida
const BlockNameSchema = z.string()
  .trim()
  .min(1, "⚠️ Nom bo'sh bo'lishi mumkin emas")
  .max(40, "⚠️ Nom juda uzun (Maks: 40 ta belgi)");

// Foydalanuvchilar kiritadigan oddiy matnlarni tozalab (Escape) beruvchi yordamchi funksiya
// Bu Telegram Markdown qulab tushishidan 100% himoya qiladi
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Markdown uchun xavfsiz tozalovchi (faqat eng xavfli belgilarni olib tashlaydi)
function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

module.exports = { 
  SubjectSchema, 
  BlockNameSchema, 
  escapeHtml, 
  escapeMarkdown 
};