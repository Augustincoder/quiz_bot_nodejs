'use strict';
/* global gc */

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Telegraf } = require('telegraf');
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(1);

const edupageService = require('../src/services/edupageService');
const imageService = require('../src/services/imageService');
const timetableCdnService = require('../src/services/timetableCdnService');
const dbService = require('../src/services/dbService');
const { escapeHtml } = require('../src/core/utils');

// Parse CLI flags
const args = process.argv.slice(2);
function getArgVal(flag, def = null) {
  const hit = args.find(a => a.startsWith(`--${flag}=`));
  if (hit) return hit.split('=')[1].trim();
  return def;
}

const targetGroup = getArgVal('group', null);
const targetTheme = getArgVal('theme', 'all'); // 'dark' | 'light' | 'vibrant' | 'all'
const delayMs = parseInt(getArgVal('delay', '2200'), 10);
const limitCount = parseInt(getArgVal('limit', '0'), 10);
const forceUpload = args.includes('--force');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = process.env.TIMETABLE_STORAGE_CHANNEL_ID || process.env.CHANNEL_ID;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatDuration(ms) {
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / (1000 * 60)) % 60;
  const hrs = Math.floor(ms / (1000 * 60 * 60));
  if (hrs > 0) return `${hrs}h ${min}m ${sec}s`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

