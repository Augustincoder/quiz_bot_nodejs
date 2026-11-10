'use strict';
const { execSync } = require('child_process');

console.log('🚀 Running Complete Master Test Suite for Smart Feature Flag Governance...\n');

const testScripts = [
  'scripts/test_feature_flags_core.js',
  'scripts/test_feature_flags_circuit_breaker.js',
  'scripts/test_feature_flags_admin_handler.js',
  'scripts/test_feature_flags_integration.js',
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
console.log(`🎉 ALL ${totalPassed}/${testScripts.length} FEATURE FLAG SUITES COMPLETED WITH ZERO ERRORS! 🚀`);
console.log(`======================================================\n`);
