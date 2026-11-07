'use strict';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:dummy_test_token';
const assert = require('assert');

console.log('🧪 Starting Error Reporter System Tests...\n');

// --- TASK 1: Configuration & Environment Setup ---
console.log('--- Task 1: Testing SECOND_BOT configuration export ---');
const config = require('../src/config/config');

assert(
  Object.prototype.hasOwnProperty.call(config, 'SECOND_BOT'),
  'FAIL: config must export SECOND_BOT property'
);
console.log('  ✅ Passed: SECOND_BOT is exported from src/config/config.js');


// --- TASK 2: Core Error Reporter Service ---
console.log('\n--- Task 2: Testing errorReporterService ---');
const errorReporter = require('../src/services/errorReporterService');

assert(typeof errorReporter.report === 'function', 'FAIL: errorReporter must have report()');
assert(typeof errorReporter.formatErrorMessage === 'function', 'FAIL: errorReporter must have formatErrorMessage()');
assert(typeof errorReporter.isBenignError === 'function', 'FAIL: errorReporter must have isBenignError()');
assert(typeof errorReporter.clearDedupCache === 'function', 'FAIL: errorReporter must have clearDedupCache()');

// 2.1 Test Benign Error Filtering
console.log('2.1 Testing benign error filtering:');
assert(errorReporter.isBenignError('bot was blocked by the user') === true, 'bot was blocked should be benign');
assert(errorReporter.isBenignError('query is too old') === true, 'query is too old should be benign');
assert(errorReporter.isBenignError('message is not modified') === true, 'message is not modified should be benign');
assert(errorReporter.isBenignError('TypeError: Cannot read properties of undefined') === false, 'TypeError is NOT benign');
assert(errorReporter.isBenignError('PostgreSQL connection timeout') === false, 'DB error is NOT benign');
console.log('  ✅ Passed: Benign errors correctly filtered');

// 2.2 Test HTML Escaping and Truncation in formatErrorMessage
console.log('2.2 Testing HTML escaping & length clamp:');
const rawHtmlError = new Error('Syntax error <script>alert("hack")</script> & query failed');
const formatted = errorReporter.formatErrorMessage(rawHtmlError, { contextTag: '<test>' });

assert(!formatted.includes('<script>'), 'Unescaped script tags must not exist');
assert(formatted.includes('&lt;script&gt;'), 'Script tag must be HTML-escaped');
assert(formatted.includes('&amp;'), 'Ampersand must be HTML-escaped');
assert(formatted.includes('&lt;test&gt;'), 'Context tags must be HTML-escaped');

// Test 10,000 character giant stack trace truncation
const hugeStack = 'A'.repeat(10000);
const hugeError = new Error('Huge Error');
hugeError.stack = hugeStack;
const formattedHuge = errorReporter.formatErrorMessage(hugeError);
assert(formattedHuge.length <= 4096, `Formatted message length ${formattedHuge.length} must be <= 4096 chars`);
assert(formattedHuge.includes('... (qisqartirildi)'), 'Truncation notice must be present in truncated message');
console.log('  ✅ Passed: HTML escaping and 4096-char ceiling safe clamp verified');

// 2.3 Test Deduplication Logic
console.log('2.3 Testing anti-flood deduplication logic:');
errorReporter.clearDedupCache();

// Mock dispatch to verify report() calls without hitting external Telegram API
let dispatchedMessages = [];
errorReporter._setMockDispatcher((text) => {
  dispatchedMessages.push(text);
  return Promise.resolve(true);
});

async function runAsyncTests() {
  const err1 = new Error('Database connection pool exhausted');
  const res1 = await errorReporter.report(err1, { source: 'unit-test' });
  assert(res1 === true, 'First error report must dispatch');
  assert(dispatchedMessages.length === 1, 'Exactly 1 message should be dispatched for initial error');

  // Immediately report identical error
  const err2 = new Error('Database connection pool exhausted');
  const res2 = await errorReporter.report(err2, { source: 'unit-test' });
  assert(res2 === false, 'Duplicate error within window must be suppressed/deduplicated');
  assert(dispatchedMessages.length === 1, 'No additional message should be dispatched for duplicate');

  // Different error should dispatch immediately
  const errDiff = new Error('Redis connection refused');
  const resDiff = await errorReporter.report(errDiff, { source: 'unit-test' });
  assert(resDiff === true, 'Different error must dispatch');
  assert(dispatchedMessages.length === 2, 'Total 2 messages dispatched');

  // Benign error should not dispatch
  const benignErr = new Error('bot was blocked by the user');
  const resBenign = await errorReporter.report(benignErr);
  assert(resBenign === false, 'Benign error should be ignored');
  assert(dispatchedMessages.length === 2, 'Dispatched count must remain 2');

  // Clean mock
  errorReporter._setMockDispatcher(null);
  console.log('  ✅ Passed: Deduplication and suppression logic verified');

  // --- TASK 3: Winston Logger Integration ---
  console.log('\n--- Task 3: Testing Winston Logger Transport Integration ---');
  const logger = require('../src/core/logger');

  let winstonDispatches = [];
  errorReporter._setMockDispatcher((text) => {
    winstonDispatches.push(text);
    return Promise.resolve(true);
  });

  errorReporter.clearDedupCache();
  logger.error('Test Winston Error message', { serviceTag: 'test-winston-tag' });

  // Give Winston event loop tick to invoke transport
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert(winstonDispatches.length === 1, `Winston error must trigger exactly 1 error report dispatch, got: ${winstonDispatches.length}`);
  assert(winstonDispatches[0].includes('Test Winston Error message'), 'Dispatched message must include winston message');
  assert(winstonDispatches[0].includes('test-winston-tag'), 'Dispatched message must include winston metadata');
  console.log('  ✅ Passed: logger.error automatically routes to errorReporterService');

  errorReporter._setMockDispatcher(null);

  // --- TASK 4: Global Handlers & Console.error Hook ---
  console.log('\n--- Task 4: Testing Global Handlers & Console.error ---');
  let consoleDispatches = [];
  errorReporter._setMockDispatcher((text) => {
    consoleDispatches.push(text);
    return Promise.resolve(true);
  });

  errorReporter.clearDedupCache();

  // Test console.error interception helper
  const { initGlobalErrorHooks } = require('../src/services/errorReporterService');
  assert(typeof initGlobalErrorHooks === 'function', 'FAIL: errorReporterService must export initGlobalErrorHooks()');
  initGlobalErrorHooks();

  console.error('Test direct console.error triggered', { customCode: 999 });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert(consoleDispatches.length === 1, `console.error must trigger 1 error report dispatch, got: ${consoleDispatches.length}`);
  assert(consoleDispatches[0].includes('Test direct console.error triggered'), 'Message must be present in dispatch');
  console.log('  ✅ Passed: console.error interception correctly captured');

  errorReporter._setMockDispatcher(null);

  console.log('\n🎉 ALL TASK 1, TASK 2, TASK 3 & TASK 4 TESTS PASSED!');
}

runAsyncTests().catch((err) => {
  console.error('❌ Async test failed:', err);
  process.exit(1);
});
