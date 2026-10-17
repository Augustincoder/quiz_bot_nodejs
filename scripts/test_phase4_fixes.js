'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_TOKEN_XYZ';

console.log('🧪 Testing Phase 4 Fixes (ARCH-01 through ARCH-04)...\n');

let passedCount = 0;
function pass(testName) {
  passedCount++;
  console.log(`✅ [PASS] ${testName}`);
}

async function runTests() {
  // --- ARCH-01: Dead socket files removed ---
  console.log('--- Test 1: ARCH-01 Dead socket files removed ---');
  const deadFiles = [
    'src/socket/gameLogic.js',
    'src/socket/judger.js',
    'src/socket/questions.js'
  ];
  for (const f of deadFiles) {
    const fullPath = path.join(__dirname, '..', f);
    assert.strictEqual(fs.existsSync(fullPath), false, `Dead file ${f} should no longer exist!`);
  }
  pass('ARCH-01: Unused dead files (gameLogic, judger, questions) safely removed');

  // --- ARCH-02: Reply callback regex in adminHandlers ---
  console.log('\n--- Test 2: ARCH-02 Callback regex collision check ---');
  const adminHandlersSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/adminHandlers.js'), 'utf8');
  // Match the bot.action regex for reply
  const replyActionMatch = adminHandlersSrc.match(/bot\.action\((.*?reply.*?),\s*adminGuard\(cbReplyStart\)\)/);
  assert(replyActionMatch, 'Could not find cbReplyStart action registration in adminHandlers.js');
  const regexStr = replyActionMatch[1].trim();
  assert(regexStr.includes('$'), `Regex ${regexStr} must include end anchor $ to prevent shadowing contactAdmin`);

  // Evaluate regex behavior
  const regex = /^\/reply_\\d+\/$/.test(regexStr) ? /reply_\d+$/ : eval(regexStr);
  assert.strictEqual(regex.test('reply_12345'), true, 'reply_12345 should match cbReplyStart');
  assert.strictEqual(regex.test('reply_12345_67890'), false, 'reply_12345_67890 must NOT match cbReplyStart (reserved for contactAdmin)');
  pass('ARCH-02: adminHandlers regex anchored with $; prevents hijacking contactAdmin callbacks');

  // --- ARCH-03: Supabase client consolidation ---
  console.log('\n--- Test 3: ARCH-03 Supabase client consolidation ---');
  const dbServiceSrc = fs.readFileSync(path.join(__dirname, '../src/services/dbService.js'), 'utf8');
  assert(!dbServiceSrc.includes("require('@supabase/supabase-js')"), 'dbService.js should not directly import @supabase/supabase-js');
  assert(dbServiceSrc.includes("require('../lib/supabase')"), 'dbService.js must import { supabase } from ../lib/supabase');
  
  const dbService = require('../src/services/dbService');
  assert(typeof dbService === 'object' && dbService !== null, 'dbService module loaded successfully');
  pass('ARCH-03: dbService.js imports unified Supabase client from src/lib/supabase');

  // --- ARCH-04: scheduleHandler export & ESLint configuration ---
  console.log('\n--- Test 4: ARCH-04 Duplicate export and ESLint config check ---');
  const scheduleHandler = require('../src/handlers/scheduleHandler');
  const scheduleSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/scheduleHandler.js'), 'utf8');
  
  // Count occurrences of buildRoomPageKb in module.exports block
  const exportsBlock = scheduleSrc.substring(scheduleSrc.indexOf('module.exports = {'));
  const exportMatches = exportsBlock.match(/buildRoomPageKb/g);
  assert.strictEqual(exportMatches ? exportMatches.length : 0, 1, 'buildRoomPageKb should only be exported once');

  assert.strictEqual(fs.existsSync(path.join(__dirname, '../.eslintrc.js')), false, 'Legacy .eslintrc.js should be removed');
  assert.strictEqual(fs.existsSync(path.join(__dirname, '../eslint.config.js')), true, 'Active eslint.config.js should exist');
  pass('ARCH-04: Duplicate export removed and ESLint configuration standardized to eslint.config.js');

  console.log(`\n🎉 All Phase 4 tests passed! (${passedCount}/4)`);
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('\n❌ Phase 4 Test failed:', err);
  process.exit(1);
});
