'use strict';

/**
 * Smart Question Parser & Deduplication Engine (v2 - Deep Architecture)
 * 
 * Provides:
 * 1. Adaptive separator hierarchy detection (3+, 4+, 5+ arbitrary length `+`, `=`, `-`).
 * 2. Mixed/noisy delimiter tolerance (3, 4, 5+ separators mixed in the same file).
 * 3. Fallback for un-delimited numbered questions (`1. `, `2) `), even without blank lines.
 * 4. Inline option splitting (`A) ... B) ... C) ... D) ...` on a single line).
 * 5. Multi-line question & option preservation.
 * 6. Flexible correct answer detection (#, *, HEMIS `+`, trailing "Javob: B" / "# A", mode='first').
 * 7. High-performance Duplicate Question Detection (Exact match $O(1)$ + Bucketed Fuzzy Levenshtein >= 88%).
 * 8. Telegram Poll boundary conformity (2..10 options, max 300 chars question, max 100 chars option).
 */

const logger = require('./logger');
const { getLevenshteinDistance } = require('./utils');

/**
 * Normalizes question text for robust deduplication & comparison.
 * Strips Uzbek apostrophes, punctuation, excessive spaces, and converts to lowercase.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizeQuestionText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    // Standardize Uzbek/Russian apostrophes: ‘, ’, `, ՚, ʼ, ' -> '
    .replace(/[\u2018\u2019\u02BC\u0060\u00B4\u201B]/g, "'")
    // Remove leading numbering (e.g., "1. ", "25) ", "Savol 1: ", "1 - ")
    // Only strip when accompanied by delimiter symbols like ., ), :, -
    .replace(/^\s*(?:savol\s*\d+\s*[\:\.\)\-]\s*|\d+[\:\.\)\-]\s*)/i, '')
    // Remove all punctuation and symbols except essential alphanumeric & apostrophe
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    // Collapse all whitespace sequences into a single space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Creates a normalized signature for options to cross-verify duplicate questions.
 *
 * @param {string[]} options
 * @returns {string}
 */
function getOptionsSignature(options) {
  if (!Array.isArray(options)) return '';
  return options
    .map(opt => normalizeQuestionText(opt))
    .filter(Boolean)
    .sort()
    .join('|');
}

/**
 * Calculates string similarity between 0.0 (completely different) and 1.0 (identical).
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function calculateSimilarity(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = getLevenshteinDistance(a, b);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Detects multiple options written on the same line (e.g., "A) 1441   B) 1483   C) 1501   D) 1336")
 * and splits them into discrete lines.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function expandInlineOptions(lines) {
  const result = [];
  const inlinePattern = /(?:^|\s{2,}|\t|\s+)(?:([#*+]?)\s*(?:[a-zA-Z][\)\.]|\d+\)|\d+\.(?!\d))\s+)/g;

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;

    const matches = [...trimmed.matchAll(inlinePattern)];
    if (matches.length >= 2) {
      // Multiple options detected on one line!
      for (let i = 0; i < matches.length; i++) {
        const start = matches[i].index + (matches[i][0].startsWith(' ') || matches[i][0].startsWith('\t') ? 1 : 0);
        const end = (i + 1 < matches.length) ? matches[i + 1].index : trimmed.length;
        const optSlice = trimmed.substring(start, end).trim();
        if (optSlice) result.push(optSlice);
      }
    } else {
      result.push(trimmed);
    }
  }

  return result;
}

/**
 * Scans text to adaptively detect delimiters for questions and options.
 * Counts 3+ sequences of `+`, `=`, `-` and determines hierarchy.
 *
 * @param {string} text
 * @returns {{ questionDelimiter: RegExp|null, optionDelimiter: RegExp|null, type: string }}
 */
