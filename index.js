"use strict";
require("dotenv").config();
const { Telegraf } = require("telegraf");
const express = require("express");
const http = require("http");
const cors = require("cors");
const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");

const logger = require("./src/core/logger");
const cron = require("node-cron");
const redisConnection = require("./src/services/redisService");
const { broadcastQueue, quizTimerQueue } = require("./src/jobs/queues");
const initWorkers = require("./src/jobs/workers");
const { loadAllTests, syncUserNames } = require("./src/core/loader");
const scheduleService = require("./src/services/scheduleService");
const scheduleWatcher = require("./src/services/scheduleWatcherService");
const { BOT_TOKEN } = require("./src/config/config");
const dbService = require("./src/services/dbService");
const { getState, States, isAdmin, clearState } = require("./src/core/utils");
const { rateLimiterMiddleware } = require("./src/core/rateLimiter");
const { initSocket } = require("./src/socket");

// ─── Sentry Initialization ──────────────────────────────────
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  environment: process.env.NODE_ENV || "production",
});

// ─── Unhandled Error Safety Net ──────────────────────────────
process.on("unhandledRejection", async (reason) => {
  logger.error("Unhandled Rejection:", reason);
  Sentry.captureException(reason);
  await Sentry.flush(2000);
});

process.on("uncaughtException", async (err) => {
  logger.error("Uncaught Exception:", err);
  Sentry.captureException(err);
  await Sentry.flush(2000);
  process.exit(1);
});

// ─── Bot & Workers Setup ─────────────────────────────────────
const bot = new Telegraf(BOT_TOKEN);
let _workers = null;
let _cronJobs = [];

// ─── Handlers ────────────────────────────────────────────────
const handlers = {
  start: require("./src/handlers/startHandler"),
  profile: require("./src/handlers/profileHandler"),
  schedule: require("./src/handlers/scheduleHandler"),
  testCreation: require("./src/handlers/testCreation"),
  admin: require("./src/handlers/adminHandlers"),
  stats: require("./src/handlers/statsHandlers"),
  quiz: require("./src/handlers/quizGame"),
  ai: require("./src/handlers/aiHandlers"),
  shelf: require("./src/handlers/shelfHandlers"),
  aiTests: require("./src/handlers/aiTestsHandlers"),
  contact: require("./src/handlers/contactAdmin"),
};

// ═══ MIDDLEWARE STACK ═════════════════════════════════════════
bot.use(rateLimiterMiddleware());

bot.use(async (ctx, next) => {
  const ignoredUpdates = ["poll_answer", "poll", "my_chat_member", "chat_member"];
  if (ignoredUpdates.includes(ctx.updateType)) return next();

  const key = `tg_session:${ctx.from?.id || ctx.chat?.id || "unknown"}`;
  let originalSessionStr = '{"state":null,"data":{}}';

  try {
    const sessionData = await redisConnection.get(key);
    if (sessionData) originalSessionStr = sessionData;
  } catch (err) {
    logger.error("Session Redis read error:", { error: err.message });
  }

  try {
    ctx.session = JSON.parse(originalSessionStr);
  } catch {
    ctx.session = { state: null, data: {} };
  }

  // Call downstream handlers ONCE. Never call next() inside a catch block!
  await next();

  // Save session to Redis if modified
  try {
    const newSessionStr = JSON.stringify(ctx.session || { state: null, data: {} });
    if (originalSessionStr !== newSessionStr) {
      await redisConnection.set(key, newSessionStr, "EX", 86400);
    }
  } catch (err) {
    logger.error("Session Redis write error:", { error: err.message });
  }
});

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (userId && !isAdmin(userId)) {
    const isBanned = await dbService.isUserBanned(userId);
    if (isBanned) {
      if (ctx.callbackQuery) {
        return ctx.answerCbQuery("⛔ Siz botdan bloklangansiz!", { show_alert: true }).catch(() => {});
      }
      return ctx.reply("⛔ <b>Siz botdan bloklangansiz!</b>\n\nQoidabuzarlik sababli sizga kirish cheklangan.", { parse_mode: "HTML" }).catch(() => {});
    }
  }
  return next();
});

