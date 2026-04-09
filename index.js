'use strict';

const { Telegraf, session } = require('telegraf');
const express               = require('express');
const cron                  = require('node-cron'); // CRON: Ertalabki xabarlar uchun

const { BOT_TOKEN }         = require('./config');
const botModule             = require('./bot');
const storage               = require('./storage');
const statsManager          = require('./statsManager');
const { setMemoryDb }       = require('./keyboards');
const { States, getState }  = require('./utils');
const { getFormattedSchedule } = require('./edupageApi'); // Jadval API

// ─── Handlers ────────────────────────────────────────────────
const basicHandlers  = require('./handlers/basicHandlers');
const testCreation   = require('./handlers/testCreation');
const adminHandlers  = require('./handlers/adminHandlers');
const statsHandlers  = require('./handlers/statsHandlers');
const quizGame       = require('./handlers/quizGame');

// ─── Bot ─────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

bot.use(session({
  defaultSession: () => ({ state: null, data: {} }),
}));

// ─── Handler ro'yxati ────────────────────────────────────────
basicHandlers.register(bot);
testCreation.register(bot);
adminHandlers.register(bot);
statsHandlers.register(bot);
quizGame.register(bot);

// ─── Global message handler (FSM router) ─────────────────────
bot.on('message', async (ctx, next) => {
  const state = getState(ctx);
  if (!state) return next();

  // UGC test yaratish
  if (state === States.CREATE_SUBJECT) {
    if (ctx.message.text) return testCreation.onSubjectInput(ctx);
  }
  if (state === States.CREATE_NAME) {
    if (ctx.message.text) return testCreation.onNameInput(ctx);
  }
  if (state === States.CREATE_QUESTIONS) {
    if (ctx.message.document) return testCreation.onDocxFile(ctx);
    return testCreation.onQuestionMessage(ctx);
  }

  // Admin rasmiy test
  if (state === States.ADM_CREATE_TEST_ID) {
    if (ctx.message.text) return adminHandlers.onAdmTestId(ctx);
  }
  if (state === States.ADM_CREATE_CONTENT) {
    if (ctx.message.document) return adminHandlers.onAdmDocxContent(ctx);
    if (ctx.message.text)     return adminHandlers.onAdmTextContent(ctx);
  }

  // Admin broadcast
  if (state === States.ADMIN_BROADCAST) {
    if (ctx.message.text) return adminHandlers.onBroadcastMessage(ctx);
  }

  // Admin reply
  if (state === States.ADMIN_REPLY) {
    if (ctx.message.text) return adminHandlers.onReplyMessage(ctx);
  }

  // Foydalanuvchi murojaat
  if (state === States.USER_CONTACT) {
    if (ctx.message.text) return adminHandlers.onContactMessage(ctx);
  }

  return next();
});

bot.on('poll_answer', async (ctx) => {
  await quizGame.handlePollAnswer(ctx.pollAnswer, ctx.telegram);
});

bot.catch((err, ctx) => {
  console.error(`Bot xatosi [${ctx?.updateType}]:`, err.message);
});

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('📦 Testlar yuklanmoqda...');
  botModule.memoryDb = storage.initStorage();

  try {
    const dbTests = await statsManager.loadAllOfficialTests();
    for (const [subj, tests] of Object.entries(dbTests)) {
      if (!botModule.memoryDb[subj]) botModule.memoryDb[subj] = {};
      Object.assign(botModule.memoryDb[subj], tests);
    }
    console.log('✅ Supabase testlari ham yuklandi.');
  } catch (e) {
    console.warn('⚠️ Supabase testlari yuklanmadi:', e.message);
  }

  setMemoryDb(botModule.memoryDb);

  // ==============================================================
  // 1. RENDER UCHUN EXPRESS VEB-SERVER (Uyquga ketmasligi uchun)
  // ==============================================================
  const app  = express();
  const port = parseInt(process.env.PORT || '8080', 10);
  app.get('/', (_, res) => res.send('Bot 100% aktiv va ishlab turibdi! 🚀'));
  app.listen(port, () => console.log(`🌐 Web server ishga tushdi (Port: ${port})`));

  // ==============================================================
  // 2. AVTOMATIK JADVAL YUBORISH (Node-Cron)
  // Har kuni soat 07:30 da (Dushanbadan Shanbagacha)
  // ==============================================================
  cron.schedule('30 07 * * 1-6', async () => {
    console.log('⏰ Avtomatik dars jadvali tarqatish boshlandi...');
    try {
      // statsManager orqali barcha userlarni olamiz
      const allUsers = await statsManager.getAllUsers(); 
      if (!allUsers) return;

      const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
      const dayOfWeek = (date.getDay() + 6) % 7; 

      if (dayOfWeek === 6) return; // Yakshanba kuni yuborilmaydi

      let sentCount = 0;
      for (const user of allUsers) {
        if (user.class_name) {
          try {
            const scheduleText = await getFormattedSchedule(user.class_name, dayOfWeek);
            if (!scheduleText.includes('Jadval topilmadi') && !scheduleText.includes('xatolik')) {
               await bot.telegram.sendMessage(
                 user.telegram_id, 
                 `🌤 <b>Xayrli tong! Bugungi darsingiz:</b>\n\n🎓 <b>Guruh: ${user.class_name}</b>\n${scheduleText}`,
                 { parse_mode: 'HTML' }
               );
               sentCount++;
               // Telegram spam-limitiga (sekundiga 30 ta) tushmaslik uchun ozgina kutamiz
               await new Promise(r => setTimeout(r, 50)); 
            }
          } catch (e) { /* Xatolikni inkor qilamiz */ }
        }
      }
      console.log(`✅ Avtomatik jadval ${sentCount} ta talabaga yuborildi!`);
    } catch (error) {
      console.error('Avtomatik jadval tarqatishda xatolik:', error);
    }
  }, { timezone: "Asia/Tashkent" });

  // 3) Bot polling
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log('🤖 Bot ishga tushdi...');
  await bot.launch();
}

main().catch(err => {
  console.error('Ishga tushishda xato:', err);
  process.exit(1);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));