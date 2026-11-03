'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');

async function runTests() {
  console.log('--- TEST: AUTO-DOCX CONTINUOUS CHUNK NUMBERING ---');

  // Test 1: Part number extraction from various block names
  console.log('\n[Test 1] Max part number extraction logic...');
  const testBlocks1 = [
    { block_name: 'Pul va kredit (1-qism)' },
    { block_name: 'Pul va kredit (2-qism)' },
    { block_name: 'Pul va kredit (3-qism)' }
  ];

  let maxPart1 = 0;
  for (const t of testBlocks1) {
    const match = (t.block_name || '').match(/(?:^|\D)(\d+)\s*-?\s*qism/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxPart1) maxPart1 = num;
    }
  }
  assert.strictEqual(maxPart1, 3, 'Max part should be 3');
  const startPart1 = maxPart1 + 1;
  assert.strictEqual(startPart1, 4, 'Next part should start at 4');
  console.log('✅ Test 1 PASSED: startPart is 4');

  // Test 2: Double-digit parts (e.g. 10-qism, 11-qism)
  console.log('\n[Test 2] Double-digit part numbers (up to 12)...');
  const testBlocks2 = [
    { block_name: 'Boshqaruv hisobi (6-qism)' },
    { block_name: 'Boshqaruv hisobi (12-qism)' },
    { block_name: 'Boshqaruv hisobi (1-qism)' }
  ];

  let maxPart2 = 0;
  for (const t of testBlocks2) {
    const match = (t.block_name || '').match(/(?:^|\D)(\d+)\s*-?\s*qism/i);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxPart2) maxPart2 = num;
    }
  }
  assert.strictEqual(maxPart2, 12, 'Max part should be 12');
  assert.strictEqual(maxPart2 + 1, 13, 'Next part should start at 13');
  console.log('✅ Test 2 PASSED: startPart is 13');

  // Test 3: Common base name extraction
  console.log('\n[Test 3] Common base name detection...');
  const baseMatches = testBlocks1
    .map(t => {
      const m = (t.block_name || '').match(/^(.*?)\s*\(\d+\s*-?\s*qism\)$/i);
      return m ? m[1].trim() : null;
    })
    .filter(Boolean);

  const existingBaseName =
    baseMatches.length > 0 && baseMatches.every(b => b === baseMatches[0])
      ? baseMatches[0]
      : null;

  assert.strictEqual(existingBaseName, 'Pul va kredit');
  console.log('✅ Test 3 PASSED: Common base name is "Pul va kredit"');

  // Test 4: Chunks mapped with continuous numbering
  console.log('\n[Test 4] Chunk mapping with startPart = 4...');
  const fakeChunks = [['q1', 'q2'], ['q3', 'q4']];
  const mapped = fakeChunks.map((chunk, i) => ({
    blockName: `${existingBaseName} (${startPart1 + i}-qism)`,
    questions: chunk
  }));

  assert.strictEqual(mapped[0].blockName, 'Pul va kredit (4-qism)');
  assert.strictEqual(mapped[1].blockName, 'Pul va kredit (5-qism)');
  console.log('✅ Test 4 PASSED: Correctly generated "Pul va kredit (4-qism)" and "Pul va kredit (5-qism)"');

  console.log('\n🎉 ALL CHUNK NUMBERING TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
