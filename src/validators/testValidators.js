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
  if (!result.success) return result.error.issues?.[0]?.message || result.error.errors?.[0]?.message || result.error.message;
  return null;
}

function validateBlockName(name) {
  const result = BlockNameSchema.safeParse(name);
  if (!result.success) return result.error.issues?.[0]?.message || result.error.errors?.[0]?.message || result.error.message;
  return null;
}

// Markdown belgilarini xavfsiz holatga keltirish uchun
function escapeMarkdown(text) {
  if (!text) return '';
  return text.replace(/[_*`\[\\]/g, (m) => '\\' + m);
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

    // Convert 1-based indexing if LLM provided 1..rawOptions.length
    let targetIdx = numCorrect;
    if (targetIdx === rawOptions.length && targetIdx > 0 && targetIdx > 1) {
      targetIdx = targetIdx - 1;
    } else if (targetIdx < 0 || targetIdx >= rawOptions.length) {
      targetIdx = 0;
    }
    let targetOpt = String(rawOptions[targetIdx] ?? '').trim();
    if (targetOpt.length > 100) targetOpt = targetOpt.slice(0, 97) + '...';
    const targetCorrectText = targetOpt.toLowerCase();

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

    // Track correct answer text position in deduplicated options
    let resolvedCorrectIdx = options.findIndex((o) => o.toLowerCase() === targetCorrectText);
    if (resolvedCorrectIdx === -1 || resolvedCorrectIdx >= options.length) {
      resolvedCorrectIdx = 0;
    }

    const { safeTruncateExplanation } = require('../core/questionUtils');
    cleanList.push({
      question,
      options,
      correct_index: resolvedCorrectIdx,
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

/**
 * Extracts candidate question stem and options from malformed / invalid question text.
 * Integrates aiDocxHealer (healSmashedLine, detectFormattedKey, normalizeOptionPrefixes).
 *
 * @param {string} badText
 * @returns {{ questionText: string, options: Array<{ index: number, raw: string, text: string, cleanText: string, isCorrect: boolean }>, suggestedCorrectIdx: number }}
 */
function extractQuestionCandidates(badText) {
  if (!badText || typeof badText !== 'string') {
    return { questionText: '', options: [], suggestedCorrectIdx: -1 };
  }

  const aiDocxHealer = require('../services/aiDocxHealer');

  // 1. Try single-line smashed line recovery
  const smashed = aiDocxHealer.healSmashedLine(badText);
  if (smashed && smashed.success && Array.isArray(smashed.options) && smashed.options.length >= 2) {
    let suggestedIdx = smashed.options.findIndex((o) => o.isCorrect);
    if (suggestedIdx === -1) {
      const fmt = aiDocxHealer.detectFormattedKey(badText);
      if (fmt.correctIndex >= 0 && fmt.correctIndex < smashed.options.length) {
        suggestedIdx = fmt.correctIndex;
      }
    }

    return {
      questionText: smashed.questionText,
      options: smashed.options.map((opt, idx) => ({
        index: idx,
        raw: opt.raw || opt.cleanText,
        text: opt.cleanText || opt.raw,
        cleanText: opt.cleanText || opt.raw,
        isCorrect: idx === suggestedIdx || Boolean(opt.isCorrect),
      })),
      suggestedCorrectIdx: suggestedIdx,
    };
  }

  // 2. Multi-line candidate extraction
  const normalized = aiDocxHealer.normalizeOptionPrefixes(badText);
  const normalizedHtml = normalized
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/w:p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const cleanStr = aiDocxHealer.stripHtmlTags ? aiDocxHealer.stripHtmlTags(normalizedHtml) : normalizedHtml;
  const lines = cleanStr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lines.length < 2) {
    return { questionText: badText.trim(), options: [], suggestedCorrectIdx: -1 };
  }

  // Find first option marker index
  let firstOptIdx = 1;
  for (let i = 1; i < lines.length; i++) {
    if (/^[#*+]?\s*(?:[A-Za-z][\)\.]|\d+[\)\.]|[•\-\*]|\[[xX ]\])\s*/.test(lines[i])) {
      firstOptIdx = i;
      break;
    }
  }

  const questionStem = lines
    .slice(0, firstOptIdx)
    .join(' ')
    .replace(/^(\d+[\)\.]|№\s*\d+[\)\.]?)\s*/, '')
    .trim();

  const rawOpts = lines.slice(firstOptIdx);
  let suggestedCorrectIdx = -1;

  const options = rawOpts.map((line, idx) => {
    let isCorrect = /^[#*+]|\[[xX]\]/.test(line);
    let clean = line.replace(/^[#*+]?\s*(\[[xX ]\]\s*)?(?:[A-Za-z0-9][\)\.\-]|[•\-\*])\s*/, '').trim();
    if (/^[#*+]/.test(clean)) {
      isCorrect = true;
      clean = clean.replace(/^[#*+]\s*/, '').trim();
    }
    if (isCorrect && suggestedCorrectIdx === -1) {
      suggestedCorrectIdx = idx;
    }
    return {
      index: idx,
      raw: line,
      text: clean || line,
      cleanText: clean || line,
      isCorrect,
    };
  });

  if (suggestedCorrectIdx === -1) {
    const fmt = aiDocxHealer.detectFormattedKey(badText);
    if (fmt.correctIndex >= 0 && fmt.correctIndex < options.length) {
      suggestedCorrectIdx = fmt.correctIndex;
      if (options[suggestedCorrectIdx]) {
        options[suggestedCorrectIdx].isCorrect = true;
      }
    }
  }

  return {
    questionText: questionStem,
    options,
    suggestedCorrectIdx,
  };
}

module.exports = {
  SubjectSchema,
  BlockNameSchema,
  validateSubject,
  validateBlockName,
  escapeMarkdown,
  sanitizeQuizQuestions,
  validateQuizQuestion,
  extractQuestionCandidates,
};