'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../core/logger');
const { TTLMap, getLevenshteinDistance } = require('../../core/utils');

const CYRILLIC_LOOKALIKES = {
  '\u0410': 'A', '\u0430': 'A', // А, а
  '\u0412': 'B', '\u0432': 'B', // В, в
  '\u0421': 'C', '\u0441': 'C', // С, с
  '\u0415': 'E', '\u0435': 'E', // Е, е
  '\u041D': 'H', '\u043D': 'H', // Н, н
  '\u041A': 'K', '\u043A': 'K', // К, к
  '\u041C': 'M', '\u043C': 'M', // М, м
  '\u041E': 'O', '\u043E': 'O', // О, о
  '\u0420': 'P', '\u0440': 'P', // Р, р
  '\u0422': 'T', '\u0442': 'T', // Т, т
  '\u0425': 'X', '\u0445': 'X', // Х, х
  '\u0423': 'U', '\u0443': 'U', // У, у
  '\u0406': 'I', '\u0456': 'I', // І, і
};

/**
 * Transliterates Cyrillic lookalikes into Latin equivalents
 */
function transliterateCyrillic(str) {
  if (!str) return '';
  return String(str).replace(/[\u0400-\u04FF]/g, (ch) => CYRILLIC_LOOKALIKES[ch] || ch);
}

/**
 * Normalizes a class/group string for fast O(1) hash lookups.
 * Transliterates Cyrillic lookalikes, trims whitespace, strips punctuation/dashes/slashes.
 * e.g. "BHA-51k/24" -> "BHA51K24", "MMТ-20/23" -> "MMT2023", "BHA_51K" -> "BHA51K"
 */
function normalizeGroupName(str) {
  if (!str) return '';
  const transliterated = transliterateCyrillic(String(str));
  const clean = transliterated.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return clean.replace(/^([A-Z]+\d+)([IRK])(\d{2})$/, '$1$3$2');
}

/**
 * Extracts base group name without graduation year suffix
 * e.g. "BHA-56/24i" -> "BHA-56i", "BHA-51k/24" -> "BHA-51k", "BHA-51/24" -> "BHA-51"
 */
function extractGroupBase(str) {
  if (!str) return '';
  return String(str).replace(/\/(\d{2})([a-z]?)$/i, (m, yr, track) => track || '');
}

// Global Canonical Group Registry: maps normalized & base variants to official canonical names
const canonicalExact = new Map(); // norm -> canonical (e.g. "BHA51K24" -> "BHA-51k/24")
const canonicalBase = new Map();  // baseNorm -> canonical (e.g. "BHA51K" -> "BHA-51k/24")

function registerCanonicalGroup(groupName) {
  if (!groupName || typeof groupName !== 'string') return;
  const clean = groupName.trim();
  if (!clean || clean === '-' || clean === '--' || clean.includes('FAKULTET') || clean.includes('KURS')) return;

  const norm = normalizeGroupName(clean);
  if (norm) {
    if (!canonicalExact.has(norm)) canonicalExact.set(norm, clean);

    const base = extractGroupBase(clean);
    const baseNorm = normalizeGroupName(base);
    if (baseNorm && !canonicalBase.has(baseNorm)) {
      canonicalBase.set(baseNorm, clean);
    }
  }
}

// Pre-seed canonical registry from groups.json if available
try {
  const groupsJsonPath = path.resolve(__dirname, '../../data/groups.json');
  if (fs.existsSync(groupsJsonPath)) {
    const rawArr = JSON.parse(fs.readFileSync(groupsJsonPath, 'utf8'));
    for (const g of rawArr) {
      registerCanonicalGroup(g);
    }
  }
} catch (e) {
  logger.debug('Failed to pre-seed groups from groups.json:', { error: e.message });
}

/**
 * Resolves ANY group input (e.g. "BHA_51K", "bha-51k", "bha 51k", "BHA-51k/24", "MMT-20")
 * to its exact official CANONICAL original appearance ("asli ko'rinishi", e.g. "BHA-51k/24").
 * Returns null if not recognized.
 */
