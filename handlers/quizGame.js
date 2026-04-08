'use strict';

const { Markup }   = require('telegraf');
const { SUBJECTS } = require('../config');
const statsManager = require('../statsManager');
const { getBlocksKeyboard } = require('../keyboards');
const { prepareShuffledQuestions, shuffleArray } = require('../questionUtils');
const {
  activeTests, waitingRooms, pollChatMap, userNameCache,
  safeEdit, safeDelete, backToMainKb,
  progressBar, safePercent, grade, parseSuffix,
} = require('../utils');

// ─── Rasmiy testlar ──────────────────────────────────────────

async function cbOfficialTests(ctx) {
  await ctx.answerCbQuery();
  const memDb   = require('../bot').memoryDb;
  const buttons = [];
  for (const [k, v] of Object.entries(SUBJECTS)) {
    const blocks = memDb[k] || {};
    const qCount = Object.values(blocks).reduce((s, b) => s + (b.questions || []).length, 0);
    buttons.push([Markup.button.callback(
      `📘 ${v}  •  ${Object.keys(blocks).length} blok, ${qCount} savol`,
      `subj_${k}`,
    )]);
  }
  buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]);

  await safeEdit(ctx,
    '📚 *Rasmiy Testlar*\n\nAdmin tomonidan tayyorlangan testlar.\n\nFan tanlang:',
    Markup.inlineKeyboard(buttons),
  );
}

async function cbSubject(ctx) {
  await ctx.answerCbQuery();
  const subjectKey = parseSuffix(ctx.callbackQuery.data, 'subj_');
  const subjName   = SUBJECTS[subjectKey] || 'Fan';
  await safeEdit(ctx,
    `📚 *${subjName}*\n\nBlok tanlang yoki Mock Exam yechib ko\'ring:`,
    getBlocksKeyboard(subjectKey, 0),
  );
}

async function cbPage(ctx) {
  await ctx.answerCbQuery();
  const parts = ctx.callbackQuery.data.split('_');
  const page  = parseInt(parts[parts.length - 1], 10);
  // e.g. page_korporativ_1 → subject = korporativ
  const subjectKey = parts.slice(1, parts.length - 1).join('_');
  try {
    await ctx.editMessageReplyMarkup(getBlocksKeyboard(subjectKey, page).reply_markup);
  } catch { /* message not modified */ }
}

// ─── UGC bloklar ────────────────────────────────────────────

async function showUgcSubjectBlocks(ctx, creatorId, subject) {
  const tests     = await statsManager.getUserCreatedTests(creatorId);
  const subjTests = tests.filter(t => t.subject === subject);

  if (!subjTests.length) {
    return ctx.reply('❌ Bu fanda bloklar topilmadi.', backToMainKb());
  }
  const buttons = subjTests.map(t => ([
    Markup.button.callback(
      `📘 ${t.block_name}  •  ${(t.questions || []).length} savol`,
      `ugc_start_${t.id}`,
    ),
  ]));
  buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]);

  await ctx.reply(
    `📚 *${subject}*\n\n${subjTests.length} ta blok mavjud.\nBoshlash uchun blokni tanlang:`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) },
  );
}

async function startUgcTest(ctx, testDb) {
  const chatId = ctx.chat.id;
  if (activeTests.has(chatId) || waitingRooms.has(chatId)) {
    return ctx.reply('⚠️ Bu chatda tugallanmagan test mavjud.\nAvval to\'xtating: /stop');
  }
  const sessionQ = prepareShuffledQuestions(testDb.questions);
  activeTests.set(chatId, {
    chatType:            'private',
    initiatorId:         ctx.from.id,
    subjectKey:          testDb.subject,
    testId:              `ugc_${testDb.id}`,
    blockName:           testDb.block_name || '',
    sessionQuestions:    sessionQ,
    qIdx:                0,
    startTime:           Date.now(),
    pollId:              null,
    msgId:               null,
    timerTask:           null,
    correct:             0,
    wrong:               0,
    mistakes:            [],
    consecutiveTimeouts: 0,
    groupScores:         {},
    finished:            false,
  });
  await ctx.reply(
    `🚀 *Test Boshlandi!*\n\n📚 Fan: ${testDb.subject}\n📝 Blok: ${testDb.block_name || ''}\n🔢 Jami: ${sessionQ.length} ta savol\n⏱ Har savolga 30 soniya\n\n_/stop — testni to\'xtatish_`,
    { parse_mode: 'Markdown' },
  );
  await sendNextQuestion(chatId, ctx.telegram);
}