// ═══ GLOBAL ERROR HANDLER ════════════════════════════════════
bot.catch((err, ctx) => {
  const errMsg = err?.message || "";
  const benignErrors = [
    "bot was blocked by the user",
    "user is deactivated",
    "message is not modified",
    "message to edit not found",
    "message can't be deleted",
    "query is too old",
    "Too Many Requests",
    "chat not found",
    "have no rights to send a message",
    "replied message not found",
  ];

  if (benignErrors.some(be => errMsg.includes(be))) return;

  if (process.env.SENTRY_DSN) {
    Sentry.withScope((scope) => {
      scope.setUser({ id: ctx?.from?.id, username: ctx?.from?.username });
      scope.setContext("telegram", {
        updateType: ctx?.updateType,
        chatId: ctx?.chat?.id,
        callbackData: ctx?.callbackQuery?.data,
      });
      Sentry.captureException(err);
    });
  }

  logger.error(`Bot error [${ctx?.updateType}]: ${errMsg}`, { stack: err?.stack });

  // Prevent UI freeze
  if (ctx?.callbackQuery) {
    ctx.answerCbQuery("⚠️ Xatolik yuz berdi. Qaytadan urinib ko'ring.", { show_alert: true }).catch(() => {});
  } else if (ctx?.chat?.type === "private") {
    ctx.reply("⚠️ Texnik xatolik yuz berdi. Iltimos qaytadan urinib ko'ring yoki /start bosing.").catch(() => {});
  }
});

// ═══ REGISTER HANDLERS ═══════════════════════════════════════
Object.values(handlers).forEach(h => h.register && h.register(bot));

bot.command("start", (ctx) => (handlers.start.cbStart || handlers.start.cmdStart)(ctx));
bot.command("profile", (ctx) => handlers.profile.cbProfile(ctx));
bot.command("schedule", (ctx) => (handlers.schedule.cbSchedule || handlers.schedule.cmdTimetable)(ctx));

bot.command("testcron_bugun", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Faqat bot adminlari uchun!");
  await ctx.reply("⏳ Bugungi jadval tarqatish jarayoni boshlanmoqda...");
  await queueSchedules(false);
  return ctx.reply("✅ Bugungi dars jadvali tarqatish vazifasi navbatga qo'shildi!");
});

bot.command("testcron_ertaga", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Faqat bot adminlari uchun!");
  await ctx.reply("⏳ Ertangi jadval tarqatish jarayoni boshlanmoqda...");
  await queueSchedules(true);
  return ctx.reply("✅ Ertangi dars jadvali tarqatish vazifasi navbatga qo'shildi!");
});

bot.command("check_schedule", async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply("⛔ Faqat bot adminlari uchun!");
  await ctx.reply("🔍 Dars jadvalidagi o'zgarishlar tekshirilmoqda...");
  const res = await scheduleWatcher.checkScheduleChanges(true);
  const status = scheduleWatcher.getWatcherStatus();
  const msg =
    "📊 <b>Dars jadvali kuzatuvchisi (Watcher) holati:</b>\n\n" +
    `• Holat: <b>${status.lastCheckStatus}</b>\n` +
    `• Kuzatilayotgan guruhlar: <b>${status.trackedGroupsCount} ta</b>\n` +
    `• O'zgarish aniqlangan guruhlar: <b>${res.changedGroupsCount || 0} ta</b>\n` +
    (res.changedGroups?.length ? `• Guruhlar: <code>${res.changedGroups.join(", ")}</code>\n` : "") +
    `• Tekshiruv vaqti: <b>${res.durationMs || 0} ms</b>\n` +
    `• Baza tayyor: <b>${status.isBaselineReady ? "Ha ✅" : "Yo'q ⏳"}</b>`;
  return ctx.reply(msg, { parse_mode: "HTML" });
});

