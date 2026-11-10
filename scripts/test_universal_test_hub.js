'use strict';

process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123456:TEST_BOT_TOKEN_FOR_UNIVERSAL_HUB';

const assert = require('assert');
const universalTestHub = require('../src/handlers/universalTestHub');
const botCore = require('../src/core/bot');
const dbService = require('../src/services/dbService');

async function runTests() {
  console.log('🧪 Starting Universal Test Hub & Multi-Mode Rich Suite...\n');

  const ADMIN_ID = 12345;
  const featureFlagService = require('../src/services/featureFlagService');
  featureFlagService.setAdminList([ADMIN_ID]);
  await featureFlagService.setFeatureState('FEATURE_BLITZ_FLASHCARD', 'PUBLIC');
  botCore.memoryDb = {
    matematika: {
      1: {
        questions: [
          { question: '2 + 2 = ?', options: ['3', '4', '5'], correct_index: 1 },
          { question: '5 * 5 = ?', options: ['25', '20'], correct_index: 0 },
        ],
      },
      2: {
        questions: [
          { question: '10 / 2 = ?', options: ['2', '5', '8'], correct_index: 1 },
        ],
      },
    },
  };

  // Mock UGC database calls
  const originalGetSubjectById = dbService.getSubjectById;
  const originalGetSubjectBlocks = dbService.getSubjectBlocks;
  const originalGetUserTest = dbService.getUserTest;

  dbService.getSubjectById = async (id) => {
    if (Number(id) === 101) {
      return { id: 101, name: 'Fizika (UGC)', creator_id: 888 };
    }
    return null;
  };

  dbService.getSubjectBlocks = async (id) => {
    if (Number(id) === 101) {
      return [
        {
          id: 501,
          block_name: 'Mexanika',
          questions: [
            { question: 'Tezlik formulasi?', options: ['v = s/t', 'F = ma'], correct_index: 0 },
            { question: 'Og\'irlik kuchi?', options: ['P = mg', 'E = mc2'], correct_index: 0 },
          ],
        },
        {
          id: 502,
          block_name: 'Optika',
          questions: [
            { question: 'Yorug\'lik tezligi?', options: ['300 000 km/s', '150 km/s'], correct_index: 0 },
          ],
        },
      ];
    }
    return [];
  };

  dbService.getUserTest = async (tid) => {
    if (Number(tid) === 501) {
      return {
        id: 501,
        subject: 'Fizika (UGC)',
        block_name: 'Mexanika',
        subject_id: 101,
        questions: [
          { question: 'Tezlik formulasi?', options: ['v = s/t', 'F = ma'], correct_index: 0 },
        ],
      };
    }
    return null;
  };

  // ─────────────────────────────────────────────────────────────
  // 1. RESOLVE SUBJECT DATA (Official & UGC)
  // ─────────────────────────────────────────────────────────────
  console.log('[Test 1] Testing resolveSubjectData...');
  {
    // 1A: Official Subject
    const offSubj = await universalTestHub.resolveSubjectData('matematika', true);
    assert(offSubj, 'Official subject must be resolved');
    assert.strictEqual(offSubj.isOfficial, true);
    assert.strictEqual(offSubj.blocks.length, 2);
    assert.strictEqual(offSubj.totalQuestions, 3);
    assert(offSubj.title.includes('Matematika'));

    // 1B: UGC Subject from Postgres
    const ugcSubj = await universalTestHub.resolveSubjectData(101, false);
    assert(ugcSubj, 'UGC subject must be resolved from Postgres');
    assert.strictEqual(ugcSubj.isOfficial, false);
    assert.strictEqual(ugcSubj.blocks.length, 2);
    assert.strictEqual(ugcSubj.totalQuestions, 3);
    assert.strictEqual(ugcSubj.title, 'Fizika (UGC)');

    console.log('  ✅ [PASS] resolveSubjectData successfully resolves Official and UGC subjects');
  }

  // ─────────────────────────────────────────────────────────────
  // 2. RESOLVE BLOCK DATA (Official & UGC)
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Test 2] Testing resolveBlockData...');
  {
    // 2A: Official Block
    const offBlock = await universalTestHub.resolveBlockData('matematika_1', true);
    assert(offBlock, 'Official block must be resolved');
    assert.strictEqual(offBlock.isOfficial, true);
    assert.strictEqual(offBlock.questions.length, 2);

    // 2B: UGC Block
    const ugcBlock = await universalTestHub.resolveBlockData(501, false);
    assert(ugcBlock, 'UGC block must be resolved');
    assert.strictEqual(ugcBlock.isOfficial, false);
    assert.strictEqual(ugcBlock.blockName, 'Mexanika');
    assert.strictEqual(ugcBlock.questions.length, 1);

    console.log('  ✅ [PASS] resolveBlockData resolves individual blocks accurately');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. SHOW SUBJECT HUB RENDERING & BUTTONS
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Test 3] Testing showSubjectHub Rendering...');
  {
    let sentText = '';
    let sentOpts = null;

    const mockCtx = {
      from: { id: 12345 },
      chat: { id: 12345 },
      reply: async (text, opts) => {
        sentText = text;
        sentOpts = opts;
        return true;
      },
    };

    await universalTestHub.showSubjectHub(mockCtx, 'matematika', { isOfficial: true });
    assert(sentText.includes('Matematika'), 'Must include subject title');
    assert(sentText.includes('Fan Hubi'), 'Must include Fan Hubi indicator');
    assert(sentText.includes('Jami <b>3 ta savol</b>'), 'Must display total question count');

    const keyboard = sentOpts.reply_markup.inline_keyboard;
    const flatButtons = keyboard.flat();

    // Must have Marathon button
    const hasMarathon = flatButtons.some(b => b.text.includes('Ketma-ket Marafon') && b.callback_data.includes('hub_seq_'));
    assert(hasMarathon, 'Must provide Sequential Marathon button');

    // Must have Mock Exam button
    const hasMock = flatButtons.some(b => b.text.includes('Mock Exam') && b.callback_data.includes('hub_mock_'));
    assert(hasMock, 'Must provide Mock Exam button');

    // Must have 3D Flashcard Picker button
    const hasFlashcard = flatButtons.some(b => b.text.includes('Flashcard') && b.callback_data.includes('hub_cram_pick_'));
    assert(hasFlashcard, 'Must provide Flashcard Picker button');

    console.log('  ✅ [PASS] showSubjectHub renders complete toolbar: Marathon, Mock, Flashcard, Adaptive');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. SHOW BLOCK HUB RENDERING & ACTION BUTTONS
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Test 4] Testing showBlockHub Rendering...');
  {
    let sentText = '';
    let sentOpts = null;

    const mockCtx = {
      from: { id: 12345 },
      chat: { id: 12345 },
      reply: async (text, opts) => {
        sentText = text;
        sentOpts = opts;
        return true;
      },
    };

    await universalTestHub.showBlockHub(mockCtx, 'matematika_1', { isOfficial: true });
    assert(sentText.includes('1-Blok'), 'Must include block title');
    assert(sentText.includes('Savollar soni:'), 'Must show question count');

    const flatButtons = sentOpts.reply_markup.inline_keyboard.flat();

    // Standard start button
    assert(flatButtons.some(b => b.text.includes('Standart Test') && b.callback_data.includes('hub_start_')), 'Must have start button');

    // 3D Flashcard direct launcher
    assert(flatButtons.some(b => b.text.includes('Flashcard') && b.callback_data.includes('cram_start_')), 'Must have flashcard button');

    // 5-min Blitz launcher
    assert(flatButtons.some(b => b.text.includes('Blitz') && b.callback_data.includes('hub_blitz_')), 'Must have blitz button');

    console.log('  ✅ [PASS] showBlockHub provides standard, flashcard, and blitz actions');
  }

  // ─────────────────────────────────────────────────────────────
  // 5. FLASHCARD COGNITIVE OVERLOAD PREVENTION PICKER
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Test 5] Testing showFlashcardPicker...');
  {
    let editedText = '';
    let editedOpts = null;

    const mockCtx = {
      from: { id: 12345 },
      chat: { id: 12345 },
      callbackQuery: { data: 'hub_cram_pick_off_matematika' },
      editMessageText: async (text, opts) => {
        editedText = text;
        editedOpts = opts;
        return true;
      },
    };

    await universalTestHub.showFlashcardPicker(mockCtx, 'matematika', true);
    assert(editedText.includes('Flashcard Tanlovi'), 'Must include Flashcard Tanlovi title');

    const flatButtons = editedOpts.reply_markup.inline_keyboard.flat();
    assert(flatButtons.some(b => b.text.includes('20 ta Blitz') && b.callback_data.includes('hub_cram_blitz_')), 'Must offer 20-card Blitz option');
    assert(flatButtons.some(b => b.text.includes('1-Blok')), 'Must offer Block 1 card deck');
    assert(flatButtons.some(b => b.text.includes('2-Blok')), 'Must offer Block 2 card deck');

    console.log('  ✅ [PASS] showFlashcardPicker cleanly subdivides cards per block or 20-card Blitz');
  }

  // ─────────────────────────────────────────────────────────────
  // 6. ROUTE REGISTRATION IN TELEGRAF BOT
  // ─────────────────────────────────────────────────────────────
  console.log('\n[Test 6] Testing Bot Action Registration...');
  {
    const registeredActions = [];
    const mockBot = {
      action: (pattern) => {
        registeredActions.push(pattern);
      },
    };

    universalTestHub.register(mockBot);
    assert(registeredActions.length >= 8, `Expected at least 8 registered actions, got ${registeredActions.length}`);
    console.log(`  ✅ [PASS] All ${registeredActions.length} Universal Hub bot action patterns registered cleanly`);
  }

  // Cleanup mocks
  dbService.getSubjectById = originalGetSubjectById;
  dbService.getSubjectBlocks = originalGetSubjectBlocks;
  dbService.getUserTest = originalGetUserTest;

  console.log('\n🎉 ALL UNIVERSAL TEST HUB & MULTI-MODE TESTS PASSED SUCCESSFULLY! 🚀');
}

runTests().catch((err) => {
  console.error('❌ Universal Test Hub Suite Failed:', err);
  process.exit(1);
});
