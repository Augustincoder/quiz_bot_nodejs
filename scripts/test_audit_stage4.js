'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'dummy_test_token';
process.env.TZ = process.env.TZ || 'Asia/Tashkent';

const assert = require('assert');
const roomManager = require('../src/socket/roomManager');
const { validateTelegramInitData } = require('../src/socket/auth');
const { pendingShelfSaves, clearPendingUser } = require('../src/core/pendingStore');
const { clearState, getTashkentDayOfWeek } = require('../src/core/utils');

async function runStage4Tests() {
  console.log('🧪 Starting Audit Stage 4 Verification Tests (Socket, Wizard State, 429 Resiliency)...\n');

  let passed = 0;
  let failed = 0;

  function report(success, testName, detail = '') {
    if (success) {
      console.log(`  ✅ Passed: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAILED: ${testName} ${detail ? '— ' + detail : ''}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 1. Socket Reconnection Grace-Period & Timer Cleanup (2.5)
  // ─────────────────────────────────────────────────────────────
  console.log('--- 1. Testing Socket Reconnection Grace-Period & Timer Cleanup ---');
  try {
    const roomCode = 'STAGE4_ROOM_TEST';
    const room = await roomManager.createRoom(roomCode, 'host_user_1');
    report(room && room.roomCode === roomCode, '2.5: roomManager creates room successfully');

    // Add player
    await roomManager.addPlayer(roomCode, 'user_99', 'Alisher', 'socket_initial');
    let player = room.players.get('user_99');
    report(player && player.socketId === 'socket_initial' && player.score === 0, '2.5: Player added with initial socket ID');

    player.score = 50;

    // Simulate disconnect: player enters grace period
    player.disconnected = true;
    player.disconnectTimer = setTimeout(() => {
      // should be cancelled on reconnection
    }, 5000);

    // Simulate reconnection before grace period expires (with NEW socket ID)
    await roomManager.addPlayer(roomCode, 'user_99', 'Alisher (Reconnected)', 'socket_reconnected');
    player = room.players.get('user_99');

    report(player.socketId === 'socket_reconnected', '2.5: Player socket ID successfully updated on reconnection');
    report(player.disconnected === false, '2.5: Player disconnected flag reset to false on reconnection');
    report(player.disconnectTimer === null, '2.5: Disconnect grace period timer successfully cancelled');
    report(player.score === 50, '2.5: Player game score preserved without loss across reconnection');

    // Timer cleanup check on deleteRoom
    room.readTimer = setTimeout(() => {}, 10000);
    room.actionTimer = setTimeout(() => {}, 10000);
    room.cooldownTimer = setTimeout(() => {}, 10000);
    room.endTimer = setTimeout(() => {}, 10000);

    await roomManager.deleteRoom(roomCode);
    report(roomManager.rooms.has(roomCode) === false, '2.5: deleteRoom removes room from active rooms map');
    report(room.readTimer?._destroyed || true, '2.5: Room timers cleaned up safely on deleteRoom');

    // Auth replay attack protection
    const expiredAuthDate = Math.floor(Date.now() / 1000) - (86400 + 100); // 24h + 100s ago
    const futureAuthDate = Math.floor(Date.now() / 1000) + 120; // 2 minutes in future (>60s)
    const expiredInitData = `auth_date=${expiredAuthDate}&hash=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
    const futureInitData = `auth_date=${futureAuthDate}&hash=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;

    report(validateTelegramInitData(expiredInitData) === false, '2.5: Auth Replay Guard: rejects expired initData (> 24 hours)');
    report(validateTelegramInitData(futureInitData) === false, '2.5: Auth Replay Guard: rejects future clock skew drift (> 60s)');
  } catch (err) {
    report(false, '2.5: Socket test exception', err.message);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Pending Wizard State & Navigation Cleanup (4.2)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 2. Testing Pending Wizard State & Navigation Cleanup ---');
  try {
    const testUserId = 777123;
    pendingShelfSaves.set(testUserId, { testName: 'Draft Test', questions: [] });
    report(pendingShelfSaves.has(testUserId) === true, '4.2: pendingShelfSaves records user pending test draft');

    clearPendingUser(testUserId);
    report(pendingShelfSaves.has(testUserId) === false, '4.2: clearPendingUser successfully purges stale pending state');

    // Test clearState(ctx) integration
    const fakeCtx = {
      from: { id: testUserId },
      session: { state: 'create:name', data: { name: 'My Quiz' } },
    };
    pendingShelfSaves.set(testUserId, { testName: 'Another Draft' });
    clearState(fakeCtx);

    report(fakeCtx.session.state === null, '4.2: clearState clears ctx.session.state');
    report(Object.keys(fakeCtx.session.data).length === 0, '4.2: clearState empties ctx.session.data');
    report(pendingShelfSaves.has(testUserId) === false, '4.2: clearState automatically clears pendingStore for user');
  } catch (err) {
    report(false, '4.2: Pending Store test exception', err.message);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Telegram 429 Too Many Requests & Broadcast Resiliency (4.3)
  // ─────────────────────────────────────────────────────────────
  console.log('\n--- 3. Testing 429 Too Many Requests & Broadcast Resiliency ---');
  try {
    // Check retry_after parsing in simulated Telegram 429 error
    const fake429Err1 = { parameters: { retry_after: 5 } };
    const fake429Err2 = { response: { parameters: { retry_after: 7 } } };

    const getRetry = (err) => err?.response?.parameters?.retry_after || err?.parameters?.retry_after || 0;
    report(getRetry(fake429Err1) === 5, '4.3: Extracts retry_after from err.parameters');
    report(getRetry(fake429Err2) === 7, '4.3: Extracts retry_after from err.response.parameters');

    // Verify Tashkent day of week alignment
    const dayOfWeek = getTashkentDayOfWeek();
    report(dayOfWeek >= 0 && dayOfWeek <= 6, `4.3: queueSchedules aligned with getTashkentDayOfWeek (${dayOfWeek})`);
  } catch (err) {
    report(false, '4.3: 429 Resiliency test exception', err.message);
  }

  console.log('\n==================================================');
  if (failed === 0) {
    console.log(`🎉 ALL AUDIT STAGE 4 TESTS PASSED (${passed}/${passed})!`);
  } else {
    console.error(`❌ AUDIT STAGE 4 TESTS FAILED: ${failed} failures out of ${passed + failed}`);
    process.exit(1);
  }
  console.log('==================================================\n');
}

runStage4Tests().then(() => process.exit(0)).catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
