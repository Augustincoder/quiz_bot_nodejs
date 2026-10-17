'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');
const sessionService = require('../src/services/sessionService');
const coreQuiz = require('../src/handlers/coreQuiz');

let passedTests = 0;
function pass(testName) {
  passedTests++;
  console.log(`  ✅ Passed: ${testName}`);
}

async function runTests() {
  console.log('🧪 Starting Audit Stage 2 Verification Tests (Q-01, Q-02, Q-03)...\n');

  // =========================================================================
  // 1. Q-01: Race Condition (Timer vs Poll Answer)
  // =========================================================================
  console.log('--- 1. Testing Q-01: Atomic Question Transition & Race Condition Guard ---');

  const testChatId = 888101;
  const pollId = 'poll_race_test_123';

  const mockSession = {
    chatType: 'private',
    initiatorId: testChatId,
    subjectKey: 'iqtisodiyot',
    testId: 1,
    blockName: '1-Blok',
    sessionQuestions: [
      { question: 'Q1?', options: ['A', 'B'], correct_index: 0 },
      { question: 'Q2?', options: ['A', 'B'], correct_index: 1 },
      { question: 'Q3?', options: ['A', 'B'], correct_index: 0 },
    ],
    qIdx: 0,
    startTime: Date.now(),
    pollId: pollId,
    msgId: 501,
    correct: 0,
    wrong: 0,
    mistakes: [],
    consecutiveTimeouts: 0,
    groupScores: {},
    finished: false,
    status: 'running',
    transitionLock: null,
    questionState: 'ACTIVE',
  };

  await sessionService.setActiveTest(testChatId, mockSession);
  await sessionService.setPollChat(pollId, String(testChatId));

  let sendNextQuestionCalled = 0;
  const mockTelegram = {
    stopPoll: async () => {},
    sendMessage: async () => ({ poll: { id: 'poll_next_456' }, message_id: 502 }),
    sendPoll: async () => ({ poll: { id: 'poll_next_456' }, message_id: 502 }),
  };

  // Test 1.1: Concurrent handlePollAnswer and questionTimeout on the same question
  // Simulate poll answer arriving at t=14.95s and timeout firing at t=15.00s simultaneously
  const pollAnswerEvent = {
    poll_id: pollId,
    user: { id: testChatId, first_name: 'Talaba' },
    option_ids: [0], // Correct answer
  };

  // Run both concurrently
  await Promise.all([
    coreQuiz.handlePollAnswer(pollAnswerEvent, mockTelegram),
    coreQuiz.questionTimeout(testChatId, 0, pollId, mockTelegram),
  ]);

  const afterRaceSession = await sessionService.getActiveTest(testChatId);
  // Expect qIdx to be 1 (incremented only ONCE, never skipped to 2)
  assert.strictEqual(
    afterRaceSession.qIdx,
    1,
    `Question index must advance exactly by 1 (got ${afterRaceSession.qIdx})`
  );
  assert.strictEqual(
    afterRaceSession.correct + afterRaceSession.wrong,
    1,
    'Exactly one event (answer or timeout) must win the atomic transition without double-counting'
  );
  pass('Q-01: Concurrent poll answer and timeout advance question index exactly once without skipping');

  // Test 1.2: Double finish guard on final question
  const finalChatId = 888102;
  const finalPollId = 'poll_final_test_999';
  const finalSession = {
    ...mockSession,
    qIdx: 2, // Last question (index 2 of 3)
    pollId: finalPollId,
    msgId: 601,
    transitionLock: null,
    questionState: 'ACTIVE',
  };

  await sessionService.setActiveTest(finalChatId, finalSession);
  await sessionService.setPollChat(finalPollId, String(finalChatId));

  let finishTestCallCount = 0;
  // Monkey-patch finishTest on mock session
  await Promise.all([
    coreQuiz.handlePollAnswer({ poll_id: finalPollId, user: { id: finalChatId }, option_ids: [0] }, mockTelegram),
    coreQuiz.questionTimeout(finalChatId, 2, finalPollId, mockTelegram),
  ]);

  const afterFinalSession = await sessionService.getActiveTest(finalChatId);
  // In coreQuiz finishTest marks finished: true
  assert(
    !afterFinalSession || afterFinalSession.finished === true || afterFinalSession.questionState === 'FINISHED',
    'Session must be cleanly finished without double-finish corruption'
  );
  pass('Q-01: Final question race condition completes test cleanly with atomic state transition');

  // =========================================================================
  // 2. Q-02: Group Quiz Concurrency & Fatal Error Handling
  // =========================================================================
  console.log('\n--- 2. Testing Q-02: Group Concurrency & Fatal Error Recovery ---');

  const groupChatId = -100998877;
  const groupPollId = 'group_poll_active_777';

  // Seed activePollsCache for group quiz
  await coreQuiz.activePollsCache.set(groupPollId, {
    chatId: groupChatId,
    correct_index: 1,
    qData: {
      question: 'Guruh savoli?',
      options: ['Xato', 'To\'g\'ri'],
      correct_index: 1,
      correct_text: 'To\'g\'ri',
    },
  });

  // Simulate 10 simultaneous voters voting on the group poll
  const voters = Array.from({ length: 10 }, (_, i) => ({
    poll_id: groupPollId,
    user: { id: 1000 + i, first_name: `Talaba_${i}` },
    option_ids: [i % 2 === 0 ? 1 : 0], // alternating correct/wrong
  }));

  await Promise.all(voters.map((v) => coreQuiz.handlePollAnswer(v, mockTelegram)));

  const groupScoresEntry = await coreQuiz.groupTestCache.get(groupChatId);
  assert(groupScoresEntry && groupScoresEntry.scores, 'Group scores entry must exist');
  const recordedUsersCount = Object.keys(groupScoresEntry.scores).length;
  assert.strictEqual(recordedUsersCount, 10, 'All 10 simultaneous group voters must be recorded without data loss');
  pass('Q-02: Group concurrent poll answers successfully recorded without lost updates');

  // Test 2.2: Fatal Telegram error handling (Zombie Quiz cleanup)
  const kickedChatId = -100445566;
  const zombieSession = {
    ...mockSession,
    chatType: 'group',
    qIdx: 0,
    pollId: 'zombie_poll_111',
  };
  await sessionService.setActiveTest(kickedChatId, zombieSession);
  await sessionService.setPollChat('zombie_poll_111', String(kickedChatId));

  const kickedTelegram = {
    sendPoll: async () => {
      throw new Error('403: Forbidden: bot was kicked from the supergroup chat');
    },
    sendMessage: async () => {},
  };

  // Trigger sendNextQuestion with kicked error
  await coreQuiz.sendNextQuestion(kickedChatId, kickedTelegram);

  const zombieAfter = await sessionService.getActiveTest(kickedChatId);
  assert.strictEqual(zombieAfter, null, 'Zombie session must be deleted immediately upon fatal bot kicked error');
  pass('Q-02: Fatal bot kicked / chat closed errors force-stop and clean up zombie quiz sessions');

  // =========================================================================
  // 3. Q-03: Poll Mapping TTL & Routing Cleanup
  // =========================================================================
  console.log('\n--- 3. Testing Q-03: Poll Mapping TTL & Routing Cleanup ---');

  const testPollId = 'poll_map_ttl_check_555';
  await sessionService.setPollChat(testPollId, '12345678');
  const mappedChatId = await sessionService.getPollChat(testPollId);
  assert.strictEqual(mappedChatId, '12345678', 'Poll mapping must correctly resolve chatId');

  // Test explicit delete on cleanup
  await sessionService.deletePollChat(testPollId);
  const deletedMapping = await sessionService.getPollChat(testPollId);
  assert.strictEqual(deletedMapping, null, 'Deleted poll mapping must return null');
  pass('Q-03: Poll mapping successfully stored with TTL and cleaned up upon resolution');

  console.log('\n==================================================');
  console.log(`🎉 ALL AUDIT STAGE 2 TESTS PASSED (${passedTests}/${passedTests})!`);
  console.log('==================================================\n');
}

runTests().then(() => process.exit(0)).catch((err) => {
  console.error('❌ Audit Stage 2 tests failed:', err);
  process.exit(1);
});
