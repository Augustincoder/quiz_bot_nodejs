'use strict';
/* global setInterval, clearInterval */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Telegraf } = require('telegraf');
const { BOT_TOKEN, TIMETABLE_STORAGE_CHANNEL_ID } = require('../src/config/config');
const timetableCdnService = require('../src/services/timetableCdnService');
const edupageService = require('../src/services/edupageService');

async function run() {
  console.log('====================================================');
  console.log('🚀 TSUE TIMETABLE CDN PRE-WARMING WORKER');
  console.log('====================================================');

  if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN is missing!');
    process.exit(1);
  }

  if (!TIMETABLE_STORAGE_CHANNEL_ID) {
    console.error('❌ TIMETABLE_STORAGE_CHANNEL_ID (or CHANNEL_ID) is missing in .env!');
    console.log('ℹ️ Please set CHANNEL_ID=-100xxxxxxxxxx in your .env file or environment variables.');
    process.exit(1);
  }

  console.log(`📡 Storage Channel ID: ${TIMETABLE_STORAGE_CHANNEL_ID}`);
  const bot = new Telegraf(BOT_TOKEN);

  const activeOnly = process.argv.includes('--active-only');
  console.log(`⚙️ Mode: ${activeOnly ? 'Active Enrolled Groups Only' : 'Full University Pre-warm'}`);

  console.log('⏳ Pre-warming EduPage raw database...');
  await edupageService.warmUpCache();

  console.log('▶️ Launching sequential worker with 2.5s pacing (concurrency=1)...');
  const result = await timetableCdnService.prewarmAllTimetables(bot.telegram, {
    activeOnly,
    delayMs: 2500,
  });

  if (result.status === 'started') {
    // Monitor progress
    const interval = setInterval(() => {
      const st = timetableCdnService.getWorkerStatus();
      if (!st.isRunning) {
        clearInterval(interval);
        console.log('\n✅ Pre-warm completed!');
        console.log(`📊 Stats: Generated: ${st.generated} | Skipped: ${st.skipped} | Failed: ${st.failed} | Total: ${st.processed}/${st.total}`);
        process.exit(0);
      } else {
        const percent = st.total > 0 ? ((st.processed / st.total) * 100).toFixed(1) : 0;
        process.stdout.write(`\r⏳ Progress: ${st.processed}/${st.total} (${percent}%) | Generated: ${st.generated} | Skipped: ${st.skipped} | Current: ${st.currentGroup || 'N/A'} [${st.currentTheme || 'N/A'}] `);
      }
    }, 3000);
  } else {
    console.log('Worker result:', result);
  }
}

function handleShutdown() {
  console.log('\n🛑 Stopping pre-warm worker gracefully...');
  timetableCdnService.stopPrewarmWorker();
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

run().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
