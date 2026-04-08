'use strict';

const fs   = require('fs');
const path = require('path');
const { DATA_DIR, SUBJECTS } = require('./config');

function initStorage() {
  const memoryDb = {};
  let totalLoaded = 0;

  for (const subjectKey of Object.keys(SUBJECTS)) {
    memoryDb[subjectKey] = {};
    const subjectDir = path.join(DATA_DIR, subjectKey);

    if (!fs.existsSync(subjectDir)) continue;

    for (const filename of fs.readdirSync(subjectDir)) {
      if (!filename.startsWith('test_') || !filename.endsWith('.json')) continue;
      const filepath = path.join(subjectDir, filename);
      try {
        const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
        const testId = data.test_id ?? parseInt(filename.split('_')[1], 10);
        if (!data.range) {
          data.range = `1-${(data.questions || []).length}`;
        }
        memoryDb[subjectKey][testId] = data;
        totalLoaded++;
      } catch (e) {
        console.error(`Xato: ${filepath} o'qilmadi. Sabab: ${e.message}`);
      }
    }
  }

  console.log(`Muvaffaqiyatli! ${Object.keys(SUBJECTS).length} ta fandan ${totalLoaded} ta blok yuklandi.`);
  return memoryDb;
}

module.exports = { initStorage };