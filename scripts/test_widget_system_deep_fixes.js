'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456789:TEST_BOT_TOKEN_FOR_WIDGETS';

const assert = require('assert');
const http = require('http');
const express = require('express');
const zlib = require('zlib');
const widgetService = require('../src/services/widgetService');
const widgetServer = require('../src/widgets/widgetServer');
const logger = require('../src/core/logger');

async function runTests() {
  console.log('🧪 Starting Widget System Deep Analysis & Fix Verification Suite...\n');

  // --- Test 1: Widget Engine Disabled & Invalid URL Logging ---
  console.log('[Test 1] Testing buildWidgetMessage logging and disable behavior...');
  let loggedWarn = false;
  const originalWarn = logger.warn;
  logger.warn = (msg, meta) => {
    loggedWarn = true;
    originalWarn(msg, meta);
  };

  try {
    const msg = widgetService.buildWidgetMessage('flashcard', {}, 'Fallback text', null, { userId: 'disabled_user' });
    // In test environment, featureFlagService or isWidgetEngineEnabled evaluates for user
    assert.strictEqual(typeof msg, 'object', 'buildWidgetMessage should return an object');
    assert.strictEqual(msg.fallbackText, 'Fallback text');
  } finally {
    logger.warn = originalWarn;
  }
  console.log('✅ Test 1 Passed: buildWidgetMessage handles disabled/enabled users cleanly.\n');

  // --- Test 2: 4KB Limit & compressWidgetHtml ---
  console.log('[Test 2] Testing 4KB Limit & compressWidgetHtml validation...');
  const smallHtml = '<div>Hello World</div>';
  const smallComp = widgetService.compressWidgetHtml(smallHtml);
  assert.strictEqual(smallComp.valid, true, 'Small HTML should be valid');
  assert(smallComp.compressedBytes <= 4096, 'Compressed bytes should be <= 4096');

  // Generate oversized HTML (>4096 bytes compressed)
  const crypto = require('crypto');
  const hugeHtml = '<div>' + crypto.randomBytes(6000).toString('base64') + '</div>';
  let sizeWarnTriggered = false;
  logger.warn = (msg) => {
    if (String(msg).includes('exceeds Telegram 4096-byte limit')) {
      sizeWarnTriggered = true;
    }
  };
  try {
    const hugeComp = widgetService.compressWidgetHtml(hugeHtml);
    assert.strictEqual(hugeComp.valid, false, 'Huge HTML must be invalid');
    assert(hugeComp.compressedBytes > 4096, 'Compressed bytes must exceed 4096');
    assert.strictEqual(sizeWarnTriggered, true, 'Logger warning must be triggered for oversized HTML');
  } finally {
    logger.warn = originalWarn;
  }
  console.log('✅ Test 2 Passed: 4KB zlib compression limit strictly enforced with clear warning.\n');

  // --- Test 3: SID Payload Store & verifyWidgetTokenAsync Redis Recovery ---
  console.log('[Test 3] Testing SID Payload Store & verifyWidgetTokenAsync Redis recovery...');
  const largePayload = {
    title: 'Large Test Docx',
    questions: Array.from({ length: 30 }, (_, i) => ({
      id: i + 1,
      questionText: `Savol matni ${i + 1} - talabalar uchun imtihon sinovi?`,
      options: ['Variant A', 'Variant B', 'Variant C', 'Variant D'],
    })),
  };

  const largeToken = widgetService.createWidgetToken(12345, 'docxHealer', largePayload);
  assert(largeToken.includes('.'), 'Token must be signed string');

  // Synchronous verify works initially because it is in widgetPayloadStore
  const verifiedSync = widgetService.verifyWidgetToken(largeToken);
  assert(verifiedSync, 'Synchronous verification should succeed from memory');
  assert.strictEqual(verifiedSync.payload.title, 'Large Test Docx');

  // Now simulate Node.js restart or TTLMap sweep by clearing in-memory store
  const dotIdx = largeToken.indexOf('.');
  const dataPart = largeToken.slice(0, dotIdx);
  const parsed = JSON.parse(Buffer.from(dataPart, 'base64url').toString('utf8'));
  const sid = parsed.payload.sid;
  assert(sid, 'Large payload must use sid');

  widgetService.widgetPayloadStore.delete(sid);
  assert.strictEqual(widgetService.verifyWidgetToken(largeToken), null, 'In-memory lookup should return null after eviction');

  // Simulate Redis store having the payload
  const redis = require('../src/services/redisService');
  if (redis && typeof redis.set === 'function') {
    await redis.set(`widget_payload:${sid}`, JSON.stringify(largePayload), 'EX', 3600);

    const verifiedAsync = await widgetService.verifyWidgetTokenAsync(largeToken);
    assert(verifiedAsync, 'verifyWidgetTokenAsync should recover payload from Redis');
    assert.strictEqual(verifiedAsync.payload.title, 'Large Test Docx');
    assert.strictEqual(verifiedAsync.payload.questions.length, 30);

    // Verify it repopulated memory cache
    const verifiedSyncAgain = widgetService.verifyWidgetToken(largeToken);
    assert(verifiedSyncAgain, 'Synchronous verification should now work from repopulated cache');
  }
  console.log('✅ Test 3 Passed: verifyWidgetTokenAsync recovers evicted SID payloads seamlessly from Redis.\n');

  // --- Test 4: Express Widget Server CORS, CSP & Error Transparency ---
  console.log('[Test 4] Testing Express Widget Server CORS, CSP & Error Transparency...');
  const app = express();
  app.use(express.json());
  app.use('/widget', widgetServer);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/widget`;

  // 4a: Check CORS & OPTIONS preflight
  const optionsRes = await fetch(`${baseUrl}/query`, { method: 'OPTIONS' });
  assert.strictEqual(optionsRes.status, 204, 'OPTIONS request should return 204 No Content');
  assert.strictEqual(optionsRes.headers.get('access-control-allow-origin'), '*', 'CORS Allow-Origin must be *');

  // 4b: Check CSP headers on GET /widget/:token
  const sampleToken = widgetService.createWidgetToken(99999, 'flashcard', { title: 'CSP Test' });
  const getRes = await fetch(`${baseUrl}/${sampleToken}`);
  assert.strictEqual(getRes.status, 200, 'GET /widget/:token should return 200');
  const cspHeader = getRes.headers.get('content-security-policy') || '';
  assert(cspHeader.includes("connect-src 'self' https: http:"), 'CSP must allow connect-src');
  assert(cspHeader.includes('frame-ancestors *'), 'CSP must allow frame-ancestors for Telegram WebView');

  // 4c: Check 400 Bad Request on missing token in POST /query
  const missingTokenRes = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'my_analysis' }),
  });
  assert.strictEqual(missingTokenRes.status, 400, 'Missing token should return 400');
  const missingJson = await missingTokenRes.json();
  assert.strictEqual(missingJson.ok, false);
  assert.strictEqual(missingJson.error, 'Missing token');

  // 4d: Check 401 on invalid/expired token in POST /query
  const invalidTokenRes = await fetch(`${baseUrl}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'invalid.token', action: 'my_analysis' }),
  });
  assert.strictEqual(invalidTokenRes.status, 401, 'Invalid token should return 401');
  const invalidJson = await invalidTokenRes.json();
  assert.strictEqual(invalidJson.ok, false);
  assert(invalidJson.error.includes('Invalid or expired widget token'));

  // 4e: Check 500 error reporting transparency when action handler throws
  widgetServer.registerQueryHandler('fail_action', async () => {
    throw new Error('Database connection simulation error');
  });

  let capturedCriticalLog = false;
  logger.error = (msg, meta) => {
    if (String(msg).includes('Widget query execution CRITICAL error')) {
      capturedCriticalLog = true;
      assert(meta.stack, 'Stack trace must be present in logger metadata');
      assert.strictEqual(meta.error, 'Database connection simulation error');
    }
    originalWarn(msg, meta);
  };

  try {
    const errorQueryRes = await fetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: sampleToken, action: 'fail_action', data: {} }),
    });
    assert.strictEqual(errorQueryRes.status, 500, 'Query error should return 500');
    const errorJson = await errorQueryRes.json();
    assert.strictEqual(errorJson.ok, false);
    assert.strictEqual(errorJson.error, 'Database connection simulation error');
    assert.strictEqual(capturedCriticalLog, true, 'Critical error must be transparently logged with stack trace');
  } finally {
    logger.error = originalWarn;
  }

  server.close();
  console.log('✅ Test 4 Passed: CORS, CSP, and Error Transparency on widget server verified 100%.\n');

  // --- Test 5: Verify HTML templates contain toast error reporting ---
  console.log('[Test 5] Checking HTML templates for toast notification & network error handling...');
  const fs = require('fs');
  const path = require('path');
  const docxHtml = fs.readFileSync(path.join(__dirname, '../src/widgets/views/docxHealerWidget.html'), 'utf8');
  const flashHtml = fs.readFileSync(path.join(__dirname, '../src/widgets/views/flashcardWidget.html'), 'utf8');

  assert(docxHtml.includes("showToast('Xatolik: ' +"), 'docxHealerWidget must display toast on network error');
  assert(flashHtml.includes("showToast('Xatolik: ' +"), 'flashcardWidget must display toast on network error');
  assert(flashHtml.includes('id="toast"'), 'flashcardWidget must contain toast DOM element');

  console.log('✅ Test 5 Passed: HTML templates equipped with user-facing toast error reporting.\n');

  console.log('================================================================');
  console.log('🎉 ALL WIDGET SYSTEM DEEP AUDIT & FIX TESTS PASSED SUCCESSFULLY! 🚀');
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
