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