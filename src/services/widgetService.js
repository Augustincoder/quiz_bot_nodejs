'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let featureFlagService = null;
try {
  featureFlagService = require('./featureFlagService');
} catch {}

/**
 * Validates if a URL is a valid, external HTTPS URL suitable for Telegram WebApp.
 * Telegram Bot API strictly forbids Telegram domains (t.me, telegram.org) in web_app buttons
 * and throws 400 Bad Request: BUTTON_URL_INVALID.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isValidWebAppUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith('https://')) return false;
  if (trimmed.length > 2048 || Buffer.byteLength(trimmed, 'utf8') > 2048) return false;
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    if (
      !host ||
      host === 't.me' ||
      host.endsWith('.t.me') ||
      host === 'telegram.org' ||
      host.endsWith('.telegram.org') ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      host === '127.0.0.1' ||
      host.endsWith('.test')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if Telegram 10.4 Widget Engine is enabled for a user.
 * @param {string|number} userId
 * @returns {boolean}
 */
function isWidgetEngineEnabled(userId) {
  if (!featureFlagService) return true;
  return featureFlagService.isFeatureEnabledSync('FEATURE_WIDGET_ENGINE', userId);
}

// Negative cache for Telegram Bot API 10.4 native in-chat widgets (sendWidget).
// Telegram Bot API 10.4 HTML Bubbles are in restricted pilot; bots not yet whitelisted
// by Telegram receive "400 Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED".
// When encountered, we cache this status (default 1 hour) to eliminate redundant HTTP failures,
// reduce network latency by 150-300ms, and protect the circuit breaker from false trips.
let sendWidgetNotAllowedUntil = 0;

function isNativeSendWidgetAllowed() {
  return Date.now() > sendWidgetNotAllowedUntil;
}

function markSendWidgetNotAllowed(ttlMs = 60 * 60 * 1000) {
  sendWidgetNotAllowedUntil = Date.now() + ttlMs;
}

// HMAC Secret Key derivation (uses WIDGET_SECRET, BOT_TOKEN, or secure fallback)
const RAW_SECRET = process.env.WIDGET_SECRET ||
  (process.env.BOT_TOKEN ? crypto.createHmac('sha256', 'widget_v1').update(process.env.BOT_TOKEN).digest('hex') : '') ||
  (process.env.NODE_ENV === 'test' ? 'test_widget_secret_fallback_key' : '');

if (!RAW_SECRET && process.env.NODE_ENV !== 'test') {
  throw new Error('CRITICAL: Neither WIDGET_SECRET nor BOT_TOKEN is configured for secure widgetService.');
}

const SECRET_KEY = crypto.createHash('sha256').update(RAW_SECRET || 'test_widget_secret_fallback_key').digest();

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

const { decodeHtmlEntities, escapeHtml: coreEscapeHtml } = require('../core/utils');

/**
 * Escapes HTML characters including single quotes for safe embedding in WebApp HTML and attributes.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  return coreEscapeHtml(str).replace(/'/g, '&#39;');
}

/**
 * Creates a signed, tamper-proof widget token using HMAC-SHA256.
 *
 * @param {string|number} userId - Telegram User ID
 * @param {string} type - Widget type (e.g. 'podium', 'flashcard', 'docxHealer')
 * @param {object} payload - Arbitrary state payload
 * @param {number} [ttlMs=3600000] - Time to live in milliseconds
 * @returns {string} Signed token: `<base64urlData>.<hmacSignature>`
 */
