'use strict';

const path = require('path');
const fs   = require('fs');

const BOT_TOKEN = '';

const DATA_DIR = path.join(__dirname, 'data');

const SUBJECTS = {
  korporativ: '🎓 Korporativ Boshqaruv',
  moliyaviy:  '💰 Moliyaviy Hisob',
  ekonometrika: '📈 Iqtisodiy tahlil',
};

const QUESTIONS_PER_TEST = 25;

// const SUPABASE_URL = '';
// const SUPABASE_KEY = '';
const ADMIN_ID = 2014973670;

// Data papkalarini yaratish
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
for (const key of Object.keys(SUBJECTS)) {
  const dir = path.join(DATA_DIR, key);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

module.exports = {
  BOT_TOKEN,
  DATA_DIR,
  SUBJECTS,
  QUESTIONS_PER_TEST,
  SUPABASE_URL,
  SUPABASE_KEY,
  ADMIN_ID,
};