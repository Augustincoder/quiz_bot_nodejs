'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test_token';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test_key';

const { performance } = require('perf_hooks');
const path = require('path');
const fs = require('fs');

function runFsMethod(iterations) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const rawGroups = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/data/groups.json'), 'utf8'));
    const valid = rawGroups.filter(g => {
      if (!g) return false;
      const cleanG = g.trim().toUpperCase();
      return cleanG !== '-' &&
             cleanG !== '--' &&
             cleanG !== '(RUS)' &&
             !cleanG.includes('FAKULTET') &&
             !cleanG.includes('KURS');
    });
  }
  const t1 = performance.now();
  return t1 - t0;
}

function runRequireMethod(iterations) {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    delete require.cache[require.resolve('../src/data/groups.json')];
    const rawGroups = require('../src/data/groups.json');
    const valid = rawGroups.filter(g => {
      if (!g) return false;
      const cleanG = g.trim().toUpperCase();
      return cleanG !== '-' &&
             cleanG !== '--' &&
             cleanG !== '(RUS)' &&
             !cleanG.includes('FAKULTET') &&
             !cleanG.includes('KURS');
    });
  }
  const t1 = performance.now();
  return t1 - t0;
}

function runCachedRequireMethod(iterations) {
  // Pre-load into require cache
  require('../src/data/groups.json');
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) {
    const rawGroups = require('../src/data/groups.json');
    const valid = rawGroups.filter(g => {
      if (!g) return false;
      const cleanG = g.trim().toUpperCase();
      return cleanG !== '-' &&
             cleanG !== '--' &&
             cleanG !== '(RUS)' &&
             !cleanG.includes('FAKULTET') &&
             !cleanG.includes('KURS');
    });
  }
  const t1 = performance.now();
  return t1 - t0;
}

console.log('📊 Benchmarking Group JSON Loading Strategies (1,000 iterations)...');
const fsTime = runFsMethod(1000);
console.log(`1️⃣ Synchronous fs.readFileSync + JSON.parse: ${fsTime.toFixed(3)} ms`);

const requireTime = runRequireMethod(1000);
console.log(`2️⃣ Uncached require('../data/groups.json'):      ${requireTime.toFixed(3)} ms`);

const cachedRequireTime = runCachedRequireMethod(1000);
console.log(`3️⃣ Cached require('../data/groups.json'):        ${cachedRequireTime.toFixed(3)} ms`);
