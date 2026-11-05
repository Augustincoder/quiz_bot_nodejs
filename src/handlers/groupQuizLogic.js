'use strict';

const { Markup } = require('telegraf');
const mutex = require('../core/mutex');
const sessionService = require('../services/sessionService');
const dbService = require('../services/dbService');
const { resolveShareParam } = require('../services/shareService');
const { safeDelete, escapeHtml, naturalSortBlocks } = require('../core/utils');

// Kutish zalini chizish (yaratish yoki yangilash) uchun yordamchi funksiya
async function renderLobby(ctx, chatId, room, messageId = null) {
  const users = Object.values(room.readyUsers);
  const displayUsers = users.slice(0, 30);
  let usersList = displayUsers.map((name, i) => `<b>${i + 1}.</b> ${escapeHtml(name)}`).join('\n');
  if (users.length > 30) {
    usersList += `\n<i>...va yana ${users.length - 30} nafar qatnashchi</i>`;
  }
  
  if (!usersList) {
    usersList = "<i>Hali hech kim qo'shilmadi...</i>";
  }

  const modeText = room.mode === 'marathon' ? '🏆 <b>Rejim:</b> MARAFON (Barcha bloklar)' : '📝 <b>Rejim:</b> Bitta Blok';
  
  const text = `🎯 <b>MUSOBAQA KUTISH ZALI</b>\n\n` +
               `${modeText}\n` +
               `📚 <b>Fan:</b> ${escapeHtml(room.testData.subject || '')} ${room.mode === 'block' ? '| 🔖 ' + escapeHtml(room.testData.block_name || '') : ''}\n\n` +
               `👥 <b>Qatnashchilar (${users.length}):</b>\n${usersList}\n\n` +
               `<i>⚠️ Testni faqatgina muallif (${escapeHtml(room.initiatorName || 'Muallif')}) boshlay oladi.</i>`;

  const buttons = [
    [Markup.button.callback('✋ Qatnashish', 'room_ready')],
    [
      Markup.button.callback('▶️ Boshlash', 'room_start'),
      Markup.button.callback('❌ Bekor qilish', 'room_cancel')
    ]
  ];

  if (messageId) {
    // Agar oldin yuborilgan bo'lsa, xabarni tahrirlaymiz
    await ctx.telegram.editMessageText(chatId, messageId, undefined, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    }).catch((err) => {
      if (!err?.description?.includes('message is not modified')) {
        console.error('renderLobby edit error:', err.message);
      }
    });
  } else {
    const sendOpts = {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    };
    if (room.messageThreadId) sendOpts.message_thread_id = room.messageThreadId;
    await ctx.telegram.sendMessage(chatId, text, sendOpts).catch((err) => console.error('renderLobby send error:', err.message));
  }
}

