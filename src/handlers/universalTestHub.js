'use strict';

/**
 * Universal Test & Subject Hub Handler
 *
 * Bridges the gap between Official Tests and UGC (User-Generated) Tests.
 * Provides a unified, rich entrypoint with:
 * - 📚 Subject Hub: Sequential Marathon, 25-Q Mock Exam, Flashcard Block Picker, AI Adaptive
 * - 📘 Block Hub: Standard Quiz, 3D Flashcard WebApp, 5-Min Blitz, Group Multiplayer
 * - Seamless Deep Link Resolution (/start s_..., /start t_..., /start offs_..., /start offt_...)
 */

const { Markup } = require('telegraf');
const dbService = require('../services/dbService');
const logger = require('../core/logger');
const { escapeHtml, safeEdit, safeCallbackData } = require('../core/utils');
const { shuffleArray, deepClone } = require('../core/questionUtils');

let featureFlagService = null;
try {
  featureFlagService = require('../services/featureFlagService');
} catch {}

let cramReviewHandler = null;
try {
  cramReviewHandler = require('./cramReviewHandler');
} catch {}

let _customMemoryDb = null;
function setMemoryDb(db) {
  _customMemoryDb = db;
}

// In-memory DB getter
function getMemoryDb() {
  if (_customMemoryDb) return _customMemoryDb;
  const botCore = require('../core/bot');
  return botCore.memoryDb || {};
}

/**
 * Formats a clean human-readable title from slug / key.
 */
