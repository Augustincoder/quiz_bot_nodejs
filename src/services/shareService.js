'use strict';

const crypto = require('crypto');

// Secret key derivation (stable across restarts, overridable via SHARE_LINK_SECRET)
const RAW_SECRET = process.env.SHARE_LINK_SECRET || process.env.BOT_TOKEN || 'quiz_bot_share_secret_salt_v1';
const SECRET_KEY = crypto.createHash('sha256').update(RAW_SECRET).digest();

/**
 * Encodes a test or subject ID into a secure, deterministic, tamper-proof token using AES-256-GCM.
 * 
 * Format packed: [12-byte IV] + [16-byte Auth Tag] + [Ciphertext] -> base64url (~43-47 chars).
 * Fits well within Telegram's 64-character limit for /start parameters.
 *
 * @param {'t'|'s'} type - 't' for test block, 's' for subject marathon
 * @param {string|number} id - The database ID of the test or subject
 * @returns {string} URL-safe base64url encoded token
 */
function encodeShareToken(type, id) {
  if (!type || id === undefined || id === null) {
    throw new Error('type and id are required to encode share token');
  }

  const strId = String(id).trim();
  // Deterministic 12-byte IV derived via HMAC-SHA256 from (key, 'iv:' + type + ':' + strId)
  // Ensures the same entity always gets the exact same link, but completely different from others
  const iv = crypto.createHmac('sha256', SECRET_KEY)
    .update(`iv:${type}:${strId}`)
    .digest()
    .subarray(0, 12);

  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const plaintext = Buffer.from(`${type}:${strId}`, 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack IV (12) + Tag (16) + Encrypted Payload
  const packed = Buffer.concat([iv, tag, encrypted]);
  return packed.toString('base64url');
}

/**
 * Decodes and cryptographically authenticates a share token.
 * 
 * @param {string} token - The base64url encoded token
 * @returns {{ type: 't'|'s', id: string } | null} Decoded entity info or null if invalid/tampered
 */
function decodeShareToken(token) {
  if (!token || typeof token !== 'string') return null;

  try {
    const packed = Buffer.from(token, 'base64url');
    // Minimum length: 12 (IV) + 16 (Tag) + 3 (e.g., 't:1') = 31 bytes
    if (packed.length < 31) return null;

    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const encrypted = packed.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    const str = decrypted.toString('utf8');

    const colonIdx = str.indexOf(':');
    if (colonIdx === -1) return null;

    const type = str.slice(0, colonIdx);
    const id = str.slice(colonIdx + 1);

    if (type !== 't' && type !== 's') return null;
    if (!id || !/^\d+$/.test(id)) return null;

    return { type, id };
  } catch {
    // Auth tag mismatch, invalid padding, or corrupted token
    return null;
  }
}

/**
 * Builds a complete Telegram share link (for private chat start or group startgroup).
 * 
 * @param {string} botUsername - Telegram bot username (without @)
 * @param {'t'|'s'} type - 't' for test block, 's' for subject marathon
 * @param {string|number} id - Database ID
 * @param {boolean} isGroup - Whether this is a group link (startgroup=) or private (start=)
 * @returns {string} Full https://t.me/... URL
 */
function buildShareLink(botUsername, type, id, isGroup = false) {
  const token = encodeShareToken(type, id);
  const action = isGroup ? 'startgroup' : 'start';
  return `https://t.me/${botUsername}?${action}=${type}_${token}`;
}

/**
 * Resolves an incoming deep link parameter from Telegram.
 * Supports:
 * - New secure tokens (e.g. t_pnsiWPME..., s_2a1W87...)
 * - Legacy numeric IDs (e.g. t_42, s_5) for full backward compatibility
 * - Official test parameters (e.g. offt_Matematika_1, offs_Fizika)
 *
 * @param {string} rawParam - Raw parameter string from /start or /startgroup
 * @returns {{ type: 't'|'s'|'offt'|'offs'|null, id: string|null, isLegacy: boolean, isInvalid: boolean }}
 */
function resolveShareParam(rawParam) {
  if (!rawParam || typeof rawParam !== 'string') {
    return { type: null, id: null, isLegacy: false, isInvalid: true };
  }

  // Strip @botusername if Telegram appended it in a group chat
  const param = rawParam.split('@')[0].trim();

  // 1. Single test block
  if (param.startsWith('t_')) {
    const raw = param.slice(2);
    // Legacy support: purely numeric ID (e.g. t_105)
    if (/^\d+$/.test(raw)) {
      return { type: 't', id: raw, isLegacy: true, isInvalid: false };
    }

    // New secure cryptographic token
    const decoded = decodeShareToken(raw);
    if (decoded && (decoded.type === 't' || decoded.type === 's')) {
      return { type: 't', id: decoded.id, isLegacy: false, isInvalid: false };
    }

    return { type: 't', id: null, isLegacy: false, isInvalid: true };
  }

  // 2. Subject marathon
  if (param.startsWith('s_')) {
    const raw = param.slice(2);
    // Legacy support: purely numeric ID (e.g. s_7)
    if (/^\d+$/.test(raw)) {
      return { type: 's', id: raw, isLegacy: true, isInvalid: false };
    }

    // New secure cryptographic token
    const decoded = decodeShareToken(raw);
    if (decoded && (decoded.type === 's' || decoded.type === 't')) {
      return { type: 's', id: decoded.id, isLegacy: false, isInvalid: false };
    }

    return { type: 's', id: null, isLegacy: false, isInvalid: true };
  }

  // 3. Official tests / subjects
  if (param.startsWith('offt_')) {
    return { type: 'offt', id: param.replace('offt_', ''), isLegacy: true, isInvalid: false };
  }
  if (param.startsWith('offs_')) {
    return { type: 'offs', id: param.replace('offs_', ''), isLegacy: true, isInvalid: false };
  }

  return { type: null, id: null, isLegacy: false, isInvalid: true };
}

module.exports = {
  encodeShareToken,
  decodeShareToken,
  buildShareLink,
  resolveShareParam,
};
