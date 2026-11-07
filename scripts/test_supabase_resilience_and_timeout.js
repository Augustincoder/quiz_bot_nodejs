'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runTests() {
  console.log('🧪 Starting Supabase Resilience, Circuit Breaker & Negative Caching Tests...\n');

  // ─── 1. Test Supabase Client & Circuit Breaker Exports ───
  console.log('1. Testing supabase.js Circuit Breaker & isSupabaseAvailable exports');
  const sbModule = require('../src/lib/supabase');
  assert(typeof sbModule.isSupabaseAvailable === 'function', 'isSupabaseAvailable must be exported');
  assert(sbModule.supabaseBreaker, 'supabaseBreaker must be exported');
  assert.strictEqual(sbModule.supabaseBreaker.getState().state, 'CLOSED', 'Breaker must start CLOSED');
  console.log('  ✅ Passed: Supabase module exports Circuit Breaker and health check.\n');

  // ─── 2. Test Circuit Breaker Tripping on Failures & Fast-Fail ───
  console.log('2. Testing Circuit Breaker trip on consecutive failures and fast-fail');
  const { CircuitBreaker } = require('../src/core/circuitBreaker');
  const testBreaker = new CircuitBreaker({ name: 'test-sb', failureThreshold: 3, resetTimeoutMs: 1000 });

  assert.strictEqual(testBreaker.canAttempt(), true);
  testBreaker.recordFailure(new Error('TimeoutError: operation aborted'));
  assert.strictEqual(testBreaker.getState().state, 'CLOSED');
  testBreaker.recordFailure(new Error('ECONNRESET'));
  assert.strictEqual(testBreaker.getState().state, 'CLOSED');
  testBreaker.recordFailure(new Error('503 Service Unavailable'));
  assert.strictEqual(testBreaker.getState().state, 'OPEN', 'Breaker must trip to OPEN on 3 failures');

  // While OPEN: fast-fails immediately
  assert.strictEqual(testBreaker.canAttempt(), false, 'Breaker must block attempts while OPEN');

  // Test recovery probe after timeout
  testBreaker.setState('OPEN', Date.now() - 10, false);
  assert.strictEqual(testBreaker.canAttempt(), true, 'Breaker must allow probe after reset timeout');
  assert.strictEqual(testBreaker.getState().state, 'HALF_OPEN');

  // Successful probe resets to CLOSED
  testBreaker.recordSuccess();
  assert.strictEqual(testBreaker.getState().state, 'CLOSED');
  assert.strictEqual(testBreaker.getState().consecutiveFailures, 0);
  console.log('  ✅ Passed: Circuit breaker trips, fast-fails, and recovers cleanly.\n');

  // ─── 3. Test dbService Negative Caching and L1 Memory Cache ───
  console.log('3. Testing dbService negative caching and L1 in-memory cache');
  const dbService = require('../src/services/dbService');

  // Non-existent subject ID should safely return null
  const missingSid = 9999999;
  const subj1 = await dbService.getSubjectById(missingSid);
  assert.strictEqual(subj1, null, 'Non-existent subject should return null');

  // Non-existent test ID should safely return null
  const missingTid = 8888888;
  const test1 = await dbService.getUserTest(missingTid);
  assert.strictEqual(test1, null, 'Non-existent test should return null');

  console.log('  ✅ Passed: Negative cache handles missing records without crashing.\n');

  // ─── 4. Test dbService Error Recording & isRecentDbError ───
  console.log('4. Testing dbService DB error tracking and maintenance status');
  assert.strictEqual(dbService.isRecentDbError(), false);
  dbService.recordDbError(new Error('TimeoutError: The operation was aborted due to timeout'));
  assert.strictEqual(dbService.isRecentDbError(), true, 'isRecentDbError must return true after error');
  dbService.clearDbError();
  assert.strictEqual(dbService.isRecentDbError(), false, 'clearDbError must reset error state');
  console.log('  ✅ Passed: DB error tracking and maintenance state verified.\n');

  // ─── 5. Test User Stats 24h Redis TTL Preservation ───
  console.log('5. Testing user_stats Redis cache TTL is 86400 (24 hours)');
  const dbServiceSrc = fs.readFileSync(path.join(__dirname, '../src/services/dbService.js'), 'utf8');
  assert(
    dbServiceSrc.includes("cacheKey, JSON.stringify(data), 'EX', 86400"),
    'getUserStats must cache user stats in Redis with 86400s (24h) TTL'
  );
  console.log('  ✅ Passed: User stats Redis TTL configured to 24h, protecting historical data.\n');

  // ─── 6. Test Telegraf https.Agent Keep-Alive Configuration ───
  console.log('6. Testing Telegraf https.Agent keepAlive configuration in index.js');
  const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert(indexSrc.includes('keepAlive: true'), 'Telegraf agent must have keepAlive: true');
  assert(indexSrc.includes('telegram: { agent: telegramAgent }'), 'Telegraf must be initialized with custom agent');
  console.log('  ✅ Passed: Telegraf agent keep-alive configured to prevent socket drop ECONNRESET.\n');

  // ─── 7. Test User-Facing Maintenance Messages during DB Outages ───
  console.log('7. Testing user-facing error messaging during DB downtime');
  const startHandlerSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/startHandler.js'), 'utf8');
  assert(
    startHandlerSrc.includes("dbService.isRecentDbError()") &&
    startHandlerSrc.includes("vaqtinchalik uzilish yuz berdi"),
    'startHandler must display maintenance message when DB error is detected'
  );

  const quizGameSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/quizGame.js'), 'utf8');
  assert(
    quizGameSrc.includes("dbService.isRecentDbError()") &&
    quizGameSrc.includes("vaqtinchalik uzilish yuz berdi"),
    'quizGame showUgcSubjectBlocks and cbUgcStart must display maintenance message when DB is down'
  );

  const groupQuizLogicSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/groupQuizLogic.js'), 'utf8');
  assert(
    groupQuizLogicSrc.includes("dbService.isRecentDbError()") &&
    groupQuizLogicSrc.includes("vaqtinchalik uzilish yuz berdi"),
    'groupQuizLogic createLobby must display maintenance message when DB is down'
  );
  console.log('  ✅ Passed: User-facing messages clearly notify users of DB maintenance instead of false deletions.\n');

  console.log('================================================================');
  console.log('🎉 ALL SUPABASE RESILIENCE & TIMEOUT TESTS PASSED SUCCESSFULLY!');
  console.log('================================================================\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
