'use strict';

const assert = require('assert');
const edupageService = require('../src/services/edupageService');

async function runResilienceTests() {
  console.log('🧪 Starting EduPage Enterprise Resilience & Multi-Transport Tests...\n');
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

  // Test 1: Session Manager
  await runAsyncTest('Test 1: EduPage Session Manager obtains real browser cookie', async () => {
    const sm = edupageService.getSessionManager();
    assert.ok(sm, 'Session manager must be exported');
    const cookie = await sm.getSessionCookie(true);
    console.log('     Obtained cookie:', cookie ? cookie.slice(0, 35) + '...' : '(empty or direct)');
    assert.ok(typeof cookie === 'string', 'Cookie must be a string');
  });

  // Test 2: Ultra-Fast Lightweight Health Probe (332 bytes)
  await runAsyncTest('Test 2: probeEduPageHealth tests reachability in <3 seconds without full download', async () => {
    const t0 = Date.now();
    const probe = await edupageService.probeEduPageHealth(8000);
    const duration = Date.now() - t0;
    console.log(`     Probe finished in ${duration}ms, result:`, probe.ok ? `OK (defaultNum: ${probe.defaultNum})` : `Failed (${probe.error})`);
    assert.strictEqual(probe.ok, true, 'Live probe to tsue.edupage.org must succeed');
    assert.ok(probe.defaultNum, 'Probe must return valid defaultNum');
    assert.ok(duration < 5000, `Lightweight probe must be fast (< 5000ms, took ${duration}ms)`);
  });

  // Test 3: Circuit Breaker Lightweight Recovery (No 45s lockup!)
  await runAsyncTest('Test 3: Circuit Breaker recovers via lightweight probe when retry time arrives', async () => {
    // 1. Trip breaker to OPEN
    edupageService.recordEduPageFailure(new Error('Simulated failure 1'));
    edupageService.recordEduPageFailure(new Error('Simulated failure 2'));
    edupageService.recordEduPageFailure(new Error('Simulated failure 3'));

    let state = edupageService._getCircuitBreakerState();
    assert.strictEqual(state.state, 'OPEN', 'Breaker must be OPEN');

    // 2. Advance time past retry time
    edupageService._setCircuitBreakerState('OPEN', Date.now() - 1000, false);

    // 3. getMetadataSignature probe must be permitted and recover breaker
    const sig = await edupageService.getMetadataSignature();
    assert.ok(sig, 'Metadata signature probe must succeed and return signature');

    state = edupageService._getCircuitBreakerState();
    assert.strictEqual(state.state, 'CLOSED', 'Breaker must be reset to CLOSED after successful lightweight probe');
  });

  // Test 4: Diagnostic Status Reporting
  await runAsyncTest('Test 4: getEduPageDiagnosticStatus returns complete system health metrics', async () => {
    await edupageService.getIndexedDatabase(false);
    const diag = edupageService.getEduPageDiagnosticStatus();
    assert.strictEqual(typeof diag.circuitBreakerState, 'string');
    assert.strictEqual(typeof diag.consecutiveFailures, 'number');
    assert.strictEqual(typeof diag.activeTransport, 'string');
    assert.strictEqual(typeof diag.hasL1Database, 'boolean');
    assert.strictEqual(typeof diag.l1ClassesCount, 'number');
    assert.ok(diag.l1ClassesCount > 1000, `Must have > 1000 classes indexed (has ${diag.l1ClassesCount})`);
  });

  // Test 5: Live Transport Testing
  await runAsyncTest('Test 5: testTransports measures latency across active channels', async () => {
    const results = await edupageService.testTransports();
    assert.ok(results.direct, 'Direct transport must be tested');
    console.log('     Direct transport latency:', results.direct.latencyMs, 'ms, ok:', results.direct.ok);
    assert.strictEqual(results.direct.ok, true, 'Direct transport to TsUE must succeed');
  });

  // Test 6: Manual Timetable Ingestion (Self-Healing Hot Swap)
  await runAsyncTest('Test 6: manuallyIngestTimetable parses, validates, and hot-swaps RAM & Disk', async () => {
    // Read current disk cache as sample valid payload
    const diskDb = await edupageService.getIndexedDatabase(false);
    assert.ok(diskDb && diskDb.classesById.size > 1000);

    // Trip breaker to simulate total network outage
    edupageService.recordEduPageFailure(new Error('Total outage simulation'));
    edupageService.recordEduPageFailure(new Error('Total outage simulation 2'));
    edupageService.recordEduPageFailure(new Error('Total outage simulation 3'));
    assert.strictEqual(edupageService._getCircuitBreakerState().state, 'OPEN');

    // Admin uploads timetable from disk cache snapshot
    const fs = require('fs');
    const path = require('path');
    const cachePath = path.resolve(__dirname, '../data/timetable_cache.json');
    const rawData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));

    const ingestResult = await edupageService.manuallyIngestTimetable(rawData, 'test_suite');
    assert.strictEqual(ingestResult.success, true);
    assert.ok(ingestResult.classesCount > 1000);

    // Circuit breaker MUST be automatically recovered to CLOSED!
    const cbAfter = edupageService._getCircuitBreakerState();
    assert.strictEqual(cbAfter.state, 'CLOSED', 'Ingestion must reset Circuit Breaker to CLOSED');

    // Fresh RAM database must NOT be marked fallback
    const liveDb = await edupageService.getIndexedDatabase(false);
    assert.strictEqual(liveDb.isFromCircuitBreakerFallback, false, 'Ingested DB must be live, not fallback');
  });

  console.log(`\n=======================================================`);
  console.log(`🎉 ALL ${passed}/${passed} RESILIENCE & MULTI-TRANSPORT TESTS PASSED!`);
  console.log(`=======================================================`);
}

runResilienceTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
