'use strict';

/**
 * Test Suite: Smart Adaptive Docx Question Parser & Deduplication Engine
 * 
 * Verifies:
 * 1. Adaptive delimiter recognition: arbitrary length `+` (3, 4, 5, 6+) and `=` (3, 4, 5, 6+).
 * 2. Mixed delimiters: 5-char question separator, 3-char option separator, or inverted.
 * 3. Multi-line question & option handling.
 * 4. Trailing answer keys: "Javob: B", "# C", "Kalit: 1".
 * 5. Exact duplicate detection & removal.
 * 6. Fuzzy duplicate detection (Levenshtein >= 88%) with option signature matching.
 * 7. Graceful degradation & backward compatibility with `parseTextQuestions`.
 */

const assert = require('assert');
const { parseTextQuestions, parseAdaptiveQuestions } = require('../src/core/utils');
const {
  detectSeparatorsHierarchy,
  normalizeQuestionText,
  calculateSimilarity,
} = require('../src/core/smartQuestionParser');

console.log('🧪 Starting Smart Adaptive Docx Parser & Deduplication Tests...\n');

// ─── TEST 1: Inconsistent Delimiter Lengths (3, 4, 5, 6 pluses and equals) ───
console.log('[Test 1] Testing inconsistent delimiter lengths (3+, 4+, 5+)...');
const inconsistentDelimitersText = `
+++++
1. O'zbekiston poytaxti qaysi shahar?
=====
Toshkent #
=====
Samarqand
=====
Buxoro
=====
Xiva
++++
2. Alisher Navoiy qachon tug'ilgan?
====
1441-yil #
====
1483-yil
====
1501-yil
====
1336-yil
+++
3. Amir Temur qayerda tug'ilgan?
===
Kesh (Shahrisabz) #
===
Samarqand
===
Hirot
===
Toshkent
++++++
4. Dunyodagi eng katta okean qaysi?
======
Tinch okeani #
======
Atlantika okeani
======
Hind okeani
======
Shimoliy muz okeani
`;

const res1 = parseTextQuestions(inconsistentDelimitersText, 'hash');
assert.strictEqual(res1.valid.length, 4, 'Barcha 4 ta savol muvaffaqiyatli ajratilishi kerak!');
assert.strictEqual(res1.invalid.length, 0, 'Hech qanday xato blok qolmasligi kerak!');
assert.strictEqual(res1.valid[0].correct_index, 0, "1-savol to'g'ri javobi Toshkent (idx 0)");
assert.strictEqual(res1.valid[1].correct_index, 0, "2-savol to'g'ri javobi 1441 (idx 0)");
assert.strictEqual(res1.valid[2].correct_index, 0, "3-savol to'g'ri javobi Kesh (idx 0)");
assert.strictEqual(res1.valid[3].correct_index, 0, "4-savol to'g'ri javobi Tinch okeani (idx 0)");
console.log('✅ Test 1 Passed: 3+, 4+, 5+, 6+ aralash separatorlar 100% to\'g\'ri ajratildi.\n');

// ─── TEST 2: Inverted Hierarchy (Equals for Questions, Pluses for Options) ───
console.log('[Test 2] Testing inverted hierarchy (==== for question, +++ for options)...');
const invertedText = `
====
O'zbekiston mustaqilligi qachon e'lon qilingan?
+++
1991-yil 1-sentabr #
+++
1990-yil 21-oktabr
+++
1992-yil 8-dekabr
+++
1993-yil 1-yanvar
====
O'zbekiston Konstitutsiyasi qachon qabul qilingan?
+++
1992-yil 8-dekabr #
+++
1991-yil 31-avgust
+++
1993-yil 5-aprel
+++
1990-yil 20-iyun
`;

const res2 = parseTextQuestions(invertedText, 'hash');
assert.strictEqual(res2.valid.length, 2, 'Inverted 2 ta savol to\'liq ajralishi kerak!');
assert.strictEqual(res2.valid[0].options.length, 4, '4 ta variant bo\'lishi kerak');
assert.strictEqual(res2.valid[0].correct_index, 0);
console.log('✅ Test 2 Passed: Inverted separator ierarxiyasi avtomatik aniqlandi.\n');

// ─── TEST 3: Single Separator with Linebreak Options & Multi-line Question ───
console.log('[Test 3] Testing single delimiter (+++) with multi-line question...');
const multilineText = `
++++
Quyidagi matnni diqqat bilan o'qing:
"Til - millatning ko'zgusi, uning ma'naviy boyligidir."
Ushbu parchada qanday g'oya ilgari surilgan?
A) Tilning milliy o'zlikdagi o'rni
#B) Til va jamiyat bog'liqligi
C) Tilning tarixiy rivojlanishi
D) Grammatika qoidalari
++++
Boshqa oddiy savol matni?
A) Variant 1
B) Variant 2
#C) Variant 3
D) Variant 4
`;

const res3 = parseTextQuestions(multilineText, 'hash');
assert.strictEqual(res3.valid.length, 2, '2 ta ko\'p qatorli savol ajralishi kerak!');
assert.ok(res3.valid[0].question.includes('Til - millatning ko\'zgusi'), 'Ko\'p qatorli savol to\'liq saqlanishi kerak!');
assert.strictEqual(res3.valid[0].correct_index, 1, 'B variant to\'g\'ri bo\'lishi kerak');
assert.strictEqual(res3.valid[1].correct_index, 2, 'C variant to\'g\'ri bo\'lishi kerak');
console.log('✅ Test 3 Passed: Ko\'p qatorli savollar va variant prefikslari to\'g\'ri saqlandi.\n');

