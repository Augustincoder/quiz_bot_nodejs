'use strict';

process.env.BOT_TOKEN = '123456:mock_token_for_tests';
process.env.ADMIN_IDS = '2014973670';

const assert = require('assert');
const {
  buildInlineFlashcardWidgetHtml,
  compressWidgetHtml,
} = require('../src/services/widgetService');
const cramReviewHandler = require('../src/handlers/cramReviewHandler');
const universalTestHub = require('../src/handlers/universalTestHub');
const dbService = require('../src/services/dbService');

async function runTests() {
  console.log('🧪 Starting Telegram Bot API 10.4 HTML Widget & Flashcard Verification Tests...\n');

  // ─── TEST 1: Telegram 10.4 Widget Limits & Compression ───
  console.log('[Test 1] Testing HTML Widget byte size and zlib compression limits...');
  const mockViewData = {
    subjectName: 'Tarix',
    blockName: '1-Blok',
    question: 'Amir Temur qachon tug\'ilgan?',
    answer: '1336-yil 9-aprel',
    total: 20,
    learnedCount: 5,
    cardIdx: 0,
  };

  const widgetHtml = buildInlineFlashcardWidgetHtml(mockViewData);
  assert(widgetHtml.includes('TelegramWidget'), 'Must integrate TelegramWidget object');
  assert(widgetHtml.includes('publicDataChanged'), 'Must listen to publicDataChanged');
  assert(widgetHtml.includes('chatDataChanged'), 'Must listen to chatDataChanged');
  assert(widgetHtml.includes('sendQuery'), 'Must provide sendQuery for user actions');

  const comp = compressWidgetHtml(widgetHtml);
  console.log(`  Raw UTF-8: ${comp.rawBytes} bytes (Limit: 32768)`);
  console.log(`  Zlib Level 9: ${comp.compressedBytes} bytes (Limit: 4096)`);
  assert(comp.valid, 'Widget HTML MUST pass Telegram Bot API 10.4 size constraints');
  console.log('  ✅ [PASS] Inline widget strictly satisfies Telegram Bot API limits.\n');

  // ─── TEST 2: Native sendWidget Invocation in launchFlashcardReview ───
  console.log('[Test 2] Testing sendWidget execution with shared widget parameters...');
  const apiCalls = [];
  let answerCbCalled = false;
  let replyOrEditCalled = false;

  const mockCtx = {
    chat: { id: 2014973670, type: 'private' },
    from: { id: 2014973670, first_name: 'AvazovM' },
    callbackQuery: {
      id: 'cb_query_1',
      data: 'cram_start_ugc_277',
      message: { message_id: 111 },
    },
    telegram: {
      callApi: async (method, params) => {
        apiCalls.push({ method, params });
        if (method === 'sendWidget') {
          return {
            message_id: 999,
            widget: { id: 'shared_widget_12345' },
          };
        }
        return { ok: true };
      },
      deleteMessage: async () => true,
    },
    deleteMessage: async () => true,
    answerCbQuery: async (text, opts) => {
      answerCbCalled = true;
      return true;
    },
    reply: async () => {
      replyOrEditCalled = true;
      return { message_id: 100 };
    },
    editMessageText: async () => {
      replyOrEditCalled = true;
      return true;
    },
  };

  const mockQuestions = [
    { question: 'Savol 1', answer: 'Javob 1', options: ['Javob 1', 'Noto\'g\'ri'] },
    { question: 'Savol 2', answer: 'Javob 2', options: ['Noto\'g\'ri', 'Javob 2'] },
  ];

  await cramReviewHandler.launchFlashcardReview(
    mockCtx,
    'ugc',
    '277',
    mockQuestions,
    { subjectName: 'Tarix', blockName: '1-Blok' }
  );

  const sendWidgetCall = apiCalls.find(c => c.method === 'sendWidget');
  assert(sendWidgetCall, 'Must call sendWidget API for private chats');
  assert.strictEqual(sendWidgetCall.params.chat_id, 2014973670, 'chat_id must match');
  assert.strictEqual(sendWidgetCall.params.is_shared, true, 'is_shared must be true');
  assert.strictEqual(sendWidgetCall.params.allow_queries, true, 'allow_queries must be true');
  assert(sendWidgetCall.params.public_data, 'Must provide public_data');
  assert(sendWidgetCall.params.html, 'Must provide HTML widget');
  console.log('  ✅ [PASS] sendWidget called with is_shared=true, allow_queries=true and compliant HTML.\n');

  // ─── TEST 3: handleWidgetQuery and handleSharedWidgetQuery ───
  console.log('[Test 3] Testing widget_query and shared_widget_query handling (editSharedWidgetData)...');
  apiCalls.length = 0;

  // Simulate widget_query (message-specific)
  const widgetQuery = {
    id: 'wq_query_99',
    from: { id: 2014973670 },
    chat: { id: 2014973670 },
    message_id: 999,
    data: 'known',
  };
  await cramReviewHandler.handleWidgetQuery(mockCtx, widgetQuery);

  const answerQueryCall = apiCalls.find(c => c.method === 'answerWidgetQuery');
  assert(answerQueryCall, 'Must call answerWidgetQuery within 15s');
  assert.strictEqual(answerQueryCall.params.widget_query_id, 'wq_query_99');

  const editMsgWidgetCall = apiCalls.find(c => c.method === 'editMessageWidgetData');
  assert(editMsgWidgetCall, 'Must call editMessageWidgetData to push state update');
  console.log('  ✅ [PASS] handleWidgetQuery answered and updated message widget data.');

  // Simulate shared_widget_query (uses editSharedWidgetData per Telegram link!)
  apiCalls.length = 0;
  const sharedQuery = {
    id: 'swq_query_100',
    from: { id: 2014973670 },
    widget_id: 'shared_widget_12345',
    data: 'repeat',
  };
  await cramReviewHandler.handleSharedWidgetQuery(mockCtx, sharedQuery);

  const answerSharedCall = apiCalls.find(c => c.method === 'answerWidgetQuery');
  assert(answerSharedCall, 'Must call answerWidgetQuery for shared query');

  const editSharedCall = apiCalls.find(c => c.method === 'editSharedWidgetData');
  assert(editSharedCall, 'Must call editSharedWidgetData per https://core.telegram.org/bots/api#editsharedwidgetdata');
  assert.strictEqual(editSharedCall.params.widget_id, 'shared_widget_12345');
  assert.strictEqual(editSharedCall.params.cache_time, 5);
  const parsedPublic = JSON.parse(editSharedCall.params.public_data);
  assert(parsedPublic.q, 'Public data must contain question state');
  console.log('  ✅ [PASS] handleSharedWidgetQuery cleanly called editSharedWidgetData.\n');

  // ─── TEST 4: No Silent Freeze on Empty or Missing Subject/Block ───
  console.log('[Test 4] Testing graceful error presentation on missing blocks/questions...');
  let editedWithText = '';
  mockCtx.editMessageText = async (text) => {
    editedWithText = text;
    return true;
  };

  // Missing data in startSubjectBlitzCards
  const origResolveSubjectData = universalTestHub.resolveSubjectData;
  universalTestHub.resolveSubjectData = async () => null;

  await universalTestHub.startSubjectBlitzCards(mockCtx, 999999, false);
  assert(editedWithText.includes('topilmadi'), 'Must present clear error message instead of dying silently');
  console.log('  ✅ [PASS] startSubjectBlitzCards shows clear message when data is not found.');

  // Missing questions in launchFlashcardReview
  editedWithText = '';
  await cramReviewHandler.launchFlashcardReview(mockCtx, 'ugc', 999999, []);
  assert(editedWithText.includes('topilmadi'), 'Must present clear error message when questions are empty');
  console.log('  ✅ [PASS] launchFlashcardReview shows clear message when questions are empty.\n');

  // ─── TEST 5: Interactive Fallback Message Flip (cram_reveal / cram_hide) ───
  console.log('[Test 5] Testing interactive fallback reveal and answer display...');
  let lastEditedText = '';
  let lastExtra = null;
  mockCtx.editMessageText = async (text, extra) => {
    lastEditedText = text;
    lastExtra = extra;
    return true;
  };

  // Re-seed session
  await cramReviewHandler.launchFlashcardReview(
    mockCtx,
    'ugc',
    '277',
    mockQuestions,
    { subjectName: 'Falsafa', blockName: '1-Blok' }
  );

  // User taps [ 👁 Javobni ko'rish ]
  mockCtx.callbackQuery.data = 'cram_reveal_0';
  await cramReviewHandler.cbCramReveal(mockCtx);
  assert(lastEditedText.includes('To\'g\'ri javob'), 'Revealed message MUST display correct answer section');
  assert(lastEditedText.includes('Javob 1'), 'Must display true answer text: "Javob 1"');
  console.log('  ✅ [PASS] cbCramReveal correctly formats and displays answer text.');

  // User taps [ 🙈 Yashirish ]
  mockCtx.callbackQuery.data = 'cram_hide_0';
  await cramReviewHandler.cbCramHide(mockCtx);
  assert(!lastEditedText.includes('To\'g\'ri javob:'), 'Hidden message MUST NOT display answer');
  console.log('  ✅ [PASS] cbCramHide correctly hides answer.');

  // Restore originals
  universalTestHub.resolveSubjectData = origResolveSubjectData;

  console.log('\n================================================================');
  console.log('🎉 ALL 5 TELEGRAM 10.4 WIDGET & FLASHCARD FIXES VERIFIED! 🚀');
  console.log('================================================================\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
