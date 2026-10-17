'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');
const mutex = require('../src/core/mutex');
const {
  prepareShuffledQuestions,
  shuffleArray,
  fitsTelegramPoll,
  deepClone,
} = require('../src/core/questionUtils');

let passedTests = 0;
function pass(testName) {
  passedTests++;
  console.log(`  ✅ Passed: ${testName}`);
}

async function runTests() {
  console.log('🧪 Starting Audit Stage 1 Verification Tests (C-01, Q-04, C-02)...\n');

  // =========================================================================
  // 1. C-01: Deadlock-Safe & Memory-Leak Free Mutex
  // =========================================================================
  console.log('--- 1. Testing C-01: Mutex runExclusive, Timeout & Auto-cleanup ---');

  // Test 1.1: Sequential FIFO execution
  const results = [];
  const p1 = mutex.runExclusive('user:101', async () => {
    await new Promise((r) => setTimeout(r, 50));
    results.push('first');
    return 1;
  });
  const p2 = mutex.runExclusive('user:101', async () => {
    results.push('second');
    return 2;
  });

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.strictEqual(res1, 1);
  assert.strictEqual(res2, 2);
  assert.deepStrictEqual(results, ['first', 'second'], 'runExclusive must maintain FIFO execution');
  pass('C-01: runExclusive executes sequentially in FIFO order');

  // Test 1.2: Auto-cleanup of _locks Map (no memory leak)
  // After all operations on 'user:101' complete, the map entry must be cleaned up
  assert.strictEqual(mutex.size, 0, 'Mutex _locks map must be empty after all queued jobs complete');
  pass('C-01: Mutex map automatically cleans up finished locks (no memory leak)');

  // Test 1.3: Timeout behavior (does not hang indefinitely on stuck operation)
  let timeoutCaught = false;
  try {
    await mutex.runExclusive(
      'user:stuck',
      async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
      50 // timeout 50ms
    );
  } catch (err) {
    if (err.message.includes('timeout')) {
      timeoutCaught = true;
    }
  }
  assert.strictEqual(timeoutCaught, true, 'Operation exceeding timeout must reject with timeout error');
  pass('C-01: Mutex timeout safely aborts hanging lock acquisition');

  // Test 1.4: Subsequent operation works after timeout without deadlock
  const afterTimeoutRes = await mutex.runExclusive('user:stuck', async () => {
    return 'recovered';
  }, 100);
  assert.strictEqual(afterTimeoutRes, 'recovered', 'Mutex must recover and allow subsequent calls after timeout');
  assert.strictEqual(mutex.size, 0, 'Cleaned up after timeout recovery');
  pass('C-01: Mutex recovers immediately after timeout with zero deadlock');

  // Test 1.5: Backward-compatibility with manual lock() and unlock()
  const unlock = await mutex.lock('user:compat', 1000);
  assert.strictEqual(mutex.size, 1);
  unlock();
  assert.strictEqual(mutex.size, 0);
  pass('C-01: Backward-compatible lock() and unlock() functions as expected');

  // =========================================================================
  // 2. Q-04: Question Deep Cloning & Telegram Poll Constraints
  // =========================================================================
  console.log('\n--- 2. Testing Q-04: Question Deep Clone & Telegram Poll Limits ---');

  // Test 2.1: Deep copy prevents in-place mutation of original questions
  const originalQuestions = [
    {
      id: 1,
      question: 'O\'zbekiston poytaxti qayer?',
      options: ['Toshkent', 'Samarqand', 'Buxoro', 'Xiva'],
      correct_index: 0,
      metadata: { source: 'official_db' },
    },
  ];

  const shuffled = prepareShuffledQuestions(originalQuestions);
  assert.strictEqual(shuffled.length, 1);
  assert.strictEqual(shuffled[0].options.length, 4);

  // Mutate shuffled copy
  shuffled[0].options[0] = 'MUTATED';
  shuffled[0].metadata.source = 'HACKED';

  // Original MUST be pristine
  assert.strictEqual(originalQuestions[0].options[0], 'Toshkent', 'Original options must not be mutated');
  assert.strictEqual(originalQuestions[0].metadata.source, 'official_db', 'Original nested metadata must not be mutated');
  pass('Q-04: prepareShuffledQuestions deep-clones input objects, preserving original memoryDb');

  // Test 2.2: fitsTelegramPoll validation
  assert.strictEqual(fitsTelegramPoll('Qisqa savol?', ['A', 'B', 'C']), true, 'Valid poll accepted');
  assert.strictEqual(fitsTelegramPoll('A'.repeat(301), ['A', 'B']), false, 'Question > 300 chars rejected');
  assert.strictEqual(fitsTelegramPoll('Savol?', ['A'.repeat(101), 'B']), false, 'Option > 100 chars rejected');
  assert.strictEqual(fitsTelegramPoll('Savol?', ['A']), false, 'Fewer than 2 options rejected');
  assert.strictEqual(fitsTelegramPoll('Savol?', new Array(11).fill('Opt')), false, 'More than 10 options rejected');
  assert.strictEqual(fitsTelegramPoll('Savol?', ['A', '   ']), false, 'Empty/whitespace option rejected');
  pass('Q-04: fitsTelegramPoll accurately validates Telegram 300/100 char and 2-10 count limits');

  // Test 2.3: Non-mutating shuffleArray
  const originalArray = ['X', 'Y', 'Z'];
  const shuffledArr = shuffleArray(originalArray);
  assert.strictEqual(originalArray.length, 3);
  assert.strictEqual(originalArray[0], 'X');
  assert.strictEqual(originalArray[1], 'Y');
  assert.strictEqual(originalArray[2], 'Z');
  pass('Q-04: shuffleArray creates a copy and does not mutate source array in-place');

  // =========================================================================
  // 3. C-02: Stale State Cleanup on Main Navigation
  // =========================================================================
  console.log('\n--- 3. Testing C-02: Stale Wizard State Cleanup on Navigation ---');

  const { cmdTimetable } = require('../src/handlers/scheduleHandler');
  const { cbOfficialTests } = require('../src/handlers/quizGame');
  const { cbMyShelf } = require('../src/handlers/shelfHandlers');
  const { cbMyTests } = require('../src/handlers/testCreation');
  const { cbStatsMenu } = require('../src/handlers/statsHandlers');
  const { cbAiTutorMenu } = require('../src/handlers/aiHandlers');

  function createMockCtx() {
    return {
      from: { id: 99999, first_name: 'TestUser' },
      chat: { id: 99999, type: 'private' },
      session: {
        state: 'create:questions',
        data: { subject: 'Tarix', draft: true },
      },
      answerCbQuery: async () => {},
      reply: async () => {},
      callbackQuery: { data: 'dummy' },
    };
  }

  // Test 3.1: cmdTimetable clears state
  const ctx1 = createMockCtx();
  await cmdTimetable(ctx1);
  assert.strictEqual(ctx1.session.state, null, 'cmdTimetable must clear session state');
  pass('C-02: cmdTimetable clears stale wizard state');

  // Test 3.2: cbOfficialTests clears state
  const ctx2 = createMockCtx();
  await cbOfficialTests(ctx2);
  assert.strictEqual(ctx2.session.state, null, 'cbOfficialTests must clear session state');
  pass('C-02: cbOfficialTests clears stale wizard state');

  // Test 3.3: cbMyShelf clears state
  const ctx3 = createMockCtx();
  await cbMyShelf(ctx3);
  assert.strictEqual(ctx3.session.state, null, 'cbMyShelf must clear session state');
  pass('C-02: cbMyShelf clears stale wizard state');

  // Test 3.4: cbMyTests clears state
  const ctx4 = createMockCtx();
  await cbMyTests(ctx4);
  assert.strictEqual(ctx4.session.state, null, 'cbMyTests must clear session state');
  pass('C-02: cbMyTests clears stale wizard state');

  // Test 3.5: cbStatsMenu clears state
  const ctx5 = createMockCtx();
  await cbStatsMenu(ctx5);
  assert.strictEqual(ctx5.session.state, null, 'cbStatsMenu must clear session state');
  pass('C-02: cbStatsMenu clears stale wizard state');

  // Test 3.6: cbAiTutorMenu clears state
  const ctx6 = createMockCtx();
  await cbAiTutorMenu(ctx6);
  assert.strictEqual(ctx6.session.state, null, 'cbAiTutorMenu must clear session state');
  pass('C-02: cbAiTutorMenu clears stale wizard state');

  console.log('\n==================================================');
  console.log(`🎉 ALL AUDIT STAGE 1 TESTS PASSED (${passedTests}/${passedTests})!`);
  console.log('==================================================\n');
}

runTests().then(() => process.exit(0)).catch((err) => {
  console.error('❌ Audit Stage 1 tests failed:', err);
  process.exit(1);
});
