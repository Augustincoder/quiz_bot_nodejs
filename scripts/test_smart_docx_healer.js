'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_BOT_TOKEN_FOR_HEALER';

const assert = require('assert');

// 1. Module requirement under test (Step 1 of TDD: will fail RED)
const aiDocxHealer = require('../src/services/aiDocxHealer');
const { extractQuestionCandidates } = require('../src/validators/testValidators');
const testCreation = require('../src/handlers/testCreation');

async function runTests() {
  console.log('🧪 Testing Task 4: Docx Multi-Error AI & Visual Healer...\n');

  // Test 1: Smashed line - Question and options on a single unformatted line
  console.log('[Test 1] Smashed single line recovery...');
  const smashedLine = "15. Axborot xavfsizligining 3 ta ustuni nima? A) Konfidensiallik, yaxlitlik, mavjudlik B) Tezlik, hajm, sifat C) Parol, login, kod D) Barcha javoblar noto'g'ri";
  const healed1 = aiDocxHealer.healSmashedLine(smashedLine);
  assert(healed1 && healed1.success, 'Healer must separate smashed single line');
  assert.strictEqual(healed1.questionText, 'Axborot xavfsizligining 3 ta ustuni nima?');
  assert.strictEqual(healed1.options.length, 4);
  assert.strictEqual(healed1.options[0].cleanText, 'Konfidensiallik, yaxlitlik, mavjudlik');
  assert.strictEqual(healed1.options[1].cleanText, 'Tezlik, hajm, sifat');
  assert.strictEqual(healed1.options[2].cleanText, 'Parol, login, kod');
  assert.strictEqual(healed1.options[3].cleanText, "Barcha javoblar noto'g'ri");
  console.log('✅ Test 1 PASSED');

  // Test 2: Smashed line with numbered options (1-4) or dashes
  console.log('[Test 2] Smashed line with numeric and symbol prefixes...');
  const smashedNumeric = "Kompyuterning asosiy miyasi nima? 1) RAM 2) CPU 3) HDD 4) GPU";
  const healedNum = aiDocxHealer.healSmashedLine(smashedNumeric);
  assert(healedNum && healedNum.success, 'Must separate numeric option line');
  assert.strictEqual(healedNum.options.length, 4);
  assert.strictEqual(healedNum.options[1].cleanText, 'CPU');
  console.log('✅ Test 2 PASSED');

  // Test 3: Bold / Underlined / Asterisk key detection
  console.log('[Test 3] Bold / Underline key detection...');
  const htmlSnippetWithBold = `<p>O'zbekiston BMTga qachon a'zo bo'lgan?</p>
<p>A) 1991-yil</p>
<p><b>B) 1992-yil 2-mart</b></p>
<p>C) 1993-yil</p>
<p>D) 1994-yil</p>`;

  const boldDetected = aiDocxHealer.detectFormattedKey(htmlSnippetWithBold);
  assert(boldDetected, 'detectFormattedKey must return an object');
  assert.strictEqual(boldDetected.correctIndex, 1, 'Must detect option B as correct due to <b> tag');
  assert(boldDetected.confidence > 0.8, 'Confidence should be high for <b> tag');

  const htmlWithUnderline = `<p>Dasturlash tili qaysi?</p>
<p>A) HTML</p>
<p>B) CSS</p>
<p><u>C) Python</u></p>
<p>D) SQL</p>`;
  const underlineDetected = aiDocxHealer.detectFormattedKey(htmlWithUnderline);
  assert.strictEqual(underlineDetected.correctIndex, 2, 'Must detect option C as correct due to <u> tag');

  const textWithPrefixes = `Kattalik birligi:
A) metr
+B) kilogramm
C) sekund`;
  const plusDetected = aiDocxHealer.detectFormattedKey(textWithPrefixes);
  assert.strictEqual(plusDetected.correctIndex, 1, 'Must detect option B marked with +');
  console.log('✅ Test 3 PASSED');

  // Test 4: Cyrillic / Latin letter mismatch normalization
  console.log('[Test 4] Cyrillic/Latin letter mismatch normalization...');
  const mixedText = "А) Variant 1\nB) Variant 2\nС) Variant 3\nD) Variant 4"; // Cyrillic А and С
  const normalized = aiDocxHealer.normalizeOptionPrefixes(mixedText);
  assert(!normalized.includes('А)'), 'Cyrillic А must be normalized to Latin A');
  assert(!normalized.includes('С)'), 'Cyrillic С must be normalized to Latin C');
  assert(normalized.includes('A)'), 'Must contain Latin A)');
  assert(normalized.includes('C)'), 'Must contain Latin C)');
  console.log('✅ Test 4 PASSED');

  // Test 5: extractQuestionCandidates validator integration
  console.log('[Test 5] extractQuestionCandidates integration...');
  assert(typeof extractQuestionCandidates === 'function', 'extractQuestionCandidates must be exported');
  const candidatesFromSmashed = extractQuestionCandidates(smashedLine);
  assert.strictEqual(candidatesFromSmashed.questionText, 'Axborot xavfsizligining 3 ta ustuni nima?');
  assert.strictEqual(candidatesFromSmashed.options.length, 4);

  const multilineUnmarked = "Qaysi daryo eng uzun?\nNil\nAmazonka\nMissisipi\nYanszi";
  const candidatesFromMulti = extractQuestionCandidates(multilineUnmarked);
  assert.strictEqual(candidatesFromMulti.questionText, 'Qaysi daryo eng uzun?');
  assert.strictEqual(candidatesFromMulti.options.length, 4);
  assert.strictEqual(candidatesFromMulti.options[0].cleanText, 'Nil');
  console.log('✅ Test 5 PASSED');

  // Test 6: batchAutoHeal
  console.log('[Test 6] batchAutoHeal heuristic batch execution...');
  const invalidPool = [
    smashedLine,
    `<p>O'zbekiston poytaxti qayer?</p><p><b>A) Toshkent</b></p><p>B) Samarqand</p><p>C) Buxoro</p>`,
    "Quyosh tizimidagi eng katta sayyora?\n#Yupiter\nMars\nVenera",
  ];
  const batchResult = await aiDocxHealer.batchAutoHeal(invalidPool);
  assert(batchResult && Array.isArray(batchResult.healed), 'batchResult must contain healed array');
  assert(batchResult.healed.length >= 2, 'Should heal at least 2 questions without API key');
  assert.strictEqual(batchResult.healed[0].options.length, 4);
  console.log('✅ Test 6 PASSED');

  // Test 7: testCreation handler exports and action registrations
  console.log('[Test 7] testCreation interactive healer actions registration...');
  assert(typeof testCreation.cbFixAutoAll === 'function', 'cbFixAutoAll must be exported');
  assert(typeof testCreation.cbFixPickKey === 'function', 'cbFixPickKey must be exported');
  assert(typeof testCreation.cbOpenInspector === 'function', 'cbOpenInspector must be exported');

  // Mock bot to verify registration
  const registeredActions = [];
  const mockBot = {
    action: (pattern, handler) => {
      registeredActions.push(pattern);
    }
  };
  testCreation.register(mockBot);

  const hasFixAutoAll = registeredActions.some(a => String(a) === 'fix_auto_all' || (a instanceof RegExp && a.test('fix_auto_all')));
  const hasFixPickKey = registeredActions.some(a => (a instanceof RegExp && a.test('fix_pick_key_0_1')));
  const hasOpenInspector = registeredActions.some(a => String(a).includes('fix_open_inspector') || (a instanceof RegExp && a.test('fix_open_inspector')));

  assert(hasFixAutoAll, 'fix_auto_all must be registered');
  assert(hasFixPickKey, 'fix_pick_key regex must be registered');
  assert(hasOpenInspector, 'fix_open_inspector must be registered');
  console.log('✅ Test 7 PASSED');

  // Test 8: End-to-End Simulation of 1-Tap Option Pick (cbFixPickKey)
  console.log('[Test 8] cbFixPickKey 1-tap option resolution...');
  const mockCtxPick = {
    from: { id: 777123 },
    session: {
      data: {
        invalidQs: [
          "O'zbekistonning poytaxti qayer?\nA) Samarqand\nB) Buxoro\nC) Toshkent\nD) Andijon"
        ],
        questions: [],
      }
    },
    callbackQuery: { data: 'fix_pick_key_0_2' }, // Option C (index 2)
    answerCbQuery: async (msg) => msg,
    editMessageText: async () => {},
    reply: async () => {},
  };

  await testCreation.cbFixPickKey(mockCtxPick);
  assert.strictEqual(mockCtxPick.session.data.invalidQs.length, 0, 'Invalid pool must now be empty');
  assert.strictEqual(mockCtxPick.session.data.questions.length, 1, 'Questions pool must have 1 resolved question');
  assert.strictEqual(mockCtxPick.session.data.questions[0].correct_index, 2, 'Correct index must be 2 (Option C)');
  assert.strictEqual(mockCtxPick.session.data.questions[0].options[2], 'Toshkent', 'Correct option text should match');
  console.log('✅ Test 8 PASSED');

  // Test 9: End-to-End Simulation of 1-Tap AI Auto-Heal (cbFixAutoAll)
  console.log('[Test 9] cbFixAutoAll batch auto-recovery...');
  const mockCtxAuto = {
    from: { id: 777124 },
    session: {
      data: {
        invalidQs: [
          "Axborot xavfsizligi ustunlari: A) Konfidensiallik B) Tezlik C) Parol D) Kod",
          "<p>Quyosh tizimining markazi nima?</p><p><b>A) Quyosh</b></p><p>B) Yer</p><p>C) Oy</p>",
        ],
        questions: [],
      }
    },
    callbackQuery: { data: 'fix_auto_all' },
    answerCbQuery: async (msg) => msg,
    editMessageText: async () => {},
    reply: async () => {},
  };

  await testCreation.cbFixAutoAll(mockCtxAuto);
  assert.strictEqual(mockCtxAuto.session.data.invalidQs.length, 0, 'All repairable items must be auto-healed');
  assert.strictEqual(mockCtxAuto.session.data.questions.length, 2, 'Both questions must be added to questions');
  console.log('✅ Test 9 PASSED');

  // Test 10: cbOpenInspector Widget Launcher
  console.log('[Test 10] cbOpenInspector HTML widget launcher...');
  let editedText = '';
  let editedExtra = null;
  const mockCtxInspector = {
    from: { id: 777125 },
    session: {
      data: {
        invalidQs: [smashedLine],
      }
    },
    callbackQuery: { data: 'fix_open_inspector' },
    answerCbQuery: async () => {},
    editMessageText: async (text, extra) => {
      editedText = text;
      editedExtra = extra;
      return true;
    },
    reply: async () => {},
  };

  await testCreation.cbOpenInspector(mockCtxInspector);
  assert(editedText.includes('Smart Docx Visual Healer'), 'Must show Docx Visual Healer title in message');
  assert(editedExtra && editedExtra.reply_markup, 'Must provide reply markup with web_app button');
  const webAppBtn = editedExtra.reply_markup.inline_keyboard?.[0]?.[0];
  assert(webAppBtn && webAppBtn.web_app && webAppBtn.web_app.url, 'Must include web_app launcher button with signed URL');
  assert(webAppBtn.web_app.url.includes('/widget/'), 'URL must target widget engine path');
  console.log('✅ Test 10 PASSED');

  // Test 11: Docx Word XML <w:b/> tag support in detectFormattedKey
  console.log('[Test 11] Word XML <w:b/> formatting tag support...');
  const xmlSample = `<w:p><w:r><w:t>Alisher Navoiy qachon tug'ilgan?</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>A) 1441-yil</w:t></w:r></w:p>
<w:p><w:r><w:t>B) 1451-yil</w:t></w:r></w:p>
<w:p><w:r><w:t>C) 1431-yil</w:t></w:r></w:p>`;
  const xmlDetected = aiDocxHealer.detectFormattedKey(xmlSample);
  assert.strictEqual(xmlDetected.correctIndex, 0, 'Must detect option A with <w:b/> tag');
  console.log('✅ Test 11 PASSED');

  console.log('\n🎉 ALL TASK 4 TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
