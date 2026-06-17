'use strict';
const { Markup } = require('telegraf');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { ADMIN_ID, SUBJECTS } = require('../config/config');

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
const userNameCache = new TTLMap(86400000); // 24 hours TTL
const leaderboardCache = { text: null, ts: 0 };
const LEADERBOARD_TTL  = 120_000;

// ─── Session State Helpers ───────────────────────────────────
const setState = (ctx, stateName) => { ctx.session.state = stateName; };
const clearState = (ctx) => { ctx.session.state = null; ctx.session.data = {}; };
const updateData = async (ctx, patch) => { ctx.session.data = { ...(ctx.session.data || {}), ...patch }; };
const getData = async (ctx) => ctx.session.data || {};
const getState = (ctx) => ctx.session.state || null;

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
  ADMIN_AI_TESTS_SUBJECT:   'admin:ai_tests_subject',
  ADMIN_AI_TESTS_TYPE:      'admin:ai_tests_type',
  ADMIN_AI_TESTS_TEXT:      'admin:ai_tests_text',
  ADMIN_AI_TESTS_IMAGE:     'admin:ai_tests_image',
  ADMIN_AI_TESTS_IMAGE_WAIT: 'admin:ai_tests_image_wait',
  ADMIN_AI_TESTS_ADAPTIVE_USER: 'admin:ai_tests_adaptive_user',
  ADMIN_AI_TESTS_ADAPTIVE_COUNT: 'admin:ai_tests_adaptive_count',
  ADMIN_AI_TESTS_GENERATE:  'admin:ai_tests_generate',
};

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

// ─── Helpers ─────────────────────────────────────────────────
const escapeHtml = (str) => String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sanitizeForTelegram = (str) => str ? String(str).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, '') : '';

const navKb = (backAction, extraButtons = []) => {
  const rows = [...extraButtons];
  const navRow = [];
  if (backAction) navRow.push(Markup.button.callback('🔙 Ortga', backAction));
  navRow.push(Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main'));
  rows.push(navRow);
  return Markup.inlineKeyboard(rows);
};

const backToMainKb = (extraButtons = []) => Markup.inlineKeyboard([...extraButtons, [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]]);

const safeAnswerCb = async (ctx, text, opts) => { try { await ctx.answerCbQuery(text, opts); } catch {} };

const safeEdit = async (ctx, text, extra = {}) => {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...extra });
    return true;
  } catch {
    try { await ctx.reply(text, { parse_mode: 'HTML', ...extra }); return true; } catch { return false; }
  }
};

const safeDelete = async (ctx) => { try { await ctx.deleteMessage(); } catch {} };

const progressBar = (current, total, length = 15) => {
  if (total <= 0) return '░'.repeat(length);
  const filled = Math.floor(length * Math.min(current, total) / total);
  return '▓'.repeat(filled) + '░'.repeat(length - filled);
};

const safePercent = (correct, total) => total > 0 ? Math.round(correct / total * 1000) / 10 : 0;

const grade = (percent) => {
  if (percent >= 90) return "🏆 A'lo!";
  if (percent >= 75) return '👍 Yaxshi!';
  if (percent >= 60) return '📈 Qoniqarli';
  return "📚 Ko'proq mashq kerak";
};

const parseSuffix = (str, prefix) => str.slice(prefix.length);

async function getUserName(bot, userId) {
  const uid = String(userId);
  if (userNameCache.has(uid)) return userNameCache.get(uid);
  try {
    const chat = await bot.telegram.getChat(uid);
    const name = chat.first_name ? `${chat.first_name}${chat.last_name ? ' ' + chat.last_name : ''}` : 'Sirli Talaba';
    userNameCache.set(uid, name);
    return name;
  } catch { return 'Sirli Talaba'; }
}

const downloadFile = (url, destPath) => new Promise((resolve, reject) => {
  const proto = url.startsWith('https') ? https : http;
  const file = fs.createWriteStream(destPath);
  proto.get(url, (res) => {
    res.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
  }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
});

async function parseDocxQuestions(filePath, mode = 'hash') {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ path: filePath });
  return parseTextQuestions(result.value, mode);
}

function parseTextQuestions(text, mode = 'hash') {
  const valid = [];
  const invalid = [];
  let rawBlocks = text.includes('+++++') ? text.split(/\+{5,}/) : text.split(/\n\s*\n/);

  for (const block of rawBlocks) {
    if (!block.trim()) continue;
    let parts = block.includes('=====') ? block.split(/={5,}/) : block.split('\n');
    parts = parts.map(p => p.trim()).filter(Boolean);

    if (parts.length < 2) { invalid.push(block.trim()); continue; }

    let questionText = parts[0].replace(/^\d+[\)\.]\s*/, '').trim();
    const opts = [];
    let correctIdx = -1;

    for (let i = 1; i < parts.length; i++) {
      let optText = parts[i];
      let isCorrect = (mode === 'hash' && optText.startsWith('#')) || (mode === 'first' && i === 1);
      if (mode === 'hash' && isCorrect) optText = optText.substring(1).trim();
      optText = optText.replace(/^[a-eA-E1-5][\)\.]\s*/, '').trim();
      if (!optText) continue;
      opts.push(optText);
      if (isCorrect) correctIdx = opts.length - 1;
    }

    if (correctIdx !== -1 && opts.length >= 2) valid.push({ question: questionText, options: opts, correct_index: correctIdx });
    else invalid.push(block.trim());
  }
  return { valid, invalid };
}

const isAdmin = (userId) => String(userId) === String(ADMIN_ID);

const adminGuard = (fn) => async (ctx, ...args) => {
  if (!isAdmin(ctx.from.id)) return safeAnswerCb(ctx, '⛔ Ruxsat yo\'q!', { show_alert: true });
  return fn(ctx, ...args);
};

const buildUserContext = (session) => {
  if (!session?.state) return '📍 Asosiy Menyu';
  const parts = [`📍 ${STATE_LABELS[session.state] || session.state}`];
  const data = session.data || {};
  if (data.subject) parts.push(`📚 Fan: ${SUBJECTS[data.subject] || data.subject}`);
  if (data.block_name) parts.push(`📝 Blok: ${data.block_name}`);
  if (data.test_id) parts.push(`🔖 Test ID: ${data.test_id}`);
  return parts.join('\n');
};

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

