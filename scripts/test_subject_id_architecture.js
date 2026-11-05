'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');
const { naturalSortBlocks } = require('../src/core/utils');
const dbService = require('../src/services/dbService');
const { buildFinishButtons } = require('../src/handlers/coreQuiz');

async function runTests() {
  console.log('--- TEST: SUBJECT_ID ARCHITECTURE & NEXT BLOCK NAVIGATION ---');

  // =========================================================================
  // Test 1: naturalSortBlocks correctly sorts multi-part chunks
  // =========================================================================
  console.log('\n[Test 1] Natural sorting of UGC blocks...');
  const unorderedBlocks = [
    { id: 3, block_name: 'Anatomiya (10-qism)' },
    { id: 1, block_name: 'Anatomiya (1-qism)' },
    { id: 2, block_name: 'Anatomiya (2-qism)' },
  ];
  const sorted = naturalSortBlocks(unorderedBlocks);
  assert.strictEqual(sorted[0].id, 1, 'First block should be 1-qism');
  assert.strictEqual(sorted[1].id, 2, 'Second block should be 2-qism');
  assert.strictEqual(sorted[2].id, 3, 'Third block should be 10-qism');
  console.log('✅ Test 1 PASSED: Natural sorting correctly handles multi-digit chunk parts.');

  // =========================================================================
  // Test 2: Next Block Navigation in buildFinishButtons
  // =========================================================================
  console.log('\n[Test 2] Next block navigation button calculation...');

  // Mock getSubjectBlocks in dbService for isolated unit testing
  const originalGetSubjectBlocks = dbService.getSubjectBlocks;
  const mockSubjectBlocks = [
    { id: 101, block_name: '1-Mavzu (1-qism)', questions: [{}, {}] },
    { id: 102, block_name: '1-Mavzu (2-qism)', questions: [{}, {}] },
    { id: 103, block_name: '1-Mavzu (3-qism)', questions: [{}, {}] },
  ];

  dbService.getSubjectBlocks = async (subjectId) => {
    if (subjectId === 77) return mockSubjectBlocks;
    return [];
  };

  try {
    // 2a: User finishes Block 1 (id: 101)
    const session1 = { subjectId: 77, subjectKey: 'Biologiya' };
    const buttons1 = await buildFinishButtons('ugc_101', 'Biologiya', 0, session1);
    const flatButtons1 = buttons1.flat();

    const nextBtn1 = flatButtons1.find((b) => b.text.includes('Keyingi'));
    assert(nextBtn1, 'Block 1 finish must have a "Keyingi" button');
    assert.strictEqual(nextBtn1.callback_data, 'ugc_start_102', 'Next button must target block 102');
    assert(nextBtn1.text.includes('1-Mavzu (2-qism)'), 'Next button must display the next block name');

    const replayBtn1 = flatButtons1.find((b) => b.text.includes('Qayta ishlash'));
    assert(replayBtn1, 'Must have replay button');
    assert.strictEqual(replayBtn1.callback_data, 'ugc_start_101', 'Replay must restart block 101');

    const subjBtn1 = flatButtons1.find((b) => b.text.includes('Fan bloklari'));
    assert(subjBtn1, 'Must have "Fan bloklari" button');
    assert.strictEqual(subjBtn1.callback_data, 'ugc_subj_77', 'Must point to ugc_subj_77');

    console.log('✅ Test 2a PASSED: Block 1 provides Next Block (Block 2) button.');

    // 2b: User finishes Block 2 (id: 102)
    const session2 = { subjectId: 77, subjectKey: 'Biologiya' };
    const buttons2 = await buildFinishButtons('ugc_102', 'Biologiya', 1, session2);
    const flatButtons2 = buttons2.flat();

    const nextBtn2 = flatButtons2.find((b) => b.text.includes('Keyingi'));
    assert(nextBtn2, 'Block 2 finish must have a "Keyingi" button');
    assert.strictEqual(nextBtn2.callback_data, 'ugc_start_103', 'Next button must target block 103');

    const mistakesBtn = flatButtons2.find((b) => b.text.includes('Xatolar ustida ishlash'));
    assert(mistakesBtn, 'Mistakes button must be shown when mistakesCount > 0');

    console.log('✅ Test 2b PASSED: Block 2 provides Next Block (Block 3) and mistake buttons.');

    // 2c: User finishes Block 3 (last block, id: 103)
    const session3 = { subjectId: 77, subjectKey: 'Biologiya' };
    const buttons3 = await buildFinishButtons('ugc_103', 'Biologiya', 0, session3);
    const flatButtons3 = buttons3.flat();

    const nextBtn3 = flatButtons3.find((b) => b.text.includes('Keyingi'));
    assert.strictEqual(nextBtn3, undefined, 'Last block must NOT have a "Keyingi" button');

    const fanBtn3 = flatButtons3.find((b) => b.text.includes('Fan bloklari'));
    assert(fanBtn3, 'Last block must provide "Fan bloklari" button to view all blocks');

    console.log('✅ Test 2c PASSED: Last block properly omits Next button and provides Subject overview.');
  } finally {
    dbService.getSubjectBlocks = originalGetSubjectBlocks;
  }

  // =========================================================================
  // Test 3: Fallback resolution when session.subjectId is missing
  // =========================================================================
  console.log('\n[Test 3] Automatic fallback resolution of subjectId from testDb...');
  const originalGetUserTest = dbService.getUserTest;
  const originalGetSubjectBlocks3 = dbService.getSubjectBlocks;

  dbService.getUserTest = async (tid) => {
    if (tid === 201) return { id: 201, subject: 'Fizika', subject_id: 88, block_name: '1-Blok' };
    return null;
  };

  dbService.getSubjectBlocks = async (sid) => {
    if (sid === 88) {
      return [
        { id: 201, block_name: '1-Blok' },
        { id: 202, block_name: '2-Blok' },
      ];
    }
    return [];
  };

  try {
    // Session without subjectId (e.g. older session or reloaded)
    const sessionWithoutSubjId = { subjectKey: 'Fizika' };
    const buttons = await buildFinishButtons('ugc_201', 'Fizika', 0, sessionWithoutSubjId);
    const flatButtons = buttons.flat();
    const nextBtn = flatButtons.find((b) => b.text.includes('Keyingi'));

    assert(nextBtn, 'Must find next block even if session.subjectId was not set initially');
    assert.strictEqual(nextBtn.callback_data, 'ugc_start_202');
    console.log('✅ Test 3 PASSED: Fallback resolution from database works seamlessly.');
  } finally {
    dbService.getUserTest = originalGetUserTest;
    dbService.getSubjectBlocks = originalGetSubjectBlocks3;
  }

  // =========================================================================
  // Test 4: Migration Logic & Distinct Subject Extraction Simulation
  // =========================================================================
  console.log('\n[Test 4] Simulation of migration algorithm on dirty user tests...');

  const rawUserTests = [
    { id: 1, creator_id: 'user_A', subject: 'Matematika', subject_id: null },
    { id: 2, creator_id: 'user_A', subject: 'matematika ', subject_id: null }, // whitespace + lower
    { id: 3, creator_id: 'user_A', subject: 'Fizika', subject_id: null },
    { id: 4, creator_id: 'user_B', subject: 'Matematika', subject_id: null }, // different user
    { id: 5, creator_id: 'user_B', subject: 'Kimyo', subject_id: 55 }, // already linked
  ];

  // Simulating migration mapping:
  const subjectsTable = [{ id: 55, creator_id: 'user_B', name: 'Kimyo' }];
  let nextSubjectId = 100;

  for (const t of rawUserTests) {
    if (!t.subject_id && t.creator_id && t.subject) {
      const norm = t.subject.trim().toLowerCase();
      let found = subjectsTable.find(
        (s) => s.creator_id === t.creator_id && s.name.trim().toLowerCase() === norm
      );
      if (!found) {
        found = { id: nextSubjectId++, creator_id: t.creator_id, name: t.subject.trim() };
        subjectsTable.push(found);
      }
      t.subject_id = found.id;
    }
  }

  // Verification assertions:
  assert.strictEqual(subjectsTable.length, 4, 'Should have 4 unique subjects: Kimyo (B), Matematika (A), Fizika (A), Matematika (B)');
  assert.strictEqual(rawUserTests[0].subject_id, rawUserTests[1].subject_id, 'user_A "Matematika" and "matematika " must share same subject_id');
  assert.notStrictEqual(rawUserTests[0].subject_id, rawUserTests[3].subject_id, 'user_A Matematika and user_B Matematika must have DIFFERENT subject_ids');
  assert.strictEqual(rawUserTests[4].subject_id, 55, 'Existing subject_id 55 must remain untouched');

  console.log('✅ Test 4 PASSED: Migration logic prevents duplicates, isolates creators, and preserves existing links.');

  console.log('\n🎉 ALL SUBJECT_ID ARCHITECTURE TESTS PASSED!');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
