'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_BOT_TOKEN_FOR_FLASHCARD';

const assert = require('assert');
const { initFlashcardDeck, extractCorrectAnswerText } = require('../src/handlers/cramReviewHandler');

console.log('🧪 Starting Flashcard Correct Answer & Question Normalization Tests...\n');

// 1. Numeric correct_index (Standard Bot API format)
{
  const q1 = {
    question: 'O\'zbekiston poytaxti qayer?',
    options: ['Samarqand', 'Toshkent', 'Buxoro', 'Xiva'],
    correct_index: 1,
  };
  const ans = extractCorrectAnswerText(q1);
  assert.strictEqual(ans, 'Toshkent', `Expected 'Toshkent', got '${ans}'`);
  console.log('  ✅ [PASS] Numeric correct_index (1) resolves to "Toshkent"');
}

// 2. Numeric correct_index = 0 (Falsy 0 bug check)
{
  const q0 = {
    question: 'Eng katta sayyora?',
    options: ['Yupiter', 'Mars', 'Venera', 'Saturn'],
    correct_index: 0,
  };
  const ans = extractCorrectAnswerText(q0);
  assert.strictEqual(ans, 'Yupiter', `Expected 'Yupiter', got '${ans}'`);
  console.log('  ✅ [PASS] Numeric correct_index (0) properly resolves without falsy fallback');
}

// 3. String correct_index ("2") or answer: 2
{
  const qStr = {
    question: 'Quyosh tizimida nechta sayyora bor?',
    options: ['7 ta', '9 ta', '8 ta'],
    correct_index: '2',
  };
  const ans = extractCorrectAnswerText(qStr);
  assert.strictEqual(ans, '8 ta', `Expected '8 ta', got '${ans}'`);
  console.log('  ✅ [PASS] String numeric index ("2") properly resolves');
}

// 4. Raw correct_ans string property
{
  const qAns = {
    question: 'Suvning kimyoviy formulasi?',
    options: ['H2O', 'CO2', 'NaCl'],
    correct_ans: 'H2O',
  };
  const ans = extractCorrectAnswerText(qAns);
  assert.strictEqual(ans, 'H2O', `Expected 'H2O', got '${ans}'`);
  console.log('  ✅ [PASS] Explicit correct_ans string property recognized');
}

// 5. Options with leading "#" or "A)" markers
{
  const qPrefixed = {
    question: 'Fotosintez uchun nima zarur?',
    options: ['A) Qorong\'ulik', '#B) Quyosh nuri', 'C) Muz'],
    correct_index: 1,
  };
  const ans = extractCorrectAnswerText(qPrefixed);
  assert.strictEqual(ans, 'Quyosh nuri', `Expected 'Quyosh nuri' (cleaned), got '${ans}'`);
  console.log('  ✅ [PASS] Prefixes like "#B)" cleanly stripped from answer text');
}

// 6. Deck initialization integration
{
  const questions = [
    { question: 'Q1', options: ['A', 'To\'g\'ri variant 1'], correct_index: 1 },
    { question: 'Q2', options: ['To\'g\'ri variant 2', 'B'], correct_index: 0 },
  ];
  const deck = initFlashcardDeck(questions);
  assert.strictEqual(deck.cards[0].answer, 'To\'g\'ri variant 1');
  assert.strictEqual(deck.cards[1].answer, 'To\'g\'ri variant 2');
  console.log('  ✅ [PASS] initFlashcardDeck populates cards[i].answer with true answer strings');
}

console.log('\n🎉 ALL FLASHCARD ANSWER EXTRACTION TESTS PASSED! 🚀');
