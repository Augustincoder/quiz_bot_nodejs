'use strict';

const { Markup } = require('telegraf');
const { SUBJECTS } = require('../config/config');
const dbService = require('../services/dbService');
const redisConnection = require('../services/redisService');
const {
  safeEdit,
  parseSuffix,
  escapeHtml,
  safeAnswerCb,
  backToMainKb,
} = require('../core/utils');

/**
 * Flashcard fan menyusini ko'rsatish
 */
async function cbFlashcardMenu(ctx) {
  await safeAnswerCb(ctx);
  const buttons = Object.entries(SUBJECTS).map(([key, name]) => [
    Markup.button.callback(`📇 ${name}`, `flash_subj_${key}`),
  ]);
  buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]);

  const text =
    `📇 <b>Flashcard (Kartochkalar) Rejimi</b>\n\n` +
    `Bu rejim sizning avvalgi xatolaringizni tezkor savol-javob shaklida takrorlash imkonini beradi.\n\n` +
    `<i>Boshlash uchun fanni tanlang:</i>`;

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

/**
 * Flashcard fani tanlanganda
 */
async function cbFlashcardSubject(ctx) {
  const subjectKey = parseSuffix(ctx.callbackQuery?.data || '', 'flash_subj_');
  const userId = ctx.from.id;

  try {
    const mistakes = await dbService.getUserMistakes(userId, subjectKey, 20);
    if (!mistakes || mistakes.length < 3) {
      return safeAnswerCb(ctx, "⚠️ Kamida 3 ta xatolik bo'lganda ishlaydi!", {
        show_alert: true,
      });
    }

    await safeAnswerCb(ctx);

    const state = {
      cards: mistakes,
      idx: 0,
      known: 0,
      unknown: 0,
      subjectKey,
    };

    await redisConnection.set(
      `flash:${userId}`,
      JSON.stringify(state),
      'EX',
      1800,
    );

    await sendFlashcard(ctx, userId, 0);
  } catch (error) {
    console.error('cbFlashcardSubject xatosi:', error.message);
    await safeAnswerCb(ctx, '⚠️ Xatolik yuz berdi.', { show_alert: true });
  }
}

/**
 * Flashcard savolini yuborish
 */
