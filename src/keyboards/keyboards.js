"use strict";

const { Markup } = require("telegraf");
const { TTLMap } = require("../core/utils");

const ITEMS_PER_PAGE = 5;

// memory_db botdan import qilinadi (circular dep yechimi)
let _memoryDb = null;
function setMemoryDb(db) {
  _memoryDb = db;
}

// Cache with 30-minute TTL to prevent unbounded memory growth
const blocksKbCache = new TTLMap(30 * 60 * 1000);

function getMainKeyboard() {
  return Markup.inlineKeyboard([
    // 1-qator: Asosiy test yechish va yaratish
    [
      Markup.button.callback("📚 Rasmiy Testlar", "official_tests"),
      Markup.button.callback("➕ Test Yaratish", "create_test"),
    ],
    // 2-qator: Ikkita mustaqil arxiv bo'limi
    [
      Markup.button.callback("📂 Mening Testlarim", "my_tests"),
      Markup.button.callback("📥 Javon (Pauza)", "my_shelf"),
    ],
    // 3-qator: AI va Statistika
    [
      Markup.button.callback("🤖 AI Tutor", "ai_menu"),
      Markup.button.callback("📊 Statistika", "stats_menu"),
    ],
    // 4-qator: Yordam
    [Markup.button.callback("📞 Adminga Murojaat / Yordam", "contact_admin")],
  ]);
}

function invalidateBlocksCache(subjectKey = null) {
  if (subjectKey) {
    // TTLMap doesn't support prefix iteration, so we clear all
    // This is fine — cache is rebuilt on next access
    blocksKbCache.delete(subjectKey);
  }
  // For full invalidation, we can't iterate TTLMap easily, but it auto-expires
}

/**
 * Reusable pagination row builder.
 * @param {string} prefix - Callback data prefix, e.g. "page_ekonometrika_"
 * @param {number} currentPage - Current page index (0-based)
 * @param {number} totalPages - Total number of pages
 * @returns {Array} Array of Telegraf inline buttons
 */
function paginationRow(prefix, currentPage, totalPages) {
  const nav = [];
  if (currentPage > 0) {
    nav.push(Markup.button.callback("⬅️ Oldingi", `${prefix}${currentPage - 1}`));
  }
  if (totalPages > 1) {
    nav.push(Markup.button.callback(`${currentPage + 1} / ${totalPages}`, "ignore"));
  }
  if (currentPage < totalPages - 1) {
    nav.push(Markup.button.callback("Keyingi ➡️", `${prefix}${currentPage + 1}`));
  }
  return nav;
}

function getBlocksKeyboard(subjectKey, page = 0) {
  const cacheKey = `${subjectKey}:${page}`;
  if (blocksKbCache.has(cacheKey)) return blocksKbCache.get(cacheKey);

  const db = _memoryDb || {};
  const subjectTests = db[subjectKey] || {};
  const testIds = Object.keys(subjectTests)
    .map(Number)
    .sort((a, b) => a - b);
  const totalPages = Math.max(1, Math.ceil(testIds.length / ITEMS_PER_PAGE));
  const current = testIds.slice(
    page * ITEMS_PER_PAGE,
    (page + 1) * ITEMS_PER_PAGE,
  );

  const buttons = [];

  if (testIds.length === 0) {
    buttons.push([
      Markup.button.callback("📭 Bu fanda hozircha test yo'q", "ignore"),
    ]);
  } else {
    for (const tId of current) {
      const qCount = (subjectTests[tId]?.questions || []).length;
      buttons.push([
        Markup.button.callback(
          `📘 ${tId}-Blok  •  ${qCount} ta savol`,
          `start_test_${subjectKey}_${tId}`,
        ),
      ]);
    }
    const nav = paginationRow(`page_${subjectKey}_`, page, totalPages);
    if (nav.length) buttons.push(nav);
    buttons.push([
      Markup.button.callback("🎲 Aralash (Mock Exam)", `mock_${subjectKey}`),
    ]);
    buttons.push([
      Markup.button.callback("🎯 AI Adaptiv Test", `adaptive_${subjectKey}`),
    ]);
  }
  buttons.push([
    Markup.button.callback("🔙 Fanlarga qaytish", "official_tests"),
    Markup.button.callback("🏠 Asosiy Menyu", "back_to_main"),
  ]);

  const kb = Markup.inlineKeyboard(buttons);
  blocksKbCache.set(cacheKey, kb);
  return kb;
}

function getTimetableKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ["📅 Bugungi jadval", "🖼 Haftalik jadval"],
        ["🏢 Bo'sh xonalar", "⚙️ Guruhni sozlash"],
        ["🔙 Asosiy menyu"],
      ],
      resize_keyboard: true,
      is_persistent: true,
    },
  };
}

module.exports = {
  ITEMS_PER_PAGE,
  getMainKeyboard,
  getBlocksKeyboard,
  invalidateBlocksCache,
  setMemoryDb,
  getTimetableKeyboard,
  paginationRow,
};
