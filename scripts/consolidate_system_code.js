'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const sections = [
  {
    title: '1. Dastur Asosiy Kirish Nuqtasi (Application Entry Point)',
    files: [
      'package.json',
      'index.js',
    ],
  },
  {
    title: '2. Konfiguratsiya va Tizim Magzi (Core Infrastructure & Engine)',
    files: [
      'src/config/config.js',
      'src/lib/postgres.js',
      'src/core/bot.js',
      'src/core/circuitBreaker.js',
      'src/core/loader.js',
      'src/core/logger.js',
      'src/core/mutex.js',
      'src/core/pendingStore.js',
      'src/core/questionUtils.js',
      'src/core/rateLimiter.js',
      'src/core/storage.js',
      'src/core/utils.js',
    ],
  },
  {
    title: '3. Klaviaturasi va Validatorlar (Keyboards & Validators)',
    files: [
      'src/validators/testValidators.js',
      'src/keyboards/keyboards.js',
    ],
  },
  {
    title: '4. Biznes Mantiq Servislari (Core Services & Business Logic)',
    files: [
      'src/services/aiDocxHealer.js',
      'src/services/aiService.js',
      'src/services/dbService.js',
      'src/services/edupageService.js',
      'src/services/errorReporterService.js',
      'src/services/featureFlagService.js',
      'src/services/imageService.js',
      'src/services/redisService.js',
      'src/services/scheduleService.js',
      'src/services/scheduleWatcherService.js',
      'src/services/sessionService.js',
      'src/services/shareService.js',
      'src/services/timetableCdnService.js',
      'src/services/watchdogService.js',
      'src/services/widgetService.js',
    ],
  },
  {
    title: '5. Telegram Bot Handlerlari (Bot Handlers & Controllers)',
    files: [
      'src/handlers/startHandler.js',
      'src/handlers/quizGame.js',
      'src/handlers/coreQuiz.js',
      'src/handlers/cramReviewHandler.js',
      'src/handlers/donateHandler.js',
      'src/handlers/featureFlagAdminHandler.js',
      'src/handlers/groupQuizLogic.js',
      'src/handlers/testCreation.js',
      'src/handlers/universalTestHub.js',
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
    ],
  },
  {
    title: '6. Navbatlar va Orqa Fon Ishchilari (Queues & Workers)',
    files: [
      'src/jobs/queues.js',
      'src/jobs/workers.js',
    ],
  },
  {
    title: '7. REST API va Multiplayer Real-Time Soketlar (API & Socket Server)',
    files: [
      'src/api/admin.js',
      'src/socket/index.js',
      'src/socket/auth.js',
      'src/socket/gameLoop.js',
      'src/socket/roomManager.js',
    ],
  },
  {
    title: '8. Interaktiv Telegram WebApp Vidjetlari (Widget Server & Views)',
    files: [
      'src/widgets/widgetServer.js',
      'src/widgets/views/docxHealerWidget.html',
      'src/widgets/views/flashcardWidget.html',
      'src/widgets/views/podiumWidget.html',
    ],
  },
];

// Flatten file metadata
const fileList = [];
let globalIndex = 1;

for (const sec of sections) {
  for (const relPath of sec.files) {
    const fullPath = path.join(ROOT, relPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`❌ Missing runtime file: ${relPath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const lines = content.split('\n').length;
    const sizeBytes = Buffer.byteLength(content, 'utf8');
    const sizeKb = (sizeBytes / 1024).toFixed(1);

    fileList.push({
      index: globalIndex++,
      section: sec.title,
      relPath,
      content,
      lines,
      sizeBytes,
      sizeKb,
    });
  }
}

const totalFiles = fileList.length;
const totalLines = fileList.reduce((sum, f) => sum + f.lines, 0);
const totalBytes = fileList.reduce((sum, f) => sum + f.sizeBytes, 0);
const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);
const isoTimestamp = new Date().toISOString();

let header = `================================================================================
ASOSIY ISHCHI PRODUCTION DASTUR KODI (PURE RUNTIME CODEBASE)
Loyiha: quiz_bot_nodejs (Talabalar Imtihon Trenajyori — Node.js)
Jami Ishchi Kod Fayllari: ${totalFiles} ta
Jami Kod Qatorlari: ${totalLines.toLocaleString('uz-UZ')} qator
Hajmi: ${totalMb} MB (${totalBytes.toLocaleString('uz-UZ')} bayt)
Yaratilgan vaqt: ${isoTimestamp}
Qamrov: FAQAT dasturning real ishlashida qatnashadigan asosiy runtime kodlar
        (Asosiy kirish, Engine, Validatsiya, Servislar, Handlerlar, Navbatlar, Soketlar, WebApp Vidjetlar)
Chetlashtirilgan: Testlar (test_*.js), statik json (groups.json), sql migratsiyalar, docker/git configlar, loglar
================================================================================

MUNDARIJA (TABLE OF CONTENTS):
`;

for (const sec of sections) {
  header += `\n--- [ ${sec.title} ] ---\n`;
  const secFiles = fileList.filter(f => f.section === sec.title);
  for (const f of secFiles) {
    const num = String(f.index).padStart(2, ' ');
    const padPath = f.relPath.padEnd(48, ' ');
    const padLines = `${String(f.lines).padStart(6, ' ')} qator`;
    const padKb = `${String(f.sizeKb).padStart(8, ' ')} KB`;
    header += `${num}. ${padPath} | ${padLines} | ${padKb}\n`;
  }
}

header += `\n================================================================================\n\n`;

let body = '';
for (const f of fileList) {
  body += `\n// ============================================================================
// [${f.index}/${totalFiles}] FAYL: ${f.relPath}
// BO'LIM: ${f.section}
// QATORLAR: ${f.lines} | HAJMI: ${f.sizeKb} KB
// ============================================================================

${f.content}
`;
}

const finalContent = header + body;

const outSystem = path.join(ROOT, 'ALL_SYSTEM_CODE.txt');
const outProd = path.join(ROOT, 'ALL_PRODUCTION_CODE.txt');

fs.writeFileSync(outSystem, finalContent, 'utf8');
fs.writeFileSync(outProd, finalContent, 'utf8');

console.log(`🎉 ALL_SYSTEM_CODE.txt va ALL_PRODUCTION_CODE.txt muvaffaqiyatli sinxronlashtirildi!`);
console.log(`📊 Jami fayllar: ${totalFiles} ta`);
console.log(`📝 Jami qatorlar: ${totalLines.toLocaleString('uz-UZ')} qator`);
console.log(`💾 Hajmi: ${totalMb} MB (${totalBytes.toLocaleString('uz-UZ')} bayt)`);
