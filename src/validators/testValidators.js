'use strict';
const { z } = require('zod');

// QATTIQ CHEKLOV OLIB TASHLANDI:
// Endi o'zbek kirill harflari, lotin harflari (o', g'), bo'sh joy (probel), 
// tire, nuqta, vergul, va tutuq belgisi (') ishlatilishiga ruxsat beriladi.
const nameRegex = /^[a-zA-Z0-9\s\-_.,'"\u0400-\u04FF\u0100-\u017F]+$/;

const SubjectSchema = z.string()
  .min(2, "Kamida 2 ta belgi bo'lishi kerak")
  .max(50, "Maksimal 50 ta belgi ruxsat etiladi")
  .regex(nameRegex, "Faqat harflar, raqamlar, probel va odatiy belgilar mumkin");

const BlockNameSchema = z.string()
  .min(1, "Kamida 1 ta belgi bo'lishi kerak")
  .max(50, "Maksimal 50 ta belgi ruxsat etiladi")
  .regex(nameRegex, "Faqat harflar, raqamlar, probel va odatiy belgilar mumkin");

function validateSubject(name) {
  const result = SubjectSchema.safeParse(name);
  if (!result.success) return result.error.errors[0].message;
  return null;
}

function validateBlockName(name) {
  const result = BlockNameSchema.safeParse(name);
  if (!result.success) return result.error.errors[0].message;
  return null;
}

// Markdown belgilarini xavfsiz holatga keltirish uchun
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/**
 * Strict sanitizer and validator for Quiz Questions (AI generation & imports)
 * Guarantees compliance with Telegram Poll limits:
 * - 2 <= options.length <= 10
 * - Deduplicates options case-insensitively
 * - Option text clamped to 100 chars, question clamped to 300 chars
 * - Handles 1-based indexing from AI (converts 1..N to 0..N-1)
 * - Clamps correct_index safely to 0 <= correct_index < options.length
 */
function sanitizeQuizQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  const cleanList = [];

  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object') continue;
    let question = String(item.question || '').trim();
    if (!question) continue;
    if (question.length > 300) question = question.slice(0, 297) + '...';

    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const seen = new Set();
    const options = [];

    const rawCorrect = item.correct_index !== undefined
      ? item.correct_index
      : (item.correct_option_id !== undefined ? item.correct_option_id : item.correct);

    let numCorrect = Number(rawCorrect);
    if (!Number.isFinite(numCorrect)) numCorrect = 0;

    for (let idx = 0; idx < rawOptions.length; idx++) {
      let opt = String(rawOptions[idx] || '').trim();
      if (!opt) continue;
      if (opt.length > 100) opt = opt.slice(0, 97) + '...';
      const lower = opt.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        options.push(opt);
      }
    }

    if (options.length < 2) continue; // Minimum 2 options required
    if (options.length > 10) options.length = 10;

    // Convert 1-based indexing if LLM provided 1..rawOptions.length
    if (numCorrect >= 1 && numCorrect === rawOptions.length && rawOptions.length <= options.length) {
      numCorrect = numCorrect - 1;
    } else if (numCorrect >= 1 && numCorrect >= options.length) {
      if (numCorrect - 1 < options.length) {
        numCorrect = numCorrect - 1;
      } else {
        numCorrect = 0;
      }
    }

    if (numCorrect < 0 || numCorrect >= options.length) {
      numCorrect = 0;
    }

    const { safeTruncateExplanation } = require('../core/questionUtils');
    cleanList.push({
      question,
      options,
      correct_index: numCorrect,
      explanation: item.explanation ? safeTruncateExplanation(String(item.explanation), 200) : undefined,
    });
  }
  return cleanList;
}

function validateQuizQuestion(q) {
  if (!q || typeof q !== 'object') return false;
  if (typeof q.question !== 'string' || !q.question.trim() || q.question.length > 300) return false;
  if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10) return false;
  for (const opt of q.options) {
    if (typeof opt !== 'string' || !opt.trim() || opt.length > 100) return false;
  }
  const set = new Set(q.options.map((o) => o.toLowerCase()));
  if (set.size !== q.options.length) return false;
  if (!Number.isInteger(q.correct_index) || q.correct_index < 0 || q.correct_index >= q.options.length) return false;
  return true;
}

module.exports = {
  SubjectSchema,
  BlockNameSchema,
  validateSubject,
  validateBlockName,
  escapeMarkdown,
  sanitizeQuizQuestions,
  validateQuizQuestion,
};