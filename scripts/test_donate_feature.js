'use strict';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:dummy_test_token';
process.env.ADMIN_ID = process.env.ADMIN_ID || '11223344';
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

// --- Task 3: Keyboards & Index Integration ---
console.log('\n--- Task 3: Testing getMainKeyboard includes donate_menu ---');
const { getMainKeyboard } = require('../src/keyboards/keyboards');
const kb = getMainKeyboard();
const flatButtons = kb.reply_markup.inline_keyboard.flat();
const donateBtn = flatButtons.find((btn) => btn.callback_data === 'donate_menu');

assert(Boolean(donateBtn), 'FAIL: getMainKeyboard must contain a button with callback_data="donate_menu"');
assert(donateBtn.text.includes('Donat'), `FAIL: donate button text should mention Donat, got: "${donateBtn.text}"`);
console.log(`  ✅ Passed: donate_menu found in getMainKeyboard with label "${donateBtn.text}"`);

// --- End-to-End Simulation: onDonateScreenshot ---
console.log('\n--- Task 4: Testing onDonateScreenshot handler simulations ---');

async function testHandlerSimulations() {
  // 4.1 Test text during state
  let replyText = '';
  const textCtx = {
    message: { text: 'Salom, qayerga tashlay?' },
    from: { id: 12345, first_name: 'Ali' },
    chat: { id: 12345, type: 'private' },
    session: { state: 'donate:screenshot' },
    reply: (msg) => { replyText = msg; return Promise.resolve(true); },
  };

  await donateHandler.onDonateScreenshot(textCtx, () => {});
  assert(replyText.includes('Iltimos, to\'lov chekining skrinshotini (rasm) yuboring'), 'Must prompt for image');
  console.log('  ✅ Passed: text message during screenshot wait gives polite guidance');

  // 4.2 Test photo receipt submission
  let adminMessages = [];
  let userConfirmReply = '';
  const photoCtx = {
    message: {
      photo: [{ file_id: 'photo_small' }, { file_id: 'photo_large' }],
      caption: '30,000 so\'m tashladim',
    },
    from: { id: 998877, first_name: 'Vali', username: 'valibek' },
    chat: { id: 998877, type: 'private' },
    session: { state: 'donate:screenshot' },
    telegram: {
      sendMessage: (chatId, text, opts) => {
        adminMessages.push({ chatId, text, opts });
        return Promise.resolve({ message_id: 112233 });
      },
    },
    copyMessage: (chatId) => {
      adminMessages.push({ chatId, copied: true });
      return Promise.resolve({ message_id: 445566 });
    },
    reply: (msg) => { userConfirmReply = msg; return Promise.resolve(true); },
  };

  await donateHandler.onDonateScreenshot(photoCtx, () => {});
  assert(photoCtx.session.state === null || photoCtx.session.state === undefined, 'State must be cleared after receipt');
  assert(userConfirmReply.includes('Katta rahmat! To\'lov chekingiz adminga yetkazildi'), 'User must receive thank-you');
  assert(adminMessages.length >= 2, 'Admin must receive header and copied photo receipt');
  const header = adminMessages.find(m => m.text && m.text.includes('YANGI DONAT'));
  assert(Boolean(header), 'Admin message must contain YANGI DONAT header');
  assert(header.text.includes('Vali'), 'Admin message must include user name');
  assert(header.text.includes('valibek'), 'Admin message must include username');
  assert(header.text.includes('30,000 so\'m tashladim'), 'Admin message must include caption');
  console.log('  ✅ Passed: photo receipt forwarded to admin with full user context and reply button');

  // 4.3 Test menu button cancellation during wait
  let nextCalled = false;
  const menuCtx = {
    message: { text: '🏠 Asosiy Menyu' },
    from: { id: 12345 },
    chat: { id: 12345, type: 'private' },
    session: { state: 'donate:screenshot' },
  };
  await donateHandler.onDonateScreenshot(menuCtx, () => { nextCalled = true; });
  assert(nextCalled === true, 'Menu button must call next()');
  assert(menuCtx.session.state === null, 'Menu button must clear stale state');
  console.log('  ✅ Passed: menu button clears stale state and passes to next middleware');

  console.log('\n🎉 ALL DONATE FEATURE TESTS PASSED (100%)!');
}

testHandlerSimulations().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});



