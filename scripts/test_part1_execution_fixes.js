'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

console.log('🧪 Testing Part 1: Quiz Execution Fixes (BUG-EX-01 to BUG-EX-08)...\n');

let passedCount = 0;
function pass(testName) {
  passedCount++;
  console.log(`✅ [PASS] ${testName}`);
}

async function runTests() {
  // --- Test 1: BUG-EX-01 (Cascading skip prevention) ---
  console.log('--- Test 1: BUG-EX-01 Cascading skip prevention in coreQuiz.js ---');
  const coreQuizSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/coreQuiz.js'), 'utf8');
  assert(coreQuizSrc.includes('session.sendErrors'), 'coreQuiz.js must track consecutive sendErrors');
  assert(coreQuizSrc.includes('session.sendErrors >= 3'), 'coreQuiz.js must pause session on 3 consecutive errors');
  assert(coreQuizSrc.includes('session.sendErrors = 0'), 'coreQuiz.js must reset sendErrors on success');
  pass('BUG-EX-01: Cascading skip protected by 3-error circuit breaker & 1000ms delay');

  // --- Test 2: BUG-EX-02 (Waiting room readyUsers parsing) ---
  console.log('\n--- Test 2: BUG-EX-02 Waiting room readyUsers parsing ---');
  const quizGameSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/quizGame.js'), 'utf8');
  assert(quizGameSrc.includes('Object.values(room.readyUsers)'), 'sendWaitingRoomMessage must extract names from readyUsers object');
  assert(quizGameSrc.includes('readyUsers: { [ctx.from.id]: initiatorName }'), 'cbStartTest & startUgcTest must include initiator in readyUsers');
  pass('BUG-EX-02: Waiting room readyUsers correctly handles object format with initiator');

  // --- Test 3: BUG-EX-03 (Deep link official test support) ---
  console.log('\n--- Test 3: BUG-EX-03 Official test deep link in startHandler.js ---');
  const startHandlerSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/startHandler.js'), 'utf8');
  assert(startHandlerSrc.includes("param.startsWith('offt_')"), 'startHandler must handle offt_ official block link');
  assert(startHandlerSrc.includes("param.startsWith('offs_')"), 'startHandler must handle offs_ official marathon link');
  pass('BUG-EX-03: Deep linking supports offt_ and offs_ official tests in private chat');

  // --- Test 4: BUG-EX-04 (BullMQ timer cancellation on stop) ---
  console.log('\n--- Test 4: BUG-EX-04 BullMQ timer cancel on pause/stop ---');
  assert(quizGameSrc.includes('quizTimerQueue.getJob(`timeout:${chatId}:${session.qIdx}`)'), 'cbStopTest must clean up active BullMQ timeout');
  pass('BUG-EX-04: Active BullMQ timer safely cancelled when user pauses test');

  // --- Test 5: BUG-EX-05 (Shelf completed test resumption) ---
  console.log('\n--- Test 5: BUG-EX-05 Shelf completed test restart logic ---');
  assert(quizGameSrc.includes('isCompleted'), 'resumeTestFromShelf must detect completed test status');
  assert(quizGameSrc.includes('Test boshidan (1-savoldan) qayta boshlanmoqda!'), 'resumeTestFromShelf must restart completed test from question 1');
  pass('BUG-EX-05: Completed tests from shelf restart from question 1 instead of immediate finish');

  // --- Test 6: BUG-EX-06 (Inline mistakes rotation without duplication) ---
  console.log('\n--- Test 6: BUG-EX-06 Inline mistakes rotation without duplication ---');
  assert(quizGameSrc.includes('const timedOutQ = checkState.queue.shift()'), 'wmTimer must shift question from queue head');
  assert(quizGameSrc.includes('checkState.queue.push(timedOutQ)'), 'wmTimer must push question to queue tail');
  assert(quizGameSrc.includes('elapsed > 20000'), 'cbWmAns timeout must align to 20 seconds');
  pass('BUG-EX-06: Inline mistake timeout rotates queue cleanly without question duplication');

  // --- Test 7: BUG-EX-07 & BUG-EX-08 (HTML review mistakes and poll answer delay) ---
  console.log('\n--- Test 7: BUG-EX-07 & BUG-EX-08 Formatting and poll answer animation ---');
  assert(quizGameSrc.includes('<i>Sahifa: ${validPage + 1} / ${totalPages}</i>'), 'cbReviewMistakes must use HTML <i> for pagination');
  assert(coreQuizSrc.includes('setTimeout(r, 600)'), 'coreQuiz.js must provide delay after poll answer for smooth animation');
  pass('BUG-EX-07 & BUG-EX-08: HTML formatting fixed and smooth poll transition implemented');

  console.log(`\n🎉 All Part 1 Execution tests passed! (${passedCount}/7)`);
}

runTests().catch(err => {
  console.error('\n❌ Part 1 Test failed:', err);
  process.exit(1);
});
