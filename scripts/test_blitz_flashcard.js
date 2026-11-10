'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456789:TEST_BOT_TOKEN_FOR_FLASHCARDS';

const assert = require('assert');

// We require cramReviewHandler which does not exist yet (TDD RED step)
const {
  initFlashcardDeck,
  processCardAction,
  buildFlashcardViewData,
  getFlashcardFallbackKeyboard,
  formatFlashcardMessage,
  register: registerCramHandler,
  cbCramStart,
  cbCramReveal,
  cbCramHide,
  cbCramKnown,
  cbCramRepeat,
  cbCramExit,
  cramSessions,
} = require('../src/handlers/cramReviewHandler');

const { getBlocksKeyboard, setMemoryDb } = require('../src/keyboards/keyboards');
const botCore = require('../src/core/bot');
const { buildWidgetMessage, verifyWidgetToken } = require('../src/services/widgetService');
const featureFlagService = require('../src/services/featureFlagService');

async function runTests() {
  console.log('🧪 Starting 3D Blitz-Flashcard Review Widget & Spaced Repetition Tests...\n');
  await featureFlagService.setFeatureState('FEATURE_BLITZ_FLASHCARD', featureFlagService.STATES.PUBLIC);
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', featureFlagService.STATES.PUBLIC);

  // Sample questions fixture
  const sampleQuestions = [
    {
      question: 'Buxgalteriya balansi qanday qismlardan iborat?',
      options: ['A) Aktiv va Passiv', 'B) Debet va Kredit', 'C) Foyda va Zarar', 'D) Daromad'],
      answer: 'A) Aktiv va Passiv',
    },
    {
      question: 'Likvidlik nima?',
      options: ['A) Qarzlar', 'B) Aktivlarning tez pulga aylanish qobiliyati', 'C) Foiz stavkasi'],
      answer: 'B) Aktivlarning tez pulga aylanish qobiliyati',
    },
    {
      question: 'Amortizatsiya nima?',
      options: ['A) Eskirish qiymati', 'B) Daromad solig\'i', 'C) Sof foyda'],
      answer: 'A) Eskirish qiymati',
    },
  ];

  // ─── TEST 1: Deck Initialization ─────────────────────────────────────
  console.log('[Test 1] Spaced Repetition Deck Initialization...');
  const emptyDeck = initFlashcardDeck([]);
  assert.strictEqual(emptyDeck.total, 0, 'Empty questions should yield total 0');
  assert.deepStrictEqual(emptyDeck.unlearned, [], 'Empty questions should have empty unlearned');
  assert.deepStrictEqual(emptyDeck.learned, [], 'Empty questions should have empty learned');
  assert.deepStrictEqual(emptyDeck.cards, [], 'Empty questions should have empty cards');

  const deck = initFlashcardDeck(sampleQuestions);
  assert.strictEqual(deck.total, 3, 'Total should be 3');
  assert.deepStrictEqual(deck.unlearned, [0, 1, 2], 'Initial unlearned should contain indices [0, 1, 2]');
  assert.deepStrictEqual(deck.learned, [], 'Initial learned should be empty');
  assert.strictEqual(deck.cards.length, 3, 'Cards array should have 3 items');
  assert.strictEqual(deck.cards[0].question, sampleQuestions[0].question);
  assert.strictEqual(deck.cards[0].answer, sampleQuestions[0].answer);
  assert.strictEqual(deck.cards[0].q, sampleQuestions[0].question);
  assert.strictEqual(deck.cards[0].a, sampleQuestions[0].answer);
  console.log('✅ Test 1 Passed: Deck properly initialized with 0-indexed unlearned queue.');

  // ─── TEST 2: Spaced Repetition Transitions (known vs repeat) ──────────
  console.log('\n[Test 2] Card Actions: known (Swipe Right) & repeat (Swipe Left)...');
  
  // 2a: 'repeat' action on card 0: moves 0 to the back of unlearned
  const deckAfterRepeat = processCardAction(deck, 'repeat', 0);
  assert.deepStrictEqual(
    deckAfterRepeat.unlearned,
    [1, 2, 0],
    "'repeat' action should move card 0 to the back of unlearned queue"
  );
  assert.deepStrictEqual(deckAfterRepeat.learned, [], 'Learned array should still be empty after repeat');

  // 2b: 'known' action on card 1: moves 1 from unlearned to learned
  const deckAfterKnown1 = processCardAction(deckAfterRepeat, 'known', 1);
  assert.deepStrictEqual(
    deckAfterKnown1.unlearned,
    [2, 0],
    "'known' action should remove card 1 from unlearned queue"
  );
  assert.deepStrictEqual(
    deckAfterKnown1.learned,
    [1],
    "'known' action should add card 1 to learned array"
  );

  // 2c: 'known' on remaining cards (2, then 0)
  processCardAction(deckAfterKnown1, 'known', 2);
  const deckCompleted = processCardAction(deckAfterKnown1, 'known', 0);
  assert.deepStrictEqual(deckCompleted.unlearned, [], 'All cards learned: unlearned should be empty');
  assert.deepStrictEqual(deckCompleted.learned, [1, 2, 0], 'All cards should now be in learned array');
  assert.strictEqual(deckCompleted.learned.length, deckCompleted.total);
  console.log('✅ Test 2 Passed: Spaced repetition transitions (swipe left/right) verified.');

  // ─── TEST 3: View Data Formatting & Progress Percentage ──────────────
  console.log('\n[Test 3] View Data Formatting & Progress Calculation...');
  const deckForView = initFlashcardDeck(sampleQuestions);
  
  // 0% progress initially
  const viewData0 = buildFlashcardViewData(deckForView, 'Buxgalteriya', '1-Blok');
  assert.strictEqual(viewData0.percent, 0, 'Initial progress should be 0%');
  assert.strictEqual(viewData0.cardIdx, 0, 'Current card should be index 0');
  assert.strictEqual(viewData0.question, sampleQuestions[0].question);
  assert.strictEqual(viewData0.answer, sampleQuestions[0].answer);
  assert.strictEqual(viewData0.subjectName, 'Buxgalteriya');
  assert.strictEqual(viewData0.blockName, '1-Blok');
  assert.strictEqual(viewData0.isFinished, false);

  // 1 card learned -> 33% progress
  processCardAction(deckForView, 'known', 0);
  const viewData1 = buildFlashcardViewData(deckForView, 'Buxgalteriya', '1-Blok');
  assert.strictEqual(viewData1.percent, 33, '1/3 cards learned should be 33%');
  assert.strictEqual(viewData1.cardIdx, 1, 'Current card should now be index 1');

  // 2 cards learned -> 67% progress
  processCardAction(deckForView, 'known', 1);
  const viewData2 = buildFlashcardViewData(deckForView, 'Buxgalteriya', '1-Blok');
  assert.strictEqual(viewData2.percent, 67, '2/3 cards learned should be 67%');

  // 3 cards learned -> 100% progress
  processCardAction(deckForView, 'known', 2);
  const viewData3 = buildFlashcardViewData(deckForView, 'Buxgalteriya', '1-Blok');
  assert.strictEqual(viewData3.percent, 100, 'All cards learned should be 100%');
  assert.strictEqual(viewData3.isFinished, true, 'Deck should be marked finished');
  console.log('✅ Test 3 Passed: View data and progress calculations accurate.');

  // ─── TEST 4: Fallback Keyboard & Message Formatting ───────────────────
  console.log('\n[Test 4] Dual-Mode Inline Keyboard Fallback & Text Formatting...');
  
  // 4a: Hidden answer state
  const kbHidden = getFlashcardFallbackKeyboard(0, false);
  const buttonsHidden = kbHidden.reply_markup ? kbHidden.reply_markup.inline_keyboard : kbHidden.inline_keyboard;
  assert.strictEqual(buttonsHidden.length, 3, 'Fallback keyboard must have 3 rows');
  // Row 1: Javobni ko'rish
  assert.strictEqual(buttonsHidden[0][0].text, '👁 Javobni ko\'rish');
  assert.strictEqual(buttonsHidden[0][0].callback_data, 'cram_reveal_0');
  // Row 2: Qiyin (Qaytarish) | Bilib oldim
  assert.strictEqual(buttonsHidden[1][0].text, '👈 Qiyin (Qaytarish)');
  assert.strictEqual(buttonsHidden[1][0].callback_data, 'cram_repeat_0');
  assert.strictEqual(buttonsHidden[1][1].text, '👉 Bilib oldim');
  assert.strictEqual(buttonsHidden[1][1].callback_data, 'cram_known_0');
  // Row 3: 5-daqiqalik Blitz | Chiqish
  assert.strictEqual(buttonsHidden[2][0].text, '⚡ 5-daqiqalik Blitz');
  assert.strictEqual(buttonsHidden[2][1].text, '🏁 Chiqish');
  assert.strictEqual(buttonsHidden[2][1].callback_data, 'cram_exit');

  // 4b: Revealed answer state
  const kbRevealed = getFlashcardFallbackKeyboard(0, true);
  const buttonsRevealed = kbRevealed.reply_markup ? kbRevealed.reply_markup.inline_keyboard : kbRevealed.inline_keyboard;
  assert.strictEqual(buttonsRevealed[0][0].text, '🙈 Yashirish');
  assert.strictEqual(buttonsRevealed[0][0].callback_data, 'cram_hide_0');

  // 4c: Message formatting
  const textHidden = formatFlashcardMessage(viewData0, false);
  assert(textHidden.includes(sampleQuestions[0].question), 'Must include question');
  assert(!textHidden.includes(sampleQuestions[0].answer), 'Hidden message must NOT include answer');

  const textRevealed = formatFlashcardMessage(viewData0, true);
  assert(textRevealed.includes(sampleQuestions[0].question), 'Must include question');
  assert(textRevealed.includes(sampleQuestions[0].answer), 'Revealed message must include answer');
  console.log('✅ Test 4 Passed: Dual-mode inline keyboard rows and message formats match specs.');

  // ─── TEST 5: Telegram 10.4 Widget Payload Integration ────────────────
  console.log('\n[Test 5] Telegram 10.4 Widget Message Payload & HMAC Token...');
  const widgetMsg = buildWidgetMessage(
    'flashcard',
    viewData0,
    textHidden,
    kbHidden,
    { userId: 424242 }
  );
  assert.strictEqual(widgetMsg.type, 'flashcard');
  assert(widgetMsg.token && widgetMsg.token.includes('.'), 'Widget message must contain signed token');
  assert(widgetMsg.widgetUrl.includes(widgetMsg.token), 'Widget URL must contain token');
  
  const verifiedToken = verifyWidgetToken(widgetMsg.token);
  assert(verifiedToken !== null, 'Token in widget message must verify');
  assert.strictEqual(verifiedToken.type, 'flashcard');
  assert.strictEqual(verifiedToken.userId, 424242);
  console.log('✅ Test 5 Passed: Telegram 10.4 HTML widget integration verified.');

  // ─── TEST 6: Integration into keyboards.js ───────────────────────────
  console.log('\n[Test 6] Integration into src/keyboards/keyboards.js...');
  const fakeDb = {
    matematika: {
      1: { questions: sampleQuestions },
      2: { questions: sampleQuestions },
    },
  };
  setMemoryDb(fakeDb);
  const blocksKb = getBlocksKeyboard('matematika', 0);
  const blockButtons = blocksKb.reply_markup ? blocksKb.reply_markup.inline_keyboard : blocksKb.inline_keyboard;
  
  // Find cram_start button
  const allFlattenedButtons = blockButtons.flat();
  const cramButton1 = allFlattenedButtons.find(b => b.callback_data === 'cram_start_matematika_1');
  const cramButton2 = allFlattenedButtons.find(b => b.callback_data === 'cram_start_matematika_2');
  
  assert(cramButton1, 'Blocks keyboard must contain cram_start_matematika_1');
  assert(cramButton1.text.includes('⚡') && cramButton1.text.includes('Flashcard'), 'Button text must feature Flashcard label');
  assert(cramButton2, 'Blocks keyboard must contain cram_start_matematika_2');
  console.log('✅ Test 6 Passed: getBlocksKeyboard includes Flashcard launcher buttons.');

  // ─── TEST 7: Registration in bot.js and Handler ──────────────────────
  console.log('\n[Test 7] Action Registrations in bot.js and cramReviewHandler...');
  const registeredActions = [];
  const fakeBot = {
    action: (pattern, handler) => {
      registeredActions.push({ pattern, handler });
    },
  };

  // Test registration from botCore
  assert(typeof botCore.registerCramActions === 'function' || typeof botCore.register === 'function', 'bot.js must provide cram registration');
  (botCore.registerCramActions || botCore.register)(fakeBot);

  // Check expected regex patterns
  const patternsStr = registeredActions.map(r => r.pattern.toString());
  assert(patternsStr.some(p => p.includes('cram_start_')), 'cram_start pattern must be registered');
  assert(patternsStr.some(p => p.includes('cram_reveal_')), 'cram_reveal pattern must be registered');
  assert(patternsStr.some(p => p.includes('cram_hide_')), 'cram_hide pattern must be registered');
  assert(patternsStr.some(p => p.includes('cram_known_')), 'cram_known pattern must be registered');
  assert(patternsStr.some(p => p.includes('cram_repeat_')), 'cram_repeat pattern must be registered');
  assert(patternsStr.some(p => p.includes('cram_exit')), 'cram_exit pattern must be registered');
  console.log('✅ Test 7 Passed: All 6 required bot actions registered.');

  // ─── TEST 8: Full Interactive Flow Simulation ────────────────────────
  console.log('\n[Test 8] End-to-End Simulation of Interactive Cram Session...');
  
  let sentText = '';
  let sentKeyboard = null;
  let answeredAlert = null;

  const mockCtx = {
    from: { id: 77777, first_name: 'Sardor' },
    chat: { id: 77777, type: 'private' },
    callbackQuery: {
      data: 'cram_start_matematika_1',
      message: { message_id: 101 },
    },
    answerCbQuery: async (msg, opts) => {
      answeredAlert = { msg, opts };
    },
    editMessageText: async (text, extra) => {
      sentText = text;
      sentKeyboard = extra?.reply_markup;
    },
    reply: async (text, extra) => {
      sentText = text;
      sentKeyboard = extra?.reply_markup;
    },
  };

  // 8a: Trigger cram_start
  await cbCramStart(mockCtx);
  assert(sentText.includes('Savol:'), 'Cram start should render first card question');
  assert(cramSessions.has('77777'), 'Session for user 77777 should be active');
  
  // 8b: Trigger cram_reveal_0
  mockCtx.callbackQuery.data = 'cram_reveal_0';
  await cbCramReveal(mockCtx);
  assert(sentText.includes('To\'g\'ri javob:'), 'Cram reveal should display answer');

  // 8c: Trigger cram_hide_0
  mockCtx.callbackQuery.data = 'cram_hide_0';
  await cbCramHide(mockCtx);
  assert(!sentText.includes('To\'g\'ri javob:'), 'Cram hide should remove answer');

  // 8d: Trigger cram_repeat_0
  mockCtx.callbackQuery.data = 'cram_repeat_0';
  await cbCramRepeat(mockCtx);
  const sessionAfterRepeat = cramSessions.get('77777');
  assert.deepStrictEqual(sessionAfterRepeat.deck.unlearned, [1, 2, 0], 'Repeat moves card 0 to end');

  // 8e: Trigger cram_known_1, 2, 0 until finished
  mockCtx.callbackQuery.data = 'cram_known_1';
  await cbCramKnown(mockCtx);
  mockCtx.callbackQuery.data = 'cram_known_2';
  await cbCramKnown(mockCtx);
  mockCtx.callbackQuery.data = 'cram_known_0';
  await cbCramKnown(mockCtx);

  assert(sentText.includes('Tabriklaymiz') || sentText.includes('o\'zlashtirildi') || sentText.includes('100%'), 'Completion message on deck finish');

  // 8f: Trigger cram_exit
  mockCtx.callbackQuery.data = 'cram_exit';
  await cbCramExit(mockCtx);
  assert(!cramSessions.has('77777'), 'cram_exit should clean up user session');
  console.log('✅ Test 8 Passed: End-to-end interactive lifecycle verified.');

  console.log('\n🎉 ALL 8 BLITZ-FLASHCARD & SPACED REPETITION TESTS PASSED SUCCESSFULLY! 🎉');
}

runTests().catch(err => {
  console.error('\n❌ Test execution failed:', err);
  process.exit(1);
});
