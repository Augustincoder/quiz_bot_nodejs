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

/**
 * Decodes HTML entities back to their raw characters to prevent double-escaping.
 * @param {any} str
 * @returns {string}
 */
function decodeHtmlEntities(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Escapes HTML entities to prevent XSS.
 * @param {any} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  const decoded = decodeHtmlEntities(str);
  return decoded
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

  const templatePath = path.join(TEMPLATE_DIR, templateFileName);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Widget template not found: "${templatePath}"`);
  }

  let html = fs.readFileSync(templatePath, 'utf8');

  // Prevent script breakout in JSON injection
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
 *
 * @param {string} type - Widget type
 * @param {object} payload - Widget payload
 * @param {string} fallbackText - Clean fallback message text
 * @param {object} [fallbackKeyboard] - Inline keyboard markup for classic clients
 * @param {object} [options] - Optional settings (userId, ttlMs, baseUrl)
 * @returns {object} Telegram 10.4 Widget Message structure
 */
function buildWidgetMessage(type, payload = {}, fallbackText = '', fallbackKeyboard = null, options = {}) {
  const userId = options.userId !== undefined ? options.userId : (payload?.userId || 0);
  const isEnabled = isWidgetEngineEnabled(userId);

  if (!isEnabled) {
    const defaultKeyboard = fallbackKeyboard || {
      inline_keyboard: [],
    };
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
          [
            {
              text: '🚀 Widgetni ochish',
              web_app: { url: widgetUrl },
            },
          ],
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
    // If URL is invalid (e.g. t.me or non-https), strip web_app to prevent BUTTON_URL_INVALID
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
 *
 * @param {string} html
 * @returns {{ rawBytes: number, compressedBytes: number, valid: boolean }}
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
 * Builds self-contained, inline HTML for Telegram Bot API 10.4 `sendWidget`.
 * Conforms to QuickJS sandbox, Profile 1 CSS/JS, zero external requests, and <= 4096 bytes zlib compressed.
 * Spec: https://core.telegram.org/bots/api#sendwidget and https://core.telegram.org/bots/widgets
 *
 * @param {object} viewData
 * @returns {string} Fully standalone inline HTML
 */
function buildInlineFlashcardWidgetHtml(viewData = {}) {
  const qClean = decodeHtmlEntities(viewData.question || 'Savol...');
  const aClean = decodeHtmlEntities(viewData.answer || 'Javob...');
  const titleClean = decodeHtmlEntities(viewData.subjectName ? `${viewData.subjectName} • ${viewData.blockName || ''}` : '⚡ 3D Flashcard');

  const initialData = JSON.stringify({
    title: titleClean,
    q: qClean,
    a: aClean,
    total: viewData.total || 0,
    learned: viewData.learnedCount || 0,
    cardIdx: viewData.cardIdx || 0,
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><style>
* { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
html, body { width: 100%; height: auto; min-height: 290px; background: var(--tg-theme-bg-color, #17212b); color: var(--tg-theme-text-color, #fff); overflow-x: hidden; }
.wrap { padding: 10px 12px; min-height: 290px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box; }
.top-bar { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--tg-theme-hint-color, #90caf9); opacity: 0.9; }
.bar-wrap { background: rgba(255,255,255,0.12); height: 5px; border-radius: 3px; margin: 5px 0 8px; overflow: hidden; }
.bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #2481cc, #4caf50); border-radius: 3px; transition: width 0.3s ease; }
.card-box { flex: 1; display: flex; align-items: stretch; justify-content: center; min-height: 180px; margin-bottom: 8px; perspective: 900px; touch-action: pan-y; }
.card { width: 100%; min-height: 180px; position: relative; border-radius: 14px; cursor: pointer; transform-style: preserve-3d; transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1); will-change: transform, opacity; }
.card.flipped { transform: rotateY(180deg); }
.face { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 14px; padding: 14px 12px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; backface-visibility: hidden; -webkit-backface-visibility: hidden; box-shadow: 0 6px 20px rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.12); background: var(--tg-theme-secondary-bg-color, #233446); }
.face.back { transform: rotateY(180deg); background: var(--tg-theme-bg-color, #182533); border-color: rgba(76, 175, 80, 0.4); }
.tag { font-size: 10px; font-weight: 700; letter-spacing: 0.8px; opacity: 0.85; margin-bottom: 6px; text-transform: uppercase; }
.front .tag { color: var(--tg-theme-link-color, #64b5f6); }
.back .tag { color: #81c784; }
.q-text { font-size: 15px; font-weight: 500; line-height: 1.45; word-break: break-word; max-height: 130px; overflow-y: auto; padding: 0 4px; }
.a-text { font-size: 16px; font-weight: 700; line-height: 1.45; color: #a5d6a7; word-break: break-word; max-height: 130px; overflow-y: auto; padding: 0 4px; }
.hint { margin-top: 8px; font-size: 11px; opacity: 0.6; }
.actions { display: flex; gap: 8px; margin-top: 4px; }
.btn { flex: 1; padding: 10px 14px; border-radius: 10px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; color: #fff; transition: transform 0.1s ease, opacity 0.2s ease; display: flex; align-items: center; justify-content: center; gap: 6px; }
.btn:active { transform: scale(0.96); opacity: 0.85; }
.btn-repeat { background: #d32f2f; }
.btn-known { background: #2e7d32; }
</style></head><body>
<div class="wrap">
  <div class="top-bar"><span id="title">⚡ 3D Flashcard</span><span id="prog">0 / 0</span></div>
  <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
  <div class="card-box">
    <div class="card" id="card">
      <div class="face front">
        <div class="tag">SAVOL (YODLASH)</div>
        <div class="q-text" id="q-text">Savol yuklanmoqda...</div>
        <div class="hint">💡 Javobni ko'rish uchun bosing 👆</div>
      </div>
      <div class="face back">
        <div class="tag">TO'G'RI JAVOB</div>
        <div class="a-text" id="a-text">Javob yuklanmoqda...</div>
        <div class="hint">🔄 Qaytadan aylantirish uchun bosing</div>
      </div>
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-repeat" id="btn-rep" onclick="triggerAction('left','repeat')">👈 Qaytarish</button>
    <button class="btn btn-known" id="btn-kno" onclick="triggerAction('right','known')">👉 Bilib oldim</button>
  </div>
</div>
<script>
var W = window.TelegramWidget || window.Telegram && window.Telegram.WebApp || {};
var card = document.getElementById('card');
var isAnim = false;

function clean(s) {
  if (!s) return '';
  return String(s).replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function flip() {
  if (isAnim) return;
  card.classList.toggle('flipped');
  if (W.HapticFeedback && typeof W.HapticFeedback.selectionChanged === 'function') {
    W.HapticFeedback.selectionChanged();
  }
}

card.onclick = function(e) {
  if (isAnim) return;
  flip();
};

function render(dataStr) {
  try {
    var d = typeof dataStr === 'string' ? JSON.parse(dataStr) : (dataStr || {});
    if (d.isFinished) {
      document.querySelector('.card-box').innerHTML = '<div class="face front" style="position:relative;width:100%"><div class="tag" style="color:#81c784">TABRIKLAYMIZ! 🎉</div><div class="q-text" style="color:#a5d6a7;font-weight:700">Barcha kartochkalarni muvaffaqiyatli o‘zlashtirdingiz!</div></div>';
      var actions = document.querySelector('.actions');
      if (actions) actions.style.display = 'none';
      return;
    }
    if (d.q) document.getElementById('q-text').textContent = clean(d.q);
    if (d.a) document.getElementById('a-text').textContent = clean(d.a);
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

  // Instant swipe-out transition (0ms perceived lag)
  var transX = direction === 'right' ? '125%' : '-125%';
  var rot = direction === 'right' ? '14deg' : '-14deg';
  var isFlipped = card.classList.contains('flipped');
  card.style.transition = 'transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease';
  card.style.transform = (isFlipped ? 'rotateY(180deg) ' : '') + 'translateX(' + transX + ') rotate(' + rot + ')';
  card.style.opacity = '0';

  if (typeof W.request === 'function') {
    W.request(act).then(function(res) {
      if (res && res.result) {
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
  render(newData);
  card.style.transition = 'none';
  card.classList.remove('flipped');
  card.style.transform = 'translateY(16px) scale(0.92)';
  card.style.opacity = '0';

  void card.offsetWidth;

  card.style.transition = 'transform 0.26s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease';
  card.style.transform = 'translate(0, 0) scale(1)';
  card.style.opacity = '1';

  setTimeout(function() {
    isAnim = false;
    card.style.transition = '';
    card.style.transform = '';
  }, 280);
}

function resetCard() {
  card.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
  card.style.transform = card.classList.contains('flipped') ? 'rotateY(180deg)' : '';
  card.style.opacity = '1';
  isAnim = false;
}

// Touch swipe gestures
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
    card.style.transform = base + 'translateX(' + dx + 'px) rotate(' + (dx * 0.05) + 'deg)';
  }
}, { passive: true });

card.addEventListener('touchend', function(e) {
  if (!isDragging || isAnim) return;
  isDragging = false;
  if (curX > 65) {
    triggerAction('right', 'known');
  } else if (curX < -65) {
    triggerAction('left', 'repeat');
  } else if (Math.abs(curX) > 5) {
    card.style.transition = 'transform 0.22s cubic-bezier(0.18, 0.89, 0.32, 1.28)';
    card.style.transform = card.classList.contains('flipped') ? 'rotateY(180deg)' : '';
  }
}, { passive: true });

var lastData = '';
function checkData() {
  var pd = W.chatData || W.publicData;
  if (pd && pd !== lastData) {
    lastData = pd;
    animateIn(pd);
  }
}
setInterval(checkData, 300);
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
 * Conforms to QuickJS sandbox, Profile 1 CSS/JS, zero external requests, and <= 4096 bytes zlib compressed.
 * Spec: https://core.telegram.org/bots/api#sendwidget and https://core.telegram.org/bots/widgets
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

  const initialData = JSON.stringify({
    title: decodeHtmlEntities(viewData.fileName || viewData.title || 'Docx Healer'),
    total: rawQuestions.length,
    curIdx: typeof viewData.currentIndex === 'number' ? viewData.currentIndex : 0,
    questions: rawQuestions.map((q, i) => {
      const qText = q.questionText || q.question || q.raw || 'Savol';
      return {
        id: q.id || (i + 1),
        q: decodeHtmlEntities(typeof qText === 'string' ? qText : 'Savol'),
        err: decodeHtmlEntities(q.error || 'Tekshirish talab etiladi'),
        opts: (q.options || []).map((o) => {
          const t = typeof o === 'string' ? o : (o.cleanText || o.text || '');
          const isOk = typeof o === 'object' ? Boolean(o.isCorrect) : false;
          return {
            t: decodeHtmlEntities(t),
            ok: isOk,
          };
        }),
      };
    }),
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><style>
* { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
html, body { width: 100%; min-height: 300px; background: var(--tg-theme-bg-color, #17212b); color: var(--tg-theme-text-color, #fff); overflow-x: hidden; }
.wrap { padding: 10px 12px; min-height: 300px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box; }
.top-bar { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 700; color: var(--tg-theme-link-color, #64b5f6); }
.badge { font-size: 10px; padding: 2px 8px; border-radius: 6px; background: rgba(255, 152, 0, 0.2); color: #ffb74d; font-weight: 600; }
.badge.ok { background: rgba(76, 175, 80, 0.2); color: #81c784; }
.bar-wrap { background: rgba(255,255,255,0.12); height: 4px; border-radius: 2px; margin: 5px 0 8px; overflow: hidden; }
.bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #2481cc, #4caf50); transition: width 0.3s; }
.card-box { flex: 1; display: flex; flex-direction: column; min-height: 195px; background: var(--tg-theme-secondary-bg-color, #233446); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 12px; margin-bottom: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.25); position: relative; transition: transform 0.22s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.2s; will-change: transform, opacity; }
.q-title { font-size: 11px; text-transform: uppercase; color: var(--tg-theme-hint-color, #8e9ca8); margin-bottom: 4px; font-weight: 700; }
.q-text { font-size: 14px; font-weight: 500; line-height: 1.4; max-height: 60px; overflow-y: auto; margin-bottom: 8px; word-break: break-word; color: #fff; }
.opts { display: flex; flex-direction: column; gap: 6px; }
.opt { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.08); cursor: pointer; transition: all 0.15s; font-size: 13px; line-height: 1.3; }
.opt:active { transform: scale(0.98); }
.opt.sel { background: rgba(76, 175, 80, 0.22); border-color: #4caf50; font-weight: 600; }
.opt-l { width: 22px; height: 22px; border-radius: 50%; background: rgba(255,255,255,0.12); display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
.opt.sel .opt-l { background: #4caf50; color: #fff; }
.opt-t { flex: 1; word-break: break-word; color: #e0e0e0; }
.actions { display: flex; gap: 6px; }
.btn { flex: 1; padding: 9px 12px; border-radius: 10px; border: none; font-size: 12px; font-weight: 600; cursor: pointer; color: #fff; background: rgba(255,255,255,0.1); display: flex; align-items: center; justify-content: center; gap: 4px; transition: opacity 0.2s; }
.btn:active { opacity: 0.8; }
.btn:disabled { opacity: 0.3; cursor: default; }
.btn-heal { background: linear-gradient(135deg, #7b1fa2, #512da8); }
.btn-save { background: #2e7d32; }
</style></head><body>
<div class="wrap">
  <div class="top-bar"><span id="title">🔧 Docx Healer</span><span class="badge" id="badge">Xato #1</span></div>
  <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
  <div class="card-box" id="box">
    <div class="q-title" id="q-hdr">SAVOL (1 / 3)</div>
    <div class="q-text" id="q-text">Savol matni yuklanmoqda...</div>
    <div class="opts" id="opts"></div>
  </div>
  <div class="actions">
    <button class="btn" id="btn-prev" onclick="nav(-1)">◀ Oldingi</button>
    <button class="btn btn-heal" id="btn-heal" onclick="healAll()">✨ AI Tuzatish</button>
    <button class="btn" id="btn-next" onclick="nav(1)">Keyingi ▶</button>
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
  if (!qs.length) return;
  var fixed = qs.filter(function(q) {
    return q.opts && q.opts.some(function(o) { return o.ok; });
  }).length;
  var pct = Math.round((fixed / qs.length) * 100);
  document.getElementById('bar').style.width = pct + '%';
}

function render() {
  if (!qs.length) {
    box.innerHTML = '<div class="q-title" style="color:#81c784">TABRIKLAYMIZ! 🎉</div><div class="q-text" style="color:#a5d6a7;font-weight:700">Barcha xatoliklar muvaffaqiyatli to‘g‘rilandi!</div>';
    var acts = document.querySelector('.actions');
    if (acts) acts.style.display = 'none';
    return;
  }
  var q = qs[cur];
  if (!q) return;

  var letters = ['A', 'B', 'C', 'D', 'E'];
  var isFixed = q.opts && q.opts.some(function(o) { return o.ok; });

  document.getElementById('title').textContent = initialData.title || '🔧 Docx Healer';
  var badge = document.getElementById('badge');
  badge.textContent = isFixed ? '✅ Kalit belgilandi' : clean(q.err || 'To‘g‘ri javob yo‘q');
  badge.className = 'badge' + (isFixed ? ' ok' : '');

  document.getElementById('q-hdr').textContent = 'SAVOL (' + (cur + 1) + ' / ' + qs.length + ')';
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

  q.opts.forEach(function(o, i) {
    o.ok = (i === optIdx);
  });
  render();

  if (W.HapticFeedback && typeof W.HapticFeedback.selectionChanged === 'function') {
    W.HapticFeedback.selectionChanged();
  }

  var payload = { action: 'docx_pick', qIdx: cur, optIdx: optIdx };
  if (typeof W.request === 'function') {
    W.request(JSON.stringify(payload)).catch(function() {});
  } else if (typeof W.sendQuery === 'function') {
    W.sendQuery(JSON.stringify(payload));
  }

  // Optimistic transition to next question if not on last
  if (cur < qs.length - 1) {
    setTimeout(function() {
      nav(1);
    }, 240);
  }
}

function nav(delta) {
  if (isAnim) return;
  var nextIdx = cur + delta;
  if (nextIdx < 0 || nextIdx >= qs.length) return;

  isAnim = true;
  var transX = delta > 0 ? '-100%' : '100%';
  box.style.transition = 'transform 0.18s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.16s ease';
  box.style.transform = 'translateX(' + transX + ') scale(0.95)';
  box.style.opacity = '0';

  setTimeout(function() {
    cur = nextIdx;
    render();
    box.style.transition = 'none';
    box.style.transform = (delta > 0 ? 'translateX(100%)' : 'translateX(-100%)') + ' scale(0.95)';
    void box.offsetWidth;

    box.style.transition = 'transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.18s ease';
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
  btn.textContent = '⏳ AI...';
  btn.disabled = true;

  if (W.HapticFeedback && typeof W.HapticFeedback.impactOccurred === 'function') {
    W.HapticFeedback.impactOccurred('medium');
  }

  var payload = { action: 'docx_heal_all' };
  if (typeof W.request === 'function') {
    W.request(JSON.stringify(payload)).then(function(res) {
      btn.textContent = '✨ AI Tuzatish';
      btn.disabled = false;
      if (res && res.result) {
        try {
          var d = typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
          if (d.questions) qs = d.questions;
        } catch(e) {}
      } else {
        heuristicHeal();
      }
      render();
    }).catch(function() {
      heuristicHeal();
      btn.textContent = '✨ AI Tuzatish';
      btn.disabled = false;
      render();
    });
  } else {
    heuristicHeal();
    setTimeout(function() {
      btn.textContent = '✨ AI Tuzatish';
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

// Touch swipe gestures
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

box.addEventListener('touchend', function(e) {
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
