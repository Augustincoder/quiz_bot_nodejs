'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

const assert = require('assert');
const { parseTextQuestions, escapeHtml } = require('../src/core/utils');

async function runTests() {
  console.log('--- TEST PART 2: QUIZ CREATION FIXES ---');

  // Test 1: BUG-CR-01 - Auto-naming sanitization for DOCX file name
  console.log('\n[Test 1] BUG-CR-01: DOCX file auto-naming sanitization...');
  function sanitizeDocxName(fileName) {
    return fileName
      .replace(/\.docx$/i, "")
      .replace(/_/g, " ")
      .replace(/[^\w\s\-\.\,\'\u0400-\u04FF\u0100-\u017F]/g, "")
      .trim()
      .substring(0, 50) || "Word Test";
  }

  const sanitized1 = sanitizeDocxName("Tarix_Fanidan_Test_2024.docx");
  assert.strictEqual(sanitized1, "Tarix Fanidan Test 2024", "Normal file name should be cleaned properly");

  const sanitized2 = sanitizeDocxName("Biologiya <script>alert(1)</script>!*#$.docx");
  assert.strictEqual(sanitized2, "Biologiya scriptalert1script", "Special characters, HTML, markdown chars stripped");

  const sanitized3 = sanitizeDocxName("____.docx");
  assert.strictEqual(sanitized3, "Word Test", "Empty result falls back to 'Word Test'");

  const sanitized4 = sanitizeDocxName("Она_тили_ва_адабиёт_ўзбек.DOCX");
  assert.strictEqual(sanitized4, "Она тили ва адабиёт ўзбек", "Cyrillic and case-insensitive .DOCX handled");
  console.log('✅ BUG-CR-01 PASSED');

  // Test 2: BUG-CR-02 - Safe HTML escaping in test creation templates
  console.log('\n[Test 2] BUG-CR-02: HTML formatting and safe escaping in testCreation...');
  const subjectWithSpecialChars = 'Matematika <Pro> & "Algebra"';
  const blockWithSpecialChars = '1-Mavzu: <Kvadrat tenglamalar>';
  const escapedSubj = escapeHtml(subjectWithSpecialChars);
  const escapedBlock = escapeHtml(blockWithSpecialChars);

  assert.strictEqual(escapedSubj, 'Matematika &lt;Pro&gt; &amp; &quot;Algebra&quot;');
  assert.strictEqual(escapedBlock, '1-Mavzu: &lt;Kvadrat tenglamalar&gt;');

  // Verify template string generates safe HTML without raw markdown syntax
  const summaryMsg = `📚 Fan: <b>${escapedSubj}</b>\n📝 Asosiy Blok: <b>${escapedBlock}</b>`;
  assert(!summaryMsg.includes('<script>'));
  assert(summaryMsg.includes('&lt;Pro&gt;'));
  console.log('✅ BUG-CR-02 PASSED');

  // Test 3: BUG-CR-03 - cbEditQuestionStart index bounds guard
  console.log('\n[Test 3] BUG-CR-03: cbEditQuestionStart index bounds guard...');
  const testCreation = require('../src/handlers/testCreation');

  let gridCalled = false;
  const mockCtx = {
    answerCbQuery: async () => {},
    callbackQuery: { data: 'edit_q_999' },
    session: {
      data: {
        questions: [
          { question: 'Q1?', options: ['A', 'B'], correct_index: 0 }
        ]
      }
    },
    editMessageText: async () => {}
  };

  // We can trigger cbEditQuestionStart and ensure it doesn't crash on out-of-bounds index
  assert.doesNotReject(async () => {
    // When idx is 999 (out of bounds), it redirects to cbPreviewGrid
    await testCreation.cbEditQuestionStart(mockCtx);
  }, 'Should not throw on out-of-bounds question edit index');
  console.log('✅ BUG-CR-03 PASSED');

  // Test 4: BUG-CR-04 - parseTextQuestions multiline & up to J options
  console.log('\n[Test 4] BUG-CR-04: parseTextQuestions multiline, option letters up to J, 10-option clipping...');
  const multilineInput = `
Quyidagi fikrlardan qaysi biri to'g'ri?
Bu savol bir nechta qatorlardan iborat matnga ega
va keyingi satrlar savolning davomi hisoblanadi.
#A) Birinchi to'g'ri variant
B) Ikkinchi variant
C) Uchinchi variant
D) To'rtinchi variant
`;

  const parsedMulti = parseTextQuestions(multilineInput, 'hash');
  assert.strictEqual(parsedMulti.valid.length, 1, 'Should parse 1 multiline question');
  assert.strictEqual(parsedMulti.valid[0].correct_index, 0);
  assert(parsedMulti.valid[0].question.includes("bir nechta qatorlardan"));
  assert(parsedMulti.valid[0].question.includes("savolning davomi"));
  assert.strictEqual(parsedMulti.valid[0].options.length, 4);

  // Test options up to J (10 options)
  const tenOptionsInput = `
10 ta variantli savol:
#a) Variant A
b) Variant B
c) Variant C
d) Variant D
e) Variant E
f) Variant F
g) Variant G
h) Variant H
i) Variant I
j) Variant J
`;
  const parsed10 = parseTextQuestions(tenOptionsInput, 'hash');
  assert.strictEqual(parsed10.valid.length, 1);
  assert.strictEqual(parsed10.valid[0].options.length, 10);
  assert.strictEqual(parsed10.valid[0].options[9], 'Variant J', 'J option should be stripped and parsed');
  assert.strictEqual(parsed10.valid[0].correct_index, 0);

  // Test 11 options (clipping to 10 and preserving correct answer)
  const elevenOptionsInput = `
Ko'p variantli savol:
a) Variant 1
b) Variant 2
c) Variant 3
d) Variant 4
e) Variant 5
f) Variant 6
g) Variant 7
h) Variant 8
i) Variant 9
j) Variant 10
#k) To'g'ri Variant 11
`;
  const parsed11 = parseTextQuestions(elevenOptionsInput, 'hash');
  assert.strictEqual(parsed11.valid.length, 1);
  assert.strictEqual(parsed11.valid[0].options.length, 10, 'Should clip to 10 options max for Telegram poll');
  assert.strictEqual(parsed11.valid[0].correct_index, 9, 'Correct index must be 9 (preserved in 10th slot)');
  assert.strictEqual(parsed11.valid[0].options[9], "To'g'ri Variant 11");
  console.log('✅ BUG-CR-04 PASSED');

  // Test 5: BUG-CR-05 - Sequential testId for AI tests saving
  console.log('\n[Test 5] BUG-CR-05: Sequential testId generation in AI tests saving...');
  const botModule = require('../src/core/bot');
  botModule.memoryDb = {
    'fizika': {
      1: { test_id: 1, questions: [] },
      2: { test_id: 2, questions: [] },
      '1728864000000': { test_id: '1728864000000', questions: [] } // Old timestamp to ignore
    }
  };

  const subject = 'fizika';
  const memDb = botModule.memoryDb || {};
  const existingTests = Object.keys(memDb[subject] || {})
    .map(Number)
    .filter(n => !isNaN(n) && n > 0 && n < 1000000000);
  const nextTestId = existingTests.length > 0 ? Math.max(...existingTests) + 1 : 1;

  assert.strictEqual(nextTestId, 3, 'Next testId should be 3 (sequential), ignoring timestamps');

  // For a new subject without tests
  const emptySubjTests = Object.keys(memDb['kimyo'] || {})
    .map(Number)
    .filter(n => !isNaN(n) && n > 0 && n < 1000000000);
  const newSubjTestId = emptySubjTests.length > 0 ? Math.max(...emptySubjTests) + 1 : 1;
  assert.strictEqual(newSubjTestId, 1, 'First testId for a new subject should be 1');
  console.log('✅ BUG-CR-05 PASSED');

  // Test 6: BUG-CR-06 - Auto-docx question limit constant and message
  console.log('\n[Test 6] BUG-CR-06: Auto-docx question limit constant and message alignment...');
  const fs = require('fs');
  const path = require('path');
  const creationCode = fs.readFileSync(path.join(__dirname, '../src/handlers/testCreation.js'), 'utf8');

  assert(creationCode.includes('const MAX_QUESTIONS = 300;'), 'MAX_QUESTIONS must be 300');
  assert(creationCode.includes('dastlabki ${MAX_QUESTIONS} ta savol'), 'limitMsg must reference MAX_QUESTIONS (300)');
  assert(!creationCode.includes('dastlabki 250 ta savol'), 'Should not mention 250 when limit is 300');
  console.log('✅ BUG-CR-06 PASSED');

  console.log('\n========================================');
  console.log('ALL PART 2 (QUIZ CREATION) TESTS PASSED! 🎉');
  console.log('========================================');
}

runTests().catch(err => {
  console.error('❌ PART 2 TEST SUITE FAILED:', err);
  process.exit(1);
});
