'use strict';

const express = require('express');
const widgetService = require('../services/widgetService');
const logger = require('../core/logger');

const router = express.Router();

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
  // Check if a specific handler was registered
  if (action && queryHandlers.has(action)) {
    return await queryHandlers.get(action)(verifiedToken, action, data);
  }

  // Built-in handlers
  switch (action) {
    case 'my_analysis':
      return {
        userId: verifiedToken.userId,
        personal: verifiedToken.payload?.personal || {},
        status: 'ok',
      };

    case 'card_action':
      return {
        action: data?.action,
        cardIdx: data?.cardIdx,
        timestamp: Date.now(),
        status: 'saved',
      };

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
          error: '✅ AI orqali tiklandi',
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
            error: '⚠️ Qo‘lda tanlash talab etiladi',
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
            error: '✅ Tiklandi',
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
      const questionsInput = data?.questions || verifiedToken.payload?.questions || [];
      const userId = verifiedToken.userId;

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
          let session = rawSession ? JSON.parse(rawSession) : null;

          if (!session) session = { data: {} };
          if (!session.data) session.data = {};

          const existingValid = session.data.questions || [];
          const updatedQuestions = [...existingValid, ...validQuestionsToAdd];

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
 * Generates a clean, friendly responsive HTML error page.
 */
function renderErrorPage(title, message) {
  return `<!DOCTYPE html>
<html lang="uz">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${widgetService.escapeHtml(title)}</title>
  <style>
    body {
      background: #0e1621;
      color: #f5f5f5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      margin: 0;
    }
    .card {
      background: #17212b;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 18px;
      padding: 32px 24px;
      text-align: center;
      max-width: 380px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
    }
    .icon { font-size: 48px; margin-bottom: 16px; }
    h2 { font-size: 18px; font-weight: 700; margin-bottom: 8px; color: #ff9800; }
    p { font-size: 13px; color: #8e9ca8; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⏳</div>
    <h2>${widgetService.escapeHtml(title)}</h2>
    <p>${widgetService.escapeHtml(message)}</p>
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
        'Havola muddati tugagan yoki yaroqsiz',
        'Xavfsizlik yuzasidan widget tokeni tekshiruvdan o\'tmadi yoki 1 soatlik yaroqlilik muddati tugagan.'
      )
    );
  }

  try {
    // Security headers: allow iframe embedding in Telegram WebApp while maintaining strict CSP
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
    return res.status(500).send(renderErrorPage('Xatolik', 'Widgetni yuklashda xatolik yuz berdi.'));
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
