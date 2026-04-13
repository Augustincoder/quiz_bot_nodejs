'use strict';

const { Markup } = require('telegraf');

// ─── Global mutable state ────────────────────────────────────
const activeTests  = new Map();   // chatId → TestSession
const waitingRooms = new Map();   // chatId → WaitingRoom
const pollChatMap  = new Map();   // pollId → chatId

const userNameCache       = new Map();   // userId → string
const leaderboardCache    = { text: null, ts: 0 };
const LEADERBOARD_TTL     = 120_000;     // ms

// ─── FSM helpers (session-tabanlı) ──────────────────────────
function setState(ctx, stateName) {
  ctx.session.state = stateName;
}

function clearState(ctx) {
  ctx.session.state = null;
  ctx.session.data  = {};
}

async function updateData(ctx, patch) {
  ctx.session.data = { ...(ctx.session.data || {}), ...patch };
}

async function getData(ctx) {
  return ctx.session.data || {};
}

function getState(ctx) {
  return ctx.session.state || null;
}

// ─── State nomlari ───────────────────────────────────────────
const States = {
  // Admin
  ADMIN_BROADCAST:          'admin:broadcast',
  ADMIN_REPLY:              'admin:reply',
  // User
  USER_CONTACT:             'user:contact',
  // UGC test yaratish
  CREATE_SUBJECT:           'create:subject',
  CREATE_NAME:              'create:name',
  CREATE_FORMAT:            'create:format',
  CREATE_QUESTIONS:         'create:questions',
  // Admin test yaratish
  ADM_CREATE_SUBJECT:       'adm_create:subject',
  ADM_CREATE_TEST_ID:       'adm_create:test_id',
  ADM_CREATE_FORMAT:        'adm_create:format',
  ADM_CREATE_CONTENT:       'adm_create:content',
// AI test yaratish
  CREATE_AI_TEXT:           'create:ai_text',
  CREATE_AI_QUESTIONS:      'create:ai_questions',
};

// ─── Klaviatura yordamchilari ────────────────────────────────
function backToMainKb(extraButtons = []) {
  const rows = [
    ...extraButtons,
    [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
  ];
  return Markup.inlineKeyboard(rows);
}

// ─── Matn yordamchilari ──────────────────────────────────────
function progressBar(current, total, length = 15) {
  if (total === 0) return '░'.repeat(length);
  const filled = Math.floor(length * current / total);
  return '▓'.repeat(filled) + '░'.repeat(length - filled);
}

function safePercent(correct, total) {
  return total > 0 ? Math.round(correct / total * 1000) / 10 : 0;
}

function grade(percent) {
  if (percent >= 90) return "🏆 A'lo!";
  if (percent >= 75) return '👍 Yaxshi!';
  if (percent >= 60) return '📈 Qoniqarli';
  return '📚 Ko\'proq mashq kerak';
}

function parseSuffix(str, prefix) {
  return str.slice(prefix.length);
}

// ─── Bot API yordamchilari ───────────────────────────────────
async function safeEdit(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra });
    return true;
  } catch {
    try {
      await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
    } catch (e2) {
      console.warn('safeEdit failed:', e2.message);
    }
    return false;
  }
}

async function safeDelete(ctx) {
  try { await ctx.deleteMessage(); } catch { /* silent */ }
}

async function getUserName(bot, userId) {
  if (userNameCache.has(userId)) return userNameCache.get(userId);

  // DIQQAT: MANZIL O'ZGARDI
  const dbService = require('../services/dbService');
  try {
    const users = await dbService.getAllUsers();
    const found = users.find(u => u.telegram_id === String(userId));
    if (found?.full_name) {
      userNameCache.set(userId, found.full_name);
      return found.full_name;
    }
  } catch { /* silent */ }

  try {
    const chat = await bot.telegram.getChat(userId);
    const name = chat.first_name
      ? `${chat.first_name}${chat.last_name ? ' ' + chat.last_name : ''}`
      : 'Sirli Talaba';
    userNameCache.set(userId, name);
    return name;
  } catch {
    return 'Sirli Talaba';
  }
}

// ─── docx parse ─────────────────────────────────────────────
async function parseDocxQuestions(filePath) {
  const mammoth = require('mammoth');
  const result  = await mammoth.extractRawText({ path: filePath });
  const text    = result.value;

  const questions = [];
  const blocks    = text.split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;

    const opts = []; let corr = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i + 1];
      if (line.startsWith('#')) {
        corr = i;
        opts.push(line.slice(1).trim());
      } else {
        opts.push(line);
      }
    }
    if (corr !== -1 && opts.length >= 2) {
      questions.push({ question: lines[0], options: opts, correct_index: corr });
    }
  }
  return questions;
}

function parseTextQuestions(text) {
  const questions = [];
  for (const block of text.split(/\n\n/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const opts = []; let corr = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i + 1];
      if (line.startsWith('#')) {
        corr = i;
        opts.push(line.slice(1).trim());
      } else {
        opts.push(line);
      }
    }
    if (corr !== -1 && opts.length >= 2) {
      questions.push({ question: lines[0], options: opts, correct_index: corr });
    }
  }
  return questions;
}

module.exports = {
  activeTests,
  waitingRooms,
  pollChatMap,
  userNameCache,
  leaderboardCache,
  LEADERBOARD_TTL,
  States,
  setState,
  clearState,
  updateData,
  getData,
  getState,
  backToMainKb,
  progressBar,
  safePercent,
  grade,
  parseSuffix,
  safeEdit,
  safeDelete,
  getUserName,
  parseDocxQuestions,
  parseTextQuestions,
};