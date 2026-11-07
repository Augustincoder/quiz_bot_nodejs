'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const files = [
  'index.js',
  'src/config/config.js',
  'src/lib/postgres.js',
  'src/core/logger.js',
  'src/core/utils.js',
  'src/core/mutex.js',
  'src/core/rateLimiter.js',
  'src/core/storage.js',
  'src/core/pendingStore.js',
  'src/core/questionUtils.js',
  'src/core/loader.js',
  'src/core/bot.js',
  'src/validators/testValidators.js',
  'src/keyboards/keyboards.js',
  'src/services/dbService.js',
  'src/services/sessionService.js',
  'src/services/redisService.js',
  'src/services/shareService.js',
  'src/services/aiService.js',
  'src/services/edupageService.js',
  'src/services/scheduleService.js',
  'src/services/scheduleWatcherService.js',
  'src/services/timetableCdnService.js',
  'src/services/watchdogService.js',
  'src/services/imageService.js',
  'src/handlers/startHandler.js',
  'src/handlers/quizGame.js',
  'src/handlers/coreQuiz.js',
  'src/handlers/groupQuizLogic.js',
  'src/handlers/testCreation.js',
  'src/handlers/adaptiveQuiz.js',
  'src/handlers/aiHandlers.js',
  'src/handlers/aiTestsHandlers.js',
  'src/handlers/noteHandler.js',
  'src/handlers/profileHandler.js',
  'src/handlers/scheduleHandler.js',
  'src/handlers/shelfHandlers.js',
  'src/handlers/statsHandlers.js',
  'src/handlers/adminHandlers.js',
  'src/handlers/contactAdmin.js',
  'src/jobs/queues.js',
  'src/jobs/workers.js',
  'src/api/admin.js',
  'src/socket/index.js',
  'src/socket/auth.js',
  'src/socket/gameLoop.js',
  'src/socket/roomManager.js',
];

const timestamp = new Date().toISOString();
let output = `================================================================================
PROJECT SYSTEM SOURCE CODE CONSOLIDATION
Project: quiz_bot_nodejs
Total Files: ${files.length}
Generated: ${timestamp}
================================================================================

TABLE OF CONTENTS:
`;

files.forEach((file, idx) => {
  output += `${String(idx + 1).padStart(2, ' ')}. ${file}\n`;
});

output += `\n================================================================================\n\n`;

files.forEach((file, idx) => {
  const fullPath = path.join(ROOT, file);
  if (!fs.existsSync(fullPath)) {
    console.error(`Missing file: ${file}`);
    return;
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const lines = content.split('\n').length;
  const sizeKb = (Buffer.byteLength(content, 'utf8') / 1024).toFixed(1);

  output += `\n// ============================================================================
// [${idx + 1}/${files.length}] FILE: ${file}
// LINES: ${lines} | SIZE: ${sizeKb} KB
// ============================================================================

${content}
`;
});

const outPath = path.join(ROOT, 'ALL_SYSTEM_CODE.txt');
const prodPath = path.join(ROOT, 'ALL_PRODUCTION_CODE.txt');
fs.writeFileSync(outPath, output, 'utf8');
fs.writeFileSync(prodPath, output, 'utf8');
console.log(`✅ Successfully consolidated ${files.length} files into ALL_SYSTEM_CODE.txt and ALL_PRODUCTION_CODE.txt (${(Buffer.byteLength(output, 'utf8') / 1024 / 1024).toFixed(2)} MB)`);
