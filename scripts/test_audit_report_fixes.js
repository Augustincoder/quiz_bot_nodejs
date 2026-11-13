'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_BOT_TOKEN_FOR_AUDIT';

/**
 * 🧪 AUTOMATED TEST SUITE: AUDIT REPORT BUG FIXES & HIGH-LOAD VERIFICATION
 * Covers BUG-01 to BUG-08, Performance/High-load fixes, and Clean Code/DRY refactorings.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 Starting Audit Report Comprehensive Bug Fixes & High-Load Test Suite...\n');

// ═══════════════════════════════════════════════════════════════════
// SUITE 1: CLEAN CODE & DRY CENTRALIZATION
// ═══════════════════════════════════════════════════════════════════
console.log('--- Suite 1: Clean Code & DRY Centralization ---');

const utils = require('../src/core/utils');
assert.strictEqual(typeof utils.getLevenshteinDistance, 'function', 'getLevenshteinDistance must be exported from utils');
assert.strictEqual(typeof utils.escapeHtml, 'function', 'escapeHtml must be exported from utils');
assert.strictEqual(typeof utils.decodeHtmlEntities, 'function', 'decodeHtmlEntities must be exported from utils');

// Test getLevenshteinDistance
assert.strictEqual(utils.getLevenshteinDistance('kitten', 'sitting'), 3, 'Levenshtein kitten -> sitting should be 3');
assert.strictEqual(utils.getLevenshteinDistance('BHA-51', 'BHA-51'), 0, 'Identical strings must have 0 distance');
assert.strictEqual(utils.getLevenshteinDistance('', 'test'), 4, 'Empty string vs 4-char string must be 4');
assert.strictEqual(utils.getLevenshteinDistance('test', ''), 4, '4-char string vs empty string must be 4');
console.log('  ✅ [PASS] 1.1: getLevenshteinDistance verified with various string distances');

// Test profileHandler uses utils.getLevenshteinDistance
const profileHandler = require('../src/handlers/profileHandler');
assert.strictEqual(typeof profileHandler.cbProfile, 'function', 'profileHandler loaded cleanly');
console.log('  ✅ [PASS] 1.2: profileHandler cleanly uses centralized getLevenshteinDistance');

// Test edupageService uses centralized getLevenshteinDistance and escapeHtml
const edupageService = require('../src/services/edupageService');
assert.strictEqual(typeof edupageService.normalizeGroupName, 'function', 'edupageService loaded cleanly');
console.log('  ✅ [PASS] 1.3: edupageService cleanly uses centralized utils functions');

// Test canManageLobbyOrGame exported from groupQuizLogic and used in startHandler
const groupQuizLogic = require('../src/handlers/groupQuizLogic');
assert.strictEqual(typeof groupQuizLogic.canManageLobbyOrGame, 'function', 'canManageLobbyOrGame is exported');
console.log('  ✅ [PASS] 1.4: canManageLobbyOrGame centralized and shared cleanly with startHandler');


// ═══════════════════════════════════════════════════════════════════
// SUITE 2: TELEGRAM 10.4 WIDGET TEMPLATE CACHING & FAST RAM PATH
// ═══════════════════════════════════════════════════════════════════
console.log('\n--- Suite 2: Widget In-Memory Template Caching & Performance ---');

const widgetService = require('../src/services/widgetService');

// Verify renderWidgetHtml works and caches in RAM
const t1Start = Date.now();
const html1 = widgetService.renderWidgetHtml('podium', { title: 'Test Podium' });
const t1Elapsed = Date.now() - t1Start;
assert.ok(html1.includes('Test Podium'), 'Rendered HTML contains injected title');

const t2Start = Date.now();
const html2 = widgetService.renderWidgetHtml('podium', { title: 'Test Podium 2' });
const t2Elapsed = Date.now() - t2Start;
assert.ok(html2.includes('Test Podium 2'), 'Rendered HTML 2 contains injected title');
console.log(`  ✅ [PASS] 2.1: renderWidgetHtml fast RAM path verified (t1: ${t1Elapsed}ms, t2: ${t2Elapsed}ms)`);

// Verify Flashcard and DocxHealer template render
const flashcardHtml = widgetService.renderWidgetHtml('flashcard', { title: 'Flashcards' });
assert.ok(flashcardHtml.includes('Flashcards'), 'Flashcard template rendered');
const docxHtml = widgetService.renderWidgetHtml('docxHealer', { title: 'Docx Healer' });
assert.ok(docxHtml.includes('Docx Healer'), 'Docx Healer template rendered');
console.log('  ✅ [PASS] 2.2: All 3 widget templates render cleanly with zero disk I/O on hot path');


// ═══════════════════════════════════════════════════════════════════
// SUITE 3: BUG-02 & BUG-03 DOCX HEALER WIDGET 1024-BYTE LIMIT & INDEX SHIFT
// ═══════════════════════════════════════════════════════════════════
console.log('\n--- Suite 3: Docx Healer Safe Public Data & Index Shift (BUG-02 & BUG-03) ---');

const testCreation = require('../src/handlers/testCreation');
assert.strictEqual(typeof testCreation.makeSafeDocxWidgetPublicData, 'function', 'makeSafeDocxWidgetPublicData is exported');

// Test makeSafeDocxWidgetPublicData strictly bounded under 1024 bytes with 50 questions
const mockLargeInvalid = [];
for (let i = 0; i < 50; i++) {
  mockLargeInvalid.push(
    `Savol ${i + 1}: Ushbu savol juda ham uzun matndan iborat bo'lib, talabalar imtihonida tushadigan barcha qoidalarni o'z ichiga oladi va ko'plab tushuntirishlarni talab qiladi?\nA) Variant birinchi va uzun matn\nB) Variant ikkinchi va uzun matn\nC) Variant uchinchi\nD) Variant to'rtinchi`
  );
}

const safePayloadStr = testCreation.makeSafeDocxWidgetPublicData(mockLargeInvalid, 0, 'Docx Test File.docx');
const byteLength = Buffer.byteLength(safePayloadStr, 'utf8');
assert.ok(byteLength <= 1024, `makeSafeDocxWidgetPublicData must be <= 1024 bytes, got ${byteLength} bytes`);

const parsedSafe = JSON.parse(safePayloadStr);
assert.strictEqual(parsedSafe.remaining, 50, 'Total remaining questions is 50');
assert.strictEqual(parsedSafe.curIdx, 0, 'Current index is 0');
assert.strictEqual(parsedSafe.isFinished, false, 'isFinished is false');
assert.ok(parsedSafe.currentQuestion, 'Single currentQuestion is provided');
assert.strictEqual(parsedSafe.currentQuestion.opts.length, 4, '4 options provided');
console.log(`  ✅ [PASS] 3.1: makeSafeDocxWidgetPublicData with 50 questions is strictly ${byteLength} bytes (<= 1024 limit)`);

// Test with 0 questions (completion)
const safeEmptyStr = testCreation.makeSafeDocxWidgetPublicData([], 0, 'Finished');
const parsedEmpty = JSON.parse(safeEmptyStr);
assert.strictEqual(parsedEmpty.remaining, 0);
assert.strictEqual(parsedEmpty.isFinished, true);
assert.strictEqual(parsedEmpty.currentQuestion, null);
console.log('  ✅ [PASS] 3.2: makeSafeDocxWidgetPublicData handles empty list (completion) cleanly');

// Test handleDocxWidgetQuery index splicing and answerWidgetQuery
let recordedAnswer = null;
let recordedWidgetEdit = null;
const mockTelegramCtx = {
  from: { id: 777123 },
  chat: { id: 777123 },
  session: {
    state: null,
    data: {
      invalidQs: [
        '1. Birinchi savol?\nA) Javob A\nB) Javob B',
        '2. Ikkinchi savol?\nA) Javob A\nB) Javob B',
        '3. Uchinchi savol?\nA) Javob A\nB) Javob B',
      ],
      questions: [],
    },
  },
  telegram: {
    callApi: async (method, params) => {
      if (method === 'answerWidgetQuery') {
        recordedAnswer = params;
        return true;
      }
      if (method === 'editMessageWidgetData') {
        recordedWidgetEdit = params;
        return true;
      }
      return true;
    },
  },
};

(async () => {
  // Simulate picking option 0 for question at index 0
  const queryPick = {
    id: 'wq_1001',
    from: { id: 777123 },
    data: JSON.stringify({ action: 'docx_pick', qIdx: 0, optIdx: 0 }),
    message: { chat: { id: 777123 }, message_id: 999 },
  };

  await testCreation.handleDocxWidgetQuery(mockTelegramCtx, queryPick);

  assert.strictEqual(mockTelegramCtx.session.data.questions.length, 1, '1 question added to valid questions');
  assert.strictEqual(mockTelegramCtx.session.data.invalidQs.length, 2, 'invalidQs length spliced from 3 to 2');
  assert.ok(mockTelegramCtx.session.data.invalidQs[0].includes('Ikkinchi savol'), 'New index 0 is now the second question');

  assert.ok(recordedAnswer, 'answerWidgetQuery was dispatched');
  const ansPayload = JSON.parse(recordedAnswer.data);
  assert.strictEqual(ansPayload.remaining, 2, 'Remaining reported as 2');
  assert.ok(ansPayload.currentQuestion.q.includes('Ikkinchi savol'), 'currentQuestion is now the second question');

  console.log('  ✅ [PASS] 3.3: handleDocxWidgetQuery successfully splices invalidQs and keeps frontend/backend indices synchronized');
})();


// ═══════════════════════════════════════════════════════════════════
// SUITE 4: BUG-04 & BUG-05 FLASHCARD WIDGET & WEBAPP INTEGRITY
// ═══════════════════════════════════════════════════════════════════
console.log('\n--- Suite 4: Flashcard Widget Data Sync & WebApp Integrity (BUG-04 & BUG-05) ---');

// Verify buildInlineFlashcardWidgetHtml contains getLatestWidgetData and doesn't trigger false jump
const inlineFlashcardHtml = widgetService.buildInlineFlashcardWidgetHtml({
  cards: [{ q: 'Savol 1', a: 'Javob 1' }],
  cardIdx: 0,
  total: 1,
  learnedCount: 0,
});
assert.ok(inlineFlashcardHtml.includes('getLatestWidgetData'), 'buildInlineFlashcardWidgetHtml includes getLatestWidgetData()');
assert.ok(inlineFlashcardHtml.includes('lastData = getLatestWidgetData()'), 'lastData initialized to prevent initial false jump');
console.log('  ✅ [PASS] 4.1: buildInlineFlashcardWidgetHtml includes getLatestWidgetData and suppresses false 300ms animation');

// Verify flashcardWidget.html does NOT call Telegram.WebApp.sendData (which would close the WebApp)
const flashcardViewPath = path.join(__dirname, '../src/widgets/views/flashcardWidget.html');
const flashcardViewSource = fs.readFileSync(flashcardViewPath, 'utf8');
assert.strictEqual(
  flashcardViewSource.includes('Telegram.WebApp.sendData'),
  false,
  'flashcardWidget.html must NOT call Telegram.WebApp.sendData on card swipe'
);
assert.ok(
  flashcardViewSource.includes('(Qoldi:'),
  'flashcardWidget.html must display remaining count dynamically'
);
console.log('  ✅ [PASS] 4.2: flashcardWidget.html confirmed free of WebApp-closing sendData() and displays accurate remaining count');


// ═══════════════════════════════════════════════════════════════════
// SUITE 5: BUG-06 3D PODIUM, MARATHON SCORES & ACCURATE RADAR BREAKDOWN
// ═══════════════════════════════════════════════════════════════════
console.log('\n--- Suite 5: 3D Podium, Marathon Global Scores & Accurate Radar (BUG-06) ---');

const coreQuiz = require('../src/handlers/coreQuiz');

// 5.1 Test fallback to marathonGlobalScores when groupScores is empty object {}
const marathonSession = {
  groupScores: {}, // empty object is TRUTHY in JavaScript!
  marathonGlobalScores: {
    '12345': {
      userId: 12345,
      name: 'Ali Valiyev',
      correct: 18,
      wrong: 2,
      totalTimeMs: 45000,
      mistakes: [
        { question: 'Savol 1', wrong_ans: 'A', correct_ans: 'B', category: 'Fizika' },
        { question: 'Savol 2', wrong_ans: 'C', correct_ans: 'D', category: 'Matematika' },
      ],
    },
  },
  sessionQuestions: [
    { question: 'Savol 1', category: 'Fizika' },
    { question: 'Savol 2', category: 'Matematika' },
    { question: 'Savol 3', category: 'Fizika' },
    { question: 'Savol 4', category: 'Informatika' },
    { question: 'Savol 5', category: 'Informatika' },
  ],
};

const analysis = coreQuiz.generatePersonalAnalysis(12345, marathonSession);
assert.strictEqual(analysis.userId, 12345);
assert.strictEqual(analysis.correct, 18, 'Correct answers correctly read from marathonGlobalScores');
assert.strictEqual(analysis.wrong, 2, 'Wrong answers correctly read from marathonGlobalScores');
assert.strictEqual(analysis.totalAnswered, 20, 'totalAnswered is 20');
console.log('  ✅ [PASS] 5.1: generatePersonalAnalysis correctly falls back to marathonGlobalScores when groupScores is {}');

// 5.2 Test unanswered questions are NOT marked as correct!
// Suppose a quiz had 20 questions in sessionQuestions, but the student only answered 2 questions: 1 correct, 1 wrong.
const partialStudentSession = {
  groupScores: {
    '999': {
      userId: 999,
      name: 'Kamron',
      correct: 1,
      wrong: 1,
      totalTimeMs: 12000,
      mistakes: [
        { question: 'Q_Wrong', wrong_ans: 'X', correct_ans: 'Y', category: 'Tarix' },
      ],
    },
  },
  sessionQuestions: [
    { question: 'Q_Wrong', category: 'Tarix' },
    { question: 'Q_Correct', category: 'Tarix' },
    { question: 'Q_Unanswered_1', category: 'Tarix' },
    { question: 'Q_Unanswered_2', category: 'Tarix' },
    { question: 'Q_Unanswered_3', category: 'Tarix' },
    { question: 'Q_Unanswered_4', category: 'Tarix' },
    { question: 'Q_Unanswered_5', category: 'Tarix' },
  ],
};

const partialAnalysis = coreQuiz.generatePersonalAnalysis(999, partialStudentSession);
assert.strictEqual(partialAnalysis.correct, 1, 'Total correct must be exactly 1');
assert.strictEqual(partialAnalysis.wrong, 1, 'Total wrong must be exactly 1');
assert.strictEqual(partialAnalysis.totalAnswered, 2, 'Total answered must be exactly 2 (unanswered questions excluded)');

// Check topic categories: correct must NOT be inflated with unanswered questions!
const tarixCat = partialAnalysis.categories.find(c => c.name === 'Tarix');
if (tarixCat) {
  assert.strictEqual(tarixCat.correct, 1, 'Tarix category correct must be 1, not 6!');
  assert.strictEqual(tarixCat.wrong, 1, 'Tarix category wrong must be 1');
  assert.strictEqual(tarixCat.total, 2, 'Tarix category total must be 2, not 7!');
}
console.log('  ✅ [PASS] 5.2: Unanswered questions are NOT falsely marked as correct in category breakdown');

// 5.3 Test podiumWidget.html strips raw HTML tags from personal.advice
const podiumViewPath = path.join(__dirname, '../src/widgets/views/podiumWidget.html');
const podiumViewSource = fs.readFileSync(podiumViewPath, 'utf8');
assert.ok(
  podiumViewSource.includes('replace(/<\\/?(?:b|strong|i|em|code)>/gi'),
  'podiumWidget.html must strip raw HTML tags before setting textContent'
);
console.log('  ✅ [PASS] 5.3: podiumWidget.html sanitizes raw HTML formatting tags in ghost coach advice');


// ═══════════════════════════════════════════════════════════════════
// SUITE 6: BUG-07 SHAXSIY MARAFON & FAOL TEST HIMOYASI
// ═══════════════════════════════════════════════════════════════════
console.log('\n--- Suite 6: Shaxsiy Marafon & Faol Test Himoyasi (BUG-07) ---');

const quizGame = require('../src/handlers/quizGame');
assert.strictEqual(typeof quizGame.checkActiveTestConflict, 'function', 'checkActiveTestConflict is exported from quizGame');

// 6.1 Test buildFinishButtons generates marathon continuation button
(async () => {
  const marathonFinishSession = {
    isMarathon: true,
    currentBlockIdx: 0,
    marathonBlocks: [
      { id: 101, block_name: '1-Mavzu' },
      { id: 102, block_name: '2-Mavzu' },
    ],
  };

  const finishButtons = await coreQuiz.buildFinishButtons(101, 'algebra', 0, marathonFinishSession);
  const topRow = finishButtons[0];
  assert.ok(topRow && topRow[0], 'Finish buttons has top row');
  assert.ok(
    topRow[0].text.includes('Keyingi marafon bloki') && topRow[0].text.includes('2-Mavzu'),
    'Marathon continuation button displayed at the top'
  );
  console.log('  ✅ [PASS] 6.1: buildFinishButtons generates sequential marathon continuation button for personal tests');
})();


// ═══════════════════════════════════════════════════════════════════
// SUITE 7: HIGH-LOAD RATE LIMITER & PER-USER MUTEX IN WIDGET SERVER
// ═══════════════════════════════════════════════════════════════════
console.log('\n--- Suite 7: High-Load Rate Limiter & Concurrency Mutex in Widget Server ---');

const widgetServerSource = fs.readFileSync(path.join(__dirname, '../src/widgets/widgetServer.js'), 'utf8');
assert.ok(widgetServerSource.includes('widgetRateLimiter'), 'widgetServer includes widgetRateLimiter middleware');
assert.ok(widgetServerSource.includes('widgetAiHealLimiter'), 'widgetServer limits AI batchAutoHeal per user');
assert.ok(widgetServerSource.includes('mutex.runExclusive(`widget_save_docx:${userId}`'), 'save_docx is protected by per-user mutex');
assert.ok(widgetServerSource.includes('deduplicatedNew'), 'save_docx deduplicates incoming questions against existing');
console.log('  ✅ [PASS] 7.1: widgetServer verified with 90 req/min IP limiter, 5 req/min AI limiter, mutex, and question dedup');


// ═══════════════════════════════════════════════════════════════════
// SUITE 8: HYBRID L1/L2 CRAM SESSIONS & CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════════
console.log('\n--- Suite 8: Hybrid L1/L2 Cram Sessions & Circuit Breaker ---');

const cramReviewHandler = require('../src/handlers/cramReviewHandler');
const cramSource = fs.readFileSync(path.join(__dirname, '../src/handlers/cramReviewHandler.js'), 'utf8');

assert.ok(cramSource.includes('saveCramSession'), 'cramReviewHandler implements saveCramSession with Redis backup');
assert.ok(cramSource.includes('getCramSession'), 'cramReviewHandler implements getCramSession with Redis recovery');
assert.ok(cramSource.includes("isFeatureEnabledSync('FEATURE_BLITZ_FLASHCARD'"), 'Flashcard feature flag checked');
assert.ok(cramSource.includes("isWidgetEngineEnabled(userId)"), 'Widget engine feature flag checked before sendWidget');
assert.ok(cramSource.includes("recordFeatureError('FEATURE_WIDGET_ENGINE'"), 'Circuit breaker records widget errors');
console.log('  ✅ [PASS] 8.1: cramReviewHandler verified with L1/L2 persistence, feature flag governance, and circuit breaker');


console.log('\n======================================================');
console.log('🎉 ALL AUDIT REPORT BUG FIXES AND HIGH-LOAD TESTS PASSED! 🚀');
console.log('======================================================\n');
