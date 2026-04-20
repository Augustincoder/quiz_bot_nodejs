"use strict";
require("dotenv").config();
const { Telegraf } = require("telegraf");
const express = require("express");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

// ─── Redis Connection ────────────────────────────────────────
const redisConnection = require("./src/services/redisService");

// ─── Sentry ──────────────────────────────────────────────────
const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");
const logger = require("./src/core/logger");

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  environment: process.env.NODE_ENV || "production",
});

// ─── Unhandled Error Safety Net ──────────────────────────────
process.on("unhandledRejection", async (reason, promise) => {
  console.error("Unhandled Rejection:", reason);
  Sentry.captureException(reason);
  await Sentry.flush(2000);
});

process.on("uncaughtException", async (err) => {
  console.error("Uncaught Exception:", err);
  Sentry.captureException(err);
  await Sentry.flush(2000);
  process.exit(1);
});

// ─── BullMQ ──────────────────────────────────────────────────
const { broadcastQueue, quizTimerQueue } = require("./src/jobs/queues");
const initWorkers = require("./src/jobs/workers");

// ─── Session & Services ─────────────────────────────────────
const sessionService = require("./src/services/sessionService");
const { BOT_TOKEN, DATA_DIR, SUBJECTS } = require("./src/config/config");
const storage = require("./src/core/storage");
const botModule = require("./src/core/bot");
const dbService = require("./src/services/dbService");
const scheduleService = require("./src/services/scheduleService");
const { setMemoryDb } = require("./src/keyboards/keyboards");
const { States, getState, userNameCache } = require("./src/core/utils");
const { rateLimiterMiddleware } = require("./src/core/rateLimiter");

// ─── Handlers ────────────────────────────────────────────────
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
const contactAdmin = require("./src/handlers/contactAdmin");

// ─── Bot Instance ────────────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);

// ─── Store workers ref for graceful shutdown ─────────────────
let _workers = null;

// ═══ MIDDLEWARE STACK ═════════════════════════════════════════

// 1. Rate Limiter (fires FIRST — blocks spammers before Redis session read)
bot.use(rateLimiterMiddleware());

// 2. Redis Session Middleware
bot.use(async (ctx, next) => {
  const ignoredUpdates = [
    "poll_answer",
    "poll",
    "my_chat_member",
    "chat_member",
  ];
  if (ignoredUpdates.includes(ctx.updateType)) {
    return next();
  }

  const key = `tg_session:${ctx.from?.id || ctx.chat?.id || "unknown"}`;

  try {
    const sessionData = await redisConnection.get(key);
    const originalSessionStr = sessionData || '{"state":null,"data":{}}';
    ctx.session = JSON.parse(originalSessionStr);

    await next();

    const newSessionStr = JSON.stringify(ctx.session);
    if (originalSessionStr !== newSessionStr) {
      await redisConnection.set(key, newSessionStr, "EX", 86400);
    }
  } catch (err) {
    logger.error("Session Redis xatosi:", { error: err.message });
    ctx.session = { state: null, data: {} };
    await next();
  }
});

// ═══ GLOBAL ERROR HANDLER (Single, Unified) ══════════════════
bot.catch((err, ctx) => {
  const errMsg = err.message || "";

  // Benign Telegram errors — don't pollute Sentry
  if (
    errMsg.includes("bot was blocked by the user") ||
    errMsg.includes("message is not modified") ||
    errMsg.includes("message to edit not found") ||
    errMsg.includes("query is too old") ||
    errMsg.includes("Too Many Requests")
  ) {
    return;
  }

  // Send to Sentry with full context
  Sentry.withScope((scope) => {
    scope.setUser({ id: ctx?.from?.id, username: ctx?.from?.username });
    scope.setContext("telegram", {
      updateType: ctx?.updateType,
      chatId: ctx?.chat?.id,
      callbackData: ctx?.callbackQuery?.data,
    });
    Sentry.captureException(err);
  });

  logger.error(`Bot xatosi [${ctx?.updateType}]: ${errMsg}`, {
    stack: err.stack,
  });
});

// ═══ REGISTER HANDLERS ═══════════════════════════════════════
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

// ═══ GLOBAL TEXT STATE ROUTER ════════════════════════════════
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