async function sendFlashcard(ctx, userId, idx) {
  try {
    const rawState = await redisConnection.get(`flash:${userId}`);
    if (!rawState) {
      return safeEdit(ctx, '⚠️ Flashcard sessiyasi tugagan.', backToMainKb());
    }

    const state = JSON.parse(rawState);
    if (!state.cards || idx >= state.cards.length) {
      return showCompletionSummary(ctx, userId, state);
    }

    state.idx = idx;
    await redisConnection.set(
      `flash:${userId}`,
      JSON.stringify(state),
      'EX',
      1800,
    );

    const card = state.cards[idx];
    const progress = `[${idx + 1}/${state.cards.length}]`;
    const subjName = SUBJECTS[state.subjectKey] || state.subjectKey;

    const questionText = card.question || "Savol matni yo'q";

    const text =
      `📇 <b>Flashcard ${progress}</b> — <i>${escapeHtml(subjName)}</i>\n\n` +
      `❓ <b>Savol:</b>\n` +
      `${escapeHtml(questionText)}`;

    const buttons = [
      [Markup.button.callback("💡 Javobni ko'rish", `flash_rev_${idx}`)],
      [Markup.button.callback("⏭ O'tkazib yuborish", `flash_skip_${idx}`)],
      [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
    ];

    await safeEdit(ctx, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (error) {
    console.error('sendFlashcard xatosi:', error.message);
  }
}

/**
 * Javobni ko'rsatish
 */
async function cbFlashcardReveal(ctx) {
  await safeAnswerCb(ctx);
  const idx = parseInt(
    parseSuffix(ctx.callbackQuery?.data || '', 'flash_rev_'),
    10,
  );
  const userId = ctx.from.id;

  try {
    const rawState = await redisConnection.get(`flash:${userId}`);
    if (!rawState) {
      return safeEdit(ctx, '⚠️ Flashcard sessiyasi tugagan.', backToMainKb());
    }

    const state = JSON.parse(rawState);
    if (!state.cards || isNaN(idx) || !state.cards[idx]) {
      return showCompletionSummary(ctx, userId, state);
    }

    const card = state.cards[idx];
    const progress = `[${idx + 1}/${state.cards.length}]`;
    const subjName = SUBJECTS[state.subjectKey] || state.subjectKey;

    const questionText = card.question || "Savol matni yo'q";
    const correctAnsText =
      card.correct_ans || card.correct || "Noma'lum";

    const text =
      `📇 <b>Flashcard ${progress}</b> — <i>${escapeHtml(subjName)}</i>\n\n` +
      `❓ <b>Savol:</b>\n` +
      `${escapeHtml(questionText)}\n\n` +
      `💡 <b>To'g'ri javob:</b>\n` +
      `✅ <b>${escapeHtml(correctAnsText)}</b>`;

    const buttons = [
      [
        Markup.button.callback('✔️ Bilardim', `flash_know_${idx}`),
        Markup.button.callback('❌ Bilmasdim', `flash_unk_${idx}`),
      ],
      [Markup.button.callback("⏭ O'tkazib yuborish", `flash_skip_${idx}`)],
      [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
    ];

    await safeEdit(ctx, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (error) {
    console.error('cbFlashcardReveal xatosi:', error.message);
  }
}

/**
 * Bilardim / Bilmasdim / O'tkazib yuborish amallari
 */
async function cbFlashcardAction(ctx) {
  await safeAnswerCb(ctx);
  const data = ctx.callbackQuery?.data || '';
  const userId = ctx.from.id;

  let idx = 0;
  let actionType = '';

  if (data.startsWith('flash_know_')) {
    actionType = 'know';
    idx = parseInt(parseSuffix(data, 'flash_know_'), 10);
  } else if (data.startsWith('flash_unk_')) {
    actionType = 'unk';
    idx = parseInt(parseSuffix(data, 'flash_unk_'), 10);
  } else if (data.startsWith('flash_skip_')) {
    actionType = 'skip';
    idx = parseInt(parseSuffix(data, 'flash_skip_'), 10);
  }

  try {
    const rawState = await redisConnection.get(`flash:${userId}`);
    if (!rawState) {
      return safeEdit(ctx, '⚠️ Flashcard sessiyasi tugagan.', backToMainKb());
    }

    const state = JSON.parse(rawState);

    if (actionType === 'know') {
      state.known = (state.known || 0) + 1;
    } else if (actionType === 'unk') {
      state.unknown = (state.unknown || 0) + 1;
    }

    const nextIdx = (isNaN(idx) ? state.idx || 0 : idx) + 1;
    state.idx = nextIdx;

    await redisConnection.set(
      `flash:${userId}`,
      JSON.stringify(state),
      'EX',
      1800,
    );

    await sendFlashcard(ctx, userId, nextIdx);
  } catch (error) {
    console.error('cbFlashcardAction xatosi:', error.message);
  }
}

/**
 * Flashcard yakunlash xabarini ko'rsatish
 */
async function showCompletionSummary(ctx, userId, state) {
  await redisConnection.del(`flash:${userId}`).catch(() => {});

  const total = state?.cards?.length || 0;
  const known = state?.known || 0;
  const unknown = state?.unknown || 0;
  const skipped = Math.max(0, total - known - unknown);
  const subjName =
    SUBJECTS[state?.subjectKey] || state?.subjectKey || 'Tanlangan fan';

  const text =
    `🏁 <b>Flashcard Mashg'uloti Yakunlandi!</b>\n\n` +
    `📚 Fan: <b>${escapeHtml(subjName)}</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `✔️ Bilardim:    <b>${known} ta</b>\n` +
    `❌ Bilmasdim:  <b>${unknown} ta</b>\n` +
    `⏭ O'tkazildi:  <b>${skipped} ta</b>\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `<i>Xatolaringiz ustida ishlash davom etadi. Keyingi safar natijangiz yanada yaxshi bo'ladi!</i>`;

  const buttons = [
    [
      Markup.button.callback(
        '🔁 Qaytadan ishlash',
        `flash_subj_${state?.subjectKey}`,
      ),
    ],
    [Markup.button.callback('📇 Fan tanlash menyusi', 'flash_menu')],
    [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
  ];

  await safeEdit(ctx, text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard(buttons),
  });
}

function register(bot) {
  bot.action('flash_menu', cbFlashcardMenu);
  bot.action(/^flash_subj_(.+)$/, cbFlashcardSubject);
  bot.action(/^flash_rev_(\d+)$/, cbFlashcardReveal);
  bot.action(/^flash_know_(\d+)$/, cbFlashcardAction);
  bot.action(/^flash_unk_(\d+)$/, cbFlashcardAction);
  bot.action(/^flash_skip_(\d+)$/, cbFlashcardAction);
}

module.exports = {
  register,
  cbFlashcardMenu,
  cbFlashcardSubject,
  sendFlashcard,
  cbFlashcardReveal,
  cbFlashcardAction,
  showCompletionSummary,
};