async function cbUgcStart(ctx) {
  await ctx.answerCbQuery();
  const testId = parseSuffix(ctx.callbackQuery.data, 'ugc_start_');
  const testDb = await statsManager.getUserTest(testId);
  if (!testDb) {
    return ctx.reply('❌ Test topilmadi yoki o\'chirilgan.', backToMainKb());
  }
  await safeDelete(ctx);
  await startUgcTest(ctx, testDb);
}

// ─── Rasmiy/Mock test boshlash ────────────────────────────────

async function cbStartTest(ctx) {
  await ctx.answerCbQuery();
  const chatId  = ctx.chat.id;
  const memDb   = require('../bot').memoryDb;

  if (activeTests.has(chatId) || waitingRooms.has(chatId)) {
    return ctx.answerCbQuery('⚠️ Bu chatda faol test bor!\nAvval to\'xtating: /stop', { show_alert: true });
  }

  const isMock = ctx.callbackQuery.data.startsWith('mock_');
  let subjectKey, testId, testData;

  if (isMock) {
    subjectKey   = parseSuffix(ctx.callbackQuery.data, 'mock_');
    const allQs  = Object.values(memDb[subjectKey] || {}).flatMap(t => t.questions || []);
    if (!allQs.length) return ctx.answerCbQuery('❌ Bu fanda savollar yo\'q!', { show_alert: true });
    // random sample 25
    shuffleArray(allQs);
    testData   = { questions: allQs.slice(0, 25), block_name: 'Aralash Test' };
    testId     = 'mock';
  } else {
    const suffix = parseSuffix(ctx.callbackQuery.data, 'start_test_');
    const parts  = suffix.split('_');
    testId       = parseInt(parts[parts.length - 1], 10);
    subjectKey   = parts.slice(0, -1).join('_');
    testData     = (memDb[subjectKey] || {})[testId];
    if (!testData) return ctx.answerCbQuery('❌ Test topilmadi!', { show_alert: true });
  }

  await safeDelete(ctx);

  // Guruh rejimi
  if (ctx.chat.type !== 'private') {
    waitingRooms.set(chatId, {
      subjectKey,
      testId,
      testData,
      initiatorId: ctx.from.id,
      readyUsers:  new Set(),
    });
    const tLabel = testId === 'mock' ? 'Aralash' : `${testId}-Blok`;
    await ctx.telegram.sendMessage(chatId,
      `👥 *Guruh Rejimi*\n\n📚 ${SUBJECTS[subjectKey] || 'Fan'} | ${tLabel}\n🔢 Savollar: ${testData.questions.length} ta\n\nKamida 2 kishi tayyor bo\'lsa boshlanadi.\nTayyor bo\'lsangiz quyidagi tugmani bosing:`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Tayyorman! (0)', 'room_ready')],
          [Markup.button.callback('❌ Bekor qilish', 'room_cancel')],
        ]),
      },
    );
    return;
  }

  // Shaxsiy rejim
  await initAndStartTest(chatId, ctx.telegram, subjectKey, testId, testData, ctx.from.id, 'private');
}

// ─── Guruh kutish zali ────────────────────────────────────────

async function cbRoomReady(ctx) {
  const chatId = ctx.chat.id;
  const room   = waitingRooms.get(chatId);
  if (!room) return ctx.answerCbQuery('Kutish zali yopilgan!', { show_alert: true });
  if (room.readyUsers.has(ctx.from.id)) return ctx.answerCbQuery('✅ Siz allaqachon tayyorsiz!');

  room.readyUsers.add(ctx.from.id);
  const count   = room.readyUsers.size;
  const buttons = [[Markup.button.callback(`✅ Tayyorman! (${count})`, 'room_ready')]];
  if (count >= 2) buttons.push([Markup.button.callback('🚀 Testni Boshlash!', 'room_start')]);
  buttons.push([Markup.button.callback('❌ Bekor qilish', 'room_cancel')]);

  try {
    await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(buttons).reply_markup);
  } catch { /* not modified */ }
  await ctx.answerCbQuery(`✅ Tayyor! Jami: ${count} kishi`);
}

