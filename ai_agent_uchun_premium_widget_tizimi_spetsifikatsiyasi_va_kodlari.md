# 🎯 AI AGENT EXECUTION PROMPT: CLEAN PREMIUM WIDGET SYSTEM OVERHAUL

> **ROLE & OBJECTIVE FOR AI AGENT:**
> You are a Principal Staff Frontend Architect & UI/UX Designer. Your task is to upgrade the entire Telegram Bot API 10.4 Inline Widget & WebApp Widget subsystem of `quiz-bot-nodejs` to a **Linear / Raycast / Apple Pro Obsidian** design standard while preserving 100% of backend contracts, security tokens, and Telegram Bot API 10.4 sandbox constraints.

---

## 🏛 1. PREMIUM DESIGN SYSTEM RULES (ANTI-"AI SLOP" MANIFESTO)

1. **Zero Emoji Spam in UI Controls:**
   - Replace generic emojis (`👈`, `👉`, `🔄`, `🗑️`, `✨`, `👑`) inside interactive buttons and status pills with **crisp 1.75px-stroke inline SVG vector icons**.
2. **Obsidian & Specular Glass Hierarchy:**
   - **Canvas (`--bg-canvas`):** `#07090E` with subtle top radial ambient light (`radial-gradient(ellipse 80% 50% at 50% -15%, rgba(56, 189, 248, 0.14), transparent)`).
   - **Elevated Surface 1 (`--surface-1`):** `#0D111A` with 1px structural border `rgba(255, 255, 255, 0.07)` and top inner specular highlight `inset 0 1px 0 0 rgba(255, 255, 255, 0.12)`.
   - **Interactive Surface 2 (`--surface-2`):** `#141A26` with subtle hover/active luminance.
3. **Precision Typography:**
   - Use `-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Display", sans-serif`.
   - Enforce `font-variant-numeric: tabular-nums` on all counters, timers, percentages, and rankings so numbers never jitter.
   - Tight tracking (`letter-spacing: -0.02em`) on headings; wide tracking (`letter-spacing: 0.08em`) on micro-uppercase telemetry tags.
4. **Non-Negotiable Technical Invariants:**
   - **Dual-Layer Answer Leak Protection (Flashcards):** The answer DOM node (`#a-text` / `#back-text`) MUST remain empty (`textContent = ''`) while the card is on the question side, AND `.back` / `.card-back` MUST have `visibility: hidden; opacity: 0; pointer-events: none;` until `.flipped` is active.
   - **Telegram 10.4 Inline Widget Limits:** `buildInlineFlashcardWidgetHtml` and `buildInlineDocxHealerWidgetHtml` MUST have zero external network requests and compress to `<= 4096 bytes` via `zlib.deflateSync(html, { level: 9 })`.
   - **HMAC-SHA256 Token & Mutex Integrity:** Preserve constant-time signature verification (`crypto.timingSafeEqual`) and `mutex.runExclusive` on state writes.

---

## 📂 2. FILES TO UPDATE (5 CORE FILES)

Apply the exact, complete file contents below to the following paths:
1. `src/services/widgetService.js`
2. `src/widgets/widgetServer.js`
3. `src/widgets/views/flashcardWidget.html`
4. `src/widgets/views/podiumWidget.html`
5. `src/widgets/views/docxHealerWidget.html`

---

### FILE 1: `src/services/widgetService.js`

**Target Path:** `src/services/widgetService.js`

```javascript
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
html,body{width:100%;min-height:296px;background:var(--tg-theme-bg-color,#080b12);color:var(--tg-theme-text-color,#f1f5f9);overflow-x:hidden;font-variant-numeric:tabular-nums}
.wrap{padding:12px 14px;min-height:296px;display:flex;flex-direction:column;justify-content:space-between;background:radial-gradient(ellipse 90% 50% at 50% -10%,rgba(59,130,246,0.14),transparent)}
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
.q-text{font-size:15px;font-weight:600;line-height:1.48;color:#f8fafc;word-break:break-word;max-height:110px;overflow-y:auto;padding:0 4px;margin:auto 0;letter-spacing:-0.01em}
.a-text{font-size:15.5px;font-weight:700;line-height:1.48;color:#6ee7b7;word-break:break-word;max-height:110px;overflow-y:auto;padding:0 4px;margin:auto 0}
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
    title: decodeHtmlEntities(viewData.fileName || viewData.title || 'Docx Inspector').slice(0, 50),
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
html,body{width:100%;min-height:306px;background:var(--tg-theme-bg-color,#080b12);color:var(--tg-theme-text-color,#f1f5f9);overflow-x:hidden;font-variant-numeric:tabular-nums}
.wrap{padding:12px 14px;min-height:306px;display:flex;flex-direction:column;justify-content:space-between;background:radial-gradient(ellipse 90% 50% at 50% -10%,rgba(99,102,241,0.14),transparent)}
.top-bar{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;font-weight:600;color:#94a3b8}
.badge{font-size:10px;padding:2px 9px;border-radius:6px;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.28);color:#fbbf24;font-weight:700;letter-spacing:0.03em}
.badge.ok{background:rgba(16,185,129,0.14);border-color:rgba(16,185,129,0.28);color:#34d399}
.bar-wrap{background:rgba(255,255,255,0.07);height:4px;border-radius:99px;margin:7px 0 10px;overflow:hidden}
.bar-fill{height:100%;width:0%;background:linear-gradient(90deg,#6366f1,#10b981);transition:width 0.3s ease}
.card-box{flex:1;display:flex;flex-direction:column;min-height:198px;background:#0f1420;border:1px solid rgba(255,255,255,0.08);box-shadow:inset 0 1px 0 rgba(255,255,255,0.1),0 14px 28px -8px rgba(0,0,0,0.55);border-radius:15px;padding:13px;margin-bottom:10px;position:relative;transition:transform 0.22s cubic-bezier(0.22,1,0.36,1),opacity 0.2s}
.q-title{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#64748b;margin-bottom:5px;font-weight:700}
.q-text{font-size:13.5px;font-weight:600;line-height:1.42;max-height:60px;overflow-y:auto;margin-bottom:9px;word-break:break-word;color:#f8fafc}
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
  <div class="top-bar"><span id="title">Docx Inspector</span><span class="badge" id="badge">Xato #1</span></div>
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

  document.getElementById('title').textContent = initialData.title || 'Docx Inspector';
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
```

---

### FILE 2: `src/widgets/widgetServer.js`

**Target Path:** `src/widgets/widgetServer.js`

