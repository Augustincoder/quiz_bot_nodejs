'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'dummy_test_token';

const edupageService = require('../src/services/edupageService');

async function runTests() {
  console.log('🧪 Starting EduPage Circuit Breaker & Fallback Resilience Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ Passed: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAILED: ${testName} ${details ? '— ' + details : ''}`);
      failed++;
    }
  }

  // 1. Test offline retrieval from L3 Disk Cache
  try {
    const indexedDb = await edupageService.getIndexedDatabase(false);
    assert(!!indexedDb, 'getIndexedDatabase returns valid indexed database');
    assert(indexedDb.classesById instanceof Map && indexedDb.classesById.size > 0, 'classesById is populated from disk/cache', `Size: ${indexedDb?.classesById?.size}`);
    assert(indexedDb.schedulesByClassId instanceof Map && indexedDb.schedulesByClassId.size > 0, 'schedulesByClassId is populated from disk/cache', `Size: ${indexedDb?.schedulesByClassId?.size}`);
    assert(indexedDb.emptyRoomsMatrix instanceof Map && indexedDb.emptyRoomsMatrix.size === 48, 'emptyRoomsMatrix has all 48 slots indexed', `Size: ${indexedDb?.emptyRoomsMatrix?.size}`);
  } catch (err) {
    assert(false, 'getIndexedDatabase should not throw', err.message);
  }

  // 2. Test class finding and canonical resolution with indexed DB
  try {
    const indexedDb = await edupageService.getIndexedDatabase(false);
    const classId = edupageService.findClassId(indexedDb, 'BHA-56/24i');
    assert(!!classId, 'findClassId finds class ID for BHA-56/24i', `classId: ${classId}`);

    const schedule = indexedDb.schedulesByClassId.get(classId);
    assert(!!schedule, 'Schedule exists for BHA-56/24i');
    assert(schedule[0] && Object.keys(schedule[0]).length > 0, 'BHA-56/24i has lessons on Monday');
  } catch (err) {
    assert(false, 'findClassId check should not throw', err.message);
  }

  // 3. Test empty rooms query
  try {
    const emptyRoomsPages = await edupageService.getEmptyRoomsText('BHA-56/24i', 0, 1);
    assert(Array.isArray(emptyRoomsPages) && emptyRoomsPages.length > 0 && typeof emptyRoomsPages[0] === 'string', 'getEmptyRoomsText returns formatted empty rooms pages');
    assert(!emptyRoomsPages[0].includes('undefined'), 'getEmptyRoomsText does not have undefined strings');
  } catch (err) {
    assert(false, 'getEmptyRoomsText should not throw', err.message);
  }

  console.log(`\n📊 Resilience Test Results: ${passed} Passed, ${failed} Failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
