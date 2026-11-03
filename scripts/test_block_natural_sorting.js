'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');
const { naturalSortBlocks } = require('../src/core/utils');

async function runTests() {
  console.log('--- TEST: BLOCK NATURAL SORTING ---');

  // Test 1: User request specific case - "Pul va kredit (1-qism)", "(2-qism)", "(3-qism)", etc.
  console.log('\n[Test 1] User case: Chunked test names in scrambled order...');
  const userCaseBlocks = [
    { id: 279, block_name: 'Pul va kredit (3-qism)', questions: [1] },
    { id: 281, block_name: 'Pul va kredit (10-qism)', questions: [1] },
    { id: 277, block_name: 'Pul va kredit (1-qism)', questions: [1] },
    { id: 280, block_name: 'Pul va kredit (4-qism)', questions: [1] },
    { id: 278, block_name: 'Pul va kredit (2-qism)', questions: [1] },
  ];

  const sortedUserCase = naturalSortBlocks(userCaseBlocks);
  const expectedNames = [
    'Pul va kredit (1-qism)',
    'Pul va kredit (2-qism)',
    'Pul va kredit (3-qism)',
    'Pul va kredit (4-qism)',
    'Pul va kredit (10-qism)',
  ];
  assert.deepStrictEqual(
    sortedUserCase.map(b => b.block_name),
    expectedNames,
    'Blocks should be sorted in natural numbered order 1, 2, 3, 4, 10'
  );
  console.log('✅ Test 1 PASSED');

  // Test 2: Blocks named like "1-Blok", "2-Blok", "10-Blok"
  console.log('\n[Test 2] Numbered prefix blocks...');
  const numberedPrefixBlocks = [
    { id: 10, block_name: '10-Blok' },
    { id: 1, block_name: '1-Blok' },
    { id: 2, block_name: '2-Blok' },
    { id: 20, block_name: '20-Blok' },
    { id: 3, block_name: '3-Blok' },
  ];
  const sortedPrefix = naturalSortBlocks(numberedPrefixBlocks);
  assert.deepStrictEqual(
    sortedPrefix.map(b => b.block_name),
    ['1-Blok', '2-Blok', '3-Blok', '10-Blok', '20-Blok'],
    'Prefix numbers should be naturally sorted'
  );
  console.log('✅ Test 2 PASSED');

  // Test 3: Fallback to ID when block names are identical
  console.log('\n[Test 3] Same block name falls back to ID ascending...');
  const sameNameBlocks = [
    { id: 50, block_name: 'Umumiy test' },
    { id: 10, block_name: 'Umumiy test' },
    { id: 30, block_name: 'Umumiy test' },
  ];
  const sortedSame = naturalSortBlocks(sameNameBlocks);
  assert.deepStrictEqual(
    sortedSame.map(b => b.id),
    [10, 30, 50],
    'Same name should be sorted by ID ascending'
  );
  console.log('✅ Test 3 PASSED');

  // Test 4: Edge cases: null, undefined, empty array, missing block_name
  console.log('\n[Test 4] Robustness and edge cases...');
  assert.deepStrictEqual(naturalSortBlocks(null), []);
  assert.deepStrictEqual(naturalSortBlocks(undefined), []);
  assert.deepStrictEqual(naturalSortBlocks([]), []);

  const edgeBlocks = [
    { id: 5, block_name: null },
    { id: 2, block_name: 'A-blok' },
    { id: 1, block_name: '' },
    { id: 3, block_name: 'B-blok' },
  ];
  const sortedEdge = naturalSortBlocks(edgeBlocks);
  assert.strictEqual(sortedEdge.length, 4);
  console.log('✅ Test 4 PASSED');

  // Test 5: showUgcSubjectBlocks with loadingMsgId
  console.log('\n[Test 5] showUgcSubjectBlocks in-place message edit...');
  const { showUgcSubjectBlocks } = require('../src/handlers/quizGame');
  const dbService = require('../src/services/dbService');

  const originalGetUserCreatedTests = dbService.getUserCreatedTests;
  dbService.getUserCreatedTests = async () => [
    { id: 2, subject: 'Pul va kredit', block_name: 'Pul va kredit (2-qism)', questions: [1] },
    { id: 1, subject: 'Pul va kredit', block_name: 'Pul va kredit (1-qism)', questions: [1] },
  ];

  let edited = null;
  const mockCtx = {
    chat: { id: 12345 },
    telegram: {
      editMessageText: async (chatId, msgId, inlineId, text, opts) => {
        edited = { chatId, msgId, text, opts };
      }
    }
  };

  await showUgcSubjectBlocks(mockCtx, 'creator1', 'Pul va kredit', 9999);
  assert(edited !== null, 'Should call editMessageText when loadingMsgId provided');
  assert.strictEqual(edited.msgId, 9999);
  assert(edited.text.includes('Pul va kredit'));

  dbService.getUserCreatedTests = originalGetUserCreatedTests;
  console.log('✅ Test 5 PASSED');

  console.log('\n🎉 ALL TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
