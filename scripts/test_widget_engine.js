'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456789:TEST_BOT_TOKEN_FOR_WIDGETS';

const assert = require('assert');
const http = require('http');
const express = require('express');

const {
  createWidgetToken,
  verifyWidgetToken,
  escapeHtml,
  renderWidgetHtml,
  buildWidgetMessage,
} = require('../src/services/widgetService');

const widgetRouter = require('../src/widgets/widgetServer');
const featureFlagService = require('../src/services/featureFlagService');

async function runTests() {
  console.log('🧪 Starting Telegram 10.4 Widget Engine & HMAC Infrastructure Tests...\n');
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', featureFlagService.STATES.PUBLIC);

  // ─── TEST 1: Token Generation & Verification ─────────────────────────
  console.log('[Test 1] Token Generation & Verification...');
  const userId = 123456;
  const type = 'podium';
  const payload = { testId: 'fin_acc_101', top3: [{ name: 'Ali', score: 25 }] };

  const token = createWidgetToken(userId, type, payload);
  assert(token && typeof token === 'string', 'Token should be a non-empty string');
  assert(token.includes('.'), 'Token must contain data and HMAC signature separated by dot');

  const verified = verifyWidgetToken(token);
  assert(verified !== null, 'Valid token must be verified successfully');
  assert.strictEqual(verified.userId, userId, 'Verified userId must match');
  assert.strictEqual(verified.type, type, 'Verified type must match');
  assert.deepStrictEqual(verified.payload, payload, 'Verified payload must match');
  assert(verified.exp > Date.now(), 'Token expiration must be in the future');
  console.log('✅ Test 1 Passed: Valid token signed and verified with HMAC-SHA256.');

  // ─── TEST 2: Tamper Resistance ───────────────────────────────────────
  console.log('\n[Test 2] Tamper Resistance & Signature Integrity...');
  const [dataPart, sigPart] = token.split('.');

  // Alter payload data
  const tamperedDataPart = Buffer.from(
    JSON.stringify({ userId: 999999, type: 'podium', payload })
  ).toString('base64url');
  const tamperedDataToken = `${tamperedDataPart}.${sigPart}`;
  assert.strictEqual(verifyWidgetToken(tamperedDataToken), null, 'Tampered data must fail verification');

  // Alter signature
  const corruptedSig = sigPart.slice(0, -2) + (sigPart.endsWith('a') ? 'b' : 'a');
  const tamperedSigToken = `${dataPart}.${corruptedSig}`;
  assert.strictEqual(verifyWidgetToken(tamperedSigToken), null, 'Tampered signature must fail verification');

  // Malformed inputs
  assert.strictEqual(verifyWidgetToken(''), null, 'Empty token must return null');
  assert.strictEqual(verifyWidgetToken('invalid_token_without_dot'), null, 'Token without dot must return null');
  assert.strictEqual(verifyWidgetToken(null), null, 'Null token must return null');
  assert.strictEqual(verifyWidgetToken(undefined), null, 'Undefined token must return null');
  assert.strictEqual(verifyWidgetToken(12345), null, 'Non-string token must return null');
  console.log('✅ Test 2 Passed: Tampered, corrupted, and invalid tokens securely rejected.');

  // ─── TEST 3: Expiration / TTL Handling ───────────────────────────────
  console.log('\n[Test 3] Expiration / TTL Handling...');
  // Create an expired token (ttlMs = -1000)
  const expiredToken = createWidgetToken(userId, type, payload, -1000);
  assert.strictEqual(verifyWidgetToken(expiredToken), null, 'Expired token must return null');

  // Create a token with short positive TTL
  const shortLivingToken = createWidgetToken(userId, type, payload, 5000);
  const verifiedShort = verifyWidgetToken(shortLivingToken);
  assert(verifiedShort !== null, 'Fresh token within TTL must verify');
  console.log('✅ Test 3 Passed: Expiration checks strictly enforced.');

  // ─── TEST 4: XSS Escaping ───────────────────────────────────────────
  console.log('\n[Test 4] HTML Sanitization / XSS Escaping...');
  const malicious = '<script>alert("xss")</script>&"\'';
  const escaped = escapeHtml(malicious);
  assert(!escaped.includes('<script>'), 'Must escape < and >');
  assert(escaped.includes('&lt;script&gt;'), 'Must encode < and > to entities');
  assert(escaped.includes('&quot;'), 'Must escape double quotes');
  assert(escaped.includes('&#39;'), 'Must escape single quotes');
  assert(escaped.includes('&amp;'), 'Must escape ampersands');
  assert.strictEqual(escapeHtml(null), '', 'Null should return empty string');
  assert.strictEqual(escapeHtml(undefined), '', 'Undefined should return empty string');
  console.log('✅ Test 4 Passed: HTML escaping correctly neutralizes dangerous chars.');

  // ─── TEST 5: Template Rendering (Podium, Flashcard, DocxHealer) ──────
  console.log('\n[Test 5] HTML Template Rendering...');
  // 5a: Podium widget
  const podiumHtml = renderWidgetHtml('podium', {
    title: 'Top-3 Natijalar',
    top3: [
      { name: 'Otabek <script>', score: 25, timeFormatted: '01:15' },
      { name: 'Malika', score: 24, timeFormatted: '01:20' },
      { name: 'Javohir', score: 23, timeFormatted: '01:45' },
    ],
    personal: { rank: 4, total: 15, percentile: 'Top 27%' },
  });
  assert(typeof podiumHtml === 'string' && podiumHtml.length > 100, 'Podium HTML must be rendered');
  assert(podiumHtml.includes('<!DOCTYPE html>'), 'Podium HTML must contain valid DOCTYPE');
  assert(!podiumHtml.includes('<script>alert'), 'Must not allow unescaped malicious tags');
  assert(podiumHtml.includes('podium') || podiumHtml.includes('pedestal'), 'Podium HTML must contain podium elements');
  assert(podiumHtml.includes('Telegram.WebApp') || podiumHtml.includes('telegram-web-app'), 'Must support Telegram WebApp bridge');

  // 5b: Flashcard widget
  const flashcardHtml = renderWidgetHtml('flashcard', {
    subject: 'Moliyaviy Hisob',
    deck: {
      total: 5,
      cards: [
        { q: 'Debet nima?', a: 'Aktivlarning ko\'payishi yoki majburiyatlarning kamayishi.' }
      ]
    }
  });
  assert(typeof flashcardHtml === 'string' && flashcardHtml.length > 100, 'Flashcard HTML must be rendered');
  assert(flashcardHtml.includes('preserve-3d') || flashcardHtml.includes('rotateY'), 'Must include 3D CSS transforms');
  assert(flashcardHtml.includes('touchstart') || flashcardHtml.includes('touchmove'), 'Must include touch/swipe listeners');

  // 5c: DocxHealer widget
  const docxHtml = renderWidgetHtml('docxHealer', {
    fileName: 'test_savollar.docx',
    brokenCount: 3,
    questions: [
      { id: 1, raw: '1. Savol? A) 1 B) 2 C) 3 D) 4', error: 'Options smashed' }
    ]
  });
  assert(typeof docxHtml === 'string' && docxHtml.length > 100, 'DocxHealer HTML must be rendered');
  assert(docxHtml.includes('docx') || docxHtml.includes('Healer') || docxHtml.includes('inspector'), 'DocxHealer elements present');

  // 5d: Invalid type handling
  assert.throws(() => {
    renderWidgetHtml('nonExistentWidgetType', {});
  }, /Unknown widget type/, 'Rendering unknown widget type must throw');
  console.log('✅ Test 5 Passed: All 3 widget templates render with responsive 3D/Touch capabilities.');

  // ─── TEST 6: buildWidgetMessage ─────────────────────────────────────
  console.log('\n[Test 6] buildWidgetMessage payload creation...');
  const widgetMsg = buildWidgetMessage(
    'flashcard',
    { subject: 'Ekonometrika', blockId: 12 },
    '⚡ Tezkor ko\'rish (Flashcard) rejimi',
    { inline_keyboard: [[{ text: '👁 Javobni ko\'rish', callback_data: 'cram_reveal_0' }]] },
    { baseUrl: 'https://example.com' }
  );
  assert(widgetMsg.token, 'Must return token');
  assert(widgetMsg.url && widgetMsg.url.startsWith('https://example.com/widget/'), 'Widget URL must be generated');
  assert.strictEqual(widgetMsg.text, '⚡ Tezkor ko\'rish (Flashcard) rejimi', 'Fallback text must match');
  assert(widgetMsg.reply_markup && widgetMsg.reply_markup.inline_keyboard, 'Fallback keyboard must match');
  assert(widgetMsg.widget && widgetMsg.widget.url === widgetMsg.url, 'Telegram 10.4 widget structure must match');
  console.log('✅ Test 6 Passed: buildWidgetMessage prepares complete Telegram 10.4 payload.');

  // ─── TEST 7: Express Widget Router Integration ───────────────────────
  console.log('\n[Test 7] Express Widget Server HTTP Integration...');
  const app = express();
  app.use(express.json());
  app.use('/widget', widgetRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 7a: GET /widget/:token with valid token
    const testToken = createWidgetToken(userId, 'podium', {
      title: 'Top Natijalar',
      top3: [{ name: 'TestUser', score: 20 }]
    });

    const resValid = await fetch(`${baseUrl}/widget/${testToken}`);
    assert.strictEqual(resValid.status, 200, 'GET /widget/:validToken must return 200 OK');
    const htmlBody = await resValid.text();
    assert(htmlBody.includes('<!DOCTYPE html>'), 'Body must be HTML');
    assert(htmlBody.includes('TestUser'), 'Body must contain rendered payload data');

    // 7b: GET /widget/:token with invalid token -> 403 Forbidden
    const resInvalid = await fetch(`${baseUrl}/widget/invalid_token_123.456`);
    assert.strictEqual(resInvalid.status, 403, 'GET /widget/:invalidToken must return 403 Forbidden');

    // 7c: POST /widget/query with valid token
    const resPostValid = await fetch(`${baseUrl}/widget/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: testToken,
        action: 'my_analysis',
        data: { userId }
      }),
    });
    assert.strictEqual(resPostValid.status, 200, 'POST /widget/query must return 200 OK');
    const postJson = await resPostValid.json();
    assert.strictEqual(postJson.ok, true, 'Response must have { ok: true }');

    // 7d: POST /widget/query with invalid token -> 401 Unauthorized
    const resPostInvalid = await fetch(`${baseUrl}/widget/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'corrupted_token.abc',
        action: 'test_action'
      }),
    });
    assert.strictEqual(resPostInvalid.status, 401, 'POST /widget/query with invalid token must return 401');

    console.log('✅ Test 7 Passed: Express widget server handles GET views and POST queries securely.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('\n🎉 ALL TELEGRAM 10.4 WIDGET ENGINE TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch((err) => {
  console.error('\n❌ TEST SUITE FAILED:');
  console.error(err);
  process.exit(1);
});
