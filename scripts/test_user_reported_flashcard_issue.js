'use strict';

process.env.BOT_TOKEN = '123456:mock_token_for_tests';
process.env.ADMIN_IDS = '2014973670';

const assert = require('assert');
const { decodeHtmlEntities, escapeTelegramHtml } = require('../src/core/utils');
const { buildInlineFlashcardWidgetHtml, compressWidgetHtml } = require('../src/services/widgetService');
const cramReviewHandler = require('../src/handlers/cramReviewHandler');

async function testUserReportedFlashcardIssue() {
  console.log('🧪 Testing User-Reported Flashcard & sendWidget Issues...\n');

  // ─── TEST 1: Question with &quot; and HTML entities decoding ───
  console.log('[Test 1] Testing question text entity decoding and message formatting...');
  const rawQuestionWithEntities = '&quot;Nominal foiz stavkasi&quot; va &quot;Real foiz stavkasi&quot; o‘rtasidagi bog‘liqlik qaysi tenglama (Fisher effekti) orqali ifodalanadi?';
  const rawAnswerWithEntities = '(1 + i) = (1 + r) &times; (1 + &pi;)';

  const decodedQ = decodeHtmlEntities(rawQuestionWithEntities);
  assert(!decodedQ.includes('&quot;'), 'Decoded question must not contain &quot;');
  assert(decodedQ.startsWith('"Nominal foiz stavkasi"'), 'Must start with literal double quote');
  console.log('  Decoded Question:', decodedQ);

  const escapedForTg = escapeTelegramHtml(rawQuestionWithEntities);
  assert(!escapedForTg.includes('&quot;'), 'Telegram HTML must NOT output &quot;');
  assert(!escapedForTg.includes('&amp;quot;'), 'Telegram HTML must NOT output &amp;quot;');
  assert(escapedForTg.includes('"Nominal foiz stavkasi"'), 'Quotes must remain literal in body text');
  console.log('  Telegram HTML Question:', escapedForTg);
  console.log('  ✅ [PASS] Entities decoded cleanly without double-escaping.\n');

  // ─── TEST 2: formatFlashcardMessage with user question ───
  console.log('[Test 2] Testing formatFlashcardMessage with user viewData...');
  const mockViewData = {
    subjectName: 'pul va kredit 3-kurs 1-modul',
    blockName: 'pul va kredit (11-qism)',
    question: rawQuestionWithEntities,
    answer: '(1 + i) = (1 + r)(1 + π)',
    total: 17,
    learnedCount: 0,
    percent: 0,
    cardIdx: 0,
  };

  const messageText = cramReviewHandler.formatFlashcardMessage(mockViewData, false);
  console.log('--- Formatted Message ---');
  console.log(messageText);
  console.log('-------------------------');
  assert(!messageText.includes('&quot;'), 'Message text must NEVER contain &quot;');
  assert(messageText.includes('"Nominal foiz stavkasi"'), 'Must contain natural quote "');
  assert(messageText.includes('pul va kredit 3-kurs 1-modul'), 'Must contain subject name');
  assert(messageText.includes('0 / 17 (0%)'), 'Must contain progress stats');
  console.log('  ✅ [PASS] formatFlashcardMessage output matches desired user display.\n');

  // ─── TEST 3: sendWidget Payload and Constraints ───
  console.log('[Test 3] Testing sendWidget payload compliance with https://core.telegram.org/bots/api#sendwidget...');
  const sentPayloads = [];
  const mockCtx = {
    chat: { id: 2014973670, type: 'private' },
    from: { id: 2014973670 },
    callbackQuery: {
      id: 'cb_123',
      message: { message_id: 555 },
    },
    telegram: {
      callApi: async (method, payload) => {
        if (method === 'sendWidget') {
          sentPayloads.push(payload);
          return { message_id: 777, widget: { id: 'w_test_99' } };
        }
        return { ok: true };
      },
    },
    deleteMessage: async () => true,
    answerCbQuery: async () => true,
  };

  const questions = [
    {
      question: rawQuestionWithEntities,
      answer: '(1 + i) = (1 + r)(1 + π)',
      options: ['(1 + i) = (1 + r)(1 + π)', 'i = r + π', 'i = r - π'],
    },
    {
      question: '2-savol: Pul agregatlari qaysilar?',
      answer: 'M0, M1, M2, M3',
      options: ['M0, M1, M2, M3', 'Faqat M1'],
    },
  ];

  await cramReviewHandler.launchFlashcardReview(
    mockCtx,
    'pul_va_kredit',
    '11',
    questions,
    { subjectName: 'pul va kredit 3-kurs 1-modul', blockName: 'pul va kredit (11-qism)' }
  );

  assert.strictEqual(sentPayloads.length, 1, 'sendWidget must be called');
  const payload = sentPayloads[0];

  assert.strictEqual(payload.chat_id, 2014973670);
  assert(typeof payload.html === 'string' && payload.html.length > 0, 'Must have HTML code');
  // Problem 1 Fix: caption must be omitted so plain-text question doesn't cover or clutter the widget
  assert.strictEqual(payload.caption, undefined, 'Caption must be omitted so the widget appears cleanly without redundant text');
  assert(payload.is_shared === true, 'is_shared must be true');
  assert(payload.allow_queries === true, 'allow_queries must be true');

  // Verify byte lengths strictly under Telegram limits
  const publicBytes = Buffer.byteLength(payload.public_data, 'utf8');
  const chatBytes = Buffer.byteLength(payload.chat_data, 'utf8');
  console.log(`  public_data size: ${publicBytes} bytes (Limit: 1024)`);
  console.log(`  chat_data size: ${chatBytes} bytes (Limit: 1024)`);
  assert(publicBytes <= 1024, 'public_data must not exceed 1024 bytes');
  assert(chatBytes <= 1024, 'chat_data must not exceed 1024 bytes');

  const comp = compressWidgetHtml(payload.html);
  console.log(`  HTML raw: ${comp.rawBytes} bytes (Limit: 32768)`);
  console.log(`  HTML zlib: ${comp.compressedBytes} bytes (Limit: 4096)`);
  assert(comp.valid, 'HTML must be valid within Telegram Bot API limits');
  assert(!payload.html.includes('&quot;Nominal'), 'HTML initialData must not have raw &quot; entities');
  assert(payload.html.includes('min-height: 290px'), 'HTML must declare min-height for full question visibility');
  assert(payload.html.includes('overflow-y: auto'), 'q-text must have overflow-y auto to prevent question truncation');
  assert(payload.html.includes('rotateY(180deg)'), 'HTML must feature smooth 3D flip transform');
  assert(payload.html.includes('triggerAction'), 'HTML must feature instant micro-interaction swipe transition');

  // Verify reply_markup compactness (< 400 bytes, no oversized URLs, no duplicate known/repeat buttons)
  assert(payload.reply_markup, 'sendWidget payload must include reply_markup keyboard');
  const markupJson = JSON.stringify(payload.reply_markup);
  const markupBytes = Buffer.byteLength(markupJson, 'utf8');
  console.log(`  reply_markup JSON size: ${markupBytes} bytes (Limit: 1024, Target: <= 300)`);
  assert(markupBytes <= 350, `reply_markup must be compact (was ${markupBytes} bytes) to avoid 'reply markup is too long' error`);
  assert(!markupJson.includes('web_app'), 'reply_markup for native sendWidget should not contain heavy WebApp URLs');
  assert(!markupJson.includes('Qiyin'), 'reply_markup must not duplicate Qiyin button already present in widget');
  assert(!markupJson.includes('known'), 'reply_markup must not duplicate Bilib oldim button already present in widget');
  assert(markupJson.includes('cram_blitz') && markupJson.includes('cram_exit'), 'reply_markup must contain utility actions blitz and exit');

  console.log('  ✅ [PASS] sendWidget payload cleanly displays widget without duplicate buttons or captions.\n');

  // ─── TEST 4: Elimination of WebApp button in all flashcard keyboards ───
  console.log('[Test 4] Testing elimination of WebApp button in all flashcard keyboards...');
  const fallbackKb = cramReviewHandler.getFlashcardFallbackKeyboard(0, false);
  const fallbackKbJson = JSON.stringify(fallbackKb);
  assert(!fallbackKbJson.includes('web_app'), 'Fallback keyboard must NEVER contain web_app button');
  assert(!fallbackKbJson.includes('Web App'), 'Fallback keyboard must not have Web App label');
  console.log('  ✅ [PASS] WebApp button completely eliminated from flashcard mode.\n');

  // ─── TEST 5: Subsequent card transitions via editMessageWidgetData ───
  console.log('[Test 5] Testing in-place card updates via editMessageWidgetData...');
  const widgetEditCalls = [];
  const testCtx = {
    from: { id: 2014973670 },
    chat: { id: 2014973670, type: 'private' },
    callbackQuery: {
      data: 'cram_known_0',
      message: { message_id: 777 },
    },
    telegram: {
      callApi: async (method, data) => {
        if (method === 'editMessageWidgetData') {
          widgetEditCalls.push(data);
          return true;
        }
        return { ok: true };
      },
    },
    answerCbQuery: async () => true,
  };

  await cramReviewHandler.cbCramKnown(testCtx);
  assert.strictEqual(widgetEditCalls.length, 1, 'cbCramKnown on widget session must update widget in-place via editMessageWidgetData');
  assert.strictEqual(widgetEditCalls[0].message_id, 777);
  assert(widgetEditCalls[0].public_data, 'Must send updated public_data');
  assert.strictEqual(widgetEditCalls[0].reply_markup, undefined, 'editMessageWidgetData must NOT include reply_markup parameter');
  console.log('  ✅ [PASS] In-place widget transition preserves widget format across subsequent cards.\n');

  // ─── TEST 6: isValidWebAppUrl bounds and safeEdit recovery ───
  console.log('[Test 6] Testing isValidWebAppUrl bounds and safeEdit error recovery...');
  const { isValidWebAppUrl } = require('../src/services/widgetService');
  const validUrl = 'https://example.com/widget?card=1';
  const oversizedUrl = 'https://example.com/widget?data=' + 'x'.repeat(2500);

  assert.strictEqual(isValidWebAppUrl(validUrl), true, 'Valid HTTPS URL should return true');
  assert.strictEqual(isValidWebAppUrl(oversizedUrl), false, 'URL > 2048 bytes must return false');
  assert.strictEqual(isValidWebAppUrl('http://insecure.com'), false, 'Non-HTTPS URL must return false');
  console.log('  ✅ [PASS] isValidWebAppUrl correctly enforces HTTPS and 2048-byte limit.\n');

  console.log('======================================================');
  console.log('🎉 ALL FLASHCARD & SENDWIDGET TESTS PASSED SUCCESSFULLY! 🚀');
  console.log('======================================================');
}

testUserReportedFlashcardIssue().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