```javascript
'use strict';

const express = require('express');
const widgetService = require('../services/widgetService');
const logger = require('../core/logger');
const mutex = require('../core/mutex');
const { TTLMap } = require('../core/utils');

const router = express.Router();

const widgetIpLimiter = new TTLMap(60 * 1000, 5000);
const widgetAiHealLimiter = new TTLMap(60 * 1000, 2000);

function widgetRateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const count = (widgetIpLimiter.get(ip) || 0) + 1;
  widgetIpLimiter.set(ip, count);
  if (count > 90) {
    return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });
  }
  next();
}

router.use(widgetRateLimiter);

// Registry for custom widget action handlers
const queryHandlers = new Map();

/**
 * Registers a handler for a widget action or type.
 * @param {string} actionName
 * @param {Function} handlerFn - async (verifiedToken, action, data) => result
 */
function registerQueryHandler(actionName, handlerFn) {
  if (typeof handlerFn === 'function') {
    queryHandlers.set(actionName, handlerFn);
  }
}

/**
 * Executes a widget query action.
 * @param {object} verifiedToken
 * @param {string} action
 * @param {any} data
 * @returns {Promise<any>}
 */
async function executeQueryAction(verifiedToken, action, data) {
  if (action && queryHandlers.has(action)) {
    return await queryHandlers.get(action)(verifiedToken, action, data);
  }

  switch (action) {
    case 'my_analysis':
      return {
        userId: verifiedToken.userId,
        personal: verifiedToken.payload?.personal || {},
        status: 'ok',
      };

    case 'card_action': {
      const userId = verifiedToken.userId;
      const cardAct = data?.action === 'repeat' ? 'repeat' : 'known';
      const cardIdx = typeof data?.cardIdx === 'number' ? data.cardIdx : null;

      if (userId) {
        try {
          const cramHandler = require('../handlers/cramReviewHandler');
          const userKey = String(userId);
          const session = cramHandler.cramSessions?.get(userKey);
          if (session && session.deck) {
            cramHandler.processCardAction(session.deck, cardAct, cardIdx);
            cramHandler.cramSessions.set(userKey, session);
            try {
              const redis = require('../services/redisService');
              if (redis && typeof redis.set === 'function') {
                await redis.set(`cram_session:${userKey}`, JSON.stringify(session), 'EX', 7200);
              }
            } catch {}
          }
        } catch (err) {
          logger.debug('card_action cram session sync skipped:', err?.message);
        }
      }

      return {
        action: data?.action,
        cardIdx: data?.cardIdx,
        timestamp: Date.now(),
        status: 'saved',
      };
    }

    case 'fix_option': {
      const questionIdx = typeof data?.questionIdx === 'number' ? data.questionIdx : -1;
      const correctOptionIdx = typeof data?.correctOptionIdx === 'number' ? data.correctOptionIdx : -1;
      const userId = verifiedToken.userId;

      if (userId && questionIdx >= 0 && correctOptionIdx >= 0) {
        try {
          const redisConnection = require('../services/redisService');
          const sessionKey = `tg_session:${userId}`;
          const raw = await redisConnection.get(sessionKey);
          if (raw) {
            const session = JSON.parse(raw);
            if (!session.data) session.data = {};
            if (!session.data.fixedKeysDraft) session.data.fixedKeysDraft = {};
            session.data.fixedKeysDraft[questionIdx] = correctOptionIdx;
            await redisConnection.set(sessionKey, JSON.stringify(session), 'EX', 86400);
          }
        } catch (err) {
          logger.debug('fix_option redis update skipped/offline:', err?.message);
        }
      }

      return {
        questionIdx,
        correctOptionIdx,
        status: 'updated',
      };
    }

    case 'auto_heal_all': {
      const uidKey = String(verifiedToken.userId || 'anon');
      const aiCount = (widgetAiHealLimiter.get(uidKey) || 0) + 1;
      widgetAiHealLimiter.set(uidKey, aiCount);
      if (aiCount > 5) {
        throw new Error('AI avto-tuzatish limiti: daqiqasiga ko\'pi bilan 5 marta urinish mumkin.');
      }

      const rawQuestions = (data?.questions && Array.isArray(data.questions) && data.questions.length > 0)
        ? data.questions
        : (verifiedToken.payload?.questions || []);

      try {
        const aiDocxHealer = require('../services/aiDocxHealer');
        const { extractQuestionCandidates } = require('../validators/testValidators');
        const apiKey = process.env.GEMINI_API_KEY || null;

        const rawTexts = rawQuestions.map(q => {
          if (typeof q === 'string') return q;
          return q.raw || q.questionText || q.question || '';
        }).filter(Boolean);

        const healResult = await aiDocxHealer.batchAutoHeal(rawTexts, apiKey);

        const healedList = (healResult.healed || []).map((h, i) => ({
          id: i + 1,
          questionText: h.question,
          raw: h.raw || h.question,
          options: (h.options || []).map((opt, oi) => ({
            text: typeof opt === 'string' ? opt : (opt.cleanText || opt.text || ''),
            cleanText: typeof opt === 'string' ? opt : (opt.cleanText || opt.text || ''),
            isCorrect: oi === h.correct_index,
          })),
          error: 'AI orqali tiklandi',
        }));

        const remainingList = (healResult.remainingInvalid || []).map((r, i) => {
          const cand = extractQuestionCandidates(r);
          return {
            id: healedList.length + i + 1,
            questionText: cand.questionText || r,
            raw: r,
            options: (cand.options || []).map(o => ({
              text: o.cleanText || o.text,
              cleanText: o.cleanText || o.text,
              isCorrect: false,
            })),
            error: 'Qo‘lda tanlash talab etiladi',
          };
        });

        const fullList = [...healedList, ...remainingList];
        return {
          status: 'auto_healed',
          healedCount: healedList.length,
          remainingCount: remainingList.length,
          healed: fullList.length > 0 ? fullList : rawQuestions,
        };
      } catch (err) {
        logger.warn('auto_heal_all error in widgetServer, using heuristic fallback:', err?.message);
        const heuristic = rawQuestions.map((q, i) => {
          const cand = typeof q === 'string'
            ? require('../validators/testValidators').extractQuestionCandidates(q)
            : q;
          const opts = (cand.options || []).map((o, oi) => ({
            text: typeof o === 'string' ? o : (o.cleanText || o.text || ''),
            isCorrect: oi === 0,
          }));
          return {
            id: i + 1,
            questionText: cand.questionText || cand.raw || 'Savol',
            raw: cand.raw || cand.questionText || '',
            options: opts,
            error: 'Tiklandi',
          };
        });
        return {
          status: 'auto_healed',
          healedCount: heuristic.length,
          remainingCount: 0,
          healed: heuristic,
        };
      }
    }

    case 'save_docx': {
      const userId = verifiedToken.userId;
      return await mutex.runExclusive(`widget_save_docx:${userId}`, async () => {
        const questionsInput = data?.questions || verifiedToken.payload?.questions || [];
        const validQuestionsToAdd = [];
        const remainingInvalid = [];

        for (const q of questionsInput) {
          const opts = (q.options || []).map(o => typeof o === 'string' ? o : (o.cleanText || o.text || ''));
          const correctIdx = (q.options || []).findIndex(o => Boolean(o.isCorrect));

          if (opts.length >= 2 && correctIdx >= 0) {
            validQuestionsToAdd.push({
              question: q.questionText || q.question || (typeof q.raw === 'string' ? q.raw.split('\n')[0] : 'Savol'),
              options: opts,
              correct_index: correctIdx,
            });
          } else {
            remainingInvalid.push(typeof q.raw === 'string' ? q.raw : (q.questionText || 'Xato savol'));
          }
        }

        let totalValid = validQuestionsToAdd.length;
        if (userId) {
          try {
            const redisConnection = require('../services/redisService');
            const sessionKey = `tg_session:${userId}`;
            const rawSession = await redisConnection.get(sessionKey);
            let session = rawSession ? JSON.parse(rawSession) : { data: {} };
            if (!session) session = { data: {} };
            if (!session.data) session.data = {};

            const existingValid = Array.isArray(session.data.questions) ? session.data.questions : [];
            const existingSet = new Set(existingValid.map(item => `${item.question}::${(item.options || []).join('|')}`));
            const deduplicatedNew = validQuestionsToAdd.filter(
              item => !existingSet.has(`${item.question}::${(item.options || []).join('|')}`)
            );

            const updatedQuestions = [...existingValid, ...deduplicatedNew];
            session.data.questions = updatedQuestions;
            session.data.invalidQs = remainingInvalid;
            session.data.fixing_error_index = undefined;
            if (session.data.fixedKeysDraft) delete session.data.fixedKeysDraft;

            if (session.data.is_auto_docx) {
              const chunks = [];
              for (let i = 0; i < updatedQuestions.length; i += 25) {
                chunks.push(updatedQuestions.slice(i, i + 25));
              }
              session.data.chunks = chunks;
            }

            totalValid = updatedQuestions.length;
            await redisConnection.set(sessionKey, JSON.stringify(session), 'EX', 86400);
          } catch (err) {
            logger.warn('save_docx session update in redis failed/offline:', err?.message);
          }
        }

        return {
          status: 'completed',
          savedCount: validQuestionsToAdd.length,
          remainingCount: remainingInvalid.length,
          totalValid,
        };
      });
    }

    case 'delete_question': {
      const qIdx = typeof data?.questionIdx === 'number' ? data.questionIdx : -1;
      const userId = verifiedToken.userId;

      if (qIdx >= 0 && userId) {
        try {
          const redisConnection = require('../services/redisService');
          const sessionKey = `tg_session:${userId}`;
          const raw = await redisConnection.get(sessionKey);
          if (raw) {
            const session = JSON.parse(raw);
            if (session?.data?.invalidQs && session.data.invalidQs.length > qIdx) {
              session.data.invalidQs.splice(qIdx, 1);
              await redisConnection.set(sessionKey, JSON.stringify(session), 'EX', 86400);
            }
          }
        } catch (err) {
          logger.warn('delete_question redis update skipped/offline:', err?.message);
        }
      }

      return {
        status: 'deleted',
        questionIdx: qIdx,
      };
    }

    default:
      return {
        action: action || 'unknown',
        status: 'processed',
        received: data || null,
        timestamp: Date.now(),
      };
  }
}

/**
 * Generates a clean Obsidian Glass responsive HTML error page.
 */
function renderErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>${widgetService.escapeHtml(title)}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg: #07090E;
      --surface: #0E131F;
      --text: #F8FAFC;
      --muted: #94A3B8;
      --accent: #3B82F6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(ellipse 80% 50% at 50% -15%, rgba(245, 158, 11, 0.12), transparent), var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: var(--surface);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12), 0 24px 48px -12px rgba(0, 0, 0, 0.7);
      border-radius: 20px;
      padding: 32px 24px;
      text-align: center;
      max-width: 380px;
      width: 100%;
    }
    .icon-ring {
      width: 56px;
      height: 56px;
      border-radius: 14px;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.25);
      color: #FBBF24;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 18px;
    }
    h2 { font-size: 17px; font-weight: 700; margin-bottom: 8px; color: #F8FAFC; letter-spacing: -0.02em; }
    p { font-size: 13px; color: var(--muted); line-height: 1.55; margin-bottom: 24px; }
    .btn {
      width: 100%;
      padding: 12px 16px;
      border-radius: 12px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: #161E2E;
      color: #F8FAFC;
      font-size: 13.5px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn:active { background: #1E293B; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-ring">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </div>
    <h2>${widgetService.escapeHtml(title)}</h2>
    <p>${widgetService.escapeHtml(message)}</p>
    <button class="btn" onclick="if(window.Telegram&&window.Telegram.WebApp){window.Telegram.WebApp.close();}else{window.close();}">Yopish</button>
  </div>
</body>
</html>`;
}

// ─── GET /widget/:token ──────────────────────────────────────────
router.get(['/:token', '/widget/:token'], (req, res) => {
  const token = req.params.token;
  if (!token) {
    return res.status(400).send(renderErrorPage('Xatolik', 'Token ko\'rsatilmadi.'));
  }

  const verified = widgetService.verifyWidgetToken(token);
  if (!verified) {
    return res.status(403).send(
      renderErrorPage(
        'Havola muddati tugagan',
        'Xavfsizlik yuzasidan ushbu vidjet seansi yakunlangan. Bot orqali yangi oynani oching.'
      )
    );
  }

  try {
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' 'unsafe-inline' 'unsafe-eval' https://telegram.org; img-src 'self' data: https:; frame-ancestors *;"
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    const viewData = {
      ...verified.payload,
      userId: verified.userId,
      token,
      type: verified.type,
    };

    const html = widgetService.renderWidgetHtml(verified.type, viewData);
    return res.send(html);
  } catch (err) {
    logger.error('Widget render error:', { error: err.message, stack: err.stack });
    return res.status(500).send(renderErrorPage('Xatolik', 'Vidjetni yuklashda texnik xatolik yuz berdi.'));
  }
});