// ═══ GLOBAL TEXT STATE ROUTER ════════════════════════════════
bot.on("message", async (ctx, next) => {
  const state = getState(ctx);
  if (!state) return next();

  const userId = ctx.from?.id;

  // Admin states guard
  const isAdminState =
    state.startsWith("admin:") ||
    state.startsWith("adm_create:") ||
    state === States.ADMIN_WARNING;

  if (isAdminState && !isAdmin(userId)) {
    clearState(ctx);
    logger.warn(`Unauthorized attempt to access admin state "${state}" by user ${userId}`);
    return ctx.reply("⛔ Bu amal faqat bot adminlari uchun!");
  }

  const stateMap = {
    // User test creation
    [States.CREATE_SUBJECT]: () => handlers.testCreation.onSubjectInput(ctx),
    [States.CREATE_NAME]: () => handlers.testCreation.onNameInput(ctx),
    [States.CREATE_QUESTIONS]: () => ctx.message.document ? handlers.testCreation.onDocxFile(ctx) : handlers.testCreation.onQuestionMessage(ctx),
    [States.CREATE_AI_IMAGE]: () => ctx.message.photo ? handlers.testCreation.onAiImageInput(ctx) : ctx.reply("⚠️ Iltimos, kitob yoki matnning rasmini yuboring."),
    [States.CREATE_AI_TEXT]: () => handlers.testCreation.onAiTextInput(ctx),
    [States.CREATE_AI_QUESTIONS]: () => handlers.testCreation.onAiQuestionsInput(ctx),
    [States.AI_ESSAY_ANALYSIS]: () => handlers.ai.onEssayInput(ctx),
    [States.CREATE_SHELF_FOLDER]: () => handlers.shelf.onNewFolderInput(ctx),

    // Admin test creation & management
    [States.ADM_CREATE_TEST_ID]: () => handlers.admin.onAdmTestId(ctx),
    [States.ADM_CREATE_CONTENT]: () => ctx.message.document ? handlers.admin.onAdmDocxContent(ctx) : handlers.admin.onAdmTextContent(ctx),
    [States.ADMIN_SEARCH_USER]: () => handlers.admin.onAdminSearchInput(ctx),
    [States.ADMIN_BROADCAST]: () => handlers.admin.onBroadcastMessage(ctx),
    [States.ADMIN_REPLY]: () => handlers.admin.onReplyMessage(ctx),
    [States.ADMIN_WARNING]: () => handlers.contact.onAdminWarningInput && handlers.contact.onAdminWarningInput(ctx),

    // Admin AI tests generator
    [States.ADMIN_AI_TESTS_TEXT]: () => handlers.aiTests.onAiTestsText(ctx),
    [States.ADMIN_AI_TESTS_IMAGE]: () => handlers.aiTests.onAiTestsImage(ctx),
    [States.ADMIN_AI_TESTS_IMAGE_WAIT]: () => handlers.aiTests.onAiTestsImage(ctx),
    [States.ADMIN_AI_TESTS_ADAPTIVE_USER]: () => handlers.aiTests.onAiTestsAdaptiveUser(ctx),
    [States.ADMIN_AI_TESTS_ADAPTIVE_COUNT]: () => handlers.aiTests.onAiTestsAdaptiveCount(ctx),

    // User feedback / contact
    [States.USER_CONTACT]: () => handlers.contact.handleContactMessages ? handlers.contact.handleContactMessages(ctx, next) : handlers.admin.onContactMessage(ctx),
  };

  if (stateMap[state]) return stateMap[state]();
  return next();
});

bot.on("poll_answer", async (ctx) => {
  await handlers.quiz.handlePollAnswer(ctx.pollAnswer, ctx.telegram);
});

