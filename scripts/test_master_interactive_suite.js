'use strict';
const { execSync } = require('child_process');

console.log('🚀 Running Complete Master Test Suite for Telegram 10.4 Interactive Features...\n');

const testScripts = [
  'scripts/test_widget_engine.js',
  'scripts/test_podium_and_ghost_coach.js',
  'scripts/test_blitz_flashcard.js',
  'scripts/test_flashcard_correct_answers.js',
  'scripts/test_smart_docx_healer.js',
  'scripts/test_universal_test_hub.js',
  'scripts/test_prod_bug_fixes.js',
  'scripts/test_widget_and_flashcard_fixes.js',
  'scripts/test_deeplink_and_flashcard_fixes.js',
];

let totalPassed = 0;

for (const script of testScripts) {
  console.log(`\n======================================================`);
  console.log(`▶️ EXECUTING: node ${script}`);
  console.log(`======================================================\n`);
  try {
    execSync(`node ${script}`, { stdio: 'inherit' });
    totalPassed++;
    console.log(`\n✅ SUITE PASSED: ${script}`);
  } catch (err) {
    console.error(`\n❌ SUITE FAILED: ${script}`);
    process.exit(1);
  }
}

console.log(`\n======================================================`);
console.log(`🎉 ALL ${totalPassed}/${testScripts.length} INTERACTIVE SUITES COMPLETED WITH ZERO ERRORS! 🚀`);
console.log(`======================================================\n`);
