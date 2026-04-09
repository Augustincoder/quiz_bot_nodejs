'use strict';

const path = require('path');
const fs   = require('fs');

// Load environment variables from .env (if present)
// Note: `.env` is gitignored; use `.env.example` as a template.
require('dotenv').config({ path: path.join(__dirname, '.env') });

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

const DATA_DIR = path.join(__dirname, 'data');

const SUBJECTS = {
  korporativ: '🎓 Korporativ Boshqaruv',
  moliyaviy:  '💰 Moliyaviy Hisob',
  ekonometrika: '📈 Iqtisodiy tahlil',
};

const QUESTIONS_PER_TEST = 25;

const QUESTIONS_PER_TEST_ENV = envInt('QUESTIONS_PER_TEST', QUESTIONS_PER_TEST);

const SUPABASE_URL = env('SUPABASE_URL', '');
const SUPABASE_KEY = env('SUPABASE_KEY', '');
const ADMIN_ID = envInt('ADMIN_ID', 2014973670);

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
  SUPABASE_URL,
  SUPABASE_KEY,
  ADMIN_ID,
};