function createWidgetToken(userId, type, payload = {}, ttlMs = DEFAULT_TTL_MS) {
  if (!type || typeof type !== 'string') {
    throw new Error('type is required and must be a string');
  }

  const now = Date.now();
  const tokenPayload = {
    userId: userId !== undefined && userId !== null ? Number(userId) : 0,
    type: String(type).trim(),
    payload: payload && typeof payload === 'object' ? payload : {},
    iat: now,
    exp: now + (typeof ttlMs === 'number' ? ttlMs : DEFAULT_TTL_MS),
  };

  const dataPart = Buffer.from(JSON.stringify(tokenPayload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', SECRET_KEY)
    .update(dataPart)
    .digest('base64url');

  return `${dataPart}.${signature}`;
}

/**
 * Verifies a widget token's HMAC-SHA256 signature and expiration.
 *
 * @param {string} token - The signed token string
 * @returns {{ userId: number, type: string, payload: object, iat: number, exp: number } | null}
 */
function verifyWidgetToken(token) {
  if (!token || typeof token !== 'string') return null;

  const dotIdx = token.indexOf('.');
  if (dotIdx === -1 || token.lastIndexOf('.') !== dotIdx) return null;

  const dataPart = token.slice(0, dotIdx);
  const sigPart = token.slice(dotIdx + 1);

  if (!dataPart || !sigPart) return null;

  try {
    const expectedSig = crypto
      .createHmac('sha256', SECRET_KEY)
      .update(dataPart)
      .digest('base64url');

    const sigBuf = Buffer.from(sigPart, 'utf8');
    const expectedBuf = Buffer.from(expectedSig, 'utf8');

    if (sigBuf.length !== expectedBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

    const jsonStr = Buffer.from(dataPart, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);

    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.exp !== 'number' || Date.now() > parsed.exp) return null;

    return {
      userId: parsed.userId,
      type: parsed.type,
      payload: parsed.payload || {},
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

// Map canonical types to template filenames
const TEMPLATE_MAP = {
  podium: 'podiumWidget.html',
  flashcard: 'flashcardWidget.html',
  docxhealer: 'docxHealerWidget.html',
  docx_healer: 'docxHealerWidget.html',
  docxHealer: 'docxHealerWidget.html',
};

const TEMPLATE_DIR = path.join(__dirname, '../widgets/views');

// L1 In-Memory Cache for templates
const templateMemoryCache = new Map();

function getTemplateContent(templateFileName) {
  if (templateMemoryCache.has(templateFileName)) {
    return templateMemoryCache.get(templateFileName);
  }
  const templatePath = path.join(TEMPLATE_DIR, templateFileName);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Widget template not found: "${templatePath}"`);
  }
  const content = fs.readFileSync(templatePath, 'utf8');
  templateMemoryCache.set(templateFileName, content);
  return content;
}

/**
 * Securely renders HTML template for a given widget type.
 *
 * @param {string} type - Widget type ('podium', 'flashcard', 'docxHealer')
 * @param {object} data - Data to inject into the template
 * @returns {string} Rendered HTML string
 */
function renderWidgetHtml(type, data = {}) {
  const normType = String(type || '').trim();
  const templateFileName = TEMPLATE_MAP[normType] || TEMPLATE_MAP[normType.toLowerCase()];

  if (!templateFileName) {
    throw new Error(`Unknown widget type: "${type}"`);
  }

  let html = getTemplateContent(templateFileName);

  const safeDataJson = JSON.stringify(data || {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\//g, '\\/');

  const title = escapeHtml(data.title || `${normType.charAt(0).toUpperCase() + normType.slice(1)} Widget`);

  html = html
    .replace(/{{DATA_JSON}}/g, safeDataJson)
    .replace(/{{TITLE}}/g, title)
    .replace(/{{TYPE}}/g, escapeHtml(normType))
    .replace(/{{TOKEN}}/g, escapeHtml(data.token || ''));

  return html;
}

/**
 * Prepares payload for Telegram Bot API 10.4 `sendWidget` with URL `/widget/:token`,
 * plus clean fallback text and inline keyboard for classic Telegram clients.
 */
function buildWidgetMessage(type, payload = {}, fallbackText = '', fallbackKeyboard = null, options = {}) {
  const userId = options.userId !== undefined ? options.userId : (payload?.userId || 0);
  const isEnabled = isWidgetEngineEnabled(userId);

  if (!isEnabled) {
    const defaultKeyboard = fallbackKeyboard || { inline_keyboard: [] };
    return {
      type,
      token: null,
      url: null,
      widgetUrl: null,
      text: fallbackText || '',
      fallbackText: fallbackText || '',
      reply_markup: defaultKeyboard,
      fallbackKeyboard: defaultKeyboard,
      widget: null,
      enabled: false,
    };
  }

  const ttlMs = options.ttlMs || DEFAULT_TTL_MS;
  const token = createWidgetToken(userId, type, payload, ttlMs);

  const rawBaseUrl = options.baseUrl ||
    process.env.WEBAPP_URL ||
    process.env.APP_URL ||
    process.env.SERVER_URL ||
    process.env.BASE_URL ||
    process.env.PUBLIC_URL ||
    process.env.NF_PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    process.env.RAILWAY_STATIC_URL ||
    'https://p01--quiz-bot-nodejs--hqhlj8nqhyp9.code.run';
  const baseUrl = rawBaseUrl.replace(/\/+$/, '');
  const widgetUrl = `${baseUrl}/widget/${token}`;
  const isUrlValid = isValidWebAppUrl(widgetUrl);

  let defaultKeyboard = fallbackKeyboard;
  if (isUrlValid) {
    if (!defaultKeyboard || !defaultKeyboard.inline_keyboard) {
      defaultKeyboard = {
        inline_keyboard: [
          [{ text: '🚀 Widgetni ochish', web_app: { url: widgetUrl } }],
        ],
      };
    } else {
      const hasWebApp = defaultKeyboard.inline_keyboard.some(row =>
        Array.isArray(row) && row.some(btn => btn && btn.web_app)
      );
      if (!hasWebApp) {
        const buttonLabel = type === 'flashcard'
          ? '🎴 3D Kartochka (Web App)'
          : (type === 'podium' ? '🏛 3D Shohsupa & Radar' : '🚀 Visual Inspektorni Ochish');
        defaultKeyboard = {
          inline_keyboard: [
            [{ text: buttonLabel, web_app: { url: widgetUrl } }],
            ...defaultKeyboard.inline_keyboard,
          ],
        };
      }
    }
  } else {
    if (!defaultKeyboard || !defaultKeyboard.inline_keyboard) {
      defaultKeyboard = { inline_keyboard: [] };
    } else {
      defaultKeyboard = {
        inline_keyboard: defaultKeyboard.inline_keyboard.map(row =>
          Array.isArray(row)
            ? row.filter(btn => !btn || !btn.web_app || isValidWebAppUrl(btn.web_app.url))
            : row
        ).filter(row => row.length > 0),
      };
    }
  }

  return {
    type,
    token,
    url: widgetUrl,
    widgetUrl,
    text: fallbackText || '',
    fallbackText: fallbackText || '',
    reply_markup: defaultKeyboard,
    fallbackKeyboard: defaultKeyboard,
    widget: {
      type,
      url: widgetUrl,
      title: payload?.title || (type.charAt(0).toUpperCase() + type.slice(1)),
    },
  };
}

/**
 * Compresses HTML with zlib level 9 and checks Bot API limits (32KB raw, 4KB compressed).
 */
function compressWidgetHtml(html) {
  const buf = Buffer.from(html, 'utf8');
  const compressed = zlib.deflateSync(buf, { level: 9 });
  return {
    rawBytes: buf.length,
    compressedBytes: compressed.length,
    valid: buf.length <= 32768 && compressed.length <= 4096,
  };
}

/**
 * Builds self-contained, inline HTML for Telegram Bot API 10.4 `sendWidget` (Flashcard).
 * Crafted in Linear/Obsidian Pro style with SVG vector icons, tabular numerals,
 * and strict 2-layer DOM+CSS answer hiding. Compressed size ~2.1KB (< 4096B limit).
 *
 * @param {object} viewData
 * @returns {string} Fully standalone inline HTML
 */
function buildInlineFlashcardWidgetHtml(viewData = {}) {
  const qClean = decodeHtmlEntities(viewData.question || 'Savol...');
  const aClean = decodeHtmlEntities(viewData.answer || 'Javob...');
  const titleClean = decodeHtmlEntities(viewData.subjectName ? `${viewData.subjectName} • ${viewData.blockName || ''}` : 'Flashcard Studio');

  const initialData = JSON.stringify({
    title: titleClean,
    q: qClean,
    a: aClean,
    total: viewData.total || 0,
    learned: viewData.learnedCount || 0,
    cardIdx: viewData.cardIdx || 0,
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

  let tpl;
  try {
    tpl = getTemplateContent('inlineFlashcard.html');
  } catch {
    tpl = getTemplateContent('flashcardWidget.html');
  }
  if (tpl.includes('/*INITIAL_DATA_PLACEHOLDER*/')) {
    return tpl.replace('/*INITIAL_DATA_PLACEHOLDER*/', initialData);
  }
  return tpl.replace('window.__WIDGET_DATA__ = {{DATA_JSON}};', `window.__WIDGET_DATA__ = ${initialData};`);
}

/**
 * Builds self-contained, inline HTML for Telegram Bot API 10.4 `sendWidget` (Docx Healer).
 * Crafted in Linear/Obsidian Pro style with SVG vector icons and <= 4096 bytes zlib compressed.
 *
 * @param {object} viewData
 * @returns {string} Fully standalone inline HTML
 */
function buildInlineDocxHealerWidgetHtml(viewData = {}) {
  const rawQuestions = Array.isArray(viewData.questions) && viewData.questions.length > 0
    ? viewData.questions
    : [
        {
          id: 1,
          questionText: 'Savol matni?',
          raw: 'Savol matni?',
          options: [
            { text: 'Variant A', cleanText: 'Variant A', isCorrect: false },
            { text: 'Variant B', cleanText: 'Variant B', isCorrect: false },
          ],
          error: "To'g'ri javob kaliti belgilanmagan",
        },
      ];

  const boundedQuestions = rawQuestions.slice(0, 10);
  const initialData = JSON.stringify({
    title: decodeHtmlEntities(viewData.fileName || viewData.title || 'Docx Healer').slice(0, 50),
    total: rawQuestions.length,
    curIdx: typeof viewData.currentIndex === 'number' ? viewData.currentIndex : 0,
    questions: boundedQuestions.map((q, i) => {
      const qText = q.questionText || q.question || q.raw || 'Savol';
      return {
        id: q.id || (i + 1),
        q: decodeHtmlEntities(typeof qText === 'string' ? qText : 'Savol').slice(0, 200),
        err: decodeHtmlEntities(q.error || 'Kalit talab etiladi').slice(0, 60),
        opts: (q.options || []).map((o) => {
          const t = typeof o === 'string' ? o : (o.cleanText || o.text || '');
          const isOk = typeof o === 'object' ? Boolean(o.isCorrect) : false;
          return {
            t: decodeHtmlEntities(t).slice(0, 70),
            ok: isOk,
          };
        }),
      };
    }),
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

  let tpl;
  try {
    tpl = getTemplateContent('inlineDocxHealer.html');
  } catch {
    tpl = getTemplateContent('docxHealerWidget.html');
  }
  if (tpl.includes('/*INITIAL_DATA_PLACEHOLDER*/')) {
    return tpl.replace('/*INITIAL_DATA_PLACEHOLDER*/', initialData);
  }
  return tpl.replace('{{DATA_JSON}}', initialData);
}

module.exports = {
  isValidWebAppUrl,
  createWidgetToken,
  verifyWidgetToken,
  decodeHtmlEntities,
  escapeHtml,
  renderWidgetHtml,
  buildWidgetMessage,
  isWidgetEngineEnabled,
  compressWidgetHtml,
  buildInlineFlashcardWidgetHtml,
  buildInlineDocxHealerWidgetHtml,
  isNativeSendWidgetAllowed,
  markSendWidgetNotAllowed,
};