/**
 * Test suite to verify accurate building parsing and ensure "Asosiy bino" is never forcefully added.
 */
const assert = require('assert');
const edupage = require('../src/services/edupageService');

async function runTests() {
  console.log('🧪 Starting Classroom & Building Parsing Tests...\n');

  // 1. Unit tests for parseRoomLocation
  console.log('1. Testing parseRoomLocation unit logic:');
  const testCases = [
    { input: '1-bochka-220 (Moliya)', expected: { bino: '1-bochka', qavat: '2-qavat' } },
    { input: '1/111', expected: { bino: '4-bino', qavat: '1-qavat' } },
    { input: '1/216L', expected: { bino: '4-bino', qavat: '2-qavat' } },
    { input: '3/102L-50', expected: { bino: '3-bino', qavat: '1-qavat' } },
    { input: '4//1-250', expected: { bino: '4-bino', qavat: '1-qavat' } },
    { input: '4-bino Test markazi 1-30', expected: { bino: '4-bino', qavat: '1-qavat' } },
    { input: '4-bino Test markazi 2-30', expected: { bino: '4-bino', qavat: '2-qavat' } },
    { input: '5/201', expected: { bino: '5-bino', qavat: '2-qavat' } },
    { input: '7/labaratoriya', expected: { bino: '7-bino', qavat: '1-qavat' } },
    { input: '8-101', expected: { bino: '8-bino', qavat: '1-qavat' } },
    { input: '8-201-68', expected: { bino: '8-bino', qavat: '2-qavat' } },
    { input: '2-M2', expected: { bino: '2-bino', qavat: '2-qavat' } },
    { input: '2/leksionniy-1', expected: { bino: '2-bino', qavat: '1-qavat' } },
    { input: '2-bino/210', expected: { bino: '2-bino', qavat: '2-qavat' } },
    { input: '1 korpus 211 xona', expected: { bino: '4-bino', qavat: '2-qavat' } },
    { input: 'Litsey 2A03E-26', expected: { bino: 'Litsey', qavat: '2-qavat' } },
    { input: 'Rektorat 12-8', expected: { bino: 'Rektorat', qavat: '12-qavat' } },
    // Placeholders and off-campus entities should be null
    { input: '-', expected: null },
    { input: '--', expected: null },
    { input: '?', expected: null },
    { input: '', expected: null },
    { input: 'Online', expected: null },
    { input: "E-ma'ruzalar zali", expected: null },
    { input: "D-ma'ruzalar zali", expected: null },
    { input: 'TRASTBANK XAB Xalqaro moliya filliali', expected: null },
    { input: "Turizm qo'mitasi", expected: null },
  ];

  for (const { input, expected } of testCases) {
    const actual = edupage.parseRoomLocation(input);
    if (expected === null) {
      assert.strictEqual(actual, null, `Expected null for "${input}", got ${JSON.stringify(actual)}`);
      console.log(`  ✅ Passed: "${input}" correctly ignored (null)`);
    } else {
      assert(actual, `Expected result for "${input}", got null`);
      assert.strictEqual(actual.bino, expected.bino, `Bino mismatch for "${input}": expected ${expected.bino}, got ${actual.bino}`);
      assert.strictEqual(actual.qavat, expected.qavat, `Qavat mismatch for "${input}": expected ${expected.qavat}, got ${actual.qavat}`);
      console.log(`  ✅ Passed: "${input}" => ${actual.bino}, ${actual.qavat}`);
    }
  }

  // 2. Test group building resolution
  console.log('\n2. Testing getGroupBuildings without forced Asosiy bino:');
  const db = await edupage.getIndexedDatabase();
  assert(db, 'Indexed database should load');

  let forcedAsosiyCount = 0;
  let totalChecked = 0;
  db.buildingsByClassId.forEach((binos, cid) => {
    totalChecked++;
    if (binos.includes('Asosiy bino')) {
      forcedAsosiyCount++;
    }
  });

  console.log(`  Total groups checked: ${totalChecked}`);
  console.log(`  Groups with Asosiy bino: ${forcedAsosiyCount}`);
  assert.strictEqual(forcedAsosiyCount, 0, 'No group should have "Asosiy bino" forcefully injected');
  console.log('  ✅ Passed: Exactly 0 groups have "Asosiy bino"');

  // Verify group ST-50/24 specifically (which previously had [Asosiy bino, 8-bino])
  const stBinos = await edupage.getGroupBuildings('ST-50/24');
  console.log(`  ST-50/24 resolved buildings:`, stBinos);
  assert.deepStrictEqual(stBinos, ['8-bino'], 'ST-50/24 should only have 8-bino');
  console.log('  ✅ Passed: ST-50/24 has ONLY 8-bino (no Asosiy bino)');

  // 3. Test getEmptyRoomsText output
  console.log('\n3. Testing getEmptyRoomsText output:');
  const allRoomsPages = await edupage.getEmptyRoomsText(null, 1, 1, 0, 'all');
  assert(Array.isArray(allRoomsPages) && allRoomsPages.length > 0, 'Should return pages');
  const firstPage = allRoomsPages[0];
  assert(!firstPage.includes('🏛 <b>Asosiy bino</b>'), 'First page of empty rooms must NOT contain Asosiy bino');
  assert(!firstPage.includes('Asosiy bino'), 'Empty rooms list must NOT contain Asosiy bino');
  console.log('  ✅ Passed: getEmptyRoomsText(all) contains NO "Asosiy bino" block');

  const myRoomsPages = await edupage.getEmptyRoomsText('ST-50/24', 1, 1, 0, 'my');
  assert(Array.isArray(myRoomsPages) && myRoomsPages.length > 0, 'Should return student pages');
  const myFirstPage = myRoomsPages[0];
  assert(!myFirstPage.includes('Asosiy bino'), 'Student empty rooms list must NOT contain Asosiy bino');
  assert(myFirstPage.includes('8-bino'), 'Student empty rooms list should contain 8-bino');
  console.log('  ✅ Passed: getEmptyRoomsText(my) for ST-50/24 has ONLY 8-bino');

  console.log('\n🎉 ALL CLASSROOM & BUILDING TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
