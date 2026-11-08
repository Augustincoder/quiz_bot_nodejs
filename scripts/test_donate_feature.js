'use strict';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:dummy_test_token';
const assert = require('assert');

console.log('🧪 Starting Donate Feature Tests...\n');

// --- Task 1: Testing Config & State Setup ---
console.log('--- Task 1: Testing CARD_NUMBER config and States.DONATE_SCREENSHOT ---');
const config = require('../src/config/config');
const { States } = require('../src/core/utils');

assert(
  Object.prototype.hasOwnProperty.call(config, 'CARD_NUMBER'),
  'FAIL: config must export CARD_NUMBER property'
);
assert(
  States.DONATE_SCREENSHOT === 'donate:screenshot',
  `FAIL: States.DONATE_SCREENSHOT must be "donate:screenshot", got: ${States.DONATE_SCREENSHOT}`
);
console.log('  ✅ Passed: CARD_NUMBER exported from config and States.DONATE_SCREENSHOT defined');
