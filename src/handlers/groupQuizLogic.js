'use strict';

const { Markup }            = require('telegraf');
const sessionService        = require('../services/sessionService');
const { SUBJECTS }          = require('../config/config');
const { prepareShuffledQuestions } = require('../core/questionUtils');
const { safeDelete, backToMainKb } = require('../core/utils');
const { sendNextQuestion }  = require('./coreQuiz');
const logger                = require('../core/logger');

const wait = ms => new Promise(r => setTimeout(r, ms));

async function initAndStartTest(chatId, telegram, subjectKey, testId, testData, initiatorId, chatType) {
  try {
    const sessionQ = prepareShuffledQuestions(testData.questions);
    await sessionService.setActiveTest(chatId, {
      chatType, initiatorId, subjectKey, testId,
      blockName:         testData.block_name || '',
      sessionQuestions:  sessionQ,
      qIdx:              0,
      startTime:         Date.now(),
      pollId:            null,
      msgId:             null,
      correct:           0,
      wrong:             0,
      mistakes:          [],
      consecutiveTimeouts: 0,
      groupScores:       {},
      finished:          false,
      status:            'preparing',
    });

    // Telemetry
    logger.info('test:start', {
      chatId,
      subject: subjectKey,
      testId,
      type: chatType,
      questionCount: sessionQ.length,
    });

    const tLabel = testId === 'mock' ? 'Aralash Test' : `${testId}-Blok`;
    await telegram.sendMessage(
      chatId,
      `🚀 <b>Testga tayyorgarlik</b>\n\n` +
      `📚 Fan: <b>${SUBJECTS[subjectKey] || subjectKey}</b>\n` +
      `📝 Blok: <b>${tLabel}</b>\n` +
      `🔢 Jami: <b>${sessionQ.length} ta savol</b>\n` +
      `⏱ Har savolga: <b>30 soniya</b>\n\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `💡 <i>Savollar aralashtirilib beriladi. Tayyor bo'lsangiz — boshlang!</i>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('✅ Tayyorman!', 'user_ready_start')]]),
      },
    );
  } catch (e) {
    console.error(`initAndStartTest error [${chatId}]:`, e.message);
  }
}

async function sendWaitingRoomMessage(ctx, chatId, subjectKey, testId, questionCount) {
  const tLabel = testId === 'mock' ? 'Aralash' : `${testId}-Blok`;
  await ctx.telegram.sendMessage(
    chatId,
    `👥 <b>Guruh Rejimi — Kutish Zali</b>\n\n` +
    `📚 ${SUBJECTS[subjectKey] || 'Fan'} — ${tLabel}\n` +
    `🔢 Savollar: <b>${questionCount} ta</b>\n\n` +
    `<i>\"✅ Tayyorman\" tugmasini bosing. Kamida 2 kishi tayyorlanishi kerak.</i>`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Tayyorman! (0)', 'room_ready')],
        [Markup.button.callback('❌ Bekor qilish',   'room_cancel')],
      ]),
    },
  );
}

async function cbRoomReady(ctx) {
  const chatId = ctx.chat.id;
  try {
    const room = await sessionService.getWaitingRoom(chatId);
    if (!room) return ctx.answerCbQuery('Kutish zali yopilgan!', { show_alert: true }).catch(() => {});
    if (room.readyUsers.has(ctx.from.id)) return ctx.answerCbQuery('✅ Siz allaqachon tayyorsiz!').catch(() => {});

    room.readyUsers.add(ctx.from.id);
    await sessionService.setWaitingRoom(chatId, room);

    const count   = room.readyUsers.size;
    const buttons = [[Markup.button.callback(`✅ Tayyorman! (${count})`, 'room_ready')]];
    if (count >= 2) buttons.push([Markup.button.callback('🚀 Testni Boshlash!', 'room_start')]);
    buttons.push([Markup.button.callback('❌ Bekor qilish', 'room_cancel')]);

    try { await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(buttons).reply_markup); } catch { /* no change */ }
    await ctx.answerCbQuery(`✅ Tayyor! Jami: ${count} kishi`).catch(() => {});
  } catch (e) {
    console.error('cbRoomReady error:', e.message);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi.', { show_alert: true }).catch(() => {});
  }
}