// 1. Kutish zalini yaratish (startgroup dan kelganda)
async function createLobby(ctx, param) {
  const chatId = ctx.chat.id;
  const activeSession = await sessionService.getActiveTest(chatId);
  if (activeSession && activeSession.status === 'running') {
    return ctx.reply("⚠️ Ushbu guruhda allaqachon faol test ketmoqda!\n\nYangi test boshlash uchun avval joriy testni yakunlang yoki /stop buyrug'ini yuboring.");
  }
  const messageThreadId = ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id || null;
  let testData = null;
  let mode = '';
  let isOfficial = false;
  const memDb = require('../core/bot').memoryDb || {};

  const resolved = resolveShareParam(param);

  if (resolved.type === 't') {
    if (resolved.isInvalid || !resolved.id) return ctx.reply("❌ Test topilmadi yoki havola yaroqsiz.");
    testData = await dbService.getUserTest(resolved.id);
    if (!testData) return ctx.reply("❌ Test topilmadi yoki o'chirilgan.");
    mode = 'block';
  } else if (resolved.type === 's') {
    if (resolved.isInvalid || !resolved.id) return ctx.reply("❌ Fan topilmadi yoki havola yaroqsiz.");
    const rawId = resolved.id;
    let subject = await dbService.getSubjectById(rawId);
    if (subject) {
      const blocks = await dbService.getSubjectBlocks(subject.id);
      if (!blocks.length) return ctx.reply("❌ Bu fanda bloklar topilmadi.");
      testData = {
        ...blocks[0],
        subject: subject.name,
        subject_id: subject.id,
      };
    } else {
      testData = await dbService.getUserTest(rawId);
      if (!testData) return ctx.reply("❌ Fan topilmadi.");
      if (testData.subject_id) {
        const s = await dbService.getSubjectById(testData.subject_id);
        if (s) testData.subject = s.name;
      }
    }
    mode = 'marathon';
  } else if (param.startsWith('offt_')) { 
    // Rasmiy test (Blok)
    const parts = param.split('_');
    const testId = parts.pop();
    const subject = parts.slice(1).join('_');
    testData = (memDb[subject] || {})[testId];
    if (!testData) return ctx.reply("❌ Rasmiy test topilmadi.");
    testData.subject = subject; 
    testData.block_name = `${testId}-Blok`;
    mode = 'block';
    isOfficial = true;
  } else if (param.startsWith('offs_')) { 
    // Rasmiy test (Marafon)
    const subject = param.replace('offs_', '');
    const blocks = memDb[subject] || {};
    const firstBlockId = Object.keys(blocks)[0];
    if (!firstBlockId) return ctx.reply("❌ Bu fanda rasmiy testlar yo'q.");
    testData = blocks[firstBlockId];
    testData.subject = subject;
    mode = 'marathon';
    isOfficial = true;
  } else {
    return ctx.reply("⚠️ Noma'lum havola.");
  }

  const room = {
    initiatorId: ctx.from.id,
    initiatorName: ctx.from.first_name || 'Muallif',
    param: param,
    testData: testData,
    mode: mode,
    isOfficial: isOfficial, // Rasmiy ekanligini belgilab qo'yamiz
    messageThreadId: messageThreadId,
    readyUsers: {} 
  };
  
  room.readyUsers[ctx.from.id] = room.initiatorName;
  await sessionService.setWaitingRoom(chatId, room);
  await renderLobby(ctx, chatId, room);
}

// 2. Qatnashish tugmasi bosilganda
async function cbRoomReady(ctx) {
  const chatId = ctx.chat.id;
  const unlock = await mutex.lock(`room_ready:${chatId}`);
  try {
    const room = await sessionService.getWaitingRoom(chatId);
    if (!room) return ctx.answerCbQuery('Kutish zali yopilgan!', { show_alert: true }).catch(() => {});

    if (room.readyUsers[ctx.from.id]) {
      return ctx.answerCbQuery("✅ Siz allaqachon ro'yxatdasiz!", { show_alert: true }).catch(() => {});
    }

    // Foydalanuvchini qo'shamiz va xotirani yangilaymiz
    room.readyUsers[ctx.from.id] = ctx.from.first_name || 'Foydalanuvchi';
    await sessionService.setWaitingRoom(chatId, room);
    
    // Ro'yxatni jonli yangilaymiz
    await renderLobby(ctx, chatId, room, ctx.callbackQuery.message.message_id);
    await ctx.answerCbQuery("Ro'yxatga qo'shildingiz!").catch(() => {});
  } catch (e) {
    console.error('cbRoomReady error:', e.message);
  } finally {
    unlock();
  }
}

async function canManageLobbyOrGame(ctx, chatId, userId, initiatorId) {
  if (userId === initiatorId) return true;
  const config = require('../config/config');
  if (config.ADMIN_IDS && config.ADMIN_IDS.map(Number).includes(Number(userId))) return true;
  if (ctx.chat?.type !== 'private') {
    try {
      const member = await ctx.telegram.getChatMember(chatId, userId);
      if (member && (member.status === 'creator' || member.status === 'administrator')) {
        return true;
      }
    } catch {}
  }
  return false;
}

