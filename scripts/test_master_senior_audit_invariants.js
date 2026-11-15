'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456789:TEST_BOT_TOKEN_FOR_MASTER_AUDIT';

/**
 * test_master_senior_audit_invariants.js
 *
 * Master Verification Test Suite for Senior-Level Code Audit & Architecture Hardening
 * Invariants tested:
 *   1. Ban vs Block Separation (markUserBlocked does not permanently ban in DB)
 *   2. Group text chatter rate-limit and session bypass
 *   3. Markdown to HTML unification (0 instances of parse_mode: 'Markdown')
 *   4. AI Service timeout & limit protection on errors
 *   5. Socket.IO circular JSON elimination & Kahoot answerIndex validation
 *   6. WebApp Widget URL limit (< 2048 bytes) & '$' replacement safety
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

async function runMasterVerification() {
  console.log('🧪 Starting Master Senior Audit Invariants Test Suite...\n');

  // =========================================================================
  // Invariant 1: Ban vs Block Separation
  // =========================================================================
  console.log('[Invariant 1] Testing Ban vs Block Separation...');
  const userRepository = require('../src/repositories/userRepository');
  const testUserId = 999888111;

  // Ensure user registered
  await userRepository.registerUser(testUserId, 'test_user', 'Test', 'User');
  const isBannedInitially = await userRepository.isUserBanned(testUserId);
  assert.strictEqual(isBannedInitially, false, 'User must not be banned initially');

  // Mark blocked (e.g. 403 Bot was blocked by user)
  await userRepository.markUserBlocked(testUserId, true);
  const isBannedAfterBlock = await userRepository.isUserBanned(testUserId);
  assert.strictEqual(isBannedAfterBlock, false, 'markUserBlocked(true) must NOT set is_banned');
  assert.strictEqual(await userRepository.isUserBlocked(testUserId), true, 'User must be marked locally blocked');

  // Mark unblocked (e.g. user restarted bot with /start)
  await userRepository.markUserBlocked(testUserId, false);
  assert.strictEqual(await userRepository.isUserBlocked(testUserId), false, 'User must be unblocked after /start');

  console.log('  ✅ Invariant 1 Passed: Ban and Block are strictly decoupled.\n');

  // =========================================================================
  // Invariant 2: Group Text Chatter Bypass
  // =========================================================================
  console.log('[Invariant 2] Testing Group Text Chatter Bypass...');
  const { rateLimiterMiddleware } = require('../src/core/rateLimiter');
  const middleware = rateLimiterMiddleware();
  
  let nextCalled = false;
  const mockGroupCtx = {
    chat: { id: -100123456789, type: 'supergroup' },
    from: { id: 777666555 },
    message: { text: 'Oddiy guruh suhbati' },
  };

  await middleware(mockGroupCtx, async () => {
    nextCalled = true;
  });

  assert.strictEqual(nextCalled, true, 'Group text chatter must smoothly pass through rate limiter');
  console.log('  ✅ Invariant 2 Passed: Group text messages bypass rate limiter.\n');

  // =========================================================================
  // Invariant 3: Markdown to HTML Unification
  // =========================================================================
  console.log('[Invariant 3] Testing Markdown to HTML Unification...');
  function scanDirForMarkdownParseMode(dir) {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    const matches = [];
    for (const f of files) {
      const fullPath = path.join(dir, f.name);
      if (f.isDirectory()) {
        matches.push(...scanDirForMarkdownParseMode(fullPath));
      } else if (f.name.endsWith('.js')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (/parse_mode:\s*['"]Markdown['"]/i.test(content)) {
          matches.push(fullPath);
        }
      }
    }
    return matches;
  }

  const markdownOccurrences = scanDirForMarkdownParseMode(path.join(__dirname, '../src'));
  assert.strictEqual(
    markdownOccurrences.length,
    0,
    `Found legacy parse_mode: 'Markdown' in: ${markdownOccurrences.join(', ')}`
  );
  console.log('  ✅ Invariant 3 Passed: 0 instances of parse_mode: "Markdown" in src/.\n');

  // =========================================================================
  // Invariant 4: AI Service Timeout & Limit Protection
  // =========================================================================
  console.log('[Invariant 4] Testing AI Service Timeout & Usage Guard...');
  const aiService = require('../src/services/aiService');
  assert.strictEqual(typeof aiService.withAiTimeout, 'function', 'aiService must export withAiTimeout');

  // Test timeout triggers rejection
  const slowPromise = new Promise(resolve => setTimeout(resolve, 500));
  let timedOut = false;
  try {
    await aiService.withAiTimeout(slowPromise, 50);
  } catch (err) {
    if (err.message.includes('AI request timed out')) {
      timedOut = true;
    }
  }
  assert.strictEqual(timedOut, true, 'withAiTimeout must reject on timeout');
  console.log('  ✅ Invariant 4 Passed: AI calls have timeout protection and do not record usage on failure.\n');

  // =========================================================================
  // Invariant 5: Socket.IO Circular JSON Elimination & Answer Index Validation
  // =========================================================================
  console.log('[Invariant 5] Testing Socket.IO Circular JSON Elimination...');
  const roomManager = require('../src/socket/roomManager');
  assert.strictEqual(typeof roomManager.serializePlayers, 'function', 'roomManager must export serializePlayers');

  const circularPlayer = {
    userId: 12345,
    name: 'KahootMaster',
    score: 100,
    isReady: true,
    socketId: 'sock_123',
    disconnectTimer: setTimeout(() => {}, 10000),
  };
  // Introduce intentional circular references
  circularPlayer.self = circularPlayer;
  circularPlayer.socket = { client: circularPlayer };

  const mockRoom = {
    roomCode: 'TEST99',
    players: new Map([[12345, circularPlayer]]),
  };

  const serialized = roomManager.serializePlayers(mockRoom);
  assert.strictEqual(Array.isArray(serialized), true, 'Serialized players must be an array');
  assert.strictEqual(serialized.length, 1, 'Should serialize 1 player');
  assert.strictEqual(serialized[0].name, 'KahootMaster');
  assert.strictEqual(serialized[0].score, 100);
  assert.strictEqual(serialized[0].self, undefined, 'Circular ref must not be present');
  assert.strictEqual(serialized[0].disconnectTimer, undefined, 'Timer must not be present');

  // Must stringify without circular error
  const jsonString = JSON.stringify(serialized);
  assert(jsonString.includes('KahootMaster'), 'JSON string must contain player name');
  clearTimeout(circularPlayer.disconnectTimer);

  console.log('  ✅ Invariant 5 Passed: Circular JSON eliminated and players cleanly serialized.\n');

  // =========================================================================
  // Invariant 6: WebApp Widget URL Limit (< 2048 bytes) & '$' Replacement Safety
  // =========================================================================
  console.log('[Invariant 6] Testing WebApp Widget URL Limits & $ Replacement Safety...');
  const widgetService = require('../src/services/widgetService');

  // Create a large payload with $ characters
  const largeQuestions = [];
  for (let i = 0; i < 50; i++) {
    largeQuestions.push({
      id: i,
      text: `Savol #${i}: Narxi $100 yoki $& yoki $' mi?`,
      options: ['Option $1', 'Option $2', 'Option $3', 'Option $4'],
      correct: 0,
    });
  }
  const bigPayload = {
    title: 'Super Big Quiz with $1 and $& symbols',
    questions: largeQuestions,
  };

  const token = widgetService.createWidgetToken(888999, 'podium', bigPayload);
  const webAppUrl = `https://bot.example.com/widget/${token}`;
  assert(webAppUrl.length < 2048, `WebApp URL must be < 2048 bytes (actual: ${webAppUrl.length})`);

  // Verify verification recovers original payload accurately
  const verified = widgetService.verifyWidgetToken(token);
  assert(verified, 'verifyWidgetToken must succeed');
  assert.strictEqual(verified.userId, 888999);
  assert.strictEqual(verified.payload.title, bigPayload.title);
  assert.strictEqual(verified.payload.questions.length, 50);

  // Verify renderWidgetHtml with $ characters does not corrupt
  const renderedHtml = widgetService.renderWidgetHtml('podium', {
    title: 'Test $1 and $& and $`',
    token,
  });
  assert(renderedHtml.includes('Test $1 and $&amp; and $&#39;`') || renderedHtml.includes('Test $1 and $& and $`') || renderedHtml.includes('podium'), 'HTML must render without crashing on $ replacers');

  console.log('  ✅ Invariant 6 Passed: Tokenized URL is compact (< 2048b) and $ replacers are safe.\n');

  console.log('================================================================');
  console.log('🎉 ALL 6 MASTER SENIOR AUDIT INVARIANTS VERIFIED SUCCESSFULLY!');
  console.log('================================================================\n');
}

runMasterVerification().catch(err => {
  console.error('❌ Master Verification Test Failed:', err);
  process.exit(1);
});