// ═══ GRACEFUL SHUTDOWN ═══════════════════════════════════════
let _isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  logger.info(`⚡ ${signal} received — graceful shutdown started`);

  try {
    // 1. Stop accepting new updates
    bot.stop(signal);

    // 2. Pause BullMQ queues
    await broadcastQueue.pause().catch(() => {});
    await quizTimerQueue.pause().catch(() => {});
    logger.info('📦 BullMQ queues paused');

    // 3. Close workers
    if (_workers) {
      if (_workers.broadcastWorker) await _workers.broadcastWorker.close().catch(() => {});
      if (_workers.quizTimerWorker) await _workers.quizTimerWorker.close().catch(() => {});
      logger.info('👷 BullMQ workers closed');
    }

    // 4. Flush Sentry
    await Sentry.flush(3000).catch(() => {});
    logger.info('📡 Sentry flushed');

    // 5. Close Redis
    await redisConnection.quit().catch(() => {});
    logger.info('🔌 Redis connection closed');

    logger.info('✅ Graceful shutdown completed');
  } catch (err) {
    logger.error('Shutdown error:', { error: err.message });
  } finally {
    process.exit(0);
  }
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ═══ MAIN STARTUP ════════════════════════════════════════════
async function main() {
  console.log("📦 Testlar yuklanmoqda...");
  botModule.memoryDb = storage.initStorage();
  _workers = initWorkers(bot, scheduleService);

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

  // 2. Local JSON papkadagi testlarni yuklash
  try {
    for (const subj of Object.keys(SUBJECTS)) {
      let subjDir = path.join(DATA_DIR, subj);
      let sourceDir = subjDir;
      if (!fs.existsSync(subjDir) || !fs.readdirSync(subjDir).some((f) => f.endsWith(".json"))) {
        const altDir = path.join(__dirname, "src", "data", subj);
        if (fs.existsSync(altDir)) {
          subjDir = altDir;
          sourceDir = altDir;
        }
      }

      if (!fs.existsSync(subjDir)) {
        console.warn(`⚠️ Local test katalogi topilmadi: ${subjDir}`);
        continue;
      }

      const files = fs.readdirSync(subjDir).filter((f) => f.endsWith(".json"));
      if (!files.length) {
        console.warn(`⚠️ ${subj} uchun JSON fayl topilmadi: ${subjDir}`);
        continue;
      }

      if (!botModule.memoryDb[subj]) botModule.memoryDb[subj] = {};

      for (const file of files) {
        const match = file.match(/^test_(\d+)\.json$/);
        if (!match) {
          console.warn(`⚠️ Nomutanosib fayl nomi e'tiborsiz qoldirildi: ${file}`);
          continue;
        }

        const testId = Number(match[1]);
        const filePath = path.join(subjDir, file);
        const rawData = JSON.parse(fs.readFileSync(filePath, "utf8"));
        let questions = rawData;
        let range = `1-${Array.isArray(rawData) ? rawData.length : (rawData.questions?.length || 0)}`;
        let blockName = rawData.block_name || `Blok ${rawData.test_id || testId}`;

        if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
          if (Array.isArray(rawData.questions)) {
            questions = rawData.questions;
          }
          if (typeof rawData.range === "string") {
            range = rawData.range;
          }
          if (typeof rawData.block_name === "string") {
            blockName = rawData.block_name;
          }
        }

        if (!Array.isArray(questions)) {
          console.warn(`⚠️ ${filePath} ichidagi test savollari massiv emas; o'tkazib yuborildi.`);
          continue;
        }

        if (!botModule.memoryDb[subj][testId]) {
          botModule.memoryDb[subj][testId] = {
            test_id: testId,
            range,
            block_name: blockName,
            questions,
          };
        }
      }

      if (sourceDir !== path.join(DATA_DIR, subj)) {
        console.log(`ℹ️ Local tests for ${subj} loaded from alternate directory: ${sourceDir}`);
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
  // Web Server & Socket.io Upgrade
  const app = express();
  const cors = require("cors");
  const adminRouter = require("./src/api/admin");

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/admin", adminRouter);

  const http = require("http");
  const { initSocket } = require("./src/socket");

  const server = http.createServer(app);
  
  // Attach Socket.io
  initSocket(server);

  const port = parseInt(process.env.PORT || "8080", 10);
  app.get("/", (_, res) => res.send("Bot 100% aktiv va ishlab turibdi! 🚀"));
  
  server.listen(port, () =>
    console.log(`🌐 Web & Socket.io server ishga tushdi (Port: ${port})`)
  );

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
              attempts: 3,
              backoff: { type: "exponential", delay: 5000 },
              removeOnComplete: true,
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
  logger.info("🤖 Bot ishga tushdi", { timestamp: new Date().toISOString() });
  console.log("🤖 Bot ishga tushdi...");
  await bot.launch();
}

main().catch((err) => {
  console.error("Ishga tushishda xato:", err);
  process.exit(1);
});