function detectSeparatorsHierarchy(text) {
  if (!text || typeof text !== 'string') {
    return { questionDelimiter: null, optionDelimiter: null, type: 'EMPTY' };
  }

  // Count 3+ sequences of `+` and `=`
  const plusMatches = text.match(/\+{3,}/g) || [];
  const equalMatches = text.match(/={3,}/g) || [];
  const dashMatches = text.match(/(?:^|\r?\n)\s*-{3,}\s*(?:\r?\n|$)/gm) || [];

  const plusCount = plusMatches.length;
  const equalCount = equalMatches.length;
  const dashCount = dashMatches.length;

  // Case 1: Both `+` and `=` exist (The standard Uzbek test format)
  if (plusCount > 0 && equalCount > 0) {
    if (plusCount <= equalCount) {
      // Standard: `+++++` separates questions, `=====` separates options
      return {
        questionDelimiter: /\+{3,}/,
        optionDelimiter: /={3,}/,
        type: 'PLUS_QUESTION_EQUAL_OPTION',
      };
    } else {
      // Inverted: `=====` separates questions, `+++++` separates options
      return {
        questionDelimiter: /={3,}/,
        optionDelimiter: /\+{3,}/,
        type: 'EQUAL_QUESTION_PLUS_OPTION',
      };
    }
  }

  // Case 2: Only `+` delimiters exist
  if (plusCount > 0) {
    return {
      questionDelimiter: /\+{3,}/,
      optionDelimiter: null,
      type: 'PLUS_ONLY',
    };
  }

  // Case 3: Only `=` delimiters exist
  if (equalCount > 0) {
    return {
      questionDelimiter: /={3,}/,
      optionDelimiter: null,
      type: 'EQUAL_ONLY',
    };
  }

  // Case 4: Dash `---` delimiters
  if (dashCount > 0) {
    return {
      questionDelimiter: /(?:^|\r?\n)\s*-{3,}\s*(?:\r?\n|$)/,
      optionDelimiter: null,
      type: 'DASH_ONLY',
    };
  }

  // Case 5: No explicit delimiters found
  return {
    questionDelimiter: null,
    optionDelimiter: null,
    type: 'NO_DELIMITERS',
  };
}

/**
 * Splits text into blocks when no explicit delimiters are provided.
 * Uses numbered questions `1. `, `2) ` or double blank lines.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitBlocksByNumberingOrLines(text) {
  // Check if text has numbered items at start of lines (e.g. "1. ", "2) ", "1-")
  const numberedPattern = /(?:\r?\n|^)(?=\s*\d+[\)\.\-]\s+)/g;
  const numberedMatches = text.match(numberedPattern);

  if (numberedMatches && numberedMatches.length >= 2) {
    // Numbered questions detected!
    const parts = text.split(/(?:\r?\n|^)(?=\s*\d+[\)\.\-]\s+)/);
    return parts.map(p => p.trim()).filter(Boolean);
  }

  // Fallback to double blank lines
  return text.split(/\r?\n\s*\r?\n+/).map(p => p.trim()).filter(Boolean);
}

/**
 * Parses raw text into questions and answers with adaptive tolerance and deep deduplication.
 *
 * @param {string} text - Raw input text from docx or user input
 * @param {string} mode - 'hash' (default) or 'first'
 * @param {object} [options] - Options { allowDuplicates: false, fuzzyThreshold: 0.88 }
 * @returns {{ valid: Array, invalid: Array, duplicates: Array, stats: object }}
 */