async function cbRoomStart(ctx) {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const room   = waitingRooms.get(chatId);
  if (!room) return;
  if (room.readyUsers.size < 2) {
    return ctx.answerCbQuery('⚠️ Kamida 2 kishi tayyor bo\'lishi kerak!', { show_alert: true });
  }
  waitingRooms.delete(chatId);
  await safeDelete(ctx);

  const sessionQ = prepareShuffledQuestions(room.testData.questions);
  activeTests.set(chatId, {
    chatType:            'group',
    initiatorId:         room.initiatorId,
    subjectKey:          room.subjectKey,
    testId:              room.testId,
    blockName:           room.testData.block_name || '',
    sessionQuestions:    sessionQ,
    qIdx:                0,
    startTime:           Date.now(),
    pollId:              null,
    msgId:               null,
    timerTask:           null,
    correct:             0,
    wrong:               0,
    mistakes:            [],
    consecutiveTimeouts: 0,
    groupScores:         {},
    finished:            false,
  });

  await ctx.telegram.sendMessage(chatId,
    `🚀 *Test Boshlandi!*\n\n👥 ${room.readyUsers.size} kishi qatnashmoqda\n🔢 Jami: ${sessionQ.length} ta savol\n\n_/stop — testni to\'xtatish_`,
    { parse_mode: 'Markdown' },
  );
  await sendNextQuestion(chatId, ctx.telegram);
}

async function cbRoomCancel(ctx) {
  const chatId = ctx.chat.id;
  const room   = waitingRooms.get(chatId);
  if (!room) return ctx.answerCbQuery('Kutish zali allaqachon yopilgan.', { show_alert: true });
  if (ctx.from.id !== room.initiatorId) {
    return ctx.answerCbQuery('⚠️ Faqat testni boshlagan kishi bekor qila oladi!', { show_alert: true });
  }
  waitingRooms.delete(chatId);
  await safeDelete(ctx);
  await ctx.reply('❌ Test bekor qilindi.');
}

// ─── Savol yuborish ───────────────────────────────────────────

async function initAndStartTest(chatId, telegram, subjectKey, testId, testData, initiatorId, chatType) {
  const sessionQ = prepareShuffledQuestions(testData.questions);
  activeTests.set(chatId, {
    chatType,
    initiatorId,
    subjectKey,
    testId,
    blockName:           testData.block_name || '',
    sessionQuestions:    sessionQ,
    qIdx:                0,
    startTime:           Date.now(),
    pollId:              null,
    msgId:               null,
    timerTask:           null,
    correct:             0,
    wrong:               0,
    mistakes:            [],
    consecutiveTimeouts: 0,
    groupScores:         {},
    finished:            false,
  });
  const tLabel = testId === 'mock' ? 'Aralash Test' : `${testId}-Blok`;
  await telegram.sendMessage(chatId,
    `🚀 *Test Boshlandi!*\n\n📚 Fan: ${SUBJECTS[subjectKey] || subjectKey}\n📝 Blok: ${tLabel}\n🔢 Jami: ${sessionQ.length} ta savol\n⏱ Har savolga: 30 soniya\n\n_/stop — testni to\'xtatish_`,
    { parse_mode: 'Markdown' },
  );
  await sendNextQuestion(chatId, telegram);
}

async function sendNextQuestion(chatId, telegram) {
  const session = activeTests.get(chatId);
  if (!session) return;
  if (session.qIdx >= session.sessionQuestions.length) {
    return finishTest(chatId, telegram);
  }

  const q        = session.sessionQuestions[session.qIdx];
  const progress = `[${session.qIdx + 1}/${session.sessionQuestions.length}]`;
  const qFull    = `${progress} ${q.question}`;

  const needsSplit = qFull.length > 255 || q.options.some(o => o.length > 100);
  let pollQ, pollOpts;

  if (needsSplit) {
    const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
    let text =
      `📑 *Savol ${progress}*\n\n${q.question}\n\n` +
      q.options.map((opt, i) => `*${labels[i]})* ${opt}`).join('\n');
    if (text.length > 4000) text = text.slice(0, 3900) + '\n_(Matn kesildi)_';
    await telegram.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    pollQ    = `${progress} To\'g\'ri variantni belgilang:`;
    pollOpts = q.options.map((_, i) => `${labels[i]} varianti`);
  } else {
    pollQ    = qFull;
    pollOpts = q.options;
  }

  let msg;
  try {
    msg = await telegram.sendPoll(chatId, pollQ, pollOpts, {
      type:              'quiz',
      correct_option_id: q.correct_index,
      is_anonymous:      false,
      open_period:       30,
    });
  } catch (e) {
    console.error(`sendPoll error [${chatId}]:`, e.message);
    return;
  }

  session.pollId = msg.poll.id;
  session.msgId  = msg.message_id;
  pollChatMap.set(msg.poll.id, chatId);

  if (session.timerTask) clearTimeout(session.timerTask);
  const qIdx   = session.qIdx;
  const pollId = msg.poll.id;
  session.timerTask = setTimeout(
    () => questionTimeout(chatId, qIdx, pollId, telegram),
    31_000,   // 30s poll + 1s buffer
  );
}

