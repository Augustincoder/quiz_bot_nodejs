'use strict';
/* global gc */

const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { Telegraf } = require('telegraf');
const sharp = require('sharp');

// Keep RAM clean while utilizing multi-core CPU for ultra-fast local rendering
sharp.cache(false);
const cpuCores = os.cpus()?.length || 4;
sharp.concurrency(Math.max(2, Math.min(8, cpuCores)));

const edupageService = require('../src/services/edupageService');
const imageService = require('../src/services/imageService');
const timetableCdnService = require('../src/services/timetableCdnService');
const dbService = require('../src/services/dbService');
const { escapeHtml } = require('../src/core/utils');

// ─── Parse CLI Flags ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArgVal(flag, def = null) {
  const hit = args.find((a) => a.startsWith(`--${flag}=`));
  if (hit) return hit.split('=')[1].trim();
  return def;
}

const targetGroup    = getArgVal('group', null);
const targetTheme    = getArgVal('theme', 'all'); // 'dark' | 'light' | 'vibrant' | 'all'
const delayMs        = parseInt(getArgVal('delay', '1200'), 10); // Safe 1.2s local default (was 2.2s)
const limitCount     = parseInt(getArgVal('limit', '0'), 10);
const forceUpload    = args.includes('--force');
const cleanCache     = args.includes('--clean');
const priorityActive = !args.includes('--no-priority');

