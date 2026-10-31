'use strict';

const assert = require('assert');
const scheduleWatcher = require('../src/services/scheduleWatcherService');

async function runTests() {
  console.log('🧪 Starting Watcher Gatekeeper (2 Skips Max -> Deep Check) & Broadcast Tests...\n');

  // Check 1: Watcher initial check establishes baseline
  console.log('--- Test 1: Baseline Establishment ---');
  const res1 = await scheduleWatcher.checkScheduleChanges(true);
  assert.strictEqual(res1.checked, true, 'res1 should be checked');
  const status1 = scheduleWatcher.getWatcherStatus();
  assert.strictEqual(status1.isBaselineReady, true, 'Baseline must be ready');
  assert.ok(status1.lastKnownSignature, 'lastKnownSignature must be set on baseline');
  console.log(`  ✅ Baseline ready with ${status1.trackedGroupsCount} tracked groups (sig=${status1.lastKnownSignature}, rawHash=${status1.lastEvaluatedRawHash})`);

  // Check 2: Gatekeeper 1st skip
  console.log('\n--- Test 2: Gatekeeper Probe (Skip 1) ---');
  const res2 = await scheduleWatcher.checkScheduleChanges(false);
  const status2 = scheduleWatcher.getWatcherStatus();
  assert.strictEqual(res2.reason, 'tier1_signature_match', 'First check must be tier1_signature_match');
  assert.strictEqual(status2.consecutiveTier1Skips, 1, 'consecutiveTier1Skips must be 1 on first skip');
  console.log(`  ✅ Tier 1 skip #1 confirmed (consecutiveTier1Skips=${status2.consecutiveTier1Skips})`);

  // Check 3: Gatekeeper 2nd skip
  console.log('\n--- Test 3: Gatekeeper Probe (Skip 2) ---');
  const res3 = await scheduleWatcher.checkScheduleChanges(false);
  const status3 = scheduleWatcher.getWatcherStatus();
  assert.strictEqual(res3.reason, 'tier1_signature_match', 'Second check must be tier1_signature_match');
  assert.strictEqual(status3.consecutiveTier1Skips, 2, 'consecutiveTier1Skips must be 2 on second skip');
  console.log(`  ✅ Tier 1 skip #2 confirmed (consecutiveTier1Skips=${status3.consecutiveTier1Skips})`);

  // Check 4: 3rd call MUST force Full Deep Check (Tier 2) because max 2 skips reached!
  console.log('\n--- Test 4: Escalation to Tier 2 Deep Check after 2 skips ---');
  const prevDeepCount = status3.deepChecksCount;
  const res4 = await scheduleWatcher.checkScheduleChanges(false);
  const status4 = scheduleWatcher.getWatcherStatus();
  assert.notStrictEqual(res4.reason, 'tier1_signature_match', 'Must NOT be skipped via tier1 on 3rd call');
  assert.strictEqual(status4.consecutiveTier1Skips, 0, 'consecutiveTier1Skips must be reset to 0 after deep check');
  assert.strictEqual(status4.deepChecksCount, prevDeepCount + 1, 'Deep check count must increment');
  console.log(`  ✅ Successfully escalated to Tier 2 Deep Check! (deepChecksCount=${status4.deepChecksCount}, consecutiveSkips reset to ${status4.consecutiveTier1Skips})`);

  // Check 5: Semantic Diff Detection for affected group (e.g. BHA-51k/24)
  console.log('\n--- Test 5: Semantic Diff for BHA-51k/24 scenario ---');
  const oldSched = {
    0: {
      1: [{ subject: 'Matematika', room: '101', teacher: 'Aliyev A.' }],
      2: [{ subject: 'Fizika', room: '102', teacher: 'Valiyev B.' }],
    },
  };
  const newSched = {
    0: {
      1: [{ subject: 'Matematika', room: '205', teacher: 'Aliyev A.' }], // Room changed
      2: [{ subject: 'Informatika', room: '102', teacher: 'Karimov K.' }], // Subject & teacher changed
    },
  };

  const diffs = scheduleWatcher.diffGroupSchedules(oldSched, newSched);
  assert.strictEqual(diffs.length >= 2, true, 'Should detect at least 2 changes');
  console.log(`  ✅ Detected ${diffs.length} schedule diffs accurately`);

  const alertMessage = scheduleWatcher.formatChangeAlert('BHA-51k/24', diffs);
  assert.strictEqual(alertMessage.includes('BHA-51k/24'), true, 'Alert must include group name');
  assert.strictEqual(alertMessage.includes('Xona o\'zgardi'), true, 'Alert must mention room change');
  console.log('  ✅ Formatted HTML alert is student-friendly and contains exact diff details');

  console.log('\n======================================================');
  console.log('🎉 ALL GATEKEEPER & BROADCAST TESTS PASSED (5/5)!');
  console.log('======================================================');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
