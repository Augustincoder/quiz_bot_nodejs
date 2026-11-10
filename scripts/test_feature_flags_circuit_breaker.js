'use strict';

const assert = require('assert');

async function runTests() {
  console.log('🧪 Starting Circuit Breaker & Auto-Kill Switch Tests...\n');

  const featureFlagService = require('../src/services/featureFlagService');
  const errorReporter = require('../src/services/errorReporterService');

  const {
    STATES,
    isFeatureEnabled,
    isFeatureEnabledSync,
    setFeatureState,
    getFeatureState,
    setAdminList,
    recordFeatureError,
    resetFeatureBreaker,
    getFeatureHealth,
    resetLocalState,
    init,
  } = featureFlagService;

  assert(typeof recordFeatureError === 'function', 'recordFeatureError must be exported from featureFlagService');
  assert(typeof resetFeatureBreaker === 'function', 'resetFeatureBreaker must be exported from featureFlagService');
  assert(typeof getFeatureHealth === 'function', 'getFeatureHealth must be exported from featureFlagService');

  await init();
  resetLocalState();

  const ADMIN_ID = 888888888;
  const REGULAR_USER_ID = 333333333;
  setAdminList([ADMIN_ID]);

  // Capture dispatched alerts from errorReporter
  const dispatchedAlerts = [];
  errorReporter._setMockDispatcher(async (text) => {
    dispatchedAlerts.push(text);
    return true;
  });

  // ─────────────────────────────────────────────────────────────
  // 1. ERRORS BELOW THRESHOLD DO NOT TRIP BREAKER
  // ─────────────────────────────────────────────────────────────
  console.log('1. Testing Errors Below Threshold:');
  {
    const featKey = 'FEAT_BREAK_TEST_1';
    await setFeatureState(featKey, STATES.PUBLIC, { errorThreshold: 3, windowSeconds: 60 });

    assert.strictEqual(isFeatureEnabledSync(featKey, REGULAR_USER_ID), true, 'Feature should initially be PUBLIC');

    // 1st error
    const res1 = recordFeatureError(featKey, new Error('Transient network error 1'));
    assert.strictEqual(res1.tripped, false, '1st error should not trip breaker');
    assert.strictEqual(res1.errorCount, 1, 'Error count should be 1');
    assert.strictEqual(isFeatureEnabledSync(featKey, REGULAR_USER_ID), true, 'Feature should remain enabled');

    // 2nd error
    const res2 = recordFeatureError(featKey, new Error('Transient network error 2'));
    assert.strictEqual(res2.tripped, false, '2nd error should not trip breaker');
    assert.strictEqual(res2.errorCount, 2, 'Error count should be 2');
    assert.strictEqual(isFeatureEnabledSync(featKey, REGULAR_USER_ID), true, 'Feature should remain enabled');

    // Health check
    const health = getFeatureHealth(featKey);
    assert.strictEqual(health.errorCount, 2, 'Health check should report 2 errors');
    assert.strictEqual(health.autoKillTriggered, false, 'autoKillTriggered must be false');
    assert.strictEqual(health.trippedAt, null, 'trippedAt must be null');
    assert.strictEqual(health.trippedReason, null, 'trippedReason must be null');

    console.log('  ✅ Below threshold (2/3): Circuit breaker remains untouched, feature stays active');
  }

  // ─────────────────────────────────────────────────────────────
  // 2. EXCEEDING THRESHOLD TRIPS BREAKER & AUTO-DOWNGRADES TO ADMIN_ONLY
  // ─────────────────────────────────────────────────────────────
  console.log('\n2. Testing Threshold Trip & Auto-Downgrade:');
  {
    const featKey = 'FEAT_BREAK_TEST_1';
    const alertsBefore = dispatchedAlerts.length;

    // 3rd error -> reaches threshold of 3
    const res3 = recordFeatureError(featKey, new Error('Fatal unhandled crash'));
    assert.strictEqual(res3.tripped, true, '3rd error must trip the circuit breaker');
    assert.strictEqual(res3.downgradedTo, STATES.ADMIN_ONLY, 'Must downgrade state to ADMIN_ONLY');
    assert.strictEqual(res3.previousState, STATES.PUBLIC, 'Previous state must be recorded as PUBLIC');
    assert(res3.reason.includes('Fatal unhandled crash'), 'Reason must capture error message');

    // State check
    assert.strictEqual(getFeatureState(featKey), STATES.ADMIN_ONLY, 'State must now be ADMIN_ONLY');

    // Immediate user protection: regular user is blocked
    assert.strictEqual(isFeatureEnabledSync(featKey, REGULAR_USER_ID), false, 'Normal user must be blocked immediately');
    assert.strictEqual(await isFeatureEnabled(featKey, REGULAR_USER_ID), false, 'Async check for regular user must also be false');

    // Admin retains access to test and debug the fix
    assert.strictEqual(isFeatureEnabledSync(featKey, ADMIN_ID), true, 'Admin must retain access to dogfood/fix');

    // Verify emergency alert was dispatched to admin via errorReporter
    assert(dispatchedAlerts.length > alertsBefore, 'Emergency alert must be dispatched to errorReporter');
    const lastAlert = dispatchedAlerts[dispatchedAlerts.length - 1];
    assert(lastAlert.includes(featKey) || lastAlert.includes('CIRCUIT BREAKER'), 'Alert must reference feature or breaker');

    // Health check verification
    const health = getFeatureHealth(featKey);
    assert.strictEqual(health.autoKillTriggered, true, 'autoKillTriggered must be true in health check');
    assert(typeof health.trippedAt === 'number' && health.trippedAt > 0, 'trippedAt must be a timestamp');
    assert(health.trippedReason.includes('Fatal unhandled crash'), 'trippedReason must match');

    console.log('  ✅ Exceeding threshold (3/3): Breaker tripped, downgraded to ADMIN_ONLY, emergency alert sent');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. CIRCUIT BREAKER RESET & STATE RESTORATION
  // ─────────────────────────────────────────────────────────────
  console.log('\n3. Testing resetFeatureBreaker:');
  {
    const featKey = 'FEAT_BREAK_TEST_1';

    // Reset breaker (should restore previous state PUBLIC)
    const resetRes = resetFeatureBreaker(featKey);
    assert.strictEqual(resetRes.success, true, 'Reset must succeed');
    assert.strictEqual(resetRes.state, STATES.PUBLIC, 'Must restore previous state PUBLIC');
    assert.strictEqual(resetRes.autoKillTriggered, false, 'autoKillTriggered must be reset to false');

    // Check health after reset
    const healthAfter = getFeatureHealth(featKey);
    assert.strictEqual(healthAfter.errorCount, 0, 'Error count must be reset to 0');
    assert.strictEqual(healthAfter.autoKillTriggered, false, 'autoKillTriggered must be false');
    assert.strictEqual(healthAfter.trippedAt, null, 'trippedAt must be cleared');
    assert.strictEqual(healthAfter.trippedReason, null, 'trippedReason must be cleared');

    // Normal user access restored
    assert.strictEqual(isFeatureEnabledSync(featKey, REGULAR_USER_ID), true, 'Normal user access must be restored');

    // Reset with explicit target state
    resetFeatureBreaker(featKey, STATES.BETA_USERS);
    assert.strictEqual(getFeatureState(featKey), STATES.BETA_USERS, 'Reset with explicit state must set that state');

    console.log('  ✅ resetFeatureBreaker: Cleanly restores state, clears error counts, unlocks users');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. SLIDING-WINDOW EXPIRATION (TIME PRUNING)
  // ─────────────────────────────────────────────────────────────
  console.log('\n4. Testing Sliding-Window Time Pruning:');
  {
    const featKey = 'FEAT_WINDOW_EXPIRY';
    await setFeatureState(featKey, STATES.PUBLIC);

    // Record error with 1 second window
    recordFeatureError(featKey, new Error('Error 1'), { errorThreshold: 2, windowSeconds: 1 });
    assert.strictEqual(getFeatureHealth(featKey).errorCount, 1, 'Error count should be 1');

    // Wait 1.1s for window to expire
    await new Promise(r => setTimeout(r, 1100));

    // Next error occurs after window expired, so errorCount should be 1 again, NOT 2
    const res = recordFeatureError(featKey, new Error('Error 2'), { errorThreshold: 2, windowSeconds: 1 });
    assert.strictEqual(res.tripped, false, 'Old error should have expired, so breaker must not trip');
    assert.strictEqual(res.errorCount, 1, 'Count should be 1 after previous error expired');

    console.log('  ✅ Sliding window: Old errors pruned cleanly outside window, avoiding false trips');
  }

  // ─────────────────────────────────────────────────────────────
  // 5. INTEGRATION WITH errorReporterService.report({ featureKey })
  // ─────────────────────────────────────────────────────────────
  console.log('\n5. Testing errorReporterService.report({ featureKey }) Integration:');
  {
    const featKey = 'FEAT_ERROR_REPORTER_INTEGRATION';
    await setFeatureState(featKey, STATES.PUBLIC, { errorThreshold: 3, windowSeconds: 60 });

    assert.strictEqual(isFeatureEnabledSync(featKey, REGULAR_USER_ID), true);

    // Call errorReporter.report with context.featureKey
    await errorReporter.report(new Error('Crash A'), { featureKey: featKey });
    await errorReporter.report(new Error('Crash B'), { featureKey: featKey });
    assert.strictEqual(isFeatureEnabledSync(featKey, REGULAR_USER_ID), true, 'Still enabled at 2 errors');

    // 3rd error triggers circuit breaker through errorReporter.report
    await errorReporter.report(new Error('Crash C'), { featureKey: featKey });

    assert.strictEqual(getFeatureState(featKey), STATES.ADMIN_ONLY, 'Breaker should trip via errorReporter.report');
    assert.strictEqual(isFeatureEnabledSync(featKey, REGULAR_USER_ID), false, 'Normal user blocked after 3rd error');

    const health = getFeatureHealth(featKey);
    assert.strictEqual(health.autoKillTriggered, true, 'autoKillTriggered must be true');

    console.log('  ✅ errorReporterService: context.featureKey automatically trips circuit breaker');
  }

  // ─────────────────────────────────────────────────────────────
  // 6. CUSTOM TARGET STATE (DOWNGRADE TO OFF)
  // ─────────────────────────────────────────────────────────────
  console.log('\n6. Testing Custom Target State (Downgrade to OFF):');
  {
    const featKey = 'FEAT_KILL_TO_OFF';
    await setFeatureState(featKey, STATES.PUBLIC);

    const trip = recordFeatureError(featKey, new Error('Critical vulnerability'), {
      errorThreshold: 1,
      targetState: STATES.OFF,
    });

    assert.strictEqual(trip.tripped, true);
    assert.strictEqual(trip.downgradedTo, STATES.OFF);
    assert.strictEqual(getFeatureState(featKey), STATES.OFF);

    // When state is OFF, even admin is disabled
    assert.strictEqual(isFeatureEnabledSync(featKey, ADMIN_ID), false, 'Even admin must be disabled when downgraded to OFF');

    console.log('  ✅ Custom targetState: Downgrade to OFF safely disables for all users including admins');
  }

  console.log('\n🎉 ALL CIRCUIT BREAKER TESTS COMPLETED SUCCESSFULLY!\n');
}

runTests().catch(err => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
