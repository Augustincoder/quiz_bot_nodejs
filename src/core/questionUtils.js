'use strict';

function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(obj);
    } catch {
      // Fallback if object has non-cloneable properties
    }
  }
  return JSON.parse(JSON.stringify(obj));
}

function shuffleArray(arr) {
  const a = Array.isArray(arr) ? [...arr] : [];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Savollarni chuqur nusxalagan holda xavfsiz aralashtiradi.
 * Asl massiv va global test keshiga hech qanday mutatsiya qilmaydi.
 */
function prepareShuffledQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  const cloned = deepClone(rawQuestions);
  const shuffledQ = shuffleArray(cloned);
  return shuffledQ.map((q) => {
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const correctText = rawOptions[q.correct_index];
    const sanitizedOptions = rawOptions.map((opt) => String(opt ?? '').trim() || 'Variant');
    const options = shuffleArray(sanitizedOptions);
    const newCorrectIdx = options.indexOf(String(correctText ?? '').trim() || 'Variant');

    return {
      ...q,
      question: q.question || '',
      options,
      correct_index: newCorrectIdx >= 0 ? newCorrectIdx : 0,
      correct_text: correctText,
    };
  });
}

/**
 * Savol va uning variantlari Telegram Poll chegaralariga sig'ishini tekshiradi.
 * Telegram Poll cheklovlari:
 * - Savol matni: 1 .. 300 belgi
 * - Variantlar soni: 2 .. 10 ta
 * - Har bir variant uzunligi: 1 .. 100 belgi
 *
 * @param {string} question
 * @param {string[]} options
 * @returns {boolean}
 */
function fitsTelegramPoll(question, options) {
  const qStr = String(question ?? '').trim();
  if (qStr.length === 0 || qStr.length > 300) return false;
  if (!Array.isArray(options) || options.length < 2 || options.length > 10) return false;
  for (const opt of options) {
    const optStr = String(opt ?? '').trim();
    if (optStr.length === 0 || optStr.length > 100) return false;
  }
  return true;
}

/**
 * Savol tushuntirishini (explanation) Telegram Poll 200 belgi limitiga moslab xavfsiz qisqartiradi.
 * Agar qisqartirish HTML entity (&amp;, &lt;, &gt;, &quot;) o'rtasiga to'g'ri kelsa, chala qolgan entityni
 * tozalab, Telegram "can't parse entities" xatosini 100% oldini oladi.
 *
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function safeTruncateExplanation(text, maxLen = 200) {
  if (!text || typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;

  const targetLen = Math.max(0, maxLen - 3);
  let sliced = trimmed.slice(0, targetLen);

  // Agar kesish HTML entity (&...;) o'rtasiga tushgan bo'lsa, chala entityni qirqib tashlaymiz
  sliced = sliced.replace(/&[a-zA-Z0-9#]*$/, '');

  return sliced.trimEnd() + '...';
}

module.exports = {
  prepareShuffledQuestions,
  shuffleArray,
  fitsTelegramPoll,
  deepClone,
  safeTruncateExplanation,
};