function parseAdaptiveQuestions(text, mode = 'hash', options = {}) {
  const allowDuplicates = options.allowDuplicates === true;
  const fuzzyThreshold = typeof options.fuzzyThreshold === 'number' ? options.fuzzyThreshold : 0.88;

  const valid = [];
  const invalid = [];
  const duplicates = [];

  if (!text || typeof text !== 'string' || !text.trim()) {
    return {
      valid,
      invalid,
      duplicates,
      stats: { totalFound: 0, validCount: 0, invalidCount: 0, duplicateCount: 0, hierarchyType: 'NONE' },
    };
  }

  const hierarchy = detectSeparatorsHierarchy(text);
  let rawBlocks = [];

  if (hierarchy.questionDelimiter) {
    rawBlocks = text.split(hierarchy.questionDelimiter);
  } else {
    rawBlocks = splitBlocksByNumberingOrLines(text);
  }

  // Filter empty blocks
  rawBlocks = rawBlocks.map(b => b.trim()).filter(Boolean);

  // Can we use `+` as correct option marker?
  // Yes, if optionDelimiter is NOT `+` (e.g. in HEMIS where +Option indicates correct answer)
  const canUsePlusAsAnswerKey = hierarchy.optionDelimiter !== /\+{3,}/ && hierarchy.type !== 'EQUAL_QUESTION_PLUS_OPTION';

  for (let bIdx = 0; bIdx < rawBlocks.length; bIdx++) {
    const block = rawBlocks[bIdx];
    let parts = [];

    if (hierarchy.optionDelimiter && hierarchy.optionDelimiter.test(block)) {
      parts = block.split(hierarchy.optionDelimiter);
    } else {
      parts = block.split(/\r?\n/);
    }

    parts = parts.map(p => p.trim()).filter(Boolean);

    // If options are inline (e.g. A) ... B) ...), expand them
    if (parts.length > 1) {
      const qLine = parts[0];
      const optLines = parts.slice(1);
      const expandedOpts = expandInlineOptions(optLines);
      parts = [qLine, ...expandedOpts];
    } else if (parts.length === 1) {
      // Possible single block with inline question + options
      const expanded = expandInlineOptions(block.split(/\r?\n/));
      if (expanded.length >= 2) {
        parts = expanded;
      }
    }

    if (parts.length < 2) {
      // If block is just document title at index 0 (e.g. "Testlar bazasi"), ignore it silently
      if (bIdx === 0 && rawBlocks.length > 1 && !/^[#*+]/.test(block) && !/\d+[\)\.]/.test(block)) {
        continue;
      }
      invalid.push(block.trim());
      continue;
    }

    // Determine where options begin (supports multi-line questions)
    let firstOptIdx = 1;
    const hasExplicitOptionDelimiter = hierarchy.optionDelimiter && hierarchy.optionDelimiter.test(block);

    if (!hasExplicitOptionDelimiter) {
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        // Checks if line begins with a known option marker: A), A., a), 1)
        if (/^[#*]?\s*(?:[a-zA-Z][\)\.]|\d+\))\s*/.test(p)) {
          firstOptIdx = i;
          break;
        }
      }
    }

    const questionLines = parts.slice(0, firstOptIdx);
    let questionText = questionLines.join('\n').replace(/^\s*(?:savol\s*\d+\s*[\:\.\)\-]\s*|\d+[\:\.\)\-]\s*)/i, '').trim();

    if (!questionText) {
      invalid.push(block.trim());
      continue;
    }

    // Check if the very last line is an explicit answer key (e.g., "Javob: A", "To'g'ri javob: B", "# A", "# 2")
    let explicitCorrectIdx = -1;
    if (parts.length - 1 > firstOptIdx) {
      const lastLine = parts[parts.length - 1].trim();
      const optionsBefore = parts.slice(firstOptIdx, parts.length - 1);
      const optionsHavePrefixes = optionsBefore.length >= 2 &&
        optionsBefore.every(line => /^(?:[a-zA-Z][\)\.]|\d+[\)\.])\s*/.test(line.trim()) && !/^[#*+]/.test(line.trim()));
      const noHashBefore = optionsBefore.length >= 2 &&
        optionsBefore.every(line => !/^[#*+]/.test(line.trim()));

      const trailingWordMatch = lastLine.match(/^[#*+]?\s*(?:to'?g'?ri\s+javob|javob|kalit)\s*[:=-]?\s*([a-jA-J1-9])$/i);
      const isTrailingHashKey = noHashBefore && (
        optionsHavePrefixes ||
        optionsBefore.length >= 4
      );
      const trailingHashMatch = isTrailingHashKey && lastLine.match(/^[#*]\s*([a-jA-J1-9])$/i);

      const trailingAnswerMatch = trailingWordMatch || trailingHashMatch;
      if (trailingAnswerMatch) {
        const keyChar = trailingAnswerMatch[1].toUpperCase();
        if (/^[1-9]$/.test(keyChar)) {
          explicitCorrectIdx = parseInt(keyChar, 10) - 1;
        } else {
          explicitCorrectIdx = keyChar.charCodeAt(0) - 65; // A->0, B->1, C->2, ...
        }
        parts.pop(); // Remove key line from options
      }
    }

    const opts = [];
    let correctIdx = -1;

    for (let i = firstOptIdx; i < parts.length; i++) {
      let optText = parts[i].trim();
      let isCorrect = false;

      // 1. Check leading # or * or HEMIS + (e.g., "# A) Text", "*Text", "+Toshkent", "+A) Toshkent")
      if (mode === 'hash') {
        if (optText.startsWith('#') || optText.startsWith('*')) {
          isCorrect = true;
          optText = optText.substring(1).trim();
        } else if (canUsePlusAsAnswerKey && optText.startsWith('+')) {
          isCorrect = true;
          optText = optText.substring(1).trim();
        }
      }

      // 2. Strip standard option prefixes: "A)", "B.", "a)", "1)" (Preserve decimal numbers like "1.5")
      optText = optText.replace(/^(?:[a-zA-Z][\)\.]|\d+\))\s*/, '').trim();

      // 3. Check #, *, + placed immediately after prefix (e.g., "A) #Text", "A) +Text")
      if (mode === 'hash' && !isCorrect) {
        if (optText.startsWith('#') || optText.startsWith('*')) {
          isCorrect = true;
          optText = optText.substring(1).trim();
        } else if (canUsePlusAsAnswerKey && optText.startsWith('+')) {
          isCorrect = true;
          optText = optText.substring(1).trim();
        }
      }

      // 4. Check trailing #, *, + (e.g., "A) Text #", "Text +")
      if (mode === 'hash' && !isCorrect) {
        if (optText.endsWith('#') || optText.endsWith('*')) {
          isCorrect = true;
          optText = optText.slice(0, -1).trim();
        } else if (canUsePlusAsAnswerKey && optText.endsWith('+')) {
          isCorrect = true;
          optText = optText.slice(0, -1).trim();
        }
      }

      // Mode 'first': the very first option is marked correct
      if (mode === 'first' && i === firstOptIdx) {
        isCorrect = true;
      }

      if (!optText) continue;
      opts.push(optText);
      if (isCorrect) {
        correctIdx = opts.length - 1;
      }
    }

    // Apply explicit trailing key if valid
    if (explicitCorrectIdx >= 0 && explicitCorrectIdx < opts.length) {
      correctIdx = explicitCorrectIdx;
    }

    // Ensure option uniqueness (Telegram Poll requirement)
    const seenOpts = new Set();
    const uniqueOpts = [];
    opts.forEach((opt, idx) => {
      let candidate = String(opt || '').trim();
      if (!candidate) candidate = `Variant ${idx + 1}`;
      if (seenOpts.has(candidate.toLowerCase())) {
        candidate = `${candidate} (${idx + 1})`;
      }
      seenOpts.add(candidate.toLowerCase());
      uniqueOpts.push(candidate);
    });

    // Bound options to Telegram Poll limit of 10
    if (uniqueOpts.length > 10) {
      if (correctIdx >= 10) {
        const correctOpt = uniqueOpts[correctIdx];
        uniqueOpts.length = 10;
        uniqueOpts[9] = correctOpt;
        correctIdx = 9;
      } else {
        uniqueOpts.length = 10;
      }
    }

    if (correctIdx !== -1 && uniqueOpts.length >= 2) {
      valid.push({
        question: questionText,
        options: uniqueOpts,
        correct_index: correctIdx,
        _blockIndex: bIdx,
      });
    } else {
      invalid.push(block.trim());
    }
  }

  // --- HIGH-PERFORMANCE DEDUPLICATION ENGINE ---
  const finalValid = [];
  const exactLookup = new Map(); // normalizedText -> validIndex
  // Buckets by length for sub-millisecond fuzzy filtering
  const lengthBuckets = new Map();

  for (let i = 0; i < valid.length; i++) {
    const item = valid[i];
    const normQ = normalizeQuestionText(item.question);
    const optSig = getOptionsSignature(item.options);

    let isDuplicate = false;
    let dupOriginalIndex = -1;
    let matchType = null;
    let similarityScore = 1.0;

    // 1. Exact Match Check ($O(1)$ Hash Map)
    if (exactLookup.has(normQ)) {
      const origIdx = exactLookup.get(normQ);
      const origItem = finalValid[origIdx];
      const origSig = getOptionsSignature(origItem.options);

      const origCorrect = origItem.options[origItem.correct_index] || '';
      const itemCorrect = item.options[item.correct_index] || '';
      const isCorrectSame = !origCorrect || !itemCorrect || normalizeQuestionText(origCorrect) === normalizeQuestionText(itemCorrect);

      if (isCorrectSame && (!optSig || !origSig || optSig === origSig || calculateSimilarity(optSig, origSig) >= 0.7)) {
        isDuplicate = true;
        dupOriginalIndex = origIdx;
        matchType = 'EXACT_MATCH';
        similarityScore = 1.0;
      }
    }

    // 2. High-Performance Fuzzy Match Check
    if (!isDuplicate && fuzzyThreshold > 0 && normQ.length >= 25) {
      const itemDigits = (normQ.match(/\d+/g) || []).join(',');
      const qLen = normQ.length;
      const minLen = Math.floor(qLen * 0.85);
      const maxLen = Math.ceil(qLen * 1.15);

      // Search only in neighboring length buckets (O(K) instead of O(N))
      for (let l = minLen; l <= maxLen; l++) {
        const bucket = lengthBuckets.get(l);
        if (!bucket) continue;

        for (const prevIdx of bucket) {
          const prevItem = finalValid[prevIdx];
          const prevNorm = normalizeQuestionText(prevItem.question);

          // Digits check
          const prevDigits = (prevNorm.match(/\d+/g) || []).join(',');
          if (itemDigits !== prevDigits) continue;

          const sim = calculateSimilarity(normQ, prevNorm);
          if (sim >= fuzzyThreshold) {
            const prevCorrect = prevItem.options[prevItem.correct_index] || '';
            const itemCorrect = item.options[item.correct_index] || '';
            const isCorrectSame = !prevCorrect || !itemCorrect || normalizeQuestionText(prevCorrect) === normalizeQuestionText(itemCorrect);

            if (!isCorrectSame) continue;

            const prevSig = getOptionsSignature(prevItem.options);
            const optSim = calculateSimilarity(optSig, prevSig);

            if (optSim >= 0.6 || optSig === prevSig) {
              isDuplicate = true;
              dupOriginalIndex = prevIdx;
              matchType = 'FUZZY_MATCH';
              similarityScore = Number(sim.toFixed(3));
              break;
            }
          }
        }
        if (isDuplicate) break;
      }
    }

    if (isDuplicate) {
      duplicates.push({
        duplicateIndex: i + 1,
        originalIndex: dupOriginalIndex + 1,
        question: item.question,
        originalQuestion: finalValid[dupOriginalIndex].question,
        similarity: similarityScore,
        matchType,
      });

      if (allowDuplicates) {
        const { _blockIndex, ...cleanItem } = item;
        finalValid.push(cleanItem);
      }
    } else {
      const { _blockIndex, ...cleanItem } = item;
      const newIdx = finalValid.length;
      finalValid.push(cleanItem);
      exactLookup.set(normQ, newIdx);

      // Add to length bucket for fast O(1) retrieval
      const len = normQ.length;
      if (!lengthBuckets.has(len)) lengthBuckets.set(len, []);
      lengthBuckets.get(len).push(newIdx);
    }
  }

  return {
    valid: finalValid,
    invalid,
    duplicates,
    stats: {
      totalFound: rawBlocks.length,
      validCount: finalValid.length,
      invalidCount: invalid.length,
      duplicateCount: duplicates.length,
      hierarchyType: hierarchy.type,
    },
  };
}

module.exports = {
  detectSeparatorsHierarchy,
  parseAdaptiveQuestions,
  normalizeQuestionText,
  getOptionsSignature,
  calculateSimilarity,
  expandInlineOptions,
  splitBlocksByNumberingOrLines,
};
