"use strict";
require("dotenv").config();
const { Telegraf } = require("telegraf");
const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
//redis connection
const redisConnection = require("./src/services/redisService");
// sentry
const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");
const logger = require("./src/core/logger");

Sentry.init({
  dsn: process.env.SENTRY_DSN, // Sentry.io dan olingan link
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
});

// redis va BullMQ
const { broadcastQueue } = require("./src/jobs/queues");
const initWorkers = require("./src/jobs/workers");
// redis session service
const sessionService = require("./src/services/sessionService");
// ─── Infratuzilma va Xizmatlar ───────────────────────────────
const { BOT_TOKEN, DATA_DIR, SUBJECTS } = require("./src/config/config");
const storage = require("./src/core/storage");
const botModule = require("./src/core/bot");
const dbService = require("./src/services/dbService");
const scheduleService = require("./src/services/scheduleService");
const { setMemoryDb } = require("./src/keyboards/keyboards");
const { States, getState, userNameCache } = require("./src/core/utils");

// ─── Boshqaruvchilar (Handlers) ──────────────────────────────
const startHandler = require("./src/handlers/startHandler");
const profileHandler = require("./src/handlers/profileHandler");
const scheduleHandler = require("./src/handlers/scheduleHandler");
const testCreation = require("./src/handlers/testCreation");
const adminHandlers = require("./src/handlers/adminHandlers");
const statsHandlers = require("./src/handlers/statsHandlers");
const quizGame = require("./src/handlers/quizGame");
const aiHandlers = require("./src/handlers/aiHandlers");
const shelfHandlers = require("./src/handlers/shelfHandlers");
const aiTestsHandlers = require("./src/handlers/aiTestsHandlers");

// index.js faylida
const contactAdmin = require('./src/handlers/contactAdmin');
// ─── Botni ishga tushirish ───────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ─── Redis Session Middleware ───
bot.use(async (ctx, next) => {
  const key = `tg_session:${ctx.from?.id || ctx.chat?.id || "unknown"}`;
  try {
    const sessionData = await redisConnection.get(key);
    ctx.session = sessionData
      ? JSON.parse(sessionData)
      : { state: null, data: {} };

    await next(); // Keyingi funksiyalarni ishlatish

    // Javob berib bo'lgach, sessiyani yana Redis'ga saqlab qo'yamiz (24 soatga)
    await redisConnection.set(key, JSON.stringify(ctx.session), "EX", 86400);
  } catch (err) {
    console.error("Session Redis xatosi:", err);
    ctx.session = { state: null, data: {} };
  }
});

// ─── Handlerlarni ulash ──────────────────────────────────────
startHandler.register(bot);
profileHandler.register(bot);
scheduleHandler.register(bot);
testCreation.register(bot);
adminHandlers.register(bot);
statsHandlers.register(bot);
quizGame.register(bot);
aiHandlers.register(bot);
shelfHandlers.register(bot);
aiTestsHandlers.register(bot);
contactAdmin.register(bot);
// Bot komandalarini ulash
bot.command("start", (ctx) => startHandler.cbStart(ctx));
bot.command("profile", (ctx) => profileHandler.cbProfile(ctx));
bot.command("schedule", (ctx) => scheduleHandler.cbSchedule(ctx));
bot.command("stop", async (ctx) => {
  // YANGILANISH: Redis'dan qidiramiz
  const existingSession = await sessionService.getActiveTest(
    ctx.chat?.id || ctx.from?.id,
  );

  if (!existingSession) {
    return ctx.reply("⚠️ Faol test yo'q.");
  }

  await quizGame.cbStopTest(ctx);
});

// ─── Global Matnli Xabarlar (State Router) ───────────────────
bot.on("message", async (ctx, next) => {
  const state = getState(ctx);
  if (!state) return next();

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

  if (state === States.CREATE_AI_TEXT) {
    if (ctx.message.text) return testCreation.onAiTextInput(ctx);
  }
  if (state === States.CREATE_AI_QUESTIONS) {
    if (ctx.message.text) return testCreation.onAiQuestionsInput(ctx);
  }
  // SHU QATORNI QO'SHING:
  if (state === States.CREATE_AI_IMAGE) {
    if (ctx.message.photo) return testCreation.onAiImageInput(ctx);
  }
  if (state === States.CREATE_AI_TEXT) {
    if (ctx.message.text) return testCreation.onAiTextInput(ctx);
  }
  if (state === States.AI_ESSAY_ANALYSIS) {
    if (ctx.message.text) return aiHandlers.onEssayInput(ctx);
  }
  if (state === States.CREATE_SHELF_FOLDER) {
    if (ctx.message.text) return shelfHandlers.onNewFolderInput(ctx);
  }
  if (state === States.CREATE_AI_QUESTIONS) {
    if (ctx.message.text) return testCreation.onAiQuestionsInput(ctx);
  }
  if (state === States.ADM_CREATE_TEST_ID) {
    if (ctx.message.text) return adminHandlers.onAdmTestId(ctx);
  }
  if (state === States.ADM_CREATE_CONTENT) {
    if (ctx.message.document) return adminHandlers.onAdmDocxContent(ctx);
    if (ctx.message.text) return adminHandlers.onAdmTextContent(ctx);
  }

  if (state === States.ADMIN_BROADCAST) {
    if (ctx.message.text) return adminHandlers.onBroadcastMessage(ctx);
  }
  if (state === States.ADMIN_REPLY) {
    if (ctx.message.text) return adminHandlers.onReplyMessage(ctx);
  }
  if (state === States.USER_CONTACT) {
    if (ctx.message.text) return adminHandlers.onContactMessage(ctx);
  }

  return next();
});

