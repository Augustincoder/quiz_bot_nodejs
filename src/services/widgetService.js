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

// HMAC Secret Key derivation (uses WIDGET_SECRET, BOT_TOKEN, or secure fallback)
const RAW_SECRET = process.env.WIDGET_SECRET || process.env.BOT_TOKEN || 'quiz_bot_widget_hmac_secret_v1';
const SECRET_KEY = crypto.createHash('sha256').update(RAW_SECRET).digest();

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

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>
*{box-sizing:border-box;margin:0;padding:0;user-select:none;-webkit-user-select:none;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif}
html,body{width:100%;min-height: 290px;background:var(--tg-theme-bg-color,#080b12);color:var(--tg-theme-text-color,#f1f5f9);overflow-x:hidden;font-variant-numeric:tabular-nums}
.wrap{padding:12px 14px;min-height: 290px;display:flex;flex-direction:column;justify-content:space-between;background:radial-gradient(ellipse 90% 50% at 50% -10%,rgba(59,130,246,0.14),transparent)}
.top-bar{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;font-weight:600;color:#94a3b8;letter-spacing:-0.01em}
.pill{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.09);color:#e2e8f0;padding:2px 9px;border-radius:99px;font-size:11px;font-weight:700}
.bar-wrap{background:rgba(255,255,255,0.07);height:4px;border-radius:99px;margin:7px 0 11px;overflow:hidden}
.bar-fill{height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#10b981);border-radius:99px;transition:width 0.35s cubic-bezier(0.22,1,0.36,1)}
.card-box{flex:1;display:flex;align-items:stretch;justify-content:center;min-height:184px;margin-bottom:11px;perspective:1100px;touch-action:pan-y}
.card{width:100%;min-height:184px;position:relative;border-radius:16px;cursor:pointer;transform-style:preserve-3d;-webkit-transform-style:preserve-3d;transition:transform 0.42s cubic-bezier(0.22,1,0.36,1)}
.card.flipped{transform:rotateY(180deg);-webkit-transform:rotateY(180deg)}
.face{position:absolute;inset:0;width:100%;height:100%;border-radius:16px;padding:16px;display:flex;flex-direction:column;justify-content:space-between;align-items:center;text-align:center;backface-visibility:hidden;-webkit-backface-visibility:hidden;background:#0f1420;border:1px solid rgba(255,255,255,0.08);box-shadow:inset 0 1px 0 rgba(255,255,255,0.12),0 16px 32px -8px rgba(0,0,0,0.6);transition:opacity 0.15s ease,visibility 0.15s ease}
.face.front{z-index:2;visibility:visible;opacity:1}
.face.back{transform:rotateY(180deg);-webkit-transform:rotateY(180deg);background:#0b1917;border-color:rgba(16,185,129,0.28);box-shadow:inset 0 1px 0 rgba(52,211,153,0.18),0 16px 32px -8px rgba(0,0,0,0.6);z-index:1;visibility:hidden;opacity:0;pointer-events:none}
.card.flipped .face.front{visibility:hidden;opacity:0;pointer-events:none;z-index:1}
.card.flipped .face.back{visibility:visible;opacity:1;pointer-events:auto;z-index:2}
.tag{font-size:10px;font-weight:700;letter-spacing:0.08em;padding:3px 10px;border-radius:6px;text-transform:uppercase;display:inline-flex;align-items:center;gap:5px}
.front .tag{background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.22)}
.back .tag{background:rgba(16,185,129,0.14);color:#34d399;border:1px solid rgba(16,185,129,0.25)}
.q-text{font-size:15px;font-weight:600;line-height:1.48;color:#f8fafc;word-break:break-word;max-height:110px;overflow-y: auto;padding:0 4px;margin:auto 0;letter-spacing:-0.01em}
.a-text{font-size:15.5px;font-weight:700;line-height:1.48;color:#6ee7b7;word-break:break-word;max-height:110px;overflow-y: auto;padding:0 4px;margin:auto 0}
.hint{font-size:11px;color:#64748b;font-weight:500;display:flex;align-items:center;gap:5px}
.actions{display:flex;gap:8px}
.btn{flex:1;padding:10px 12px;border-radius:11px;font-size:12.5px;font-weight:600;cursor:pointer;transition:transform 0.12s ease,background 0.15s ease;display:flex;align-items:center;justify-content:center;gap:6px;border:1px solid rgba(255,255,255,0.08);box-shadow:inset 0 1px 0 rgba(255,255,255,0.08)}
.btn:active{transform:scale(0.97)}
.btn-repeat{background:rgba(244,63,94,0.12);color:#fda4af;border-color:rgba(244,63,94,0.25)}
.btn-known{background:rgba(16,185,129,0.14);color:#6ee7b7;border-color:rgba(16,185,129,0.28)}
svg{width:14px;height:14px;stroke:currentColor;stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0}
</style></head><body>
<div class="wrap">
  <div class="top-bar"><span id="title">Flashcard</span><span class="pill" id="prog">0 / 0</span></div>
  <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
  <div class="card-box">
    <div class="card" id="card">
      <div class="face front">
        <div class="tag">SAVOL</div>
        <div class="q-text" id="q-text">Yuklanmoqda...</div>
        <div class="hint"><svg viewBox="0 0 24 24"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"/></svg>Javobni ko'rish uchun bosing</div>
      </div>
      <div class="face back">
        <div class="tag">TASDIQLANGAN JAVOB</div>
        <div class="a-text" id="a-text"></div>
        <div class="hint"><svg viewBox="0 0 24 24"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8"/></svg>Savolga qaytish</div>
      </div>
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-repeat" id="btn-rep" onclick="triggerAction('left','repeat')"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>Qaytarish</button>
    <button class="btn btn-known" id="btn-kno" onclick="triggerAction('right','known')"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Bilib oldim</button>
  </div>
</div>
<script>
var W = window.TelegramWidget || window.Telegram && window.Telegram.WebApp || {};
var card = document.getElementById('card');
var isAnim = false;
var curAnswer = '';

function clean(s) {
  if (!s) return '';
  return String(s).replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function flip() {
  if (isAnim) return;
  var willFlip = !card.classList.contains('flipped');
  if (willFlip) {
    document.getElementById('a-text').textContent = curAnswer;
  }
  card.classList.toggle('flipped');
  if (W.HapticFeedback && typeof W.HapticFeedback.selectionChanged === 'function') {
    W.HapticFeedback.selectionChanged();
  }
}

card.onclick = function() {
  if (isAnim) return;
  flip();
};

function render(dataStr) {
  try {
    var d = typeof dataStr === 'string' ? JSON.parse(dataStr) : (dataStr || {});
    if (d.isFinished) {
      document.querySelector('.card-box').innerHTML = '<div class="face front" style="position:relative;width:100%;visibility:visible;opacity:1;border-color:rgba(16,185,129,0.3)"><div class="tag" style="background:rgba(16,185,129,0.15);color:#34d399;border-color:rgba(16,185,129,0.3)">YAKUNLANDI</div><div class="q-text" style="color:#6ee7b7;font-weight:700">Barcha kartochkalar muvaffaqiyatli o‘zlashtirildi</div><div class="hint">Yangi blok tanlashingiz mumkin</div></div>';
      var actions = document.querySelector('.actions');
      if (actions) actions.style.display = 'none';
      document.getElementById('bar').style.width = '100%';
      return;
    }
    card.classList.remove('flipped');
    document.getElementById('a-text').textContent = '';
    if (d.q) document.getElementById('q-text').textContent = clean(d.q);
    if (d.a !== undefined) curAnswer = clean(d.a);
    if (d.title) document.getElementById('title').textContent = clean(d.title);
    if (d.total) {
      var p = Math.round(((d.learned || 0) / d.total) * 100);
      document.getElementById('prog').textContent = (d.learned || 0) + ' / ' + d.total + ' (' + p + '%)';
      document.getElementById('bar').style.width = p + '%';
    }
  } catch(e) {}
}

function triggerAction(direction, act) {
  if (isAnim) return;
  isAnim = true;

  if (W.HapticFeedback && typeof W.HapticFeedback.impactOccurred === 'function') {
    W.HapticFeedback.impactOccurred('medium');
  }

  var transX = direction === 'right' ? '120%' : '-120%';
  var rot = direction === 'right' ? '12deg' : '-12deg';
  var isFlipped = card.classList.contains('flipped');
  card.style.transition = 'transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease';
  card.style.transform = (isFlipped ? 'rotateY(180deg) ' : '') + 'translateX(' + transX + ') rotate(' + rot + ')';
  card.style.opacity = '0';

  if (typeof W.request === 'function') {
    W.request(act).then(function(res) {
      if (res && res.result && res.result !== 'OK') {
        lastData = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
        animateIn(res.result);
      } else {
        resetCard();
      }
    }).catch(function() {
      resetCard();
    });
  } else if (typeof W.sendQuery === 'function') {
    W.sendQuery(act);
    setTimeout(resetCard, 300);
  } else {
    setTimeout(resetCard, 300);
  }
}

function animateIn(newData) {
  card.style.transition = 'none';
  card.classList.remove('flipped');
  render(newData);
  card.style.transform = 'translateY(14px) scale(0.94)';
  card.style.opacity = '0';

  void card.offsetWidth;

  card.style.transition = 'transform 0.26s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease';
  card.style.transform = 'translate(0, 0) scale(1)';
  card.style.opacity = '1';

  setTimeout(function() {
    isAnim = false;
    card.style.transition = '';
    card.style.transform = '';
  }, 270);
}

function resetCard() {
  card.style.transition = 'none';
  card.classList.remove('flipped');
  document.getElementById('a-text').textContent = '';
  void card.offsetWidth;
  card.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
  card.style.transform = '';
  card.style.opacity = '1';
  isAnim = false;
}

var startX = 0, startY = 0, curX = 0, isDragging = false;
card.addEventListener('touchstart', function(e) {
  if (isAnim) return;
  var t = e.touches[0];
  startX = t.clientX;
  startY = t.clientY;
  curX = 0;
  isDragging = true;
}, { passive: true });

card.addEventListener('touchmove', function(e) {
  if (!isDragging || isAnim) return;
  var t = e.touches[0];
  var dx = t.clientX - startX;
  var dy = t.clientY - startY;
  if (Math.abs(dx) > Math.abs(dy)) {
    curX = dx;
    var base = card.classList.contains('flipped') ? 'rotateY(180deg) ' : '';
    card.style.transition = 'none';
    card.style.transform = base + 'translateX(' + dx + 'px) rotate(' + (dx * 0.045) + 'deg)';
  }
}, { passive: true });

card.addEventListener('touchend', function() {
  if (!isDragging || isAnim) return;
  isDragging = false;
  if (curX > 65) {
    triggerAction('right', 'known');
  } else if (curX < -65) {
    triggerAction('left', 'repeat');
  } else if (Math.abs(curX) > 5) {
    card.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1)';
    card.style.transform = card.classList.contains('flipped') ? 'rotateY(180deg)' : '';
  }
}, { passive: true });

var lastData = '';
function getLatestWidgetData() {
  var pd = W.publicData;
  var cd = W.chatData;
  if (pd && String(pd).indexOf('"q"') !== -1) return pd;
  if (cd && String(cd).indexOf('"q"') !== -1) return cd;
  return pd || cd || '';
}

lastData = getLatestWidgetData();

function checkData() {
  var nextD = getLatestWidgetData();
  if (nextD && nextD !== lastData) {
    lastData = nextD;
    if (!isAnim) {
      animateIn(nextD);
    }
  }
}
setInterval(checkData, 350);
if (W.onEvent) {
  W.onEvent('chatDataChanged', function() { checkData(); });
  W.onEvent('publicDataChanged', function() { checkData(); });
}
if (W.setResizeAnchor) {
  try { W.setResizeAnchor('top'); } catch(e) {}
}
if (typeof W.ready === 'function') { W.ready(); }
render(${initialData});
</script></body></html>`;
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

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>
*{box-sizing:border-box;margin:0;padding:0;user-select:none;-webkit-user-select:none;font-family:-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',sans-serif}
html,body{width:100%;min-height: 300px;background:var(--tg-theme-bg-color,#080b12);color:var(--tg-theme-text-color,#f1f5f9);overflow-x:hidden;font-variant-numeric:tabular-nums}
.wrap{padding:12px 14px;min-height: 300px;display:flex;flex-direction:column;justify-content:space-between;background:radial-gradient(ellipse 90% 50% at 50% -10%,rgba(99,102,241,0.14),transparent)}
.top-bar{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;font-weight:600;color:#94a3b8}
.badge{font-size:10px;padding:2px 9px;border-radius:6px;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.28);color:#fbbf24;font-weight:700;letter-spacing:0.03em}
.badge.ok{background:rgba(16,185,129,0.14);border-color:rgba(16,185,129,0.28);color:#34d399}
.bar-wrap{background:rgba(255,255,255,0.07);height:4px;border-radius:99px;margin:7px 0 10px;overflow:hidden}
.bar-fill{height:100%;width:0%;background:linear-gradient(90deg,#6366f1,#10b981);transition:width 0.3s ease}
.card-box{flex:1;display:flex;flex-direction:column;min-height:198px;background:#0f1420;border:1px solid rgba(255,255,255,0.08);box-shadow:inset 0 1px 0 rgba(255,255,255,0.1),0 14px 28px -8px rgba(0,0,0,0.55);border-radius:15px;padding:13px;margin-bottom:10px;position:relative;transition:transform 0.22s cubic-bezier(0.22,1,0.36,1),opacity 0.2s}
.q-title{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;margin-bottom:5px;font-weight:700}
.q-text{font-size:13.5px;font-weight:600;line-height:1.42;max-height:60px;overflow-y: auto;margin-bottom:9px;word-break:break-word;color:#f8fafc}
.opts{display:flex;flex-direction:column;gap:6px}
.opt{display:flex;align-items:center;gap:9px;padding:7.5px 10px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);cursor:pointer;transition:all 0.14s;font-size:12.5px;line-height:1.3}
.opt:active{transform:scale(0.985)}
.opt.sel{background:rgba(16,185,129,0.14);border-color:#10b981;font-weight:600}
.opt-l{width:21px;height:21px;border-radius:6px;background:rgba(255,255,255,0.07);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#94a3b8;flex-shrink:0}
.opt.sel .opt-l{background:#10b981;color:#052e16}
.opt-t{flex:1;word-break:break-word;color:#e2e8f0}
.actions{display:flex;gap:7px}
.btn{flex:1;padding:9.5px 10px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);font-size:12px;font-weight:600;cursor:pointer;color:#e2e8f0;background:#141a26;display:flex;align-items:center;justify-content:center;gap:5px;transition:opacity 0.2s}
.btn:active{opacity:0.8}
.btn:disabled{opacity:0.3;cursor:default}
.btn-heal{background:linear-gradient(135deg,#4f46e5,#7c3aed);border-color:rgba(255,255,255,0.16);color:#fff}
</style></head><body>
<div class="wrap">
  <div class="top-bar"><span id="title">Docx Healer</span><span class="badge" id="badge">Xato #1</span></div>
  <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
  <div class="card-box" id="box">
    <div class="q-title" id="q-hdr">SAVOL 01 / 03</div>
    <div class="q-text" id="q-text">Yuklanmoqda...</div>
    <div class="opts" id="opts"></div>
  </div>
  <div class="actions">
    <button class="btn" id="btn-prev" onclick="nav(-1)">Oldingi</button>
    <button class="btn btn-heal" id="btn-heal" onclick="healAll()">AI Auto-Heal</button>
    <button class="btn" id="btn-next" onclick="nav(1)">Keyingi</button>
  </div>
</div>
<script>
var W = window.TelegramWidget || (window.Telegram && window.Telegram.WebApp) || {};
if (W.ready && typeof W.ready === 'function') W.ready();
if (W.setResizeAnchor && typeof W.setResizeAnchor === 'function') W.setResizeAnchor('top');

var initialData = ${initialData};
var qs = initialData.questions || [];
var cur = initialData.curIdx || 0;
var isAnim = false;
var box = document.getElementById('box');

function clean(s) {
  if (!s) return '';
  return String(s).replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function updateProgress() {
  if (!qs.length) {
    document.getElementById('bar').style.width = '100%';
    return;
  }
  var fixed = qs.filter(function(q) {
    return q.opts && q.opts.some(function(o) { return o.ok; });
  }).length;
  var pct = Math.round((fixed / qs.length) * 100);
  document.getElementById('bar').style.width = pct + '%';
}

function render() {
  if (!qs.length) {
    box.innerHTML = '<div class="q-title" style="color:#34d399">TAYYOR</div><div class="q-text" style="color:#6ee7b7;font-weight:700">Barcha savollar muvaffaqiyatli tekshirildi va saqlandi.</div>';
    var acts = document.querySelector('.actions');
    if (acts) acts.style.display = 'none';
    updateProgress();
    return;
  }
  var q = qs[cur];
  if (!q) return;

  var letters = ['A', 'B', 'C', 'D', 'E'];
  var isFixed = q.opts && q.opts.some(function(o) { return o.ok; });

  document.getElementById('title').textContent = initialData.title || 'Docx Healer';
  var badge = document.getElementById('badge');
  badge.textContent = isFixed ? 'Kalit tanlandi' : clean(q.err || 'Kalit yo‘q');
  badge.className = 'badge' + (isFixed ? ' ok' : '');

  document.getElementById('q-hdr').textContent = 'SAVOL ' + (cur + 1) + ' / ' + qs.length;
  document.getElementById('q-text').textContent = clean(q.q || 'Savol matni');

  document.getElementById('btn-prev').disabled = (cur === 0);
  document.getElementById('btn-next').disabled = (cur === qs.length - 1);

  var optsBox = document.getElementById('opts');
  optsBox.innerHTML = '';

  (q.opts || []).forEach(function(opt, idx) {
    var div = document.createElement('div');
    div.className = 'opt' + (opt.ok ? ' sel' : '');
    div.onclick = function() { pickKey(idx); };

    var l = document.createElement('div');
    l.className = 'opt-l';
    l.textContent = letters[idx] || (idx + 1);

    var t = document.createElement('div');
    t.className = 'opt-t';
    t.textContent = clean(opt.t);

    div.appendChild(l);
    div.appendChild(t);
    optsBox.appendChild(div);
  });

  updateProgress();
}

function pickKey(optIdx) {
  if (isAnim) return;
  var q = qs[cur];
  if (!q || !q.opts) return;

  isAnim = true;
  q.opts.forEach(function(o, i) {
    o.ok = (i === optIdx);
  });
  render();

  if (W.HapticFeedback && typeof W.HapticFeedback.selectionChanged === 'function') {
    W.HapticFeedback.selectionChanged();
  }

  var payload = { action: 'docx_pick', qIdx: cur, optIdx: optIdx };
  var onDone = function(res) {
    qs.splice(cur, 1);

    if (res && res.result && res.result !== 'OK') {
      try {
        var d = typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
        if (d.isFinished || d.remaining === 0) {
          qs = [];
        } else if (d.currentQuestion) {
          if (cur < qs.length) {
            qs[cur] = d.currentQuestion;
          } else {
            qs.push(d.currentQuestion);
          }
        }
      } catch (e) {}
    }

    if (cur >= qs.length && cur > 0) cur = qs.length - 1;
    isAnim = false;
    render();
  };

  if (typeof W.request === 'function') {
    W.request(JSON.stringify(payload)).then(onDone).catch(function() { onDone(null); });
  } else if (typeof W.sendQuery === 'function') {
    W.sendQuery(JSON.stringify(payload));
    setTimeout(function() { onDone(null); }, 220);
  } else {
    setTimeout(function() { onDone(null); }, 220);
  }
}

function nav(delta) {
  if (isAnim) return;
  var nextIdx = cur + delta;
  if (nextIdx < 0 || nextIdx >= qs.length) return;

  isAnim = true;
  var transX = delta > 0 ? '-100%' : '100%';
  box.style.transition = 'transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.16s ease';
  box.style.transform = 'translateX(' + transX + ') scale(0.96)';
  box.style.opacity = '0';

  setTimeout(function() {
    cur = nextIdx;
    render();
    box.style.transition = 'none';
    box.style.transform = (delta > 0 ? 'translateX(100%)' : 'translateX(-100%)') + ' scale(0.96)';
    void box.offsetWidth;

    box.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease';
    box.style.transform = 'translateX(0) scale(1)';
    box.style.opacity = '1';

    setTimeout(function() {
      isAnim = false;
      box.style.transition = '';
      box.style.transform = '';
    }, 230);
  }, 180);
}

function healAll() {
  var btn = document.getElementById('btn-heal');
  btn.textContent = 'AI...';
  btn.disabled = true;

  if (W.HapticFeedback && typeof W.HapticFeedback.impactOccurred === 'function') {
    W.HapticFeedback.impactOccurred('medium');
  }

  var payload = { action: 'docx_heal_all' };
  if (typeof W.request === 'function') {
    W.request(JSON.stringify(payload)).then(function(res) {
      btn.textContent = 'AI Auto-Heal';
      btn.disabled = false;
      if (res && res.result && res.result !== 'OK') {
        try {
          var d = typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
          if (d.isFinished || d.remaining === 0) {
            qs = [];
          } else if (Array.isArray(d.questions)) {
            qs = d.questions;
          } else if (d.currentQuestion) {
            qs = [d.currentQuestion];
            cur = 0;
          }
        } catch(e) {}
      } else {
        heuristicHeal();
      }
      render();
    }).catch(function() {
      heuristicHeal();
      btn.textContent = 'AI Auto-Heal';
      btn.disabled = false;
      render();
    });
  } else {
    heuristicHeal();
    setTimeout(function() {
      btn.textContent = 'AI Auto-Heal';
      btn.disabled = false;
      render();
    }, 300);
  }
}

function heuristicHeal() {
  qs.forEach(function(q) {
    if (q.opts && q.opts.length > 0 && !q.opts.some(function(o) { return o.ok; })) {
      q.opts[0].ok = true;
    }
  });
}

var startX = 0, startY = 0, curX = 0, isDragging = false;
box.addEventListener('touchstart', function(e) {
  if (isAnim) return;
  var t = e.touches[0];
  startX = t.clientX;
  startY = t.clientY;
  curX = 0;
  isDragging = true;
}, { passive: true });

box.addEventListener('touchmove', function(e) {
  if (!isDragging || isAnim) return;
  var t = e.touches[0];
  var dx = t.clientX - startX;
  var dy = t.clientY - startY;
  if (Math.abs(dx) > Math.abs(dy)) {
    curX = dx;
    box.style.transition = 'none';
    box.style.transform = 'translateX(' + (dx * 0.7) + 'px)';
  }
}, { passive: true });

box.addEventListener('touchend', function() {
  if (!isDragging || isAnim) return;
  isDragging = false;
  if (curX < -50 && cur < qs.length - 1) {
    nav(1);
  } else if (curX > 50 && cur > 0) {
    nav(-1);
  } else {
    box.style.transition = 'transform 0.2s ease';
    box.style.transform = '';
  }
}, { passive: true });

render();
</script></body></html>`;
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
};