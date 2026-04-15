'use strict';
const { Markup } = require('telegraf');
const fs = require('fs');
const https = require('https');
const http = require('http');

// ─── TTLMap (Auto-expiring in-memory cache) ──────────────────
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

// ─── Shared In-Memory Stores ─────────────────────────────────
const activeTests   = new Map();
const waitingRooms  = new Map();
const pollChatMap   = new Map();
const userNameCache = new Map();
const leaderboardCache = { text: null, ts: 0 };
const LEADERBOARD_TTL  = 120_000;

// ─── Session State Helpers ───────────────────────────────────
function setState(ctx, stateName)   { ctx.session.state = stateName; }
function clearState(ctx)            { ctx.session.state = null; ctx.session.data = {}; }
async function updateData(ctx, patch) { ctx.session.data = { ...(ctx.session.data || {}), ...patch }; }
async function getData(ctx)         { return ctx.session.data || {}; }
function getState(ctx)              { return ctx.session.state || null; }

// ─── State Constants ─────────────────────────────────────────
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

// ─── State-to-Label Map (for context-aware routing) ──────────
const STATE_LABELS = {
  [States.CREATE_SUBJECT]:     'Test yaratish (Fan tanlash)',
  [States.CREATE_NAME]:        'Test yaratish (Blok nomi)',
  [States.CREATE_QUESTIONS]:   'Test yaratish (Savollar kiritish)',
  [States.CREATE_AI_TEXT]:     'AI: Matndan test',
  [States.CREATE_AI_IMAGE]:    'AI: Rasmdan test',
  [States.CREATE_AI_QUESTIONS]:'AI: Savollardan test',
  [States.AI_ESSAY_ANALYSIS]:  'AI: Insho tahlili',
  [States.CREATE_SHELF_FOLDER]:'Javon: Papka yaratish',
  [States.USER_CONTACT]:       'Adminga murojaat',
  [States.ADMIN_BROADCAST]:    'Admin: Broadcast',
  [States.ADMIN_REPLY]:        'Admin: Javob yozish',
};

// ─── HTML/Text Escaping ──────────────────────────────────────
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Sanitize text for Telegram API (ensures valid UTF-8)
function sanitizeForTelegram(str) {
  if (!str) return '';
  let text = String(str);
  // Replace invalid UTF-8 sequences and control characters (except common whitespace)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Replace replacement character (U+FFFD) which indicates encoding issues
  text = text.replace(/\uFFFD/g, '');
  return text;
}

// ─── Universal Navigation Keyboard ──────────────────────────
/**
 * Builds an inline keyboard that ALWAYS has "🔙 Ortga" and "🏠 Asosiy Menyu".
 * @param {string|null} backAction - Callback data for "🔙 Ortga". If null, no back button.
 * @param {Array<Array>} extraButtons - Additional button rows to prepend.
 * @returns {object} Telegraf Markup.inlineKeyboard
 */
function navKb(backAction, extraButtons = []) {
  const rows = [...extraButtons];
  const navRow = [];
  if (backAction) navRow.push(Markup.button.callback('🔙 Ortga', backAction));
  navRow.push(Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'));
  rows.push(navRow);
  return Markup.inlineKeyboard(rows);
}

/**
 * Legacy helper — inline keyboard with just Home button and optional extra rows.
 */
function backToMainKb(extraButtons = []) {
  return Markup.inlineKeyboard([
    ...extraButtons,
    [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
  ]);
}

// ─── Safe Telegram Operations ────────────────────────────────
/**
 * Safely answer a callback query. Swallows "query is too old" errors.
 */
async function safeAnswerCb(ctx, text, opts) {
  try {
    await ctx.answerCbQuery(text, opts);
  } catch { /* query too old or already answered */ }
}

/**
 * Edit the current message. Falls back to a new reply if editing fails.
 */
async function safeEdit(ctx, text, extra = {}) {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...extra });
    return true;
  } catch {
    try { await ctx.reply(text, { parse_mode: 'HTML', ...extra }); } catch (e2) { console.warn('safeEdit failed:', e2.message); }
    return false;
  }
}

/**
 * Try to delete a message safely (swallows errors).
 */
async function safeDelete(ctx) {
  try { await ctx.deleteMessage(); } catch { /* silent */ }
}

// ─── Display Helpers ─────────────────────────────────────────
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

// ─── User Name Resolution ────────────────────────────────────
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

// ─── File Download Helper (DRY) ─────────────────────────────
/**
 * Download a file from a URL to a local path.
 * @param {string} url - The URL to download from.
 * @param {string} destPath - Local file path to write to.
 * @returns {Promise<void>}
 */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {}); // Cleanup partial file
      reject(err);
    });
  });
}

// ─── Document Parsing ────────────────────────────────────────
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

// ─── Admin Guard (Shared) ────────────────────────────────────
const { ADMIN_ID } = require('../config/config');

function isAdmin(userId) { return userId === ADMIN_ID; }

function adminGuard(fn) {
  return async (ctx, ...args) => {
    if (!isAdmin(ctx.from.id)) return safeAnswerCb(ctx, '⛔ Ruxsat yo\'q!', { show_alert: true });
    return fn(ctx, ...args);
  };
}

// ─── Context Builder (for Phase 2 contact routing) ───────────
/**
 * Builds a human-readable context string from the user's session.
 */
function buildUserContext(session) {
  if (!session || !session.state) return '📍 Asosiy Menyu';

  const parts = [];
  const label = STATE_LABELS[session.state];
  if (label) parts.push(`📍 ${label}`);
  else parts.push(`📍 ${session.state}`);

  const data = session.data || {};
  if (data.subject) {
    const { SUBJECTS } = require('../config/config');
    parts.push(`📚 Fan: ${SUBJECTS[data.subject] || data.subject}`);
  }
  if (data.block_name) parts.push(`📝 Blok: ${data.block_name}`);
  if (data.test_id) parts.push(`🔖 Test ID: ${data.test_id}`);

  return parts.join('\n');
}

module.exports = {
  activeTests, waitingRooms, pollChatMap, userNameCache,
  leaderboardCache, LEADERBOARD_TTL, States, STATE_LABELS, TTLMap,
  setState, clearState, updateData, getData, getState,
  navKb, backToMainKb, progressBar, safePercent, grade, parseSuffix,
  safeAnswerCb, safeEdit, safeDelete,
  getUserName, parseDocxQuestions, parseTextQuestions,
  escapeHtml, sanitizeForTelegram,
  downloadFile, isAdmin, adminGuard, buildUserContext,
};
