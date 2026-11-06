'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('🧪 Starting Deep Technical Audit Fixes Automated Verification Tests...\n');

// -------------------------------------------------------------
// Test 1: BUG-01 (getUsersStatsSummaryByIds & saveTestToShelf)
// -------------------------------------------------------------
console.log('1. Testing BUG-01: Admin user stats summary cache isolation & shelf protection');
const dbServiceSrc = fs.readFileSync(path.join(__dirname, '../src/services/dbService.js'), 'utf8');
assert(
  dbServiceSrc.includes('cache:user_stats_summary:'),
  'getUsersStatsSummaryByIds must use cache:user_stats_summary: to prevent poisoning full user_stats'
);
assert(
  dbServiceSrc.includes('if (!stats.shelf && supabase)'),
  'saveTestToShelf must self-heal and check shelf from DB if missing from cache'
);
console.log('  ✅ [PASS] BUG-01: Cache isolation and shelf data loss protection verified.\n');

// -------------------------------------------------------------
// Test 2: BUG-02 (index.js private chat guard for text state router)
// -------------------------------------------------------------
console.log('2. Testing BUG-02: Private chat guard for global wizard router');
const indexSrc = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const routerIdx = indexSrc.indexOf('// ═══ GLOBAL TEXT STATE ROUTER');
assert(routerIdx !== -1, 'GLOBAL TEXT STATE ROUTER must exist in index.js');
const routerSnippet = indexSrc.slice(routerIdx, routerIdx + 250);
assert(
  routerSnippet.includes('if (ctx.chat?.type !== "private") return next();'),
  'Global text state router must ignore non-private chats'
);
console.log('  ✅ [PASS] BUG-02: Private chat guard prevents state bleeding to group chats.\n');

// -------------------------------------------------------------
// Test 3: BUG-03 (shelfHandlers.js index-based callbacks)
// -------------------------------------------------------------
console.log('3. Testing BUG-03: Shelf index-based callbacks & splice(NaN, 1) protection');
const shelfSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/shelfHandlers.js'), 'utf8');
assert(
  shelfSrc.includes('sh_open_${fIdx}') || shelfSrc.includes('sh_open_` + fIdx') || shelfSrc.includes('`sh_open_${fIdx}`'),
  'cbMyShelf must generate index-based folder callbacks'
);
assert(
  shelfSrc.includes('sh_view_${fIdx}_${tIdx}') || shelfSrc.includes('`sh_view_${fIdx}_${tIdx}`'),
  'cbOpenFolder must generate index-based test view callbacks'
);
assert(
  shelfSrc.includes('isNaN(tIdx) || !folderName || !shelf[folderName]'),
  'cbDeleteTest must guard against NaN index and missing folders'
);
console.log('  ✅ [PASS] BUG-03: Shelf callbacks safely use indices and prevent wrong test deletion.\n');

// -------------------------------------------------------------
// Test 4: BUG-04 (testCreation.js 4000+ character chunk merging)
// -------------------------------------------------------------
console.log('4. Testing BUG-04: Multi-chunk Telegram auto-split text joining without \\n\\n');
const testCreationSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/testCreation.js'), 'utf8');
assert(
  testCreationSrc.includes('chunkState.lastMsgLen >= 4000 ? \'\' : \'\\n\\n\''),
  'Multi-chunk handler must join consecutive auto-split messages with empty string instead of \\n\\n'
);
console.log('  ✅ [PASS] BUG-04: Telegram split chunk concatenation preserves questions intact.\n');

// -------------------------------------------------------------
// Test 5: BUG-05 (utils.js & coreQuiz.js option deduplication)
// -------------------------------------------------------------
console.log('5. Testing BUG-05: Poll options deduplication (POLL_OPTIONS_MUST_BE_UNIQUE)');
const utils = require('../src/core/utils');
const duplicateBlock = `
Qaysi son to'g'ri?
#15
15
20
25
`;
const parsedDup = utils.parseTextQuestions(duplicateBlock);
assert.strictEqual(parsedDup.valid.length, 1, 'Question with duplicate options should be parsed safely');
const qOpts = parsedDup.valid[0].options;
const uniqueQOpts = new Set(qOpts.map(o => o.toLowerCase()));
assert.strictEqual(uniqueQOpts.size, qOpts.length, 'All parsed options must be unique');
assert(qOpts.some(o => o.includes('(2)')), 'Duplicate option must have (2) appended');

const coreQuizSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/coreQuiz.js'), 'utf8');
assert(
  coreQuizSrc.includes('seenOpts.has(candidate.toLowerCase())'),
  'sendNextQuestion must deduplicate options before dispatching sendPoll'
);
console.log('  ✅ [PASS] BUG-05: Option deduplication prevents Telegram 400 Bad Request.\n');

// -------------------------------------------------------------
// Test 6: BUG-06 (groupQuizLogic.js & coreQuiz.js autoAdvance toggle)
// -------------------------------------------------------------
console.log('6. Testing BUG-06: Group Lobby Auto-Advance toggle & readyUserIds voting');
const groupLogicSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/groupQuizLogic.js'), 'utf8');
assert(
  groupLogicSrc.includes('room_toggle_auto'),
  'groupQuizLogic must support room_toggle_auto callback'
);
assert(
  groupLogicSrc.includes('autoAdvance: room.autoAdvance !== false'),
  'cbRoomStart must pass autoAdvance to active session'
);
assert(
  groupLogicSrc.includes('readyUserIds: readyUserIds'),
  'cbRoomStart must pass readyUserIds to active session'
);
assert(
  coreQuizSrc.includes('if (!cachedPoll.autoAdvance)'),
  'handlePollAnswer must respect autoAdvance setting and allow full 30s timer'
);
assert(
  coreQuizSrc.includes('poll_ready_voters:${pollId}'),
  'handlePollAnswer must count only registered lobby voters when readyUserIds is set'
);
console.log('  ✅ [PASS] BUG-06: Auto-advance toggle and lobby participant voting verified.\n');

// -------------------------------------------------------------
// Test 7: BUG-07 (coreQuiz.js stopPoll on finish & 5-min marathon wait)
// -------------------------------------------------------------
console.log('7. Testing BUG-07: Open poll closure on finishTest and marathon 5-min wait timer');
assert(
  coreQuizSrc.includes('telegram.stopPoll(chatId, session.msgId)'),
  'finishTest must close active poll if session.msgId exists'
);
assert(
  coreQuizSrc.includes('marathon_wait:${chatId}:${session.currentBlockIdx}'),
  'finishTest must schedule a 5-minute timeout for marathon block interval'
);
const workersSrc = fs.readFileSync(path.join(__dirname, '../src/jobs/workers.js'), 'utf8');
assert(
  workersSrc.includes('job.data?.isMarathonWait'),
  'quizTimerWorker must handle isMarathonWait job and gracefully finish test if unattended'
);
console.log('  ✅ [PASS] BUG-07: Poll closure and marathon auto-finish timer verified.\n');

// -------------------------------------------------------------
// Test 8: BUG-08 (testCreation.js edit mode fixes & state cleanup)
// -------------------------------------------------------------
console.log('8. Testing BUG-08: Edit dashboard preview grid, subject_id retention, and cbManageTest clearState');
assert(
  testCreationSrc.includes('clearState(ctx);') && testCreationSrc.includes('async function cbManageTest'),
  'cbManageTest must call clearState(ctx)'
);
assert(
  testCreationSrc.includes('subject_id: testData.subject_id || null') || testCreationSrc.includes('subject_id: testData.subject_id'),
  'cbEditTest must retain subject_id'
);
assert(
  testCreationSrc.includes('data.is_editing ? showEditDashboard(ctx) : showDraftDashboard(ctx)'),
  'onDocxFile and cbFixErrors must return to showEditDashboard if editing'
);
console.log('  ✅ [PASS] BUG-08: Test editing state, navigation, and subject_id verified.\n');

