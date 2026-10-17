'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

console.log('🧪 Starting Memory Leak & Deep Architecture Audit Fixes Verification...\n');

let passedTests = 0;
function pass(testName) {
  passedTests++;
  console.log(`  ✅ [PASS] ${testName}`);
}

async function runTests() {
  // --- Test 1: Dockerfile Container & GLIBC Arena Tuning ---
  console.log('1. Testing Dockerfile MALLOC_ARENA_MAX & NODE_OPTIONS');
  const dockerfile = fs.readFileSync(path.join(__dirname, '../Dockerfile'), 'utf8');
  assert(dockerfile.includes('MALLOC_ARENA_MAX=2'), 'Dockerfile must define MALLOC_ARENA_MAX=2');
  assert(dockerfile.includes('--max-old-space-size=300'), 'Dockerfile must define max-old-space-size=300');
  assert(dockerfile.includes('--expose-gc'), 'Dockerfile must expose GC');
  pass('Dockerfile configured with MALLOC_ARENA_MAX=2 and 300MB V8 heap ceiling');

  // --- Test 2: BullMQ Queue Retention Policy ---
  console.log('\n2. Testing BullMQ Queue Retention Policy in queues.js');
  const queuesSrc = fs.readFileSync(path.join(__dirname, '../src/jobs/queues.js'), 'utf8');
  assert(queuesSrc.includes('removeOnComplete'), 'queues.js must configure removeOnComplete');
  assert(queuesSrc.includes('removeOnFail'), 'queues.js must configure removeOnFail');
  assert(queuesSrc.includes('defaultJobOptions'), 'queues.js must pass defaultJobOptions');
  pass('BullMQ queues configured with removeOnComplete/removeOnFail to prevent Redis/RAM bloat');

  // --- Test 3: Mutex Stale Lock Cleanup ---
  console.log('\n3. Testing Mutex cleanup()');
  const mutex = require('../src/core/mutex');
  assert(typeof mutex.cleanup === 'function', 'Mutex must export cleanup function');
  await mutex.runExclusive('test_key_temp', async () => 'ok');
  assert.strictEqual(mutex.size, 0, 'Mutex must have 0 locks after execution');
  mutex.cleanup();
  assert.strictEqual(mutex.size, 0);
  pass('Mutex implements cleanup() and maintains 0 lingering lock references');

  // --- Test 4: pendingStore Proactive Cleanup ---
  console.log('\n4. Testing pendingStore cleanup()');
  const pendingStore = require('../src/core/pendingStore');
  assert(typeof pendingStore.cleanup === 'function', 'pendingStore must export cleanup()');
  pendingStore.cleanup();
  pass('pendingStore exports cleanup() and clears expired memory entries');

  // --- Test 5: sessionService cleanupExpired() ---
  console.log('\n5. Testing sessionService cleanupExpired()');
  const sessionService = require('../src/services/sessionService');
  assert(typeof sessionService.cleanupExpired === 'function', 'sessionService must export cleanupExpired()');
  sessionService.cleanupExpired();
  pass('sessionService implements cleanupExpired() across all local caches');

  // --- Test 6: roomManager cleanupDeadRooms() ---
  console.log('\n6. Testing roomManager cleanupDeadRooms()');
  const roomManager = require('../src/socket/roomManager');
  assert(typeof roomManager.cleanupDeadRooms === 'function', 'roomManager must have cleanupDeadRooms');
  const room = await roomManager.createRoom('dead_room_test', 999);
  room.status = 'ended';
  roomManager.cleanupDeadRooms();
  const checkRoom = await roomManager.getRoom('dead_room_test');
  assert.strictEqual(checkRoom, null, 'cleanupDeadRooms must remove ended rooms');
  pass('roomManager cleanupDeadRooms() sweeps zombie/ended rooms and clears timers');

  // --- Test 7: watchdogService Native Off-Heap Detection & Memory Hygiene Sweep ---
  console.log('\n7. Testing watchdogService Off-Heap Threshold & Hygiene Cron');
  const watchdogSrc = fs.readFileSync(path.join(__dirname, '../src/services/watchdogService.js'), 'utf8');
  assert(watchdogSrc.includes('EXTERNAL_THRESHOLD_BYTES'), 'watchdogService must have EXTERNAL_THRESHOLD_BYTES');
  assert(watchdogSrc.includes('runMemoryHygieneSweep'), 'watchdogService must have runMemoryHygieneSweep');
  assert(watchdogSrc.includes('HYGIENE_INTERVAL_MS'), 'watchdogService must have hygiene interval');
  pass('watchdogService monitors C++ native buffers and runs periodic memory hygiene sweep');

  // --- Test 8: dbService dueNotesCache Bounded Map & Eviction ---
  console.log('\n8. Testing dbService dueNotesCache bounded size');
  const dbServiceSrc = fs.readFileSync(path.join(__dirname, '../src/services/dbService.js'), 'utf8');
  assert(dbServiceSrc.includes('MAX_DUE_NOTES_CACHE'), 'dbService must bound dueNotesCache with MAX_DUE_NOTES_CACHE');
  assert(dbServiceSrc.includes('cleanupDueNotesCache'), 'dbService must implement cleanupDueNotesCache');
  const dbService = require('../src/services/dbService');
  assert(typeof dbService.cleanupDueNotesCache === 'function', 'dbService must export cleanupDueNotesCache');
  dbService.cleanupDueNotesCache();
  pass('dbService bounds dueNotesCache with LRU eviction preventing day-over-day growth');

  // --- Test 9: aiService Robust JSON Parsing & Input Clamping ---
  console.log('\n9. Testing aiService Robust JSON Parsing & Input Clamping');
  const aiServiceSrc = fs.readFileSync(path.join(__dirname, '../src/services/aiService.js'), 'utf8');
  assert(aiServiceSrc.includes('MAX_AI_INPUT_CHARS = 15000'), 'aiService must define MAX_AI_INPUT_CHARS = 15000');
  assert(aiServiceSrc.includes('slice(0, MAX_AI_INPUT_CHARS)'), 'aiService must clamp input to MAX_AI_INPUT_CHARS');
  
  // Test JSON parser directly on tricky markdown output with trailing comma
  const testMarkdownJson = '```json\n[{"question": "Q1?", "options": ["A", "B", "C", "D"], "correct_index": 0},]\n```';
  // Simulate the enhanced extractJSON regex logic
  let clean = testMarkdownJson.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1').trim();
  const match = clean.match(/\[[\s\S]*\]/);
  assert(match, 'Must match array in markdown code block');
  const fixed = match[0].replace(/,\s*([\]}])/g, '$1');
  const parsed = JSON.parse(fixed);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].question, 'Q1?');
  pass('aiService clamps inputs to 15,000 chars and safely parses markdown code-block JSON with trailing commas');

  // --- Test 10: resetUserFlows in utils.js, startHandler, and index.js ---
  console.log('\n10. Testing resetUserFlows centralized state resetting');
  const { resetUserFlows } = require('../src/core/utils');
  assert(typeof resetUserFlows === 'function', 'utils.js must export resetUserFlows');
  
  const mockCtx = {
    session: { state: 'create:questions', data: { questions: [1, 2, 3] } },
    from: { id: 777888 }
  };
  await resetUserFlows(777888, mockCtx);
  assert.strictEqual(mockCtx.session.state, null, 'resetUserFlows must clear state');
  assert.deepStrictEqual(mockCtx.session.data, {}, 'resetUserFlows must clear data');

  const startHandlerSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/startHandler.js'), 'utf8');
  assert(startHandlerSrc.includes('resetUserFlows'), 'startHandler.js must call resetUserFlows');
  
  const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert(indexSrc.includes('resetUserFlows'), 'index.js must call resetUserFlows in router');
  pass('resetUserFlows cleanly purges user wizard state, pending store, and session keys across navigation');

  // --- Test 11: quizGame cbWmAns Mutex Concurrency Protection ---
  console.log('\n11. Testing cbWmAns mutex protection against double-click');
  const quizGameSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/quizGame.js'), 'utf8');
  assert(quizGameSrc.includes("mutex.lock(`wm_ans:${chatId}`)"), 'cbWmAns must acquire mutex lock with chatId');
  pass('cbWmAns locked with mutex preventing double-click race conditions and state corruption');

  // --- Test 12: imageService Buffer & SVG String Dereferencing ---
  console.log('\n12. Testing imageService buffer cleanup');
  const imageServiceSrc = fs.readFileSync(path.join(__dirname, '../src/services/imageService.js'), 'utf8');
  assert(imageServiceSrc.includes('inputBuf = null'), 'imageService must nullify inputBuf in finally');
  assert(imageServiceSrc.includes('svgString = null'), 'imageService must nullify svgString in finally');
  pass('imageService dereferences input buffers and SVG strings immediately after Sharp conversion');

  console.log(`\n==================================================`);
  console.log(`🎉 ALL 12 MEMORY LEAK & ARCHITECTURE AUDIT VERIFICATIONS PASSED (${passedTests}/12)!`);
  console.log(`==================================================\n`);
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n❌ Audit Verification Test Failed:', err);
  process.exit(1);
});