const BOT_TOKEN  = process.env.BOT_TOKEN;
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
  console.log('║   TSUE TIMETABLE CDN — HIGH-SPEED PIPELINED ENGINE         ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (!BOT_TOKEN) {
    console.error('❌ Xatolik: .env faylida BOT_TOKEN topilmadi!');
    process.exit(1);
  }

  if (!CHANNEL_ID) {
    console.error('❌ Xatolik: .env faylida TIMETABLE_STORAGE_CHANNEL_ID topilmadi!');
    process.exit(1);
  }

  console.log(`🤖 Bot Token:    ${BOT_TOKEN.slice(0, 10)}...`);
  console.log(`📢 Kanal ID:     ${CHANNEL_ID}`);
  console.log(`💻 CPU yadrolar: ${cpuCores} ta (Parallel libvips renderer)`);
  console.log(`⏱️ Pacing Delay: ${delayMs}ms oralig'i (Telegram CDN limitiga moslangan)`);
  console.log(`🎨 Mavzu:        ${targetTheme === 'all' ? 'dark, light, vibrant (barchasi)' : targetTheme}`);
  if (targetGroup) console.log(`🎯 Guruh:        Faqat "${targetGroup}"`);
  if (limitCount > 0) console.log(`🔢 Cheklov:      ${limitCount} ta guruh`);
  if (forceUpload) console.log(`⚡ Force:        Barcha mavjud keshlar qayta generatsiya qilinadi`);
  if (cleanCache)  console.log(`🧹 Clean:        Boshlashdan oldin barcha keshlar tozalanadi`);
  console.log('------------------------------------------------------------\n');

  const bot = new Telegraf(BOT_TOKEN);

  // 1. Verify Telegram Bot connectivity
  try {
    const me = await bot.telegram.getMe();
    console.log(`✅ Telegram bot ulandi: @${me.username} (${me.first_name})`);
  } catch (err) {
    console.error('❌ Telegram Bot Token noto\'g\'ri yoki internet uzilgan:', err.message);
    process.exit(1);
  }

  // 2. Pre-warm EduPage database (Instant in-memory index)
  console.log('⏳ EduPage dars jadvali ma\'lumotlar bazasi indekslanmoqda...');
  const t0 = Date.now();
  await edupageService.warmUpCache();
  console.log(`✅ EduPage bazasi yuklandi (${Date.now() - t0}ms)\n`);

  // 3. Sync & Pre-load Supabase Cache (Eliminates 1,350 roundtrips during indexing)
  console.log('🔍 Supabase mavjud keshlarini o\'qish va sinxronlash...');
  let existingDbRows = await dbService.getAllCachedTimetables();
  const dbCacheMap = new Map(); // `${norm}:${theme}` -> row
  for (const r of existingDbRows) {
    dbCacheMap.set(`${r.group_normalized}:${r.theme}`, r);
  }
  console.log(`📊 Supabase bazasida avvaldan mavjud rasmlar: ${dbCacheMap.size} ta`);

  // Handle Cache Cleaning or Phantom Redis Stale Cache
  if (cleanCache) {
    console.log('🧹 Barcha Redis va Supabase keshlarini tozalash boshlandi...');
    await dbService.clearAllTimetableCache();
    dbCacheMap.clear();
    console.log('✅ Barcha keshlar toza holatga keltirildi.');
  } else if (dbCacheMap.size === 0) {
    // If Supabase is empty, wipe any stale phantom keys from Redis to prevent false skipping
    try {
      const Redis = require('ioredis');
      const rClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
      const staleKeys = await rClient.keys('cache:timetable_cdn:*');
      if (staleKeys && staleKeys.length > 0) {
        await rClient.del(staleKeys);
        console.log(`🧹 Supabase bo'sh bo'lgani sababli Redis'dagi ${staleKeys.length} ta eski sinov kalitlari tozalandi.`);
      }
      rClient.quit();
    } catch {
      // Ignore if Redis not accessible
    }
  }

  // 4. Gather & Prioritize Groups (Active Students First!)
  let rawGroups = [];
  if (targetGroup) {
    rawGroups = [targetGroup];
  } else {
    try {
      const jsonPath = path.join(__dirname, '../src/data/groups.json');
      rawGroups = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (err) {
      console.error('❌ groups.json faylini o\'qib bo\'lmadi:', err.message);
      process.exit(1);
    }
  }

  const prioritizedGroups = [];
  const seenNorm = new Set();

  if (priorityActive && !targetGroup) {
    try {
      const activeUsers = await dbService.getScheduleBroadcastUsers();
      const activeGroups = activeUsers.map((u) => (u.class_name || '').trim()).filter(Boolean);
      for (const ag of activeGroups) {
        const norm = edupageService.normalizeGroupName(ag);
        if (norm && !seenNorm.has(norm)) {
          seenNorm.add(norm);
          prioritizedGroups.push(ag);
        }
      }
      console.log(`⭐ 1-navbat: ${prioritizedGroups.length} ta ro'yxatdan o'tgan talabalar guruhlari.`);
    } catch (e) {
      console.warn('⚠️ Faol talabalar guruhlarini olishda xatolik:', e.message);
    }
  }

  // Add remaining groups
  for (const g of rawGroups) {
    if (!g || typeof g !== 'string') continue;
    const norm = edupageService.normalizeGroupName(g);
    if (norm && !seenNorm.has(norm)) {
      seenNorm.add(norm);
      prioritizedGroups.push(g);
    }
  }

  let finalGroups = prioritizedGroups;
  if (limitCount > 0) {
    finalGroups = finalGroups.slice(0, limitCount);
  }

  const themesToUpload = targetTheme === 'all' ? ['dark', 'light', 'vibrant'] : [targetTheme];

  // 5. Build Work Queue in 0ms (In-Memory Pre-Scan)
  console.log('⚡ Dars jadvallari va kesh holati tekshirilmoqda...');
  const queue = [];
  let skippedCount = 0;
  let emptyCount = 0;

  for (const groupName of finalGroups) {
    const norm = edupageService.normalizeGroupName(groupName);
    if (!norm) continue;

    const rawSchedule = await edupageService.getRawSchedule(groupName);
    if (!rawSchedule || Object.keys(rawSchedule).length === 0) {
      emptyCount += themesToUpload.length;
      continue;
    }

    const scheduleHash = timetableCdnService.computeScheduleHash(rawSchedule);

    for (const theme of themesToUpload) {
      if (!forceUpload) {
        const cached = dbCacheMap.get(`${norm}:${theme}`);
        if (cached && cached.file_id && cached.schedule_hash === scheduleHash) {
          skippedCount++;
          continue;
        }
      }
      queue.push({ groupName, norm, theme, rawSchedule, scheduleHash });
    }
  }

  console.log(`📦 Jami guruhlar: ${finalGroups.length} ta`);
  console.log(`⏭️  Mavjud (o'tkazildi): ${skippedCount} ta`);
  console.log(`📭 Bo'sh jadvallar: ${emptyCount} ta`);
  console.log(`🚀 Yuklanishi kerak bo'lgan rasmlar: ${queue.length} ta\n`);

  if (queue.length === 0) {
    console.log('🎉 Barcha guruh jadvallari allaqachon eng so\'nggi holatda yuklangan!');
    process.exit(0);
  }

  console.log('▶️ Pipelined yuklash boshlandi... (To\'xtatish uchun Ctrl+C bosing)\n');

  let stats = {
    total: queue.length,
    processed: 0,
    uploaded: 0,
    failed: 0,
    startTime: Date.now(),
  };

  let isStopping = false;
  const onSignal = () => {
    if (isStopping) process.exit(0);
    isStopping = true;
    console.log('\n\n🛑 To\'xtatish signali qabul qilindi. Joriy yuklash yakunlangach to\'xtatiladi...');
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // ─── PIPELINED PREFETCH WORKER (Producer - Consumer) ───────────────────────
  // Pre-renders up to 4 images ahead in RAM so Telegram upload never waits for CPU
  const PREFETCH_BUFFER_SIZE = Math.min(4, Math.max(2, cpuCores));
  let renderIndex = 0;
  const prefetchQueue = [];

  function enqueueNextRender() {
    if (renderIndex >= queue.length) return;
    const task = queue[renderIndex++];
    const renderPromise = (async () => {
      const rStart = Date.now();
      try {
        const buf = await imageService.generateScheduleImage(task.groupName, task.rawSchedule, task.theme);
        return { task, buf, renderTime: Date.now() - rStart, error: null };
      } catch (rErr) {
        return { task, buf: null, renderTime: Date.now() - rStart, error: rErr.message };
      }
    })();
    prefetchQueue.push(renderPromise);
  }

  // Prime initial prefetch pipeline
  for (let i = 0; i < Math.min(PREFETCH_BUFFER_SIZE, queue.length); i++) {
    enqueueNextRender();
  }

  // ─── CONSUMER LOOP (Telegram Uploader) ─────────────────────────────────────
  while (prefetchQueue.length > 0) {
    if (isStopping) break;

    // 1. Await next pre-rendered image (almost instant, already rendering or done in RAM)
    const { task, buf, renderTime, error } = await prefetchQueue.shift();

    // 2. Replenish prefetch pipeline immediately to keep CPU cores busy
    enqueueNextRender();

    stats.processed++;
    const { groupName, norm, theme, scheduleHash } = task;
    const themeTitle = theme === 'light' ? 'Kunduzgi' : theme === 'vibrant' ? 'Neon' : 'Tungi';

    if (!buf || error) {
      stats.failed++;
      console.error(`\n❌ [${groupName} | ${theme}] Rasm chizishda xatolik:`, error);
      continue;
    }

    try {
      // 3. Upload to Telegram storage channel
      const caption = `🎓 <b>${escapeHtml(groupName)}</b> | 🎨 <i>${themeTitle}</i>\n<code>#hash_${scheduleHash.slice(0, 10)}</code>`;
      const uploadRes = await timetableCdnService.uploadPhotoToChannel(bot.telegram, buf, caption);

      if (uploadRes?.fileId) {
        // 4. Update Supabase & local cache map
        await dbService.upsertTimetableCache({
          groupName,
          groupNormalized: norm,
          theme,
          fileId: uploadRes.fileId,
          channelMessageId: uploadRes.messageId,
          scheduleHash,
        });

        dbCacheMap.set(`${norm}:${theme}`, {
          file_id: uploadRes.fileId,
          channel_message_id: uploadRes.messageId,
          schedule_hash: scheduleHash,
        });

        stats.uploaded++;

        const elapsedMs = Date.now() - stats.startTime;
        const avgPerOp = elapsedMs / stats.processed;
        const remainingOps = stats.total - stats.processed;
        const etaStr = formatDuration(remainingOps * avgPerOp);
        const percent = ((stats.processed / stats.total) * 100).toFixed(1);
        const mem = getMemoryUsageMB();
        const speedPerMin = Math.round((stats.processed / (elapsedMs / 60000)) || 0);

        process.stdout.write(
          `\r[${stats.processed}/${stats.total}] (${percent}%) ✅ ${groupName.padEnd(12)} [${theme.padEnd(7)}] ` +
          `| ${speedPerMin} rasm/min | ETA: ${etaStr} | RAM: ${mem.rss}MB   `
        );
      } else {
        stats.failed++;
        console.error(`\n❌ [${groupName} | ${theme}] Telegram kanalga yuklanmadi.`);
      }

      // 5. Periodic GC hint every 25 operations
      if (typeof gc === 'function' && stats.processed % 25 === 0) {
        gc();
      }

      // 6. Safe pacing delay for Telegram Channel Rate Limits
      await sleep(delayMs);
    } catch (opErr) {
      stats.failed++;
      console.error(`\n❌ [${groupName} | ${theme}] Kutilmagan xatolik:`, opErr.message);
      await sleep(2000);
    }
  }

  const totalTime = Date.now() - stats.startTime;
  console.log('\n\n════════════════════════════════════════════════════════════');
  console.log('🏁 YUKLASH YAKUNLANDI / YAKUNIY STATISTIKA');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`⏱️ Umumiy ketgan vaqt: ${formatDuration(totalTime)}`);
  console.log(`📊 Jami amallar:       ${stats.processed} / ${stats.total}`);
  console.log(`✅ Muvaffaqiyatli:     ${stats.uploaded}`);
  console.log(`⏭️  Avvaldan bor:       ${skippedCount}`);
  console.log(`❌ Xatolar:            ${stats.failed}`);
  console.log('════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Fatal dastur xatosi:', err);
  process.exit(1);
});
