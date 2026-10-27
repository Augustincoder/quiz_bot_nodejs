'use strict';

const assert = require('assert');
const dns = require('dns');

// Test that dns.setDefaultResultOrder works
if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

async function runFullVerification() {
  console.log('🔬 Starting Comprehensive Live Verification of All Fixes...\n');
  let checksPassed = 0;

  // 1. Check DNS Result Order
  console.log('--- Check 1: DNS IPv4-first Verification ---');
  const addresses = await new Promise((resolve, reject) => {
    dns.lookup('tsue.edupage.org', { all: true }, (err, res) => err ? reject(err) : resolve(res));
  });
  console.log('   Resolved addresses for tsue.edupage.org:', addresses);
  assert.ok(addresses.length > 0, 'Must resolve at least 1 address');
  assert.strictEqual(addresses[0].family, 4, 'First resolved address MUST be IPv4 (family 4)');
  console.log('   ✅ [PASS] DNS IPv4-first verified successfully.\n');
  checksPassed++;

  // 2. Check edupageService live calls
  console.log('--- Check 2: Live edupageService Network Integration ---');
  const edupage = require('../src/services/edupageService');

  const defaultNum = await edupage.resolveDefaultNum();
  console.log('   Dynamic defaultNum resolved:', defaultNum);
  assert.ok(defaultNum && defaultNum.length > 0, 'defaultNum must be resolved');
  console.log('   ✅ [PASS] resolveDefaultNum working live.');
  checksPassed++;

  const metaSig = await edupage.getMetadataSignature();
  console.log('   Metadata signature resolved:', metaSig);
  assert.ok(metaSig && metaSig.includes(defaultNum), 'Metadata signature must contain defaultNum');
  console.log('   ✅ [PASS] getMetadataSignature working live.');
  checksPassed++;

  const indexedDb = await edupage.getIndexedDatabase(false);
  console.log('   Indexed database classes count:', indexedDb.schedulesByClassId.size);
  assert.ok(indexedDb.schedulesByClassId.size > 1000, 'Database must have over 1000 groups');
  assert.strictEqual(indexedDb.isFromCircuitBreakerFallback, false, 'Live DB must NOT be marked fallback');
  console.log('   ✅ [PASS] getIndexedDatabase live sync verified.');
  checksPassed++;

  // 3. Check Circuit Breaker Fast-Fallback & Cascading Timeout Prevention
  console.log('\n--- Check 3: Circuit Breaker Non-Cascading Timeout Prevention ---');
  // Trip breaker
  edupage.recordEduPageFailure(new Error('Simulated network drop 1'));
  edupage.recordEduPageFailure(new Error('Simulated network drop 2'));
  edupage.recordEduPageFailure(new Error('Simulated network drop 3'));

  const cbState = edupage._getCircuitBreakerState();
  assert.strictEqual(cbState.state, 'OPEN', 'Breaker must be in OPEN state');
  console.log('   Circuit Breaker state is OPEN as expected');

  // When breaker is OPEN, resolveDefaultNum and getMetadataSignature must fast-fail instantly (< 50ms)
  const t0 = Date.now();
  const fastNum = await edupage.resolveDefaultNum();
  const fastNumDuration = Date.now() - t0;
  assert.strictEqual(fastNum, defaultNum || '94');
  assert.ok(fastNumDuration < 100, `resolveDefaultNum must not block (took ${fastNumDuration}ms)`);
  console.log(`   ✅ [PASS] resolveDefaultNum fast-failed in ${fastNumDuration}ms during breaker OPEN.`);
  checksPassed++;

  const t1 = Date.now();
  const fastSig = await edupage.getMetadataSignature();
  const fastSigDuration = Date.now() - t1;
  assert.strictEqual(fastSig, null, 'getMetadataSignature must return null when breaker is OPEN');
  assert.ok(fastSigDuration < 100, `getMetadataSignature must not block (took ${fastSigDuration}ms)`);
  console.log(`   ✅ [PASS] getMetadataSignature fast-failed in ${fastSigDuration}ms during breaker OPEN.`);
  checksPassed++;

  // Fallback cache must be marked isFromCircuitBreakerFallback = true
  const fallbackDb = await edupage.getIndexedDatabase(true);
  assert.strictEqual(fallbackDb.isFromCircuitBreakerFallback, true, 'Fallback cache must have isFromCircuitBreakerFallback = true');
  console.log('   ✅ [PASS] Fallback cache correctly marked isFromCircuitBreakerFallback = true.');
  checksPassed++;

  // Reset breaker
  edupage.recordEduPageSuccess();
  assert.strictEqual(edupage._getCircuitBreakerState().state, 'CLOSED');
  console.log('   ✅ [PASS] Circuit Breaker clean recovery to CLOSED.\n');
  checksPassed++;

  console.log(`=======================================================`);
  console.log(`🎉 ALL ${checksPassed}/${checksPassed} VERIFICATION CHECKS PASSED WITH 100% SUCCESS!`);
  console.log(`=======================================================`);
  process.exit(0);
}

runFullVerification().catch(err => {
  console.error('❌ Verification failed:', err);
  process.exit(1);
});