// ─── POST /widget/query ─────────────────────────────────────────
router.post(['/query', '/widget/query'], async (req, res) => {
  const { token, action, data } = req.body || {};

  if (!token) {
    return res.status(400).json({ ok: false, error: 'Missing token' });
  }

  const verified = widgetService.verifyWidgetToken(token);
  if (!verified) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired widget token' });
  }

  try {
    const result = await executeQueryAction(verified, action, data);
    return res.json({ ok: true, data: result });
  } catch (err) {
    logger.error('Widget query execution error:', { error: err.message });
    return res.status(500).json({ ok: false, error: err.message || 'Internal query error' });
  }
});

module.exports = router;
module.exports.registerQueryHandler = registerQueryHandler;
module.exports.executeQueryAction = executeQueryAction;
```

---

### FILE 3: `src/widgets/views/flashcardWidget.html`

**Target Path:** `src/widgets/views/flashcardWidget.html`

```html
<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>{{TITLE}}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg-canvas: #07090E;
      --surface-1: #0E131F;
      --surface-2: #151C2C;
      --surface-back: #091715;
      --text-primary: #F8FAFC;
      --text-secondary: #94A3B8;
      --text-muted: #64748B;
      --accent-blue: #3B82F6;
      --accent-emerald: #10B981;
      --accent-amber: #F59E0B;
      --border-hairline: rgba(255, 255, 255, 0.08);
      --specular-top: inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
    }
    body {
      background:
        radial-gradient(ellipse 85% 45% at 50% -10%, rgba(59, 130, 246, 0.16), transparent),
        var(--bg-canvas);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      padding: 16px 16px 22px;
      overflow-x: hidden;
      font-variant-numeric: tabular-nums;
    }

    /* Top Telemetry Header */
    .top-shell {
      width: 100%;
      max-width: 420px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .nav-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .deck-title-group {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .brand-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--accent-blue);
      box-shadow: 0 0 10px var(--accent-blue);
      flex-shrink: 0;
    }
    .header h1 {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .icon-pill-btn {
      background: var(--surface-1);
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
      padding: 6px 11px;
      border-radius: 99px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }
    .icon-pill-btn:disabled {
      opacity: 0.32;
      pointer-events: none;
    }
    .icon-pill-btn:active {
      transform: scale(0.96);
      background: var(--surface-2);
    }

    /* Bento Telemetry Strip */
    .telemetry-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }
    .metric-card {
      background: var(--surface-1);
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top);
      border-radius: 12px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
    }
    .metric-card .lbl {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .metric-card .val {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      margin-top: 2px;
    }
    .metric-card.learned .val { color: #34D399; }
    .metric-card.remaining .val { color: #60A5FA; }

    /* Precision Laser Progress Bar */
    .progress-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-secondary);
      margin-bottom: -6px;
    }
    .progress-track {
      width: 100%;
      background: rgba(255, 255, 255, 0.06);
      height: 5px;
      border-radius: 99px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #3B82F6, #10B981);
      border-radius: 99px;
      transition: width 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* 3D Flashcard Perspective Stage */
    .card-arena {
      perspective: 1400px;
      width: 100%;
      max-width: 420px;
      height: 356px;
      position: relative;
      margin: 10px 0;
      touch-action: pan-y;
    }
    .drag-stamp {
      position: absolute;
      top: 20px;
      z-index: 25;
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      opacity: 0;
      pointer-events: none;
      backdrop-filter: blur(8px);
      transition: opacity 0.12s ease;
    }
    .drag-stamp.known {
      left: 20px;
      border: 1px solid rgba(16, 185, 129, 0.5);
      color: #34D399;
      background: rgba(6, 78, 59, 0.65);
    }
    .drag-stamp.repeat {
      right: 20px;
      border: 1px solid rgba(245, 158, 11, 0.5);
      color: #FBBF24;
      background: rgba(120, 53, 15, 0.65);
    }

    .card-wrapper {
      width: 100%;
      height: 100%;
      position: relative;
      transform-style: preserve-3d;
      -webkit-transform-style: preserve-3d;
      transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
      cursor: pointer;
    }
    .card-wrapper.flipped {
      transform: rotateY(180deg);
      -webkit-transform: rotateY(180deg);
    }
    .card-wrapper.slide-right {
      transition: transform 0.25s ease, opacity 0.22s ease;
      transform: translateX(120%) rotateZ(12deg);
      opacity: 0;
    }
    .card-wrapper.slide-left {
      transition: transform 0.25s ease, opacity 0.22s ease;
      transform: translateX(-120%) rotateZ(-12deg);
      opacity: 0;
    }

    /* Strict Dual-Layer Backface & Visibility Protection */
    .card-face {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      backface-visibility: hidden;
      -webkit-backface-visibility: hidden;
      background: var(--surface-1);
      border: 1px solid var(--border-hairline);
      border-radius: 22px;
      padding: 22px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow:
        var(--specular-top),
        0 24px 48px -12px rgba(0, 0, 0, 0.75);
    }
    .card-front {
      z-index: 2;
      visibility: visible;
      opacity: 1;
      transition: opacity 0.15s ease, visibility 0.15s ease;
    }
    .card-back {
      transform: rotateY(180deg);
      -webkit-transform: rotateY(180deg);
      background: var(--surface-back);
      border-color: rgba(16, 185, 129, 0.28);
      box-shadow:
        inset 0 1px 0 0 rgba(52, 211, 153, 0.2),
        0 24px 48px -12px rgba(0, 0, 0, 0.75);
      z-index: 1;
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease, visibility 0.15s ease;
    }
    .card-wrapper.flipped .card-front {
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
      z-index: 1;
    }
    .card-wrapper.flipped .card-back {
      visibility: visible;
      opacity: 1;
      pointer-events: auto;
      z-index: 2;
    }

    .face-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
    }
    .card-badge {
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #60A5FA;
      background: rgba(59, 130, 246, 0.12);
      border: 1px solid rgba(59, 130, 246, 0.24);
      padding: 4px 10px;
      border-radius: 6px;
    }
    .card-back .card-badge {
      color: #34D399;
      background: rgba(16, 185, 129, 0.14);
      border-color: rgba(16, 185, 129, 0.28);
    }
    .card-index-chip {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    .card-text {
      font-size: 17px;
      line-height: 1.55;
      color: var(--text-primary);
      font-weight: 600;
      letter-spacing: -0.015em;
      margin: auto 0;
      overflow-y: auto;
      max-height: 215px;
      text-align: center;
      padding: 6px 4px;
      word-break: break-word;
    }
    .card-back .card-text {
      color: #6EE7B7;
      font-weight: 700;
      font-size: 17.5px;
    }
    .card-footer-hint {
      font-size: 11.5px;
      font-weight: 500;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding-top: 12px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }

    /* Bottom Floating Dock */
    .dock-container {
      width: 100%;
      max-width: 420px;
    }
    .actions-grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 10px;
      width: 100%;
    }
    .btn {
      padding: 13px 10px;
      border-radius: 14px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      background: var(--surface-1);
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top);
      color: var(--text-primary);
      transition: transform 0.12s ease, background 0.15s ease;
    }
    .btn:active { transform: scale(0.96); }
    .btn-repeat {
      color: #FBBF24;
      border-color: rgba(245, 158, 11, 0.25);
      background: rgba(245, 158, 11, 0.08);
    }
    .btn-flip {
      color: #60A5FA;
      border-color: rgba(59, 130, 246, 0.25);
      background: rgba(59, 130, 246, 0.08);
    }
    .btn-known {
      color: #34D399;
      border-color: rgba(16, 185, 129, 0.28);
      background: rgba(16, 185, 129, 0.1);
    }
    .svg-icon {
      width: 18px;
      height: 18px;
      stroke: currentColor;
      stroke-width: 2;
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    /* Completion Screen */
    .finish-screen {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      background: var(--surface-1);
      border: 1px solid rgba(16, 185, 129, 0.28);
      box-shadow: var(--specular-top), 0 24px 48px -12px rgba(0, 0, 0, 0.75);
      border-radius: 22px;
      padding: 36px 24px;
      width: 100%;
      max-width: 420px;
      margin: auto 0;
    }
    .finish-screen.active { display: flex; }
    .finish-badge {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: rgba(16, 185, 129, 0.14);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34D399;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 16px;
    }
    .finish-title { font-size: 19px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px; letter-spacing: -0.02em; }
    .finish-sub { font-size: 13px; color: var(--text-secondary); margin-bottom: 24px; line-height: 1.5; }
    .finish-actions { display: flex; flex-direction: column; gap: 10px; width: 100%; }
    .btn-row-full {
      width: 100%;
      flex-direction: row;
      padding: 13px 16px;
      font-size: 13.5px;
    }
  </style>
</head>
<body>
  <div class="top-shell header">
    <div class="nav-bar">
      <div class="deck-title-group">
        <span class="brand-dot"></span>
        <h1 id="subject-title">{{TITLE}}</h1>
      </div>
      <button class="icon-pill-btn" id="undo-btn" onclick="undoLastCard()" disabled>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
        <span>Ortga</span>
      </button>
    </div>

    <div class="telemetry-grid">
      <div class="metric-card learned">
        <span class="lbl">O'zlashtirildi</span>
        <span class="val" id="stat-learned">0</span>
      </div>
      <div class="metric-card remaining">
        <span class="lbl">Navbatda</span>
        <span class="val" id="stat-remaining">0</span>
      </div>
      <div class="metric-card">
        <span class="lbl">Jami karta</span>
        <span class="val" id="stat-total">0</span>
      </div>
    </div>

    <div class="progress-meta">
      <span id="progress-text">Jarayon: 0 / 0</span>
      <span id="percent-text">0%</span>
    </div>
    <div class="progress-track">
      <div class="progress-fill" id="progress-fill"></div>
    </div>
  </div>

  <!-- 3D Perspective Stage -->
  <div class="card-arena" id="card-arena">
    <div class="drag-stamp known" id="stamp-known">BILIB OLDIM</div>
    <div class="drag-stamp repeat" id="stamp-repeat">QAYTARISH</div>

    <div class="card-wrapper" id="card-element" onclick="flipCard()">
      <!-- Front (Question) -->
      <div class="card-face card-front">
        <div class="face-header">
          <div class="card-badge">SAVOL</div>
          <span class="card-index-chip" id="card-num-front">01</span>
        </div>
        <div class="card-text" id="front-text">Yuklanmoqda...</div>
        <div class="card-footer-hint">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"/></svg>
          <span>Javobni ko'rish uchun kartani bosing</span>
        </div>
      </div>

      <!-- Back (Answer) -->
      <div class="card-face card-back">
        <div class="face-header">
          <div class="card-badge">TO'G'RI JAVOB</div>
          <span class="card-index-chip" id="card-num-back">01</span>
        </div>
        <div class="card-text" id="back-text"></div>
        <div class="card-footer-hint">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8"/></svg>
          <span>Savolga qaytish uchun bosing</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Completion View -->
  <div class="finish-screen" id="finish-screen">
    <div class="finish-badge">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
    </div>
    <div class="finish-title">Barcha kartochkalar yakunlandi</div>
    <div class="finish-sub" id="finish-sub">Ushbu blokdagi barcha savollarni to'liq ko'rib chiqdingiz va o'zlashtirdingiz.</div>
    <div class="finish-actions">
      <button class="btn btn-flip btn-row-full" onclick="restartDeck()">
        <svg class="svg-icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        <span>Qaytadan takrorlash</span>
      </button>
      <button class="btn btn-known btn-row-full" onclick="closeWebApp()">
        <svg class="svg-icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Yakunlash va qaytish</span>
      </button>
    </div>
  </div>

  <!-- Bottom Action Dock -->
  <div class="dock-container" id="actions-grid">
    <div class="actions-grid">
      <button class="btn btn-repeat" onclick="handleCardAction('repeat')">
        <svg class="svg-icon" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
        <span>Qaytarish</span>
      </button>
      <button class="btn btn-flip" onclick="flipCard()">
        <svg class="svg-icon" viewBox="0 0 24 24"><path d="M17 2.1l4 4-4 4"/><path d="M3 12.2v-2a4 4 0 0 1 4-4h12.8M7 21.9l-4-4 4-4"/><path d="M21 11.8v2a4 4 0 0 1-4 4H4.2"/></svg>
        <span>Aylantirish</span>
      </button>
      <button class="btn btn-known" onclick="handleCardAction('known')">
        <svg class="svg-icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Bilib oldim</span>
      </button>
    </div>
  </div>

  <script>
    window.__WIDGET_DATA__ = {{DATA_JSON}};

    var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg) {
      tg.ready();
      tg.expand();
    }

    function haptic(type, style) {
      if (!tg || !tg.HapticFeedback) return;
      try {
        if (type === 'selection') tg.HapticFeedback.selectionChanged();
        else if (type === 'impact') tg.HapticFeedback.impactOccurred(style || 'light');
        else if (type === 'notify') tg.HapticFeedback.notificationOccurred(style || 'success');
      } catch (e) {}
    }

    const data = window.__WIDGET_DATA__ || {};
    const deck = data.deck || {
      cards: [
        { q: data.question || 'Savol mavjud emas', a: data.answer || 'Javob mavjud emas' }
      ]
    };

    let cards = (deck.cards && deck.cards.length > 0) ? [...deck.cards] : [
      { q: 'Savol namunasi', a: 'To\'g\'ri javob' }
    ];
    let currentIndex = 0;
    let learnedCount = 0;
    const totalCount = cards.length;
    let historyStack = [];
    let isAnimating = false;

    const cardEl = document.getElementById('card-element');
    const frontText = document.getElementById('front-text');
    const backText = document.getElementById('back-text');
    const progressFill = document.getElementById('progress-fill');
    const progressText = document.getElementById('progress-text');
    const percentText = document.getElementById('percent-text');
    const statLearned = document.getElementById('stat-learned');
    const statRemaining = document.getElementById('stat-remaining');
    const statTotal = document.getElementById('stat-total');
    const undoBtn = document.getElementById('undo-btn');
    const stampKnown = document.getElementById('stamp-known');
    const stampRepeat = document.getElementById('stamp-repeat');

    let currentAnswerText = '';

    function pad2(n) {
      return n < 10 ? '0' + n : String(n);
    }

    function renderCurrentCard() {
      if (currentIndex >= cards.length) {
        showFinish();
        return;
      }

      // Layer 1 & 2 Protection: reset flip without transition and clear answer DOM node
      cardEl.style.transition = 'none';
      cardEl.className = 'card-wrapper';
      cardEl.style.transform = '';
      backText.textContent = '';
      stampKnown.style.opacity = '0';
      stampRepeat.style.opacity = '0';
      void cardEl.offsetWidth;
      cardEl.style.transition = '';

      const c = cards[currentIndex];
      frontText.textContent = c.q || c.question || 'Savol';
      currentAnswerText = c.a || c.answer || 'To\'g\'ri javob';

      const numVal = (c.id !== undefined ? Number(c.id) + 1 : currentIndex + 1);
      const cardLabel = pad2(numVal) + ' / ' + pad2(totalCount);
      document.getElementById('card-num-front').textContent = cardLabel;
      document.getElementById('card-num-back').textContent = cardLabel;

      const remaining = Math.max(0, cards.length - currentIndex);
      statLearned.textContent = learnedCount;
      statRemaining.textContent = remaining;
      statTotal.textContent = totalCount;
      undoBtn.disabled = historyStack.length === 0;

      progressText.textContent = `O'zlashtirildi: ${learnedCount} / ${totalCount}`;
      const pct = totalCount > 0 ? Math.min(100, Math.round((learnedCount / totalCount) * 100)) : 0;
      progressFill.style.width = pct + '%';
      percentText.textContent = pct + '%';
      isAnimating = false;
    }

    function flipCard() {
      if (isAnimating) return;
      const willFlip = !cardEl.classList.contains('flipped');
      if (willFlip) {
        backText.textContent = currentAnswerText;
      }
      cardEl.classList.toggle('flipped');
      haptic('selection');
    }

    function handleCardAction(action) {
      if (isAnimating || currentIndex >= cards.length) return;
      isAnimating = true;

      const currentCard = cards[currentIndex];
      const realCardIdx = currentCard && currentCard.id !== undefined ? currentCard.id : currentIndex;

      if (action === 'known') {
        haptic('impact', 'medium');
        historyStack.push({ action: 'known', index: currentIndex });
        learnedCount++;
        cardEl.classList.add('slide-right');
        sendWidgetQuery('card_action', { cardIdx: realCardIdx, action: 'known' });
        setTimeout(() => {
          currentIndex++;
          renderCurrentCard();
        }, 250);
      } else {
        haptic('impact', 'light');
        historyStack.push({ action: 'repeat', index: currentIndex });
        cardEl.classList.add('slide-left');
        sendWidgetQuery('card_action', { cardIdx: realCardIdx, action: 'repeat' });
        setTimeout(() => {
          cards.push(currentCard);
          currentIndex++;
          renderCurrentCard();
        }, 250);
      }
    }

    function undoLastCard() {
      if (isAnimating || historyStack.length === 0) return;
      const last = historyStack.pop();
      if (last.action === 'known') {
        learnedCount = Math.max(0, learnedCount - 1);
      } else if (last.action === 'repeat') {
        cards.pop();
      }
      currentIndex = last.index;
      haptic('selection');
      document.getElementById('card-arena').style.display = 'block';
      document.getElementById('actions-grid').style.display = 'block';
      document.getElementById('finish-screen').classList.remove('active');
      renderCurrentCard();
    }

    function showFinish() {
      isAnimating = false;
      haptic('notify', 'success');
      statLearned.textContent = totalCount;
      statRemaining.textContent = 0;
      document.getElementById('card-arena').style.display = 'none';
      document.getElementById('actions-grid').style.display = 'none';
      document.getElementById('finish-screen').classList.add('active');
      progressFill.style.width = '100%';
      percentText.textContent = '100%';
    }

    function restartDeck() {
      haptic('impact', 'medium');
      currentIndex = 0;
      learnedCount = 0;
      historyStack = [];
      cards = (deck.cards && deck.cards.length > 0) ? [...deck.cards] : [];
      document.getElementById('card-arena').style.display = 'block';
      document.getElementById('actions-grid').style.display = 'block';
      document.getElementById('finish-screen').classList.remove('active');
      renderCurrentCard();
    }

    function closeWebApp() {
      if (tg && typeof tg.close === 'function') {
        tg.close();
      } else {
        window.close();
      }
    }

    function sendWidgetQuery(action, actionData) {
      const token = '{{TOKEN}}' || data.token;
      fetch('/widget/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action, data: actionData })
      }).catch(() => {});
    }

    // Interactive Touch Drag Physics
    let touchStartX = 0;
    let touchStartY = 0;
    let currentDragX = 0;
    let isDragging = false;

    cardEl.addEventListener('touchstart', (e) => {
      if (isAnimating) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      currentDragX = 0;
      isDragging = true;
    }, { passive: true });

    cardEl.addEventListener('touchmove', (e) => {
      if (!isDragging || isAnimating) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;
      if (Math.abs(dx) > Math.abs(dy)) {
        currentDragX = dx;
        const baseFlip = cardEl.classList.contains('flipped') ? 'rotateY(180deg) ' : '';
        cardEl.style.transition = 'none';
        cardEl.style.transform = `${baseFlip}translateX(${dx}px) rotateZ(${dx * 0.045}deg)`;

        if (dx > 25) {
          stampKnown.style.opacity = String(Math.min(1, (dx - 25) / 55));
          stampRepeat.style.opacity = '0';
        } else if (dx < -25) {
          stampRepeat.style.opacity = String(Math.min(1, (-dx - 25) / 55));
          stampKnown.style.opacity = '0';
        } else {
          stampKnown.style.opacity = '0';
          stampRepeat.style.opacity = '0';
        }
      }
    }, { passive: true });

    cardEl.addEventListener('touchend', () => {
      if (!isDragging || isAnimating) return;
      isDragging = false;
      stampKnown.style.opacity = '0';
      stampRepeat.style.opacity = '0';

      if (currentDragX > 65) {
        handleCardAction('known');
      } else if (currentDragX < -65) {
        handleCardAction('repeat');
      } else if (Math.abs(currentDragX) > 4) {
        cardEl.style.transition = 'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1)';
        cardEl.style.transform = cardEl.classList.contains('flipped') ? 'rotateY(180deg)' : '';
      }
    }, { passive: true });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'ArrowDown') {
        e.preventDefault();
        flipCard();
      } else if (e.code === 'ArrowRight') {
        handleCardAction('known');
      } else if (e.code === 'ArrowLeft') {
        handleCardAction('repeat');
      }
    });

    renderCurrentCard();
  </script>
