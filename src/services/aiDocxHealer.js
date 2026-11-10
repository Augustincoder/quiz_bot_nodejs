'use strict';

/**
 * AI Docx Smart Healer & Heuristic Multi-Error Recovery Engine
 *
 * Capabilities:
 * 1. healSmashedLine: Recovers single-paragraph squashed questions and options.
 * 2. detectFormattedKey: Detects bold, underline, mark, asterisks, plus signs and [x] keys.
 * 3. normalizeOptionPrefixes: Normalizes Cyrillic letters (А, В, С, Д, Е) to Latin.
 * 4. batchAutoHeal: Batch heals invalid questions using heuristics + optional Gemini AI fallback.
 */

const logger = require('../core/logger');

const CYRILLIC_TO_LATIN = {
  'А': 'A', 'а': 'a',
  'В': 'B', 'в': 'b',
  'С': 'C', 'с': 'c',
  'Д': 'D', 'д': 'd',
  'Е': 'E', 'е': 'e',
};

/**
 * Converts Cyrillic option prefixes (А, В, С, Д, Е) into Latin (A, B, C, D, E).
 * Only transforms letters appearing in prefix positions (e.g. "А)", "В.", "+С)", "#Д)").
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeOptionPrefixes(text) {
  if (!text || typeof text !== 'string') return '';

  return text.replace(
    /(^|[\n\r\s]|[#*+]|\[[xX ]\])\s*([АаВвСсДдЕе])(?=[\)\.\-]|(?:\s+[-–]))/gu,
    (match, prefix, cyrChar) => {
      const lat = CYRILLIC_TO_LATIN[cyrChar] || cyrChar;
      return `${prefix}${lat}`;
    }
  );
}

/**
 * Heals single-paragraph squashed questions and options into stem and options.
 *
 * Example:
 * "15. Axborot xavfsizligining 3 ta ustuni nima? A) Konfidensiallik B) Tezlik C) Parol D) Barcha javoblar"
 *
 * @param {string} rawText
 * @returns {{ success: boolean, questionText: string, options: Array<{ raw: string, cleanText: string, isCorrect: boolean }> }}
 */
