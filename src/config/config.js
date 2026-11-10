'use strict';

const path = require('path');
const fs   = require('fs');

// Load environment variables from .env (if present)
// Note: `.env` is gitignored; use `.env.example` as a template.
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function env(name, fallback = undefined) {
  const v = process.env[name];
  return (v === undefined || v === null || v === '') ? fallback : v;
}

function envInt(name, fallback) {
  const raw = env(name, fallback);
  const n = parseInt(String(raw), 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for ${name}: "${raw}"`);
  }
  return n;
}

const BOT_TOKEN = env('BOT_TOKEN', '');

const DATA_DIR = path.join(__dirname, '../../data');

const SUBJECTS = {
  korporativ: '🎓 Korporativ Boshqaruv',
  moliyaviy:  '💰 Moliyaviy Hisob',
  ekonometrika: '📈 Iqtisodiy tahlil',
};

const QUESTIONS_PER_TEST = 25;

const QUESTIONS_PER_TEST_ENV = envInt('QUESTIONS_PER_TEST', QUESTIONS_PER_TEST);

const DATABASE_URL = env('DATABASE_URL', 'postgresql://_24c4d3f3b7552851:_43bd4eabf61d7974c2374fef2c8f3b@primary.quiz-bot-database--hqhlj8nqhyp9.addon.code.run:5432/_62d18dea4e8b?sslmode=require&uselibpqcompat=true');
const rawAdminId = env('ADMIN_IDS') || env('ADMIN_ID', '');
const ADMIN_IDS = rawAdminId
  ? String(rawAdminId)
      .split(',')
      .map((id) => parseInt(id.trim(), 10))
      .filter((id) => !Number.isNaN(id) && id > 0)
  : [];
const ADMIN_ID = ADMIN_IDS[0] || null;
const SECOND_BOT = env('SECOND_BOT', '');
const CARD_NUMBER = env('CARD_NUMBER', '');
const GEMINI_API_KEY = env('GEMINI_API_KEY', '');
const TIMETABLE_STORAGE_CHANNEL_ID = env('TIMETABLE_STORAGE_CHANNEL_ID') ||
  env('CHANNEL_ID') ||
  env('STORAGE_CHANNEL_ID') ||
  env('TIMETABLE_CHANNEL_ID', '');
const APP_URL = env('APP_URL') ||
  env('WEBAPP_URL') ||
  env('SERVER_URL') ||
  env('BASE_URL') ||
  env('NF_PUBLIC_URL') ||
  'https://p01--quiz-bot-nodejs--hqhlj8nqhyp9.code.run';

if (!BOT_TOKEN) {
  throw new Error(
    'BOT_TOKEN is missing. Create a .env file (see .env.example) and set BOT_TOKEN=...'
  );
}

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
  QUESTIONS_PER_TEST: QUESTIONS_PER_TEST_ENV,
  DATABASE_URL,
  ADMIN_ID,
  ADMIN_IDS,
  SECOND_BOT,
  CARD_NUMBER,
  GEMINI_API_KEY,
  TIMETABLE_STORAGE_CHANNEL_ID,
  APP_URL,
};