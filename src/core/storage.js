'use strict';
const fs = require('fs');
const path = require('path');

// Fayl yo'li to'g'rilandi: ../../data/users_stats.json
const usersStatsPath = path.join(__dirname, '../../data/users_stats.json');

function initStorage() {
  if (!fs.existsSync(usersStatsPath)) {
    fs.mkdirSync(path.dirname(usersStatsPath), { recursive: true });
    fs.writeFileSync(usersStatsPath, JSON.stringify({}));
  }
  return {};
}

function getUsersStats() {
  if (fs.existsSync(usersStatsPath)) {
    return JSON.parse(fs.readFileSync(usersStatsPath, 'utf8'));
  }
  return {};
}

function saveUsersStats(stats) {
  fs.writeFileSync(usersStatsPath, JSON.stringify(stats, null, 2));
}

module.exports = { initStorage, getUsersStats, saveUsersStats, usersStatsPath };