'use strict';

/**
 * Extreme Edge Cases & Benchmark Test Suite
 * for Smart Adaptive Docx Parser & Deduplication Engine
 */

const assert = require('assert');
const { parseTextQuestions, parseAdaptiveQuestions } = require('../src/core/utils');

console.log('🔬 Boshlanmoqda: Ekstremal Edge Case va Benchmark Sinovlari...\n');

// ─── TEST 1: HEMIS + Answer Marker (+Toshkent, +A) Toshkent, A) +Toshkent) ───
console.log('[Test 1] HEMIS + belgisi bilan to\'g\'ri javobni aniqlash...');
const hemisInput1 = `
+++++
O'zbekiston poytaxti qaysi shahar?
=====
+Toshkent
=====
Samarqand
=====
Buxoro
=====
Xiva
+++++
Amir Temur tavallud topgan shahar?
=====
+A) Shahrisabz
=====
B) Samarqand
=====
C) Buxoro
=====
D) Toshkent
+++++
Alisher Navoiy tavallud topgan shahar?
=====
A) +Hirot
=====
B) Samarqand
=====
C) Mashhad
=====
D) Nishopur
`;

const resHemis = parseTextQuestions(hemisInput1, 'hash');
assert.strictEqual(resHemis.valid.length, 3, 'Barcha 3 ta HEMIS savoli ajratilishi kerak!');
assert.strictEqual(resHemis.invalid.length, 0, 'Hech qanday xato blok qolmasligi kerak!');
assert.strictEqual(resHemis.valid[0].correct_index, 0, '1-savol to\'g\'ri javobi Toshkent (idx 0)');
assert.strictEqual(resHemis.valid[0].options[0], 'Toshkent');
assert.strictEqual(resHemis.valid[1].correct_index, 0, '2-savol to\'g\'ri javobi Shahrisabz (idx 0)');
assert.strictEqual(resHemis.valid[1].options[0], 'Shahrisabz');
assert.strictEqual(resHemis.valid[2].correct_index, 0, '3-savol to\'g\'ri javobi Hirot (idx 0)');
assert.strictEqual(resHemis.valid[2].options[0], 'Hirot');
console.log('✅ Test 1 PASSED: HEMIS + belgili barcha formatlar (+Toshkent, +A), A) +) benuqson tanildi.\n');

// ─── TEST 2: Inline Options on a Single Line ───
console.log('[Test 2] Bir qatorda yonma-yon yozilgan variantlar (Inline Options)...');
const inlineInput = `
+++++
1. Alisher Navoiy qachon tug'ilgan?
#A) 1441-yil   B) 1483-yil   C) 1501-yil   D) 1336-yil
+++++
2. Zahiriddin Muhammad Bobur qachon tug'ilgan?
A) 1441-yil   #B) 1483-yil   C) 1501-yil   D) 1336-yil
`;

const resInline = parseTextQuestions(inlineInput, 'hash');
assert.strictEqual(resInline.valid.length, 2, '2 ta inline savol to\'liq ajralishi kerak!');
assert.strictEqual(resInline.valid[0].options.length, 4, '1-savolda 4 ta variant bo\'lishi kerak');
assert.strictEqual(resInline.valid[0].correct_index, 0, '#A to\'g\'ri javob');
assert.strictEqual(resInline.valid[1].options.length, 4, '2-savolda 4 ta variant bo\'lishi kerak');
assert.strictEqual(resInline.valid[1].correct_index, 1, '#B to\'g\'ri javob');
console.log('✅ Test 2 PASSED: Bir qatordagi A) B) C) D) variantlari alohida variantlarga to\'g\'ri ajratildi.\n');

// ─── TEST 3: Numbered Questions Without Any Blank Lines or Delimiters ───
console.log('[Test 3] Separatorlarsiz va bo\'sh qatorlarsiz raqamlangan savollar...');
const continuousNumbered = `
1. O'zbekiston Respublikasining maydoni qancha?
#A) 448.9 ming kv km
B) 500 ming kv km
C) 300 ming kv km
D) 600 ming kv km
2. O'zbekiston chegaradosh bo'lgan davlatlar soni nechta?
A) 3 ta
#B) 5 ta
C) 6 ta
D) 4 ta
3. O'zbekiston qaysi dengizga to'g'ridan-to'g'ri chiqish imkoniga ega emas?
A) Kaspiy dengizi
B) Qora dengiz
C) Boltiq dengizi
#D) Jahon okeaniga (Double landlocked)
`;

const resNumbered = parseTextQuestions(continuousNumbered, 'hash');
assert.strictEqual(resNumbered.valid.length, 3, 'Barcha 3 ta raqamlangan savol to\'liq ajralishi kerak!');
assert.strictEqual(resNumbered.valid[0].correct_index, 0);
assert.strictEqual(resNumbered.valid[1].correct_index, 1);
assert.strictEqual(resNumbered.valid[2].correct_index, 3);
console.log('✅ Test 3 PASSED: Bo\'sh qatorsiz ketma-ket kelgan 1. 2. 3. savollari mustaqil ajratildi.\n');

// ─── TEST 4: Performance Benchmark with 1000 Questions ───
console.log('[Test 4] 1000 ta savolda ishlash tezligi (Performance Benchmark)...');
const sampleBlocks = [];
for (let i = 1; i <= 1000; i++) {
  // Har 50-savolda bitta takroriy savol qo'shamiz
  if (i % 50 === 0) {
    sampleBlocks.push(`
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
    `);
  } else {
    sampleBlocks.push(`
++++
Savol ${i}: Bu ${i}-raqamli noyob test savoli hisoblanadi?
====
Javob ${i}-A #
====
Javob ${i}-B
====
Javob ${i}-C
====
Javob ${i}-D
    `);
  }
}
const largeText = sampleBlocks.join('\n');

const startTime = Date.now();
const resLarge = parseTextQuestions(largeText, 'hash');
const duration = Date.now() - startTime;

console.log(`  ⏱️ 1000 ta savolni parse qilish vaqti: ${duration} ms`);
console.log(`  📊 Natija: Valid: ${resLarge.valid.length}, Duplicates: ${resLarge.duplicates.length}, Invalid: ${resLarge.invalid.length}`);
assert.ok(duration < 2000, `1000 ta savol 2 soniyadan kam vaqtda tahlil qilinishi kerak (Haqiqiy: ${duration} ms)`);
assert.strictEqual(resLarge.duplicates.length, 19, '20 ta bir xil savoldan 19 tasi takroriy deb topilishi kerak');
assert.strictEqual(resLarge.valid.length, 981, '981 ta unikal savol qolishi kerak (1000 - 19)');
console.log('✅ Test 4 PASSED: 1000 ta savol sub-sekund tezlikda tahlil qilindi va deduplikatsiya qilindi.\n');

console.log('🎉 BARCHA EKSTREMAL VA BENCHMARK TESTLAR MUVAFFAQIShATLI O\'TDI!');
