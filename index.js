'use strict';

const { Telegraf, session } = require('telegraf');
const express               = require('express');

const { BOT_TOKEN }         = require('./config');
const botModule             = require('./bot');
const storage               = require('./storage');
const statsManager          = require('./statsManager');
const { setMemoryDb }       = require('./keyboards');
const { States, getState }  = require('./utils');

// ─── Handlers ────────────────────────────────────────────────
const basicHandlers  = require('./handlers/basicHandlers');
const testCreation   = require('./handlers/testCreation');
const adminHandlers  = require('./handlers/adminHandlers');
const statsHandlers  = require('./handlers/statsHandlers');
const quizGame       = require('./handlers/quizGame');

// ─── Bot ─────────────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// Session middleware (FSM uchun)
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
// Barcha text/document xabarlarni holat bo'yicha yo'naltiradi
bot.on('message', async (ctx, next) => {
  const state = getState(ctx);
  if (!state) return next();

  const { ADMIN_ID } = require('./config');

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

// ─── Poll javob ───────────────────────────────────────────────
bot.on('poll_answer', async (ctx) => {
  await quizGame.handlePollAnswer(ctx.pollAnswer, ctx.telegram);
});

// ─── Xatoliklar ───────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`Bot xatosi [${ctx?.updateType}]:`, err.message);
});

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  // 1) Rasmiy testlarni yuklash
  console.log('📦 Testlar yuklanmoqda...');
  botModule.memoryDb = storage.initStorage();

  // Agar Supabase sozlangan bo'lsa, undan ham yukla
  try {
    const dbTests = await statsManager.loadAllOfficialTests();
    // JSON + Supabase ni merge qilamiz (Supabase ustunlik qiladi)
    for (const [subj, tests] of Object.entries(dbTests)) {
      if (!botModule.memoryDb[subj]) botModule.memoryDb[subj] = {};
      Object.assign(botModule.memoryDb[subj], tests);
    }
    console.log('✅ Supabase testlari ham yuklandi.');
  } catch (e) {
    console.warn('⚠️ Supabase testlari yuklanmadi:', e.message);
  }

  // Keyboards uchun memoryDb ulash
  setMemoryDb(botModule.memoryDb);

  // 2) Express veb-server (Render.com uchun)
  const app  = express();
  const port = parseInt(process.env.PORT || '8080', 10);
  app.get('/', (_, res) => res.send('Bot va Testlar muvaffaqiyatli ishlamoqda! 🚀'));
  app.listen(port, () => console.log(`🌐 Web server: http://0.0.0.0:${port}`));

  // 3) Bot polling
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log('🤖 Bot ishga tushdi...');
  await bot.launch();
}

main().catch(err => {
  console.error('Ishga tushishda xato:', err);
  process.exit(1);
});

// Graceful stop
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));