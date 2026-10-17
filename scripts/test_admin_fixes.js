'use strict';

process.env.BOT_TOKEN = '123456:dummy_test_token';
const assert = require('assert');
const dbService = require('../src/services/dbService');
const storage = require('../src/core/storage');

async function runTests() {
  console.log('🧪 Starting Admin Fixes Verification Tests...\n');

  // 1. Test Users Pagination & Fallback
  console.log('1. Testing User Count & Pagination:');
  const count = await dbService.getUserCount();
  assert(typeof count === 'number', 'User count must be a number');
  console.log(`  ✅ User count returned: ${count}`);

  const paged = await dbService.getUsersPaginated(0, 10);
  assert(paged && Array.isArray(paged.users), 'getUsersPaginated must return users array');
  assert(typeof paged.total === 'number', 'getUsersPaginated must return numeric total');
  console.log(`  ✅ getUsersPaginated returned ${paged.users.length} users, total: ${paged.total}`);
  if (paged.users.length > 0) {
    const u = paged.users[0];
    assert(u.telegram_id, 'User object must contain telegram_id');
    console.log(`  ✅ First user structure valid: telegram_id=${u.telegram_id}, full_name=${u.full_name}`);
  }

  // 2. Test Media Group (Album) Buffering Simulation
  console.log('\n2. Testing Media Group Buffering & Handling:');
  const adminHandlers = require('../src/handlers/adminHandlers');
  assert(typeof adminHandlers.onBroadcastMessage === 'function', 'onBroadcastMessage must be a function');
  assert(typeof adminHandlers.onBroadcastConfirmInput === 'function', 'onBroadcastConfirmInput must be a function');
  console.log('  ✅ onBroadcastMessage and onBroadcastConfirmInput are properly exported');

  // Simulate Telegram media group messages (2 photos sent simultaneously with same media_group_id)
  let replies = [];
  let sentMediaGroups = [];

  const mockCtx1 = {
    from: { id: 2014973670 },
    chat: { id: 2014973670 },
    session: { state: null, data: {} },
    message: {
      message_id: 101,
      media_group_id: 'test_mg_99999',
      photo: [{ file_id: 'low_res_1' }, { file_id: 'high_res_photo_1' }],
      caption: 'Album sarlavhasi',
    },
    reply: async (text, opts) => { replies.push({ text, opts }); },
    telegram: {
      sendMediaGroup: async (chatId, media) => { sentMediaGroups.push({ chatId, media }); },
    },
  };

  const mockCtx2 = {
    from: { id: 2014973670 },
    chat: { id: 2014973670 },
    session: { state: null, data: {} },
    message: {
      message_id: 102,
      media_group_id: 'test_mg_99999',
      photo: [{ file_id: 'low_res_2' }, { file_id: 'high_res_photo_2' }],
      caption: undefined,
    },
    reply: async (text, opts) => { replies.push({ text, opts }); },
    telegram: {
      sendMediaGroup: async (chatId, media) => { sentMediaGroups.push({ chatId, media }); },
    },
  };

  // Simulate both arriving almost at once
  await adminHandlers.onBroadcastMessage(mockCtx1);
  await adminHandlers.onBroadcastMessage(mockCtx2);

  // Immediately, neither should have sent reply yet because debouncer is waiting 750ms
  assert.strictEqual(replies.length, 0, 'Debouncer should prevent immediate reply until all media arrives');
  console.log('  ✅ Debouncer buffered photo 1 and photo 2 without premature state transition');

  // Wait for debouncer (750ms) + async DB call to process buffer
  for (let i = 0; i < 60; i++) {
    if (sentMediaGroups.length > 0) break;
    await new Promise(r => setTimeout(r, 100));
  }

  assert.strictEqual(sentMediaGroups.length, 1, 'sendMediaGroup preview should have been called once');
  const preview = sentMediaGroups[0];
  assert.strictEqual(preview.media.length, 2, 'Preview album must contain exactly 2 photos');
  assert.strictEqual(preview.media[0].media, 'high_res_photo_1', 'Photo 1 file_id must match');
  assert.strictEqual(preview.media[1].media, 'high_res_photo_2', 'Photo 2 file_id must match');
  assert.strictEqual(preview.media[0].caption, 'Album sarlavhasi', 'Caption must be preserved on photo 1');
  console.log('  ✅ Album preview generated with both photos and caption');

  assert(replies.length >= 1, 'Admin confirmation prompt should have been sent');
  assert(replies[0].text.includes('ALBUM XABAR PREVIEW'), 'Confirmation prompt must indicate album mode');
  assert(replies[0].text.includes('2 ta media'), 'Confirmation prompt must specify media count');
  console.log('  ✅ Album confirmation prompt formatted correctly');

  console.log('\n📊 All Admin Fixes Verified Successfully!');
  process.exit(0);
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