function healSmashedLine(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { success: false, questionText: '', options: [] };
  }

  const normalized = normalizeOptionPrefixes(rawText.trim());

  // Split on whitespace preceding option markers:
  // - A), B., C-, etc.
  // - 1), 2), 3), 4)
  // - •, -, * bullet markers
  // - optional #, +, *, [x]
  const optionRegex = /\s+(?=(?:[#*+]|\[[xX]\])?\s*(?:[A-Da-d][\)\.\-]|[1-4][\)\.\-]|[•\-\*]\s+))/;
  const parts = normalized.split(optionRegex);

  if (!parts || parts.length < 3) {
    // Try secondary split without requiring trailing space for bullets
    const secondaryRegex = /\s+(?=(?:[#*+]|\[[xX]\])?\s*(?:[A-Da-d][\)\.\-]|[1-4][\)\.\-]))/;
    const parts2 = normalized.split(secondaryRegex);
    if (!parts2 || parts2.length < 3) {
      return { success: false, questionText: rawText.trim(), options: [] };
    }
    return buildHealedQuestion(parts2);
  }

  return buildHealedQuestion(parts);
}

/**
 * Helper to construct question text and options from split parts.
 */
function buildHealedQuestion(parts) {
  // Strip leading question number (e.g. "15. ", "15) ", "№15. ")
  let stem = parts[0].trim().replace(/^(\d+[\)\.]|№\s*\d+[\)\.]?)\s*/, '').trim();

  const options = [];
  for (let i = 1; i < parts.length; i++) {
    const raw = parts[i].trim();
    if (!raw) continue;

    let isCorrect = /^[#*+]|\[[xX]\]/i.test(raw);
    let clean = raw.replace(/^[#*+]?\s*(\[[xX ]\]\s*)?(?:[A-Za-z0-9][\)\.\-]|[•\-\*])\s*/, '').trim();

    if (/^[#*+]/.test(clean)) {
      isCorrect = true;
      clean = clean.replace(/^[#*+]\s*/, '').trim();
    }

    options.push({
      raw,
      cleanText: clean || raw,
      isCorrect,
    });
  }

  if (options.length < 2) {
    return { success: false, questionText: stem || parts[0], options: [] };
  }

  return {
    success: true,
    questionText: stem,
    options,
  };
}

/**
 * Detects author's intended correct answer key from HTML / XML formatting tags
 * (bold <b>, <strong>, underline <u>, <mark>, markdown *bold*, plus prefix +option, [x]).
 *
 * @param {string} htmlOrXml
 * @returns {{ correctIndex: number, confidence: number }}
 */
function detectFormattedKey(htmlOrXml) {
  if (!htmlOrXml || typeof htmlOrXml !== 'string') {
    return { correctIndex: -1, confidence: 0 };
  }

  const str = htmlOrXml.trim();

  // 1. Break into segments (paragraphs or lines)
  let segments = [];
  if (/<w:p[\s>]/i.test(str)) {
    segments = str.split(/<\/w:p>/i).filter(s => s.trim().length > 0);
  } else if (/<p[\s>]/i.test(str)) {
    segments = str.split(/<\/p>/i).filter(s => s.trim().length > 0);
  } else if (/<br\s*\/?>/i.test(str)) {
    segments = str.split(/<br\s*\/?>/i).filter(s => s.trim().length > 0);
  } else {
    segments = str.split(/\r?\n/).filter(s => s.trim().length > 0);
  }

  if (segments.length < 2) {
    // Check if single line has formatted parts
    return detectInlineFormattedKey(str);
  }

  // Determine which segment is the question vs options
  let firstOptIndex = 1;
  for (let i = 1; i < segments.length; i++) {
    const cleanText = stripHtmlTags(segments[i]).trim();
    if (/^[#*+]?\s*(?:[A-Za-z][\)\.]|\d+[\)\.]|[•\-\*]|\[[xX ]\])\s*/.test(cleanText)) {
      firstOptIndex = i;
      break;
    }
  }

  const optionSegments = segments.slice(firstOptIndex);
  let matchedIndex = -1;
  let highestConfidence = 0;

  optionSegments.forEach((seg, idx) => {
    let conf = 0;

    // Check for bold tag
    if (/<b[\s>]|<strong[\s>]|<w:b[\s\/>]|font-weight:\s*bold/i.test(seg)) {
      conf = Math.max(conf, 0.95);
    }

    // Check for underline tag
    if (/<u[\s>]|<w:u[\s\/>]|text-decoration:\s*underline/i.test(seg)) {
      conf = Math.max(conf, 0.95);
    }

    // Check for mark tag
    if (/<mark[\s>]/i.test(seg)) {
      conf = Math.max(conf, 0.9);
    }

    // Check for markdown bold (*bold* or **bold**)
    if (/\*\*[^*]+\*\*|\*[^*]+\*/.test(seg) && !/^\s*\*[\s\)]/.test(seg)) {
      conf = Math.max(conf, 0.85);
    }

    // Check for + prefix (+B) or +Option)
    const cleanSeg = stripHtmlTags(seg).trim();
    if (/^\s*\+\s*[A-Za-z0-9]?[\)\.]?/i.test(cleanSeg)) {
      conf = Math.max(conf, 0.95);
    }

    // Check for [x] or [X]
    if (/\[[xX]\]/.test(cleanSeg)) {
      conf = Math.max(conf, 0.98);
    }

    // Check for # prefix
    if (/^\s*#/.test(cleanSeg)) {
      conf = Math.max(conf, 0.99);
    }

    if (conf > highestConfidence) {
      highestConfidence = conf;
      matchedIndex = idx;
    }
  });

  if (matchedIndex >= 0 && highestConfidence > 0) {
    return { correctIndex: matchedIndex, confidence: highestConfidence };
  }

  return { correctIndex: -1, confidence: 0 };
}

/**
 * Fallback to check inline tags in a single line.
 */
function detectInlineFormattedKey(line) {
  const norm = normalizeOptionPrefixes(line);
  const parts = norm.split(/\s+(?=(?:[#*+]|\[[xX]\])?\s*(?:[A-Da-d][\)\.\-]|[1-4][\)\.\-]|[•\-\*]))/);

  if (parts.length > 2) {
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (/<b[\s>]|<strong[\s>]|<u[\s>]|\[[xX]\]|^\s*\+/.test(p)) {
        return { correctIndex: i - 1, confidence: 0.9 };
      }
    }
  }

  return { correctIndex: -1, confidence: 0 };
}

/**
 * Strips HTML tags from text.
 */
function stripHtmlTags(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, '').trim();
}

/**
 * Batch auto-heals an array of invalid question texts.
 * Uses heuristic recovery (smashed line, formatted keys, Cyrillic normalization)
 * and optional Gemini AI for ambiguous remaining entries.
 *
 * @param {Array<string|object>} invalidQuestions - Array of raw question strings or objects
 * @param {string} [geminiApiKey] - Optional Gemini API key
 * @returns {Promise<{ healed: Array<{ question: string, options: string[], correct_index: number }>, remainingInvalid: any[] }>}
 */
async function batchAutoHeal(invalidQuestions, geminiApiKey = null) {
  if (!Array.isArray(invalidQuestions) || invalidQuestions.length === 0) {
    return { healed: [], remainingInvalid: [] };
  }

  const healed = [];
  const remainingInvalid = [];

  for (const item of invalidQuestions) {
    const raw = typeof item === 'string' ? item : (item?.raw || item?.text || item?.question || '');
    if (!raw.trim()) continue;

    // Step 1: Normalize prefixes
    const normText = normalizeOptionPrefixes(raw);

    // Step 2: Try smashed line recovery
    const smashed = healSmashedLine(normText);
    if (smashed.success && smashed.options.length >= 2) {
      let correctIdx = smashed.options.findIndex(o => o.isCorrect);
      if (correctIdx === -1) {
        const detected = detectFormattedKey(raw);
        if (detected.correctIndex >= 0 && detected.correctIndex < smashed.options.length) {
          correctIdx = detected.correctIndex;
        }
      }
      if (correctIdx === -1) {
        // Default to first option in auto-heal
        correctIdx = 0;
      }

      healed.push({
        question: smashed.questionText,
        options: smashed.options.map(o => o.cleanText),
        correct_index: correctIdx,
      });
      continue;
    }

    // Step 3: Try multi-line recovery with detectFormattedKey
    const normalizedHtml = normText
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n');
    const cleanLines = stripHtmlTags(normalizedHtml).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (cleanLines.length >= 3) {
      const question = cleanLines[0].replace(/^(\d+[\)\.]|№\s*\d+[\)\.]?)\s*/, '').trim();
      const rawOptions = cleanLines.slice(1);
      const opts = [];
      let foundCorrect = -1;

      rawOptions.forEach((optLine, oIdx) => {
        let isCorrect = /^[#*+]|\[[xX]\]/.test(optLine);
        let optText = optLine.replace(/^[#*+]?\s*(\[[xX ]\]\s*)?(?:[A-Za-z0-9][\)\.\-]|[•\-\*])\s*/, '').trim();
        if (/^[#*+]/.test(optText)) {
          isCorrect = true;
          optText = optText.replace(/^[#*+]\s*/, '').trim();
        }
        if (isCorrect && foundCorrect === -1) {
          foundCorrect = oIdx;
        }
        opts.push(optText || optLine);
      });

      if (foundCorrect === -1) {
        const detected = detectFormattedKey(raw);
        if (detected.correctIndex >= 0 && detected.correctIndex < opts.length) {
          foundCorrect = detected.correctIndex;
        } else {
          foundCorrect = 0; // Default first option in auto-heal
        }
      }

      if (opts.length >= 2) {
        healed.push({
          question,
          options: opts,
          correct_index: foundCorrect,
        });
        continue;
      }
    }

    // Step 4: If heuristics failed, queue for AI repair or add to remaining
    remainingInvalid.push(item);
  }

  // Step 5: Optional Gemini AI fallback for remaining invalid items
  const apiKey = geminiApiKey || process.env.GEMINI_API_KEY;
  if (apiKey && remainingInvalid.length > 0) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-3.1-flash-lite-preview' });

      const textsToFix = remainingInvalid.map(item =>
        typeof item === 'string' ? item : (item.raw || item.text || '')
      ).filter(Boolean);

      if (textsToFix.length > 0) {
        const prompt = `Quyidagi buzilgan yoki xato formatlangan test savollarini tuzatib, JSON massiv ko'rinishida qaytar:
Format:
[
  {
    "question": "Savol matni?",
    "options": ["To'g'ri javob", "Noto'g'ri 1", "Noto'g'ri 2", "Noto'g'ri 3"],
    "correct_index": 0
  }
]

Buzilgan matnlar:
${textsToFix.join('\n---\n')}`;

        const res = await model.generateContent(prompt);
        const text = res?.response?.text?.() || '';
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed)) {
            parsed.forEach(q => {
              if (q && q.question && Array.isArray(q.options) && q.options.length >= 2) {
                healed.push({
                  question: String(q.question).trim(),
                  options: q.options.map(o => String(o).trim()),
                  correct_index: typeof q.correct_index === 'number' ? q.correct_index : 0,
                });
              }
            });
            // Clear remaining that were resolved by AI
            remainingInvalid.length = 0;
          }
        }
      }
    } catch (aiErr) {
      logger.warn('[aiDocxHealer] Gemini batch repair failed or skipped: ' + (aiErr?.message || aiErr));
    }
  }

  return {
    healed,
    remainingInvalid,
  };
}

module.exports = {
  healSmashedLine,
  detectFormattedKey,
  normalizeOptionPrefixes,
  batchAutoHeal,
  stripHtmlTags,
};
