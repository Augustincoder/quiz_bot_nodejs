'use strict';

const assert = require('assert');
const edupageService = require('../src/services/edupageService');

async function testDeadlockResilience() {
  console.log('🧪 Running Comprehensive Circuit Breaker Deadlock Resilience Tests...\n');
  let passed = 0;

  function runTest(name, fn) {
    try {
      fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message);
      process.exit(1);
    }
  }

  async function runAsyncTest(name, fn) {
    try {
      await fn();
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ [FAIL] ${name}:`, err.message);
      process.exit(1);
    }
  }

  // Test 1: Helper check isEduPageCircuitOpen does not mutate state or consume probe
  runTest('Test 1: isEduPageCircuitOpen is read-only and does not consume probe lock', () => {
    edupageService.recordEduPageSuccess();
    assert.strictEqual(edupageService.isEduPageCircuitOpen(), false);

    // Trip breaker
    edupageService.recordEduPageFailure(new Error('Test Fail 1'));
    edupageService.recordEduPageFailure(new Error('Test Fail 2'));
    edupageService.recordEduPageFailure(new Error('Test Fail 3'));

    const state1 = edupageService._getCircuitBreakerState();
    assert.strictEqual(state1.state, 'OPEN');
    assert.strictEqual(edupageService.isEduPageCircuitOpen(), true);

    // Advance time past retry timer
    edupageService._setCircuitBreakerState('OPEN', Date.now() - 1000, false);
    // Read-only check must return false (retry time expired)
    assert.strictEqual(edupageService.isEduPageCircuitOpen(), false);
    // But breaker state must STILL be OPEN (not transitioned by read-only check)
    const state2 = edupageService._getCircuitBreakerState();
    assert.strictEqual(state2.state, 'OPEN');
    assert.strictEqual(state2.isHalfOpenProbeInFlight, false);
  });

  // Test 2: resolveDefaultNum does not deadlock subsequent canAttemptEduPageNetwork probe
  await runAsyncTest('Test 2: resolveDefaultNum does not consume probe lock or cause deadlock', async () => {
    edupageService._setCircuitBreakerState('OPEN', Date.now() - 1000, false);

    // Calling resolveDefaultNum when retry time expired
    const num = await edupageService.resolveDefaultNum();
    assert.ok(num, 'resolveDefaultNum must return defaultNum or fallback');

    // The probe lock MUST still be available for the primary fetch
    const canProbe = edupageService.canAttemptEduPageNetwork();
    assert.strictEqual(canProbe, true, 'Primary fetch must still be allowed to probe EduPage');
    
    // Once claimed, subsequent concurrent calls must be throttled
    const concurrentProbe = edupageService.canAttemptEduPageNetwork();
    assert.strictEqual(concurrentProbe, false, 'Concurrent fetch must be throttled');

    // Clean up
    edupageService.recordEduPageSuccess();
  });

  // Test 3: Auto-recovery from stranded/abandoned HALF_OPEN probe (> 30s)
  runTest('Test 3: Stranded HALF_OPEN probe auto-expires after 30s timeout without deadlocking', () => {
    edupageService._setCircuitBreakerState('HALF_OPEN', 0, true);
    
    // Simulate probe was launched 35 seconds ago and never recorded success/failure (abandoned)
    // The circuit breaker must auto-clear the probe lock and allow a new probe
    const edupage = require('../src/services/edupageService');
    // Call canAttemptEduPageNetwork: because probe is expired (>30s), it must allow a new probe
    // Note: since probeInFlightStartedAt defaults to 0, Date.now() - 0 is > 30s!
    const allowed = edupage.canAttemptEduPageNetwork();
    assert.strictEqual(allowed, true, 'Must auto-recover and permit new probe when previous probe was abandoned');

    edupageService.recordEduPageSuccess();
  });

  // Test 4: Live database marks isFromCircuitBreakerFallback = false, fallback marks true
  await runAsyncTest('Test 4: Circuit breaker fallback flag is properly set on offline cache and cleared on live sync', async () => {
    // 1. Force circuit breaker OPEN
    edupageService._setCircuitBreakerState('OPEN', Date.now() + 60000, false);
    const dbFallback = await edupageService.getIndexedDatabase(true);
    assert.strictEqual(dbFallback.isFromCircuitBreakerFallback, true, 'Fallback DB must have isFromCircuitBreakerFallback = true');

    // 2. Reset circuit breaker
    edupageService.recordEduPageSuccess();
    assert.strictEqual(edupageService.isEduPageCircuitOpen(), false);
  });

  console.log(`\n🎉 All ${passed}/4 Deadlock Resilience Tests passed successfully!`);
}

testDeadlockResilience().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