async function questionTimeout(chatId, expectedIdx, pollId, telegram) {
  const session = activeTests.get(chatId);
  if (!session || session.qIdx !== expectedIdx || session.pollId !== pollId) return;

  try { await telegram.stopPoll(chatId, session.msgId); } catch { /* silent */ }

  const qData = session.sessionQuestions[expectedIdx];
  session.qIdx++;

  if (session.chatType === 'private') {
    session.wrong++;
    session.consecutiveTimeouts++;
    session.mistakes.push({
      question:    qData.question,
      correct_ans: qData.correct_text || qData.options[qData.correct_index],
      wrong_ans:   '⏳ Vaqt tugadi',
    });

    if (session.consecutiveTimeouts >= 2 && session.qIdx < session.sessionQuestions.length) {
      await telegram.sendMessage(chatId,
        '⏸ *Test to\'xtatildi!*\n\nKetma-ket 2 ta savolga javob bermadingiz.\n\nDavom etasizmi?',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('▶️ Davom etaman', 'resume_test')],
            [Markup.button.callback('🏁 Yakunlash', 'force_finish')],
          ]),
        },
      );
      return;
    }
  }
  await sendNextQuestion(chatId, telegram);
}

// ─── Poll javob ───────────────────────────────────────────────

async function handlePollAnswer(pollAnswer, telegram) {
  const chatId  = pollChatMap.get(pollAnswer.poll_id);
  if (!chatId) return;
  const session = activeTests.get(chatId);
  if (!session || session.pollId !== pollAnswer.poll_id) return;

  const qData    = session.sessionQuestions[session.qIdx];
  const isCorrect = pollAnswer.option_ids[0] === qData.correct_index;
  const uId      = pollAnswer.user.id;
  const uName    = pollAnswer.user.first_name
    ? `${pollAnswer.user.first_name}${pollAnswer.user.last_name ? ' ' + pollAnswer.user.last_name : ''}`
    : 'Foydalanuvchi';
  userNameCache.set(uId, uName);

  if (session.chatType === 'private') {
    session.consecutiveTimeouts = 0;
    if (session.timerTask) { clearTimeout(session.timerTask); session.timerTask = null; }
    try { await telegram.stopPoll(chatId, session.msgId); } catch { /* silent */ }

    if (isCorrect) {
      session.correct++;
    } else {
      session.wrong++;
      session.mistakes.push({
        question:    qData.question,
        correct_ans: qData.correct_text || qData.options[qData.correct_index],
        wrong_ans:   qData.options[pollAnswer.option_ids[0]],
      });
    }
    session.qIdx++;
    await sendNextQuestion(chatId, telegram);

  } else {
    // Guruh: har bir foydalanuvchi alohida
    if (!session.groupScores[uId]) {
      session.groupScores[uId] = { name: uName, correct: 0, wrong: 0, mistakes: [] };
    }
    const score = session.groupScores[uId];
    if (isCorrect) {
      score.correct++;
    } else {
      score.wrong++;
      score.mistakes.push({
        question:    qData.question,
        correct_ans: qData.correct_text || qData.options[qData.correct_index],
        wrong_ans:   qData.options[pollAnswer.option_ids[0]],
      });
    }
  }
}

// ─── Test yakunlash ───────────────────────────────────────────

