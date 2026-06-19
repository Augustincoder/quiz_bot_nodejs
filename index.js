"use strict";
require("dotenv").config();
const { Telegraf } = require("telegraf");
const express = require("express");
const http = require("http");
const cors = require("cors");
const Sentry = require("@sentry/node");
const { nodeProfilingIntegration } = require("@sentry/profiling-node");

const logger = require("./src/core/logger");
const redisConnection = require("./src/services/redisService");
const { broadcastQueue, quizTimerQueue } = require("./src/jobs/queues");
const initWorkers = require("./src/jobs/workers");
const { loadAllTests, syncUserNames } = require("./src/core/loader");
const scheduleService = require("./src/services/scheduleService");
const { BOT_TOKEN } = require("./src/config/config");
const { getState, States } = require("./src/core/utils");
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
    logger.error("Session Redis error:", { error: err.message });
    ctx.session = { state: null, data: {} };
    await next();
  }
});

// ═══ GLOBAL ERROR HANDLER ════════════════════════════════════
bot.catch((err, ctx) => {
  const errMsg = err.message || "";
  const benignErrors = [
    "bot was blocked by the user",
    "message is not modified",
    "message to edit not found",
    "query is too old",
    "Too Many Requests",
  ];

  if (benignErrors.some(be => errMsg.includes(be))) return;

  Sentry.withScope((scope) => {
    scope.setUser({ id: ctx?.from?.id, username: ctx?.from?.username });
    scope.setContext("telegram", {
      updateType: ctx?.updateType,
      chatId: ctx?.chat?.id,
      callbackData: ctx?.callbackQuery?.data,
    });
    Sentry.captureException(err);
  });

  logger.error(`Bot error [${ctx?.updateType}]: ${errMsg}`, { stack: err.stack });
});

// ═══ REGISTER HANDLERS ═══════════════════════════════════════
Object.values(handlers).forEach(h => h.register && h.register(bot));

bot.command("start", (ctx) => handlers.start.cbStart(ctx));
bot.command("profile", (ctx) => handlers.profile.cbProfile(ctx));
bot.command("schedule", (ctx) => handlers.schedule.cbSchedule(ctx));

// ═══ GLOBAL TEXT STATE ROUTER ════════════════════════════════
bot.on("message", async (ctx, next) => {
  const state = getState(ctx);
  if (!state) return next();

  const stateMap = {
    [States.CREATE_SUBJECT]: () => handlers.testCreation.onSubjectInput(ctx),
    [States.CREATE_NAME]: () => handlers.testCreation.onNameInput(ctx),
    [States.CREATE_QUESTIONS]: () => ctx.message.document ? handlers.testCreation.onDocxFile(ctx) : handlers.testCreation.onQuestionMessage(ctx),
    [States.CREATE_AI_IMAGE]: () => ctx.message.photo && handlers.testCreation.onAiImageInput(ctx),
    [States.CREATE_AI_TEXT]: () => handlers.testCreation.onAiTextInput(ctx),
    [States.AI_ESSAY_ANALYSIS]: () => handlers.ai.onEssayInput(ctx),
    [States.CREATE_SHELF_FOLDER]: () => handlers.shelf.onNewFolderInput(ctx),
    [States.CREATE_AI_QUESTIONS]: () => handlers.testCreation.onAiQuestionsInput(ctx),
    [States.ADM_CREATE_TEST_ID]: () => handlers.admin.onAdmTestId(ctx),
    [States.ADM_CREATE_CONTENT]: () => ctx.message.document ? handlers.admin.onAdmDocxContent(ctx) : handlers.admin.onAdmTextContent(ctx),
    [States.ADMIN_BROADCAST]: () => handlers.admin.onBroadcastMessage(ctx),
    [States.ADMIN_REPLY]: () => handlers.admin.onReplyMessage(ctx),
    [States.USER_CONTACT]: () => handlers.admin.onContactMessage(ctx),
  };

  if (stateMap[state]) return stateMap[state]();
  return next();
});

bot.on("poll_answer", async (ctx) => {
  await handlers.quiz.handlePollAnswer(ctx.pollAnswer, ctx.telegram);
});

// ═══ GRACEFUL SHUTDOWN ═══════════════════════════════════════
let _isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  logger.info(`⚡ ${signal} received — graceful shutdown started`);

  try {
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

  // Web Server & Socket.io
  const app = express();
  const server = http.createServer(app);
  const adminRouter = require("./src/api/admin");

  app.use(cors());
  app.use(express.json({ limit: "50mb" }));
  app.use("/api/admin", adminRouter);
  app.get("/", (_, res) => res.send("Bot 100% aktiv va ishlab turibdi! 🚀"));

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
