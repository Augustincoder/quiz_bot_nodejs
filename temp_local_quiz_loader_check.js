const path = require('path');
const fs = require('fs');
const { DATA_DIR, SUBJECTS } = require('./src/config/config');
for (const subj of Object.keys(SUBJECTS)) {
  let subjDir = path.join(DATA_DIR, subj);
  if (!fs.existsSync(subjDir) || !fs.readdirSync(subjDir).some((f) => f.endsWith('.json'))) {
    const altDir = path.join(__dirname, 'src', 'data', subj);
    if (fs.existsSync(altDir)) subjDir = altDir;
  }
  if (!fs.existsSync(subjDir)) {
    console.log(subj, 'missing');
    continue;
  }
  const files = fs.readdirSync(subjDir).filter((f) => f.endsWith('.json'));
  console.log(subj, subjDir, files.length);
  for (const file of files.slice(0, 1)) {
    const rawData = JSON.parse(fs.readFileSync(path.join(subjDir, file), 'utf8'));
    const questions = Array.isArray(rawData) ? rawData : rawData.questions;
    const blockName = rawData.block_name || `Blok ${rawData.test_id || file.match(/^test_(\d+)\.json$/)[1]}`;
    console.log(file, Array.isArray(questions) ? questions.length : typeof questions, blockName);
  }
}