async function finishTest(chatId, telegram) {
  const session = activeTests.get(chatId);
  if (!session || session.finished) return;
  session.finished = true;

  if (session.timerTask) { clearTimeout(session.timerTask); session.timerTask = null; }

  const tId     = session.testId;
  const tName   = String(tId) === 'mock' ? '🎲 Aralash Test'
    : String(tId).startsWith('ugc_') ? `📝 ${session.blockName || 'Maxsus Test'}`
    : `${tId}-Blok`;
  const subjName = SUBJECTS[session.subjectKey] || session.subjectKey;
  const elapsed  = Math.floor((Date.now() - session.startTime) / 1000);
  const mins     = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const secs     = (elapsed % 60).toString().padStart(2, '0');

  let text, buttons = [];

  if (session.chatType === 'private') {
    // Stats saqlash (async, non-blocking)
    statsManager.updateUserStats(
      chatId, session.correct, session.wrong,
      session.subjectKey, tId, session.mistakes,
    ).catch(e => console.error('Stats error:', e.message));

    const total   = session.correct + session.wrong;
    const skipped = session.sessionQuestions.length - total;
    const pct     = safePercent(session.correct, total);
    const bar     = progressBar(parseInt(pct), 100);

    text =
      `🏁 *Test Yakunlandi!*\n\n` +
      `📚 ${subjName} | ${tName}\n\n` +
      `✅ To\'g\'ri: *${session.correct} ta*\n` +
      `❌ Xato: *${session.wrong} ta*\n` +
      `⏭ O\'tkazildi: *${skipped} ta*\n\n` +
      `🎯 Natija: *${pct}%* — ${grade(pct)}\n${bar}\n\n` +
      `⏱ Vaqt: *${mins}:${secs}*`;

    if (session.mistakes.length) {
      buttons.push([Markup.button.callback('❌ Xatolarni ko\'rish', 'review_mistakes')]);
    }

    if (String(tId).startsWith('ugc_')) {
      const rawId = String(tId).replace('ugc_', '');
      buttons.push([Markup.button.callback('🔁 Qayta ishlash', `ugc_start_${rawId}`)]);
      buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'post_main')]);
    } else if (tId === 'mock') {
      buttons.push([Markup.button.callback('🎲 Yana aralash', `mock_${session.subjectKey}`)]);
      buttons.push([Markup.button.callback('🔙 Fan menyusi', `post_subj_${session.subjectKey}`)]);
      buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'post_main')]);
    } else {
      buttons.push([Markup.button.callback('🔁 Qayta ishlash', `post_start_${session.subjectKey}_${tId}`)]);
      const memDb = require('../bot').memoryDb;
      if ((memDb[session.subjectKey] || {})[tId + 1]) {
        buttons.push([Markup.button.callback(`➡️ Keyingi (${tId + 1}-Blok)`, `post_start_${session.subjectKey}_${tId + 1}`)]);
      }
      buttons.push([Markup.button.callback('🔙 Fan menyusi', `post_subj_${session.subjectKey}`)]);
      buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'post_main')]);
    }

  } else {
    // Guruh
    await Promise.allSettled(
      Object.entries(session.groupScores).map(([uid, sc]) =>
        statsManager.updateUserStats(uid, sc.correct, sc.wrong, session.subjectKey, tId, sc.mistakes)
      )
    );

    let body;
    if (!Object.keys(session.groupScores).length) {
      body = '😔 Hech kim javob bermadi.';
    } else {
      const medals  = ['🥇', '🥈', '🥉'];
      const sorted  = Object.values(session.groupScores).sort((a, b) => b.correct - a.correct);
      body = sorted.map((s, i) =>
        `${medals[i] ?? '🔸'} *${s.name}*: ${s.correct} to\'g\'ri, ${s.wrong} xato`
      ).join('\n');
    }
    text =
      `🏁 *Test Yakunlandi!*\n\n` +
      `📚 ${subjName} | ${tName}\n` +
      `⏱ Vaqt: *${mins}:${secs}*\n\n` +
      `🏆 *NATIJALAR:*\n${body}`;
    buttons.push([Markup.button.callback('🔙 Fan menyusi', `post_subj_${session.subjectKey}`)]);
    buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'post_main')]);
  }

  try {
    await telegram.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.error(`finishTest error [${chatId}]:`, e.message);
  } finally {
    if (session.pollId) pollChatMap.delete(session.pollId);
    activeTests.delete(chatId);
  }
}

// ─── Post-test navigatsiya ────────────────────────────────────

async function cbPostMain(ctx) {
  await ctx.answerCbQuery();
  try { await ctx.editMessageReplyMarkup({}); } catch { /* silent */ }
  const { getMainKeyboard } = require('../keyboards');
  await ctx.reply('🏛 *Asosiy Menyu*', { parse_mode: 'Markdown', ...getMainKeyboard() });
}

