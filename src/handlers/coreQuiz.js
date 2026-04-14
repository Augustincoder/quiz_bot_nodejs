'use strict';

const { Markup }        = require('telegraf');
const mutex             = require('../core/mutex');
const { SUBJECTS }      = require('../config/config');
const dbService         = require('../services/dbService');
const sessionService    = require('../services/sessionService');
const { userNameCache, safePercent, grade, progressBar, TTLMap } = require('../core/utils');

const lastMistakesCache = new TTLMap(3600_000);

function resolveTestName(tId, blockName) {
  if (String(tId) === 'mock')     return '🎲 Aralash Test';
  if (String(tId) === 'adaptive') return '🎯 AI Adaptiv Test';
  if (String(tId).startsWith('ugc_')) return `📝 ${blockName || 'Maxsus Test'}`;
  return `${tId}-Blok`;
}

function buildFinishButtons(tId, subjectKey, hasMistakes) {
  const btns = [];
  if (hasMistakes) btns.push([Markup.button.callback("❌ Xatolarni ko'rish", 'review_mistakes')]);

  const sid = String(tId);
  if (sid.startsWith('ugc_')) {
    btns.push([Markup.button.callback('🔁 Qayta ishlash', `ugc_start_${sid.replace('ugc_', '')}`)]);
  } else if (sid === 'mock') {
    btns.push([Markup.button.callback('🎲 Yana aralash', `mock_${subjectKey}`)]);
  } else if (sid === 'adaptive') {
    btns.push([Markup.button.callback('🎯 Yana adaptiv', `adaptive_${subjectKey}`)]);
  } else {
    btns.push([Markup.button.callback('🔁 Qayta ishlash', `post_start_${subjectKey}_${tId}`)]);
    const memDb = require('../core/bot').memoryDb || {};
    if ((memDb[subjectKey] || {})[tId + 1]) {
      btns.push([Markup.button.callback(`➡️ Keyingi (${tId + 1}-Blok)`, `post_start_${subjectKey}_${tId + 1}`)]);
    }
  }

  btns.push([Markup.button.callback('📥 Javonga saqlash', 'shelf_save_init')]);
  btns.push([
    Markup.button.callback('🔙 Fan menyusi', `post_subj_${subjectKey}`),
    Markup.button.callback('🏠 Asosiy', 'post_main'),
  ]);
  return btns;
}

async function sendNextQuestion(chatId, telegram) {
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session) return;
    if (session.qIdx >= session.sessionQuestions.length) return finishTest(chatId, telegram);

    const q        = session.sessionQuestions[session.qIdx];
    const progress = `[${session.qIdx + 1}/${session.sessionQuestions.length}]`;
    const qFull    = `${progress} ${q.question}`;
    const needsSplit = qFull.length > 255 || q.options.some(o => o.length > 100);

    let pollQ, pollOpts;
    if (needsSplit) {
      const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
      let text = `📑 <b>Savol ${progress}</b>\n\n${q.question}\n\n`
        + q.options.map((opt, i) => `<b>${labels[i]})</b> ${opt}`).join('\n');
      if (text.length > 4000) text = text.slice(0, 3900) + '\n<i>...(matn kesildi)</i>';
      await telegram.sendMessage(chatId, text, { parse_mode: 'HTML' });
      pollQ    = `${progress} To'g'ri variantni belgilang:`;
      pollOpts = q.options.map((_, i) => `${labels[i]} varianti`);
    } else {
      pollQ    = qFull;
      pollOpts = q.options;
    }

    let msg;
    try {
      msg = await telegram.sendPoll(chatId, pollQ, pollOpts, {
        type: 'quiz', correct_option_id: q.correct_index, is_anonymous: false, open_period: 30,
      });
    } catch (e) {
      console.error(`sendPoll error [${chatId}]:`, e.message);
      return;
    }

    session.pollId = msg.poll.id;
    session.msgId  = msg.message_id;
    await sessionService.setActiveTest(chatId, session);
    await sessionService.setPollChat(msg.poll.id, String(chatId));

    const { quizTimerQueue } = require('../jobs/queues');
    await quizTimerQueue.add(
      'timeout',
      { chatId, expectedIdx: session.qIdx, pollId: msg.poll.id },
      { delay: 31_000, jobId: `timeout:${chatId}:${session.qIdx}`, removeOnComplete: true },
    );
  } catch (e) {
    console.error(`sendNextQuestion fatal [${chatId}]:`, e.message);
  }
}

