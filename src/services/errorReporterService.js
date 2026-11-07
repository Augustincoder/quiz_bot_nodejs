'use strict';

const https = require('https');
const { SECOND_BOT, ADMIN_ID } = require('../config/config');

const DEDUP_WINDOW_MS = 60 * 1000; // 60 seconds deduplication window
const MAX_TELEGRAM_LEN = 3900; // Safe threshold well under Telegram's 4096-char limit

const BENIGN_PATTERNS = [
  'bot was blocked by the user',
  'user is deactivated',
  'message is not modified',
  'message to edit not found',
  'message can\'t be deleted',
  'query is too old',
  'query ID is invalid',
  'chat not found',
  'have no rights to send a message',
  'replied message not found',
  'Too Many Requests',
];

class ErrorReporterService {
  constructor() {
    this._dedupCache = new Map();
    this._isReporting = false;
    this._mockDispatcher = null;
    this._httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 10,
      timeout: 10000,
    });
  }

  /**
   * Escape HTML entities for Telegram parse_mode: 'HTML'
   */
  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Filter benign client errors that don't need admin notification
   */
  isBenignError(errorOrMessage) {
    const msg = typeof errorOrMessage === 'string'
      ? errorOrMessage
      : errorOrMessage?.message || String(errorOrMessage || '');

    return BENIGN_PATTERNS.some((pattern) => msg.includes(pattern));
  }

  /**
   * Generate an error fingerprint for deduplication
   */
  _getFingerprint(message, stack) {
    const firstStackLine = stack
      ? (String(stack).split('\n')[1] || '').replace(/:\d+(:\d+)?/g, '').trim()
      : '';
    return `${message}::${firstStackLine}`;
  }

  /**
   * Format the error message card in clean, readable HTML
   */
  formatErrorMessage(errorOrMessage, context = {}) {
    let message = '';
    let stack = '';

    if (errorOrMessage instanceof Error) {
      message = errorOrMessage.message || errorOrMessage.name || 'Unknown Error';
      stack = errorOrMessage.stack || '';
    } else if (typeof errorOrMessage === 'object' && errorOrMessage !== null) {
      message = errorOrMessage.message || JSON.stringify(errorOrMessage);
      stack = errorOrMessage.stack || '';
    } else {
      message = String(errorOrMessage || 'Unknown Error');
    }

    // Capture extra context (excluding internal winston/error fields)
    const extraMeta = {};
    for (const [k, v] of Object.entries(context || {})) {
      if (!['level', 'timestamp', 'message', 'stack', 'splat'].includes(k) && v !== undefined) {
        extraMeta[k] = v;
      }
    }

    const tashkentTime = new Date().toLocaleString('uz-UZ', {
      timeZone: 'Asia/Tashkent',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    let header = `🚨 <b>[QIZIL LOG / TIZIM XATOLIGI]</b>\n` +
      `📅 <b>Vaqt:</b> <code>${this.escapeHtml(tashkentTime)}</code> (Toshkent)\n` +
      `🏷 <b>Xabar:</b> <code>${this.escapeHtml(message.slice(0, 400))}</code>\n`;

    let metaBlock = '';
    if (Object.keys(extraMeta).length > 0) {
      try {
        const metaStr = JSON.stringify(extraMeta, null, 2);
        metaBlock = `\n📊 <b>Qo'shimcha ma'lumot:</b>\n<pre>${this.escapeHtml(metaStr.slice(0, 800))}</pre>\n`;
      } catch {
        // Ignore serialization issues
      }
    }

    let stackBlock = '';
    if (stack) {
      // Clean up local path prefix if redundant
      const cleanStack = String(stack).replace(/\r\n/g, '\n');
      stackBlock = `\n📍 <b>Stack Trace:</b>\n<pre>${this.escapeHtml(cleanStack)}</pre>`;
    }

    let fullMessage = `${header}${metaBlock}${stackBlock}`;

    // Hard ceiling enforcement for Telegram 4096 characters limit
    if (fullMessage.length > MAX_TELEGRAM_LEN) {
      const allowedStackLen = Math.max(100, MAX_TELEGRAM_LEN - (header.length + metaBlock.length + 150));
      const truncatedStack = stack.slice(0, allowedStackLen);
      stackBlock = `\n📍 <b>Stack Trace:</b>\n<pre>${this.escapeHtml(truncatedStack)}\n... (qisqartirildi)</pre>`;
      fullMessage = `${header}${metaBlock}${stackBlock}`;

      if (fullMessage.length > 4090) {
        fullMessage = fullMessage.slice(0, 4070) + '\n... (qisqartirildi)';
      }
    }

    return fullMessage;
  }

  /**
   * Core reporting method
   */
  async report(errorOrMessage, context = {}) {
    if (this._isReporting) return false; // Prevent recursive loops
    this._isReporting = true;

    try {
      if (this.isBenignError(errorOrMessage)) {
        return false;
      }

      let message = '';
      let stack = '';
      if (errorOrMessage instanceof Error) {
        message = errorOrMessage.message || errorOrMessage.name || 'Unknown Error';
        stack = errorOrMessage.stack || '';
      } else if (typeof errorOrMessage === 'object' && errorOrMessage !== null) {
        message = errorOrMessage.message || JSON.stringify(errorOrMessage);
        stack = errorOrMessage.stack || '';
      } else {
        message = String(errorOrMessage || 'Unknown Error');
      }

      // Deduplication & Anti-Flood check
      const fingerprint = this._getFingerprint(message, stack);
      const existing = this._dedupCache.get(fingerprint);

      if (existing) {
        existing.count++;
        existing.lastSeen = Date.now();
        return false; // Suppress duplicate alert within window
      }

      // Record first occurrence in deduplication cache
      const dedupEntry = {
        count: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        message,
        timeout: setTimeout(() => {
          this._handleDedupWindowExpiry(fingerprint);
        }, DEDUP_WINDOW_MS),
      };
      // Prevent timer from keeping the process alive during shutdown
      if (typeof dedupEntry.timeout.unref === 'function') {
        dedupEntry.timeout.unref();
      }
      this._dedupCache.set(fingerprint, dedupEntry);

      // Format and dispatch initial alert
      const formattedText = this.formatErrorMessage(errorOrMessage, context);
      return await this._dispatch(formattedText);
    } catch {
      // Must NEVER crash or throw from error reporter
      return false;
    } finally {
      this._isReporting = false;
    }
  }

  /**
   * Handle completion of deduplication window
   */
  async _handleDedupWindowExpiry(fingerprint) {
    const entry = this._dedupCache.get(fingerprint);
    if (!entry) return;
    this._dedupCache.delete(fingerprint);

    if (entry.count > 1) {
      try {
        const aggregatedText = `⚠️ <b>[AGREGATSIYA / TAKRORLANISH]</b>\n` +
          `Yuqoridagi xatolik so'nggi 60 soniya ichida yana <b>${entry.count - 1} marta</b> takrorlandi:\n` +
          `🏷 <code>${this.escapeHtml(entry.message.slice(0, 250))}</code>`;
        await this._dispatch(aggregatedText);
      } catch {
        // Safe silence
      }
    }
  }

  /**
   * Dispatch message via Telegram Bot API or mock
   */
  async _dispatch(text) {
    if (this._mockDispatcher) {
      return await this._mockDispatcher(text);
    }

    if (!SECOND_BOT || !ADMIN_ID) {
      return false;
    }

    return new Promise((resolve) => {
      try {
        const postData = JSON.stringify({
          chat_id: ADMIN_ID,
          text: text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });

        const options = {
          hostname: 'api.telegram.org',
          port: 443,
          path: `/bot${SECOND_BOT}/sendMessage`,
          method: 'POST',
          agent: this._httpsAgent,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 6000,
        };

        const req = https.request(options, (res) => {
          res.on('data', () => {});
          res.on('end', () => {
            resolve(res.statusCode >= 200 && res.statusCode < 300);
          });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });

        req.on('error', () => {
          resolve(false);
        });

        req.write(postData);
        req.end();
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * Clean cache for testing or maintenance
   */
  clearDedupCache() {
    for (const [, entry] of this._dedupCache.entries()) {
      if (entry.timeout) clearTimeout(entry.timeout);
    }
    this._dedupCache.clear();
  }

  /**
   * Test hook for mocking Telegram API dispatch
   */
  _setMockDispatcher(fn) {
    this._mockDispatcher = fn;
  }
}

const errorReporterInstance = new ErrorReporterService();
module.exports = errorReporterInstance;
