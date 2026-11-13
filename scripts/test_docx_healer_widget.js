'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_BOT_TOKEN_FOR_WIDGET';

const assert = require('assert');
const widgetService = require('../src/services/widgetService');
const widgetServer = require('../src/widgets/widgetServer');
const testCreation = require('../src/handlers/testCreation');
const featureFlagService = require('../src/services/featureFlagService');
const redisConnection = require('../src/services/redisService');

async function runDocxHealerWidgetTests() {
  console.log('🧪 Starting Docx Healer Widget Verification Suite...\n');

  await featureFlagService.setFeatureState('FEATURE_DOCX_SMART_HEALER', featureFlagService.STATES.PUBLIC);
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', featureFlagService.STATES.PUBLIC);

  // ─── TEST 1: Telegram Bot API 10.4 sendWidget Inline HTML Specifications ───
  console.log('[Test 1] Testing buildInlineDocxHealerWidgetHtml compliance...');

  const sampleQuestions = [
    {
      id: 1,
      questionText: 'Pul va kredit munosabatlarining asosi nima?',
      error: 'To\'g\'ri javob kaliti belgilanmagan',
      options: [
        { text: 'Taqsimot va ayirboshlash', cleanText: 'Taqsimot va ayirboshlash', isCorrect: false },
        { text: 'Faqat foiz olish', cleanText: 'Faqat foiz olish', isCorrect: false },
        { text: 'Qarz shartnomasi', cleanText: 'Qarz shartnomasi', isCorrect: false },
      ],
      raw: 'Pul va kredit munosabatlarining asosi nima?\nA) Taqsimot va ayirboshlash\nB) Faqat foiz olish\nC) Qarz shartnomasi',
    },
    {
      id: 2,
      questionText: 'Fisher effekti formulasi qaysi?',
      error: 'Variantlar kam',
      options: [
        { text: 'i = r + pi', cleanText: 'i = r + pi', isCorrect: true },
        { text: 'E = mc^2', cleanText: 'E = mc^2', isCorrect: false },
      ],
      raw: 'Fisher effekti formulasi qaysi?\n#i = r + pi\nE = mc^2',
    },
  ];

  const inlineHtml = widgetService.buildInlineDocxHealerWidgetHtml({
    questions: sampleQuestions,
    currentIndex: 0,
    fileName: 'pul_va_kredit_1.docx',
  });

  assert(typeof inlineHtml === 'string' && inlineHtml.length > 500, 'inlineHtml must be a non-empty string');
  assert(!inlineHtml.includes('http://') && !inlineHtml.includes('https://'), 'Must have zero external network requests for QuickJS sandbox');
  assert(!inlineHtml.includes('<script src='), 'Must not load external scripts');
  assert(!inlineHtml.includes('<link rel="stylesheet"'), 'Must not load external stylesheets');
  assert(!inlineHtml.includes('\0'), 'Must not contain null bytes');

  // Verify Bot API 10.4 Compression limit (<= 4096 bytes zlib level 9)
  const compressed = widgetService.compressWidgetHtml(inlineHtml);
  console.log(`  Raw HTML: ${compressed.rawBytes} bytes, Compressed: ${compressed.compressedBytes} bytes (Limit: 4096)`);
  assert(compressed.valid, `Compressed HTML must be <= 4096 bytes (was ${compressed.compressedBytes})`);
  assert(compressed.compressedBytes <= 4000, 'Should comfortably sit below 4000 bytes');

  // Verify responsive viewport & height declarations
  assert(inlineHtml.includes('min-height: 300px'), 'Must declare min-height to prevent vertical truncation');
  assert(inlineHtml.includes('overflow-y: auto'), 'Must support scrollable question text');
  assert(inlineHtml.includes('TelegramWidget'), 'Must integrate TelegramWidget natively');
  assert(inlineHtml.includes('setResizeAnchor'), 'Must set resize anchor');
  assert(inlineHtml.includes('touchstart') && inlineHtml.includes('touchmove') && inlineHtml.includes('touchend'), 'Must include mobile touch swipe listeners');

  console.log('✅ Test 1 Passed: Inline Docx Healer conforms 100% to Bot API 10.4 specifications.\n');

  // ─── TEST 2: WebApp Inspector Template (docxHealerWidget.html) ───
  console.log('[Test 2] Testing WebApp Inspector template render & features...');

  const webAppHtml = widgetService.renderWidgetHtml('docxHealer', {
    title: 'Pul va Kredit - Xatoliklar Inspektori',
    fileName: 'pul_va_kredit_test.docx',
    questions: sampleQuestions,
    token: 'test_token_123',
  });

  assert(webAppHtml.includes('Pul va Kredit - Xatoliklar Inspektori'), 'Rendered HTML must contain title');
  assert(webAppHtml.includes('var W = window.TelegramWidget'), 'Must initialize resilient Telegram widget/webapp handle');
  assert(webAppHtml.includes('autoHealAll'), 'Must contain autoHealAll handler');
  assert(webAppHtml.includes('deleteCurrentQuestion'), 'Must contain deleteCurrentQuestion handler');
  assert(webAppHtml.includes('saveAndComplete'), 'Must contain saveAndComplete handler');
  assert(webAppHtml.includes('--tg-theme-bg-color'), 'Must use Telegram CSS variables');
  assert(webAppHtml.includes('bar-fill'), 'Must render visual progress bar');
  assert(webAppHtml.includes('toast'), 'Must include toast alert notification element');

  console.log('✅ Test 2 Passed: WebApp Inspector template renders cleanly with all interactive features.\n');

  // ─── TEST 3: Widget Server Query Actions & Redis Persistence ───
  console.log('[Test 3] Testing widgetServer query actions & persistence...');

  const testUserId = 888777;
  const verifiedToken = {
    userId: testUserId,
    type: 'docxHealer',
    payload: {
      questions: sampleQuestions,
    },
  };

  // Seed Redis session
  const initialSession = {
    data: {
      subject: 'Pul va kredit',
      block_name: '1-Blok',
      is_auto_docx: true,
      questions: [],
      invalidQs: sampleQuestions.map(q => q.raw),
    },
  };
  await redisConnection.set(`tg_session:${testUserId}`, JSON.stringify(initialSession), 'EX', 3600);

  // 3a: Test fix_option action
  console.log('  3a: Testing fix_option...');
  const fixRes = await widgetServer.executeQueryAction(verifiedToken, 'fix_option', {
    questionIdx: 0,
    correctOptionIdx: 0,
  });
  assert.strictEqual(fixRes.status, 'updated');
  assert.strictEqual(fixRes.questionIdx, 0);
  assert.strictEqual(fixRes.correctOptionIdx, 0);

  // 3b: Test auto_heal_all action
  console.log('  3b: Testing auto_heal_all...');
  const healRes = await widgetServer.executeQueryAction(verifiedToken, 'auto_heal_all', {
    questions: sampleQuestions,
  });
  assert.strictEqual(healRes.status, 'auto_healed');
  assert(Array.isArray(healRes.healed) && healRes.healed.length > 0, 'Must return healed questions array');
  assert(healRes.healed[0].options.some(o => o.isCorrect), 'Healed question must have a marked correct option');

  // 3c: Test save_docx action and session persistence
  console.log('  3c: Testing save_docx session persistence...');
  const fixedQuestionsToSave = [
    {
      id: 1,
      questionText: 'Pul va kredit munosabatlarining asosi nima?',
      options: [
        { text: 'Taqsimot va ayirboshlash', cleanText: 'Taqsimot va ayirboshlash', isCorrect: true },
        { text: 'Faqat foiz olish', cleanText: 'Faqat foiz olish', isCorrect: false },
      ],
      raw: 'Pul va kredit munosabatlarining asosi nima?\n#Taqsimot va ayirboshlash\nFaqat foiz olish',
    },
  ];

  const saveRes = await widgetServer.executeQueryAction(verifiedToken, 'save_docx', {
    questions: fixedQuestionsToSave,
  });
  assert.strictEqual(saveRes.status, 'completed');
  assert.strictEqual(saveRes.savedCount, 1);

  // Verify updated Redis session
  const updatedSessionRaw = await redisConnection.get(`tg_session:${testUserId}`);
  assert(updatedSessionRaw, 'Redis session must exist after save_docx');
  const updatedSession = JSON.parse(updatedSessionRaw);
  assert.strictEqual(updatedSession.data.questions.length, 1, 'Saved questions must be in session.data.questions');
  assert.strictEqual(updatedSession.data.questions[0].question, 'Pul va kredit munosabatlarining asosi nima?');
  assert.strictEqual(updatedSession.data.questions[0].correct_index, 0);
  assert(Array.isArray(updatedSession.data.chunks), 'Auto-docx chunks must be maintained');

  // 3d: Test delete_question action
  console.log('  3d: Testing delete_question...');
  const delRes = await widgetServer.executeQueryAction(verifiedToken, 'delete_question', {
    questionIdx: 0,
  });
  assert.strictEqual(delRes.status, 'deleted');

  console.log('✅ Test 3 Passed: widgetServer query actions update state and persist to Redis accurately.\n');

  // ─── TEST 4: Native sendWidget Dispatch in cbOpenInspector ───
  console.log('[Test 4] Testing cbOpenInspector sendWidget dual-mode execution...');

  let calledApiMethod = '';
  let calledApiPayload = null;
  let deletedMsg = false;

  const mockCtxWidget = {
    chat: { id: 999111, type: 'private' },
    from: { id: 999111 },
    session: {
      data: {
        block_name: 'Pul va kredit (1-qism)',
        invalidQs: [
          'Pul nima?\nA) Umumiy ekvivalent\nB) Qog‘oz\nC) Metall',
        ],
        questions: [],
      },
    },
    callbackQuery: { message: { message_id: 555 } },
    telegram: {
      callApi: async (method, payload) => {
        calledApiMethod = method;
        calledApiPayload = payload;
        return { message_id: 777, widget: { id: 'w_test_123' } };
      },
    },
    deleteMessage: async () => {
      deletedMsg = true;
    },
    answerCbQuery: async () => {},
    reply: async () => {},
  };

  await testCreation.cbOpenInspector(mockCtxWidget);

  assert.strictEqual(calledApiMethod, 'sendWidget', 'cbOpenInspector must call sendWidget in private chat');
  assert(calledApiPayload, 'sendWidget payload must be provided');
  assert.strictEqual(calledApiPayload.chat_id, 999111);
  assert(calledApiPayload.html && calledApiPayload.html.includes('Docx Healer'), 'HTML must contain Docx Healer widget');
  assert(calledApiPayload.reply_markup, 'reply_markup must be included');

  const markupStr = JSON.stringify(calledApiPayload.reply_markup);
  assert(!markupStr.includes('web_app'), 'sendWidget action keyboard must NOT duplicate WebApp button');
  assert(markupStr.includes('fix_auto_all'), 'Must include AI auto-heal callback');
  assert(markupStr.includes('finish_test_creation'), 'Must include finish test creation callback');
  assert(deletedMsg, 'Must delete previous menu message to keep chat uncluttered');

  console.log('✅ Test 4 Passed: cbOpenInspector cleanly dispatches native sendWidget without redundant WebApp button.\n');

  // ─── TEST 5: handleDocxWidgetQuery Interactive Updates ───
  console.log('[Test 5] Testing handleDocxWidgetQuery interaction handling...');

  let editedWidgetPayload = null;
  let answeredQueryPayload = null;

  const mockQueryCtx = {
    session: {
      data: {
        invalidQs: [
          'Kredit nima?\nA) Qaytarib berish sharti bilan berilgan pul\nB) Sovg‘a',
        ],
        questions: [],
      },
    },
    telegram: {
      callApi: async (method, payload) => {
        if (method === 'editMessageWidgetData') editedWidgetPayload = payload;
        if (method === 'answerWidgetQuery') answeredQueryPayload = payload;
        return true;
      },
    },
  };

  const sampleQuery = {
    id: 'wq_12345',
    from: { id: 999111 },
    chat: { id: 999111 },
    message_id: 777,
    data: JSON.stringify({ action: 'docx_pick', qIdx: 0, optIdx: 0 }),
  };

  await testCreation.handleDocxWidgetQuery(mockQueryCtx, sampleQuery);

  assert(editedWidgetPayload, 'Must call editMessageWidgetData on pick action');
  assert.strictEqual(editedWidgetPayload.chat_id, 999111);
  assert.strictEqual(editedWidgetPayload.message_id, 777);
  assert(editedWidgetPayload.public_data, 'Must send updated public_data');

  assert(answeredQueryPayload, 'Must call answerWidgetQuery to unblock client');
  assert.strictEqual(answeredQueryPayload.widget_query_id, 'wq_12345');

  console.log('✅ Test 5 Passed: handleDocxWidgetQuery updates widget data and answers query cleanly.\n');

  console.log('======================================================');
  console.log('🎉 ALL DOCX HEALER WIDGET TESTS COMPLETED WITH 0 ERRORS! 🚀');
  console.log('======================================================');
}

runDocxHealerWidgetTests().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