function getMemoryUsageMB() {
  const mem = process.memoryUsage();
  return {
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
  };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   TSUE TIMETABLE CDN — LOCAL BULK UPLOAD ENGINE            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (!BOT_TOKEN) {
    console.error('❌ Xatolik: .env faylida BOT_TOKEN topilmadi!');
    console.log('ℹ️ .env fayliga BOT_TOKEN=xxxxxxx ni kiriting.');
    process.exit(1);
  }

  if (!CHANNEL_ID) {
    console.error('❌ Xatolik: .env faylida TIMETABLE_STORAGE_CHANNEL_ID yoki CHANNEL_ID topilmadi!');
    console.log('ℹ️ .env fayliga TIMETABLE_STORAGE_CHANNEL_ID=-100xxxxxxxxxx ni kiriting.');
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.warn('⚠️ DIQQAT: SUPABASE_URL yoki SUPABASE_KEY topilmadi!');
    console.warn('   Yuklangan rasmlar kanalga ketadi, lekin file_id Supabasega yozilmasligi mumkin.\n');
  }

  console.log(`🤖 Bot Token: ${BOT_TOKEN.slice(0, 10)}...`);
  console.log(`📢 Kanal ID:  ${CHANNEL_ID}`);
  console.log(`⏱️ Pacing:    ${delayMs}ms oraliq`);
  console.log(`🎨 Mavzular:  ${targetTheme === 'all' ? 'Dark, Light, Vibrant (barchasi)' : targetTheme}`);
  if (targetGroup) console.log(`🎯 Guruh:     Faqat "${targetGroup}"`);
  if (limitCount > 0) console.log(`🔢 Cheklov:   Birinchi ${limitCount} ta guruh`);
  if (forceUpload) console.log(`⚡ Force:     Mavjud keshlarni qayta yuklash yoqilgan`);
  console.log('------------------------------------------------------------\n');

  const bot = new Telegraf(BOT_TOKEN);

  // Verify Bot and Channel connectivity
  console.log('🔍 Telegram bot va kanal ulanishini tekshirish...');
  try {
    const me = await bot.telegram.getMe();
    console.log(`✅ Bot topildi: @${me.username} (${me.first_name})`);
  } catch (err) {
    console.error('❌ Telegram Bot Token noto\'g\'ri yoki internet uzilgan:', err.message);
    process.exit(1);
  }

  // Pre-warm EduPage database
  console.log('⏳ EduPage dars jadvali bazasi indekslanmoqda...');
  const t0 = Date.now();
  await edupageService.warmUpCache();
  console.log(`✅ EduPage bazasi yuklandi (${Date.now() - t0}ms)\n`);

  // Load groups list
  let groups = [];
  if (targetGroup) {
    groups = [targetGroup];
  } else {
    try {
      const jsonPath = path.join(__dirname, '../src/data/groups.json');
      groups = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      console.error('❌ groups.json faylini o\'qib bo\'lmadi:', err.message);
      process.exit(1);
    }
  }

  if (limitCount > 0) {
    groups = groups.slice(0, limitCount);
  }

  const themesToUpload = targetTheme === 'all' ? ['dark', 'light', 'vibrant'] : [targetTheme];
  const totalOperations = groups.length * themesToUpload.length;

  console.log(`📦 Jami guruhlar soni: ${groups.length}`);
  console.log(`🖼️ Jami generatsiya qilinadigan rasmlar: ${totalOperations}\n`);
  console.log('▶️ Yuklash boshlandi... (To\'xtatish uchun Ctrl+C bosing)\n');

  let stats = {
    total: totalOperations,
    processed: 0,
    uploaded: 0,
    skipped: 0,
    empty: 0,
    failed: 0,
    startTime: Date.now(),
  };

  let isStopping = false;
  const onSignal = () => {
    if (isStopping) process.exit(0);
    isStopping = true;
    console.log('\n\n🛑 To\'xtatish signali qabul qilindi. Joriy amal yakunlangach to\'xtatiladi...');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  for (let gIdx = 0; gIdx < groups.length; gIdx++) {
    if (isStopping) break;

    const groupName = groups[gIdx];
    const norm = edupageService.normalizeGroupName(groupName);
    if (!norm) {
      stats.processed += themesToUpload.length;
      stats.failed += themesToUpload.length;
      continue;
    }

    // 1. Get raw schedule from EduPage
    let rawSchedule = null;
    try {
      rawSchedule = await edupageService.getRawSchedule(groupName);
    } catch (fetchErr) {
      console.error(`\n❌ [${groupName}] Jadvalni olishda xatolik:`, fetchErr.message);
    }

    if (!rawSchedule || Object.keys(rawSchedule).length === 0) {
      stats.empty += themesToUpload.length;
      stats.processed += themesToUpload.length;
      const mem = getMemoryUsageMB();
      process.stdout.write(`\r[${stats.processed}/${stats.total}] ⚠️ Guruh: ${groupName.padEnd(12)} -> Bo'sh jadval (o'tkazildi) | RAM: ${mem.rss}MB`);
      continue;
    }

    const scheduleHash = timetableCdnService.computeScheduleHash(rawSchedule);

    // 2. Process each theme
    for (const theme of themesToUpload) {
      if (isStopping) break;
      stats.processed++;

      const themeTitle = theme === 'light' ? 'Kunduzgi' : theme === 'vibrant' ? 'Neon' : 'Tungi';

      try {
        // Check cache in Supabase first (unless --force)
        if (!forceUpload) {
          const cached = await dbService.getTimetableCache(norm, theme);
          const cachedFileId = cached?.file_id || cached?.fileId;
          if (cached && cachedFileId && cached.schedule_hash === scheduleHash) {
            stats.skipped++;
            const mem = getMemoryUsageMB();
            process.stdout.write(`\r[${stats.processed}/${stats.total}] ⏭️  ${groupName.padEnd(12)} [${theme.padEnd(7)}] -> Avval yuklangan | RAM: ${mem.rss}MB`);
            continue;
          }
        }

        // Render schedule image
        const imageBuffer = await imageService.generateScheduleImage(groupName, rawSchedule, theme);
        if (!imageBuffer) {
          stats.failed++;
          console.error(`\n❌ [${groupName} | ${theme}] Rasm chizishda xatolik yuz berdi.`);
          continue;
        }

        // Upload to Telegram channel with caption
        const caption = `🎓 <b>${escapeHtml(groupName)}</b> | 🎨 <i>${themeTitle}</i>\n<code>#hash_${scheduleHash.slice(0, 10)}</code>`;
        const uploadRes = await timetableCdnService.uploadPhotoToChannel(bot.telegram, imageBuffer, caption);

        if (uploadRes?.fileId) {
          // Persist to Supabase
          await dbService.upsertTimetableCache({
            groupName,
            groupNormalized: norm,
            theme,
            fileId: uploadRes.fileId,
            channelMessageId: uploadRes.messageId,
            scheduleHash,
          });

          stats.uploaded++;
          const elapsed = Date.now() - stats.startTime;
          const remainingOps = stats.total - stats.processed;
          const avgPerOp = elapsed / stats.processed;
          const eta = formatDuration(remainingOps * avgPerOp);
          const mem = getMemoryUsageMB();

          process.stdout.write(`\r[${stats.processed}/${stats.total}] ✅ ${groupName.padEnd(12)} [${theme.padEnd(7)}] -> Yuklandi! (ETA: ${eta} | RAM: ${mem.rss}MB)   \n`);
        } else {
          stats.failed++;
          console.error(`\n❌ [${groupName} | ${theme}] Telegram kanalga yuklanmadi.`);
        }

        // Garbage collection hint
        if (typeof gc === 'function' && stats.processed % 10 === 0) {
          gc();
        }

        // Respect Telegram upload pacing
        await sleep(delayMs);
      } catch (opErr) {
        stats.failed++;
        console.error(`\n❌ [${groupName} | ${theme}] Kutilmagan xatolik:`, opErr.message);
        await sleep(3000);
      }
    }
  }

  const totalTime = Date.now() - stats.startTime;
  console.log('\n\n════════════════════════════════════════════════════════════');
  console.log('🏁 YUKLASH YAKUNLANDI / STATISTIKA');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`⏱️ Umumiy vaqt:    ${formatDuration(totalTime)}`);
  console.log(`📊 Jami amallar:    ${stats.processed} / ${stats.total}`);
  console.log(`✅ Yangi yuklandi:  ${stats.uploaded}`);
  console.log(`⏭️ O'tkazildi (bor): ${stats.skipped}`);
  console.log(`📭 Bo'sh jadvallar: ${stats.empty}`);
  console.log(`❌ Xatolar:         ${stats.failed}`);
  console.log('════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Fatal dastur xatosi:', err);
  process.exit(1);
});
