'use strict';
const fs = require('fs').promises; // Asinxron metodlar
const fsSync = require('fs'); // Faqat ilk marta papka ochish uchun
const path = require('path');

const usersStatsPath = path.join(__dirname, '../../data/users_stats.json');

// Bu funksiya bot ishga tushganda 1 marta ishlagani uchun Sync qolsa bo'ladi
function initStorage() {
  if (!fsSync.existsSync(usersStatsPath)) {
    fsSync.mkdirSync(path.dirname(usersStatsPath), { recursive: true });
    fsSync.writeFileSync(usersStatsPath, JSON.stringify({}));
  }
  return {};
}

// Asinxron o'qish - Event Loop'ni bloklamaydi
async function getUsersStats() {
  try {
    const data = await fs.readFile(usersStatsPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Statistika o\'qishda xatolik:', error);
    return {};
  }
}

// Atomic Asinxron yozish - Xavfsiz usul
async function saveUsersStats(stats) {
  try {
    const tempPath = `${usersStatsPath}.tmp`;
    // 1. Avval vaqtinchalik faylga yozamiz
    await fs.writeFile(tempPath, JSON.stringify(stats, null, 2));
    // 2. Keyin asli bilan almashtiramiz (agar shu jarayonda tok o'chsa ham, asosiy fayl buzilmaydi)
    await fs.rename(tempPath, usersStatsPath);
  } catch (error) {
    console.error('Statistika yozishda xatolik:', error);
  }
}

module.exports = { initStorage, getUsersStats, saveUsersStats, usersStatsPath };