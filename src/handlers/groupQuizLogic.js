'use strict';

const { Markup } = require('telegraf');
const sessionService = require('../services/sessionService');
const dbService = require('../services/dbService');
const { safeDelete } = require('../core/utils');

// Kutish zalini chizish (yaratish yoki yangilash) uchun yordamchi funksiya
async function renderLobby(ctx, chatId, room, messageId = null) {
  const users = Object.values(room.readyUsers);
  let usersList = users.map((name, i) => `<b>${i + 1}.</b> ${name}`).join('\n');
  
  if (!usersList) {
    usersList = "<i>Hali hech kim qo'shilmadi...</i>";
  }

  const modeText = room.mode === 'marathon' ? '🏆 <b>Rejim:</b> MARAFON (Barcha bloklar)' : '📝 <b>Rejim:</b> Bitta Blok';
  
  const text = `🎯 <b>MUSOBAQA KUTISH ZALI</b>\n\n` +
               `${modeText}\n` +
               `📚 <b>Fan:</b> ${room.testData.subject} ${room.mode === 'block' ? '| 🔖 ' + room.testData.block_name : ''}\n\n` +
               `👥 <b>Qatnashchilar (${users.length}):</b>\n${usersList}\n\n` +
               `<i>⚠️ Testni faqatgina muallif (${room.initiatorName}) boshlay oladi.</i>`;

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
    }).catch(() => {});
  } else {
    // Yangi xabar yuboramiz
    await ctx.telegram.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(buttons)
    });
  }
}

// 1. Kutish zalini yaratish (startgroup dan kelganda)
// 1. Kutish zalini yaratish (startgroup dan kelganda)
async function createLobby(ctx, param) {
  const chatId = ctx.chat.id;
  let testData = null;
  let mode = '';
  let isOfficial = false;
  const memDb = require('../core/bot').memoryDb || {};

  if (param.startsWith('t_')) {
    const id = param.split('_')[1];
    testData = await dbService.getUserTest(id);
    if (!testData) return ctx.reply("❌ Test topilmadi yoki o'chirilgan.");
    mode = 'block';
  } else if (param.startsWith('s_')) {
    const id = param.split('_')[1];
    testData = await dbService.getUserTest(id); 
    if (!testData) return ctx.reply("❌ Fan topilmadi.");
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
    readyUsers: {} 
  };
  
  room.readyUsers[ctx.from.id] = room.initiatorName;
  await sessionService.setWaitingRoom(chatId, room);
  await renderLobby(ctx, chatId, room);
}

