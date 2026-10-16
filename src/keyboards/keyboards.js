"use strict";

const { Markup } = require("telegraf");
const { TTLMap, safeCallbackData } = require("../core/utils");

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
    // 4-qator: Dars Jadvali
    [Markup.button.callback("📅 Dars Jadvali", "schedule_menu")],
    // 5-qator: Yordam
    [Markup.button.callback("📞 Adminga Murojaat / Yordam", "contact_admin")],
  ]);
}

function invalidateBlocksCache(subjectKey = null) {
  if (subjectKey) {
    const prefix = `${subjectKey}:`;
    const toDelete = [];
    for (const key of blocksKbCache.keys()) {
      if (typeof key === 'string' && key.startsWith(prefix)) {
        toDelete.push(key);
      }
    }
    toDelete.forEach((k) => blocksKbCache.delete(k));
  } else {
    blocksKbCache.clear();
  }
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
    nav.push(Markup.button.callback("⬅️ Oldingi", safeCallbackData(`${prefix}${currentPage - 1}`)));
  }
  if (totalPages > 1) {
    nav.push(Markup.button.callback(`${currentPage + 1} / ${totalPages}`, "ignore"));
  }
  if (currentPage < totalPages - 1) {
    nav.push(Markup.button.callback("Keyingi ➡️", safeCallbackData(`${prefix}${currentPage + 1}`)));
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
          safeCallbackData(`start_test_${subjectKey}_${tId}`),
        ),
      ]);
    }
    const nav = paginationRow(`page_${subjectKey}_`, page, totalPages);
    if (nav.length) buttons.push(nav);
    buttons.push([
      Markup.button.callback("🎲 Aralash (Mock Exam)", safeCallbackData(`mock_${subjectKey}`)),
    ]);
    buttons.push([
      Markup.button.callback("🎯 AI Adaptiv Test", safeCallbackData(`adaptive_${subjectKey}`)),
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
      one_time_keyboard: false,
    },
  };
}

function getTimetableInlineKeyboard(className = null) {
  const rows = [
    [
      Markup.button.callback("📅 Bugungi jadval", "schedule_today"),
      Markup.button.callback("🖼 Haftalik jadval", "schedule_week"),
    ],
    [
      Markup.button.callback("🏢 Bo'sh xonalar", "schedule_rooms"),
      Markup.button.callback("🔔 Xabarnomalar", "schedule_notify_settings"),
    ],
    [
      Markup.button.callback(className ? "✏️ Guruhni o'zgartirish" : "⚙️ Guruhni kiritish", "schedule_settings"),
      Markup.button.callback("🏠 Asosiy Menyu", "back_to_main"),
    ],
  ];

  return Markup.inlineKeyboard(rows);
}

/**
 * Builds Smart Schedule v2 notification settings interactive inline keyboard
 */
function getScheduleV2SettingsKeyboard(prefs) {
  const mode = prefs.notify_mode || 'shift_aware';
  const offset = Number(prefs.offset_minutes) || 60;
  const bell = prefs.pre_class_5min_bell !== false;
  const bld = prefs.building_change_alert !== false;

  return Markup.inlineKeyboard([
    // Row 1: Shift-aware auto mode (recommended)
    [Markup.button.callback(
      `${mode === 'shift_aware' ? '🔘' : '⚪️'} 🌗 Smenaga mos (Avto)`,
      'v2_mode_shift'
    )],
    // Row 2: Offset before first lesson
    [
      Markup.button.callback(`${mode === 'offset_before_first' && offset === 15 ? '🔘' : '⚪️'} 15 daq`, 'v2_offset_15'),
      Markup.button.callback(`${mode === 'offset_before_first' && offset === 30 ? '🔘' : '⚪️'} 30 daq`, 'v2_offset_30'),
      Markup.button.callback(`${mode === 'offset_before_first' && offset === 60 ? '🔘' : '⚪️'} 1 soat`, 'v2_offset_60'),
      Markup.button.callback(`${mode === 'offset_before_first' && offset === 120 ? '🔘' : '⚪️'} 2 soat`, 'v2_offset_120'),
    ],
    // Row 3: Custom HH:mm or Standard
    [
      Markup.button.callback(`${mode === 'custom_time' ? '🔘' : '⚪️'} 🎯 Aniq vaqt (${prefs.custom_morning_time || '07:00'})`, 'v2_mode_custom'),
      Markup.button.callback(`${mode === 'standard_both' ? '🔘' : '⚪️'} 🌅+🌙 Standart`, 'v2_mode_standard'),
    ],
    // Row 4: 5-minute pre-end bell & building transition alerts
    [
      Markup.button.callback(`🔔 5 daq qo'ng'iroq: ${bell ? 'YOQILGAN ✅' : 'O\'CHIQ ❌'}`, 'v2_toggle_bell'),
    ],
    [
      Markup.button.callback(`🏢 Bino almashinuvi: ${bld ? 'YOQILGAN ✅' : 'O\'CHIQ ❌'}`, 'v2_toggle_bld'),
    ],
    // Row 5: Disable / Back
    [
      Markup.button.callback(`${mode === 'disabled' ? '🔘' : '⚪️'} 🔕 O'chirish`, 'v2_mode_disabled'),
      Markup.button.callback('⬅️ Orqaga', 'schedule_menu'),
    ],
  ]);
}

/**
 * Builds note interactive reminder actions keyboard
 */
function getNoteActionsKeyboard(noteId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Bajarildi', safeCallbackData(`nd:${noteId}`)),
      Markup.button.callback('⏳ Keyingi darsga surish', safeCallbackData(`nsz:${noteId}`)),
    ],
  ]);
}

module.exports = {
  ITEMS_PER_PAGE,
  getMainKeyboard,
  getBlocksKeyboard,
  invalidateBlocksCache,
  setMemoryDb,
  getTimetableKeyboard,
  getTimetableInlineKeyboard,
  getScheduleV2SettingsKeyboard,
  getNoteActionsKeyboard,
  paginationRow,
};


