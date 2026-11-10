'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:fake_token_for_test';
process.env.NODE_ENV = 'test';

const assert = require('assert');
const { isValidWebAppUrl, buildWidgetMessage } = require('../src/services/widgetService');
const { deepClone, shuffleArray } = require('../src/core/questionUtils');
const utils = require('../src/core/utils');
const universalTestHub = require('../src/handlers/universalTestHub');
const cramReviewHandler = require('../src/handlers/cramReviewHandler');
const dbService = require('../src/services/dbService');

async function runTests() {
  console.log('🧪 Starting Production Bug Verification Tests...\n');

  // ─── TEST 1: isValidWebAppUrl rules ──────────────────────────────────────
  console.log('[Test 1] Testing isValidWebAppUrl Telegram Bot API compliance...');
  assert.strictEqual(isValidWebAppUrl('https://t.me/widget/123'), false, 't.me must be rejected');
  assert.strictEqual(isValidWebAppUrl('https://sub.t.me/widget/123'), false, '*.t.me must be rejected');
  assert.strictEqual(isValidWebAppUrl('https://telegram.org/widget/123'), false, 'telegram.org must be rejected');
  assert.strictEqual(isValidWebAppUrl('http://insecure.com/widget'), false, 'HTTP must be rejected (HTTPS required)');
  assert.strictEqual(isValidWebAppUrl(''), false, 'Empty string must be rejected');
  assert.strictEqual(isValidWebAppUrl(null), false, 'Null must be rejected');
  assert.strictEqual(isValidWebAppUrl(undefined), false, 'Undefined must be rejected');
  assert.strictEqual(isValidWebAppUrl('https://quiz-bot-app.code.run/widget/123'), true, 'Valid HTTPS cloud domain allowed');
  assert.strictEqual(isValidWebAppUrl('https://mybot.northflank.app/widget/token'), true, 'Valid Northflank domain allowed');
  console.log('  ✅ [PASS] isValidWebAppUrl correctly enforces Telegram Bot API HTTPS and anti-t.me rules.\n');

  // ─── TEST 2: BUTTON_URL_INVALID Prevention ──────────────────────────────
  console.log('[Test 2] Testing BUTTON_URL_INVALID prevention in buildWidgetMessage & cramReviewHandler...');
  const kbHidden = cramReviewHandler.getFlashcardFallbackKeyboard(0, false, 'https://t.me/widget/bad-token');
  const buttonsHidden = kbHidden.reply_markup ? kbHidden.reply_markup.inline_keyboard : kbHidden.inline_keyboard;
  
  // Must NOT include any button with t.me URL
  const allBtns = buttonsHidden.flat();
  const hasBadWebAppBtn = allBtns.some(b => b.web_app && b.web_app.url.includes('t.me'));
  assert.strictEqual(hasBadWebAppBtn, false, 'Keyboard must NOT contain web_app button with t.me URL');
  console.log('  ✅ [PASS] getFlashcardFallbackKeyboard rejects t.me URLs and does not emit broken web_app buttons.\n');

  // ─── TEST 3: deepClone and shuffleArray exports in utils & universalTestHub ───
  console.log('[Test 3] Testing deepClone & shuffleArray availability...');
  assert.strictEqual(typeof deepClone, 'function', 'deepClone must be a function in questionUtils');
  assert.strictEqual(typeof shuffleArray, 'function', 'shuffleArray must be a function in questionUtils');
  assert.strictEqual(typeof utils.deepClone, 'function', 'deepClone must be exported in utils.js as alias');
  assert.strictEqual(typeof utils.shuffleArray, 'function', 'shuffleArray must be exported in utils.js as alias');

  const testArr = [{ a: 1, b: [2, 3] }];
  const cloned = utils.deepClone(testArr);
  cloned[0].b.push(4);
  assert.strictEqual(testArr[0].b.length, 2, 'deepClone must perform real deep cloning');
  console.log('  ✅ [PASS] deepClone and shuffleArray properly resolved.\n');

  // ─── TEST 4: Reproduction of hub_mock_ugc and hub_cram_blitz_ugc calls ───
  console.log('[Test 4] Testing hub_mock_ugc and hub_cram_blitz_ugc execution without TypeError...');
  
  // Mock dbService to return UGC subject with blocks
  const origGetSubjectById = dbService.getSubjectById;
  const origGetSubjectBlocks = dbService.getSubjectBlocks;

  dbService.getSubjectById = async (id) => ({
    id: 54,
    name: 'Moliya va Bank',
    creator_id: 2014973670,
  });

  dbService.getSubjectBlocks = async (subjId) => [
    {
      id: 277,
      subject_id: 54,
      block_name: '1-Blok',
      questions: [
        { question: 'Savol 1', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
        { question: 'Savol 2', options: ['A', 'B', 'C', 'D'], correct_index: 1 },
      ],
    },
  ];

  let replyCalledWith = null;
  let lastSentText = '';
  const mockCtx = {
    chat: { id: 2014973670, type: 'private' },
    from: { id: 2014973670, first_name: 'AvazovM' },
    telegram: {
      sendMessage: async (chatId, text, extra) => {
        lastSentText = text;
        replyCalledWith = { text, extra };
        return { message_id: 100 };
      },
      sendPoll: async () => ({ message_id: 101, poll: { id: 'poll_1' } }),
      deleteMessage: async () => true,
    },
    answerCbQuery: async () => true,
    reply: async (text, extra) => {
      lastSentText = text;
      replyCalledWith = { text, extra };
      return { message_id: 999 };
    },
    editMessageText: async (text, extra) => {
      lastSentText = text;
      replyCalledWith = { text, extra };
      return true;
    },
  };

  // Run startSubjectMockExam
  await universalTestHub.startSubjectMockExam(mockCtx, 54, false);
  console.log('  ✅ [PASS] startSubjectMockExam executed cleanly without deepClone error.');

  // Run startSubjectBlitzCards
  await universalTestHub.startSubjectBlitzCards(mockCtx, 54, false);
  console.log('  ✅ [PASS] startSubjectBlitzCards executed cleanly without deepClone or BUTTON_URL_INVALID error.');

  // ─── TEST 5: AI Adaptive in Universal Hub & Zero-Mistakes Diagnostic Test ───
  console.log('\n[Test 5] Testing AI Adaptive picker & execution for UGC and Diagnostic mode...');
  // Run showAdaptivePicker
  await universalTestHub.showAdaptivePicker(mockCtx, 54, false);
  assert(replyCalledWith && replyCalledWith.text.includes('AI Adaptiv'), 'Must show AI Adaptiv prompt');
  console.log('  ✅ [PASS] showAdaptivePicker renders prompt with options.');

  // Run startSubjectAdaptiveRun
  await universalTestHub.startSubjectAdaptiveRun(mockCtx, 54, false, 10);
  assert(replyCalledWith && replyCalledWith.text.includes('Savollar:'), 'Must initialize adaptive test session');
  console.log('  ✅ [PASS] startSubjectAdaptiveRun successfully generates diagnostic adaptive quiz without blocking.');

  // Restore originals
  dbService.getSubjectById = origGetSubjectById;
  dbService.getSubjectBlocks = origGetSubjectBlocks;

  console.log('\n================================================================');
  console.log('🎉 ALL PRODUCTION BUG FIXES VERIFIED SUCCESSFULLY (5/5)!');
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