// 3. Testni boshlash tugmasi bosilganda (Muallif yoki Guruh Admini uchun)
async function cbRoomStart(ctx) {
  const chatId = ctx.chat.id;
  const unlock = await mutex.lock(`room_start:${chatId}`);
  try {
    const room = await sessionService.getWaitingRoom(chatId);
    if (!room) return ctx.answerCbQuery('Kutish zali yopilgan!', { show_alert: true }).catch(() => {});

    const canManage = await canManageLobbyOrGame(ctx, chatId, ctx.from.id, room.initiatorId);
    if (!canManage) {
      return ctx.answerCbQuery('⚠️ Faqat test muallifi yoki guruh admini ishga tushira oladi!', { show_alert: true }).catch(() => {});
    }

    if (Object.keys(room.readyUsers).length < 2) {
      return ctx.answerCbQuery("⚠️ O'yinni boshlash uchun kamida 2 kishi qo'shilishi kerak!", { show_alert: true }).catch(() => {});
    }

    await sessionService.deleteWaitingRoom(chatId);
    const { groupTestCache } = require('./coreQuiz');
    await groupTestCache.delete(chatId);
    const { safeDelete } = require('../core/utils');
    await safeDelete(ctx); // Kutish zali xabarini o'chiramiz

  let marathonBlocks = [];
    let currentBlockIdx = 0;
    let sessionQ = [];
    let testId = '';
    let blockName = '';

    const { prepareShuffledQuestions, deepClone } = require('../core/questionUtils');
    const dbService = require('../services/dbService');
    const { memoryDb: memDb } = require('../core/bot');

    const messageThreadId = room.messageThreadId || ctx.message?.message_thread_id || ctx.callbackQuery?.message?.message_thread_id || null;

    if (room.mode === 'marathon') {
      const subjectKey = room.testData.subject;
      
      if (room.isOfficial) {
        // Rasmiy testlar marafoni
        const blocksInfo = memDb[subjectKey] || {};
        marathonBlocks = Object.values(blocksInfo).map(b => ({
             test_id: b.test_id,
             block_name: `${b.test_id}-Blok`,
             questions: deepClone(b.questions || [])
        })).sort((a, b) => parseInt(a.test_id) - parseInt(b.test_id));
      } else {
        // UGC (Foydalanuvchi) testlar marafoni
        if (room.testData.subject_id) {
          const blocks = await dbService.getSubjectBlocks(room.testData.subject_id);
          marathonBlocks = blocks.map(t => ({
            ...t,
            questions: deepClone(t.questions || [])
          }));
        } else {
          const tests = await dbService.getUserCreatedTests(room.testData.creator_id);
          marathonBlocks = naturalSortBlocks(tests
              .filter(t => t.subject === subjectKey)
              .map(t => ({
                ...t,
                questions: deepClone(t.questions || [])
              }))
          );
        }
      }
          
      if (!marathonBlocks.length) return ctx.reply("❌ Bu fanda bloklar topilmadi.");

      sessionQ = prepareShuffledQuestions(marathonBlocks[0].questions);
      testId = marathonBlocks[0].test_id || (marathonBlocks[0].id ? `ugc_${marathonBlocks[0].id}` : marathonBlocks[0].id); // Rasmiy va UGC IDlari
      blockName = marathonBlocks[0].block_name;
    } else {
      sessionQ = prepareShuffledQuestions(deepClone(room.testData.questions || []));
      testId = room.isOfficial ? room.param.split('_').pop() : (room.testData?.id ? `ugc_${room.testData.id}` : room.testId || room.param); 
      blockName = room.testData.block_name;
    }

    // O'yin sessiyasini yaratamiz
    await sessionService.setActiveTest(chatId, {
      chatType: 'group',
      initiatorId: room.initiatorId,
      creatorId: room.testData?.creator_id || null,
      subjectKey: room.testData.subject,
      subjectId: room.testData.subject_id || null,
      testId: testId,
      blockName: blockName,
      messageThreadId: messageThreadId,
      sessionQuestions: sessionQ,
      qIdx: 0,
      startTime: Date.now(),
      pollId: null,
      msgId: null,
      correct: 0,
      wrong: 0,
      mistakes: [],
      consecutiveTimeouts: 0,
      groupScores: {},
      expectedParticipantsCount: Object.keys(room.readyUsers || {}).length,
      finished: false,
      status: 'running',
      transitionLock: null,
      questionState: 'RUNNING',
      
      // Marafon uchun maxsus xotira
      isMarathon: room.mode === 'marathon',
      marathonBlocks: marathonBlocks,
      currentBlockIdx: currentBlockIdx,
      marathonGlobalScores: {} 
    });

    const modeLabel = room.mode === 'marathon' ? `🏆 MARAFON: ${marathonBlocks.length} ta blok ketma-ket` : `📝 Bitta Blok: ${blockName}`;
    
    const startMsgOpts = { parse_mode: 'HTML' };
    if (messageThreadId) startMsgOpts.message_thread_id = messageThreadId;

    const msg = await ctx.telegram.sendMessage(
      chatId,
      `🚀 <b>Musobaqa boshlanmoqda!</b>\n\n👥 <b>Qatnashchilar:</b> ${Object.keys(room.readyUsers).length} ta\n${modeLabel}\n\n<b>3️⃣</b>`,
      startMsgOpts
    );

    // Sanoq
    for (const emoji of ['2️⃣', '1️⃣']) {
      await new Promise(r => setTimeout(r, 1000));
      await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, 
        `🚀 <b>Musobaqa boshlanmoqda!</b>\n\n👥 <b>Qatnashchilar:</b> ${Object.keys(room.readyUsers).length} ta\n${modeLabel}\n\n<b>${emoji}</b>`, 
        { parse_mode: 'HTML' }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 1000));
    await ctx.telegram.editMessageText(chatId, msg.message_id, undefined, '🚀 <b>BOSHLADIK!</b> Diqqat qiling, javob berish uchun 30 soniya vaqtingiz bor! 🍀', { parse_mode: 'HTML' }).catch(() => {});

    // 1-savolni yuboramiz
    const { sendNextQuestion } = require('./coreQuiz');
    await sendNextQuestion(chatId, ctx.telegram);

  } catch (e) {
    console.error('cbRoomStart error:', e.message);
  } finally {
    unlock();
  }
}

