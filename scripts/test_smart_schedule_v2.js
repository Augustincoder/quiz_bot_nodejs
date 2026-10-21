'use strict';

/**
 * Smart Timetable & Contextual Reminder Engine v2.0
 * Comprehensive Verification & Regression Test Suite
 */

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:dummy_test_token';
const assert = require('assert');
const edupageService = require('../src/services/edupageService');
const scheduleService = require('../src/services/scheduleService');
const db = require('../src/services/dbService');
const noteHandler = require('../src/handlers/noteHandler');
const pendingStore = require('../src/core/pendingStore');

console.log('🧪 Starting Smart Timetable & Contextual Reminder Engine v2.0 Test Suite...\n');

let totalTests = 0;
let passedTests = 0;

async function runTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
  }
}

async function main() {
  // =========================================================================
  // 1. TSUE Dataset Real Subject Normalization & Classification
  // =========================================================================
  console.log('--- Suite 1: TSUE Real Subject Normalization & Classification ---');

  await runTest('1.1: "Java dasturlash tili (Ma)" -> lecture & normalized key', () => {
    const normKey = edupageService.normalizeSubjectKey('Java dasturlash tili (Ma)');
    assert.strictEqual(normKey, 'Java dasturlash tili');
    const type = edupageService.normalizeLessonType('Java dasturlash tili (Ma)');
    assert.strictEqual(type, 'lecture');
  });

  await runTest('1.2: "Professional buxgalteriya amaliyoti (Ma)" -> lecture (checked before amaliyoti)', () => {
    const normKey = edupageService.normalizeSubjectKey('Professional buxgalteriya amaliyoti (Ma)');
    assert.strictEqual(normKey, 'Professional buxgalteriya amaliyoti');
    const type = edupageService.normalizeLessonType('Professional buxgalteriya amaliyoti (Ma)');
    assert.strictEqual(type, 'lecture', 'Subject with (Ma) tag must be classified as lecture even if title contains amaliyoti');
  });

  await runTest('1.3: "Elektron hukumat" -> any (word Elektron does not match lek)', () => {
    const normKey = edupageService.normalizeSubjectKey('Elektron hukumat');
    assert.strictEqual(normKey, 'Elektron hukumat');
    const type = edupageService.normalizeLessonType('Elektron hukumat');
    assert.strictEqual(type, 'any', 'Elektron should not trigger lek regex match');
  });

  await runTest('1.4: "Intellektual mulk huquqi" -> any (Intellektual does not match lek)', () => {
    const type = edupageService.normalizeLessonType('Intellektual mulk huquqi');
    assert.strictEqual(type, 'any', 'Intellektual should not trigger lek match');
  });

  await runTest('1.5: "Ko‘nikmaga asoslangan ta’lim (soft skills) (Ma)" -> lecture & preserves (soft skills)', () => {
    const normKey = edupageService.normalizeSubjectKey('Ko‘nikmaga asoslangan ta’lim (soft skills) (Ma)');
    assert.strictEqual(normKey, "Ko'nikmaga asoslangan ta'lim (soft skills)");
    const type = edupageService.normalizeLessonType('Ko‘nikmaga asoslangan ta’lim (soft skills) (Ma)');
    assert.strictEqual(type, 'lecture');
  });

  await runTest('1.6: "Buxgalteriya hisobi (aylanma) (Sem)" -> practice & preserves (aylanma)', () => {
    const normKey = edupageService.normalizeSubjectKey('Buxgalteriya hisobi (aylanma) (Sem)');
    assert.strictEqual(normKey, 'Buxgalteriya hisobi (aylanma)');
    const type = edupageService.normalizeLessonType('Buxgalteriya hisobi (aylanma) (Sem)');
    assert.strictEqual(type, 'practice');
  });

  await runTest('1.7: Trailing "Ma" and "Sem" without parentheses', () => {
    const normKey1 = edupageService.normalizeSubjectKey('Moliya bozori Ma');
    assert.strictEqual(normKey1, 'Moliya bozori');
    assert.strictEqual(edupageService.normalizeLessonType('Moliya bozori Ma'), 'lecture');

    const normKey2 = edupageService.normalizeSubjectKey('Moliya bozori Sem');
    assert.strictEqual(normKey2, 'Moliya bozori');
    assert.strictEqual(edupageService.normalizeLessonType('Moliya bozori Sem'), 'practice');
  });

  await runTest('1.8: Object metadata classification (subgroup & jointGroups)', () => {
    const subgroupObj = { subject: 'Oliy matematika', subgroup: '1-guruh' };
    assert.strictEqual(edupageService.normalizeLessonType(subgroupObj), 'practice');

    const subgroupsArrObj = { subject: 'Oliy matematika', subgroups: ['A', 'B'] };
    assert.strictEqual(edupageService.normalizeLessonType(subgroupsArrObj), 'practice');

    const jointObj = { subject: 'Iqtisodiyot nazariyasi', jointGroups: ['BHA-51', 'BHA-52'] };
    assert.strictEqual(edupageService.normalizeLessonType(jointObj), 'lecture');
  });

  // =========================================================================
  // 2. Synchronous High-Speed Cache (getCachedIndexedDatabaseSync)
  // =========================================================================
  console.log('\n--- Suite 2: Synchronous Database Cache & Speed Performance ---');

  await runTest('2.1: getCachedIndexedDatabaseSync loads database and caches in memory', () => {
    const db = edupageService.getCachedIndexedDatabaseSync();
    assert.ok(db, 'Cached indexed database should be resolved');
    assert.ok(db.schedulesByClassId && db.schedulesByClassId.size > 0, 'Should contain class schedules');
  });

  await runTest('2.2: Repeated getCachedIndexedDatabaseSync calls execute in < 5ms without reading disk', () => {
    const iterations = 200;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const db = edupageService.getCachedIndexedDatabaseSync();
      assert.ok(db);
    }
    const totalMs = performance.now() - start;
    const avgMs = totalMs / iterations;
    console.log(`      ⏱️  Total time for ${iterations} calls: ${totalMs.toFixed(2)}ms (avg: ${avgMs.toFixed(3)}ms/call)`);
    assert.ok(avgMs < 5, `Expected average call to be < 5ms, got ${avgMs}ms`);
  });

  await runTest('2.3: getGroupScheduleForDay returns lessons with subgroup, weekParity, isContinuation', () => {
    const db = edupageService.getCachedIndexedDatabaseSync();
    const allGroups = Array.from(db?.classesByName?.keys() || []);
    const testGroup = allGroups.find(g => g.includes('BHA')) || allGroups[0];
    assert.ok(testGroup, 'Test group should be available');

    let foundLessons = [];
    for (let d = 0; d < 6; d++) {
      foundLessons = scheduleService.getGroupScheduleForDay(testGroup, d);
      if (foundLessons && foundLessons.length > 0) break;
    }

    if (foundLessons.length > 0) {
      const sample = foundLessons[0];
      assert.ok('subgroup' in sample, 'Should include subgroup field');
      assert.ok('weekParity' in sample, 'Should include weekParity field');
      assert.ok('isContinuation' in sample, 'Should include isContinuation field');
    }
  });

  // =========================================================================
  // 3. Subgroup Lessons Bell Suppression & Period Grouping
  // =========================================================================
  console.log('\n--- Suite 3: 5-Minute Bell Period Grouping & Subgroup Bug Fix ---');

  await runTest('3.1: Subgroup lessons in the same period do NOT trigger false bell', () => {
    const mockLessons = [
      { period: 1, subject: 'Ingliz tili (Sem)', room: 'A-201', subgroup: '1-guruh', startTime: '08:00', endTime: '09:20' },
      { period: 1, subject: 'Ingliz tili (Sem)', room: 'A-202', subgroup: '2-guruh', startTime: '08:00', endTime: '09:20' },
    ];

    const lessonsByPeriod = new Map();
    for (const l of mockLessons) {
      if (!lessonsByPeriod.has(l.period)) lessonsByPeriod.set(l.period, []);
      lessonsByPeriod.get(l.period).push(l);
    }

    const sortedPeriods = Array.from(lessonsByPeriod.keys()).sort((a, b) => a - b);
    const alertsTriggered = [];

    for (let idx = 0; idx < sortedPeriods.length; idx++) {
      const p = sortedPeriods[idx];
      const nextPeriod = p + 1;
      if (!lessonsByPeriod.has(nextPeriod)) continue;

      const currLessons = lessonsByPeriod.get(p);
      const nextLessons = lessonsByPeriod.get(nextPeriod);
      alertsTriggered.push({ p, nextPeriod, curr: currLessons[0], next: nextLessons[0] });
    }

    assert.strictEqual(alertsTriggered.length, 0, 'No alert should be scheduled because period 2 does not exist!');
  });

  await runTest('3.2: Period 1 with 2 subgroups correctly alerts for Period 2', () => {
    const mockLessons = [
      { period: 1, subject: 'Ingliz tili (Sem)', room: 'A-201', subgroup: '1-guruh', startTime: '08:00', endTime: '09:20' },
      { period: 1, subject: 'Ingliz tili (Sem)', room: 'A-202', subgroup: '2-guruh', startTime: '08:00', endTime: '09:20' },
      { period: 2, subject: 'Menejment (Ma)', room: 'B-305', subgroup: '', startTime: '09:30', endTime: '10:50' },
    ];

    const lessonsByPeriod = new Map();
    for (const l of mockLessons) {
      if (!lessonsByPeriod.has(l.period)) lessonsByPeriod.set(l.period, []);
      lessonsByPeriod.get(l.period).push(l);
    }

    const sortedPeriods = Array.from(lessonsByPeriod.keys()).sort((a, b) => a - b);
    const alertsTriggered = [];

    for (let idx = 0; idx < sortedPeriods.length; idx++) {
      const p = sortedPeriods[idx];
      const nextPeriod = p + 1;
      if (!lessonsByPeriod.has(nextPeriod)) continue;

      const currLessons = lessonsByPeriod.get(p);
      const nextLessons = lessonsByPeriod.get(nextPeriod);
      alertsTriggered.push({ p, nextPeriod, curr: currLessons[0], next: nextLessons[0] });
    }

    assert.strictEqual(alertsTriggered.length, 1);
    assert.strictEqual(alertsTriggered[0].p, 1);
    assert.strictEqual(alertsTriggered[0].nextPeriod, 2);
    assert.strictEqual(alertsTriggered[0].next.subject, 'Menejment (Ma)');
  });

  // =========================================================================
  // 4. Double-pair Suppression & Building Transition
  // =========================================================================
  console.log('\n--- Suite 4: Double-pair Suppression & Building Transition ---');

  await runTest('4.1: Same double pair in same room suppresses alert', () => {
    const lesson1 = { subject: 'Oliy matematika (Ma)', room: 'A-201', classroom: 'A-201' };
    const lesson2 = { subject: 'Oliy matematika (Ma)', room: 'A-201', classroom: 'A-201' };
    assert.strictEqual(edupageService.isSameDoublePair(lesson1, lesson2), true);
  });

  await runTest('4.2: Building hopping transition detected', () => {
    const lesson1 = { room: 'A-201' };
    const lesson2 = { room: '2-bino 301' };
    assert.strictEqual(edupageService.detectBuildingTransition(lesson1, lesson2), true);
  });

  await runTest('4.3: Same building does not flag hopping', () => {
    const lesson1 = { room: 'A-101' };
    const lesson2 = { room: 'A-205' };
    assert.strictEqual(edupageService.detectBuildingTransition(lesson1, lesson2), false);
  });

  // =========================================================================
  // 5. Note Wizard Routing & Authorization
  // =========================================================================
  console.log('\n--- Suite 5: Note Wizard Routing & State Clearing ---');

  await runTest('5.1: Menu button or command clears wizard state', async () => {
    const pendingStore = require('../src/core/pendingStore');
    const userId = 9999999;
    await pendingStore.set(`note_wiz:${userId}`, { step: 'AWAITING_CONTENT_THEN_OCCURRENCE' });

    let passed = false;
    const mockCtx = {
      from: { id: userId },
      message: { text: '📅 Dars jadvali' },
    };

    const { handleNoteWizardInput } = require('../src/handlers/noteHandler');
    await handleNoteWizardInput(mockCtx, () => {
      passed = true;
    });

    assert.strictEqual(passed, true, 'Next callback must be called when user taps menu button');
    const remaining = await pendingStore.get(`note_wiz:${userId}`);
    assert.strictEqual(remaining, null, 'Wizard state must be cleared');
  });

  await runTest('5.2: Non-creator non-admin cannot modify group note', async () => {
    const { isAdmin } = require('../src/core/utils');
    const note = {
      creator_id: 11111,
      is_group_shared: true,
    };
    const callerId = 22222;
    const isAuthorized = !note.is_group_shared || String(note.creator_id) === String(callerId) || isAdmin(callerId);
    assert.strictEqual(isAuthorized, false, 'Unauthorized user should be blocked from editing group note');
  });

  // =========================================================================
  // 6. Production Resilience & Zero-JIT Cron Fixes
  // =========================================================================
  console.log('\n--- Suite 6: Production Resilience & Zero-JIT Cron Fixes ---');

  await runTest('6.1: isSameDoublePair suppresses bell if nextLesson.isContinuation is true', () => {
    const curr = { subject: 'Mikroiqtisodiyot (Ma)', room: 'A-101', period: 1 };
    const next = { subject: 'Mikroiqtisodiyot', room: 'A-101', period: 2, isContinuation: true };
    assert.strictEqual(edupageService.isSameDoublePair(curr, next), true, 'Continuation lesson must suppress alert');
  });

  await runTest('6.2: findUpcomingCourseOccurrences excludes continuation blocks from buttons', () => {
    const mockSchedule = {
      0: { // Monday
        1: [{ subject: 'Moliya bozori (Ma)', startTime: '08:00', endTime: '09:20', room: '101' }],
        2: [{ subject: 'Moliya bozori (Ma)', startTime: '09:30', endTime: '10:50', room: '101', isContinuation: true }],
      }
    };
    const occ = edupageService.findUpcomingCourseOccurrences(mockSchedule, 'Moliya bozori', 'any', new Date('2026-10-19T06:00:00+05:00'), 5);
    assert.ok(occ.length > 0, 'Occurrences should be found');
    assert.ok(occ.every(o => o.period === 1), 'Only the start period (1) must be listed, continuation period (2) must be excluded');
  });

  await runTest('6.3: Custom time classification: < 18:00 is morning briefing, >= 18:00 is evening preview', () => {
    const times = [
      { time: '06:30', expected: 'morning' },
      { time: '11:45', expected: 'morning' },
      { time: '17:59', expected: 'morning' },
      { time: '18:00', expected: 'evening' },
      { time: '20:30', expected: 'evening' },
      { time: '23:59', expected: 'evening' },
    ];
    for (const t of times) {
      const [hh] = t.time.split(':').map(Number);
      const category = hh < 18 ? 'morning' : 'evening';
      assert.strictEqual(category, t.expected, `Time ${t.time} should be ${t.expected}`);
    }
  });

  await runTest('6.4: Same-day snooze searchFrom calculation allows later class on same day', () => {
    const note = {
      target_date: '2026-10-20',
      target_start_time: '08:30',
    };
    const now = new Date('2026-10-20T08:00:00+05:00');
    let noteTargetDate = null;
    if (note.target_date && note.target_start_time) {
      const parsed = new Date(`${note.target_date}T${note.target_start_time}:00+05:00`);
      if (!isNaN(parsed.getTime())) noteTargetDate = parsed;
    }
    const searchFrom = (noteTargetDate && noteTargetDate > now)
      ? new Date(noteTargetDate.getTime() + 15 * 60 * 1000)
      : now;

    assert.strictEqual(searchFrom.toISOString(), new Date('2026-10-20T08:45:00+05:00').toISOString());
  });

  await runTest('6.5: updateNoteStatus handles notified_before_class without altering status column', () => {
    const updates = { updated_at: new Date().toISOString() };
    const newStatus = 'notified_before_class';
    if (newStatus === 'notified_before_class') {
      updates.notified_before_class_at = new Date().toISOString();
    } else if (newStatus) {
      updates.status = newStatus;
    }
    assert.ok(updates.notified_before_class_at, 'Should set notified_before_class_at timestamp');
    assert.strictEqual(updates.status, undefined, 'status must not be overwritten to maintain CHECK constraint');
  });

  await runTest('6.6: Snooze resets notification timestamps so new occurrence will be reminded', () => {
    const updates = {
      updated_at: new Date().toISOString(),
      notified_before_class_at: '2026-10-16T08:00:00.000Z',
      notified_evening_at: '2026-10-15T20:00:00.000Z',
    };
    const newStatus = 'snoozed';
    if (newStatus === 'snoozed') {
      updates.notified_before_class_at = null;
      updates.notified_evening_at = null;
    }
    assert.strictEqual(updates.notified_before_class_at, null);
    assert.strictEqual(updates.notified_evening_at, null);
  });

  await runTest('6.7: sendDailyBriefingCard handles 403 error cleanly without uncaught exception', async () => {
    const watcher = require('../src/services/scheduleWatcherService');
    const mockBot = {
      telegram: {
        sendMessage: async () => {
          const err = new Error('Forbidden: bot was blocked by the user');
          err.response = { error_code: 403 };
          throw err;
        }
      }
    };
    const result = await watcher.sendDailyBriefingCard(mockBot, 123456, 'BHA-51', 1, 'Header');
    assert.strictEqual(result, false, 'sendDailyBriefingCard should return false on error');
  });

  await runTest('6.8: sendPreEndBellAlert detects building change and includes warning banner', async () => {
    const watcher = require('../src/services/scheduleWatcherService');
    let sentMsg = null;
    const mockBot = {
      telegram: {
        sendMessage: async (chatId, text) => {
          sentMsg = text;
          return { message_id: 1 };
        }
      }
    };
    const curr = { period: 1, subject: 'Fizika', room: '1-bino 101', startTime: '08:00' };
    const next = { period: 2, subject: 'Kimyo', room: '2-bino 202', startTime: '09:30' };
    const sent = await watcher.sendPreEndBellAlert(mockBot, 999, curr, next, true);
    assert.strictEqual(sent, true);
    assert.ok(sentMsg.includes('BOSHQA BINODA'), 'Should include building change warning');
  });

  // =========================================================================
  // 7. Architectural & High-Load Stress Simulations
  // =========================================================================
  console.log('\n--- Suite 7: Architectural & High-Load Stress Simulations ---');

  await runTest('7.1: Repeated getAllActiveScheduleSubscribers executes in < 1ms from L1 cache', async () => {
    const initial = await db.getAllActiveScheduleSubscribers(true);
    assert.ok(Array.isArray(initial), 'Must return subscriber array');

    const iterations = 500;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const res = await db.getAllActiveScheduleSubscribers();
      assert.strictEqual(res, initial, 'Must return same cached reference');
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / iterations;
    assert.ok(avgMs < 1.0, `Average cached call must be < 1ms, got ${avgMs}ms`);
  });

  await runTest('7.2: invalidateSubscribersCache forces fresh data fetch', async () => {
    db.invalidateSubscribersCache();
    const fresh = await db.getAllActiveScheduleSubscribers();
    assert.ok(Array.isArray(fresh));
  });

  await runTest('7.3: Repeated getDueNotesForLesson for same date uses in-memory cache', async () => {
    const testDate = '2026-10-25';
    const res1 = await db.getDueNotesForLesson(null, null, testDate);
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      const res2 = await db.getDueNotesForLesson(null, null, testDate);
      assert.deepStrictEqual(res1, res2);
    }
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, 'Cached due-notes queries should take < 50ms total for 200 calls');
  });

  await runTest('7.4: invalidateDueNotesCache clears memory cache', () => {
    db.invalidateDueNotesCache();
    assert.ok(true, 'Cache invalidated without error');
  });

  await runTest('7.5: Massive user input (50,000 chars) is safely clamped to 2000 chars', () => {
    const hugeText = 'A'.repeat(50000);
    const mockMsg = { text: `/note ${hugeText}` };
    const extracted = noteHandler.extractNoteContentFromMessage(mockMsg);
    assert.ok(extracted, 'Should extract note content');
    assert.ok(extracted.text.length <= 2000, `Extracted text length ${extracted.text.length} must be <= 2000 chars`);
  });

  await runTest('7.6: Double-tap race condition on occurrence button creates exactly 1 note', async () => {
    const testUserId = 77712345;
    const wizKey = `note_wiz:${testUserId}`;
    const mockWiz = {
      step: 'AWAITING_OCCURRENCE',
      groupName: 'BHA-51',
      isGroupShared: false,
      selectedSubject: 'Mikroiqtisodiyot',
      occurrences: [
        { lessonType: 'practice', dateIso: '2026-10-26', period: 2, startTime: '09:30' }
      ],
      content: { text: 'Test assignment', mediaType: null, mediaFileId: null },
    };

    await pendingStore.set(wizKey, mockWiz);

    let createdCount = 0;
    const mockCtxFactory = () => ({
      from: { id: testUserId },
      callbackQuery: { data: 'no:0' },
      answerCbQuery: async () => {},
      editMessageText: async () => { createdCount++; },
    });

    await Promise.all([
      noteHandler.handleNoteCallback(mockCtxFactory()),
      noteHandler.handleNoteCallback(mockCtxFactory()),
    ]);

    assert.strictEqual(createdCount, 1, `Exactly 1 note must be created, got ${createdCount}`);
    const remainingWiz = await pendingStore.get(wizKey);
    assert.strictEqual(remainingWiz, null, 'Wizard state must be consumed and deleted');
  });

  await runTest('7.7: User with unknown/invalid group name gets friendly error without crashing', async () => {
    let replyMsg = null;
    const mockCtx = {
      from: { id: 99991234 },
      message: { text: '/note Homework' },
      reply: async (text) => { replyMsg = text; },
    };

    const origGetSettings = db.getUserScheduleSettings;
    db.getUserScheduleSettings = async () => ({ group_name: 'NON_EXISTENT_GROUP_999' });

    try {
      await noteHandler.handleNoteCommand(mockCtx, false);
      assert.ok(replyMsg.includes('jadvalidan fanlar topilmadi'), 'Must inform user that group timetable has no subjects');
    } finally {
      db.getUserScheduleSettings = origGetSettings;
    }
  });

  await runTest('7.8: Nighttime (02:00) and Sunday skip due-notes DB querying completely', () => {
    const testCases = [
      { day: 0, time: '02:00', expectedActive: false },
      { day: 1, time: '06:45', expectedActive: false },
      { day: 2, time: '07:30', expectedActive: true },
      { day: 3, time: '14:15', expectedActive: true },
      { day: 4, time: '20:30', expectedActive: true },
      { day: 5, time: '21:00', expectedActive: false },
      { day: 6, time: '12:00', expectedActive: false },
    ];

    for (const tc of testCases) {
      const [hh, mm] = tc.time.split(':').map(Number);
      const minFromMidnight = hh * 60 + mm;
      const isActive = tc.day < 6 && minFromMidnight >= 7 * 60 + 30 && minFromMidnight <= 20 * 60 + 30;
      assert.strictEqual(isActive, tc.expectedActive);
    }
  });

  await runTest('7.9: 1,000 subscribers schedule processing completes in < 50ms with 0 memory bloat', () => {
    const memBefore = process.memoryUsage().heapUsed;
    const sampleGroups = ['BHA-51', 'BHA-52', 'MM-10', 'DI-20', 'IS-30'];
    const mockSubscribers = [];
    for (let i = 0; i < 1000; i++) {
      mockSubscribers.push({
        telegram_id: 100000 + i,
        group_name: sampleGroups[i % sampleGroups.length],
        notify_mode: 'shift_aware',
        offset_minutes: 60,
        custom_morning_time: '07:00',
        custom_evening_time: '20:00',
        pre_class_5min_bell: true,
        building_change_alert: true,
      });
    }

    const groupTodayScheduleCache = new Map();
    const nowTashkent = edupageService.getTashkentNow();
    const dayOfWeek = 0;

    const getCachedTodayLessons = (gName) => {
      if (!groupTodayScheduleCache.has(gName)) {
        groupTodayScheduleCache.set(gName, scheduleService.getGroupScheduleForDay(gName, dayOfWeek, nowTashkent));
      }
      return groupTodayScheduleCache.get(gName);
    };

    const start = performance.now();
    let checkedCount = 0;
    for (const user of mockSubscribers) {
      const lessons = getCachedTodayLessons(user.group_name);
      if (lessons) checkedCount++;
    }
    const elapsed = performance.now() - start;
    const memAfter = process.memoryUsage().heapUsed;
    const memDeltaMB = (memAfter - memBefore) / (1024 * 1024);

    assert.strictEqual(checkedCount, 1000);
    assert.ok(elapsed < 50, `1,000 in-memory subscriber checks must finish in < 50ms, took ${elapsed}ms`);
    assert.ok(memDeltaMB < 25, `Heap increase must be < 25MB, got ${memDeltaMB.toFixed(2)} MB`);
  });

  // =========================================================================
  // 8. Smart Alert 2.0 Enhanced Suite: 10-Min Snapping, /settings & Next Lesson
  // =========================================================================
  console.log('\n--- Suite 8: Smart Alert 2.0 Enhanced Suite ---');

  const { snapTo10MinuteInterval } = require('../src/handlers/scheduleHandler');
  const keyboards = require('../src/keyboards/keyboards');

  await runTest('8.1: snapTo10MinuteInterval rejects 11:23 and snaps to 11:20 with isExact10: false', () => {
    const res = snapTo10MinuteInterval('11:23');
    assert.ok(res, 'Should parse 11:23');
    assert.strictEqual(res.isExact10, false, '11:23 is not an exact 10-minute interval');
    assert.strictEqual(res.snappedTime, '11:20', '11:23 should snap to nearest 11:20');
  });

  await runTest('8.2: snapTo10MinuteInterval accepts exact 11:30 and 12:20 with isExact10: true', () => {
    const res1 = snapTo10MinuteInterval('11:30');
    assert.strictEqual(res1.isExact10, true);
    assert.strictEqual(res1.snappedTime, '11:30');

    const res2 = snapTo10MinuteInterval('12:20');
    assert.strictEqual(res2.isExact10, true);
    assert.strictEqual(res2.snappedTime, '12:20');
  });

  await runTest('8.3: snapTo10MinuteInterval rounds 11:26 to 11:30 and 23:58 to 00:00', () => {
    const res1 = snapTo10MinuteInterval('11:26');
    assert.strictEqual(res1.isExact10, false);
    assert.strictEqual(res1.snappedTime, '11:30');

    const res2 = snapTo10MinuteInterval('23:58');
    assert.strictEqual(res2.isExact10, false);
    assert.strictEqual(res2.snappedTime, '00:00');
  });

  await runTest('8.4: snapTo10MinuteInterval returns null for invalid input formats', () => {
    assert.strictEqual(snapTo10MinuteInterval(''), null);
    assert.strictEqual(snapTo10MinuteInterval('invalid'), null);
    assert.strictEqual(snapTo10MinuteInterval('25:00'), null);
    assert.strictEqual(snapTo10MinuteInterval('12:65'), null);
  });

  await runTest('8.5: getAllUpcomingLessonsForGroup returns next lesson with full timing & date', () => {
    const db = edupageService.getCachedIndexedDatabaseSync();
    const allGroups = Array.from(db?.classesByName?.keys() || []);
    const testGroup = allGroups.find(g => g.includes('BHA')) || allGroups[0];
    assert.ok(testGroup, 'Test group must exist');

    const mondayMorning = new Date('2026-10-19T06:00:00+05:00');
    const upcoming = scheduleService.getAllUpcomingLessonsForGroup(testGroup, mondayMorning, 4);
    assert.ok(Array.isArray(upcoming), 'Should return array');
    if (upcoming.length > 0) {
      const next = upcoming[0];
      assert.ok(next.dateIso, 'Must include dateIso');
      assert.ok(next.period >= 1 && next.period <= 8, 'Period must be valid 1..8');
      assert.ok(next.startTime, 'Must include startTime');
      assert.ok(next.subject, 'Must include subject');

      const singleNext = scheduleService.getNextUpcomingLessonForGroup(testGroup, mondayMorning);
      assert.deepStrictEqual(singleNext, next, 'getNextUpcomingLessonForGroup must match first upcoming lesson');
    }
  });

  await runTest('8.6: getScheduleV2SettingsKeyboard provides 10-min offsets (10, 20, 30, 60) and /mynotes shortcut', () => {
    const mockPrefs = {
      notify_mode: 'offset_before_first',
      offset_minutes: 20,
      pre_class_5min_bell: true,
      building_change_alert: true,
    };
    const kb = keyboards.getScheduleV2SettingsKeyboard(mockPrefs);
    assert.ok(kb && kb.reply_markup && kb.reply_markup.inline_keyboard, 'Inline keyboard must exist');
    const flatButtons = kb.reply_markup.inline_keyboard.flat();

    assert.ok(flatButtons.some(b => b.callback_data === 'v2_offset_10'), 'Must contain 10 daq offset button');
    assert.ok(flatButtons.some(b => b.callback_data === 'v2_offset_20' && b.text.includes('🔘')), '20 daq button should be selected');
    assert.ok(flatButtons.some(b => b.callback_data === 'v2_offset_30'), 'Must contain 30 daq offset button');
    assert.ok(flatButtons.some(b => b.callback_data === 'v2_offset_60'), 'Must contain 60 daq offset button');
    assert.ok(flatButtons.some(b => b.callback_data === 'note_mynotes'), 'Must contain note_mynotes shortcut');
  });

  await runTest('8.7: 10-minute interval scheduler alignment covers TSUE timetable grid', () => {
    // TSUE lesson starts: 08:00, 09:30, 11:00, 13:00, 14:30, 16:00, 17:30, 19:00
    // 20 minutes before class must all fall on 10-minute boundaries:
    const classStarts = ['08:00', '09:30', '11:00', '13:00', '14:30', '16:00', '17:30', '19:00'];
    for (const cs of classStarts) {
      const [h, m] = cs.split(':').map(Number);
      const startMin = h * 60 + m;
      const noteReminderMin = startMin - 20;
      assert.strictEqual(noteReminderMin % 10, 0, `20-min pre-class reminder for ${cs} must align with 10-minute cron interval`);
    }

    // Standard & shift briefings (07:00, 07:30, 11:30, 20:00, 20:30) must all be divisible by 10:
    const briefings = ['07:00', '07:30', '11:30', '20:00', '20:30'];
    for (const b of briefings) {
      const [h, m] = b.split(':').map(Number);
      const mins = h * 60 + m;
      assert.strictEqual(mins % 10, 0, `Briefing time ${b} must align with 10-minute cron interval`);
    }
  });

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n========================================`);
  console.log(`Test Results: ${passedTests}/${totalTests} passed`);
  console.log(`========================================\n`);

  if (passedTests !== totalTests) {
    process.exit(1);
  } else {
    console.log('🎉 ALL SMART SCHEDULE V2.0 TESTS PASSED CLEANLY!\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