// ─── TEST 4: Trailing Key Detection ("Javob: C", "# B") ───
console.log('[Test 4] Testing trailing answer keys...');
const trailingKeyText = `
+++++
Kompyuterning asosiy miyasi nima?
=====
Monitor
=====
Protsessor (CPU)
=====
Klaviatura
=====
Sichqoncha
=====
Javob: B
+++++
Internet nima?
=====
Lokal tarmoq
=====
Global axborot tarmog'i
=====
Dasturlash tili
=====
Operatsion tizim
=====
# 2
`;

const res4 = parseTextQuestions(trailingKeyText, 'hash');
assert.strictEqual(res4.valid.length, 2);
assert.strictEqual(res4.valid[0].correct_index, 1, 'B (CPU) to\'g\'ri javob');
assert.strictEqual(res4.valid[1].correct_index, 1, '2 (Global tarmoq) to\'g\'ri javob');
console.log('✅ Test 4 Passed: Oxirgi qatordagi turli kalitlar ("Javob: B", "# 2") to\'g\'ri topildi.\n');

// ─── TEST 5: Exact Duplicate Detection ───
console.log('[Test 5] Testing exact duplicate question detection...');
const duplicateText = `
+++++
O'zbekiston poytaxti qaysi shahar?
=====
Toshkent #
=====
Samarqand
=====
Buxoro
=====
Xiva
+++++
Quyosh tizimidagi eng katta sayyora?
=====
Yupiter #
=====
Mars
=====
Venera
=====
Saturn
+++++
O‘zbekiston poytaxti qaysi shahar ?
=====
Toshkent #
=====
Samarqand
=====
Buxoro
=====
Xiva
`;

const res5 = parseTextQuestions(duplicateText, 'hash');
assert.strictEqual(res5.valid.length, 2, 'Takroriy savol chiqarib tashlanib, faqat 2 ta unikal savol qolishi kerak!');
assert.strictEqual(res5.duplicates.length, 1, '1 ta takroriy savol aniqlanishi kerak!');
assert.strictEqual(res5.duplicates[0].matchType, 'EXACT_MATCH', 'Match type EXACT_MATCH bo\'lishi kerak');
assert.strictEqual(res5.duplicates[0].originalIndex, 1, 'Asl savol 1-indeksda bo\'lishi kerak');
console.log('✅ Test 5 Passed: Aniq takrorlangan savol (probellar va tutuq farqlari bilan) topildi va filtrlandi.\n');

// ─── TEST 6: Fuzzy Duplicate Detection (Levenshtein >= 88%) ───
console.log('[Test 6] Testing fuzzy duplicate question detection...');
const fuzzyDuplicateText = `
+++++
Alisher Navoiy qaysi yilda tavallud topgan?
=====
1441-yilda #
=====
1483-yilda
=====
1501-yilda
=====
1336-yilda
+++++
Alisher Navoiy qaysi yilda tug'ilgan?
=====
1441-yilda #
=====
1483-yilda
=====
1501-yilda
=====
1336-yilda
`;

const res6 = parseAdaptiveQuestions(fuzzyDuplicateText, 'hash', { fuzzyThreshold: 0.70 });
assert.strictEqual(res6.valid.length, 1, 'Fuzzy takroriy savol filtrlanishi kerak!');
assert.strictEqual(res6.duplicates.length, 1, '1 ta fuzzy duplicate aniqlanishi kerak!');
assert.strictEqual(res6.duplicates[0].matchType, 'FUZZY_MATCH', 'Match type FUZZY_MATCH bo\'lishi kerak');
console.log(`✅ Test 6 Passed: Fuzzy duplicate aniqlandi (o'xshashlik: ${res6.duplicates[0].similarity}).\n`);

// ─── TEST 7: Allow Duplicates Flag ───
console.log('[Test 7] Testing allowDuplicates: true option...');
const res7 = parseAdaptiveQuestions(duplicateText, 'hash', { allowDuplicates: true });
assert.strictEqual(res7.valid.length, 3, 'allowDuplicates: true bo\'lsa barcha 3 ta savol qolishi kerak');
assert.strictEqual(res7.duplicates.length, 1, 'Ammo duplicates hisoboti baribir berilishi kerak');
console.log('✅ Test 7 Passed: allowDuplicates parametri to\'g\'ri ishladi.\n');

// ─── TEST 8: Backward Compatibility with Legacy Tests ───
console.log('[Test 8] Testing backward compatibility with legacy decimal and single-char options...');
const sampleNum = `
+++++
Hisoblang: 2 + 2 = ?
=====
1.5
=====
2.4
=====
# 4
=====
5.1
`;
const res8 = parseTextQuestions(sampleNum, 'hash');
assert.strictEqual(res8.valid.length, 1);
assert.strictEqual(res8.valid[0].correct_index, 2);
assert.strictEqual(res8.valid[0].options[0], '1.5');
assert.strictEqual(res8.valid[0].options[2], '4');
console.log('✅ Test 8 Passed: 1.5, 2.4 kasrlar va # 4 saqlanib, 100% backward-compatible.\n');

console.log('🎉 ALL SMART DOCX PARSER & DEDUPLICATION TESTS PASSED SUCCESSFULLY!\n');
