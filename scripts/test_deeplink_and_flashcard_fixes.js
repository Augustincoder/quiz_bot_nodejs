'use strict';

process.env.BOT_TOKEN = '123456:mock_token_for_tests';
process.env.ADMIN_IDS = '2014973670';

/**
 * Verification Test Suite for Deep-Link Flashcard Flow,
 * Telegram 10.4 Widget Integration & Zero-Silence Fallbacks.
 */

const assert = require('assert');
const { Markup } = require('telegraf');

const universalTestHub = require('../src/handlers/universalTestHub');
const cramReviewHandler = require('../src/handlers/cramReviewHandler');
const widgetService = require('../src/services/widgetService');
const { safeEdit, stripWebAppButtons } = require('../src/core/utils');
const featureFlagService = require('../src/services/featureFlagService');

async function runTests() {
  console.log('🧪 Starting Deep-Link & Flashcard Fixes Test Suite...\n');

  // Ensure feature flag is active for testing
  await featureFlagService.setFeatureState('FEATURE_BLITZ_FLASHCARD', 'PUBLIC');
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', 'PUBLIC');

  // Setup Mock Memory DB
  const mockMemoryDb = {
    Matematika: {
      1: {
        questions: [
          { q: '2 + 2 = ?', options: ['A) 3', 'B) 4', 'C) 5'], correct_index: 1 },
          { q: '3 * 3 = ?', options: ['A) 6', 'B) 9', 'C) 12'], correct_index: 1 },
        ],
      },
      2: {
        questions: [
          { q: '10 / 2 = ?', options: ['A) 5', 'B) 4', 'C) 3'], correct_index: 0 },
        ],
      },
    },
  };
  universalTestHub.setMemoryDb(mockMemoryDb);
  cramReviewHandler.setMemoryDb(mockMemoryDb);

  // -----------------------------------------------------------
  // Test 1: Deep Link Subject Resolution
  // -----------------------------------------------------------
  console.log('[Test 1] Testing Deep-Link Subject & Block Resolution...');
  const offSubj = await universalTestHub.resolveSubjectData('offs_Matematika', true);
  assert(offSubj, 'Official subject should resolve from offs_ prefix');
  assert.strictEqual(offSubj.title, 'Matematika');
  assert.strictEqual(offSubj.blocks.length, 2);
  assert.strictEqual(offSubj.totalQuestions, 3);

  const offBlock = await universalTestHub.resolveBlockData('offt_Matematika_1', true);
  assert(offBlock, 'Official block should resolve from offt_ prefix');
  assert.strictEqual(offBlock.blockName, '1-Blok');
  assert.strictEqual(offBlock.questions.length, 2);
  console.log('  ✅ [PASS] offs_ and offt_ prefixes resolve accurately.');

  // -----------------------------------------------------------
  // Test 2: Placeholder Domain Rejection in isValidWebAppUrl & buildWidgetMessage
  // -----------------------------------------------------------
  console.log('\n[Test 2] Testing Placeholder Domain Rejection (Preventing BUTTON_URL_INVALID)...');
  assert.strictEqual(widgetService.isValidWebAppUrl('https://sub.t.me/widget/123'), false, 't.me must be rejected');
  assert.strictEqual(widgetService.isValidWebAppUrl('https://telegram.org/widget/123'), false, 'telegram.org must be rejected');
  assert.strictEqual(widgetService.isValidWebAppUrl('http://insecure.com'), false, 'http must be rejected');
  assert.strictEqual(widgetService.isValidWebAppUrl('https://my-real-quiz-app.railway.app/widget/abc'), true, 'Real HTTPS domain accepted');

  const msgWithNoEnv = widgetService.buildWidgetMessage('flashcard', { test: 1 }, 'Fallback text');
  assert(msgWithNoEnv.url && msgWithNoEnv.token, 'Widget message contains URL and token');
  assert.strictEqual(
    msgWithNoEnv.reply_markup.inline_keyboard.some(r => r.some(b => b.web_app)),
    true,
    'Keyboard has widget launcher when default URL is present'
  );
  console.log('  ✅ [PASS] Placeholder and invalid domains strictly rejected.');

  // -----------------------------------------------------------
  // Test 3: safeEdit Circuit Breaker & stripWebAppButtons
  // -----------------------------------------------------------
  console.log('\n[Test 3] Testing safeEdit BUTTON_URL_INVALID Recovery...');
  const badKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: 'Bad WebApp', web_app: { url: 'https://invalid-url.com' } }],
        [{ text: 'Normal Button', callback_data: 'normal_cb' }],
      ],
    },
  };

  const stripped = stripWebAppButtons(badKeyboard);
  assert.strictEqual(stripped.reply_markup.inline_keyboard.length, 1);
  assert.strictEqual(stripped.reply_markup.inline_keyboard[0][0].callback_data, 'normal_cb');

  // Simulate context where editMessageText throws BUTTON_URL_INVALID initially
  let editAttempts = 0;
  let replyAttempts = 0;
  const mockCtx = {
    editMessageText: async (text, extra) => {
      editAttempts++;
      if (extra?.reply_markup?.inline_keyboard?.some(r => r.some(b => b.web_app))) {
        const err = new Error('400: Bad Request: BUTTON_URL_INVALID');
        err.description = 'Bad Request: BUTTON_URL_INVALID';
        throw err;
      }
      return true;
    },
    reply: async (text, extra) => {
      replyAttempts++;
      return true;
    },
  };

  const editResult = await safeEdit(mockCtx, 'Test message', badKeyboard);
  assert.strictEqual(editResult, true, 'safeEdit must succeed by recovering from BUTTON_URL_INVALID');
  assert.strictEqual(editAttempts, 2, 'Should have retried editMessageText with stripped keyboard');
  console.log('  ✅ [PASS] safeEdit seamlessly stripped invalid web_app buttons and delivered message without silence.');

  // -----------------------------------------------------------
  // Test 4: Launching Flashcards for a Block & 20-Card Blitz
  // -----------------------------------------------------------
  console.log('\n[Test 4] Testing launchFlashcardReview (Block & 20-Card Blitz)...');
  let sentText = '';
  let sentExtra = null;
  const simCtx = {
    from: { id: 12345678, first_name: 'TestUser' },
    chat: { id: 12345678, type: 'private' },
    callbackQuery: { data: 'cram_start_Matematika_1', message: { message_id: 999 } },
    answerCbQuery: async () => true,
    editMessageText: async (text, extra) => {
      sentText = text;
      sentExtra = extra;
      return true;
    },
    reply: async (text, extra) => {
      sentText = text;
      sentExtra = extra;
      return true;
    },
    telegram: {
      callApi: async (method, params) => {
        // Simulate Telegram API without 10.4 widgets in this test env
        throw new Error('404: Not Found: method sendWidget');
      },
    },
  };

  // Launch block 1
  await cramReviewHandler.launchFlashcardReview(simCtx, 'Matematika', '1');
  assert(sentText.includes('Blitz-Flashcard'), 'Message must contain flashcard header');
  assert(sentText.includes('2 + 2 = ?'), 'First question must be present');
  assert(!sentText.includes('✅ To\'g\'ri javob:'), 'Answer must NOT be revealed initially');
  assert(sentExtra?.reply_markup?.inline_keyboard, 'Inline keyboard must be present');
  console.log('  ✅ [PASS] Block flashcard launched with interactive questions.');

  // -----------------------------------------------------------
  // Test 5: Answer Reveal & Full Correct Answer Extraction
  // -----------------------------------------------------------
  console.log('\n[Test 5] Testing Card Flip & Answer Reveal...');
  const revealCtx = {
    from: { id: 12345678 },
    chat: { id: 12345678 },
    callbackQuery: { data: 'cram_reveal_0' },
    answerCbQuery: async () => true,
    editMessageText: async (text, extra) => {
      sentText = text;
      sentExtra = extra;
      return true;
    },
    reply: async (text, extra) => {
      sentText = text;
      sentExtra = extra;
      return true;
    },
  };

  await cramReviewHandler.cbCramReveal(revealCtx);
  assert(sentText.includes("To'g'ri javob"), 'Answer section must be revealed');
  assert(sentText.includes('4'), 'Must display the true correct answer string "4"');
  const allButtons = sentExtra.reply_markup.inline_keyboard.flat();
  const hasYashirish = allButtons.some(b => b.text && b.text.includes('Yashirish'));
  assert(hasYashirish, 'Reveal button should switch to Yashirish');
  console.log('  ✅ [PASS] Answer revealed with correct answer text "4" and toggle button.');

  // -----------------------------------------------------------
  // Test 6: Spaced Repetition Progression (Known / Repeat)
  // -----------------------------------------------------------
  console.log('\n[Test 6] Testing Card Progression (Bilib oldim)...');
  const knownCtx = {
    from: { id: 12345678 },
    chat: { id: 12345678 },
    callbackQuery: { data: 'cram_known_0' },
    answerCbQuery: async () => true,
    editMessageText: async (text, extra) => {
      sentText = text;
      sentExtra = extra;
      return true;
    },
    reply: async (text, extra) => {
      sentText = text;
      sentExtra = extra;
      return true;
    },
  };

  await cramReviewHandler.cbCramKnown(knownCtx);
  assert(sentText.includes('3 * 3 = ?'), 'Next question must be presented');
  assert(!sentText.includes('✅ To\'g\'ri javob:'), 'Next card answer must be hidden');
  console.log('  ✅ [PASS] Advanced to next card seamlessly.');

  // -----------------------------------------------------------
  // Test 7: Telegram 10.4 Widget editSharedWidgetData & editMessageWidgetData
  // -----------------------------------------------------------
  console.log('\n[Test 7] Testing Telegram 10.4 Widget Update Queries...');
  let sharedWidgetApiCalled = false;
  let sharedWidgetPayload = null;

  const mockTg = {
    callApi: async (method, params) => {
      if (method === 'answerWidgetQuery') return { ok: true };
      if (method === 'editSharedWidgetData') {
        sharedWidgetApiCalled = true;
        sharedWidgetPayload = params;
        return { ok: true };
      }
      return { ok: true };
    },
  };

  const widgetQueryCtx = {
    telegram: mockTg,
  };

  await cramReviewHandler.handleSharedWidgetQuery(widgetQueryCtx, {
    id: 'wq_1001',
    from: { id: 12345678 },
    widget_id: 'wid_777',
    data: 'known',
  });

  assert.strictEqual(sharedWidgetApiCalled, true, 'editSharedWidgetData must be called on shared widget queries');
  assert.strictEqual(sharedWidgetPayload.widget_id, 'wid_777');
  assert(sharedWidgetPayload.public_data, 'public_data must be updated');
  const parsedPub = JSON.parse(sharedWidgetPayload.public_data);
  assert(parsedPub.learned >= 1, 'Learned count in shared widget state must be incremented');
  console.log('  ✅ [PASS] editSharedWidgetData successfully handled with updated shared state.');

  console.log('\n======================================================');
  console.log('🎉 ALL DEEP-LINK & FLASHCARD FIXES VERIFIED SUCCESSFULLY! 🚀');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