function formatTitle(str) {
  if (!str) return 'Fan';
  return String(str)
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Resolves full subject data for both Official and UGC subjects.
 *
 * @param {string|number} subjectIdOrKey
 * @param {boolean} [isOfficialHint=false]
 * @returns {Promise<{ isOfficial: boolean, id: string|number, title: string, blocks: Array<object>, totalQuestions: number, authorText: string } | null>}
 */
async function resolveSubjectData(subjectIdOrKey, isOfficialHint = false) {
  if (subjectIdOrKey === undefined || subjectIdOrKey === null) return null;

  let lookupKey = String(subjectIdOrKey).trim();
  let isOfficial = isOfficialHint;

  if (lookupKey.startsWith('offs_')) {
    lookupKey = lookupKey.replace('offs_', '');
    isOfficial = true;
  } else if (lookupKey.startsWith('s_')) {
    try {
      const { resolveShareParam } = require('../services/shareService');
      const resolved = resolveShareParam(lookupKey);
      if (resolved && resolved.id) {
        lookupKey = String(resolved.id);
        if (resolved.type === 'offs') isOfficial = true;
      }
    } catch {}
  } else if (lookupKey.startsWith('blitz_')) {
    lookupKey = lookupKey.replace('blitz_', '');
  }

  const memDb = getMemoryDb();

  // 1. Check if official subject in memoryDb
  if (isOfficial || (typeof lookupKey === 'string' && memDb[lookupKey])) {
    const subjKey = String(lookupKey).trim();
    if (memDb[subjKey]) {
      const testsMap = memDb[subjKey] || {};
      const testIds = Object.keys(testsMap).map(Number).sort((a, b) => a - b);
      const blocks = testIds.map(tId => ({
        id: tId,
        test_id: tId,
        block_name: `${tId}-Blok`,
        questions: testsMap[tId]?.questions || [],
      }));
      const totalQuestions = blocks.reduce((sum, b) => sum + (b.questions?.length || 0), 0);
      return {
        isOfficial: true,
        id: subjKey,
        subjectKey: subjKey,
        title: formatTitle(subjKey),
        blocks,
        totalQuestions,
        authorText: '🎓 Rasmiy Test Bazasi',
      };
    }
  }

  // 2. Check UGC subject from PostgreSQL
  try {
    const numericId = parseInt(lookupKey, 10);
    if (!isNaN(numericId) && numericId > 0) {
      const subject = await dbService.getSubjectById(numericId);
      if (subject) {
        const rawBlocks = await dbService.getSubjectBlocks(subject.id);
        const blocks = (rawBlocks || []).map((b, idx) => ({
          id: b.id,
          test_id: b.id,
          block_name: b.block_name || `${idx + 1}-Blok`,
          questions: b.questions || [],
        }));
        const totalQuestions = blocks.reduce((sum, b) => sum + (b.questions?.length || 0), 0);
        return {
          isOfficial: false,
          id: subject.id,
          subjectId: subject.id,
          title: subject.name || formatTitle(lookupKey),
          blocks,
          totalQuestions,
          authorText: '👥 Ustoz / Foydalanuvchi',
        };
      }

      // Check if ID was a user test ID belonging to a subject
      const testData = await dbService.getUserTest(numericId);
      if (testData) {
        if (testData.subject_id) {
          return await resolveSubjectData(testData.subject_id, false);
        }
        // Group by subject string
        const allUserTests = await dbService.getUserCreatedTests(testData.creator_id);
        const matching = (allUserTests || []).filter(t => t.subject === testData.subject);
        const blocks = matching.map((b, idx) => ({
          id: b.id,
          test_id: b.id,
          block_name: b.block_name || `${idx + 1}-Blok`,
          questions: b.questions || [],
        }));
        const totalQuestions = blocks.reduce((sum, b) => sum + (b.questions?.length || 0), 0);
        return {
          isOfficial: false,
          id: numericId,
          subjectId: testData.subject_id || numericId,
          title: testData.subject || 'Foydalanuvchi Fani',
          blocks,
          totalQuestions,
          authorText: '👥 Ustoz / Foydalanuvchi',
        };
      }
    }
  } catch (err) {
    logger.error('resolveSubjectData error:', { subjectIdOrKey: lookupKey, error: err.message });
  }

  return null;
}

/**
 * Resolves single block data for both Official and UGC tests.
 *
 * @param {string|number} testIdOrDescriptor
 * @param {boolean} [isOfficialHint=false]
 * @returns {Promise<{ isOfficial: boolean, id: string|number, subjectKey: string, subjectTitle: string, blockName: string, questions: Array<object>, subjectId: number|null } | null>}
 */
async function resolveBlockData(testIdOrDescriptor, isOfficialHint = false) {
  if (testIdOrDescriptor === undefined || testIdOrDescriptor === null) return null;

  let rawStr = String(testIdOrDescriptor).trim();
  let isOfficial = isOfficialHint;

  if (rawStr.startsWith('offt_')) {
    rawStr = rawStr.replace('offt_', '');
    isOfficial = true;
  } else if (rawStr.startsWith('t_')) {
    try {
      const { resolveShareParam } = require('../services/shareService');
      const resolved = resolveShareParam(rawStr);
      if (resolved && resolved.id) {
        rawStr = String(resolved.id);
        if (resolved.type === 'offt') isOfficial = true;
      }
    } catch {}
  } else if (rawStr.startsWith('blitz_')) {
    rawStr = rawStr.replace('blitz_', '');
  }

  const memDb = getMemoryDb();

  // 1. Official block pattern: e.g. "Matematika_1" or "offt_Matematika_1"
  if (isOfficial || rawStr.includes('_')) {
    const parts = rawStr.split('_');
    const testId = parseInt(parts[parts.length - 1], 10);
    const subjectKey = parts.slice(0, -1).join('_');

    if (!isNaN(testId) && memDb[subjectKey] && memDb[subjectKey][testId]) {
      const t = memDb[subjectKey][testId];
      return {
        isOfficial: true,
        id: testId,
        subjectKey,
        subjectTitle: formatTitle(subjectKey),
        blockName: `${testId}-Blok`,
        questions: t.questions || [],
        subjectId: null,
      };
    }
  }

  // 2. UGC block from PostgreSQL
  try {
    const numericId = parseInt(rawStr, 10);
    if (!isNaN(numericId) && numericId > 0) {
      const testData = await dbService.getUserTest(numericId);
      if (testData) {
        return {
          isOfficial: false,
          id: testData.id,
          subjectKey: 'ugc',
          subjectTitle: testData.subject || 'Test',
          blockName: testData.block_name || 'Blok',
          questions: testData.questions || [],
          subjectId: testData.subject_id || null,
        };
      }
    }
  } catch (err) {
    logger.error('resolveBlockData error:', { testIdOrDescriptor, error: err.message });
  }

  return null;
}

/**
 * Renders and displays the Universal Subject Hub.
 *
 * @param {object} ctx
 * @param {string|number} subjectIdOrKey
 * @param {object} [options={}]
 */
async function showSubjectHub(ctx, subjectIdOrKey, options = {}) {
  const isOfficial = options.isOfficial === true;
  const data = await resolveSubjectData(subjectIdOrKey, isOfficial);

  if (!data || !data.blocks || data.blocks.length === 0) {
    const isDbDown = dbService.isRecentDbError && dbService.isRecentDbError();
    const errText = isDbDown
      ? "⚠️ <b>Ma'lumotlar bazasida vaqtinchalik uzilish yuz berdi.</b>\n\nIltimos, 1-2 daqiqadan so'ng qayta urinib ko'ring."
      : '❌ <b>Fan topilmadi yoki uning testlari o\'chirilgan.</b>';
    const kb = Markup.inlineKeyboard([[Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]]);
    if (options.loadingMsgId && ctx.chat?.id) {
      return ctx.telegram.editMessageText(ctx.chat.id, options.loadingMsgId, undefined, errText, { parse_mode: 'HTML', ...kb }).catch(() => ctx.reply(errText, { parse_mode: 'HTML', ...kb }));
    }
    return ctx.reply(errText, { parse_mode: 'HTML', ...kb }).catch(() => {});
  }

  const userId = ctx.from?.id;
  const isFlashcardEnabled = featureFlagService
    ? featureFlagService.isFeatureEnabledSync('FEATURE_BLITZ_FLASHCARD', userId)
    : true;

  const estTimeMin = Math.max(5, Math.round(data.totalQuestions * 0.7));
  const text = `📚 <b>${escapeHtml(data.title)}</b> — <b>Fan Hubi</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Tarkib:</b> <b>${data.blocks.length} ta blok</b> • Jami <b>${data.totalQuestions} ta savol</b>\n` +
    `👤 <b>Manba:</b> ${escapeHtml(data.authorText)}\n` +
    `⏱ <b>Taxminiy vaqt:</b> ~${estTimeMin} daqiqa\n\n` +
    `💡 <i>O'zingizga ma'qul bo'lgan o'rganish rejimini tanlang:</i>`;

  const rows = [];
  const srcTag = data.isOfficial ? 'off' : 'ugc';
  const idTag = String(data.id);

  // Row 1: Sequential Marathon
  rows.push([
    Markup.button.callback(
      `▶️ Ketma-ket Marafon (${data.blocks.length} ta blok)`,
      safeCallbackData(`hub_seq_${srcTag}_${idTag}`)
    ),
  ]);

  // Row 2: Mock Exam (Randomized 25 questions across subject)
  rows.push([
    Markup.button.callback(
      `🎲 Aralash Imtihon (Mock Exam)`,
      safeCallbackData(`hub_mock_${srcTag}_${idTag}`)
    ),
  ]);

  // Row 3: 3D Flashcard Block/Blitz Picker
  if (isFlashcardEnabled) {
    rows.push([
      Markup.button.callback(
        `⚡ 3D Flashcard (Kartochkalar)`,
        safeCallbackData(`hub_cram_pick_${srcTag}_${idTag}`)
      ),
    ]);
  }

  // Row 4: AI Adaptive Trainer
  rows.push([
    Markup.button.callback(
      `🎯 AI Adaptiv Mashq`,
      safeCallbackData(`hub_adapt_${srcTag}_${idTag}`)
    ),
  ]);

  // Row 5: Individual Blocks List
  rows.push([
    Markup.button.callback(
      `📋 Bloklar ro'yxatini ko'rish`,
      safeCallbackData(`hub_blocks_${srcTag}_${idTag}`)
    ),
  ]);

  // Row 6: Navigation
  rows.push([
    Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'),
  ]);

  const kb = Markup.inlineKeyboard(rows);

  if (options.loadingMsgId && ctx.chat?.id) {
    try {
      await ctx.telegram.editMessageText(ctx.chat.id, options.loadingMsgId, undefined, text, { parse_mode: 'HTML', ...kb });
      return;
    } catch {}
  }

  if (ctx.callbackQuery) {
    return safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  }

  return ctx.reply(text, { parse_mode: 'HTML', ...kb });
}

/**
 * Renders and displays the Universal Block Hub (Action Sheet).
 *
 * @param {object} ctx
 * @param {string|number} testIdOrDescriptor
 * @param {object} [options={}]
 */
async function showBlockHub(ctx, testIdOrDescriptor, options = {}) {
  const isOfficial = options.isOfficial === true;
  const block = await resolveBlockData(testIdOrDescriptor, isOfficial);

  if (!block || !block.questions || block.questions.length === 0) {
    const isDbDown = dbService.isRecentDbError && dbService.isRecentDbError();
    const errText = isDbDown
      ? "⚠️ <b>Ma'lumotlar bazasida vaqtinchalik uzilish yuz berdi.</b>\n\nIltimos, 1-2 daqiqadan so'ng qayta urinib ko'ring."
      : "❌ <b>Test bloki topilmadi yoki o'chirilgan.</b>";
    const kb = Markup.inlineKeyboard([[Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]]);
    return ctx.reply(errText, { parse_mode: 'HTML', ...kb }).catch(() => {});
  }

  const userId = ctx.from?.id;
  const isFlashcardEnabled = featureFlagService
    ? featureFlagService.isFeatureEnabledSync('FEATURE_BLITZ_FLASHCARD', userId)
    : true;

  const qCount = block.questions.length;
  const estTimeMin = Math.max(3, Math.round(qCount * 0.5));
  const srcTag = block.isOfficial ? 'off' : 'ugc';
  const idTag = String(block.id);

  const text = `📘 <b>${escapeHtml(block.subjectTitle)}</b> — <b>${escapeHtml(block.blockName)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>Savollar soni:</b> <b>${qCount} ta</b>\n` +
    `⏱ <b>Taxminiy vaqt:</b> ~${estTimeMin} daqiqa\n\n` +
    `💡 <i>Ushbu blokni qaysi formatda o'rganmoqchisiz?</i>`;

  const rows = [];

  // 1. Standard Quiz Start
  rows.push([
    Markup.button.callback(
      `🚀 Standart Testni Boshlash`,
      safeCallbackData(`hub_start_${srcTag}_${block.isOfficial ? `${block.subjectKey}_${idTag}` : idTag}`)
    ),
  ]);

  // 2. 3D Flashcard
  if (isFlashcardEnabled) {
    const cramKey = block.isOfficial
      ? safeCallbackData(`cram_start_${block.subjectKey}_${idTag}`)
      : safeCallbackData(`cram_start_ugc_${idTag}`);

    rows.push([
      Markup.button.callback(
        `🎴 3D Flashcard (Tezkor Ko'rish)`,
        cramKey
      ),
    ]);
  }

  // 3. 5-Minute Blitz Mode
  rows.push([
    Markup.button.callback(
      `⚡ 5-daqiqalik Blitz (10 savol)`,
      safeCallbackData(`hub_blitz_${srcTag}_${block.isOfficial ? `${block.subjectKey}_${idTag}` : idTag}`)
    ),
  ]);

  // 4. Return to subject or main
  const backRow = [];
  if (block.subjectId || block.subjectKey) {
    const returnTarget = block.isOfficial ? block.subjectKey : block.subjectId;
    backRow.push(
      Markup.button.callback(
        `📚 Barcha bloklar`,
        safeCallbackData(`hub_subj_${srcTag}_${returnTarget}`)
      )
    );
  }
  backRow.push(Markup.button.callback('🏠 Menyu', 'back_to_main'));
  rows.push(backRow);

  const kb = Markup.inlineKeyboard(rows);

  if (ctx.callbackQuery) {
    return safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  }

  return ctx.reply(text, { parse_mode: 'HTML', ...kb });
}

/**
 * Displays Flashcard Block / Blitz Picker for a Subject.
 * Avoids cognitive card overload by letting user choose a block or 20-card Blitz.
 *
 * @param {object} ctx
 * @param {string|number} subjectIdOrKey
 * @param {boolean} isOfficial
 */
async function showFlashcardPicker(ctx, subjectIdOrKey, isOfficial) {
  const data = await resolveSubjectData(subjectIdOrKey, isOfficial);
  if (!data || !data.blocks || data.blocks.length === 0) {
    return safeEdit(ctx,
      `❌ <b>Flashcard uchun fan bloklari topilmadi.</b>\n\n` +
      `<i>Ushbu fan uchun test savollari hali yuklanmagan bo'lishi mumkin.</i>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Orqaga', isOfficial ? 'official_tests' : 'my_tests')],
      ])
    );
  }

  const srcTag = isOfficial ? 'off' : 'ugc';
  const idTag = String(data.id);

  const text = `🎴 <b>${escapeHtml(data.title)} — Flashcard Tanlovi</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `💡 <i>Kartochkalar soni juda ko'payib ketmasligi va yodlash oson bo'lishi uchun kerakli blokni tanlang:</i>\n\n` +
    `📊 Jami savollar: <b>${data.totalQuestions} ta</b> (${data.blocks.length} ta blokda)`;

  const rows = [];

  // Blitz 20 Cards Option
  rows.push([
    Markup.button.callback(
      `⚡ 20 ta Blitz Kartochka (Aralash)`,
      safeCallbackData(`hub_cram_blitz_${srcTag}_${idTag}`)
    ),
  ]);

  // Individual Block Cards
  for (const b of data.blocks) {
    const qCount = b.questions?.length || 0;
    const cramKey = isOfficial
      ? safeCallbackData(`cram_start_${data.subjectKey}_${b.id}`)
      : safeCallbackData(`cram_start_ugc_${b.id}`);

    rows.push([
      Markup.button.callback(
        `📘 ${escapeHtml(b.block_name)} (${qCount} ta)`,
        cramKey
      ),
    ]);
  }

  // Back to Subject Hub
  rows.push([
    Markup.button.callback(
      `🔙 Fan Hubiga qaytish`,
      safeCallbackData(`hub_subj_${srcTag}_${idTag}`)
    ),
  ]);

  const kb = Markup.inlineKeyboard(rows);
  return safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
}

/**
 * Starts a 25-Question Randomized Mock Exam across all blocks of a subject.
 *
 * @param {object} ctx
 * @param {string|number} subjectIdOrKey
 * @param {boolean} isOfficial
 */
async function startSubjectMockExam(ctx, subjectIdOrKey, isOfficial) {
  await ctx.answerCbQuery('🎲 Imtihon savollari tayyorlanmoqda...').catch(() => {});
  const data = await resolveSubjectData(subjectIdOrKey, isOfficial);

  if (!data || !data.blocks || data.blocks.length === 0) {
    return safeEdit(ctx, '❌ <b>Imtihon uchun savollar topilmadi.</b>', Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Orqaga', isOfficial ? 'official_tests' : 'my_tests')],
    ]));
  }

  const allQuestions = data.blocks.flatMap(b => b.questions || []);
  if (!allQuestions.length) {
    return safeEdit(ctx, '❌ <b>Ushbu fanda savollar mavjud emas.</b>', Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Fan Hubiga qaytish', safeCallbackData(`hub_subj_${isOfficial ? 'off' : 'ugc'}_${data.id}`))],
    ]));
  }

  const shuffled = deepClone(allQuestions);
  shuffleArray(shuffled);
  const examQuestions = shuffled.slice(0, 25);

  const testData = {
    questions: examQuestions,
    block_name: `Aralash Imtihon (Mock)`,
    subject: data.title,
  };

  const { initAndStartTest, startUgcTest, checkActiveTestConflict } = require('./quizGame');
  const chatId = ctx.chat?.id || ctx.from?.id;
  const mutex = require('../core/mutex');

  if (isOfficial) {
    const unlock = await mutex.lock(`start_test:${chatId}`);
    try {
      if (await checkActiveTestConflict(ctx, chatId)) return;
      return await initAndStartTest(chatId, ctx.telegram, data.subjectKey, 'mock', testData, ctx.from.id, 'private');
    } finally {
      unlock();
    }
  } else {
    return startUgcTest(ctx, {
      ...testData,
      id: `mock_${data.id}`,
      title: `${data.title} — Mock`,
    });
  }
}

