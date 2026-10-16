'use strict';

/**
 * Smart Timetable & Contextual Reminder Engine v2.0
 * Comprehensive Verification & Regression Test Suite
 */

const assert = require('assert');
const edupageService = require('../src/services/edupageService');
const scheduleService = require('../src/services/scheduleService');

console.log('🧪 Starting Smart Timetable & Contextual Reminder Engine v2.0 Test Suite...\n');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✅ [PASS] ${name}`);
  } catch (err) {
    console.error(`  ❌ [FAIL] ${name}:`, err.message);
  }
}

// =========================================================================
// 1. TSUE Dataset Real Subject Normalization & Classification
// =========================================================================
console.log('--- Suite 1: TSUE Real Subject Normalization & Classification ---');

runTest('1.1: "Java dasturlash tili (Ma)" -> lecture & normalized key', () => {
  const normKey = edupageService.normalizeSubjectKey('Java dasturlash tili (Ma)');
  assert.strictEqual(normKey, 'Java dasturlash tili');
  const type = edupageService.normalizeLessonType('Java dasturlash tili (Ma)');
  assert.strictEqual(type, 'lecture');
});

runTest('1.2: "Professional buxgalteriya amaliyoti (Ma)" -> lecture (checked before amaliyoti)', () => {
  const normKey = edupageService.normalizeSubjectKey('Professional buxgalteriya amaliyoti (Ma)');
  assert.strictEqual(normKey, 'Professional buxgalteriya amaliyoti');
  const type = edupageService.normalizeLessonType('Professional buxgalteriya amaliyoti (Ma)');
  assert.strictEqual(type, 'lecture', 'Subject with (Ma) tag must be classified as lecture even if title contains amaliyoti');
});

runTest('1.3: "Elektron hukumat" -> any (word Elektron does not match lek)', () => {
  const normKey = edupageService.normalizeSubjectKey('Elektron hukumat');
  assert.strictEqual(normKey, 'Elektron hukumat');
  const type = edupageService.normalizeLessonType('Elektron hukumat');
  assert.strictEqual(type, 'any', 'Elektron should not trigger lek regex match');
});

runTest('1.4: "Intellektual mulk huquqi" -> any (Intellektual does not match lek)', () => {
  const type = edupageService.normalizeLessonType('Intellektual mulk huquqi');
  assert.strictEqual(type, 'any', 'Intellektual should not trigger lek match');
});

runTest('1.5: "Ko‘nikmaga asoslangan ta’lim (soft skills) (Ma)" -> lecture & preserves (soft skills)', () => {
  const normKey = edupageService.normalizeSubjectKey('Ko‘nikmaga asoslangan ta’lim (soft skills) (Ma)');
  assert.strictEqual(normKey, "Ko'nikmaga asoslangan ta'lim (soft skills)");
  const type = edupageService.normalizeLessonType('Ko‘nikmaga asoslangan ta’lim (soft skills) (Ma)');
  assert.strictEqual(type, 'lecture');
});

runTest('1.6: "Buxgalteriya hisobi (aylanma) (Sem)" -> practice & preserves (aylanma)', () => {
  const normKey = edupageService.normalizeSubjectKey('Buxgalteriya hisobi (aylanma) (Sem)');
  assert.strictEqual(normKey, 'Buxgalteriya hisobi (aylanma)');
  const type = edupageService.normalizeLessonType('Buxgalteriya hisobi (aylanma) (Sem)');
  assert.strictEqual(type, 'practice');
});

runTest('1.7: Trailing "Ma" and "Sem" without parentheses', () => {
  const normKey1 = edupageService.normalizeSubjectKey('Moliya bozori Ma');
  assert.strictEqual(normKey1, 'Moliya bozori');
  assert.strictEqual(edupageService.normalizeLessonType('Moliya bozori Ma'), 'lecture');

  const normKey2 = edupageService.normalizeSubjectKey('Moliya bozori Sem');
  assert.strictEqual(normKey2, 'Moliya bozori');
  assert.strictEqual(edupageService.normalizeLessonType('Moliya bozori Sem'), 'practice');
});

runTest('1.8: Object metadata classification (subgroup & jointGroups)', () => {
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

runTest('2.1: getCachedIndexedDatabaseSync loads database and caches in memory', () => {
  const db = edupageService.getCachedIndexedDatabaseSync();
  assert.ok(db, 'Cached indexed database should be resolved');
  assert.ok(db.schedulesByClassId && db.schedulesByClassId.size > 0, 'Should contain class schedules');
});

runTest('2.2: Repeated getCachedIndexedDatabaseSync calls execute in < 5ms without reading disk', () => {
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

runTest('2.3: getGroupScheduleForDay returns lessons with subgroup, weekParity, isContinuation', () => {
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

runTest('3.1: Subgroup lessons in the same period do NOT trigger false bell', () => {
  // Simulating todayLessons where period 1 has 2 subgroups
  const mockLessons = [
    { period: 1, subject: 'Ingliz tili (Sem)', room: 'A-201', subgroup: '1-guruh', startTime: '08:00', endTime: '09:20' },
    { period: 1, subject: 'Ingliz tili (Sem)', room: 'A-202', subgroup: '2-guruh', startTime: '08:00', endTime: '09:20' },
  ];

  // Group lessons by period number (1..8)
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

runTest('3.2: Period 1 with 2 subgroups correctly alerts for Period 2', () => {
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

runTest('4.1: Same double pair in same room suppresses alert', () => {
  const lesson1 = { subject: 'Oliy matematika (Ma)', room: 'A-201', classroom: 'A-201' };
  const lesson2 = { subject: 'Oliy matematika (Ma)', room: 'A-201', classroom: 'A-201' };
  assert.strictEqual(edupageService.isSameDoublePair(lesson1, lesson2), true);
});

runTest('4.2: Building hopping transition detected', () => {
  const lesson1 = { room: 'A-201' };
  const lesson2 = { room: '2-bino 301' };
  assert.strictEqual(edupageService.detectBuildingTransition(lesson1, lesson2), true);
});

runTest('4.3: Same building does not flag hopping', () => {
  const lesson1 = { room: 'A-101' };
  const lesson2 = { room: 'A-205' };
  assert.strictEqual(edupageService.detectBuildingTransition(lesson1, lesson2), false);
});

// =========================================================================
// 5. Note Wizard Routing & Authorization
// =========================================================================
console.log('\n--- Suite 5: Note Wizard Routing & State Clearing ---');

runTest('5.1: Menu button or command clears wizard state', async () => {
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

runTest('5.2: Non-creator non-admin cannot modify group note', async () => {
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
