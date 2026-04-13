'use strict';

const { Markup } = require('telegraf');

const ITEMS_PER_PAGE = 5;

// memory_db botdan import qilinadi (circular dep yechimi)
let _memoryDb = null;
function setMemoryDb(db) { _memoryDb = db; }

const blocksKbCache = new Map();

function getMainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📚 Rasmiy Testlar', 'official_tests')],
    [
      Markup.button.callback('📝 Test Yaratish', 'create_test'),
      Markup.button.callback('📂 Mening Testlarim', 'my_tests'),
    ],
    [
      Markup.button.callback('📊 Statistikam', 'show_stats'),
      Markup.button.callback('🏆 Reyting', 'show_leaderboard'),
    ],
    [Markup.button.callback('💬 Adminga Murojaat', 'contact_admin')],
  ]);
}

function invalidateBlocksCache(subjectKey = null) {
  if (subjectKey) {
    for (const key of blocksKbCache.keys()) {
      if (key.startsWith(subjectKey + ':')) blocksKbCache.delete(key);
    }
  } else {
    blocksKbCache.clear();
  }
}

function getBlocksKeyboard(subjectKey, page = 0) {
  const cacheKey = `${subjectKey}:${page}`;
  if (blocksKbCache.has(cacheKey)) return blocksKbCache.get(cacheKey);

  const db = _memoryDb || {};
  const subjectTests = db[subjectKey] || {};
  const testIds = Object.keys(subjectTests).map(Number).sort((a, b) => a - b);
  const totalPages = Math.max(1, Math.ceil(testIds.length / ITEMS_PER_PAGE));
  const current = testIds.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  const buttons = [];

  if (testIds.length === 0) {
    buttons.push([Markup.button.callback('📭 Bu fanda hozircha test yo\'q', 'ignore')]);
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
    const nav = [];
    if (page > 0) nav.push(Markup.button.callback('⬅️ Oldingi', `page_${subjectKey}_${page - 1}`));
    if (page < totalPages - 1) nav.push(Markup.button.callback('Keyingi ➡️', `page_${subjectKey}_${page + 1}`));
    if (nav.length) buttons.push(nav);
    buttons.push([Markup.button.callback('🎲 Aralash (Mock Exam)', `mock_${subjectKey}`)]);
  }
  buttons.push([Markup.button.callback('🔙 Fanlarga qaytish', 'official_tests')]);

  const kb = Markup.inlineKeyboard(buttons);
  blocksKbCache.set(cacheKey, kb);
  return kb;
}

function getTimetableKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        ['📅 Bugungi jadval', '🖼 Haftalik jadval'],
        ['🏢 Bo\'sh xonalar', '⚙️ Guruhni sozlash'],
        ['🔙 Asosiy menyu']
      ],
      resize_keyboard: true,
      is_persistent: true // Klaviaturani saqlab qoladi
    }
  };
}

module.exports = {
  getMainKeyboard,
  getBlocksKeyboard,
  invalidateBlocksCache,
  setMemoryDb,
  getTimetableKeyboard
};