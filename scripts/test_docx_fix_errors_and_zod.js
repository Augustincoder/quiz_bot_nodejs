'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');
const { BlockNameSchema, SubjectSchema, validateBlockName, validateSubject } = require('../src/validators/testValidators');
const { escapeHtml, safeEdit, parseTextQuestions } = require('../src/core/utils');

async function runTests() {
  console.log('--- TEST: DOCX FIX ERRORS & ZOD V4 COMPATIBILITY ---');

  // Test 1: Zod v4 error extraction without throwing TypeError
  console.log('\n[Test 1] Zod v4 safe error message extraction...');
  const emptyBlock = BlockNameSchema.safeParse('');
  assert.strictEqual(emptyBlock.success, false, 'Empty block name should fail validation');

  const errMsg = emptyBlock.error.issues?.[0]?.message || emptyBlock.error.errors?.[0]?.message || emptyBlock.error.message;
  assert(typeof errMsg === 'string' && errMsg.length > 0, 'Error message should be extracted successfully');
  console.log('✅ Test 1 PASSED: Extracted message:', errMsg);

  // Test 2: validateBlockName and validateSubject with invalid values
  console.log('\n[Test 2] validateBlockName and validateSubject helper functions...');
  const blockErr = validateBlockName('');
  assert(typeof blockErr === 'string' && blockErr.length > 0, 'validateBlockName should return error message');

  const subjErr = validateSubject('a'); // too short (min 2)
  assert(typeof subjErr === 'string' && subjErr.length > 0, 'validateSubject should return error message');
  console.log('✅ Test 2 PASSED');

  // Test 3: HTML escaping for question text with troublesome characters
  console.log('\n[Test 3] Question text HTML escaping for <pre><code>...');
  const badQuestions = [
    '1. 150 < 200 & x > y bo\'lsa nima bo\'ladi?\nA) to\'g\'ri\nB) noto\'g\'ri',
    '2. Formula: a * b _ c [test] `code` "quote"\n#1\n2',
    '3. Oddiy savol matni',
  ];

  for (const bq of badQuestions) {
    const htmlEscaped = escapeHtml(bq);
    const htmlBlock = `<pre><code>${htmlEscaped}</code></pre>`;
    assert(!htmlBlock.includes('<script>'), 'No script injection');
    assert(htmlBlock.includes('&lt;') || !bq.includes('<'), 'Less than properly escaped');
    assert(htmlBlock.includes('&amp;') || !bq.includes('&'), 'Ampersand properly escaped');
  }
  console.log('✅ Test 3 PASSED');

  // Test 4: safeEdit fallback without parse_mode when edit and formatted reply fail
  console.log('\n[Test 4] safeEdit resilience test...');
  let replyCalls = [];
  const mockCtx = {
    editMessageText: async () => { throw new Error('Bad Request: can\'t parse entities'); },
    reply: async (text, extra) => {
      replyCalls.push({ text, extra });
      if (extra && extra.parse_mode) {
        throw new Error('Bad Request: can\'t parse entities in reply');
      }
      return { message_id: 123 };
    }
  };

  const ok = await safeEdit(mockCtx, 'Test message', { parse_mode: 'HTML' });
  assert.strictEqual(ok, true, 'safeEdit should fall back to plain text reply and return true');
  assert.strictEqual(replyCalls.length, 2, 'Should have attempted formatted reply then unformatted reply');
  assert.strictEqual(replyCalls[1].extra.parse_mode, undefined, 'Second attempt should omit parse_mode');
  console.log('✅ Test 4 PASSED');

  // Test 5: parseTextQuestions with ===== delimiter and # on 4th option
  console.log('\n[Test 5] parseTextQuestions with ===== delimiter and # on 4th option...');
  const hemisQuiz = `
+++++
Savol 1 matni
=====
Variant 1
=====
Variant 2
=====
Variant 3
=====
#Variant 4 (to'g'ri)
+++++
Savol 2 matni
=====
Variant 1
=====
#Variant 2 (to'g'ri)
=====
Variant 3
=====
Variant 4
`;
  const parsedHemis = parseTextQuestions(hemisQuiz, 'hash');
  assert.strictEqual(parsedHemis.invalid.length, 0, 'No invalid questions');
  assert.strictEqual(parsedHemis.valid.length, 2, 'Should parse 2 valid questions');
  assert.strictEqual(parsedHemis.valid[0].options.length, 4, 'Question 1 should retain all 4 options');
  assert.strictEqual(parsedHemis.valid[0].correct_index, 3, 'Question 1 correct option is index 3');
  assert.strictEqual(parsedHemis.valid[1].options.length, 4, 'Question 2 should retain all 4 options');
  assert.strictEqual(parsedHemis.valid[1].correct_index, 1, 'Question 2 correct option is index 1');
  console.log('✅ Test 5 PASSED');

  console.log('\n🎉 ALL TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
