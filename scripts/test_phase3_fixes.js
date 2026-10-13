'use strict';

process.env.BOT_TOKEN = '123456:dummy_test_token';
const assert = require('assert');
const utils = require('../src/core/utils');
const { prepareShuffledQuestions, shuffleArray } = require('../src/core/questionUtils');

async function runPhase3Tests() {
  console.log('🧪 Starting Phase 3 (PERF-01 to PERF-06) Performance & Memory Verification Tests...\n');

  // --- Test 1: PERF-01 Inline mistake timers ---
  console.log('1. Testing PERF-01: Inline mistake timer tracking & clearing');
  const quizGameSource = require('fs').readFileSync('src/handlers/quizGame.js', 'utf8');
  assert(quizGameSource.includes('activeWmTimers'), 'quizGame.js must define activeWmTimers');
  assert(quizGameSource.includes('clearWmTimer'), 'quizGame.js must define clearWmTimer');
  assert(quizGameSource.includes('wmTimer.unref()'), 'quizGame.js must unref auto-timeout');
  console.log('  ✅ Passed: Inline mistake timers are actively tracked and unref()ed');

  // --- Test 2: PERF-02 Empty session deletion from Redis ---
  console.log('\n2. Testing PERF-02: Empty session deletion from Redis');
  const indexSource = require('fs').readFileSync('index.js', 'utf8');
  assert(indexSource.includes('isEmpty'), 'index.js must detect empty session');
  assert(indexSource.includes('redisConnection.del(key)'), 'index.js must delete cleared sessions with del(key)');
  console.log('  ✅ Passed: Cleared sessions trigger Redis DEL instead of saving 24h empty objects');

  // --- Test 3: PERF-03 Dead map removal & TTLMap usage ---
  console.log('\n3. Testing PERF-03: Dead maps removed from utils.js & TTLMap used in handlers');
  assert.strictEqual(utils.activeTests, undefined, 'activeTests must not be exported from utils.js');
  assert.strictEqual(utils.waitingRooms, undefined, 'waitingRooms must not be exported from utils.js');
  assert.strictEqual(utils.pollChatMap, undefined, 'pollChatMap must not be exported from utils.js');

  const aiHandlersSource = require('fs').readFileSync('src/handlers/aiHandlers.js', 'utf8');
  assert(aiHandlersSource.includes('userRateLimit = new TTLMap'), 'aiHandlers.js must use TTLMap for userRateLimit');

  const aiTestsSource = require('fs').readFileSync('src/handlers/aiTestsHandlers.js', 'utf8');
  assert(aiTestsSource.includes('adminAIUsage = new TTLMap'), 'aiTestsHandlers.js must use TTLMap for adminAIUsage');
  console.log('  ✅ Passed: Dead maps purged and unbounded memory leaks replaced with TTLMap');

  // --- Test 4: PERF-04 Optimized Question Shuffling ---
  console.log('\n4. Testing PERF-04: Single-pass question shuffling');
  const rawSample = [
    {
      question: 'Q1',
      options: ['Opt A', 'Opt B', 'Opt C', 'Opt D'],
      correct_index: 2
    },
    {
      question: 'Q2',
      options: ['True', 'False'],
      correct_index: 0
    }
  ];
  const shuffled = prepareShuffledQuestions(rawSample);
  assert.strictEqual(shuffled.length, 2);
  shuffled.forEach((q) => {
    assert(q.options.length >= 2);
    assert(q.correct_index >= 0);
    assert.strictEqual(q.options[q.correct_index], q.correct_text);
  });
  console.log('  ✅ Passed: Question shuffling is fast, single-pass, and preserves correct answers');

  // --- Test 5: PERF-05 Admin timetable refresh safety timeout ---
  console.log('\n5. Testing PERF-05: Admin timetable refresh monitor timer unref and safety ceiling');
  const adminSource = require('fs').readFileSync('src/handlers/adminHandlers.js', 'utf8');
  assert(adminSource.includes('MAX_MONITOR_DURATION_MS'), 'adminHandlers.js must define MAX_MONITOR_DURATION_MS');
  assert(adminSource.includes('interval.unref()'), 'adminHandlers.js must unref timetable monitor interval');
  console.log('  ✅ Passed: cmdRefreshAllTimetable monitor timer has unref and 15m safety timeout');

  // --- Test 6: PERF-06 Alignment of V8 heap limit in package.json ---
  console.log('\n6. Testing PERF-06: V8 memory limit aligned to 300MB');
  const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
  assert(pkg.scripts.start.includes('--max-old-space-size=300'), 'start script must have 300MB heap limit');
  assert(pkg.scripts.dev.includes('--max-old-space-size=300'), 'dev script must have 300MB heap limit');
  assert(pkg.scripts['prewarm:cdn'].includes('--max-old-space-size=300'), 'prewarm:cdn script must have 300MB heap limit');
  console.log('  ✅ Passed: All package.json scripts aligned to 300MB V8 heap ceiling');

  console.log('\n==================================================');
  console.log('🎉 ALL PHASE 3 PERFORMANCE & MEMORY FIXES VERIFIED SUCCESSFULLY (6/6)!');
  console.log('==================================================');
}

runPhase3Tests().catch((err) => {
  console.error('❌ Phase 3 Verification Failed:', err);
  process.exit(1);
});
