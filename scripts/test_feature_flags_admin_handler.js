'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:dummy_test_token';
process.env.ADMIN_ID = process.env.ADMIN_ID || '777123456';

const assert = require('assert');

async function runTests() {
  console.log('🧪 Starting Feature Flags Admin Handler & Dashboard Tests...\n');

  // Attempt to require the handler
  let handler;
  try {
    handler = require('../src/handlers/featureFlagAdminHandler');
  } catch (err) {
    console.error('❌ Failed to load featureFlagAdminHandler:', err.message);
    process.exit(1);
  }

  const featureFlagService = require('../src/services/featureFlagService');
  const { STATES, resetLocalState, setFeatureState, setAdminList, addBetaUser, getBetaUsers } = featureFlagService;

  const {
    cycleState,
    renderFlagsDashboardText,
    buildFlagsKeyboard,
    parseBetaUserArg,
    cbFlagsDashboard,
    cbToggleFlag,
    cbResetBreaker,
    cmdBetaAdd,
    cmdBetaRemove,
    cmdBetaList,
    register,
  } = handler;

  assert(typeof cycleState === 'function', 'cycleState must be exported');
  assert(typeof renderFlagsDashboardText === 'function', 'renderFlagsDashboardText must be exported');
  assert(typeof buildFlagsKeyboard === 'function', 'buildFlagsKeyboard must be exported');
  assert(typeof parseBetaUserArg === 'function', 'parseBetaUserArg must be exported');
  assert(typeof cbFlagsDashboard === 'function', 'cbFlagsDashboard must be exported');
  assert(typeof cbToggleFlag === 'function', 'cbToggleFlag must be exported');
  assert(typeof cbResetBreaker === 'function', 'cbResetBreaker must be exported');
  assert(typeof cmdBetaAdd === 'function', 'cmdBetaAdd must be exported');
  assert(typeof cmdBetaRemove === 'function', 'cmdBetaRemove must be exported');
  assert(typeof cmdBetaList === 'function', 'cmdBetaList must be exported');
  assert(typeof register === 'function', 'register must be exported');

  resetLocalState();
  const ADMIN_ID = 777123456;
  const REGULAR_ID = 111222333;
  setAdminList([ADMIN_ID]);

  // ─────────────────────────────────────────────────────────────
  // 1. STATE CYCLING SEQUENCE
  // ─────────────────────────────────────────────────────────────
  console.log('1. Testing State Cycling Sequence:');
  {
    assert.strictEqual(cycleState('OFF'), 'ADMIN_ONLY');
    assert.strictEqual(cycleState('ADMIN_ONLY'), 'BETA_USERS');
    assert.strictEqual(cycleState('BETA_USERS'), 'PERCENT_20');
    assert.strictEqual(cycleState('PERCENT_20'), 'PERCENT_50');
    assert.strictEqual(cycleState('PERCENT_50'), 'PUBLIC');
    assert.strictEqual(cycleState('PUBLIC'), 'OFF');

    // Full 6-step loop
    let state = 'OFF';
    const expected = ['ADMIN_ONLY', 'BETA_USERS', 'PERCENT_20', 'PERCENT_50', 'PUBLIC', 'OFF'];
    for (const exp of expected) {
      state = cycleState(state);
      assert.strictEqual(state, exp);
    }

    // Fallbacks for unknown or intermediate states
    assert.strictEqual(cycleState('PERCENT_10'), 'PERCENT_20');
    assert.strictEqual(cycleState('PERCENT_25'), 'PERCENT_50');
    assert.strictEqual(cycleState('UNKNOWN_XYZ'), 'ADMIN_ONLY');
    assert.strictEqual(cycleState(null), 'ADMIN_ONLY');
    assert.strictEqual(cycleState(undefined), 'ADMIN_ONLY');

    console.log('  ✅ cycleState correctly cycles OFF -> ADMIN_ONLY -> BETA_USERS -> PERCENT_20 -> PERCENT_50 -> PUBLIC -> OFF');
  }

  // ─────────────────────────────────────────────────────────────
  // 2. DASHBOARD TEXT FORMATTING
  // ─────────────────────────────────────────────────────────────
  console.log('\n2. Testing Dashboard Text Formatting:');
  {
    // Empty flags map
    const emptyText = renderFlagsDashboardText({});
    assert(typeof emptyText === 'string', 'Should return string');
    assert(emptyText.includes('Feature Flags') || emptyText.includes('FEATURE FLAGS'), 'Should include title');

    // Populated flags map with all states
    const flagsMap = {
      FEAT_A: { key: 'FEAT_A', state: 'OFF', autoKillTriggered: false, errorCount: 0 },
      FEAT_B: { key: 'FEAT_B', state: 'ADMIN_ONLY', autoKillTriggered: false, errorCount: 0 },
      FEAT_C: { key: 'FEAT_C', state: 'BETA_USERS', autoKillTriggered: false, errorCount: 0 },
      FEAT_D: { key: 'FEAT_D', state: 'PERCENT_20', autoKillTriggered: false, errorCount: 0 },
      FEAT_E: { key: 'FEAT_E', state: 'PERCENT_50', autoKillTriggered: false, errorCount: 0 },
      FEAT_F: { key: 'FEAT_F', state: 'PUBLIC', autoKillTriggered: false, errorCount: 0 },
    };

    const text = renderFlagsDashboardText(flagsMap);
    assert(text.includes('[OFF]'), 'Text must include [OFF]');
    assert(text.includes('[ADMIN]'), 'Text must include [ADMIN]');
    assert(text.includes('[BETA]'), 'Text must include [BETA]');
    assert(text.includes('[20%]'), 'Text must include [20%]');
    assert(text.includes('[50%]'), 'Text must include [50%]');
    assert(text.includes('[PUBLIC]'), 'Text must include [PUBLIC]');
    assert(text.includes('FEAT_A'), 'Text must include feature key FEAT_A');
    assert(text.includes('FEAT_F'), 'Text must include feature key FEAT_F');

    // Auto-kill warning test
    const trippedMap = {
      FEAT_TRIPPED: {
        key: 'FEAT_TRIPPED',
        state: 'ADMIN_ONLY',
        autoKillTriggered: true,
        trippedReason: 'Simulated high latency spike',
        errorCount: 4,
      },
    };
    const trippedText = renderFlagsDashboardText(trippedMap);
    assert(trippedText.includes('FEAT_TRIPPED'), 'Must include tripped feature key');
    assert(
      trippedText.includes('AUTO-KILL') || trippedText.includes('Auto-Kill') || trippedText.includes('CIRCUIT BREAKER'),
      'Must contain auto-kill warning header'
    );
    assert(trippedText.includes('Simulated high latency spike'), 'Must mention tripped reason');

    console.log('  ✅ renderFlagsDashboardText produces valid, styled HTML with badges and kill warnings');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. KEYBOARD BUILDER
  // ─────────────────────────────────────────────────────────────
  console.log('\n3. Testing Keyboard Builder:');
  {
    const flagsMap = {
      FEAT_A: { key: 'FEAT_A', state: 'ADMIN_ONLY', autoKillTriggered: false },
      FEAT_B: { key: 'FEAT_B', state: 'PERCENT_50', autoKillTriggered: true },
    };

    const kb = buildFlagsKeyboard(flagsMap);
    assert(kb && kb.reply_markup && Array.isArray(kb.reply_markup.inline_keyboard), 'Must return valid Telegraf inline keyboard');

    const flatButtons = kb.reply_markup.inline_keyboard.flat();
    
    // Toggle button for FEAT_A
    const toggleA = flatButtons.find(b => b.callback_data === 'flag_toggle_FEAT_A');
    assert(toggleA, 'Must have toggle button for FEAT_A (flag_toggle_FEAT_A)');

    // Toggle button for FEAT_B
    const toggleB = flatButtons.find(b => b.callback_data === 'flag_toggle_FEAT_B');
    assert(toggleB, 'Must have toggle button for FEAT_B (flag_toggle_FEAT_B)');

    // Reset breaker button for tripped FEAT_B
    const resetB = flatButtons.find(b => b.callback_data === 'flag_reset_FEAT_B');
    assert(resetB, 'Must have reset button for tripped FEAT_B (flag_reset_FEAT_B)');

    // FEAT_A is not tripped, so should NOT have reset button
    const resetA = flatButtons.find(b => b.callback_data === 'flag_reset_FEAT_A');
    assert(!resetA, 'Must NOT have reset button for untripped FEAT_A');

    // Refresh and return buttons
    const refreshBtn = flatButtons.find(b => b.callback_data === 'flags_refresh');
    assert(refreshBtn, 'Must have flags_refresh button');
    const backBtn = flatButtons.find(b => b.callback_data === 'admin_panel_main');
    assert(backBtn, 'Must have admin_panel_main button');

    // Verify all callback_data are <= 64 bytes
    flatButtons.forEach(btn => {
      assert(Buffer.byteLength(btn.callback_data, 'utf8') <= 64, `Callback data exceeds 64 bytes: ${btn.callback_data}`);
    });

    console.log('  ✅ buildFlagsKeyboard constructs correct 1-tap toggles, conditional resets, and navigation');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. BETA USER ARGUMENT PARSER
  // ─────────────────────────────────────────────────────────────
  console.log('\n4. Testing Beta User Command Parsing:');
  {
    assert.strictEqual(parseBetaUserArg('/beta_add 123456789'), '123456789');
    assert.strictEqual(parseBetaUserArg('/beta_add   987654321  '), '987654321');
    assert.strictEqual(parseBetaUserArg('/beta_add @student_hero'), 'student_hero');
    assert.strictEqual(parseBetaUserArg('/beta_add student_hero'), 'student_hero');
    assert.strictEqual(parseBetaUserArg('/beta_remove @alice'), 'alice');
    assert.strictEqual(parseBetaUserArg('/beta_remove 555444333'), '555444333');
    assert.strictEqual(parseBetaUserArg('12345'), '12345');
    assert.strictEqual(parseBetaUserArg('@bob'), 'bob');

    assert.strictEqual(parseBetaUserArg('/beta_add'), null);
    assert.strictEqual(parseBetaUserArg('/beta_add   '), null);
    assert.strictEqual(parseBetaUserArg(''), null);
    assert.strictEqual(parseBetaUserArg(null), null);
    assert.strictEqual(parseBetaUserArg(undefined), null);

    console.log('  ✅ parseBetaUserArg cleanly parses user IDs, usernames, and handles empty inputs');
  }

  // ─────────────────────────────────────────────────────────────
  // 5. ACTION HANDLERS & SIMULATED TELEGRAM CONTEXTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n5. Testing Action Handlers (Dashboard, Toggle, Reset, Beta):');
  {
    // Setup initial feature
    const testFeat = 'FEAT_ADMIN_TEST';
    await setFeatureState(testFeat, 'OFF');

    // Mock Context Generator
    function createMockCtx(userId, textOrData, isCallback = false) {
      const messages = [];
      const answers = [];
      const edits = [];

      const ctx = {
        from: { id: userId, username: 'tester_admin' },
        chat: { id: userId, type: 'private' },
        message: !isCallback ? { text: textOrData } : undefined,
        callbackQuery: isCallback ? { data: textOrData } : undefined,
        match: isCallback && textOrData.includes('_') ? [textOrData, textOrData.replace(/^(flag_toggle_|flag_reset_)/, '')] : null,
        reply: async (txt, opts) => {
          messages.push({ txt, opts });
          return { message_id: 101, text: txt };
        },
        editMessageText: async (txt, opts) => {
          edits.push({ txt, opts });
          return true;
        },
        answerCbQuery: async (txt, opts) => {
          answers.push({ txt, opts });
          return true;
        },
        _getSentMessages: () => messages,
        _getEdits: () => edits,
        _getAnswers: () => answers,
      };
      return ctx;
    }

    // 5a. /flags command (Admin)
    const ctxFlags = createMockCtx(ADMIN_ID, '/flags');
    await cbFlagsDashboard(ctxFlags);
    assert(ctxFlags._getSentMessages().length > 0, 'Admin /flags should reply with dashboard');
    assert(ctxFlags._getSentMessages()[0].txt.includes('FEAT_ADMIN_TEST'), 'Dashboard should contain FEAT_ADMIN_TEST');

    // 5b. /flags command (Non-Admin Rejected)
    const ctxNonAdmin = createMockCtx(REGULAR_ID, '/flags');
    await cbFlagsDashboard(ctxNonAdmin);
    assert(ctxNonAdmin._getSentMessages()[0].txt.includes('taqiqlangan') || ctxNonAdmin._getSentMessages()[0].txt.includes('admin'), 'Non-admin should be denied access');

    // 5c. 1-tap State Toggle
    const ctxToggle = createMockCtx(ADMIN_ID, `flag_toggle_${testFeat}`, true);
    await cbToggleFlag(ctxToggle);
    assert.strictEqual(featureFlagService.getFeatureState(testFeat), 'ADMIN_ONLY', 'State should cycle from OFF to ADMIN_ONLY');
    assert(ctxToggle._getAnswers().length > 0, 'Should answer callback query');

    // Second toggle
    await cbToggleFlag(ctxToggle);
    assert.strictEqual(featureFlagService.getFeatureState(testFeat), 'BETA_USERS', 'State should cycle from ADMIN_ONLY to BETA_USERS');

    // 5d. Circuit Breaker Reset
    featureFlagService.recordFeatureError(testFeat, new Error('Test err 1'), { errorThreshold: 2 });
    featureFlagService.recordFeatureError(testFeat, new Error('Test err 2'), { errorThreshold: 2 });
    assert.strictEqual(featureFlagService.getFeatureHealth(testFeat).autoKillTriggered, true, 'Feature should be tripped');

    const ctxReset = createMockCtx(ADMIN_ID, `flag_reset_${testFeat}`, true);
    await cbResetBreaker(ctxReset);
    assert.strictEqual(featureFlagService.getFeatureHealth(testFeat).autoKillTriggered, false, 'Breaker should be reset');

    // 5e. Beta Cohort Commands
    const ctxBetaAdd = createMockCtx(ADMIN_ID, '/beta_add 444555666');
    await cmdBetaAdd(ctxBetaAdd);
    assert(getBetaUsers().includes('444555666'), 'User 444555666 should be added to beta');
    assert(ctxBetaAdd._getSentMessages()[0].txt.includes('444555666'), 'Reply should confirm addition');

    const ctxBetaList = createMockCtx(ADMIN_ID, '/beta_list');
    await cmdBetaList(ctxBetaList);
    assert(ctxBetaList._getSentMessages()[0].txt.includes('444555666'), 'Beta list should display user 444555666');

    const ctxBetaRemove = createMockCtx(ADMIN_ID, '/beta_remove 444555666');
    await cmdBetaRemove(ctxBetaRemove);
    assert(!getBetaUsers().includes('444555666'), 'User 444555666 should be removed from beta');

    console.log('  ✅ Action handlers handle toggle, reset, and beta management successfully');
  }

  // ─────────────────────────────────────────────────────────────
  // 6. BOT ROUTE REGISTRATION VERIFICATION
  // ─────────────────────────────────────────────────────────────
  console.log('\n6. Testing Route Registration:');
  {
    const registeredCommands = [];
    const registeredActions = [];

    const mockBot = {
      command: (cmd, fn) => registeredCommands.push(cmd),
      action: (act, fn) => registeredActions.push(act),
    };

    register(mockBot);

    assert(registeredCommands.includes('flags'), 'Must register /flags');
    assert(registeredCommands.includes('beta_add'), 'Must register /beta_add');
    assert(registeredCommands.includes('beta_remove'), 'Must register /beta_remove');
    assert(registeredCommands.includes('beta_list'), 'Must register /beta_list');

    assert(registeredActions.includes('flags_dash'), 'Must register flags_dash action');
    assert(registeredActions.includes('flags_refresh'), 'Must register flags_refresh action');

    // Actions with regex matching
    const hasToggleAction = registeredActions.some(a => a instanceof RegExp && a.test('flag_toggle_TEST'));
    const hasResetAction = registeredActions.some(a => a instanceof RegExp && a.test('flag_reset_TEST'));
    assert(hasToggleAction, 'Must register regex action for flag_toggle_');
    assert(hasResetAction, 'Must register regex action for flag_reset_');

    console.log('  ✅ register(bot) binds all commands and interactive actions');
  }

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch(err => {
  console.error('\n❌ TEST RUN FAILED:', err);
  process.exit(1);
});
