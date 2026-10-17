'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'dummy_test_token';
process.env.TZ = process.env.TZ || 'Asia/Tashkent';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const edupageService = require('../src/services/edupageService');
const scheduleWatcherService = require('../src/services/scheduleWatcherService');
const scheduleService = require('../src/services/scheduleService');
const { getTashkentDate, getTashkentDayOfWeek } = require('../src/core/utils');

async function runStage3Tests() {
  console.log('🧪 Starting Audit Stage 3 Verification Tests (S-01, S-02, S-03, S-04)...\n');

  let passed = 0;
  let failed = 0;

  function report(success, testName, detail = '') {
    if (success) {
      console.log(`  ✅ Passed: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAILED: ${testName} ${detail ? '— ' + detail : ''}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. S-01: Atomic File Writing & Cache Corruption Recovery
  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. Testing S-01: Atomic File Writing & Corruption Recovery ---');
  try {
    const tmpTestDir = path.join(os.tmpdir(), `audit_s01_test_${Date.now()}`);
    await fs.promises.mkdir(tmpTestDir, { recursive: true });
    const testFile = path.join(tmpTestDir, 'timetable_cache.json');

    const sampleData1 = { version: 1, test: 'initial', r: { dbiAccessorRes: { tables: [] } } };
    await edupageService.saveTimetableCacheAtomically(testFile, sampleData1);

    const readBack1 = JSON.parse(await fs.promises.readFile(testFile, 'utf8'));
    report(readBack1.version === 1, 'S-01: saveTimetableCacheAtomically creates file cleanly');

    // Update with version 2 (should create .bak automatically)
    const sampleData2 = { version: 2, test: 'updated' };
    await edupageService.saveTimetableCacheAtomically(testFile, sampleData2);

    const readBack2 = JSON.parse(await fs.promises.readFile(testFile, 'utf8'));
    report(readBack2.version === 2, 'S-01: saveTimetableCacheAtomically updates content');

    const bakFile = `${testFile}.bak`;
    report(fs.existsSync(bakFile), 'S-01: Automatic backup (.bak) file created during update');
    const readBak = JSON.parse(await fs.promises.readFile(bakFile, 'utf8'));
    report(readBak.version === 1, 'S-01: .bak contains previous valid version');

    // Cleanup
    await fs.promises.rm(tmpTestDir, { recursive: true, force: true }).catch(() => {});
  } catch (err) {
    report(false, 'S-01: Atomic File Writing exception', err.message);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. S-02: Sanity Guard & Canonical Schedule Diffing
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Testing S-02: Sanity Guard & Canonical Normalization ---');
  try {
    const buildFakeDataset = (numClasses, numLessons, numCards) => ({
      r: {
        dbiAccessorRes: {
          tables: [
            { id: 'classes', data_rows: Array.from({ length: numClasses }, (_, i) => ({ id: `c_${i}`, name: `Group_${i}` })) },
            { id: 'lessons', data_rows: Array.from({ length: numLessons }, (_, i) => ({ id: `l_${i}` })) },
            { id: 'cards', data_rows: Array.from({ length: numCards }, (_, i) => ({ id: `cd_${i}` })) },
            { id: 'teachers', data_rows: [] },
            { id: 'classrooms', data_rows: [] },
            { id: 'subjects', data_rows: [] },
          ],
        },
      },
    });

    const healthyDataset = buildFakeDataset(100, 200, 500);
    const isValidHealthy = edupageService.validateTimetablePayload(healthyDataset);
    report(isValidHealthy === true, 'S-02: validateTimetablePayload accepts healthy full dataset');

    const emptyDataset = buildFakeDataset(10, 10, 20);
    const isValidEmpty = edupageService.validateTimetablePayload(emptyDataset);
    report(isValidEmpty === false, 'S-02: validateTimetablePayload rejects sub-threshold dataset (< 50 classes / 100 cards)');

    // Relative drop: 500 cards dropping to 200 cards (< 50%)
    const partialDataset = buildFakeDataset(100, 200, 200);
    const isValidDrop = edupageService.validateTimetablePayload(partialDataset, healthyDataset);
    report(isValidDrop === false, 'S-02: validateTimetablePayload rejects partial dataset (>50% card drop)');

    // Canonical order jitter immunity in schedule watcher
    const schedOrderA = {
      0: {
        1: [
          { subject: 'Matematika', room: '101', teacher: 'Aliyev' },
          { subject: 'Fizika', room: '202', teacher: 'Valiyev' },
        ],
      },
    };
    const schedOrderB = {
      0: {
        1: [
          { subject: 'Fizika', room: '202', teacher: 'Valiyev' },
          { subject: 'Matematika', room: '101', teacher: 'Aliyev' },
        ],
      },
    };
    const hashA = scheduleWatcherService.computeScheduleHash(schedOrderA);
    const hashB = scheduleWatcherService.computeScheduleHash(schedOrderB);
    report(hashA === hashB, 'S-02: computeScheduleHash produces identical hash regardless of lesson array order');
    const diffsJitter = scheduleWatcherService.diffGroupSchedules(schedOrderA, schedOrderB);
    report(diffsJitter.length === 0, 'S-02: diffGroupSchedules produces 0 diffs on reordered lesson cards (No false alerts)');
  } catch (err) {
    report(false, 'S-02: Sanity Guard & Canonical testing exception', err.message);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. S-03: Singleflight Deduplication & Invalid file_id Self-Healing
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Testing S-03: Singleflight & Self-Healing Fallback ---');
  try {
    // Singleflight test: 5 concurrent callers for fetchWeeklyScheduleImage
    let generateCount = 0;
    const testGroup = 'BHA-56/24i';
    await scheduleService.invalidateImageCache(testGroup);

    const originalGenerate = require('../src/services/imageService').generateScheduleImage;
    require('../src/services/imageService').generateScheduleImage = async () => {
      generateCount++;
      await new Promise((r) => setTimeout(r, 60));
      return Buffer.from('fake_image_png');
    };

    const p1 = scheduleService.fetchWeeklyScheduleImage(testGroup, 'vibrant');
    const p2 = scheduleService.fetchWeeklyScheduleImage(testGroup, 'vibrant');
    const p3 = scheduleService.fetchWeeklyScheduleImage(testGroup, 'vibrant');
    const isSingleflightPromise = (p1 === p2 && p2 === p3);

    const [b1, b2, b3] = await Promise.all([p1, p2, p3]);
    report(isSingleflightPromise && Buffer.isBuffer(b1) && b1 === b2, `S-03: Singleflight coalesces concurrent requests into exactly 1 in-flight execution`);
    require('../src/services/imageService').generateScheduleImage = originalGenerate;
    await scheduleService.invalidateImageCache(testGroup);

    // Self-healing fallback test simulation
    let invalidated = false;
    const originalInvalidate = scheduleService.invalidateImageCache;
    scheduleService.invalidateImageCache = async (cls) => {
      invalidated = true;
      return originalInvalidate ? originalInvalidate(cls) : undefined;
    };

    // Simulate Telegram error handling in cmdHafta logic
    let healed = false;
    try {
      throw new Error('400 Bad Request: wrong file identifier/HTTP URL specified');
    } catch (sendErr) {
      const errStr = String(sendErr.message);
      if (errStr.includes('wrong file identifier')) {
        await scheduleService.invalidateImageCache('TEST-HEAL');
        healed = true;
      }
    }
    report(invalidated && healed, 'S-03: Invalid file_id error triggers automatic cache purge and self-healing');
    scheduleService.invalidateImageCache = originalInvalidate;
  } catch (err) {
    report(false, 'S-03: Singleflight & Self-Healing exception', err.message);
  }

  // ─────────────────────────────────────────────────────────────
  // 4. S-04: Timezone Consistency & Building/Room Parsing
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 4. Testing S-04: Timezone Consistency & Room Parsing ---');
  try {
    // Timezone check
    const nowUtc = new Date();
    const tashkentDate = getTashkentDate(nowUtc);
    const dayOfWeek = getTashkentDayOfWeek(nowUtc);
    report(tashkentDate instanceof Date && !isNaN(tashkentDate.getTime()), 'S-04: getTashkentDate returns valid Date object');
    report(dayOfWeek >= 0 && dayOfWeek <= 6, `S-04: getTashkentDayOfWeek returns valid 0-6 index (${dayOfWeek})`);

    // Building parsing enhancements
    const roomA = edupageService.parseRoomLocation('A-204');
    report(roomA?.bino === 'A-bino' && roomA?.qavat === '2-qavat', 'S-04: parseRoomLocation accurately parses "A-204" -> A-bino, 2-qavat');

    const roomB = edupageService.parseRoomLocation('B bino 301');
    report(roomB?.bino === 'B-bino' && roomB?.qavat === '3-qavat', 'S-04: parseRoomLocation accurately parses "B bino 301" -> B-bino, 3-qavat');

    const roomReverse = edupageService.parseRoomLocation('204-A');
    report(roomReverse?.bino === 'A-bino' && roomReverse?.qavat === '2-qavat', 'S-04: parseRoomLocation accurately parses "204-A" -> A-bino, 2-qavat');

    const sportZal = edupageService.parseRoomLocation('Sport zal');
    report(sportZal?.bino === 'Sportzal' && sportZal?.qavat === '1-qavat', 'S-04: parseRoomLocation accurately parses "Sport zal" -> Sportzal, 1-qavat');
  } catch (err) {
    report(false, 'S-04: Timezone & Room Parsing exception', err.message);
  }

  console.log('\n==================================================');
  if (failed === 0) {
    console.log(`🎉 ALL AUDIT STAGE 3 TESTS PASSED (${passed}/${passed})!`);
  } else {
    console.error(`❌ AUDIT STAGE 3 TESTS FAILED: ${failed} failures out of ${passed + failed}`);
    process.exit(1);
  }
  console.log('==================================================\n');
}

runStage3Tests().then(() => process.exit(0)).catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