function getCanonicalGroupName(input) {
  if (!input) return null;
  const clean = input.toString().trim().replace(/^[*#]/, '');
  const norm = normalizeGroupName(clean);
  if (!norm) return null;

  // 1. Exact normalized match (e.g. "BHA51K24", "BHA-51k/24")
  if (canonicalExact.has(norm)) {
    return canonicalExact.get(norm);
  }

  // 2. Base match without year suffix (e.g. "BHA_51K", "BHA-51k", "bha 51k")
  if (canonicalBase.has(norm)) {
    return canonicalBase.get(norm);
  }
  const base = extractGroupBase(clean);
  const baseNorm = normalizeGroupName(base);
  if (baseNorm && canonicalBase.has(baseNorm)) {
    return canonicalBase.get(baseNorm);
  }

  // 3. Fallback: prefix match among valid groups (only if norm is at least 4 chars)
  if (norm.length >= 4) {
    for (const [n, canonical] of canonicalExact.entries()) {
      if (n.startsWith(norm)) {
        return canonical;
      }
    }
  }

  // 3b. Suffix match on base names: e.g. "56i" -> matches "BHA56I" -> "BHA-56/24i"
  if (norm.length >= 2 && /\d/.test(norm)) {
    const suffixMatches = [];
    for (const [baseNorm, canonical] of canonicalBase.entries()) {
      if (baseNorm.endsWith(norm)) {
        suffixMatches.push(canonical);
      }
    }
    if (suffixMatches.length === 1) {
      return suffixMatches[0];
    }
  }

  const normDigits = (norm.match(/\d+/g) || []).join('');

  // 4. Fallback: fuzzy typo match (Levenshtein distance <= 2)
  let best = null;
  let minDist = Infinity;
  for (const [n, canonical] of canonicalExact.entries()) {
    if (Math.abs(n.length - norm.length) > 1) continue;
    // Guard: digits must match if present to prevent cross-group number matching (e.g., 56 vs 50)
    const nDigits = (n.match(/\d+/g) || []).join('');
    if (normDigits && nDigits && normDigits !== nDigits) continue;

    const d = getLevenshteinDistance(norm, n);
    if (d < minDist) {
      minDist = d;
      best = canonical;
    }
  }
  if (minDist <= 2) return best;

  return null;
}

// Bounded L1 Room Location Cache
const roomLocationCache = new TTLMap(24 * 60 * 60 * 1000, 1000);

/**
 * Parses building and floor information from classroom code
 */
function parseRoomLocation(xona) {
  let clean = (xona || '').trim();
  if (!clean || clean === '?' || clean === '-' || clean === '--' || clean === '---') return null;
  if (/online/i.test(clean)) return null;

  clean = transliterateCyrillic(clean);

  const cached = roomLocationCache.get(clean);
  if (cached !== undefined) return cached;

  let res = null;

  const bochkaMatch = clean.match(/^(\d+)-bochka/i);
  if (bochkaMatch) {
    const qMatch = clean.match(/(\d)\d{2}/);
    res = { bino: `${bochkaMatch[1]}-bochka`, qavat: `${qMatch ? qMatch[1] : '1'}-qavat` };
  } else {
    const binoPrefixMatch = clean.match(/^(\d+)-bino/i);
    if (binoPrefixMatch) {
      const qMatch = clean.match(/(\d)(?:\d{2}|-\d+)/);
      res = { bino: `${binoPrefixMatch[1]}-bino`, qavat: `${qMatch ? qMatch[1] : '1'}-qavat` };
    } else {
      const slashMatch = clean.match(/^(\d+)\/+(.*)/);
      if (slashMatch) {
        const bNum = slashMatch[1];
        const bino = bNum === '1' ? '4-bino' : `${bNum}-bino`;
        const rest = slashMatch[2];
        const qMatch = rest.match(/(\d)(?:\d{2}|-\d+)/) || rest.match(/(\d)/);
        const qNum = qMatch ? qMatch[1] : '1';
        res = { bino, qavat: `${qNum || '1'}-qavat` };
      } else {
        const roomLetterMatch = clean.match(/^(\d)(\d{2})[-\s]*([A-Za-z])$/);
        if (roomLetterMatch) {
          res = { bino: `${roomLetterMatch[3].toUpperCase()}-bino`, qavat: `${roomLetterMatch[1]}-qavat` };
        } else {
          const dashMatch = clean.match(/^(\d+)-(.*)/);
          if (dashMatch) {
            const bNum = dashMatch[1];
            const rest = dashMatch[2];
            const qMatch = rest.match(/(\d)(?:\d{2}|-\d+)/) || rest.match(/(\d)/);
            const qNum = qMatch ? qMatch[1] : '1';
            res = { bino: `${bNum}-bino`, qavat: `${qNum || '1'}-qavat` };
          } else {
            const letterDashMatch = clean.match(/^([A-Za-z])-(\d)(?:\d{2}|-\d+)/);
            if (letterDashMatch) {
              res = { bino: `${letterDashMatch[1].toUpperCase()}-bino`, qavat: `${letterDashMatch[2]}-qavat` };
            } else {
              const letterBinoMatch = clean.match(/^([A-Za-z])\s*bino\s*(\d)(?:\d{2}|-\d+)/i);
              if (letterBinoMatch) {
                res = { bino: `${letterBinoMatch[1].toUpperCase()}-bino`, qavat: `${letterBinoMatch[2]}-qavat` };
              } else {
                const korpusMatch = clean.match(/^(\d+)\s*korpus\s*(\d)(\d{2})/i);
                if (korpusMatch) {
                  const bNum = korpusMatch[1] === '1' ? '4-bino' : `${korpusMatch[1]}-bino`;
                  res = { bino: bNum, qavat: `${korpusMatch[2]}-qavat` };
                } else if (/^litsey/i.test(clean)) {
                  const qMatch = clean.match(/(\d)[A-Za-z]/);
                  res = { bino: 'Litsey', qavat: `${qMatch ? qMatch[1] : '1'}-qavat` };
                } else if (/rektorat/i.test(clean) || /1[24]etaj/i.test(clean) || /xitoy\s*tili/i.test(clean)) {
                  const qMatch = clean.match(/(\d+)/);
                  res = { bino: 'Rektorat', qavat: `${qMatch ? qMatch[1] : '1'}-qavat` };
                } else if (/sport\s*zal/i.test(clean)) {
                  res = { bino: 'Sportzal', qavat: '1-qavat' };
                } else if (/asosiy/i.test(clean)) {
                  res = { bino: 'Asosiy bino', qavat: `${clean.charAt(0) || '1'}-qavat` };
                }
              }
            }
          }
        }
      }
    }
  }

  roomLocationCache.set(clean, res);
  return res;
}

function sweepCaches() {
  try {
    roomLocationCache.sweep();
  } catch {}
}

module.exports = {
  CYRILLIC_LOOKALIKES,
  transliterateCyrillic,
  normalizeGroupName,
  extractGroupBase,
  registerCanonicalGroup,
  getCanonicalGroupName,
  parseRoomLocation,
  roomLocationCache,
  sweepCaches,
};
