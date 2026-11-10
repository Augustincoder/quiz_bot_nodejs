'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456789:TEST_BOT_TOKEN_FOR_PODIUM';

const assert = require('assert');
const {
  sortGroupScores,
  formatPublicPodium,
  generatePersonalAnalysis,
  cbMyGroupQuizResult,
} = require('../src/handlers/coreQuiz');
const featureFlagService = require('../src/services/featureFlagService');

async function runTests() {
  console.log('🧪 Starting 3D Top-3 Podium & Ephemeral Knowledge Radar Tests...\n');
  await featureFlagService.setFeatureState('FEATURE_TOP3_PODIUM', featureFlagService.STATES.PUBLIC);
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', featureFlagService.STATES.PUBLIC);

  // ─── TEST 1: Tie-breaker with Equal Correct Scores ──────────────────
  console.log('[Test 1] Deterministic Tie-Breaker with Response Times...');
  const scoresSample = {
    user1: { name: 'Bobur', correct: 8, wrong: 2, totalTimeMs: 14000 },
    user2: { name: 'Anvar', correct: 8, wrong: 2, totalTimeMs: 9500 },  // Faster than Bobur
    user3: { name: 'Dilshod', correct: 10, wrong: 0, totalTimeMs: 15000 }, // Highest score
    user4: { name: 'Charos', correct: 8, wrong: 2, totalTimeMs: 11000 }, // In-between
    user5: { name: 'Eldor', correct: 5, wrong: 5, totalTimeMs: 8000 },   // Lower score
  };

  const sorted = sortGroupScores(scoresSample);
  assert(Array.isArray(sorted), 'sortGroupScores must return an array');
  assert.strictEqual(sorted.length, 5, 'All 5 participants must be present in sorted output');

  // 1st: Dilshod (10 correct)
  assert.strictEqual(sorted[0].name, 'Dilshod', '1st should be Dilshod with 10 correct');
  // 2nd: Anvar (8 correct, 9500ms)
  assert.strictEqual(sorted[1].name, 'Anvar', '2nd should be Anvar (faster with 9.5s)');
  // 3rd: Charos (8 correct, 11000ms)
  assert.strictEqual(sorted[2].name, 'Charos', '3rd should be Charos (11.0s)');
  // 4th: Bobur (8 correct, 14000ms)
  assert.strictEqual(sorted[3].name, 'Bobur', '4th should be Bobur (14.0s)');
  // 5th: Eldor (5 correct)
  assert.strictEqual(sorted[4].name, 'Eldor', '5th should be Eldor');

  console.log('✅ Test 1 Passed: Response-time tie-breaker works deterministically.');

  // ─── TEST 2: Public Podium Formatting & Hiding 4th+ ─────────────────
  console.log('\n[Test 2] Public Podium Formatting & Hiding 4th+ Participants...');
  const podiumResult = formatPublicPodium(scoresSample);
  assert(podiumResult && typeof podiumResult.body === 'string', 'Podium must return a formatted string');

  // Top 3 medals must be in the podium text
  assert(podiumResult.body.includes('🥇 <b>Dilshod</b>'), 'Dilshod must have gold medal');
  assert(podiumResult.body.includes('🥈 <b>Anvar</b>'), 'Anvar must have silver medal');
  assert(podiumResult.body.includes('🥉 <b>Charos</b>'), 'Charos must have bronze medal');

  // 4th and 5th participants MUST NOT be listed in the public podium text
  assert(!podiumResult.body.includes('Bobur'), 'Bobur (4th) must NOT be listed in public podium text');
  assert(!podiumResult.body.includes('Eldor'), 'Eldor (5th) must NOT be listed in public podium text');

  // Must contain the hint for remaining participants
  assert(
    podiumResult.body.includes("👥 <i>Qolgan ishtirokchilar o'z natijasini quyidagi tugma orqali ko'rishi mumkin:</i>"),
    'Must include the required italicized remaining participants hint'
  );

  // Test with <= 3 participants: no hint needed
  const smallScores = {
    u1: { name: 'Ali', correct: 5, wrong: 1, totalTimeMs: 5000 },
    u2: { name: 'Vali', correct: 4, wrong: 2, totalTimeMs: 6000 },
  };
  const smallPodium = formatPublicPodium(smallScores);
  assert(smallPodium.body.includes('🥇 <b>Ali</b>') && smallPodium.body.includes('🥈 <b>Vali</b>'));
  assert(
    !smallPodium.body.includes("Qolgan ishtirokchilar"),
    'When <= 3 participants, remaining participants hint must not be shown'
  );

  console.log('✅ Test 2 Passed: Public podium displays Top-3 only and hides 4th+ users.');

  // ─── TEST 3: Personal Analysis Rank and Percentile Calculations ─────
  console.log('\n[Test 3] Personal Analysis Rank and Percentile Calculations...');
  // Create 12 participants: ranks 1 to 12
  const twelveScores = {};
  for (let i = 1; i <= 12; i++) {
    twelveScores[`user_${i}`] = {
      userId: `user_${i}`,
      name: `Student ${i}`,
      correct: 13 - i, // user_1 has 12, user_2 has 11, ..., user_4 has 9
      wrong: i - 1,
      totalTimeMs: 10000 + i * 500,
      mistakes: i > 1 ? [
        {
          question: '2 + 2 = ?',
          correct_ans: '4',
          wrong_ans: '5',
          category: 'Matematika',
        },
      ] : [],
    };
  }

  const mockSession = {
    subjectKey: 'matematika',
    blockName: 'Asosiy Arifmetika',
    sessionQuestions: [
      { question: '2 + 2 = ?', category: 'Matematika' },
      { question: 'Sinonim nima?', category: 'Ona tili' },
    ],
    groupScores: twelveScores,
  };

  // Check 4th rank user (e.g. 4 / 12 -> Top 33%)
  const analysis4 = generatePersonalAnalysis('user_4', mockSession);
  assert.strictEqual(analysis4.rank, 4, 'Rank should be 4');
  assert.strictEqual(analysis4.total, 12, 'Total should be 12');
  assert.strictEqual(analysis4.rankStr, '4 / 12', 'Rank string must be "4 / 12"');
  assert.strictEqual(analysis4.percentile, 'Top 33%', 'Percentile for 4/12 must be "Top 33%"');
  assert.strictEqual(analysis4.correct, 9, 'Correct answers must match');
  assert.strictEqual(analysis4.wrong, 3, 'Wrong answers must match');

  // Check 1st rank user (1 / 12 -> Top 8%)
  const analysis1 = generatePersonalAnalysis('user_1', mockSession);
  assert.strictEqual(analysis1.rank, 1, 'Rank should be 1');
  assert.strictEqual(analysis1.percentile, 'Top 8%', 'Percentile for 1/12 must be "Top 8%"');
  assert.strictEqual(analysis1.correct, 12, '1st place has 12 correct');
  assert.strictEqual(analysis1.wrong, 0, '1st place has 0 wrong');

  // Check category breakdown formatting
  assert(analysis4.categoryBreakdownText, 'Category breakdown text must be generated');
  assert(
    analysis4.categoryBreakdownText.includes('Matematika') ||
    analysis4.categoryBreakdownText.includes('Asosiy Arifmetika'),
    'Category breakdown must mention the category or topic'
  );

  console.log('✅ Test 3 Passed: Rank (4/12), percentile (Top 33%), and category breakdown verified.');

  // ─── TEST 4: Ghost Coach Advice Generation ──────────────────────────
  console.log('\n[Test 4] Ghost Coach Advice Generation...');
  // For 0 mistakes (user_1)
  assert(
    analysis1.ghostCoachAdvice.toLowerCase().includes('100%') ||
    analysis1.ghostCoachAdvice.toLowerCase().includes('chempion') ||
    analysis1.ghostCoachAdvice.toLowerCase().includes('benuqson'),
    'Ghost Coach for perfect score must give champion encouragement'
  );

  // For user with mistakes (user_4)
  assert(
    analysis4.ghostCoachAdvice && analysis4.ghostCoachAdvice.includes('Ghost Coach'),
    'Ghost Coach advice must be present and labeled'
  );
  assert(
    analysis4.mistakes.length > 0,
    'Mistake review items must be preserved in analysis'
  );

  console.log('✅ Test 4 Passed: Constructive Ghost Coach encouragement generated.');

  // ─── TEST 5: cbMyGroupQuizResult Callback Handling ───────────────────
  console.log('\n[Test 5] cbMyGroupQuizResult Callback Handling...');

  // 5A: Participated user -> sends ephemeral message
  let sentEphemeral = null;
  let cbAnswered = false;
  const mockCtxParticipated = {
    from: { id: 'user_4', first_name: 'Student 4' },
    chat: { id: -100123456 },
    telegram: {
      sendMessage: async (chatId, text, opts) => {
        sentEphemeral = { chatId, text, opts };
        return { message_id: 999 };
      },
    },
    answerCbQuery: async (msg, opts) => {
      cbAnswered = true;
    },
  };

  await cbMyGroupQuizResult(mockCtxParticipated, mockSession);
  assert(sentEphemeral !== null, 'Ephemeral message should be sent to user');
  assert.strictEqual(sentEphemeral.chatId, -100123456, 'Target chat must match group');
  assert(
    sentEphemeral.opts?.ephemeral_message_parameters?.target_user_id === 'user_4' ||
    sentEphemeral.opts?.ephemeralMessageParameters?.userId === 'user_4',
    'Telegram 10.4 ephemeral parameters must target the clicking user'
  );
  assert(sentEphemeral.text.includes('4 / 12'), 'Analysis text must contain rank');
  assert(cbAnswered, 'Callback query must be answered');

  // 5B: Ephemeral fails -> Fallback to alert summary
  let alertSummaryText = null;
  const mockCtxFallback = {
    from: { id: 'user_4' },
    chat: { id: -100123456 },
    telegram: {
      sendMessage: async () => {
        throw new Error('Telegram 10.4 ephemeral parameters unsupported in this client');
      },
    },
    answerCbQuery: async (text, opts) => {
      alertSummaryText = typeof text === 'object' ? text.text : text;
    },
  };

  await cbMyGroupQuizResult(mockCtxFallback, mockSession);
  assert(alertSummaryText !== null, 'Alert fallback must be triggered on ephemeral failure');
  assert(alertSummaryText.includes('4 / 12'), 'Alert summary must contain user rank');

  // 5C: Non-participant clicks button -> Friendly toast
  let nonParticipantToast = null;
  const mockCtxNonParticipant = {
    from: { id: 'outsider_999' },
    chat: { id: -100123456 },
    telegram: {
      sendMessage: async () => {
        throw new Error('Should not send message to non-participant');
      },
    },
    answerCbQuery: async (text, opts) => {
      nonParticipantToast = typeof text === 'object' ? text.text : text;
    },
  };

  await cbMyGroupQuizResult(mockCtxNonParticipant, mockSession);
  assert.strictEqual(
    nonParticipantToast,
    "ℹ️ Siz ushbu testda qatnashmagansiz. Keyingi safar sizni ham kutamiz!",
    'Non-participant must receive friendly toast'
  );

  console.log('✅ Test 5 Passed: Ephemeral messaging, fallback alert, and non-participant toast verified.');

  // ─── TEST 6: Action Registration in quizGame.js ──────────────────────
  console.log('\n[Test 6] Action Registration in quizGame.js...');
  const quizGame = require('../src/handlers/quizGame');
  const registeredActions = [];
  const mockBot = {
    action: (pattern, handler) => {
      registeredActions.push({ pattern, handler });
    },
  };
  quizGame.register(mockBot);

  const hasMyResultAction = registeredActions.some((a) => {
    if (typeof a.pattern === 'string') return a.pattern === 'my_group_quiz_result';
    if (a.pattern instanceof RegExp) return a.pattern.test('my_group_quiz_result');
    return false;
  });

  assert(hasMyResultAction, 'quizGame.js must register action "my_group_quiz_result"');
  console.log('✅ Test 6 Passed: "my_group_quiz_result" is registered in quizGame.js.');

  console.log('\n🎉 ALL 3D TOP-3 PODIUM & EPHEMERAL RADAR TESTS PASSED! 🚀');
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