// ═══ SCHEDULE BROADCAST ENGINE ═══════════════════════════════
async function queueSchedules(isTomorrow = false) {
  logger.info(`⏰ ${isTomorrow ? "Ertangi" : "Bugungi"} jadval tarqatish vazifasi boshlanmoqda...`);
  try {
    // 1. Pre-warm / ensure cache is fresh
    await scheduleService.warmUpCache();

    // 2. Fetch users from DB (filtered: active, valid group, not banned, not blocked)
    let users = await dbService.getScheduleBroadcastUsers();
    if (!users || users.length === 0) {
      const all = await dbService.getAllUsers();
      users = (all || []).filter((u) => u.class_name && !u.is_banned && !u.is_blocked);
    }
    if (!users || users.length === 0) return;

    // 3. Compute target day in Asia/Tashkent
    const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tashkent" }));
    let dayOfWeek = (date.getDay() + 6) % 7; // 0=Monday..6=Sunday

    if (isTomorrow) {
      dayOfWeek = (dayOfWeek + 1) % 7;
    }

    // Sunday (6) is a day off — no classes
    if (dayOfWeek === 6) {
      logger.info("Yakshanba kuni dars bo'lmaydi, jadval tarqatish o'tkazib yuborildi.");
      return;
    }

    const eligibleUsers = users.filter((u) => u.class_name && u.telegram_id);
    if (eligibleUsers.length === 0) {
      logger.info("Dars jadvali yuborish uchun guruhini kiritgan foydalanuvchilar mavjud emas.");
      return;
    }

    // 4. Batch jobs into BullMQ to avoid memory & Redis connection spikes
    const BATCH_SIZE = 250;
    for (let i = 0; i < eligibleUsers.length; i += BATCH_SIZE) {
      const chunk = eligibleUsers.slice(i, i + BATCH_SIZE).map((user) => ({
        name: "send-schedule",
        data: {
          userId: user.telegram_id,
          className: user.class_name,
          dayOfWeek,
          isTomorrow,
        },
        opts: {
          attempts: 3,
          backoff: { type: "exponential", delay: 5000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      }));

      await broadcastQueue.addBulk(chunk);
    }

    logger.info(`✅ Jami ${eligibleUsers.length} ta foydalanuvchi uchun dars jadvali BullMQ navbatiga tizildi`);
  } catch (error) {
    logger.error("Schedule broadcast error:", { error: error.message });
  }
}

// ═══ GRACEFUL SHUTDOWN ═══════════════════════════════════════
let _isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  logger.info(`⚡ ${signal} received — graceful shutdown started`);

  try {
    try {
      const timetableCdnService = require('./src/services/timetableCdnService');
      timetableCdnService.stopPrewarmWorker();
    } catch {}
    _cronJobs.forEach((job) => job?.stop());
    bot.stop(signal);
    await Promise.allSettled([
      broadcastQueue.pause(),
      quizTimerQueue.pause(),
      _workers?.broadcastWorker.close(),
      _workers?.quizTimerWorker.close(),
      Sentry.flush(3000),
      redisConnection.quit()
    ]);
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
  await loadAllTests();
  await syncUserNames();

  _workers = initWorkers(bot, scheduleService);
  await broadcastQueue.resume();
  await quizTimerQueue.resume();

  // Pre-warm schedule cache in background
  scheduleService.warmUpCache().catch((err) => {
    logger.warn('Initial cache warm-up deferred', { error: err.message });
  });

  // Start Timetable CDN pre-warm in background if storage channel is configured
  const { TIMETABLE_STORAGE_CHANNEL_ID } = require('./src/config/config');
  if (TIMETABLE_STORAGE_CHANNEL_ID) {
    setTimeout(() => {
      try {
        const timetableCdnService = require('./src/services/timetableCdnService');
        timetableCdnService.prewarmAllTimetables(bot.telegram, { activeOnly: false }).catch((err) => {
          logger.warn('Timetable CDN background prewarm deferred', { error: err.message });
        });
      } catch (e) {
        logger.warn('Could not initialize timetable CDN prewarm', { error: e.message });
      }
    }, 15000);
  }

  // ═══ Cron Tasks (Asia/Tashkent) ══════════════════════════════
  // 1. Ertalab 07:30 (Bugungi jadval uchun) — Dushanbadan Shanbagacha
  const morningCron = cron.schedule("30 07 * * 1-6", () => queueSchedules(false), {
    timezone: "Asia/Tashkent",
  });

  // 2. Kechqurun 21:00 (Ertangi jadval uchun) — Yakshanbadan Jumagacha
  const eveningCron = cron.schedule("00 21 * * 0-5", () => queueSchedules(true), {
    timezone: "Asia/Tashkent",
  });

  // 3. Realtime Schedule Watcher (Kunduzi har 3 daqiqada tekshirib o'zgarishlarni aniqlaydi)
  const watcherDayCron = cron.schedule("*/3 7-20 * * 1-6", () => scheduleWatcher.checkScheduleChanges(false), {
    timezone: "Asia/Tashkent",
  });

  // 4. Realtime Schedule Watcher (Kechasi va dam olish kunlari har 30 daqiqada)
  const watcherNightCron = cron.schedule("*/30 21-23,0-6 * * *", () => scheduleWatcher.checkScheduleChanges(false), {
    timezone: "Asia/Tashkent",
  });

  _cronJobs = [morningCron, eveningCron, watcherDayCron, watcherNightCron];
  logger.info("⏰ Dars jadvali avtomatik tarqatish va Realtime Watcher faollashtirildi");

  // Initial watcher snapshot baseline in background
  scheduleWatcher.checkScheduleChanges(false).catch((err) => {
    logger.warn("Initial schedule watcher check deferred", { error: err.message });
  });

  // Web Server & Socket.io
  const app = express();
  const server = http.createServer(app);
  const adminRouter = require("./src/api/admin");

  // Security Hardening Headers
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/admin", adminRouter);
  app.get("/", (_, res) => res.send("Bot 100% aktiv va ishlab turibdi! 🚀"));

  // Express Global Error Handler
  app.use((err, req, res, next) => {
    logger.error("Express Error:", { error: err?.message, stack: err?.stack });
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });

  initSocket(server);

  const port = parseInt(process.env.PORT || "8080", 10);
  server.listen(port, () => logger.info(`🌐 Web & Socket.io server started on port ${port}`));

  await bot.telegram.deleteWebhook({ drop_pending_updates: true });
  await bot.launch();
  logger.info("🤖 Bot successfully launched");
}

main().catch((err) => {
  logger.error("Startup error:", err);
  process.exit(1);
});
