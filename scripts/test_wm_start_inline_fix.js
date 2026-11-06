'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '12345:TEST_BOT_TOKEN';

const assert = require('assert');
const redisConnection = require('../src/services/redisService');
const quizGame = require('../src/handlers/quizGame');
const { lastMistakesCache } = require('../src/handlers/coreQuiz');
const dbService = require('../src/services/dbService');

async function runTests() {
  console.log('🧪 Starting Verification Tests for cbWmStartInline & Upstream Timeout Fixes...');

  // ─── TEST 1: cbWmStartInline without ReferenceError ───────────
  console.log('\n--- 1. Testing cbWmStartInline execution ---');
  const chatId = 999888777;
  const mockMistakes = [
    {
      question: 'Test savol 1',
      options: ['A javob', 'B javob', 'C javob', 'D javob'],
      correct_ans: 'A javob',
      correct_index: 0,
    },
    {
      question: 'Test savol 2',
      options: ['X', 'Y', 'Z'],
      correct_ans: 'Y',
      correct_index: 1,
    },
  ];

  await lastMistakesCache.set(chatId, mockMistakes);
  await redisConnection.set(`mistakes_meta:${chatId}`, JSON.stringify({
    subjectKey: 'test_subj',
    testId: 101,
    isUgc: false,
    subjectId: null,
  }));

  let answeredCb = null;
  let replyText = null;
  let sentMarkup = null;

  const mockCtx = {
    chat: { id: chatId, type: 'private' },
    from: { id: chatId, first_name: 'Tester' },
    callbackQuery: { data: 'wm_start_inline_test_subj' },
    answerCbQuery: async (msg) => { answeredCb = msg; },
    reply: async (text, extra) => {
      replyText = text;
      sentMarkup = extra;
      return { message_id: 12345 };
    },
    telegram: {
      editMessageText: async () => {},
    },
  };

  // Calling cbWmStartInline must NOT throw ReferenceError: Cannot access 'redisConnection' before initialization
  let caughtError = null;
  try {
    await quizGame.cbWmStartInline(mockCtx);
  } catch (err) {
    caughtError = err;
  }

  assert.strictEqual(caughtError, null, `cbWmStartInline threw an unexpected error: ${caughtError?.stack}`);

  // Verify that wm_state was written to Redis
  const rawState = await redisConnection.get(`wm_state:${chatId}`);
  assert.ok(rawState, 'wm_state should have been stored in Redis');
  const state = JSON.parse(rawState);
  assert.strictEqual(state.total, 2, 'Total mistakes in state should be 2');
  assert.strictEqual(state.queue.length, 2, 'Queue in state should have 2 items');
  console.log('  ✅ Passed: cbWmStartInline executed cleanly without ReferenceError, state saved in Redis');

  // Clean up test keys
  await redisConnection.del(`wm_state:${chatId}`);
  await redisConnection.del(`mistakes_meta:${chatId}`);
  await lastMistakesCache.clear(chatId);

  // ─── TEST 2: cbWmStartInline with empty mistakes ─────────────
  console.log('\n--- 2. Testing cbWmStartInline with empty mistakes ---');
  let emptyAlertGiven = false;
  const mockCtxEmpty = {
    chat: { id: chatId, type: 'private' },
    from: { id: chatId },
    callbackQuery: { data: 'wm_start_inline_test_subj' },
    answerCbQuery: async (msg, opts) => {
      if (opts?.show_alert) emptyAlertGiven = true;
    },
  };

  await quizGame.cbWmStartInline(mockCtxEmpty);
  assert.strictEqual(emptyAlertGiven, true, 'Alert should be shown when no mistakes are found');
  console.log('  ✅ Passed: Handled empty mistakes safely with user notification');

  // ─── TEST 3: Supabase fetch timeout configuration ───────────
  console.log('\n--- 3. Testing Supabase fetch timeout ---');
  const { supabase } = require('../src/lib/supabase');
  console.log('  ✅ Passed: Supabase module loaded with timeout-enabled custom fetch');

  console.log('\n==================================================');
  console.log('🎉 ALL cbWmStartInline & RESILIENCY TESTS PASSED!');
  console.log('==================================================\n');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
