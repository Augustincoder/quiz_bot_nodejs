'use strict';
const { Markup } = require('telegraf');

class TTLMap {
  constructor(ttlMs = 3600000) {
    this._map = new Map();
    this._ttl = ttlMs;
  }
  set(key, value) {
    const existing = this._map.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    const timer = setTimeout(() => this._map.delete(key), this._ttl);
    timer.unref();
    this._map.set(key, { value, timer });
  }
  get(key) { return this._map.get(key)?.value; }
  has(key) { return this._map.has(key); }
  delete(key) {
    const existing = this._map.get(key);
    if (existing?.timer) clearTimeout(existing.timer);
    this._map.delete(key);
  }
}

const activeTests   = new Map();
const waitingRooms  = new Map();
const pollChatMap   = new Map();
const userNameCache = new Map();
const leaderboardCache = { text: null, ts: 0 };
const LEADERBOARD_TTL  = 120_000;

function setState(ctx, stateName)   { ctx.session.state = stateName; }
function clearState(ctx)            { ctx.session.state = null; ctx.session.data = {}; }
async function updateData(ctx, patch) { ctx.session.data = { ...(ctx.session.data || {}), ...patch }; }
async function getData(ctx)         { return ctx.session.data || {}; }
function getState(ctx)              { return ctx.session.state || null; }

const States = {
  ADMIN_BROADCAST:         'admin:broadcast',
  ADMIN_BROADCAST_CONFIRM: 'admin:broadcast_confirm',
  ADMIN_REPLY:             'admin:reply',
  ADMIN_SEARCH_USER:       'admin:search_user',
  USER_CONTACT:            'user:contact',
  CREATE_SUBJECT:          'create:subject',
  CREATE_NAME:             'create:name',
  CREATE_FORMAT:           'create:format',
  CREATE_QUESTIONS:        'create:questions',
  ADM_CREATE_SUBJECT:      'adm_create:subject',
  ADM_CREATE_TEST_ID:      'adm_create:test_id',
  ADM_CREATE_FORMAT:       'adm_create:format',
  ADM_CREATE_CONTENT:      'adm_create:content',
  CREATE_AI_TEXT:          'create:ai_text',
  CREATE_AI_QUESTIONS:     'create:ai_questions',
  AI_ESSAY_ANALYSIS:       'ai:essay_analysis',
  CREATE_AI_IMAGE:         'create:ai_image',
  CREATE_SHELF_FOLDER:     'create:shelf_folder',
  // Admin AI Tests states
  ADMIN_AI_TESTS_SUBJECT:   'admin:ai_tests_subject',
  ADMIN_AI_TESTS_TYPE:      'admin:ai_tests_type',
  ADMIN_AI_TESTS_TEXT:      'admin:ai_tests_text',
  ADMIN_AI_TESTS_IMAGE:     'admin:ai_tests_image',
  ADMIN_AI_TESTS_IMAGE_WAIT: 'admin:ai_tests_image_wait',
  ADMIN_AI_TESTS_ADAPTIVE_USER: 'admin:ai_tests_adaptive_user',
  ADMIN_AI_TESTS_ADAPTIVE_COUNT: 'admin:ai_tests_adaptive_count',
  ADMIN_AI_TESTS_GENERATE:  'admin:ai_tests_generate',
};

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

// Sanitize text for Telegram API (ensures valid UTF-8)
function sanitizeForTelegram(str) {
  if (!str) return '';
  let text = String(str);
  // Replace invalid UTF-8 sequences and control characters (except common whitespace)
  // This regex matches characters that are not valid in UTF-8 text for Telegram
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Replace replacement character (U+FFFD) which indicates encoding issues
  text = text.replace(/\uFFFD/g, '');
  return text;
}

function backToMainKb(extraButtons = []) {
  return Markup.inlineKeyboard([
    ...extraButtons,
    [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
  ]);
}

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
  return "📚 Ko'proq mashq kerak";
}

function parseSuffix(str, prefix) { return str.slice(prefix.length); }

async function safeEdit(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...extra });
    return true;
  } catch {
    try { await ctx.reply(text, { parse_mode: 'HTML', ...extra }); } catch (e2) { console.warn('safeEdit failed:', e2.message); }
    return false;
  }
}

async function safeDelete(ctx) {
  try { await ctx.deleteMessage(); } catch { /* silent */ }
}

async function getUserName(bot, userId) {
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  const dbService = require('../services/dbService');
  try {
    const users = await dbService.getAllUsers();
    const found = users?.find(u => u.telegram_id === String(userId));
    if (found?.full_name) { userNameCache.set(userId, found.full_name); return found.full_name; }
  } catch { /* silent */ }
  try {
    const chat = await bot.telegram.getChat(userId);
    const name = chat.first_name ? `${chat.first_name}${chat.last_name ? ' ' + chat.last_name : ''}` : 'Sirli Talaba';
    userNameCache.set(userId, name);
    return name;
  } catch { return 'Sirli Talaba'; }
}

async function parseDocxQuestions(filePath) {
  const mammoth = require('mammoth');
  const result  = await mammoth.extractRawText({ path: filePath });
  const questions = [];
  for (const block of result.value.split(/\n\s*\n/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;
    const opts = []; let corr = -1;
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i + 1];
      if (line.startsWith('#')) { corr = i; opts.push(line.slice(1).trim()); }
      else opts.push(line);
    }
    if (corr !== -1 && opts.length >= 2) questions.push({ question: lines[0], options: opts, correct_index: corr });
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
      if (line.startsWith('#')) { corr = i; opts.push(line.slice(1).trim()); }
      else opts.push(line);
    }
    if (corr !== -1 && opts.length >= 2) questions.push({ question: lines[0], options: opts, correct_index: corr });
  }
  return questions;
}

module.exports = {
  activeTests, waitingRooms, pollChatMap, userNameCache,
  leaderboardCache, LEADERBOARD_TTL, States, TTLMap,
  setState, clearState, updateData, getData, getState,
  backToMainKb, progressBar, safePercent, grade, parseSuffix,
  safeEdit, safeDelete, getUserName, parseDocxQuestions, parseTextQuestions,
  escapeHtml, sanitizeForTelegram,
};