async function cbRoomStart(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const chatId = ctx.chat.id;
  try {
    const room = await sessionService.getWaitingRoom(chatId);
    if (!room) return;

    if (ctx.from.id !== room.initiatorId) {
      return ctx.answerCbQuery('⚠️ Faqat testni boshlagan kishi ishga tushira oladi!', { show_alert: true }).catch(() => {});
    }
    if (room.readyUsers.size < 2) {
      return ctx.answerCbQuery("⚠️ Kamida 2 kishi tayyor bo'lishi kerak!", { show_alert: true }).catch(() => {});
    }

    await sessionService.deleteWaitingRoom(chatId);
    await safeDelete(ctx);

    const sessionQ = prepareShuffledQuestions(room.testData.questions);
    await sessionService.setActiveTest(chatId, {
      chatType:          'group',
      initiatorId:       room.initiatorId,
      subjectKey:        room.subjectKey,
      testId:            room.testId,
      blockName:         room.testData.block_name || '',
      sessionQuestions:  sessionQ,
      qIdx:              0,
      startTime:         Date.now(),
      pollId:            null,
      msgId:             null,
      correct:           0,
      wrong:             0,
      mistakes:          [],
      consecutiveTimeouts: 0,
      groupScores:       {},
      finished:          false,
      status:            'running',
    });

    // Telemetry
    logger.info('test:start', {
      chatId,
      subject: room.subjectKey,
      testId: room.testId,
      type: 'group',
      participants: room.readyUsers.size,
      questionCount: sessionQ.length,
    });

    const msg = await ctx.telegram.sendMessage(
      chatId,
      `🚀 <b>Guruh Testi boshlanmoqda!</b>\n\n👥 ${room.readyUsers.size} kishi qatnashmoqda\n🔢 Jami: ${sessionQ.length} ta savol\n\n<b>3️⃣</b>`,
      { parse_mode: 'HTML' },
    );

    for (const emoji of ['2️⃣', '1️⃣']) {
      await wait(1000);
      await ctx.telegram.editMessageText(chatId, msg.message_id, undefined,
        `🚀 <b>Guruh Testi boshlanmoqda!</b>\n\n👥 ${room.readyUsers.size} kishi qatnashmoqda\n🔢 Jami: ${sessionQ.length} ta savol\n\n<b>${emoji}</b>`,
        { parse_mode: 'HTML' },
      ).catch(() => {});
    }
    await wait(1000);
    await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, '🚀 <b>BOSHLADIK!</b> Omad! 🍀', { parse_mode: 'HTML' }).catch(() => {});

    await sendNextQuestion(chatId, ctx.telegram);
  } catch (e) {
    console.error('cbRoomStart error:', e.message);
  }
}

async function cbRoomCancel(ctx) {
  const chatId = ctx.chat.id;
  try {
    const room = await sessionService.getWaitingRoom(chatId);
    if (!room) return ctx.answerCbQuery('Kutish zali allaqachon yopilgan.', { show_alert: true }).catch(() => {});
    if (ctx.from.id !== room.initiatorId) {
      return ctx.answerCbQuery('⚠️ Faqat testni boshlagan kishi bekor qila oladi!', { show_alert: true }).catch(() => {});
    }
    await sessionService.deleteWaitingRoom(chatId);
    await safeDelete(ctx);
    await ctx.reply('❌ Test bekor qilindi.', backToMainKb());
  } catch (e) {
    console.error('cbRoomCancel error:', e.message);
  }
}

module.exports = { initAndStartTest, sendWaitingRoomMessage, cbRoomReady, cbRoomStart, cbRoomCancel };