async function cbPostSubj(ctx) {
  await ctx.answerCbQuery();
  const subjectKey = parseSuffix(ctx.callbackQuery.data, 'post_subj_');
  try { await ctx.editMessageReplyMarkup({}); } catch { /* silent */ }
  await ctx.reply(
    `📚 *${SUBJECTS[subjectKey] || 'Fan'}*\n\nBlokni tanlang:`,
    { parse_mode: 'Markdown', ...getBlocksKeyboard(subjectKey, 0) },
  );
}

async function cbPostStart(ctx) {
  await ctx.answerCbQuery();
  const suffix = parseSuffix(ctx.callbackQuery.data, 'post_start_');
  const parts  = suffix.split('_');
  const testId = parseInt(parts[parts.length - 1], 10);
  const subjectKey = parts.slice(0, -1).join('_');
  const chatId = ctx.chat.id;

  if (activeTests.has(chatId) || waitingRooms.has(chatId)) {
    return ctx.answerCbQuery('⚠️ Avval joriy testni to\'xtating: /stop', { show_alert: true });
  }
  const testData = (require('../bot').memoryDb[subjectKey] || {})[testId];
  if (!testData) return ctx.answerCbQuery('❌ Test topilmadi!', { show_alert: true });
  try { await ctx.editMessageReplyMarkup({}); } catch { /* silent */ }
  await initAndStartTest(chatId, ctx.telegram, subjectKey, testId, testData, ctx.from.id, 'private');
}

async function cbResumeTest(ctx) {
  await ctx.answerCbQuery();
  const chatId  = ctx.chat.id;
  const session = activeTests.get(chatId);
  if (!session) return ctx.answerCbQuery('❌ Test topilmadi.', { show_alert: true });
  session.consecutiveTimeouts = 0;
  await safeDelete(ctx);
  await sendNextQuestion(chatId, ctx.telegram);
}

async function cbForceFinish(ctx) {
  await ctx.answerCbQuery();
  await safeDelete(ctx);
  await finishTest(ctx.chat.id, ctx.telegram);
}

async function cbReviewMistakes(ctx) {
  await ctx.answerCbQuery();
  const stats    = await statsManager.getUserStats(ctx.from.id);
  const history  = stats.history || [];
  const mistakes = history[0]?.mistakes || [];

  if (!mistakes.length) {
    return ctx.answerCbQuery(history.length ? '🎉 Bu testda xato yo\'q edi!' : '❌ Xatolar topilmadi!', { show_alert: true });
  }

  const parts = [`📑 *So\'nggi testdagi xatolar (${mistakes.length} ta):*`];
  for (let i = 0; i < Math.min(mistakes.length, 20); i++) {
    const m = mistakes[i];
    parts.push(`*${i + 1}.* ${m.question}\n❌ ${m.wrong_ans}\n✅ ${m.correct_ans}`);
  }
  if (mistakes.length > 20) parts.push(`_...va yana ${mistakes.length - 20} ta xato_`);

  let text = parts.join('\n\n');
  if (text.length > 4000) text = text.slice(0, 3900) + '\n\n_(Matn kesildi)_';

  await safeEdit(ctx, text,
    Markup.inlineKeyboard([[Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]]));
}

// ─── Register ────────────────────────────────────────────────
function register(bot) {
  bot.action('official_tests',          cbOfficialTests);
  bot.action(/^subj_/,                  cbSubject);
  bot.action(/^page_/,                  cbPage);
  bot.action(/^start_test_/,            cbStartTest);
  bot.action(/^mock_/,                  cbStartTest);
  bot.action(/^ugc_start_/,             cbUgcStart);
  bot.action('room_ready',              cbRoomReady);
  bot.action('room_start',              cbRoomStart);
  bot.action('room_cancel',             cbRoomCancel);
  bot.action('resume_test',             cbResumeTest);
  bot.action('force_finish',            cbForceFinish);
  bot.action('review_mistakes',         cbReviewMistakes);
  bot.action('post_main',               cbPostMain);
  bot.action(/^post_subj_/,             cbPostSubj);
  bot.action(/^post_start_/,            cbPostStart);
}

module.exports = {
  register,
  finishTest,
  sendNextQuestion,
  handlePollAnswer,
  showUgcSubjectBlocks,
  startUgcTest,
};