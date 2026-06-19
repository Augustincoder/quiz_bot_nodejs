'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_DIR, SUBJECTS } = require('../config/config');
const dbService = require('../services/dbService');
const botModule = require('./bot');
const storage = require('./storage');
const { setMemoryDb } = require('../keyboards/keyboards');
const { userNameCache } = require('./utils');
const logger = require('./logger');

/**
 * Initializes memory storage and loads all tests from Supabase and Local JSON.
 */
async function loadAllTests() {
  console.log("📦 Testlar yuklanmoqda...");
  
  // Initialize storage
  botModule.memoryDb = storage.initStorage();

  // 1. Load official tests from Supabase
  try {
    const dbTests = await dbService.loadAllOfficialTests();
    for (const [subj, tests] of Object.entries(dbTests)) {
      if (!botModule.memoryDb[subj]) botModule.memoryDb[subj] = {};
      Object.assign(botModule.memoryDb[subj], tests);
    }
    console.log("✅ Supabase rasmiy testlari yuklandi.");
  } catch (e) {
    console.warn("⚠️ Supabase testlari yuklanmadi:", e.message);
  }

  // 2. Load Local JSON tests
  try {
    for (const subj of Object.keys(SUBJECTS)) {
      let subjDir = path.join(DATA_DIR, subj);
      
      // Fallback check
      if (!fs.existsSync(subjDir) || !fs.readdirSync(subjDir).some((f) => f.endsWith(".json"))) {
        const altDir = path.join(process.cwd(), "src", "data", subj);
        if (fs.existsSync(altDir)) subjDir = altDir;
      }

      if (!fs.existsSync(subjDir)) continue;

      const files = fs.readdirSync(subjDir).filter((f) => f.endsWith(".json"));
      if (!files.length) continue;

      if (!botModule.memoryDb[subj]) botModule.memoryDb[subj] = {};

      for (const file of files) {
        const match = file.match(/^test_(\d+)\.json$/);
        if (!match) continue;

        const testId = Number(match[1]);
        const filePath = path.join(subjDir, file);
        try {
            const rawData = JSON.parse(fs.readFileSync(filePath, "utf8"));
            let questions = rawData;
            let range = `1-${Array.isArray(rawData) ? rawData.length : (rawData.questions?.length || 0)}`;
            let blockName = rawData.block_name || `Blok ${rawData.test_id || testId}`;

            if (rawData && typeof rawData === "object" && !Array.isArray(rawData)) {
              if (Array.isArray(rawData.questions)) questions = rawData.questions;
              if (typeof rawData.range === "string") range = rawData.range;
              if (typeof rawData.block_name === "string") blockName = rawData.block_name;
            }

            if (Array.isArray(questions)) {
              botModule.memoryDb[subj][testId] = {
                test_id: testId,
                range,
                block_name: blockName,
                questions,
              };
            }
        } catch (err) {
            logger.error(`Error parsing local test file: ${filePath}`, err);
        }
      }
    }
    console.log("✅ Local JSON testlar muvaffaqiyatli o'qildi.");
  } catch (e) {
    console.warn("⚠️ Local testlarni o'qishda xatolik:", e.message);
  }

  // Update keyboard references
  setMemoryDb(botModule.memoryDb);
  return botModule.memoryDb;
}

/**
 * Populates the username cache from the database.
 */
async function syncUserNames() {
  try {
    const allUsers = await dbService.getAllUsers();
    if (allUsers) {
      for (const user of allUsers) {
        const userName = user.name || user.full_name || user.first_name || "Talaba";
        userNameCache.set(user.telegram_id, userName);
      }
      console.log(`✅ ${allUsers.length} ta foydalanuvchi ismi xotiraga tiklandi.`);
    }
  } catch (e) {
    logger.error("User name sync error:", e);
  }
}

module.exports = {
  loadAllTests,
  syncUserNames
};
