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

// --- Task 2: Testing donateHandler ---
console.log('\n--- Task 2: Testing donateHandler logic and formatting ---');
const donateHandler = require('../src/handlers/donateHandler');

assert(typeof donateHandler.cbDonateMenu === 'function', 'FAIL: cbDonateMenu must be a function');
assert(typeof donateHandler.cbDonateSent === 'function', 'FAIL: cbDonateSent must be a function');
assert(typeof donateHandler.cbCancelDonate === 'function', 'FAIL: cbCancelDonate must be a function');
assert(typeof donateHandler.onDonateScreenshot === 'function', 'FAIL: onDonateScreenshot must be a function');
assert(typeof donateHandler.formatCardDisplay === 'function', 'FAIL: formatCardDisplay must be a function');
assert(typeof donateHandler.register === 'function', 'FAIL: register must be a function');

// Test formatCardDisplay
console.log('2.1 Testing formatCardDisplay:');
const formatted1 = donateHandler.formatCardDisplay('8600123456789012');
assert(formatted1.includes('8600 1234 5678 9012'), '16-digit card must be formatted with 4-digit spacing');
assert(formatted1.includes('<code>8600123456789012</code>'), 'Raw 1-tap copyable code block must be included');
assert(formatted1.includes('Avazov Muhammadamin'), 'Cardholder name must be Avazov Muhammadamin');

const emptyFormatted = donateHandler.formatCardDisplay('');
assert(emptyFormatted.includes('sozlanmagan'), 'Empty card should notify that card is not configured');
console.log('  ✅ Passed: formatCardDisplay behaves correctly for valid and empty cards');

