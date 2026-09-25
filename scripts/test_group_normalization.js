'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test_token';

const assert = require('assert');
const edupage = require('../src/services/edupageService');

console.log('🧪 Starting Group Normalization & Canonical Resolution Tests...\n');

const testCases = [
  { input: 'BHA-56i/24', expected: 'BHA-56/24i' },
  { input: 'bha-56i/24', expected: 'BHA-56/24i' },
  { input: 'BHA-56/24i', expected: 'BHA-56/24i' },
  { input: 'bha-56/24i', expected: 'BHA-56/24i' },
  { input: 'BHA-56i', expected: 'BHA-56/24i' },
  { input: 'bha-56i', expected: 'BHA-56/24i' },
  { input: 'BHA 56i/24', expected: 'BHA-56/24i' },
  { input: 'BHA_56i_24', expected: 'BHA-56/24i' },
  { input: 'BHA56i24', expected: 'BHA-56/24i' },
  { input: 'bha56i24', expected: 'BHA-56/24i' },
  { input: 'BHA-56/24', expected: 'BHA-56/24' },
  { input: 'BHA-56', expected: 'BHA-56/24' },
  { input: '56i', expected: 'BHA-56/24i' },
  { input: 'AT-11r/24', expected: 'AT-11/24r' },
  { input: 'AT-11/24r', expected: 'AT-11/24r' },
  { input: 'at-11r/24', expected: 'AT-11/24r' },
  { input: 'BBA-38i/25', expected: 'BBA-38i/25' },
  { input: 'BBA-38/25i', expected: 'BBA-38i/25' },
  { input: 'bba-38i/25', expected: 'BBA-38i/25' },
  { input: 'MMT-20/23', expected: 'MMТ-20/23' },
  { input: 'mmt-20/23', expected: 'MMТ-20/23' },
  { input: 'MI-15', expected: 'MI-15' },
  { input: 'mi-15', expected: 'MI-15' },
  { input: 'MNP-80', expected: 'MNP-80' },
  { input: 'mnp-80', expected: 'MNP-80' },
  { input: 'BHA-51k/24', expected: 'BHA-51k/24' },
  { input: 'BHA-51/24k', expected: 'BHA-51k/24' },
];

let passed = 0;
let failed = 0;

for (const { input, expected } of testCases) {
  const actual = edupage.getCanonicalGroupName(input);
  try {
    assert.strictEqual(actual, expected, `Input "${input}" should resolve to "${expected}", got "${actual}"`);
    console.log(`  ✅ Passed: "${input}" => "${actual}"`);
    passed++;
  } catch (err) {
    console.error(`  ❌ Failed: ${err.message}`);
    failed++;
  }
}

// Ensure BHA-56i/24 NEVER resolves to BHA-50k/24
const badResolution = edupage.getCanonicalGroupName('BHA-56i/24');
try {
  assert.notStrictEqual(badResolution, 'BHA-50k/24', 'BHA-56i/24 must NOT resolve to BHA-50k/24');
  console.log('  ✅ Passed: BHA-56i/24 does NOT resolve to BHA-50k/24');
  passed++;
} catch (err) {
  console.error(`  ❌ Failed: ${err.message}`);
  failed++;
}

console.log(`\n📊 Test Results: ${passed} Passed, ${failed} Failed`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('🎉 All group normalization tests passed successfully!');
  process.exit(0);
}
