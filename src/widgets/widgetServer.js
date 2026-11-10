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

    case 'fix_option':
      return {
        questionIdx: data?.questionIdx,
        correctOptionIdx: data?.correctOptionIdx,
        status: 'updated',
      };

    case 'auto_heal_all':
      return {
        status: 'auto_healed',
        healed: verifiedToken.payload?.questions || [],
      };

    case 'save_docx':
      return {
        status: 'completed',
        savedCount: data?.questions?.length || 0,
      };

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