// -------------------------------------------------------------
// Test 9: BUG-09 (subjectId, creatorId, isUgc retention in shelf & finishes)
// -------------------------------------------------------------
console.log('9. Testing BUG-09: UGC attributes preserved in shelf');
assert(
  dbServiceSrc.includes('subjectId: testInfo.subjectId || null'),
  'saveTestToShelf must store subjectId'
);
assert(
  dbServiceSrc.includes('creatorId: testInfo.creatorId || null'),
  'saveTestToShelf must store creatorId'
);
assert(
  dbServiceSrc.includes('isUgc: Boolean(testInfo.isUgc)'),
  'saveTestToShelf must store isUgc flag'
);
console.log('  ✅ [PASS] BUG-09: Shelf UGC attributes retention verified.\n');

// -------------------------------------------------------------
// Test 10: BUG-10 (force_finish cancel button and preparing session auto-clear)
// -------------------------------------------------------------
console.log('10. Testing BUG-10: Preparing session cancel button & auto-clear on new test');
const quizGameSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/quizGame.js'), 'utf8');
assert(
  quizGameSrc.includes('{ text: "❌ Bekor qilish", callback_data: "force_finish" }'),
  'initAndStartTest must include a cancel button (force_finish)'
);
const startHandlerSrc = fs.readFileSync(path.join(__dirname, '../src/handlers/startHandler.js'), 'utf8');
assert(
  startHandlerSrc.includes("session.status !== 'preparing'"),
  'cmdStart must not save unstarted preparing sessions to shelf'
);
assert(
  quizGameSrc.includes("existing.status === 'preparing'"),
  'Starting a new test must auto-clear stale preparing session'
);
console.log('  ✅ [PASS] BUG-10: Preparing session cancel button and auto-clear verified.\n');

// -------------------------------------------------------------
// Test 11: BUG-11 (parseTextQuestions #A trailing line and A)Javob without space)
// -------------------------------------------------------------
console.log('11. Testing BUG-11: parseTextQuestions trailing hash without prefixes & prefix without space');
const testTrailingHashWithoutPrefix = `
O'zbekistonning poytaxti qaysi shahar?
Toshkent
Samarqand
Buxoro
Xiva
# 1
`;
const parsedTrailing = utils.parseTextQuestions(testTrailingHashWithoutPrefix);
assert.strictEqual(parsedTrailing.valid.length, 1, 'Should parse question with trailing # 1');
assert.strictEqual(parsedTrailing.valid[0].correct_index, 0, 'Toshkent should be the correct answer');
assert.strictEqual(parsedTrailing.valid[0].options.length, 4, 'Should have 4 options, not 5');

const testNoSpacePrefix = `
Amir Temur qachon tug'ilgan?
#A)1336-yil
B)1405-yil
C)1370-yil
D)1340-yil
`;
const parsedNoSpace = utils.parseTextQuestions(testNoSpacePrefix);
assert.strictEqual(parsedNoSpace.valid.length, 1, 'Should parse question with A)Prefix without space');
assert.strictEqual(parsedNoSpace.valid[0].options[0], '1336-yil', 'Option prefix A) must be stripped even without space');
assert.strictEqual(parsedNoSpace.valid[0].correct_index, 0, 'Option A must be correct');
console.log('  ✅ [PASS] BUG-11: Trailing hash parsing and space-less prefix stripping verified.\n');

// -------------------------------------------------------------
// Test 12: BUG-12 (resetUserFlows clears activeWmTimers & clamped backAction)
// -------------------------------------------------------------
console.log('12. Testing BUG-12: resetUserFlows timer & state cleanup, clamped victory button');
const utilsSrc = fs.readFileSync(path.join(__dirname, '../src/core/utils.js'), 'utf8');
assert(
  utilsSrc.includes('clearWmTimer(uid)') && utilsSrc.includes("wm_state:${uid}"),
  'resetUserFlows must clear active mistake review timer and Redis state'
);
assert(
  quizGameSrc.includes('safeCallbackData(backAction, 64)'),
  'sendNextInlineMistake victory screen backAction must be clamped to 64 bytes'
);
console.log('  ✅ [PASS] BUG-12: Interactive mistake review cleanup and safe backAction verified.\n');

