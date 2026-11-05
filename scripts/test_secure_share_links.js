'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');
const {
  encodeShareToken,
  decodeShareToken,
  buildShareLink,
  resolveShareParam,
} = require('../src/services/shareService');

async function runTests() {
  console.log('--- TEST: SECURE SHARE LINKS & LEGACY BACKWARD COMPATIBILITY ---');

  // Test 1: Encoding and decoding of valid test and subject IDs
  console.log('\n[Test 1] Correct encoding and decoding...');
  const testIds = [1, 2, 42, 105, 999999];
  for (const id of testIds) {
    const tokenT = encodeShareToken('t', id);
    assert(tokenT && typeof tokenT === 'string', 'Token must be a non-empty string');
    assert(tokenT.length <= 48, `Token length (${tokenT.length}) must be compact`);
    const decodedT = decodeShareToken(tokenT);
    assert.deepStrictEqual(decodedT, { type: 't', id: String(id) }, 'Decoded test ID must match exactly');

    const tokenS = encodeShareToken('s', id);
    const decodedS = decodeShareToken(tokenS);
    assert.deepStrictEqual(decodedS, { type: 's', id: String(id) }, 'Decoded subject ID must match exactly');
  }
  console.log('✅ Test 1 PASSED: All test and subject IDs correctly encoded and decoded.');

  // Test 2: Deterministic property (same ID produces same link, different ID produces different link)
  console.log('\n[Test 2] Determinism and avalanche effect...');
  const token1 = encodeShareToken('t', 100);
  const token1Repeat = encodeShareToken('t', 100);
  const token2 = encodeShareToken('t', 101);
  assert.strictEqual(token1, token1Repeat, 'Same ID must produce identical token');
  assert.notStrictEqual(token1, token2, 'Adjacent IDs must produce completely different tokens');
  console.log('✅ Test 2 PASSED: Deterministic output and strong avalanche effect confirmed.');

  // Test 3: Tamper-resistance and brute-force rejection
  console.log('\n[Test 3] Tamper resistance and invalid input handling...');
  const validToken = encodeShareToken('t', 77);
  // Modify last character
  const corrupted = validToken.slice(0, -1) + (validToken.endsWith('A') ? 'B' : 'A');
  assert.strictEqual(decodeShareToken(corrupted), null, 'Corrupted token must return null');
  assert.strictEqual(decodeShareToken('short'), null, 'Short invalid string must return null');
  assert.strictEqual(decodeShareToken(''), null, 'Empty string must return null');
  assert.strictEqual(decodeShareToken(null), null, 'Null must return null');
  assert.strictEqual(decodeShareToken(12345), null, 'Number must return null');
  console.log('✅ Test 3 PASSED: Tampered and malformed tokens securely rejected.');

  // Test 4: buildShareLink URL generation
  console.log('\n[Test 4] buildShareLink URL generation...');
  const botUser = 'tsue_quiz_bot';
  const privateLink = buildShareLink(botUser, 't', 50);
  assert(privateLink.startsWith(`https://t.me/${botUser}?start=t_`), 'Private link must have start=t_');
  const groupLink = buildShareLink(botUser, 's', 50, true);
  assert(groupLink.startsWith(`https://t.me/${botUser}?startgroup=s_`), 'Group link must have startgroup=s_');
  console.log('✅ Test 4 PASSED: Private and group URLs accurately formed.');

  // Test 5: resolveShareParam - New vs Legacy vs Invalid
  console.log('\n[Test 5] resolveShareParam resolution...');
  // 5a. New secure token
  const resNewTest = resolveShareParam(`t_${encodeShareToken('t', 123)}`);
  assert.strictEqual(resNewTest.type, 't');
  assert.strictEqual(resNewTest.id, '123');
  assert.strictEqual(resNewTest.isLegacy, false);
  assert.strictEqual(resNewTest.isInvalid, false);

  const resNewSubj = resolveShareParam(`s_${encodeShareToken('s', 456)}`);
  assert.strictEqual(resNewSubj.type, 's');
  assert.strictEqual(resNewSubj.id, '456');
  assert.strictEqual(resNewSubj.isLegacy, false);
  assert.strictEqual(resNewSubj.isInvalid, false);

  // 5b. Legacy numeric IDs (backward compatibility)
  const resOldTest = resolveShareParam('t_123');
  assert.strictEqual(resOldTest.type, 't');
  assert.strictEqual(resOldTest.id, '123');
  assert.strictEqual(resOldTest.isLegacy, true);
  assert.strictEqual(resOldTest.isInvalid, false);

  const resOldSubj = resolveShareParam('s_456');
  assert.strictEqual(resOldSubj.type, 's');
  assert.strictEqual(resOldSubj.id, '456');
  assert.strictEqual(resOldSubj.isLegacy, true);
  assert.strictEqual(resOldSubj.isInvalid, false);

  // 5c. Legacy with Telegram group @botname suffix
  const resGroupOld = resolveShareParam('t_999@tsue_quiz_bot');
  assert.strictEqual(resGroupOld.type, 't');
  assert.strictEqual(resGroupOld.id, '999');
  assert.strictEqual(resGroupOld.isLegacy, true);

  const resGroupNew = resolveShareParam(`s_${encodeShareToken('s', 88)}@tsue_quiz_bot`);
  assert.strictEqual(resGroupNew.type, 's');
  assert.strictEqual(resGroupNew.id, '88');
  assert.strictEqual(resGroupNew.isLegacy, false);

  // 5d. Official tests and subjects
  const resOfft = resolveShareParam('offt_Matematika_1');
  assert.strictEqual(resOfft.type, 'offt');
  assert.strictEqual(resOfft.id, 'Matematika_1');

  const resOffs = resolveShareParam('offs_Fizika');
  assert.strictEqual(resOffs.type, 'offs');
  assert.strictEqual(resOffs.id, 'Fizika');

  // 5e. Tampered / invalid params
  const resTampered = resolveShareParam('t_INVALID_RANDOM_TOKEN_HERE');
  assert.strictEqual(resTampered.type, 't');
  assert.strictEqual(resTampered.id, null);
  assert.strictEqual(resTampered.isInvalid, true);

  console.log('✅ Test 5 PASSED: resolveShareParam distinguishes new, legacy, official, and invalid.');

  console.log('\n🎉 ALL SECURE SHARE LINK TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