</body>
</html>
```

---

### FILE 4: `src/widgets/views/podiumWidget.html`

**Target Path:** `src/widgets/views/podiumWidget.html`

```html
<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>{{TITLE}}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg-canvas: #07090E;
      --surface-1: #0E131F;
      --surface-2: #151C2C;
      --text-primary: #F8FAFC;
      --text-secondary: #94A3B8;
      --text-muted: #64748B;
      --accent-blue: #3B82F6;
      --accent-emerald: #10B981;
      --border-hairline: rgba(255, 255, 255, 0.08);
      --specular-top: inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
    }
    body {
      background:
        radial-gradient(ellipse 85% 45% at 50% -10%, rgba(245, 158, 11, 0.13), transparent),
        var(--bg-canvas);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 18px 16px 24px;
      overflow-x: hidden;
      font-variant-numeric: tabular-nums;
    }
    .header {
      width: 100%;
      max-width: 430px;
      text-align: center;
      margin-bottom: 16px;
    }
    .eyebrow {
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: #FBBF24;
      margin-bottom: 4px;
    }
    .header h1 {
      font-size: 19px;
      font-weight: 700;
      letter-spacing: -0.025em;
      color: var(--text-primary);
    }

    /* Segmented Pill Switcher */
    .tabs {
      display: flex;
      background: var(--surface-1);
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top);
      padding: 4px;
      border-radius: 12px;
      width: 100%;
      max-width: 430px;
      margin-bottom: 16px;
    }
    .tab-btn {
      flex: 1;
      padding: 8.5px 12px;
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: 12.5px;
      font-weight: 600;
      border-radius: 9px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: all 0.2s ease;
    }
    .tab-btn.active {
      background: var(--surface-2);
      color: var(--text-primary);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
    }

    .view-container {
      width: 100%;
      max-width: 430px;
      position: relative;
    }
    .tab-content {
      display: none;
      animation: fadeSlide 0.26s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }
    .tab-content.active {
      display: block;
    }
    @keyframes fadeSlide {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* 3D Architectural Podium Stage */
    .podium-arena {
      width: 100%;
      padding: 28px 14px 20px;
      display: flex;
      justify-content: center;
      align-items: flex-end;
      gap: 12px;
      min-height: 310px;
      background: var(--surface-1);
      border-radius: 22px;
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top), 0 24px 48px -12px rgba(0, 0, 0, 0.7);
    }
    .podium-column {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex: 1;
      max-width: 124px;
      animation: columnRise 0.55s cubic-bezier(0.22, 1, 0.36, 1) backwards;
    }
    .podium-column.silver { animation-delay: 0.06s; }
    .podium-column.gold { animation-delay: 0.14s; }
    .podium-column.bronze { animation-delay: 0.22s; }

    @keyframes columnRise {
      from { opacity: 0; transform: translateY(22px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .avatar-wrap {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 800;
      letter-spacing: -0.02em;
      background: var(--surface-2);
      color: var(--text-primary);
      margin-bottom: 8px;
      border: 1.5px solid rgba(255, 255, 255, 0.14);
      position: relative;
    }
    .podium-column.gold .avatar-wrap {
      width: 58px;
      height: 58px;
      font-size: 18px;
      border-color: #FBBF24;
      background: radial-gradient(circle at 30% 30%, rgba(251, 191, 36, 0.28), rgba(15, 23, 42, 0.9));
      box-shadow: 0 0 24px rgba(245, 158, 11, 0.35);
      color: #FDE68A;
    }
    .podium-column.silver .avatar-wrap {
      border-color: #94A3B8;
      color: #E2E8F0;
    }
    .podium-column.bronze .avatar-wrap {
      border-color: #D97706;
      color: #FED7AA;
    }
    .crown-badge {
      position: absolute;
      top: -12px;
      color: #FBBF24;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.6));
    }

    .user-name {
      font-size: 12.5px;
      font-weight: 700;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      width: 100%;
      margin-bottom: 3px;
      color: var(--text-primary);
    }
    .user-meta {
      font-size: 10.5px;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    /* Anodized Metallic Pedestals */
    .pedestal {
      width: 100%;
      border-radius: 14px 14px 6px 6px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-between;
      padding: 14px 8px 12px;
      font-weight: 800;
      color: var(--text-primary);
      position: relative;
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
    }
    .podium-column.gold .pedestal {
      height: 148px;
      background: linear-gradient(180deg, rgba(245, 158, 11, 0.26) 0%, rgba(180, 83, 9, 0.08) 100%);
      border-color: rgba(245, 158, 11, 0.35);
      color: #FBBF24;
    }
    .podium-column.silver .pedestal {
      height: 114px;
      background: linear-gradient(180deg, rgba(148, 163, 184, 0.22) 0%, rgba(51, 65, 85, 0.08) 100%);
      border-color: rgba(148, 163, 184, 0.28);
      color: #CBD5E1;
    }
    .podium-column.bronze .pedestal {
      height: 92px;
      background: linear-gradient(180deg, rgba(217, 119, 6, 0.22) 0%, rgba(120, 53, 15, 0.08) 100%);
      border-color: rgba(217, 119, 6, 0.3);
      color: #FDBA74;
    }
    .rank-num {
      font-size: 24px;
      letter-spacing: -0.03em;
      line-height: 1;
    }
    .pedestal-score {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-primary);
      background: rgba(7, 9, 14, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 3px 9px;
      border-radius: 99px;
    }

    /* Telemetry Analysis Card */
    .analysis-card {
      background: var(--surface-1);
      border-radius: 22px;
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top), 0 24px 48px -12px rgba(0, 0, 0, 0.7);
      padding: 20px;
    }
    .radar-hero {
      display: flex;
      align-items: center;
      gap: 16px;
      padding-bottom: 16px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border-hairline);
    }
    .ring-box {
      position: relative;
      width: 74px;
      height: 74px;
      flex-shrink: 0;
    }
    .ring-svg {
      width: 74px;
      height: 74px;
      transform: rotate(-90deg);
    }
    .ring-bg {
      fill: none;
      stroke: rgba(255, 255, 255, 0.07);
      stroke-width: 6.5;
    }
    .ring-progress {
      fill: none;
      stroke: #10B981;
      stroke-width: 6.5;
      stroke-linecap: round;
      stroke-dasharray: 188.5;
      stroke-dashoffset: 188.5;
      transition: stroke-dashoffset 0.8s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .ring-label {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 15px;
      font-weight: 800;
      color: var(--text-primary);
    }
    .hero-meta h3 {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      margin-bottom: 4px;
      letter-spacing: -0.015em;
    }
    .hero-meta p {
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.45;
    }

    .stat-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 14px;
    }
    .stat-box {
      background: var(--surface-2);
      border-radius: 12px;
      padding: 11px 12px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .stat-lbl {
      font-size: 10.5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
    }
    .stat-val {
      font-size: 17px;
      font-weight: 700;
      color: var(--text-primary);
      margin-top: 3px;
    }
    .coach-box {
      background: rgba(59, 130, 246, 0.08);
      border: 1px solid rgba(59, 130, 246, 0.22);
      border-radius: 12px;
      padding: 13px 14px;
      font-size: 12.5px;
      line-height: 1.55;
      color: #E2E8F0;
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .coach-icon {
      color: #60A5FA;
      flex-shrink: 0;
      margin-top: 2px;
    }

    .footer-actions {
      margin-top: 16px;
      width: 100%;
      max-width: 430px;
    }
    .btn {
      width: 100%;
      padding: 13px;
      background: var(--surface-1);
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top);
      color: var(--text-primary);
      font-weight: 600;
      font-size: 13.5px;
      border-radius: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: transform 0.12s, background 0.15s;
    }
    .btn:active { transform: scale(0.98); background: var(--surface-2); }
  </style>
</head>
<body>
  <div class="header">
    <div class="eyebrow">MUSOBAQA NATIJALARI</div>
    <h1 id="widget-title">{{TITLE}}</h1>
  </div>

  <div class="tabs">
    <button class="tab-btn active" id="tab-podium-btn" onclick="switchTab('podium')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>
      <span>Top-3 Shohsupa</span>
    </button>
    <button class="tab-btn" id="tab-analysis-btn" onclick="switchTab('analysis')">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
      <span>Shaxsiy Tahlil</span>
    </button>
  </div>

  <div class="view-container" id="swipe-area">
    <!-- View 1: 3D Podium -->
    <div class="tab-content active" id="view-podium">
      <div class="podium-arena" id="podium-arena">
        <!-- 2nd Place -->
        <div class="podium-column silver" id="col-silver">
          <div class="avatar-wrap" id="silver-avatar">2</div>
          <div class="user-name" id="silver-name">—</div>
          <div class="user-meta" id="silver-time">--</div>
          <div class="pedestal">
            <span class="rank-num">2</span>
            <span class="pedestal-score" id="silver-score">0 ball</span>
          </div>
        </div>

        <!-- 1st Place -->
        <div class="podium-column gold" id="col-gold">
          <div class="avatar-wrap" id="gold-avatar">
            <svg class="crown-badge" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3c0 .6-.4 1-1 1H6c-.6 0-1-.4-1-1v-1h14v1z"/></svg>
            <span id="gold-init">1</span>
          </div>
          <div class="user-name" id="gold-name">—</div>
          <div class="user-meta" id="gold-time">--</div>
          <div class="pedestal">
            <span class="rank-num">1</span>
            <span class="pedestal-score" id="gold-score">0 ball</span>
          </div>
        </div>

        <!-- 3rd Place -->
        <div class="podium-column bronze" id="col-bronze">
          <div class="avatar-wrap" id="bronze-avatar">3</div>
          <div class="user-name" id="bronze-name">—</div>
          <div class="user-meta" id="bronze-time">--</div>
          <div class="pedestal">
            <span class="rank-num">3</span>
            <span class="pedestal-score" id="bronze-score">0 ball</span>
          </div>
        </div>
      </div>
    </div>

    <!-- View 2: Personal Telemetry -->
    <div class="tab-content" id="view-analysis">
      <div class="analysis-card">
        <div class="radar-hero">
          <div class="ring-box">
            <svg class="ring-svg" viewBox="0 0 72 72">
              <circle class="ring-bg" cx="36" cy="36" r="30"></circle>
              <circle class="ring-progress" id="accuracy-ring" cx="36" cy="36" r="30"></circle>
            </svg>
            <div class="ring-label" id="accuracy-pct">0%</div>
          </div>
          <div class="hero-meta">
            <h3>Aniqlik Ko'rsatkichi</h3>
            <p>Guruh ishtirokchilari orasidagi individual natijangiz va AI tahlili</p>
          </div>
        </div>

        <div class="stat-grid">
          <div class="stat-box">
            <div class="stat-lbl">Reytingdagi o'rin</div>
            <div class="stat-val" id="my-rank">-</div>
          </div>
          <div class="stat-box">
            <div class="stat-lbl">Kvadrant</div>
            <div class="stat-val" id="my-percentile">-</div>
          </div>
          <div class="stat-box">
            <div class="stat-lbl">To'g'ri javoblar</div>
            <div class="stat-val" id="my-correct">-</div>
          </div>
          <div class="stat-box">
            <div class="stat-lbl">Umumiy vaqt</div>
            <div class="stat-val" id="my-time">-</div>
          </div>
        </div>

        <div class="coach-box">
          <svg class="coach-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
          <div id="coach-advice">Tahlil yuklanmoqda...</div>
        </div>
      </div>
    </div>
  </div>

  <div class="footer-actions">
    <button class="btn" onclick="closeWidget()">Yopish</button>
  </div>

  <script>
    window.__WIDGET_DATA__ = {{DATA_JSON}};

    var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
    if (tg) {
      tg.ready();
      tg.expand();
    }

    function getInitials(name, fallback) {
      if (!name || typeof name !== 'string') return fallback;
      const parts = name.trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return fallback;
      if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }

    function switchTab(name) {
      if (tg && tg.HapticFeedback) {
        try { tg.HapticFeedback.selectionChanged(); } catch (e) {}
      }
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      if (name === 'podium') {
        document.getElementById('tab-podium-btn').classList.add('active');
        document.getElementById('view-podium').classList.add('active');
      } else {
        document.getElementById('tab-analysis-btn').classList.add('active');
        document.getElementById('view-analysis').classList.add('active');
      }
    }

    function closeWidget() {
      if (tg && typeof tg.close === 'function') {
        tg.close();
      } else {
        window.parent.postMessage({ action: 'close' }, '*');
      }
    }

    let touchStartX = 0;
    const swipeArea = document.getElementById('swipe-area');
    swipeArea.addEventListener('touchstart', (e) => {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    swipeArea.addEventListener('touchend', (e) => {
      const diff = e.changedTouches[0].screenX - touchStartX;
      if (diff < -50) switchTab('analysis');
      else if (diff > 50) switchTab('podium');
    }, { passive: true });

    (function init() {
      const data = window.__WIDGET_DATA__ || {};
      const top3 = data.top3 || [];

      if (top3[0]) {
        document.getElementById('gold-name').textContent = top3[0].name || '1-o\'rin';
        document.getElementById('gold-init').textContent = getInitials(top3[0].name, '1');
        document.getElementById('gold-score').textContent = (top3[0].score || 0) + ' ball';
        document.getElementById('gold-time').textContent = top3[0].timeFormatted || top3[0].time || '0.0s';
      }
      if (top3[1]) {
        document.getElementById('silver-name').textContent = top3[1].name || '2-o\'rin';
        document.getElementById('silver-avatar').textContent = getInitials(top3[1].name, '2');
        document.getElementById('silver-score').textContent = (top3[1].score || 0) + ' ball';
        document.getElementById('silver-time').textContent = top3[1].timeFormatted || top3[1].time || '0.0s';
      }
      if (top3[2]) {
        document.getElementById('bronze-name').textContent = top3[2].name || '3-o\'rin';
        document.getElementById('bronze-avatar').textContent = getInitials(top3[2].name, '3');
        document.getElementById('bronze-score').textContent = (top3[2].score || 0) + ' ball';
        document.getElementById('bronze-time').textContent = top3[2].timeFormatted || top3[2].time || '0.0s';
      }

      const personal = data.personal || {};
      document.getElementById('my-rank').textContent = personal.rank ? (personal.rank + ' / ' + (personal.total || '-')) : '-';
      document.getElementById('my-percentile').textContent = personal.percentile || 'Top 50%';
      document.getElementById('my-correct').textContent = (personal.correct !== undefined) ? (personal.correct + ' ta') : '-';
      document.getElementById('my-time').textContent = personal.timeFormatted || personal.time || '-';

      const pctVal = personal.accuracy !== undefined
        ? Number(personal.accuracy)
        : (personal.correct ? Math.min(100, Number(personal.correct) * 10) : 75);
      const safePct = Math.max(0, Math.min(100, isNaN(pctVal) ? 0 : pctVal));
      document.getElementById('accuracy-pct').textContent = safePct + '%';
      const circumference = 188.5;
      const offset = circumference - (safePct / 100) * circumference;
      const ringEl = document.getElementById('accuracy-ring');
      if (ringEl) {
        setTimeout(() => { ringEl.style.strokeDashoffset = String(offset); }, 120);
      }

      if (personal.advice) {
        const cleanAdvice = String(personal.advice)
          .replace(/<\/?(?:b|strong|i|em|code)>/gi, '')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&');
        document.getElementById('coach-advice').textContent = cleanAdvice;
      } else {
        document.getElementById('coach-advice').textContent = 'Ghost Coach maslahati: Viktorinada faol qatnashib, zaif mavzularingizni takrorlang!';
      }
    })();
  </script>
</body>
</html>
```

---

### FILE 5: `src/widgets/views/docxHealerWidget.html`

**Target Path:** `src/widgets/views/docxHealerWidget.html`

```html
<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>{{TITLE}}</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg-canvas: #07090E;
      --surface-1: #0E131F;
      --surface-2: #151C2C;
      --text-primary: #F8FAFC;
      --text-secondary: #94A3B8;
      --text-muted: #64748B;
      --accent-indigo: #6366F1;
      --accent-emerald: #10B981;
      --accent-amber: #F59E0B;
      --accent-rose: #F43F5E;
      --border-hairline: rgba(255, 255, 255, 0.08);
      --specular-top: inset 0 1px 0 0 rgba(255, 255, 255, 0.12);
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
    }
    body {
      background:
        radial-gradient(ellipse 85% 45% at 50% -10%, rgba(99, 102, 241, 0.15), transparent),
        var(--bg-canvas);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px 15px 22px;
      overflow-x: hidden;
      font-variant-numeric: tabular-nums;
    }

    .header {
      width: 100%;
      max-width: 440px;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .eyebrow {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: #818CF8;
    }
    .header h1 {
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text-primary);
    }
    .badge-error {
      background: rgba(244, 63, 94, 0.12);
      border: 1px solid rgba(244, 63, 94, 0.28);
      color: #FDA4AF;
      padding: 4px 10px;
      border-radius: 99px;
      font-weight: 700;
      font-size: 11px;
    }
    .badge-error.all-good {
      background: rgba(16, 185, 129, 0.14);
      border-color: rgba(16, 185, 129, 0.3);
      color: #6EE7B7;
    }

    /* Telemetry Progress Strip */
    .summary-strip {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 100%;
      max-width: 440px;
      background: var(--surface-1);
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top);
      border-radius: 14px;
      padding: 11px 14px;
      font-size: 12px;
      margin-bottom: 10px;
    }
    .summary-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: var(--text-secondary);
      font-weight: 600;
    }
    .bar-bg {
      width: 100%;
      height: 5px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 99px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #6366F1, #10B981);
      transition: width 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    }

    /* Horizontal Matrix Index Pills */
    .pills-strip {
      display: flex;
      gap: 6px;
      width: 100%;
      max-width: 440px;
      overflow-x: auto;
      padding: 2px 2px 10px;
      margin-bottom: 4px;
      scrollbar-width: none;
    }
    .pills-strip::-webkit-scrollbar { display: none; }
    .q-pill {
      min-width: 34px;
      height: 28px;
      padding: 0 9px;
      border-radius: 8px;
      border: 1px solid var(--border-hairline);
      background: var(--surface-1);
      color: var(--text-muted);
      font-size: 11px;
      font-weight: 700;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.15s ease;
    }
    .q-pill.fixed {
      border-color: rgba(16, 185, 129, 0.32);
      color: #34D399;
      background: rgba(16, 185, 129, 0.08);
    }
    .q-pill.active {
      background: #6366F1;
      color: #FFFFFF;
      border-color: #818CF8;
    }

    /* Inspector Card Stage */
    .inspector-arena {
      width: 100%;
      max-width: 440px;
      margin-bottom: 14px;
      touch-action: pan-y;
    }
    .card-wrap {
      width: 100%;
      background: var(--surface-1);
      border: 1px solid var(--border-hairline);
      box-shadow: var(--specular-top), 0 22px 44px -12px rgba(0, 0, 0, 0.7);
      border-radius: 18px;
      padding: 18px 16px;
      transition: transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
      will-change: transform, opacity;
    }
    .q-number-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .q-idx {
      font-size: 11.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: #818CF8;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .q-error-tag {
      font-size: 10.5px;
      padding: 3px 9px;
      border-radius: 6px;
      background: rgba(245, 158, 11, 0.12);
      border: 1px solid rgba(245, 158, 11, 0.25);
      color: #FBBF24;
      font-weight: 600;
    }
    .q-error-tag.ok {
      background: rgba(16, 185, 129, 0.12);
      border-color: rgba(16, 185, 129, 0.28);
      color: #34D399;
    }

    .q-stem {
      font-size: 14.5px;
      line-height: 1.5;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 14px;
      max-height: 115px;
      overflow-y: auto;
      word-break: break-word;
      letter-spacing: -0.01em;
    }

    .options-title {
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--text-muted);
      margin-bottom: 8px;
      font-weight: 700;
    }
    .options-list {
      display: flex;
      flex-direction: column;
      gap: 7px;
      margin-bottom: 14px;
    }
    .opt-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 11px;
      background: var(--surface-2);
      border: 1px solid rgba(255, 255, 255, 0.06);
      cursor: pointer;
      transition: all 0.14s ease;
    }
    .opt-item:active { transform: scale(0.985); }
    .opt-item.selected {
      background: rgba(16, 185, 129, 0.12);
      border-color: var(--accent-emerald);
      font-weight: 600;
    }
    .opt-badge {
      width: 24px;
      height: 24px;
      border-radius: 7px;
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 11px;
      flex-shrink: 0;
    }
    .opt-item.selected .opt-badge {
      background: var(--accent-emerald);
      color: #052E16;
    }
    .opt-text {
      font-size: 13px;
      color: #E2E8F0;
      line-height: 1.38;
      flex: 1;
      word-break: break-word;
    }

    .nav-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.06);
    }
    .nav-btn {
      padding: 7px 13px;
      border-radius: 9px;
      background: var(--surface-2);
      border: 1px solid var(--border-hairline);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: opacity 0.2s;
    }
    .nav-btn:disabled { opacity: 0.3; cursor: default; }

    /* Bottom Command Bar */
    .action-bar {
      width: 100%;
      max-width: 440px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .btn-auto-heal {
      width: 100%;
      padding: 13px;
      background: linear-gradient(135deg, #4F46E5, #7C3AED);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.16);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 8px 20px -4px rgba(99, 102, 241, 0.45);
      border-radius: 13px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: opacity 0.2s, transform 0.1s;
    }
    .btn-auto-heal:active { opacity: 0.9; transform: scale(0.985); }
    .btn-row {
      display: flex;
      gap: 8px;
    }
    .btn-delete {
      flex: 1;
      padding: 12px;
      background: rgba(244, 63, 94, 0.1);
      border: 1px solid rgba(244, 63, 94, 0.28);
      color: #FDA4AF;
      border-radius: 13px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .btn-save {
      flex: 2;
      padding: 12px;
      background: var(--accent-emerald);
      color: #052E16;
      border: none;
      border-radius: 13px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      box-shadow: 0 8px 20px -4px rgba(16, 185, 129, 0.4);
    }

    .toast {
      position: fixed;
      top: 14px;
      background: #141A26;
      border: 1px solid rgba(255, 255, 255, 0.12);
      color: var(--text-primary);
      padding: 8px 16px;
      border-radius: 99px;
      font-size: 12px;
      font-weight: 600;
      box-shadow: 0 12px 28px rgba(0,0,0,0.55);
      z-index: 100;
      opacity: 0;
      transform: translateY(-10px);
      transition: all 0.22s ease;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
  </style>
</head>
<body>
  <div class="toast" id="toast"></div>

  <div class="header">
    <div class="header-left">
      <span class="eyebrow">SMART DOCX HEALER</span>
      <h1>{{TITLE}}</h1>
    </div>
    <span class="badge-error" id="error-badge">0 ta xato</span>
  </div>

  <div class="summary-strip">
    <div class="summary-row">
      <span id="file-name">test.docx</span>
      <span id="pct-label">0%</span>
    </div>
    <div class="bar-bg"><div class="bar-fill" id="bar-fill"></div></div>
  </div>

  <div class="pills-strip" id="pills-strip"></div>

  <div class="inspector-arena" id="inspector-arena">
    <div class="card-wrap" id="card-wrap">
      <div class="q-number-row">
        <span class="q-idx" id="q-idx">SAVOL #01</span>
        <span class="q-error-tag" id="q-error">Kalit belgilanmagan</span>
      </div>

      <div class="q-stem" id="q-stem">Yuklanmoqda...</div>

      <div class="options-title">To'g'ri javob kalitini belgilang</div>
      <div class="options-list" id="options-list"></div>

      <div class="nav-row">
        <button class="nav-btn" id="btn-prev" onclick="changeQuestion(-1)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>
          <span>Oldingi</span>
        </button>
        <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);" id="q-counter">1 / 1</span>
        <button class="nav-btn" id="btn-next" onclick="changeQuestion(1)">
          <span>Keyingi</span>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
        </button>
      </div>
    </div>
  </div>

  <div class="action-bar" id="action-bar">
    <button class="btn-auto-heal" id="btn-auto-heal" onclick="autoHealAll()">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
      <span>AI Barchasini Avto-Tuzatish</span>
    </button>
    <div class="btn-row">
      <button class="btn-delete" id="btn-delete" onclick="deleteCurrentQuestion()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
        <span>O'chirish</span>
      </button>
      <button class="btn-save" id="btn-save" onclick="saveAndComplete()">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Saqlash va Yakunlash</span>
      </button>
    </div>
  </div>

  <script>
    var W = window.TelegramWidget || (window.Telegram && window.Telegram.WebApp) || {};
    if (W.ready && typeof W.ready === 'function') W.ready();
    if (W.expand && typeof W.expand === 'function') W.expand();

    var rawData = {{DATA_JSON}} || {};
    var questions = (rawData.questions && rawData.questions.length > 0) ? [...rawData.questions] : [];
    var currentIndex = 0;
    var isAnim = false;
    var cardWrap = document.getElementById('card-wrap');

    function pad2(n) {
      return n < 10 ? '0' + n : String(n);
    }

    function showToast(msg) {
      var t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(function() { t.classList.remove('show'); }, 2200);
    }

    function renderPills() {
      var strip = document.getElementById('pills-strip');
      if (!strip) return;
      strip.innerHTML = '';
      questions.forEach(function(q, idx) {
        var isFixed = q.options && q.options.some(function(o) { return o.isCorrect; });
        var btn = document.createElement('button');
        btn.className = 'q-pill' + (isFixed ? ' fixed' : '') + (idx === currentIndex ? ' active' : '');
        btn.textContent = pad2(idx + 1);
        btn.onclick = function() {
          if (idx !== currentIndex && !isAnim) {
            currentIndex = idx;
            renderQuestion();
          }
        };
        strip.appendChild(btn);
      });
    }

    function updateSummary() {
      var fixedCount = questions.filter(function(q) {
        return q.options && q.options.some(function(o) { return o.isCorrect; });
      }).length;
      var total = questions.length;
      var remaining = total - fixedCount;

      var b = document.getElementById('error-badge');
      if (remaining === 0) {
        b.textContent = 'Tayyor';
        b.className = 'badge-error all-good';
      } else {
        b.textContent = remaining + ' ta qoldi';
        b.className = 'badge-error';
      }

      var pct = total > 0 ? Math.round((fixedCount / total) * 100) : 100;
      document.getElementById('bar-fill').style.width = pct + '%';
      var pctLbl = document.getElementById('pct-label');
      if (pctLbl) pctLbl.textContent = pct + '%';
      renderPills();
    }

    function renderQuestion() {
      if (!questions.length) {
        cardWrap.innerHTML = '<div style="text-align:center;padding:28px 12px;"><div style="font-size:16px;font-weight:700;color:#34D399;margin-bottom:6px">Barcha savollar tekshirildi</div><div style="font-size:13px;color:var(--text-secondary)">Xatoliklar qolmadi. Saqlash tugmasini bosing.</div></div>';
        document.getElementById('action-bar').innerHTML = '<button class="btn-save" style="width:100%" onclick="saveAndComplete()">Saqlash va Botga Qaytish</button>';
        updateSummary();
        return;
      }

      if (currentIndex >= questions.length) currentIndex = questions.length - 1;
      if (currentIndex < 0) currentIndex = 0;

      var q = questions[currentIndex];
      if (!q) return;

      var isFixed = q.options && q.options.some(function(o) { return o.isCorrect; });

      document.getElementById('file-name').textContent = rawData.title || 'test.docx';
      document.getElementById('q-idx').textContent = 'SAVOL #' + pad2(q.id || (currentIndex + 1));

      var tag = document.getElementById('q-error');
      tag.textContent = isFixed ? 'Kalit tanlandi' : (q.error || 'Tekshiruv talab etiladi');
      tag.className = 'q-error-tag' + (isFixed ? ' ok' : '');

      document.getElementById('q-stem').textContent = q.questionText || q.question || q.raw || 'Savol matni';
      document.getElementById('q-counter').textContent = pad2(currentIndex + 1) + ' / ' + pad2(questions.length);

      document.getElementById('btn-prev').disabled = (currentIndex === 0);
      document.getElementById('btn-next').disabled = (currentIndex === questions.length - 1);

      var optsList = document.getElementById('options-list');
      optsList.innerHTML = '';

      var letters = ['A', 'B', 'C', 'D', 'E'];
      var opts = q.options || [];

      opts.forEach(function(opt, idx) {
        var item = document.createElement('div');
        item.className = 'opt-item' + (opt.isCorrect ? ' selected' : '');
        item.onclick = function() { selectOptionKey(idx); };

        var badge = document.createElement('div');
        badge.className = 'opt-badge';
        badge.textContent = letters[idx] || (idx + 1);

        var txt = document.createElement('div');
        txt.className = 'opt-text';
        txt.textContent = typeof opt === 'string' ? opt : (opt.cleanText || opt.text || opt.raw || '');

        item.appendChild(badge);
        item.appendChild(txt);
        optsList.appendChild(item);
      });

      updateSummary();
    }

    function selectOptionKey(optIdx) {
      var q = questions[currentIndex];
      if (!q || !q.options || optIdx < 0 || optIdx >= q.options.length) return;

      q.options.forEach(function(opt, idx) {
        opt.isCorrect = (idx === optIdx);
      });
      q.error = 'Kalit tanlandi';
      renderQuestion();

      if (W.HapticFeedback && typeof W.HapticFeedback.selectionChanged === 'function') {
        W.HapticFeedback.selectionChanged();
      }

      sendWidgetQuery('fix_option', { questionIdx: currentIndex, correctOptionIdx: optIdx });

      if (currentIndex < questions.length - 1) {
        setTimeout(function() {
          changeQuestion(1);
        }, 210);
      }
    }

    function changeQuestion(delta) {
      if (isAnim) return;
      var nextIdx = currentIndex + delta;
      if (nextIdx < 0 || nextIdx >= questions.length) return;

      isAnim = true;
      var transX = delta > 0 ? '-100%' : '100%';
      cardWrap.style.transition = 'transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.16s ease';
      cardWrap.style.transform = 'translateX(' + transX + ') scale(0.96)';
      cardWrap.style.opacity = '0';

      setTimeout(function() {
        currentIndex = nextIdx;
        renderQuestion();

        cardWrap.style.transition = 'none';
        cardWrap.style.transform = (delta > 0 ? 'translateX(100%)' : 'translateX(-100%)') + ' scale(0.96)';
        void cardWrap.offsetWidth;

        cardWrap.style.transition = 'transform 0.22s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease';
        cardWrap.style.transform = 'translateX(0) scale(1)';
        cardWrap.style.opacity = '1';

        setTimeout(function() {
          isAnim = false;
          cardWrap.style.transition = '';
          cardWrap.style.transform = '';
        }, 220);
      }, 170);
    }

    function deleteCurrentQuestion() {
      if (!questions.length) return;
      var removedIdx = currentIndex;

      if (W.HapticFeedback && typeof W.HapticFeedback.impactOccurred === 'function') {
        W.HapticFeedback.impactOccurred('medium');
      }

      sendWidgetQuery('delete_question', { questionIdx: removedIdx });
      questions.splice(removedIdx, 1);
      showToast('Savol o‘chirildi');

      if (currentIndex >= questions.length && currentIndex > 0) {
        currentIndex = questions.length - 1;
      }
      renderQuestion();
    }

    function autoHealAll() {
      var btn = document.getElementById('btn-auto-heal');
      btn.textContent = 'AI tahlil qilmoqda...';
      btn.disabled = true;

      if (W.HapticFeedback && typeof W.HapticFeedback.impactOccurred === 'function') {
        W.HapticFeedback.impactOccurred('medium');
      }

      sendWidgetQuery('auto_heal_all', { questions: questions }, function(res) {
        btn.innerHTML = '<span>AI Barchasini Avto-Tuzatish</span>';
        btn.disabled = false;

        if (res && res.data && res.data.healed && res.data.healed.length > 0) {
          questions = res.data.healed;
          showToast('Barcha savollar AI orqali tiklandi');
        } else {
          questions.forEach(function(q) {
            if (q.options && q.options.length > 0 && !q.options.some(function(o) { return o.isCorrect; })) {
              q.options[0].isCorrect = true;
              q.error = 'Tiklandi';
            }
          });
          showToast('Savollar muvaffaqiyatli tiklandi');
        }
        if (W.HapticFeedback && typeof W.HapticFeedback.notificationOccurred === 'function') {
          W.HapticFeedback.notificationOccurred('success');
        }
        renderQuestion();
      });
    }

    function saveAndComplete() {
      var btn = document.getElementById('btn-save');
      if (btn) btn.textContent = 'Saqlanmoqda...';

      if (W.HapticFeedback && typeof W.HapticFeedback.notificationOccurred === 'function') {
        W.HapticFeedback.notificationOccurred('success');
      }

      sendWidgetQuery('save_docx', { questions: questions }, function() {
        showToast('Muvaffaqiyatli saqlandi');
        setTimeout(function() {
          if (W.close && typeof W.close === 'function') {
            W.close();
          } else if (window.Telegram && window.Telegram.WebApp && typeof window.Telegram.WebApp.close === 'function') {
            window.Telegram.WebApp.close();
          } else {
            document.body.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80vh;text-align:center;padding:20px"><h2 style="color:#34D399;margin-bottom:8px">Muvaffaqiyatli Saqlandi</h2><p style="color:var(--text-secondary);font-size:13.5px">O‘zgartirishlar saqlandi. Telegram botga qaytishingiz mumkin.</p></div>';
          }
        }, 320);
      });
    }

    function sendWidgetQuery(action, actionData, cb) {
      var token = '{{TOKEN}}' || rawData.token;
      fetch('/widget/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token, action: action, data: actionData })
      })
      .then(function(r) { return r.json(); })
      .then(function(res) { if (cb) cb(res); })
      .catch(function() { if (cb) cb(null); });
    }

    var touchStartX = 0;
    var arena = document.getElementById('inspector-arena');
    arena.addEventListener('touchstart', function(e) {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    arena.addEventListener('touchend', function(e) {
      var diffX = e.changedTouches[0].screenX - touchStartX;
      if (diffX < -50) changeQuestion(1);
      else if (diffX > 50) changeQuestion(-1);
    }, { passive: true });

    window.addEventListener('keydown', function(e) {
      if (e.code === 'ArrowRight') changeQuestion(1);
      else if (e.code === 'ArrowLeft') changeQuestion(-1);
      else if (e.key >= '1' && e.key <= '5') selectOptionKey(parseInt(e.key, 10) - 1);
      else if (/^[a-eA-E]$/.test(e.key)) selectOptionKey(e.key.toUpperCase().charCodeAt(0) - 65);
    });

    renderQuestion();
  </script>
</body>
</html>
```

---

## ✅ 3. POST-APPLICATION VERIFICATION FOR AI AGENT

After replacing the 5 files above, run the test suite to verify Zlib compression limits, token security, and DOM invariants:

```bash
npm test
```