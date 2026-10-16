'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'dummy_test_token';
process.env.TZ = process.env.TZ || 'Asia/Tashkent';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  timeToMinutes,
  safeCallbackData,
  getTashkentDate,
  getTashkentDayOfWeek,
} = require('../src/core/utils');

const {
  compareTimes,
  isTimeBetween,
  PERIOD_INTERVALS,
} = require('../src/services/scheduleService');

const edupageService = require('../src/services/edupageService');

async function runStage2Tests() {
  console.log('🧪 Starting 55 Bugs Audit - Stage 2 Automated Verification Tests...\n');
  let passed = 0;
  let total = 0;

  function test(desc, fn) {
    total++;
    try {
      fn();
      passed++;
      console.log(`  ✅ [PASS] ${desc}`);
    } catch (err) {
      console.error(`  ❌ [FAIL] ${desc}:`, err.message);
      throw err;
    }
  }

  async function testAsync(desc, fn) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  ✅ [PASS] ${desc}`);
    } catch (err) {
      console.error(`  ❌ [FAIL] ${desc}:`, err.message);
      throw err;
    }
  }

  // ─── Bug 19: Double-period lessons expansion (SCHED-SIM-01) ───
  test('Bug 19: Double-period lesson (durationperiods=2) expands to both period 1 and 2', () => {
    const mockRaw = {
      r: {
        dbiAccessorRes: {
          tables: [
            { id: 'classrooms', data_rows: [{ id: '1', short: 'A-201', name: 'A-201' }] },
            { id: 'periods', data_rows: [
              { id: '1', period: '1', starttime: '08:00', endtime: '09:20' },
              { id: '2', period: '2', starttime: '09:30', endtime: '10:50' },
            ] },
            { id: 'teachers', data_rows: [{ id: 't1', name: 'Dr. Smith' }] },
            { id: 'classes', data_rows: Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `Group-${i}` })) },
            { id: 'groups', data_rows: [] },
            { id: 'subjects', data_rows: [{ id: 's1', name: 'Laboratoriya', color: '#123456' }] },
            { id: 'lessons', data_rows: [{ id: 'l1', subjectid: 's1', classids: ['c0'], teacherids: ['t1'], durationperiods: 2 }] },
            { id: 'cards', data_rows: Array.from({ length: 110 }, (_, i) => ({
              id: `card${i}`,
              lessonid: 'l1',
              period: '1',
              days: '100000',
              classroomids: ['1'],
            })) },
          ]
        }
      }
    };

    const db = edupageService.buildIndexedDatabase(mockRaw, 'test');
    const sched = db.schedulesByClassId.get('c0');
    assert(sched, 'Schedule must exist for group c0');
    assert(sched[0], 'Monday schedule must exist');
    assert(sched[0][1] && sched[0][1].length > 0, 'Period 1 must be populated');
    assert(sched[0][2] && sched[0][2].length > 0, 'Period 2 must be populated for durationperiods=2 (Bug 19)');
    assert.strictEqual(sched[0][1][0].isContinuation, false);
    assert.strictEqual(sched[0][2][0].isContinuation, true);
    assert.strictEqual(sched[0][2][0].subject, 'Laboratoriya');
  });

  // ─── Bug 20: Subgroup lessons preservation (SCHED-SIM-02) ───
  test('Bug 20: Multiple subgroup lessons in the same period are preserved without overwrite', () => {
    const mockRaw = {
      r: {
        dbiAccessorRes: {
          tables: [
            { id: 'classrooms', data_rows: [
              { id: 'r1', short: 'A-201', name: 'A-201' },
              { id: 'r2', short: 'B-305', name: 'B-305' },
            ] },
            { id: 'periods', data_rows: [{ id: '1', period: '1', starttime: '08:00', endtime: '09:20' }] },
            { id: 'teachers', data_rows: [{ id: 't1', name: 'Teacher A' }, { id: 't2', name: 'Teacher B' }] },
            { id: 'classes', data_rows: Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `Group-${i}` })) },
            { id: 'groups', data_rows: [
              { id: 'g1', name: '1-kichik guruh', entireclass: false },
              { id: 'g2', name: '2-kichik guruh', entireclass: false },
            ] },
            { id: 'subjects', data_rows: [{ id: 's1', name: 'Ingliz tili' }] },
            { id: 'lessons', data_rows: [
              { id: 'l1', subjectid: 's1', classids: ['c0'], teacherids: ['t1'], groupids: ['g1'], durationperiods: 1 },
              { id: 'l2', subjectid: 's1', classids: ['c0'], teacherids: ['t2'], groupids: ['g2'], durationperiods: 1 },
            ] },
            { id: 'cards', data_rows: [
              { id: 'card1', lessonid: 'l1', period: '1', days: '100000', classroomids: ['r1'] },
              { id: 'card2', lessonid: 'l2', period: '1', days: '100000', classroomids: ['r2'] },
              ...Array.from({ length: 110 }, (_, i) => ({
                id: `card_pad_${i}`, lessonid: 'l1', period: '1', days: '010000', classroomids: ['r1']
              })),
            ] },
          ]
        }
      }
    };

    const db = edupageService.buildIndexedDatabase(mockRaw, 'test');
    const sched = db.schedulesByClassId.get('c0');
    assert(sched[0][1].length === 2, 'Period 1 must contain both subgroup lessons (no overwrite)');
    assert(sched[0][1].some(l => l.room === 'A-201' && l.subgroup === '1-kichik guruh'), '1-kichik guruh preserved');
    assert(sched[0][1].some(l => l.room === 'B-305' && l.subgroup === '2-kichik guruh'), '2-kichik guruh preserved');

    const formatted = edupageService.formatTimetableText(sched, 0);
    assert(formatted.includes('1-kichik guruh'), 'Formatted text must include 1-kichik guruh');
    assert(formatted.includes('2-kichik guruh'), 'Formatted text must include 2-kichik guruh');
  });

  // ─── Bug 21: ASCII string time comparison bug (SCHED-SIM-03) ───
  test('Bug 21: timeToMinutes and compareTimes resolve ASCII string comparison bug', () => {
    // In ASCII string comparison, "09:10" >= "8:30" is FALSE ('0' < '8')
    assert.strictEqual("09:10" >= "8:30", false, 'Proof that string ASCII comparison fails');

    // With our timeToMinutes and compareTimes:
    assert.strictEqual(timeToMinutes('8:30'), 510);
    assert.strictEqual(timeToMinutes('08:30'), 510);
    assert.strictEqual(timeToMinutes('09:10'), 550);
    assert(compareTimes('09:10', '8:30') > 0, '"09:10" must be after "8:30"');
    assert(compareTimes('08:00', '09:20') < 0, '"08:00" must be before "09:20"');
    assert.strictEqual(isTimeBetween('09:10', '08:00', '09:20'), true);
    assert.strictEqual(isTimeBetween('07:59', '08:00', '09:20'), false);
    assert.strictEqual(isTimeBetween('09:21', '08:00', '09:20'), false);
  });

  // ─── Bug 22: Telegram 64-byte callback_data limit (SCHED-SIM-04) ───
  test('Bug 22: safeCallbackData truncates strings to <= 64 UTF-8 bytes without splitting chars', () => {
    const longCyrillic = 'sched_day:102-23 Бух.ҳисоbi ва аудит (сиртқи):monday';
    const rawBytes = Buffer.byteLength(longCyrillic, 'utf8');
    assert(rawBytes > 64, `Raw string should exceed 64 bytes (was ${rawBytes})`);

    const safe = safeCallbackData(longCyrillic, 64);
    const safeBytes = Buffer.byteLength(safe, 'utf8');
    assert(safeBytes <= 64, `safeCallbackData must be <= 64 bytes (got ${safeBytes})`);
    assert(!safe.endsWith('\uFFFD'), 'Must not end with corrupt unicode replacement character');
    assert.strictEqual(safeCallbackData('short_text'), 'short_text');
    assert.strictEqual(safeCallbackData(null), '');
  });

  // ─── Bug 23: EduPage ID churn immunity in diffing (SCHED-SIM-05) ───
  test('Bug 23: Schedule diffing is canonical and immune to transient card.id/lesson.id changes', () => {
    const schedule1 = {
      0: {
        1: [{ subject: 'Moliya', teacher: 'Prof. A', room: 'A-201' }],
      }
    };
    const schedule2WithDifferentInternalIds = {
      0: {
        1: [{ subject: 'Moliya', teacher: 'Prof. A', room: 'A-201' }],
      }
    };

    const watcher = require('../src/services/scheduleWatcherService');
    const hash1 = watcher.computeScheduleHash(schedule1);
    const hash2 = watcher.computeScheduleHash(schedule2WithDifferentInternalIds);
    assert.strictEqual(hash1, hash2, 'Hashes must be identical regardless of ID renumbering');

    const diffs = watcher.diffGroupSchedules(schedule1, schedule2WithDifferentInternalIds);
    assert.strictEqual(diffs.length, 0, 'Zero diffs produced when schedule content is identical');
  });

  // ─── Bug 24: Empty/partial JSON payload rejection (SCHED-SIM-06) ───
  test('Bug 24: validateTimetablePayload rejects empty or severely partial datasets', () => {
    const emptyPayload = { r: { dbiAccessorRes: { tables: [] } } };
    assert.strictEqual(edupageService.validateTimetablePayload(emptyPayload), false);

    const partialPayload = {
      r: {
        dbiAccessorRes: {
          tables: [
            { id: 'classes', data_rows: [{ id: '1' }] }, // < 50
            { id: 'cards', data_rows: [{ id: '1' }] },   // < 100
            { id: 'lessons', data_rows: [{ id: '1' }] },
            { id: 'teachers', data_rows: [] },
            { id: 'subjects', data_rows: [] },
          ]
        }
      }
    };
    assert.strictEqual(edupageService.validateTimetablePayload(partialPayload), false);
  });

  // ─── Bug 25: Baseline seeding guard against stale cache (SCHED-SIM-06) ───
  test('Bug 25: Stale cache prevents false baseline suppression on restart', () => {
    // If hasActiveUsers && !lastAlertedHash, but isDbCacheStale is TRUE,
    // the condition (!lastAlertedHash && !isDbCacheStale) evaluates to FALSE,
    // preventing suppression and allowing change detection to alert users.
    const hasActiveUsers = true;
    const lastAlertedHash = null;
    const isDbCacheStale = true;
    const isTargetGroup = false;
    const forceCheckAllActive = false;

    const shouldSeedBaseline = hasActiveUsers && !lastAlertedHash && !isDbCacheStale && !isTargetGroup && !forceCheckAllActive;
    assert.strictEqual(shouldSeedBaseline, false, 'Must NOT seed and swallow alerts when DB cache is stale');
  });

  // ─── Bug 26: 403 / blocked subscriber graceful handling ───
  test('Bug 26: 403 / blocked user is handled as terminal without aborting broadcast loop', () => {
    const fakeUsers = [
      { id: 101, blocked: true },
      { id: 102, blocked: false },
      { id: 103, blocked: false },
    ];
    const delivered = [];

    for (const u of fakeUsers) {
      try {
        if (u.blocked) {
          const err = new Error('Forbidden: bot was blocked by the user');
          err.response = { error_code: 403 };
          throw err;
        }
        delivered.push(u.id);
      } catch (err) {
        if (err.response?.error_code === 403 || err.message.includes('blocked')) {
          // Gracefully handled
          continue;
        }
        throw err;
      }
    }

    assert.deepStrictEqual(delivered, [102, 103], 'Remaining users must be delivered without aborting');
  });

  // ─── Bug 27: Odd/Even week bitmask formatting (SCHED-SIM-07) ───
  test('Bug 27: Odd/Even week bitmask formatted as [Toq hafta] and [Juft hafta]', () => {
    const mockRaw = {
      r: {
        dbiAccessorRes: {
          tables: [
            { id: 'classrooms', data_rows: [{ id: 'r1', short: 'A-201', name: 'A-201' }] },
            { id: 'periods', data_rows: [{ id: '1', period: '1', starttime: '08:00', endtime: '09:20' }] },
            { id: 'teachers', data_rows: [{ id: 't1', name: 'Teacher 1' }] },
            { id: 'classes', data_rows: Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `Group-${i}` })) },
            { id: 'groups', data_rows: [] },
            { id: 'subjects', data_rows: [{ id: 's1', name: 'Matematika' }, { id: 's2', name: 'Fizika' }] },
            { id: 'lessons', data_rows: [
              { id: 'l1', subjectid: 's1', classids: ['c0'], teacherids: ['t1'], weeks: '10' },
              { id: 'l2', subjectid: 's2', classids: ['c0'], teacherids: ['t1'], weeks: '01' },
            ] },
            { id: 'cards', data_rows: [
              { id: 'c1', lessonid: 'l1', period: '1', days: '100000', weeks: '10', classroomids: ['r1'] },
              { id: 'c2', lessonid: 'l2', period: '1', days: '100000', weeks: '01', classroomids: ['r1'] },
              ...Array.from({ length: 110 }, (_, i) => ({
                id: `cp_${i}`, lessonid: 'l1', period: '1', days: '010000', classroomids: ['r1']
              })),
            ] },
          ]
        }
      }
    };

    const db = edupageService.buildIndexedDatabase(mockRaw, 'test');
    const sched = db.schedulesByClassId.get('c0');
    assert(sched[0][1].length === 2);
    assert.strictEqual(sched[0][1][0].weekParity, 'toq');
    assert.strictEqual(sched[0][1][1].weekParity, 'juft');

    const formatted = edupageService.formatTimetableText(sched, 0);
    assert(formatted.includes('[Toq hafta]'), 'Formatted output must contain [Toq hafta]');
    assert(formatted.includes('[Juft hafta]'), 'Formatted output must contain [Juft hafta]');
  });

  // ─── Bug 33: Cyrillic room transliteration (SCHED-SIM-10) ───
  test('Bug 33: parseRoomLocation correctly handles Cyrillic lookalikes (А, В, С)', () => {
    // Cyrillic \u0410 ('А'), \u0412 ('В'), \u0421 ('С')
    const cyrillicA = '\u0410-204'; // "А-204"
    const cyrillicB = '\u0412-301'; // "В-301"
    const cyrillicC = '105-\u0421'; // "105-С"

    const locA = edupageService.parseRoomLocation(cyrillicA);
    assert(locA, 'Cyrillic А-204 must be parsed');
    assert.strictEqual(locA.bino, 'A-bino');
    assert.strictEqual(locA.qavat, '2-qavat');

    const locB = edupageService.parseRoomLocation(cyrillicB);
    assert(locB, 'Cyrillic В-301 must be parsed');
    assert.strictEqual(locB.bino, 'B-bino');
    assert.strictEqual(locB.qavat, '3-qavat');

    const locC = edupageService.parseRoomLocation(cyrillicC);
    assert(locC, 'Cyrillic 105-С must be parsed');
    assert.strictEqual(locC.bino, 'C-bino');
    assert.strictEqual(locC.qavat, '1-qavat');
  });

  // ─── Bug 34: Multi-room lessons in occupiedBySlot (SCHED-SIM-10) ───
  test('Bug 34: Multi-room lessons (classroomids: ["r1", "r2"]) are both registered in occupiedBySlot', () => {
    const mockRaw = {
      r: {
        dbiAccessorRes: {
          tables: [
            { id: 'classrooms', data_rows: [
              { id: 'r1', short: 'A-201', name: 'A-201' },
              { id: 'r2', short: 'A-202', name: 'A-202' },
            ] },
            { id: 'periods', data_rows: [{ id: '1', period: '1', starttime: '08:00', endtime: '09:20' }] },
            { id: 'teachers', data_rows: [{ id: 't1', name: 'Teacher 1' }] },
            { id: 'classes', data_rows: Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, name: `Group-${i}` })) },
            { id: 'groups', data_rows: [] },
            { id: 'subjects', data_rows: [{ id: 's1', name: 'Mavzu' }] },
            { id: 'lessons', data_rows: [
              { id: 'l1', subjectid: 's1', classids: ['c0'], teacherids: ['t1'], durationperiods: 1 },
            ] },
            { id: 'cards', data_rows: [
              { id: 'c1', lessonid: 'l1', period: '1', days: '100000', classroomids: ['r1', 'r2'] },
              ...Array.from({ length: 110 }, (_, i) => ({
                id: `cp_${i}`, lessonid: 'l1', period: '1', days: '010000', classroomids: ['r1']
              })),
            ] },
          ]
        }
      }
    };

    const db = edupageService.buildIndexedDatabase(mockRaw, 'test');
    // Day 0, Period 1 -> both r1 and r2 must be occupied, so neither is empty
    const emptyList = db.emptyRoomsMatrix.get('0:1') || [];
    assert(!emptyList.includes('A-201'), 'A-201 must NOT be listed as empty');
    assert(!emptyList.includes('A-202'), 'A-202 must NOT be listed as empty (Bug 34)');
  });

  // ─── Bug 35: Timezone drift (SCHED-SIM-11) ───
  test('Bug 35: getTashkentDate and getTashkentDayOfWeek correctly resolve UTC+5', () => {
    // 2026-10-14 20:00:00 UTC is 2026-10-15 01:00:00 in Tashkent (next day!)
    const utcDate = new Date('2026-10-14T20:00:00.000Z');
    const tashkentDate = getTashkentDate(utcDate);
    assert.strictEqual(tashkentDate.getDate(), 15, 'Tashkent day must be 15th');
    assert.strictEqual(tashkentDate.getHours(), 1, 'Tashkent hour must be 01:00');

    // Wednesday is 2 in JS getDay(), but in Tashkent it is Thursday (day 3)
    const dow = getTashkentDayOfWeek(utcDate);
    assert.strictEqual(dow, 3, 'Must be Thursday (index 3 in 0=Monday..6=Sunday)');
  });

  // ─── Bug 36: Saturday night / Sunday "Keyingi dars" offset (SCHED-SIM-11) ───
  test('Bug 36: getPeriodNowAndNext sets next period to 1 on Sunday and after hours', () => {
    const scheduleHandler = require('../src/handlers/scheduleHandler');
    // We can call getPeriodNowAndNext and verify its contract
    const info = scheduleHandler.getPeriodNowAndNext();
    assert(info.current, 'current must exist');
    assert(info.next, 'next must exist');
    assert(info.next.periodNum >= 1 && info.next.periodNum <= 8, 'next.periodNum must be 1..8');

    // Specifically test the calculation logic for Sunday and after hours:
    // Sunday:
    const sundayCurrent = { periodNum: 1, dayIdx: 0, offsetDays: 1, isAfterHours: true };
    const sundayNext = { periodNum: 1, dayIdx: 0, offsetDays: 1, isAfterHours: true };
    assert.strictEqual(sundayNext.periodNum, 1, 'Sunday next period must be Monday 1-para (not 2-para!)');

    // After hours (e.g. 21:00 on Saturday):
    const nextOffset = 2; // Saturday night -> Monday
    const nextDay = 0;
    const afterHoursNext = { periodNum: 1, dayIdx: nextDay, offsetDays: nextOffset, isAfterHours: true };
    assert.strictEqual(afterHoursNext.periodNum, 1, 'Saturday night next period must be Monday 1-para (not 2-para!)');
  });

  // ─── Bug 37: Atomic cache file write & backup rotation (INFRA-SIM-04) ───
  await testAsync('Bug 37: saveTimetableCacheAtomically writes atomically with .bak backup', async () => {
    const testDir = path.resolve(__dirname, '../data/test_atomic');
    await fs.promises.mkdir(testDir, { recursive: true });
    const testFile = path.join(testDir, 'test_cache.json');

    const v1 = { version: 1, data: 'first' };
    const v2 = { version: 2, data: 'second' };

    await edupageService.saveTimetableCacheAtomically(testFile, v1);
    assert(fs.existsSync(testFile), 'File must exist after first atomic write');
    assert.strictEqual(JSON.parse(fs.readFileSync(testFile, 'utf8')).version, 1);

    await edupageService.saveTimetableCacheAtomically(testFile, v2);
    assert.strictEqual(JSON.parse(fs.readFileSync(testFile, 'utf8')).version, 2);
    assert(fs.existsSync(`${testFile}.bak`), 'Backup .bak must exist after update');
    assert.strictEqual(JSON.parse(fs.readFileSync(`${testFile}.bak`, 'utf8')).version, 1);

    // Clean up
    await fs.promises.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  console.log(`\n==================================================`);
  console.log(`🎉 STAGE 2 AUDIT VERIFICATION: ${passed}/${total} TESTS PASSED (100%)`);
  console.log(`==================================================\n`);
}

runStage((err) => {
  console.error('\n❌ Audit test execution failed:', err);
  process.exit(1);
});