/**
 * Starts 20-card Blitz flashcards selected randomly across the entire subject.
 *
 * @param {object} ctx
 * @param {string|number} subjectIdOrKey
 * @param {boolean} isOfficial
 */
async function startSubjectBlitzCards(ctx, subjectIdOrKey, isOfficial) {
  await ctx.answerCbQuery('⚡ Blitz kartochkalar tayyorlanmoqda...').catch(() => {});
  const data = await resolveSubjectData(subjectIdOrKey, isOfficial);

  if (!data || !data.blocks || data.blocks.length === 0) {
    return safeEdit(ctx,
      `❌ <b>Fan bloklari yoki savollari topilmadi.</b>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Orqaga', isOfficial ? 'official_tests' : 'my_tests')],
      ])
    );
  }

  const allQuestions = data.blocks.flatMap(b => b.questions || []);
  if (!allQuestions.length) {
    return safeEdit(ctx,
      `❌ <b>Ushbu fanda test savollari mavjud emas.</b>`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Fan Hubiga qaytish', safeCallbackData(`hub_subj_${isOfficial ? 'off' : 'ugc'}_${data.id}`))],
      ])
    );
  }

  const shuffled = deepClone(allQuestions);
  shuffleArray(shuffled);
  const blitzQuestions = shuffled.slice(0, 20);

  const handler = cramReviewHandler || require('./cramReviewHandler');
  if (handler && typeof handler.launchFlashcardReview === 'function') {
    return handler.launchFlashcardReview(
      ctx,
      isOfficial ? data.subjectKey : 'ugc',
      `blitz_${data.id}`,
      blitzQuestions,
      {
        subjectName: data.title,
        blockName: '⚡ 20 ta Blitz Kartochka',
        blitzMode: true,
      }
    );
  }

  return safeEdit(ctx,
    `⚠️ <b>Flashcard modulini ishga tushirishda xatolik yuz berdi.</b>`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Fan Hubiga qaytish', safeCallbackData(`hub_subj_${isOfficial ? 'off' : 'ugc'}_${data.id}`))],
    ])
  );
}

/**
 * Starts sequential multi-block marathon progression for a subject.
 *
 * @param {object} ctx
 * @param {string|number} subjectIdOrKey
 * @param {boolean} isOfficial
 */
async function startSubjectMarathon(ctx, subjectIdOrKey, isOfficial) {
  await ctx.answerCbQuery('🏃‍♂️ Marafon boshlanmoqda...').catch(() => {});
  const data = await resolveSubjectData(subjectIdOrKey, isOfficial);

  if (!data || !data.blocks || data.blocks.length === 0) {
    return ctx.reply('❌ Marafon uchun bloklar topilmadi.').catch(() => {});
  }

  const { initAndStartTest, startUgcTest, checkActiveTestConflict } = require('./quizGame');
  const chatId = ctx.chat?.id || ctx.from?.id;
  const mutex = require('../core/mutex');

  if (isOfficial) {
    const firstBlock = data.blocks[0];
    const testData = {
      questions: firstBlock.questions,
      block_name: firstBlock.block_name,
      isMarathon: true,
      marathonBlocks: data.blocks,
      currentBlockIdx: 0,
    };
    const unlock = await mutex.lock(`start_test:${chatId}`);
    try {
      if (await checkActiveTestConflict(ctx, chatId)) return;
      return await initAndStartTest(chatId, ctx.telegram, data.subjectKey, firstBlock.id, testData, ctx.from.id, 'private');
    } finally {
      unlock();
    }
  } else {
    const firstBlock = data.blocks[0];
    const testDb = {
      id: firstBlock.id,
      subject: data.title,
      block_name: firstBlock.block_name,
      questions: firstBlock.questions,
      isMarathon: true,
      marathonBlocks: data.blocks,
      currentBlockIdx: 0,
    };
    return startUgcTest(ctx, testDb);
  }
}

/**
 * Displays AI Adaptive Test setup / question count picker for a subject.
 *
 * @param {object} ctx
 * @param {string|number} subjectIdOrKey
 * @param {boolean} isOfficial
 */
async function showAdaptivePicker(ctx, subjectIdOrKey, isOfficial) {
  await ctx.answerCbQuery().catch(() => {});
  const data = await resolveSubjectData(subjectIdOrKey, isOfficial);

  if (!data || !data.blocks || data.blocks.length === 0) {
    return ctx.reply("❌ Fan yoki uning testlari topilmadi.", Markup.inlineKeyboard([[Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]])).catch(() => {});
  }

  const srcTag = isOfficial ? 'off' : 'ugc';
  const idTag = String(data.id);
  const userId = ctx.from?.id;

  // Retrieve user's previous mistakes for this subject
  let mistakes = [];
  try {
    const stats = await dbService.getUserStats(userId);
    const history = stats?.history || [];
    mistakes = history
      .filter(r =>
        r &&
        (
          r.subject === data.title ||
          r.subjectKey === data.subjectKey ||
          r.subjectId === data.id ||
          r.subject === data.subjectKey
        ) &&
        Array.isArray(r.mistakes) &&
        r.mistakes.length > 0
      )
      .flatMap(r => r.mistakes);
  } catch {}

  const hasMistakes = mistakes.length > 0;
  const countButtons = [];

  if (hasMistakes) {
    countButtons.push(
      [
        Markup.button.callback('5 ta', safeCallbackData(`hub_adprun_${srcTag}_${idTag}_5`)),
        Markup.button.callback('10 ta', safeCallbackData(`hub_adprun_${srcTag}_${idTag}_10`)),
      ],
      [
        Markup.button.callback('15 ta', safeCallbackData(`hub_adprun_${srcTag}_${idTag}_15`)),
        Markup.button.callback('20 ta', safeCallbackData(`hub_adprun_${srcTag}_${idTag}_20`)),
      ]
    );
  } else {
    // Diagnostic adaptive test: draws questions across all blocks
    countButtons.push(
      [
        Markup.button.callback('10 ta', safeCallbackData(`hub_adprun_${srcTag}_${idTag}_10`)),
        Markup.button.callback('15 ta', safeCallbackData(`hub_adprun_${srcTag}_${idTag}_15`)),
      ]
    );
  }

  countButtons.push([
    Markup.button.callback('🔙 Fan Hubiga qaytish', safeCallbackData(`hub_subj_${srcTag}_${idTag}`)),
  ]);

  const text = hasMistakes
    ? `🎯 <b>AI Adaptiv Test — ${escapeHtml(data.title)}</b>\n\n` +
      `AI sizning <b>avvalgi xatolaringiz</b> asosida maxsus test yaratadi — zaif joylaringizni mustahkamlash uchun eng samarali usul!\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `📊 <b>Jamg'arilgan xatolar:</b> <b>${mistakes.length} ta</b>\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `<b>Nechta savol ishlashni tanlang:</b>\n` +
      `<i>💡 10–15 ta — diqqat va samaradorlik uchun eng maqbul.</i>`
    : `🎯 <b>AI Adaptiv Diagnostika — ${escapeHtml(data.title)}</b>\n\n` +
      `✨ <i>Ushbu fandan hali xatolaringiz qayd etilmagan.</i>\n\n` +
      `🧠 AI fanning barcha bloklaridan bilim darajangizni aniqlovchi <b>Diagnostik Adaptiv Test</b> tuzib beradi!\n\n` +
      `<b>Nechta savol ishlashni tanlang:</b>`;

  const kb = Markup.inlineKeyboard(countButtons);
  if (ctx.callbackQuery) {
    return safeEdit(ctx, text, { parse_mode: 'HTML', ...kb });
  }
  return ctx.reply(text, { parse_mode: 'HTML', ...kb });
}

/**
 * Executes AI Adaptive Test for a subject.
 *
 * @param {object} ctx
 * @param {string|number} subjectIdOrKey
 * @param {boolean} isOfficial
 * @param {number} count
 */
async function startSubjectAdaptiveRun(ctx, subjectIdOrKey, isOfficial, count = 10) {
  await ctx.answerCbQuery('🧠 AI savollar tayyorlanmoqda...').catch(() => {});
  const data = await resolveSubjectData(subjectIdOrKey, isOfficial);

  if (!data || !data.blocks || data.blocks.length === 0) {
    return ctx.reply('❌ Fan yoki uning testlari topilmadi.').catch(() => {});
  }

  const chatId = ctx.chat?.id || ctx.from?.id;
  const userId = ctx.from?.id;

  const msg = await ctx.reply(
    `⏳ <i>AI "${escapeHtml(data.title)}" fanidan siz uchun maxsus ${count} ta adaptiv savol tayyorlamoqda...</i> 🧠`,
    { parse_mode: 'HTML' }
  ).catch(() => null);

  let finalQuestions = [];

  // 1. Try finding previous mistakes
  try {
    const stats = await dbService.getUserStats(userId);
    const history = stats?.history || [];
    const mistakes = history
      .filter(r =>
        r &&
        (
          r.subject === data.title ||
          r.subjectKey === data.subjectKey ||
          r.subjectId === data.id ||
          r.subject === data.subjectKey
        ) &&
        Array.isArray(r.mistakes) &&
        r.mistakes.length > 0
      )
      .flatMap(r => r.mistakes);

    if (mistakes.length > 0) {
      const aiService = require('../services/aiService');
      const shuffledMistakes = deepClone(mistakes);
      shuffleArray(shuffledMistakes);

      try {
        const aiQs = await aiService.generateAdaptiveQuiz(data.title, shuffledMistakes, count);
        if (Array.isArray(aiQs) && aiQs.length > 0) {
          finalQuestions = aiQs.filter(q => q && q.question && Array.isArray(q.options) && q.options.length >= 2);
        }
      } catch (aiErr) {
        logger.warn('AI adaptive generation fallback to raw mistakes:', aiErr.message);
      }

      if (!finalQuestions.length) {
        finalQuestions = shuffledMistakes.slice(0, count);
      }
    }
  } catch (err) {
    logger.warn('Error reading mistakes for adaptive test:', err.message);
  }

  // 2. If no mistakes yet, pull diverse questions from across all blocks
  if (!finalQuestions.length) {
    const allQuestions = data.blocks.flatMap(b => b.questions || []);
    if (allQuestions.length > 0) {
      const shuffled = deepClone(allQuestions);
      shuffleArray(shuffled);
      finalQuestions = shuffled.slice(0, count);
    }
  }

  if (msg && ctx.telegram?.deleteMessage) {
    await ctx.telegram.deleteMessage(chatId, msg.message_id).catch(() => {});
  }

  if (!finalQuestions.length) {
    return ctx.reply('❌ Ushbu fandan test savollari topilmadi.').catch(() => {});
  }

  const testData = {
    questions: finalQuestions,
    block_name: `🎯 AI Adaptiv Test (${finalQuestions.length} ta)`,
    subject: data.title,
  };

  const { initAndStartTest, startUgcTest, checkActiveTestConflict } = require('./quizGame');
  const mutex = require('../core/mutex');

  if (isOfficial) {
    const unlock = await mutex.lock(`start_test:${chatId}`);
    try {
      if (await checkActiveTestConflict(ctx, chatId)) return;
      return await initAndStartTest(chatId, ctx.telegram, data.subjectKey, 'adaptive', testData, ctx.from.id, 'private');
    } finally {
      unlock();
    }
  } else {
    return startUgcTest(ctx, {
      ...testData,
      id: `adapt_${data.id}`,
      title: `${data.title} — AI Adaptiv`,
    });
  }
}

/**
 * Registers all action handlers for Universal Test Hub.
 *
 * @param {object} bot - Telegraf bot instance
 */
function register(bot) {
  if (!bot || typeof bot.action !== 'function') return;

  // 1. Subject Hub launcher: hub_subj_{srcTag}_{id}
  bot.action(/^hub_subj_(off|ugc)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    await showSubjectHub(ctx, id, { isOfficial: srcTag === 'off' });
  });

  // 2. Block Hub launcher: hub_block_{srcTag}_{id}
  bot.action(/^hub_block_(off|ugc)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    await showBlockHub(ctx, id, { isOfficial: srcTag === 'off' });
  });

  // 3. Subject Mock Exam: hub_mock_{srcTag}_{id}
  bot.action(/^hub_mock_(off|ugc)_(.+)$/, async (ctx) => {
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    await startSubjectMockExam(ctx, id, srcTag === 'off');
  });

  // 4. Subject Marathon: hub_seq_{srcTag}_{id}
  bot.action(/^hub_seq_(off|ugc)_(.+)$/, async (ctx) => {
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    await startSubjectMarathon(ctx, id, srcTag === 'off');
  });

  // 5. Flashcard Picker: hub_cram_pick_{srcTag}_{id}
  bot.action(/^hub_cram_pick_(off|ugc)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    await showFlashcardPicker(ctx, id, srcTag === 'off');
  });

  // 6. Flashcard Blitz: hub_cram_blitz_{srcTag}_{id}
  bot.action(/^hub_cram_blitz_(off|ugc)_(.+)$/, async (ctx) => {
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    await startSubjectBlitzCards(ctx, id, srcTag === 'off');
  });

  // 7. Individual Blocks List view: hub_blocks_{srcTag}_{id}
  bot.action(/^hub_blocks_(off|ugc)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    if (srcTag === 'off') {
      const { cbSubject } = require('./quizGame');
      ctx.callbackQuery.data = `subj_${id}`;
      return cbSubject(ctx);
    } else {
      const { showUgcSubjectBlocks } = require('./quizGame');
      return showUgcSubjectBlocks(ctx, id);
    }
  });

  // 8. Start Block Test: hub_start_{srcTag}_{id}
  bot.action(/^hub_start_(off|ugc)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const srcTag = ctx.match[1];
    const rawId = ctx.match[2];
    if (srcTag === 'off') {
      const parts = rawId.split('_');
      const testId = parseInt(parts.pop(), 10);
      const subjectKey = parts.join('_');
      const { initAndStartTest, checkActiveTestConflict } = require('./quizGame');
      const mutex = require('../core/mutex');
      const memDb = getMemoryDb();
      const testData = (memDb[subjectKey] || {})[testId];
      if (testData) {
        const unlock = await mutex.lock(`start_test:${ctx.chat.id}`);
        try {
          if (await checkActiveTestConflict(ctx, ctx.chat.id)) return;
          return await initAndStartTest(ctx.chat.id, ctx.telegram, subjectKey, testId, testData, ctx.from.id, 'private');
        } finally {
          unlock();
        }
      }
    } else {
      const { startUgcTest } = require('./quizGame');
      const testData = await dbService.getUserTest(rawId);
      if (testData) {
        return startUgcTest(ctx, testData);
      }
    }
  });

  // 9. Blitz Block (10 questions): hub_blitz_{srcTag}_{id}
  bot.action(/^hub_blitz_(off|ugc)_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('⚡ Blitz savollar tayyorlanmoqda...').catch(() => {});
    const srcTag = ctx.match[1];
    const rawId = ctx.match[2];
    const block = await resolveBlockData(rawId, srcTag === 'off');
    if (!block || !block.questions.length) {
      return ctx.reply('❌ Savollar topilmadi.').catch(() => {});
    }
    const shuffled = deepClone(block.questions);
    shuffleArray(shuffled);
    const blitzQs = shuffled.slice(0, 10);
    const testData = {
      questions: blitzQs,
      block_name: `${block.blockName} (⚡ 10 Blitz)`,
      subject: block.subjectTitle,
    };
    const { initAndStartTest, startUgcTest, checkActiveTestConflict } = require('./quizGame');
    const mutex = require('../core/mutex');
    if (block.isOfficial) {
      const unlock = await mutex.lock(`start_test:${ctx.chat.id}`);
      try {
        if (await checkActiveTestConflict(ctx, ctx.chat.id)) return;
        return await initAndStartTest(ctx.chat.id, ctx.telegram, block.subjectKey, 'blitz', testData, ctx.from.id, 'private');
      } finally {
        unlock();
      }
    } else {
      return startUgcTest(ctx, { ...testData, id: `blitz_${block.id}` });
    }
  });

  // 10. AI Adaptive Picker: hub_adapt_{srcTag}_{id}
  bot.action(/^hub_adapt_(off|ugc)_(.+)$/, async (ctx) => {
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    await showAdaptivePicker(ctx, id, srcTag === 'off');
  });

  // 11. AI Adaptive Run: hub_adprun_{srcTag}_{id}_{count}
  bot.action(/^hub_adprun_(off|ugc)_(.+)_(\d+)$/, async (ctx) => {
    const srcTag = ctx.match[1];
    const id = ctx.match[2];
    const count = parseInt(ctx.match[3], 10) || 10;
    await startSubjectAdaptiveRun(ctx, id, srcTag === 'off', count);
  });
}

module.exports = {
  resolveSubjectData,
  resolveBlockData,
  showSubjectHub,
  showBlockHub,
  showFlashcardPicker,
  showAdaptivePicker,
  startSubjectMockExam,
  startSubjectAdaptiveRun,
  startSubjectBlitzCards,
  startSubjectMarathon,
  setMemoryDb,
  register,
};
