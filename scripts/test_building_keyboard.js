'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test_token';

const assert = require('assert');
const scheduleHandler = require('../src/handlers/scheduleHandler');

console.log('🧪 Starting Building Keyboard Filter Tests...\n');

let passed = 0;
let failed = 0;

try {
  const periodNum = 1;
  const currentBino = 'my';
  const currentPage = 0;
  const totalPages = 1;

  // Test case 1: Group studies in 4-bino and 5-bino (does NOT study in Asosiy bino)
  const studentBinos = ['4-bino', '5-bino'];
  const kb = scheduleHandler.buildRoomPageKb(periodNum, currentBino, currentPage, totalPages, studentBinos);

  const allButtons = kb.reply_markup.inline_keyboard.flat();
  const buildingFilterButtons = allButtons.filter(b => b.callback_data && b.callback_data.startsWith('rm_1_'));
  const buildingButtonTexts = buildingFilterButtons.map(b => b.text);

  console.log('Generated building filter button labels:', buildingButtonTexts);

  assert(buildingButtonTexts.some(t => t.includes('Mening binolarim')), 'Should contain Mening binolarim button');
  assert(buildingButtonTexts.some(t => t.includes('Barchasi')), 'Should contain Barchasi button');
  assert(buildingButtonTexts.some(t => t.includes('4-bino')), 'Should contain 4-bino button');
  assert(buildingButtonTexts.some(t => t.includes('5-bino')), 'Should contain 5-bino button');

  const hasAsosiyBuilding = buildingFilterButtons.some(b => b.callback_data === 'rm_1_asosiy_0' || b.text.includes('Asosiy bino'));
  assert.strictEqual(hasAsosiyBuilding, false, 'Should NOT force-add Asosiy bino when group has no lessons there');

  console.log('  ✅ Passed: Group with [4-bino, 5-bino] does not get Asosiy bino force-added.');
  passed++;
} catch (err) {
  console.error(`  ❌ Failed: ${err.message}`);
  failed++;
}

try {
  // Test case 2: Group with empty studentBinos gets default buildings fallback
  const kbFallback = scheduleHandler.buildRoomPageKb(1, 'all', 0, 1, []);
  const fallbackBuildingButtons = kbFallback.reply_markup.inline_keyboard.flat().filter(b => b.callback_data && b.callback_data.startsWith('rm_1_'));
  const fallbackTexts = fallbackBuildingButtons.map(b => b.text);

  assert(fallbackTexts.some(t => t.includes('Asosiy')), 'Default fallback should include Asosiy when no group binos found');
  console.log('  ✅ Passed: Fallback without studentBinos displays default campus buttons.');
  passed++;
} catch (err) {
  console.error(`  ❌ Failed: ${err.message}`);
  failed++;
}

console.log(`\n📊 Test Results: ${passed} Passed, ${failed} Failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 All building keyboard tests passed successfully!');
  process.exit(0);
}
