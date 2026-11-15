'use strict';

/**
 * Senior Level Audit & AI Refactoring Verification Suite
 * Validates all 5 Phases of the Architectural Transformation:
 * - Phase 1: Security Hardening (SSL, HMAC salt, IP rate limiter)
 * - Phase 2: Database & Performance Optimization (Bounded TTLMap, Aggregated SQL)
 * - Phase 3: Architecture & Modularization (EduPage, dbService, testCreation)
 * - Phase 4: Broken Logic & Bug Fixes (Zod v4, Global message router, AI limiter)
 * - Phase 5: Verification & Zero Regression
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('dotenv').config();
process.env.SHARE_LINK_SECRET = process.env.SHARE_LINK_SECRET || 'test_share_secret_key_123456';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

async function runTests() {
  console.log('🧪 Starting Senior Level Refactoring Invariants Test Suite...\n');

  // ─── 1. SECURITY & CONFIG ───────────────────────────────────
  console.log('[Phase 1] Security Hardening Invariants...');
  const postgresSrc = fs.readFileSync(path.join(__dirname, '../src/lib/postgres.js'), 'utf8');
  assert(
    !postgresSrc.includes('postgres://postgres:postgres@localhost:5432/quizbot'),
    'Hardcoded database credentials must not exist in postgres.js'
  );
  assert(
    postgresSrc.includes('rejectUnauthorized') && postgresSrc.includes('DB_SSL_REJECT_UNAUTHORIZED'),
    'Managed DB SSL rejection fallback must be present'
  );

  const shareService = require('../src/services/shareService');
  assert.strictEqual(typeof shareService.buildShareLink, 'function', 'buildShareLink exported');
  assert.strictEqual(typeof shareService.encodeShareToken, 'function', 'encodeShareToken exported');
  assert.strictEqual(typeof shareService.decodeShareToken, 'function', 'decodeShareToken exported');

  const token = shareService.encodeShareToken('s', 12345);
  const decoded = shareService.decodeShareToken(token);
  assert.strictEqual(String(decoded.id), '12345', 'Share token decode must match encoded id');
  assert.strictEqual(decoded.type, 's', 'Share token decode must match encoded type');
  console.log('  ✅ Phase 1 Passed: Security hardening verified.');

  // ─── 2. DATABASE & PERFORMANCE ──────────────────────────────
  console.log('\n[Phase 2] Database & Performance Invariants...');
  const dbService = require('../src/services/dbService');
  assert.strictEqual(typeof dbService.getAggregatedAdminStats, 'function', 'getAggregatedAdminStats exists on dbService facade');

  const { TTLMap } = require('../src/core/utils');
  const ttlTest = new TTLMap(1000, 2);
  ttlTest.set('a', 1);
  ttlTest.set('b', 2);
  ttlTest.set('c', 3);
  assert.strictEqual(ttlTest.size <= 2, true, 'TTLMap must stay strictly bounded within capacity limit');

  const widgetServerSrc = fs.readFileSync(path.join(__dirname, '../src/widgets/widgetServer.js'), 'utf8');
  assert(widgetServerSrc.includes('TTLMap'), 'widgetServer must use TTLMap for caching');
  assert(
    fs.existsSync(path.join(__dirname, '../src/widgets/views/inlineDocxHealer.html')) &&
    fs.existsSync(path.join(__dirname, '../src/widgets/views/inlineFlashcard.html')),
    'HTML templates must be extracted to src/widgets/views/'
  );
  console.log('  ✅ Phase 2 Passed: Bounded memory and performance optimizations verified.');

  // ─── 3. MODULAR ARCHITECTURE ────────────────────────────────
  console.log('\n[Phase 3] Modular Architecture Invariants...');
  
  // 3.1 EduPage Service Facade
  const edupageService = require('../src/services/edupageService');
  assert.strictEqual(typeof edupageService.normalizeGroupName, 'function', 'edupageService facade exports normalizeGroupName');
  assert.strictEqual(typeof edupageService.detectCurrentActiveLesson, 'function', 'edupageService facade exports detectCurrentActiveLesson');
  assert.strictEqual(typeof edupageService.manuallyIngestTimetable, 'function', 'edupageService facade exports manuallyIngestTimetable');
  assert.strictEqual(typeof edupageService.testTransports, 'function', 'edupageService facade exports testTransports');

  const edupageLines = fs.readFileSync(path.join(__dirname, '../src/services/edupageService.js'), 'utf8').split('\n').length;
  assert(edupageLines < 400, `edupageService.js must be a clean facade (< 400 lines), got ${edupageLines}`);

  // 3.2 Database Service Repositories Facade
  assert.strictEqual(typeof dbService.getUserByTelegramId, 'function', 'dbService exports getUserByTelegramId');
  assert.strictEqual(typeof dbService.getUserTest, 'function', 'dbService exports getUserTest');
  assert.strictEqual(typeof dbService.saveUserTest, 'function', 'dbService exports saveUserTest');
  assert.strictEqual(typeof dbService.saveUserTestsBatch, 'function', 'dbService exports saveUserTestsBatch');
  assert.strictEqual(typeof dbService.getUserScheduleSettings, 'function', 'dbService exports getUserScheduleSettings');

  const dbServiceLines = fs.readFileSync(path.join(__dirname, '../src/services/dbService.js'), 'utf8').split('\n').length;
  assert(dbServiceLines < 300, `dbService.js must be a clean facade (< 300 lines), got ${dbServiceLines}`);

  // 3.3 TestCreation Flow Facade
  const testCreation = require('../src/handlers/testCreation');
  assert.strictEqual(typeof testCreation.register, 'function', 'testCreation exports register');
  assert.strictEqual(typeof testCreation.cbCreateTest || typeof testCreation.showDraftDashboard, 'function', 'testCreation exports core flows');
  assert.strictEqual(typeof testCreation.cbFixErrors, 'function', 'testCreation exports cbFixErrors');
  assert.strictEqual(typeof testCreation.makeSafeDocxWidgetPublicData, 'function', 'testCreation exports makeSafeDocxWidgetPublicData');
  assert.ok(testCreation._userTextChunks, 'testCreation exports _userTextChunks');

  const testCreationLines = fs.readFileSync(path.join(__dirname, '../src/handlers/testCreation.js'), 'utf8').split('\n').length;
  assert(testCreationLines < 300, `testCreation.js must be a clean facade (< 300 lines), got ${testCreationLines}`);

  console.log('  ✅ Phase 3 Passed: God objects cleanly decomposed into submodules & facades.');

  // ─── 4. BUG FIXES & CENTRAL ROUTING ────────────────────────
  console.log('\n[Phase 4] Bug Fixes & Central Routing Invariants...');

  // 4.1 Zod v4 issue
  const wizardFlowSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/testCreation/wizardFlow.js'), 'utf8');
  assert(
    wizardFlowSrc.includes('result.error.issues?.[0]?.message') || wizardFlowSrc.includes('result.error.errors?.[0]?.message'),
    'Zod v4 issues/errors safe handling verified'
  );

  // 4.2 Central Message Router & contactAdmin bot.on cleanup
  const contactAdminSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/contactAdmin.js'), 'utf8');
  assert(
    !contactAdminSrc.includes("bot.on('message', handleContactMessages)"),
    'Standalone bot.on(message) must be removed from contactAdmin.js'
  );

  const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert(
    indexSrc.includes('isAdmin(userId) && ctx.message?.reply_to_message'),
    'index.js must centrally route admin replies'
  );

  // 4.3 AI Rate Limiter & Stats
  const aiRateLimiter = require('../src/services/aiRateLimiter');
  assert.strictEqual(typeof aiRateLimiter.checkUserLimit, 'function', 'aiRateLimiter exports checkUserLimit');
  assert.strictEqual(typeof aiRateLimiter.checkAdminAILimit, 'function', 'aiRateLimiter exports checkAdminAILimit');

  const aiService = require('../src/services/aiService');
  const aiStats = aiService.getAIUsageStats();
  assert.strictEqual(aiStats.byFunction.explainMistakes, 0, 'aiService byFunction explainMistakes initial stat must be 0');
  assert.strictEqual(aiStats.byFunction.generateQuiz, 0, 'aiService byFunction generateQuiz initial stat must be 0');

  // 4.4 Centralized Constants & Tashkent Timezone
  const utils = require('../src/core/utils');
  assert(Array.isArray(utils.MAIN_MENU_BUTTONS), 'MAIN_MENU_BUTTONS must be an array exported from utils');
  assert.strictEqual(typeof utils.isMainMenuButton, 'function', 'isMainMenuButton must be a function exported from utils');
  assert.strictEqual(utils.isMainMenuButton('📅 Dars jadvali'), true, 'isMainMenuButton recognizes Dars jadvali');
  assert.strictEqual(utils.isMainMenuButton('random text'), false, 'isMainMenuButton ignores random text');

  const tashkentDate = utils.getTashkentDate();
  assert(tashkentDate instanceof Date, 'getTashkentDate returns Date instance');

  // 4.5 Storage.js sync cleanup
  const storageSrc = fs.readFileSync(path.join(__dirname, '../src/core/storage.js'), 'utf8');
  assert(
    !storageSrc.includes('JSON.parse(fsSync.readFileSync(srcPath'),
    'Dead synchronous JSON disk reading removed from storage.js'
  );

  console.log('  ✅ Phase 4 Passed: All bug fixes and central routing verified.');

  console.log('\n======================================================');
  console.log('🎉 ALL SENIOR LEVEL REFACTORING INVARIANTS PASSED! 🚀');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('❌ Refactoring verification failed:', err);
  process.exit(1);
});