bot.on("poll_answer", async (ctx) => {
  await quizGame.handlePollAnswer(ctx.pollAnswer, ctx.telegram);
});

bot.catch((err, ctx) => {
  // Xatoni Sentry orqali telefoningizga jo'natadi
  Sentry.withScope((scope) => {
    scope.setUser({ id: ctx?.from?.id, username: ctx?.from?.username });
    scope.setContext("telegram", {
      updateType: ctx?.updateType,
      chatId: ctx?.chat?.id,
      callbackData: ctx?.callbackQuery?.data,
    });
    Sentry.captureException(err);
  });

  // Xatoni serverdagi logs/error.log fayliga chiroyli qilib yozadi
  logger.error(`Bot xatosi [${ctx?.updateType}]: ${err.message}`, {
    stack: err.stack,
  });
});

// ─── Asosiy ishga tushirish funksiyasi ───────────────────────
async function main() {
  console.log("📦 Testlar yuklanmoqda...");
  botModule.memoryDb = storage.initStorage();
  initWorkers(bot, scheduleService);
  // 1. Supabase'dan testlarni yuklash
  try {
    const dbTests = await dbService.loadAllOfficialTests();
    for (const [subj, tests] of Object.entries(dbTests)) {
      if (!botModule.memoryDb[subj]) botModule.memoryDb[subj] = {};
      Object.assign(botModule.memoryDb[subj], tests);
    }
    console.log("✅ Supabase rasmiy testlari yuklandi.");
  } catch (e) {
    console.warn("⚠️ Supabase testlari yuklanmadi:", e.message);
  }

  // 2. Local JSON papkadagi testlarni yuklash (Eski testlarni yo'qotmaslik uchun)
  try {
    for (const subj of Object.keys(SUBJECTS)) {
      const subjDir = path.join(DATA_DIR, subj);
      if (fs.existsSync(subjDir)) {
        const files = fs
          .readdirSync(subjDir)
          .filter((f) => f.endsWith(".json"));
        if (!botModule.memoryDb[subj]) botModule.memoryDb[subj] = {};

        for (const file of files) {
          const testId = parseInt(
            file.replace("test_", "").replace(".json", ""),
            10,
          );
          const questions = JSON.parse(
            fs.readFileSync(path.join(subjDir, file), "utf8"),
          );

          // Agar bu test Supabase'dan kelmagan bo'lsa, xotiraga qo'shamiz
          if (!botModule.memoryDb[subj][testId]) {
            botModule.memoryDb[subj][testId] = {
              test_id: testId,
              range: `1-${questions.length}`,
              questions: questions,
            };
          }
        }
      }
    }
    console.log("✅ Local JSON testlar ham muvaffaqiyatli o'qildi.");
  } catch (e) {
    console.warn("⚠️ Local testlarni o'qishda xatolik:", e.message);
  }

  setMemoryDb(botModule.memoryDb);

  // Ismlarni xotiraga tiklash (Reyting uchun)
  const allUsers = await dbService.getAllUsers();
  if (allUsers) {
    for (const user of allUsers) {
      const userName =
        user.name || user.full_name || user.first_name || "Talaba";
      userNameCache.set(user.telegram_id, userName);
    }
    console.log(
      `✅ ${allUsers.length} ta foydalanuvchi ismi xotiraga tiklandi.`,
    );
  }

  // Web Server
  const app = express();
  const port = parseInt(process.env.PORT || "8080", 10);
  app.get("/", (_, res) => res.send("Bot 100% aktiv va ishlab turibdi! 🚀"));
  app.listen(port, () =>
    console.log(`🌐 Web server ishga tushdi (Port: ${port})`),
  );

  // Avtomatik Dars Jadvali tarqatish
  // Avtomatik Dars Jadvali tarqatish (Xavfsiz Navbat orqali)
  cron.schedule(
    "30 07 * * 1-6",
    async () => {
      console.log(
        "⏰ Jadval tarqatish vazifalari navbatga (Queue) qo'shilmoqda...",
      );
      try {
        const users = await dbService.getAllUsers();
        if (!users) return;

        const date = new Date(
          new Date().toLocaleString("en-US", { timeZone: "Asia/Tashkent" }),
        );
        const dayOfWeek = (date.getDay() + 6) % 7;
        if (dayOfWeek === 6) return;

        // Hamma foydalanuvchini BullMQ navbatiga tashlaymiz
        const jobs = users
          .filter((u) => u.class_name)
          .map((user) => ({
            name: "send-schedule",
            data: {
              userId: user.telegram_id,
              className: user.class_name,
              dayOfWeek,
            },
            opts: {
              attempts: 3, // Agar xato qilsa 3 marta qayta urinib ko'radi
              backoff: { type: "exponential", delay: 5000 },
              removeOnComplete: true, // Xotirani tozalash uchun
              removeOnFail: false,
            },
          }));

        if (jobs.length > 0) {
          await broadcastQueue.addBulk(jobs);
          console.log(
            `✅ Jami ${jobs.length} ta xabar yuborish vazifasi BullMQ navbatiga tizildi!`,
          );
        }
      } catch (error) {
        console.error("Cron xatoligi:", error);
      }
    },
    { timezone: "Asia/Tashkent" },
  );

  // Botni yurgizish
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  console.log("🤖 Bot ishga tushdi...");
  await bot.launch();
}

main().catch((err) => {
  console.error("Ishga tushishda xato:", err);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