async function finishTest(chatId, telegram) {
  const session = await sessionService.getActiveTest(chatId);
  if (!session || session.finished) return;
  session.finished = true;

  const tId      = session.testId;
  const tName    = resolveTestName(tId, session.blockName);
  const subjName = SUBJECTS[session.subjectKey] || session.subjectKey;
  const elapsed  = Math.floor((Date.now() - session.startTime) / 1000);
  const time     = `${Math.floor(elapsed / 60).toString().padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`;

  let text;
  let buttons = [];

  try {
    if (session.chatType === 'private') {
      lastMistakesCache.set(chatId, [...session.mistakes]);

      dbService.updateUserStats(chatId, session.correct, session.wrong, session.subjectKey, tId, session.mistakes)
        .catch(e => console.error('Stats update error:', e.message));

      const total   = session.correct + session.wrong;
      const skipped = session.sessionQuestions.length - total;
      const pct     = safePercent(session.correct, total);

      text =
        `🏁 <b>Test Yakunlandi!</b>\n\n` +
        `📚 ${subjName} — ${tName}\n` +
        `${progressBar(Math.round(pct), 100)}\n\n` +
        `✅ To'g'ri:    <b>${session.correct} ta</b>\n` +
        `❌ Xato:       <b>${session.wrong} ta</b>\n` +
        `⏭ O'tkazildi: <b>${skipped} ta</b>\n\n` +
        `🎯 Natija: <b>${pct}%</b> — ${grade(pct)}\n` +
        `⏱ Vaqt: <b>${time}</b>`;

      const { pendingShelfSaves } = require('../core/pendingStore');
      pendingShelfSaves.set(chatId, {
        testId: tId, testName: tName, subject: session.subjectKey,
        questions: session.sessionQuestions || [], progress: null,
      });

      buttons = buildFinishButtons(tId, session.subjectKey, session.mistakes.length > 0);
    } else {
      await Promise.allSettled(
        Object.entries(session.groupScores).map(([uid, sc]) =>
          dbService.updateUserStats(uid, sc.correct, sc.wrong, session.subjectKey, tId, sc.mistakes),
        ),
      );

      const entries = Object.values(session.groupScores);
      const medals  = ['🥇', '🥈', '🥉'];
      const body    = entries.length
        ? entries.sort((a, b) => b.correct - a.correct)
            .map((s, i) => `${medals[i] ?? '🔸'} <b>${s.name}</b>: ${s.correct} to'g'ri, ${s.wrong} xato`)
            .join('\n')
        : '😔 Hech kim javob bermadi.';

      text =
        `🏁 <b>Test Yakunlandi!</b>\n\n` +
        `📚 ${subjName} — ${tName}\n` +
        `⏱ Vaqt: <b>${time}</b>\n\n` +
        `🏆 <b>Natijalar:</b>\n${body}`;

      buttons = [
        [Markup.button.callback('🔙 Fan menyusi', `post_subj_${session.subjectKey}`)],
        [Markup.button.callback('🏠 Asosiy Menyu', 'post_main')],
      ];
    }

    await telegram.sendMessage(chatId, text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  } catch (e) {
    console.error(`finishTest send error [${chatId}]:`, e.message);
  } finally {
    if (session.pollId) await sessionService.deletePollChat(session.pollId).catch(() => {});
    await sessionService.deleteActiveTest(chatId).catch(() => {});
  }
}

async function handlePollAnswer(pollAnswer, telegram) {
  const pollId = pollAnswer.poll_id;
  const chatId = await sessionService.getPollChat(pollId);
  if (!chatId) return;

  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session || session.pollId !== pollId) return;

    const qData     = session.sessionQuestions[session.qIdx];
    const isCorrect = pollAnswer.option_ids[0] === qData.correct_index;
    const uId       = pollAnswer.user.id;
    const uName     = [pollAnswer.user.first_name, pollAnswer.user.last_name].filter(Boolean).join(' ') || 'Foydalanuvchi';
    userNameCache.set(uId, uName);

    if (session.chatType === 'private') {
      session.consecutiveTimeouts = 0;
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
      await sessionService.setActiveTest(chatId, session);
      await sendNextQuestion(chatId, telegram);
    } else {
      if (!session.groupScores[uId]) session.groupScores[uId] = { name: uName, correct: 0, wrong: 0, mistakes: [] };
      const sc = session.groupScores[uId];
      if (isCorrect) {
        sc.correct++;
      } else {
        sc.wrong++;
        sc.mistakes.push({
          question:    qData.question,
          correct_ans: qData.correct_text || qData.options[qData.correct_index],
          wrong_ans:   qData.options[pollAnswer.option_ids[0]],
        });
      }
      await sessionService.setActiveTest(chatId, session);
    }
  } finally {
    unlock();
  }
}

async function questionTimeout(chatId, expectedIdx, pollId, telegram) {
  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
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
        const remaining = session.sessionQuestions.length - session.qIdx;
        await sessionService.setActiveTest(chatId, session);
        await telegram.sendMessage(
          chatId,
          `⏸ <b>Test to'xtatildi!</b>\n\n` +
          `Ketma-ket 2 ta savolga javob bermadingiz.\n\n` +
          `📊 <b>Joriy natija:</b>\n` +
          `✅ To'g'ri: <b>${session.correct} ta</b>\n` +
          `❌ Xato:    <b>${session.wrong} ta</b>\n` +
          `📌 Qolgan:  <b>${remaining} ta savol</b>\n\n` +
          `Davom etasizmi?`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('▶️ Davom etaman', 'resume_test')],
              [Markup.button.callback('🏁 Yakunlash',    'force_finish')],
            ]),
          },
        );
        return;
      }
    }

    await sessionService.setActiveTest(chatId, session);
    await sendNextQuestion(chatId, telegram);
  } finally {
    unlock();
  }
}

module.exports = { sendNextQuestion, finishTest, handlePollAnswer, questionTimeout, lastMistakesCache, resolveTestName };