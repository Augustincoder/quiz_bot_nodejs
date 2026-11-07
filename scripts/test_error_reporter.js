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