// 4. Bekor qilish tugmasi (Muallif yoki Guruh Admini uchun)
async function cbRoomCancel(ctx) {
  const chatId = ctx.chat.id;
  try {
    const room = await sessionService.getWaitingRoom(chatId);
    if (!room) return ctx.answerCbQuery('Kutish zali allaqachon yopilgan.', { show_alert: true }).catch(() => {});

    const canManage = await canManageLobbyOrGame(ctx, chatId, ctx.from.id, room.initiatorId);
    if (!canManage) {
      return ctx.answerCbQuery('⚠️ Faqat test muallifi yoki guruh admini bekor qila oladi!', { show_alert: true }).catch(() => {});
    }

    await sessionService.deleteWaitingRoom(chatId);
    await safeDelete(ctx);
    await ctx.reply("❌ Musobaqa bekor qilindi.");
  } catch (e) {
    console.error('cbRoomCancel error:', e.message);
  }
}
// 5. Marafonda keyingi blokni boshlash tugmasi (Muallif yoki Guruh Admini uchun)
async function cbRoomNextBlock(ctx) {
  const chatId = ctx.chat.id;
  const unlock = await mutex.lock(`room_next:${chatId}`);
  try {
     const session = await sessionService.getActiveTest(chatId);
     if (!session || !session.isMarathon) return ctx.answerCbQuery("Test topilmadi", {show_alert: true}).catch(()=>{});
     
     const canManage = await canManageLobbyOrGame(ctx, chatId, ctx.from.id, session.initiatorId);
     if (!canManage) {
         return ctx.answerCbQuery("⚠️ Faqat test muallifi yoki guruh admini keyingi blokni boshlay oladi!", {show_alert: true}).catch(()=>{});
     }

     if (session.questionState === "ACTIVE" || session.qIdx > 0) {
         return ctx.answerCbQuery("⚠️ Ushbu blok allaqachon boshlangan!", {show_alert: true}).catch(()=>{});
     }

     await ctx.answerCbQuery().catch(()=>{});
     const { safeDelete } = require('../core/utils');
     await safeDelete(ctx); // Tugmali xabarni o'chiramiz

     const nextBlock = session.marathonBlocks?.[session.currentBlockIdx] || {};
     const blockName = nextBlock.block_name || `${session.currentBlockIdx + 1}-Blok`;
     const nextBlockOpts = { parse_mode: "HTML" };
     if (session.messageThreadId) nextBlockOpts.message_thread_id = session.messageThreadId;
     await ctx.telegram.sendMessage(chatId, `🚀 <b>${session.currentBlockIdx + 1}-Blok (${blockName}) boshlanmoqda!</b>\n\nDiqqatni jamlang!`, nextBlockOpts);
     
     const { sendNextQuestion } = require('./coreQuiz');
     await sendNextQuestion(chatId, ctx.telegram);
  } catch(e) {
     console.error('cbRoomNextBlock err:', e.message);
  } finally {
     unlock();
  }
}
module.exports = { 
  createLobby, 
  cbRoomReady, 
  cbRoomStart, 
  cbRoomCancel,
  cbRoomNextBlock,
};