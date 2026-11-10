'use strict';

const { Markup } = require('telegraf');
const { TTLMap, escapeHtml, safeCallbackData, safeEdit } = require('../core/utils');
const { buildWidgetMessage, isValidWebAppUrl, buildInlineFlashcardWidgetHtml } = require('../services/widgetService');
const logger = require('../core/logger');

// Active cram sessions (2 hours TTL to prevent memory leaks)
const cramSessions = new TTLMap(2 * 60 * 60 * 1000);

let _customMemoryDb = null;
function setMemoryDb(db) {
  _customMemoryDb = db;
}

/**
 * Returns formatted subject title from key.
 * @param {string} key
 * @returns {string}
 */
function formatSubjectTitle(key) {
  if (!key) return '';
  return String(key)
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Generates visual progress bar.
 * @param {number} percent
 * @returns {string}
 */
function makeProgressBar(percent) {
  const totalBars = 10;
  const filledBars = Math.max(0, Math.min(totalBars, Math.round((percent / 100) * totalBars)));
  const emptyBars = totalBars - filledBars;
  return `${'🟩'.repeat(filledBars)}${'⬜'.repeat(emptyBars)} ${percent}%`;
}

/**
 * Resolves the true text of the correct answer from question object.
 * Handles numeric correct_index, string index, direct correct_ans, and cleans option prefixes.
 *
 * @param {object} q 
 * @returns {string} Clean correct answer string
 */
function extractCorrectAnswerText(q) {
  if (!q) return 'To\'g\'ri javob';
  const options = Array.isArray(q.options) ? q.options : [];

  // 1. Check numeric correct_index, correct_option, or numeric answer
  let idx = -1;
  if (typeof q.correct_index === 'number') {
    idx = q.correct_index;
  } else if (typeof q.correct_option === 'number') {
    idx = q.correct_option;
  } else if (typeof q.answer === 'number') {
    idx = q.answer;
  } else if (typeof q.correct_index === 'string' && /^\d+$/.test(q.correct_index.trim())) {
    idx = parseInt(q.correct_index.trim(), 10);
  } else if (typeof q.answer === 'string' && /^\d+$/.test(q.answer.trim())) {
    idx = parseInt(q.answer.trim(), 10);
  } else if (typeof q.a === 'number') {
    idx = q.a;
  }

  if (idx >= 0 && idx < options.length) {
    const optText = options[idx];
    if (typeof optText === 'string' && optText.trim()) {
      return optText.replace(/^[#*+]?\s*(\[[xX ]\]\s*)?(?:[A-Za-z0-9][\)\.\-]|[•\-\*])\s*/, '').trim() || optText.trim();
    }
  }

  // 2. Direct string answer properties
  if (typeof q.correct_ans === 'string' && q.correct_ans.trim()) {
    return q.correct_ans.trim();
  }
  if (typeof q.correct_text === 'string' && q.correct_text.trim()) {
    return q.correct_text.trim();
  }
  if (typeof q.answer === 'string' && q.answer.trim() && isNaN(Number(q.answer.trim()))) {
    return q.answer.trim();
  }
  if (typeof q.a === 'string' && q.a.trim() && isNaN(Number(q.a.trim()))) {
    return q.a.trim();
  }

  // 3. Fallback to first option if available
  if (options.length > 0 && typeof options[0] === 'string' && options[0].trim()) {
    return options[0].replace(/^[#*+]?\s*(\[[xX ]\]\s*)?(?:[A-Za-z0-9][\)\.\-]|[•\-\*])\s*/, '').trim() || options[0].trim();
  }

  return 'To\'g\'ri javob';
}

/**
 * Initializes spaced repetition flashcard deck.
 *
 * @param {Array<object>} questions - Questions array
 * @returns {{ total: number, unlearned: number[], learned: number[], cards: Array<object> }}
 */
function initFlashcardDeck(questions = []) {
  if (!Array.isArray(questions) || questions.length === 0) {
    return {
      total: 0,
      unlearned: [],
      learned: [],
      cards: [],
    };
  }

  const cards = questions.map((q, idx) => {
    const questionText = q.question || q.q || `Savol ${idx + 1}`;
    const answerText = extractCorrectAnswerText(q);
    const options = Array.isArray(q.options) ? q.options : [];
    return {
      id: q.id !== undefined ? q.id : idx,
      question: questionText,
      answer: answerText,
      options,
      q: questionText,
      a: answerText,
    };
  });

  const unlearned = cards.map((_, i) => i);

  return {
    total: cards.length,
    unlearned,
    learned: [],
    cards,
  };
}

/**
 * Processes a spaced repetition card action.
 *
 * - 'known' (Swipe right): moves card index from unlearned to learned.
 * - 'repeat' (Swipe left): keeps card index in unlearned, appending to back of queue.
 *
 * @param {object} deck - Spaced repetition deck
 * @param {'known'|'repeat'} action - User action
 * @param {number} [cardIdx] - Optional specific card index (defaults to unlearned[0])
 * @returns {object} Updated deck
 */
function processCardAction(deck, action, cardIdx = null) {
  if (!deck || !Array.isArray(deck.unlearned)) return deck;

  const targetIdx = cardIdx !== null && cardIdx !== undefined
    ? Number(cardIdx)
    : deck.unlearned[0];

  if (targetIdx === undefined || isNaN(targetIdx)) return deck;

  if (action === 'known') {
    // Swipe right: move from unlearned to learned
    const pos = deck.unlearned.indexOf(targetIdx);
    if (pos !== -1) {
      deck.unlearned.splice(pos, 1);
    }
    if (!Array.isArray(deck.learned)) {
      deck.learned = [];
    }
    if (!deck.learned.includes(targetIdx)) {
      deck.learned.push(targetIdx);
    }
  } else if (action === 'repeat') {
    // Swipe left: keep in unlearned, appending to the back of deck
    const pos = deck.unlearned.indexOf(targetIdx);
    if (pos !== -1) {
      deck.unlearned.splice(pos, 1);
    }
    if (Array.isArray(deck.learned)) {
      const learnedPos = deck.learned.indexOf(targetIdx);
      if (learnedPos !== -1) {
        deck.learned.splice(learnedPos, 1);
      }
    }
    deck.unlearned.push(targetIdx);
  }

  return deck;
}

/**
 * Builds view data for Telegram 10.4 Flashcard Widget and dual-mode fallbacks.
 *
 * @param {object} deck - Spaced repetition deck
 * @param {string} [subjectName] - Human-readable subject name
 * @param {string} [blockName] - Human-readable block name
 * @returns {object} View data object
 */
function buildFlashcardViewData(deck, subjectName = '', blockName = '') {
  if (!deck) {
    return {
      total: 0,
      learnedCount: 0,
      remainingCount: 0,
      percent: 0,
      cardIdx: null,
      question: '',
      answer: '',
      options: [],
      subjectName,
      blockName,
      isFinished: true,
      deck: { total: 0, unlearned: [], learned: [], cards: [] },
      title: 'Blitz-Flashcard',
    };
  }

  const total = Number(deck.total || deck.cards?.length || 0);
  const learnedCount = Array.isArray(deck.learned) ? deck.learned.length : 0;
  const remainingCount = Array.isArray(deck.unlearned) ? deck.unlearned.length : 0;
  const percent = total > 0 ? Math.round((learnedCount / total) * 100) : 0;
  const isFinished = remainingCount === 0;

  const currentCardIdx = remainingCount > 0 ? deck.unlearned[0] : null;
  const currentCard = currentCardIdx !== null && deck.cards ? deck.cards[currentCardIdx] : null;

  const question = currentCard ? (currentCard.question || currentCard.q || '') : '';
  const answer = currentCard ? (currentCard.answer || currentCard.a || '') : '';
  const options = currentCard?.options || [];

  return {
    total,
    learnedCount,
    remainingCount,
    percent,
    cardIdx: currentCardIdx,
    question,
    answer,
    options,
    subjectName: subjectName || '',
    blockName: blockName || '',
    isFinished,
    deck,
    title: subjectName ? `${subjectName} - ${blockName || 'Flashcard'}` : 'Blitz-Flashcard',
  };
}

/**
 * Builds dual-mode fallback inline keyboard for Telegram clients.
 *
 * Row 1: [ 👁 Javobni ko'rish ] / [ 🙈 Yashirish ]
 * Row 2: [ 👈 Qiyin (Qaytarish) ] | [ 👉 Bilib oldim ]
 * Row 3: [ ⚡ 5-daqiqalik Blitz ] | [ 🏁 Chiqish ]
 *
 * @param {number|null} cardIdx - Current card index
 * @param {boolean} [isRevealed=false] - Whether the answer is currently revealed
 * @param {string} [webAppUrl=null] - Optional WebApp URL for 3D gesture widget
 * @returns {object} Telegraf inline keyboard markup
 */
function getFlashcardFallbackKeyboard(cardIdx, isRevealed = false, webAppUrl = null) {
  const safeIdx = cardIdx !== null && cardIdx !== undefined ? cardIdx : 0;

  const row1 = [
    isRevealed
      ? Markup.button.callback('🙈 Yashirish', safeCallbackData(`cram_hide_${safeIdx}`))
      : Markup.button.callback('👁 Javobni ko\'rish', safeCallbackData(`cram_reveal_${safeIdx}`)),
  ];

  const row2 = [
    Markup.button.callback('👈 Qiyin (Qaytarish)', safeCallbackData(`cram_repeat_${safeIdx}`)),
    Markup.button.callback('👉 Bilib oldim', safeCallbackData(`cram_known_${safeIdx}`)),
  ];

  const row3 = [
    Markup.button.callback('⚡ 5-daqiqalik Blitz', safeCallbackData('cram_blitz')),
    Markup.button.callback('🏁 Chiqish', 'cram_exit'),
  ];

  const rows = [];
  if (webAppUrl && isValidWebAppUrl(webAppUrl)) {
    rows.push([
      Markup.button.webApp('🎴 3D Kartochka (Web App)', webAppUrl),
    ]);
  }
  rows.push(row1, row2, row3);

  return Markup.inlineKeyboard(rows);
}

/**
 * Builds finished completion keyboard.
 *
 * @param {string} subjectKey
 * @param {string|number} testId
 * @returns {object}
 */
function getCramFinishedKeyboard(subjectKey, testId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔄 Qaytadan boshlash', safeCallbackData(`cram_start_${subjectKey}_${testId}`)),
      Markup.button.callback('🏁 Chiqish', 'cram_exit'),
    ],
  ]);
}

/**
 * Formats clean message text for Telegram chat fallback.
 *
 * @param {object} viewData - Data from buildFlashcardViewData
 * @param {boolean} [isRevealed=false] - Whether answer should be visible
 * @returns {string} Formatted HTML text
 */
function formatFlashcardMessage(viewData, isRevealed = false) {
  if (!viewData) return '';

  if (viewData.isFinished) {
    return [
      `🎉 <b>Tabriklaymiz! Barcha kartochkalar o'rganildi!</b>`,
      ``,
      `📚 <b>Fan:</b> ${escapeHtml(viewData.subjectName)}`,
      `📘 <b>Blok:</b> ${escapeHtml(viewData.blockName)}`,
      `📊 <b>Natija:</b> ${viewData.total}/${viewData.total} (100% o'zlashtirildi)`,
      ``,
      `<i>Flashcardlarni yana takrorlashingiz yoki yangi blokni tanlashingiz mumkin.</i>`,
    ].join('\n');
  }

  const subj = escapeHtml(viewData.subjectName || 'Fan');
  const blk = escapeHtml(viewData.blockName || 'Blok');
  const progressText = makeProgressBar(viewData.percent);

  const lines = [
    `⚡ <b>Blitz-Flashcard</b> • <i>${subj}</i> (${blk})`,
    ``,
    `📊 <b>Jarayon:</b> ${viewData.learnedCount} / ${viewData.total} (${viewData.percent}%)`,
    `${progressText}`,
    ``,
    `❓ <b>Savol:</b>`,
    `${escapeHtml(viewData.question)}`,
  ];

  if (isRevealed) {
    lines.push(
      ``,
      `✅ <b>To'g'ri javob:</b>`,
      `<b>${escapeHtml(viewData.answer)}</b>`,
    );
  } else {
    lines.push(
      ``,
      `<i>💡 Javobni ko'rish uchun quyidagi tugmani bosing yoki kartochkani suring.</i>`,
    );
  }

  return lines.join('\n');
}

/**
 * Interactive launcher for Blitz-Flashcards.
 *
 * @param {object} ctx - Telegraf context
 * @param {string} subjectKey
 * @param {string|number} testId
 * @param {Array<object>} [questions=null]
 * @param {object} [options={}]
 */
async function launchFlashcardReview(ctx, subjectKey, testId, questions = null, options = {}) {
  await ctx.answerCbQuery().catch(() => {});
  const userId = ctx.from?.id;

  try {
    const featureFlagService = require('../services/featureFlagService');
    if (!featureFlagService.isFeatureEnabledSync('FEATURE_BLITZ_FLASHCARD', userId)) {
      return safeEdit(ctx, "ℹ️ <b>Flashcard funksiyasi hozircha sozlanmoqda.</b>", {
        reply_markup: {
          inline_keyboard: [[Markup.button.callback('🔙 Orqaga', 'official_tests')]],
        },
      });
    }
  } catch {}

  const userKey = userId ? String(userId) : 'default';

  // 1. Robust question resolution across memDb, Postgres user_tests, and universalTestHub
  let qs = questions;
  let subjectName = options.subjectName || formatSubjectTitle(subjectKey);
  let blockName = options.blockName || `${testId}-Blok`;

  if (!qs || !Array.isArray(qs) || qs.length === 0) {
    const botCore = require('../core/bot');
    const memDb = _customMemoryDb || botCore.memoryDb || {};
    const testData = (memDb[subjectKey] || {})[testId];
    if (testData?.questions?.length) {
      qs = testData.questions;
    } else {
      // 1a. Try resolving from Postgres user_tests
      try {
        const dbService = require('../services/dbService');
        const ugcTest = await dbService.getUserTest(testId);
        if (ugcTest && Array.isArray(ugcTest.questions) && ugcTest.questions.length > 0) {
          qs = ugcTest.questions;
          if (ugcTest.subject) subjectName = ugcTest.subject;
          if (ugcTest.block_name) blockName = ugcTest.block_name;
        }
      } catch (err) {}

      // 1b. Fallback to universalTestHub block resolver
      if (!qs || !qs.length) {
        try {
          const universalTestHub = require('./universalTestHub');
          const resolvedBlock = await universalTestHub.resolveBlockData(testId, subjectKey !== 'ugc');
          if (resolvedBlock && Array.isArray(resolvedBlock.questions) && resolvedBlock.questions.length > 0) {
            qs = resolvedBlock.questions;
            if (resolvedBlock.subjectTitle) subjectName = resolvedBlock.subjectTitle;
            if (resolvedBlock.blockName) blockName = resolvedBlock.blockName;
          }
        } catch {}
      }
    }
  }

  if (!qs || qs.length === 0) {
    const returnTarget = subjectKey !== 'ugc' ? `hub_subj_off_${subjectKey}` : `hub_subj_ugc_${testId}`;
    return safeEdit(ctx,
      `❌ <b>Ushbu blokda test savollari topilmadi.</b>\n\n` +
      `<i>Iltimos, boshqa blokni yoki boshqa fanni tanlab ko'ring.</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Fan Hubiga qaytish', safeCallbackData(returnTarget))],
      ])
    );
  }

  // 2. Initialize spaced repetition deck
  const deck = initFlashcardDeck(qs);

  // 3. Build view data & widget message
  const viewData = buildFlashcardViewData(deck, subjectName, blockName);
  const fallbackText = formatFlashcardMessage(viewData, false);

  // Generate signed WebApp widget URL if external domain configured
  let webAppUrl = null;
  try {
    const widgetMsg = buildWidgetMessage('flashcard', viewData, fallbackText, null, { userId });
    if (widgetMsg?.url && isValidWebAppUrl(widgetMsg.url)) {
      webAppUrl = widgetMsg.url;
    }
  } catch {}

  const safeFallbackKeyboard = getFlashcardFallbackKeyboard(viewData.cardIdx, false, webAppUrl);

  const chatId = ctx.chat?.id || ctx.from?.id;
  let widgetSent = false;

  // 4. Save session in TTLMap
  const session = {
    userId,
    chatId,
    subjectKey,
    testId,
    subjectName,
    blockName,
    deck,
    isRevealed: false,
    blitzMode: !!options.blitzMode,
    webAppUrl,
    messageId: ctx.callbackQuery?.message?.message_id,
    widgetId: null,
  };
  cramSessions.set(userKey, session);

  // 5. Telegram Bot API 10.4 HTML Widget launcher
  // Native inline message widget with QuickJS sandbox, 3D CSS flip & zero-latency updates
  if (chatId && ctx.chat?.type === 'private' && ctx.telegram && typeof ctx.telegram.callApi === 'function') {
    try {
      const inlineWidgetHtml = buildInlineFlashcardWidgetHtml(viewData);
      const publicData = {
        title: `${subjectName} • ${blockName}`,
        q: viewData.question,
        a: viewData.answer,
        total: viewData.total,
        learned: viewData.learnedCount,
        cardIdx: viewData.cardIdx,
      };
      const chatData = {
        userId,
        cardIdx: viewData.cardIdx,
      };

      const widgetRes = await ctx.telegram.callApi('sendWidget', {
        chat_id: chatId,
        html: inlineWidgetHtml,
        width: 360,
        height: 380,
        public_data: JSON.stringify(publicData),
        chat_data: JSON.stringify(chatData),
        is_shared: true,
        allow_queries: true,
        caption: `🎴 <b>3D Blitz-Flashcard</b> • <i>${escapeHtml(subjectName)}</i> (${escapeHtml(blockName)})`,
        parse_mode: 'HTML',
        reply_markup: safeFallbackKeyboard.reply_markup,
      });

      if (widgetRes && widgetRes.message_id) {
        widgetSent = true;
        session.messageId = widgetRes.message_id;
        session.widgetId = widgetRes.widget?.id || null;
        cramSessions.set(userKey, session);

        // Delete previous menu message to keep chat uncluttered
        if (ctx.callbackQuery?.message) {
          await ctx.deleteMessage().catch(() => {});
        }
      }
    } catch (widgetErr) {
      logger.debug('sendWidget unavailable or error (falling back to interactive message):', widgetErr.message);
    }
  }

  // 6. Dual-mode fallback: safeEdit interactive flashcard message
  if (!widgetSent) {
    await safeEdit(ctx, fallbackText, {
      parse_mode: 'HTML',
      ...safeFallbackKeyboard,
    });
  }
}

/**
 * Handles callback: cram_start_{subjectKey}_{testId}
 */
async function cbCramStart(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const data = ctx.callbackQuery?.data || '';
  const match = data.match(/^cram_start_(.+)_([^_]+)$/);
  if (!match) {
    return ctx.answerCbQuery('❌ Noto\'g\'ri parametr!', { show_alert: true }).catch(() => {});
  }
  const subjectKey = match[1];
  const testId = match[2];
  await launchFlashcardReview(ctx, subjectKey, testId);
}

/**
 * Handles callback: cram_reveal_{idx}
 */
async function cbCramReveal(ctx) {
  const userId = ctx.from?.id;
  const userKey = userId ? String(userId) : 'default';
  const session = cramSessions.get(userKey);
  if (!session) {
    return ctx.answerCbQuery('⚠️ Sessiya muddati tugagan.', { show_alert: true }).catch(() => {});
  }

  session.isRevealed = true;
  cramSessions.set(userKey, session);

  const viewData = buildFlashcardViewData(session.deck, session.subjectName, session.blockName);
  const text = formatFlashcardMessage(viewData, true);
  const keyboard = getFlashcardFallbackKeyboard(viewData.cardIdx, true, session.webAppUrl);
  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
  await ctx.answerCbQuery().catch(() => {});
}

/**
 * Handles callback: cram_hide_{idx}
 */
async function cbCramHide(ctx) {
  const userId = ctx.from?.id;
  const userKey = userId ? String(userId) : 'default';
  const session = cramSessions.get(userKey);
  if (!session) {
    return ctx.answerCbQuery('⚠️ Sessiya muddati tugagan.', { show_alert: true }).catch(() => {});
  }

  session.isRevealed = false;
  cramSessions.set(userKey, session);

  const viewData = buildFlashcardViewData(session.deck, session.subjectName, session.blockName);
  const text = formatFlashcardMessage(viewData, false);
  const keyboard = getFlashcardFallbackKeyboard(viewData.cardIdx, false, session.webAppUrl);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
  await ctx.answerCbQuery().catch(() => {});
}

/**
 * Handles callback: cram_known_{idx}
 */
async function cbCramKnown(ctx) {
  const userId = ctx.from?.id;
  const userKey = userId ? String(userId) : 'default';
  const session = cramSessions.get(userKey);
  if (!session) {
    return ctx.answerCbQuery('⚠️ Sessiya muddati tugagan.', { show_alert: true }).catch(() => {});
  }

  const data = ctx.callbackQuery?.data || '';
  const match = data.match(/^cram_known_(\d+)$/);
  const cardIdx = match ? Number(match[1]) : session.deck.unlearned[0];

  processCardAction(session.deck, 'known', cardIdx);
  session.isRevealed = false;
  cramSessions.set(userKey, session);

  const viewData = buildFlashcardViewData(session.deck, session.subjectName, session.blockName);
  const text = formatFlashcardMessage(viewData, false);

  if (viewData.isFinished) {
    const finishKeyboard = getCramFinishedKeyboard(session.subjectKey, session.testId);
    await safeEdit(ctx, text, { parse_mode: 'HTML', ...finishKeyboard });
  } else {
    const keyboard = getFlashcardFallbackKeyboard(viewData.cardIdx, false, session.webAppUrl);
    await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
  }

  await ctx.answerCbQuery('👉 Bilib oldim!').catch(() => {});
}

/**
 * Handles callback: cram_repeat_{idx}
 */
async function cbCramRepeat(ctx) {
  const userId = ctx.from?.id;
  const userKey = userId ? String(userId) : 'default';
  const session = cramSessions.get(userKey);
  if (!session) {
    return ctx.answerCbQuery('⚠️ Sessiya muddati tugagan.', { show_alert: true }).catch(() => {});
  }

  const data = ctx.callbackQuery?.data || '';
  const match = data.match(/^cram_repeat_(\d+)$/);
  const cardIdx = match ? Number(match[1]) : session.deck.unlearned[0];

  processCardAction(session.deck, 'repeat', cardIdx);
  session.isRevealed = false;
  cramSessions.set(userKey, session);

  const viewData = buildFlashcardViewData(session.deck, session.subjectName, session.blockName);
  const text = formatFlashcardMessage(viewData, false);
  const keyboard = getFlashcardFallbackKeyboard(viewData.cardIdx, false, session.webAppUrl);

  await safeEdit(ctx, text, { parse_mode: 'HTML', ...keyboard });
  await ctx.answerCbQuery('👈 Kartochka oxiriga qaytarildi').catch(() => {});
}

/**
 * Handles callback: cram_blitz
 */
async function cbCramBlitz(ctx) {
  const userId = ctx.from?.id;
  const userKey = userId ? String(userId) : 'default';
  const session = cramSessions.get(userKey);
  if (session) {
    session.blitzMode = true;
    session.blitzExpiresAt = Date.now() + 5 * 60 * 1000;
    cramSessions.set(userKey, session);
  }
  await ctx.answerCbQuery('⚡ 5-daqiqalik Blitz rejimi faollashtirildi!', { show_alert: true }).catch(() => {});
}

/**
 * Handles callback: cram_exit
 */
async function cbCramExit(ctx) {
  const userId = ctx.from?.id;
  const userKey = userId ? String(userId) : 'default';
  const session = cramSessions.get(userKey);
  const subjectKey = session?.subjectKey;

  cramSessions.delete(userKey);

  const exitText = "🏁 <b>Flashcard mashg'uloti yakunlandi.</b>\n\nQuyidagi tugma orqali test bloklariga qaytishingiz mumkin:";
  const exitKeyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📘 Bloklarga qaytish', subjectKey ? `page_${subjectKey}_0` : 'official_tests'),
      Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'),
    ],
  ]);

  await safeEdit(ctx, exitText, { parse_mode: 'HTML', ...exitKeyboard });
  await ctx.answerCbQuery().catch(() => {});
}

/**
 * Handles incoming `widget_query` update from Telegram Bot API 10.4.
 *
 * @param {object} ctx - Telegraf context
 * @param {object} query - widget_query object
 */
async function handleWidgetQuery(ctx, query) {
  if (!query) return;

  await ctx.telegram.callApi('answerWidgetQuery', {
    widget_query_id: query.id,
    data: 'OK',
  }).catch(() => {});

  const userId = query.from?.id;
  const userKey = userId ? String(userId) : 'default';
  const session = cramSessions.get(userKey);
  if (!session) return;

  const rawAction = String(query.data || '').trim();
  let action = 'known';
  let targetIdx = null;

  try {
    if (rawAction.startsWith('{')) {
      const parsed = JSON.parse(rawAction);
      action = parsed.a || parsed.action || 'known';
      targetIdx = parsed.i !== undefined ? parsed.i : null;
    } else {
      action = rawAction === 'repeat' ? 'repeat' : 'known';
    }
  } catch {}

  processCardAction(session.deck, action, targetIdx);
  session.isRevealed = false;
  cramSessions.set(userKey, session);

  const viewData = buildFlashcardViewData(session.deck, session.subjectName, session.blockName);
  const newPublicData = {
    title: `${session.subjectName} • ${session.blockName}`,
    q: viewData.question,
    a: viewData.answer,
    total: viewData.total,
    learned: viewData.learnedCount,
    cardIdx: viewData.cardIdx,
    isFinished: viewData.isFinished,
  };

  const chatId = query.chat?.id || ctx.chat?.id;
  const messageId = query.message_id;

  if (chatId && messageId) {
    await ctx.telegram.callApi('editMessageWidgetData', {
      chat_id: chatId,
      message_id: messageId,
      public_data: JSON.stringify(newPublicData),
      chat_data: JSON.stringify({ cardIdx: viewData.cardIdx }),
    }).catch(err => logger.debug('editMessageWidgetData error:', err.message));
  }
}

/**
 * Handles incoming `shared_widget_query` update from Telegram Bot API 10.4.
 * Uses `editSharedWidgetData` per https://core.telegram.org/bots/api#editsharedwidgetdata.
 *
 * @param {object} ctx - Telegraf context
 * @param {object} query - shared_widget_query object
 */
async function handleSharedWidgetQuery(ctx, query) {
  if (!query) return;

  await ctx.telegram.callApi('answerWidgetQuery', {
    widget_query_id: query.id,
    data: 'OK',
  }).catch(() => {});

  const userId = query.from?.id;
  const userKey = userId ? String(userId) : 'default';
  const session = cramSessions.get(userKey);
  if (!session) return;

  const rawAction = String(query.data || '').trim();
  let action = 'known';
  let targetIdx = null;

  try {
    if (rawAction.startsWith('{')) {
      const parsed = JSON.parse(rawAction);
      action = parsed.a || parsed.action || 'known';
      targetIdx = parsed.i !== undefined ? parsed.i : null;
    } else {
      action = rawAction === 'repeat' ? 'repeat' : 'known';
    }
  } catch {}

  processCardAction(session.deck, action, targetIdx);
  session.isRevealed = false;
  cramSessions.set(userKey, session);

  const viewData = buildFlashcardViewData(session.deck, session.subjectName, session.blockName);
  const newPublicData = {
    title: `${session.subjectName} • ${session.blockName}`,
    q: viewData.question,
    a: viewData.answer,
    total: viewData.total,
    learned: viewData.learnedCount,
    cardIdx: viewData.cardIdx,
    isFinished: viewData.isFinished,
  };

  if (query.widget_id) {
    await ctx.telegram.callApi('editSharedWidgetData', {
      widget_id: query.widget_id,
      public_data: JSON.stringify(newPublicData),
      cache_time: 5,
    }).catch(err => logger.debug('editSharedWidgetData error:', err.message));
  }
}

/**
 * Registers cram review actions into Telegraf bot instance.
 *
 * @param {object} bot - Telegraf bot instance
 */
function register(bot) {
  if (!bot || typeof bot.action !== 'function') return;

  // Telegram 10.4 Widget queries middleware
  if (typeof bot.use === 'function') {
    bot.use(async (ctx, next) => {
      if (ctx.update?.widget_query) {
        return handleWidgetQuery(ctx, ctx.update.widget_query);
      }
      if (ctx.update?.shared_widget_query) {
        return handleSharedWidgetQuery(ctx, ctx.update.shared_widget_query);
      }
      return next();
    });
  }

  bot.action(/^cram_start_(.+)_(.+)$/, cbCramStart);
  bot.action(/^cram_reveal_(\d+)$/, cbCramReveal);
  bot.action(/^cram_hide_(\d+)$/, cbCramHide);
  bot.action(/^cram_known_(\d+)$/, cbCramKnown);
  bot.action(/^cram_repeat_(\d+)$/, cbCramRepeat);
  bot.action(/^cram_blitz(?:_(\d+))?$/, cbCramBlitz);
  bot.action(/^cram_exit$/, cbCramExit);
}

module.exports = {
  cramSessions,
  extractCorrectAnswerText,
  initFlashcardDeck,
  processCardAction,
  buildFlashcardViewData,
  getFlashcardFallbackKeyboard,
  getCramFinishedKeyboard,
  formatFlashcardMessage,
  launchFlashcardReview,
  handleWidgetQuery,
  handleSharedWidgetQuery,
  cbCramStart,
  cbCramReveal,
  cbCramHide,
  cbCramKnown,
  cbCramRepeat,
  cbCramBlitz,
  cbCramExit,
  register,
  setMemoryDb,
};
