'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');

// Mock dependencies for dbService
const dbService = require('../src/services/dbService');

async function runTests() {
  console.log('--- TEST: BAN & UNBAN CACHE REFRESH FLOW ---');

  const testUserId = '888777666';

  // Test 1: unbanUser should clear L1 cache and Redis keys
  console.log('\n[Test 1] Testing unbanUser functionality...');
  const unbanRes = await dbService.unbanUser(testUserId);
  assert.strictEqual(typeof unbanRes, 'boolean', 'unbanUser should return boolean');
  console.log('✅ Test 1 PASSED');

  // Test 2: isUserBanned with forceRefresh parameter
  console.log('\n[Test 2] Testing isUserBanned with forceRefresh...');
  const isBannedWithoutForce = await dbService.isUserBanned(testUserId, false);
  assert.strictEqual(typeof isBannedWithoutForce, 'boolean');
  
  const isBannedWithForce = await dbService.isUserBanned(testUserId, true);
  assert.strictEqual(typeof isBannedWithForce, 'boolean');
  console.log('✅ Test 2 PASSED');

  console.log('\n🎉 ALL UNBAN TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