// 2. Qatnashish tugmasi bosilganda
async function cbRoomReady(ctx) {
  const chatId = ctx.chat.id;
  const { mutex } = require('../core/bot'); // Try to get mutex if exported, otherwise require
  const localMutex = require('../core/mutex');
  
  const unlock = await localMutex.lock(`room_ready:${chatId}`);
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

// 3. Testni boshlash tugmasi bosilganda (Faqat muallif uchun)
// 3. Testni boshlash tugmasi bosilganda (Faqat muallif uchun)
async function cbRoomStart(ctx) {
  const chatId = ctx.chat.id;
  try {
    const room = await sessionService.getWaitingRoom(chatId);
    if (!room) return ctx.answerCbQuery('Kutish zali yopilgan!', { show_alert: true }).catch(() => {});

    if (ctx.from.id !== room.initiatorId) {
      return ctx.answerCbQuery('⚠️ Faqat testni boshlagan kishi ishga tushira oladi!', { show_alert: true }).catch(() => {});
    }

    if (Object.keys(room.readyUsers).length < 2) {
      return ctx.answerCbQuery("⚠️ O'yinni boshlash uchun kamida 2 kishi qo'shilishi kerak!", { show_alert: true }).catch(() => {});
    }

    await sessionService.deleteWaitingRoom(chatId);
    const { safeDelete } = require('../core/utils');
    await safeDelete(ctx); // Kutish zali xabarini o'chiramiz

  let marathonBlocks = [];
    let currentBlockIdx = 0;
    let sessionQ = [];
    let testId = '';
    let blockName = '';

    const { prepareShuffledQuestions } = require('../core/questionUtils');
    const dbService = require('../services/dbService');
    const { memoryDb: memDb } = require('../core/bot');

  if (room.mode === 'marathon') {
      const subjectKey = room.testData.subject;
      
      if (room.isOfficial) {
        // Rasmiy testlar marafoni
        const blocksInfo = memDb[subjectKey] || {};
        marathonBlocks = Object.values(blocksInfo).map(b => ({
             test_id: b.test_id,
             block_name: `${b.test_id}-Blok`,
             questions: b.questions
        })).sort((a, b) => parseInt(a.test_id) - parseInt(b.test_id));
      } else {
        // UGC (Foydalanuvchi) testlar marafoni
        const tests = await dbService.getUserCreatedTests(room.testData.creator_id);
        marathonBlocks = tests
            .filter(t => t.subject === subjectKey)
            .sort((a, b) => a.id - b.id);
      }
          
      if (!marathonBlocks.length) return ctx.reply("❌ Bu fanda bloklar topilmadi.");

      sessionQ = prepareShuffledQuestions(marathonBlocks[0].questions);
      testId = marathonBlocks[0].test_id || marathonBlocks[0].id; // Rasmiy va UGC IDlari
      blockName = marathonBlocks[0].block_name;
    } else {
      sessionQ = prepareShuffledQuestions(room.testData.questions);
      testId = room.param.split('_').pop(); 
      blockName = room.testData.block_name;
    }

    // O'yin sessiyasini yaratamiz
    await sessionService.setActiveTest(chatId, {
      chatType: 'group',
      initiatorId: room.initiatorId,
      subjectKey: room.testData.subject,
      testId: testId,
      blockName: blockName,
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
      finished: false,
      status: 'running',
      
      // Marafon uchun maxsus xotira
      isMarathon: room.mode === 'marathon',
      marathonBlocks: marathonBlocks,
      currentBlockIdx: currentBlockIdx,
      marathonGlobalScores: {} 
    });

    const modeLabel = room.mode === 'marathon' ? `🏆 MARAFON: ${marathonBlocks.length} ta blok ketma-ket` : `📝 Bitta Blok: ${blockName}`;
    
    const msg = await ctx.telegram.sendMessage(
      chatId,
      `🚀 <b>Musobaqa boshlanmoqda!</b>\n\n👥 <b>Qatnashchilar:</b> ${Object.keys(room.readyUsers).length} ta\n${modeLabel}\n\n<b>3️⃣</b>`,
      { parse_mode: 'HTML' }
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
  }
}

// 4. Bekor qilish tugmasi (Faqat muallif uchun)
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
    await ctx.reply("❌ Musobaqa bekor qilindi.");
  } catch (e) {
    console.error('cbRoomCancel error:', e.message);
  }
}
// 5. Marafonda keyingi blokni boshlash tugmasi (Faqat muallif uchun)
async function cbRoomNextBlock(ctx) {
  const chatId = ctx.chat.id;
  try {
     const session = await sessionService.getActiveTest(chatId);
     if (!session || !session.isMarathon) return ctx.answerCbQuery("Test topilmadi", {show_alert: true}).catch(()=>{});
     
     if (ctx.from.id !== session.initiatorId) {
         return ctx.answerCbQuery("⚠️ Faqat test muallifi keyingi blokni boshlay oladi!", {show_alert: true}).catch(()=>{});
     }

     await ctx.answerCbQuery().catch(()=>{});
     const { safeDelete } = require('../core/utils');
     await safeDelete(ctx); // Tugmali xabarni o'chiramiz

     const nextBlock = session.marathonBlocks[session.currentBlockIdx];
     await ctx.telegram.sendMessage(chatId, `🚀 <b>${session.currentBlockIdx + 1}-Blok (${nextBlock.block_name}) boshlanmoqda!</b>\n\nDiqqatni jamlang!`, { parse_mode: "HTML" });
     
     const { sendNextQuestion } = require('./coreQuiz');
     await sendNextQuestion(chatId, ctx.telegram);
  } catch(e) {
     console.error('cbRoomNextBlock err:', e.message);
  }
}
module.exports = { 
  createLobby, 
  cbRoomReady, 
  cbRoomStart, 
  cbRoomCancel,
  cbRoomNextBlock,
};