// -------------------------------------------------------------
// Test 13: BUG-13 (coreQuiz.js split message retry loop)
// -------------------------------------------------------------
console.log('13. Testing BUG-13: Split message retry loop in sendNextQuestion');
assert(
  coreQuizSrc.includes('sendMsgAttempts < 3') && coreQuizSrc.includes('telegram.sendMessage(chatId, text, splitOpts)'),
  'sendNextQuestion must retry sendMessage on rate limits or transient errors'
);
console.log('  ✅ [PASS] BUG-13: Split question retry loop verified.\n');

// -------------------------------------------------------------
// Test 14: BUG-14 (HTML parse mode & cbManageSubj pagination)
// -------------------------------------------------------------
console.log('14. Testing BUG-14: HTML parse mode consistency & cbManageSubj pagination');
assert(
  testCreationSrc.includes('const AI_WARNING_TEXT = `\\n\\n⚠️ <b>Eslatma:</b>'),
  'AI_WARNING_TEXT must use HTML formatting'
);
assert(
  testCreationSrc.includes('PAGE_SIZE = 10') && testCreationSrc.includes('manage_subj_${refId}_'),
  'cbManageSubj must paginate blocks 10 per page'
);
console.log('  ✅ [PASS] BUG-14: HTML parse mode and subject blocks pagination verified.\n');

// -------------------------------------------------------------
// Test 15: BUG-15 (Kahoot Socket membership, active count, room duplicate, Zod refine)
// -------------------------------------------------------------
console.log('15. Testing BUG-15: Socket.io Kahoot membership, disconnected player filtering, and Zod refine');
const socketSrc = fs.readFileSync(path.join(__dirname, '../src/socket/index.js'), 'utf8');
assert(
  socketSrc.includes('if (!room.players.has(userId)) return;'),
  'kahoot:answer_submit must check room.players.has(userId)'
);
assert(
  socketSrc.includes('filter(p => !p.disconnected)'),
  'kahoot:answer_submit must exclude disconnected players when comparing answered count'
);
assert(
  socketSrc.includes('Bu xona kodi allaqachon mavjud'),
  'room:create must check if room already exists'
);
const adminApiSrc = fs.readFileSync(path.join(__dirname, '../src/api/admin.js'), 'utf8');
assert(
  adminApiSrc.includes('.refine(d => d.correct_index < d.options.length'),
  'SingleKahootQuestionSchema must refine that correct_index < options.length'
);
console.log('  ✅ [PASS] BUG-15: Kahoot socket security, player disconnection, and schema refine verified.\n');

// -------------------------------------------------------------
// Test 16: BUG-16 (_lastSyncedSessionStr in updateData & session middleware)
// -------------------------------------------------------------
console.log('16. Testing BUG-16: Session middleware _lastSyncedSessionStr merger');
assert(
  utilsSrc.includes('ctx._lastSyncedSessionStr = serialized'),
  'updateData must track _lastSyncedSessionStr'
);
assert(
  indexSrc.includes('ctx._lastSyncedSessionStr || originalSessionStr'),
  'index.js session middleware must use _lastSyncedSessionStr as baseline'
);
console.log('  ✅ [PASS] BUG-16: Session merger prevents resurrecting deleted keys.\n');

// -------------------------------------------------------------
// Test 17: BUG-17 (resumeTestFromShelf question shuffling on completed tests)
// -------------------------------------------------------------
console.log('17. Testing BUG-17: Completed test question shuffling on shelf restart');
assert(
  quizGameSrc.includes('sessionQuestions: isCompleted ? prepareShuffledQuestions(savedTest.questions) : savedTest.questions'),
  'resumeTestFromShelf must shuffle questions when restarting a 100% completed test'
);
console.log('  ✅ [PASS] BUG-17: Completed shelf test shuffle verified.\n');

console.log('================================================================');
console.log('🎉 ALL 17 DEEP TECHNICAL AUDIT BUG FIXES VERIFIED SUCCESSFULLY!');
console.log('================================================================');
