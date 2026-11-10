'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_BOT_TOKEN_FOR_FLAGS_INTEGRATION';

const assert = require('assert');
const featureFlagService = require('../src/services/featureFlagService');
const { STATES } = featureFlagService;

const { getBlocksKeyboard, setMemoryDb } = require('../src/keyboards/keyboards');
const coreQuiz = require('../src/handlers/coreQuiz');
const testCreation = require('../src/handlers/testCreation');
const widgetService = require('../src/services/widgetService');
const sessionService = require('../src/services/sessionService');

async function runTests() {
  console.log('🧪 Starting Feature Flags Integration & Route Protection Suite...\n');

  const ADMIN_ID = 999001;
  const NORMAL_USER_ID = 111002;

  // Configure admin list
  featureFlagService.setAdminList([ADMIN_ID]);
  assert(featureFlagService.isAdmin(ADMIN_ID), 'Admin ID must be recognized as admin');
  assert(!featureFlagService.isAdmin(NORMAL_USER_ID), 'Normal user must not be admin');

  // Reset all 4 flags to ADMIN_ONLY (Dogfooding state)
  await featureFlagService.setFeatureState('FEATURE_BLITZ_FLASHCARD', STATES.ADMIN_ONLY);
  await featureFlagService.setFeatureState('FEATURE_TOP3_PODIUM', STATES.ADMIN_ONLY);
  await featureFlagService.setFeatureState('FEATURE_DOCX_SMART_HEALER', STATES.ADMIN_ONLY);
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', STATES.ADMIN_ONLY);

  console.log('--- Initial States Verified: All 4 features are ADMIN_ONLY ---');

  // =========================================================================
  // 1. FEATURE_BLITZ_FLASHCARD in getBlocksKeyboard
  // =========================================================================
  console.log('\n[Test 1] FEATURE_BLITZ_FLASHCARD in getBlocksKeyboard...');
  const fakeDb = {
    biologiya: {
      1: { questions: [{ question: 'Q1', options: ['A', 'B'], answer: 'A' }] },
      2: { questions: [{ question: 'Q2', options: ['A', 'B'], answer: 'B' }] },
    },
  };
  setMemoryDb(fakeDb);

  // 1A: ADMIN sees Flashcard button in ADMIN_ONLY state
  const adminKb = getBlocksKeyboard('biologiya', 0, ADMIN_ID);
  const adminButtons = (adminKb.reply_markup || adminKb).inline_keyboard.flat();
  const adminHasFlashcard = adminButtons.some(b => b.callback_data === 'cram_start_biologiya_1');
  assert(adminHasFlashcard, 'Admin MUST see Flashcard button when ADMIN_ONLY');

  // 1B: NORMAL USER does NOT see Flashcard button in ADMIN_ONLY state
  const normalKb = getBlocksKeyboard('biologiya', 0, NORMAL_USER_ID);
  const normalButtons = (normalKb.reply_markup || normalKb).inline_keyboard.flat();
  const normalHasFlashcard = normalButtons.some(b => b.callback_data === 'cram_start_biologiya_1');
  assert(!normalHasFlashcard, 'Normal user MUST NOT see Flashcard button when ADMIN_ONLY');

  // 1C: Set to PUBLIC -> Normal user immediately sees Flashcard button
  await featureFlagService.setFeatureState('FEATURE_BLITZ_FLASHCARD', STATES.PUBLIC);
  const normalKbPublic = getBlocksKeyboard('biologiya', 0, NORMAL_USER_ID);
  const normalButtonsPublic = (normalKbPublic.reply_markup || normalKbPublic).inline_keyboard.flat();
  assert(
    normalButtonsPublic.some(b => b.callback_data === 'cram_start_biologiya_1'),
    'Normal user MUST see Flashcard button when PUBLIC'
  );

  // 1D: Set to OFF -> Even admin does NOT see Flashcard button
  await featureFlagService.setFeatureState('FEATURE_BLITZ_FLASHCARD', STATES.OFF);
  const adminKbOff = getBlocksKeyboard('biologiya', 0, ADMIN_ID);
  const adminButtonsOff = (adminKbOff.reply_markup || adminKbOff).inline_keyboard.flat();
  assert(
    !adminButtonsOff.some(b => b.callback_data === 'cram_start_biologiya_1'),
    'Admin MUST NOT see Flashcard button when OFF'
  );

  console.log('✅ [Test 1 Passed] FEATURE_BLITZ_FLASHCARD properly guarded across all states.');

  // =========================================================================
  // 2. FEATURE_TOP3_PODIUM in coreQuiz.finishTest
  // =========================================================================
  console.log('\n[Test 2] FEATURE_TOP3_PODIUM in coreQuiz.finishTest...');
  await featureFlagService.setFeatureState('FEATURE_TOP3_PODIUM', STATES.ADMIN_ONLY);

  const sampleScores = {
    u1: { userId: 'u1', name: 'Alisher', correct: 10, wrong: 0, totalTimeMs: 12000 },
    u2: { userId: 'u2', name: 'Barno', correct: 8, wrong: 2, totalTimeMs: 10000 },
    u3: { userId: 'u3', name: 'Charos', correct: 8, wrong: 2, totalTimeMs: 15000 },
    u4: { userId: 'u4', name: 'Dilshod', correct: 6, wrong: 4, totalTimeMs: 14000 },
    u5: { userId: 'u5', name: 'Eldor', correct: 4, wrong: 6, totalTimeMs: 9000 },
  };

  // 2A: Group test initiated by ADMIN -> Shows Top-3 Podium & Ephemeral Button
  let sentAdminMsg = null;
  const mockTelegramAdmin = {
    stopPoll: async () => {},
    getMe: async () => ({ username: 'TestQuizBot' }),
    sendMessage: async (chatId, text, opts) => {
      sentAdminMsg = { chatId, text, opts };
      return { message_id: 101 };
    },
  };

  const adminChatId = -10099901;
  await sessionService.setActiveTest(adminChatId, {
    chatType: 'group',
    initiatorId: ADMIN_ID,
    testId: 1,
    subjectKey: 'biologiya',
    blockName: '1-Blok',
    sessionQuestions: [{}, {}],
    groupScores: { ...sampleScores },
    startTime: Date.now() - 30000,
  });

  await coreQuiz.finishTest(adminChatId, mockTelegramAdmin);
  assert(sentAdminMsg, 'finishTest must send message');
  assert(sentAdminMsg.text.includes('🥇 <b>Alisher</b>'), 'Admin podium must include gold medal Alisher');
  assert(sentAdminMsg.text.includes('🥈 <b>Barno</b>'), 'Admin podium must include silver medal Barno');
  assert(sentAdminMsg.text.includes('🥉 <b>Charos</b>'), 'Admin podium must include bronze medal Charos');
  assert(!sentAdminMsg.text.includes('Dilshod'), 'Admin podium must hide 4th participant Dilshod');
  assert(
    sentAdminMsg.text.includes("Qolgan ishtirokchilar o'z natijasini quyidagi tugma orqali ko'rishi mumkin"),
    'Admin podium must contain remaining participants hint'
  );
  const adminFinishButtons = sentAdminMsg.opts.reply_markup.inline_keyboard.flat();
  assert(
    adminFinishButtons.some(b => b.callback_data === 'my_group_quiz_result'),
    'Admin podium MUST contain ephemeral result button (my_group_quiz_result)'
  );

  // 2B: Group test initiated by NORMAL USER -> Standard group results (no podium, no ephemeral button)
  let sentNormalMsg = null;
  const mockTelegramNormal = {
    stopPoll: async () => {},
    getMe: async () => ({ username: 'TestQuizBot' }),
    sendMessage: async (chatId, text, opts) => {
      sentNormalMsg = { chatId, text, opts };
      return { message_id: 102 };
    },
  };

  const normalChatId = -10099902;
  await sessionService.setActiveTest(normalChatId, {
    chatType: 'group',
    initiatorId: NORMAL_USER_ID,
    testId: 1,
    subjectKey: 'biologiya',
    blockName: '1-Blok',
    sessionQuestions: [{}, {}],
    groupScores: { ...sampleScores },
    startTime: Date.now() - 30000,
  });

  await coreQuiz.finishTest(normalChatId, mockTelegramNormal);
  assert(sentNormalMsg, 'finishTest must send message');
  // In standard results, 4th participant Dilshod IS shown in the full list
  assert(sentNormalMsg.text.includes('Dilshod'), 'Standard results MUST show 4th participant Dilshod');
  assert(
    !sentNormalMsg.text.includes("Qolgan ishtirokchilar o'z natijasini"),
    'Standard results must NOT include podium remaining participants hint'
  );
  const normalFinishButtons = sentNormalMsg.opts.reply_markup.inline_keyboard.flat();
  assert(
    !normalFinishButtons.some(b => b.callback_data === 'my_group_quiz_result'),
    'Standard results MUST NOT contain ephemeral result button (my_group_quiz_result)'
  );

  // 2C: Set FEATURE_TOP3_PODIUM to PUBLIC -> Normal user sees podium
  await featureFlagService.setFeatureState('FEATURE_TOP3_PODIUM', STATES.PUBLIC);
  let sentNormalMsgPublic = null;
  const mockTelegramNormalPublic = {
    stopPoll: async () => {},
    getMe: async () => ({ username: 'TestQuizBot' }),
    sendMessage: async (chatId, text, opts) => {
      sentNormalMsgPublic = { chatId, text, opts };
      return { message_id: 103 };
    },
  };
  const normalChatId2 = -10099903;
  await sessionService.setActiveTest(normalChatId2, {
    chatType: 'group',
    initiatorId: NORMAL_USER_ID,
    testId: 1,
    subjectKey: 'biologiya',
    blockName: '1-Blok',
    sessionQuestions: [{}, {}],
    groupScores: { ...sampleScores },
    startTime: Date.now() - 30000,
  });
  await coreQuiz.finishTest(normalChatId2, mockTelegramNormalPublic);
  assert(sentNormalMsgPublic.text.includes('🥇 <b>Alisher</b>'), 'Public podium must show gold medal');
  assert(!sentNormalMsgPublic.text.includes('Dilshod'), 'Public podium must hide 4th user');
  const normalFinishButtonsPublic = sentNormalMsgPublic.opts.reply_markup.inline_keyboard.flat();
  assert(
    normalFinishButtonsPublic.some(b => b.callback_data === 'my_group_quiz_result'),
    'Public podium must contain ephemeral button for normal users'
  );

  // 2D: Set FEATURE_TOP3_PODIUM to OFF -> Even admin sees standard results
  await featureFlagService.setFeatureState('FEATURE_TOP3_PODIUM', STATES.OFF);
  let sentAdminMsgOff = null;
  const mockTelegramAdminOff = {
    stopPoll: async () => {},
    getMe: async () => ({ username: 'TestQuizBot' }),
    sendMessage: async (chatId, text, opts) => {
      sentAdminMsgOff = { chatId, text, opts };
      return { message_id: 104 };
    },
  };
  const adminChatIdOff = -10099904;
  await sessionService.setActiveTest(adminChatIdOff, {
    chatType: 'group',
    initiatorId: ADMIN_ID,
    testId: 1,
    subjectKey: 'biologiya',
    blockName: '1-Blok',
    sessionQuestions: [{}, {}],
    groupScores: { ...sampleScores },
    startTime: Date.now() - 30000,
  });
  await coreQuiz.finishTest(adminChatIdOff, mockTelegramAdminOff);
  assert(sentAdminMsgOff.text.includes('Dilshod'), 'When OFF, admin must see standard list with Dilshod');
  const adminFinishButtonsOff = sentAdminMsgOff.opts.reply_markup.inline_keyboard.flat();
  assert(
    !adminFinishButtonsOff.some(b => b.callback_data === 'my_group_quiz_result'),
    'When OFF, admin must NOT see ephemeral result button'
  );

  console.log('✅ [Test 2 Passed] FEATURE_TOP3_PODIUM properly guarded across all states.');

  // =========================================================================
  // 3. FEATURE_DOCX_SMART_HEALER in testCreation.cbFixErrors
  // =========================================================================
  console.log('\n[Test 3] FEATURE_DOCX_SMART_HEALER in testCreation.cbFixErrors...');
  await featureFlagService.setFeatureState('FEATURE_DOCX_SMART_HEALER', STATES.ADMIN_ONLY);

  const testQuestionRaw = `O'zbekistonning poytaxti qaysi shahar?
A) Samarqand
B) Toshkent
C) Buxoro
D) Xiva`;

  // 3A: Admin user in ADMIN_ONLY -> Sees 1-tap option keys, AI auto-heal, and web inspector
  let editedAdminMsg = null;
  const mockAdminCtx = {
    from: { id: ADMIN_ID },
    chat: { id: ADMIN_ID },
    callbackQuery: { data: 'fix_errors_0' },
    answerCbQuery: async () => {},
    session: {
      data: {
        invalidQs: [testQuestionRaw],
        questions: [],
      },
    },
    editMessageText: async (text, opts) => {
      editedAdminMsg = { text, opts };
      return { message_id: 201 };
    },
  };

  await testCreation.cbFixErrors(mockAdminCtx);
  assert(editedAdminMsg, 'cbFixErrors must render message');
  const adminHealerButtons = editedAdminMsg.opts.reply_markup.inline_keyboard.flat();
  const hasPickKey = adminHealerButtons.some(b => b.callback_data && b.callback_data.startsWith('fix_pick_key_'));
  const hasAutoAll = adminHealerButtons.some(b => b.callback_data === 'fix_auto_all');
  const hasInspector = adminHealerButtons.some(b => b.callback_data === 'fix_open_inspector');
  assert(hasPickKey, 'Admin MUST see 1-tap option key buttons');
  assert(hasAutoAll, 'Admin MUST see AI auto-heal button');
  assert(hasInspector, 'Admin MUST see Web Inspector button');

  // 3B: Normal user in ADMIN_ONLY -> Falls back to standard text fix prompt
  let editedNormalMsg = null;
  const mockNormalCtx = {
    from: { id: NORMAL_USER_ID },
    chat: { id: NORMAL_USER_ID },
    callbackQuery: { data: 'fix_errors_0' },
    answerCbQuery: async () => {},
    session: {
      data: {
        invalidQs: [testQuestionRaw],
        questions: [],
      },
    },
    editMessageText: async (text, opts) => {
      editedNormalMsg = { text, opts };
      return { message_id: 202 };
    },
  };

  await testCreation.cbFixErrors(mockNormalCtx);
  assert(editedNormalMsg, 'cbFixErrors must render fallback message');
  assert(
    editedNormalMsg.text.includes('Matnni nusxalang'),
    'Normal user MUST see standard text fix prompt ("Matnni nusxalang")'
  );
  const normalHealerButtons = editedNormalMsg.opts.reply_markup.inline_keyboard.flat();
  assert(
    !normalHealerButtons.some(b => b.callback_data && b.callback_data.startsWith('fix_pick_key_')),
    'Normal user MUST NOT see 1-tap option keys when ADMIN_ONLY'
  );
  assert(
    !normalHealerButtons.some(b => b.callback_data === 'fix_auto_all'),
    'Normal user MUST NOT see AI auto-heal button when ADMIN_ONLY'
  );
  assert(
    !normalHealerButtons.some(b => b.callback_data === 'fix_open_inspector'),
    'Normal user MUST NOT see Web Inspector button when ADMIN_ONLY'
  );

  // 3C: Set to PUBLIC -> Normal user sees Smart Healer controls
  await featureFlagService.setFeatureState('FEATURE_DOCX_SMART_HEALER', STATES.PUBLIC);
  let editedNormalMsgPublic = null;
  const mockNormalCtxPublic = {
    from: { id: NORMAL_USER_ID },
    chat: { id: NORMAL_USER_ID },
    callbackQuery: { data: 'fix_errors_0' },
    answerCbQuery: async () => {},
    session: {
      data: {
        invalidQs: [testQuestionRaw],
        questions: [],
      },
    },
    editMessageText: async (text, opts) => {
      editedNormalMsgPublic = { text, opts };
      return { message_id: 203 };
    },
  };
  await testCreation.cbFixErrors(mockNormalCtxPublic);
  const normalButtonsPublicHealer = editedNormalMsgPublic.opts.reply_markup.inline_keyboard.flat();
  assert(
    normalButtonsPublicHealer.some(b => b.callback_data && b.callback_data.startsWith('fix_pick_key_')),
    'Normal user MUST see 1-tap keys when PUBLIC'
  );

  // 3D: Set to OFF -> Even admin falls back to standard text fix prompt
  await featureFlagService.setFeatureState('FEATURE_DOCX_SMART_HEALER', STATES.OFF);
  let editedAdminMsgOff = null;
  const mockAdminCtxOff = {
    from: { id: ADMIN_ID },
    chat: { id: ADMIN_ID },
    callbackQuery: { data: 'fix_errors_0' },
    answerCbQuery: async () => {},
    session: {
      data: {
        invalidQs: [testQuestionRaw],
        questions: [],
      },
    },
    editMessageText: async (text, opts) => {
      editedAdminMsgOff = { text, opts };
      return { message_id: 204 };
    },
  };
  await testCreation.cbFixErrors(mockAdminCtxOff);
  assert(editedAdminMsgOff.text.includes('Matnni nusxalang'), 'Admin MUST see standard prompt when OFF');
  const adminButtonsOffHealer = editedAdminMsgOff.opts.reply_markup.inline_keyboard.flat();
  assert(
    !adminButtonsOffHealer.some(b => b.callback_data && b.callback_data.startsWith('fix_pick_key_')),
    'Admin MUST NOT see 1-tap keys when OFF'
  );

  console.log('✅ [Test 3 Passed] FEATURE_DOCX_SMART_HEALER properly guarded across all states.');

  // =========================================================================
  // 4. FEATURE_WIDGET_ENGINE in widgetService.buildWidgetMessage
  // =========================================================================
  console.log('\n[Test 4] FEATURE_WIDGET_ENGINE in widgetService.buildWidgetMessage...');
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', STATES.ADMIN_ONLY);

  // 4A: Admin user in ADMIN_ONLY -> Gets valid widget token and WebApp URL
  const adminWidget = widgetService.buildWidgetMessage(
    'podium',
    { title: 'Top-3' },
    'Fallback text',
    null,
    { userId: ADMIN_ID, baseUrl: 'https://test.me' }
  );
  assert(adminWidget.token, 'Admin MUST receive widget token when ADMIN_ONLY');
  assert(adminWidget.url && adminWidget.url.includes('/widget/'), 'Admin MUST receive widget URL when ADMIN_ONLY');
  assert(adminWidget.widget && adminWidget.widget.url, 'Admin MUST receive widget structure');
  assert(adminWidget.enabled !== false, 'Admin widget MUST be enabled');

  // 4B: Normal user in ADMIN_ONLY -> Receives fallback structure without widget URL
  const normalWidget = widgetService.buildWidgetMessage(
    'podium',
    { title: 'Top-3' },
    'Fallback text',
    null,
    { userId: NORMAL_USER_ID, baseUrl: 'https://test.me' }
  );
  assert.strictEqual(normalWidget.token, null, 'Normal user token MUST be null when ADMIN_ONLY');
  assert.strictEqual(normalWidget.url, null, 'Normal user url MUST be null when ADMIN_ONLY');
  assert.strictEqual(normalWidget.widget, null, 'Normal user widget MUST be null when ADMIN_ONLY');
  assert.strictEqual(normalWidget.enabled, false, 'Normal user widget enabled MUST be false');
  assert.strictEqual(normalWidget.text, 'Fallback text', 'Fallback text MUST be preserved');

  // 4C: Set to PUBLIC -> Normal user receives active widget
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', STATES.PUBLIC);
  const normalWidgetPublic = widgetService.buildWidgetMessage(
    'podium',
    { title: 'Top-3' },
    'Fallback text',
    null,
    { userId: NORMAL_USER_ID, baseUrl: 'https://test.me' }
  );
  assert(normalWidgetPublic.token, 'Normal user MUST receive token when PUBLIC');
  assert(normalWidgetPublic.url && normalWidgetPublic.url.includes('/widget/'), 'Normal user MUST receive URL when PUBLIC');

  // 4D: Set to OFF -> Even admin receives fallback only
  await featureFlagService.setFeatureState('FEATURE_WIDGET_ENGINE', STATES.OFF);
  const adminWidgetOff = widgetService.buildWidgetMessage(
    'podium',
    { title: 'Top-3' },
    'Fallback text',
    null,
    { userId: ADMIN_ID, baseUrl: 'https://test.me' }
  );
  assert.strictEqual(adminWidgetOff.token, null, 'Admin token MUST be null when OFF');
  assert.strictEqual(adminWidgetOff.url, null, 'Admin url MUST be null when OFF');
  assert.strictEqual(adminWidgetOff.widget, null, 'Admin widget MUST be null when OFF');
  assert.strictEqual(adminWidgetOff.enabled, false, 'Admin widget enabled MUST be false when OFF');

  console.log('✅ [Test 4 Passed] FEATURE_WIDGET_ENGINE properly guarded across all states.');

  console.log('\n======================================================');
  console.log('🎉 ALL 4 FEATURE FLAG INTEGRATION TESTS PASSED CLEANLY! 🚀');
  console.log('======================================================\n');
}

runTests().catch(err => {
  console.error('\n❌ Integration Test Suite Failed:', err);
  process.exit(1);
});
