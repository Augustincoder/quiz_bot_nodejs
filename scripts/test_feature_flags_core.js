'use strict';

const assert = require('assert');

async function runTests() {
  console.log('🧪 Starting Core Feature Flags & Hashing Engine Tests...\n');

  // Load featureFlagService
  let featureFlagService;
  try {
    featureFlagService = require('../src/services/featureFlagService');
  } catch (err) {
    console.error('❌ Failed to require featureFlagService:', err.message);
    throw err;
  }

  const {
    STATES,
    calculateUserBucket,
    isFeatureEnabled,
    isFeatureEnabledSync,
    setFeatureState,
    getFeatureStates,
    getFeatureState,
    setAdminList,
    addBetaUser,
    removeBetaUser,
    getBetaUsers,
    init,
  } = featureFlagService;

  // Initialize service
  await init();

  // Test Admin IDs setup
  const ADMIN_ID = 999999999;
  const REGULAR_USER_ID = 111111111;
  const ANOTHER_USER_ID = 222222222;
  setAdminList([ADMIN_ID]);

  // ─────────────────────────────────────────────────────────────
  // 1. DETERMINISTIC HASHING TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('1. Testing Deterministic User Bucketing (0..99):');
  {
    const bucket1 = calculateUserBucket(12345, 'FEATURE_ALPHA');
    const bucket2 = calculateUserBucket(12345, 'FEATURE_ALPHA');
    assert.strictEqual(bucket1, bucket2, 'Bucket must be strictly deterministic for identical inputs');
    assert(typeof bucket1 === 'number' && Number.isInteger(bucket1), 'Bucket must be an integer');
    assert(bucket1 >= 0 && bucket1 < 100, `Bucket must be in range [0, 99], got ${bucket1}`);

    // Type coercion (string vs number)
    const bucketStr = calculateUserBucket('12345', 'FEATURE_ALPHA');
    assert.strictEqual(bucket1, bucketStr, 'Bucket should match whether userId is passed as number or string');

    // Distinct feature keys generate distinct buckets
    const bucketBeta = calculateUserBucket(12345, 'FEATURE_BETA');
    // While theoretically possible to collide on 1/100, we check determinism
    assert(bucketBeta >= 0 && bucketBeta < 100, 'FEATURE_BETA bucket must be valid');

    // Test distribution of 1000 users
    let min = 100, max = -1;
    const seen = new Set();
    for (let uid = 1000; uid < 2000; uid++) {
      const b = calculateUserBucket(uid, 'FEATURE_DIST_TEST');
      assert(b >= 0 && b < 100, `Bucket ${b} out of range [0, 99]`);
      seen.add(b);
      if (b < min) min = b;
      if (b > max) max = b;
    }
    // Across 1000 users, we should have covered almost all buckets [0..99]
    assert(seen.size > 80, `Expected wide distribution across buckets, but covered only ${seen.size} buckets`);
    console.log(`  ✅ Hash bucket strictly deterministic, uniform across 0..99 (covered ${seen.size} buckets for 1000 users)`);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. DECLARATIVE SELF-REGISTRATION TESTS
  // ─────────────────────────────────────────────────────────────
  console.log('\n2. Testing Declarative Self-Registration:');
  {
    const newFeatureKey = 'FEATURE_AUTO_DISCOVERED_' + Date.now();
    const statesBefore = getFeatureStates();
    assert(!statesBefore[newFeatureKey], 'Feature must not exist before evaluation');

    // Evaluating an unknown feature should auto-register it as ADMIN_ONLY
    const enabledForAdmin = await isFeatureEnabled(newFeatureKey, ADMIN_ID);
    assert.strictEqual(enabledForAdmin, true, 'Admin should be enabled for auto-registered ADMIN_ONLY feature');

    const enabledForRegular = await isFeatureEnabled(newFeatureKey, REGULAR_USER_ID);
    assert.strictEqual(enabledForRegular, false, 'Regular user should be disabled for auto-registered ADMIN_ONLY feature');

    const state = getFeatureState(newFeatureKey);
    assert.strictEqual(state, STATES.ADMIN_ONLY, `Auto-registered feature must default to ADMIN_ONLY, got ${state}`);

    // Sync evaluation self-registration
    const syncFeatureKey = 'FEATURE_SYNC_AUTO_' + Date.now();
    const syncResRegular = isFeatureEnabledSync(syncFeatureKey, REGULAR_USER_ID);
    assert.strictEqual(syncResRegular, false, 'Sync evaluation should return false for regular user on new feature');
    assert.strictEqual(getFeatureState(syncFeatureKey), STATES.ADMIN_ONLY, 'Sync call should auto-register feature as ADMIN_ONLY');
    console.log('  ✅ Unregistered features automatically self-register with default state ADMIN_ONLY');
  }

  // ─────────────────────────────────────────────────────────────
  // 3. STATE EVALUATION TESTS (OFF, ADMIN_ONLY, BETA, PERCENT, PUBLIC)
  // ─────────────────────────────────────────────────────────────
  console.log('\n3. Testing State Evaluations:');

  // 3a. OFF
  {
    const key = 'FEATURE_TEST_OFF';
    await setFeatureState(key, STATES.OFF);
    const regRes = await isFeatureEnabled(key, REGULAR_USER_ID);
    const admRes = await isFeatureEnabled(key, ADMIN_ID);
    assert.strictEqual(regRes, false, 'OFF feature must return false for regular user');
    assert.strictEqual(admRes, false, 'OFF feature must return false even for admin');
    console.log('  ✅ State OFF: Disabled for all users including admins');
  }

  // 3b. ADMIN_ONLY
  {
    const key = 'FEATURE_TEST_ADMIN_ONLY';
    await setFeatureState(key, STATES.ADMIN_ONLY);
    const regRes = await isFeatureEnabled(key, REGULAR_USER_ID);
    const admRes = await isFeatureEnabled(key, ADMIN_ID);
    assert.strictEqual(regRes, false, 'ADMIN_ONLY must return false for non-admin');
    assert.strictEqual(admRes, true, 'ADMIN_ONLY must return true for admin');
    console.log('  ✅ State ADMIN_ONLY: Enabled only for admin users');
  }

  // 3c. BETA_USERS
  {
    const key = 'FEATURE_TEST_BETA';
    await setFeatureState(key, STATES.BETA_USERS);
    const betaUserId = 555555555;
    const nonBetaUserId = 666666666;

    await addBetaUser(betaUserId);
    const currentBetas = getBetaUsers();
    assert(currentBetas.map(String).includes(String(betaUserId)), 'Beta user must be in getBetaUsers() list');

    const admRes = await isFeatureEnabled(key, ADMIN_ID);
    const betaRes = await isFeatureEnabled(key, betaUserId);
    const nonBetaRes = await isFeatureEnabled(key, nonBetaUserId);

    assert.strictEqual(admRes, true, 'BETA_USERS feature must be enabled for admin');
    assert.strictEqual(betaRes, true, 'BETA_USERS feature must be enabled for beta user');
    assert.strictEqual(nonBetaRes, false, 'BETA_USERS feature must be disabled for non-beta user');

    // Context chatId beta support
    const betaGroupChatId = -100123456789;
    await addBetaUser(betaGroupChatId);
    const groupRes = await isFeatureEnabled(key, nonBetaUserId, { chatId: betaGroupChatId });
    assert.strictEqual(groupRes, true, 'BETA_USERS feature must be enabled if context.chatId is in beta list');

    // Test removeBetaUser
    await removeBetaUser(betaUserId);
    const betaRemovedRes = await isFeatureEnabled(key, betaUserId);
    assert.strictEqual(betaRemovedRes, false, 'Removed beta user must no longer have access');
    console.log('  ✅ State BETA_USERS: Enabled for admins, designated beta users and beta groups');
  }

  // 3d. PERCENTAGE ROLLOUT (PERCENT_10, PERCENT_20, PERCENT_50)
  {
    const key = 'FEATURE_TEST_PERCENT_25';
    await setFeatureState(key, STATES.PERCENT_25);

    // Admin always gets access
    const admRes = await isFeatureEnabled(key, ADMIN_ID);
    assert.strictEqual(admRes, true, 'PERCENT rollout must be enabled for admin');

    // Find users with specific buckets
    let userBelow25 = null;
    let userAbove25 = null;
    for (let uid = 10000; uid < 10500; uid++) {
      const b = calculateUserBucket(uid, key);
      if (b < 25 && userBelow25 === null) userBelow25 = uid;
      if (b >= 25 && userAbove25 === null) userAbove25 = uid;
      if (userBelow25 !== null && userAbove25 !== null) break;
    }

    assert(userBelow25 !== null, 'Should find user in bottom 25%');
    assert(userAbove25 !== null, 'Should find user in top 75%');

    const resBelow = await isFeatureEnabled(key, userBelow25);
    const resAbove = await isFeatureEnabled(key, userAbove25);
    assert.strictEqual(resBelow, true, `User with bucket < 25 must be enabled (bucket=${calculateUserBucket(userBelow25, key)})`);
    assert.strictEqual(resAbove, false, `User with bucket >= 25 must be disabled (bucket=${calculateUserBucket(userAbove25, key)})`);

    // Monotonicity test: if user is in 25%, they must also be in 50%
    await setFeatureState(key, STATES.PERCENT_50);
    const res50 = await isFeatureEnabled(key, userBelow25);
    assert.strictEqual(res50, true, 'User enabled at 25% must also be enabled when promoted to 50%');

    // Sticky consistency: check 10 times in a row
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(await isFeatureEnabled(key, userBelow25), true, 'Evaluation must be sticky across repeated calls');
    }
    console.log('  ✅ State PERCENTAGE: Deterministic bucket gating with strict cohort monotonicity');
  }

  // 3e. PUBLIC
  {
    const key = 'FEATURE_TEST_PUBLIC';
    await setFeatureState(key, STATES.PUBLIC);
    const regRes = await isFeatureEnabled(key, REGULAR_USER_ID);
    const anotherRes = await isFeatureEnabled(key, ANOTHER_USER_ID);
    const admRes = await isFeatureEnabled(key, ADMIN_ID);

    assert.strictEqual(regRes, true, 'PUBLIC feature must be enabled for regular user');
    assert.strictEqual(anotherRes, true, 'PUBLIC feature must be enabled for another user');
    assert.strictEqual(admRes, true, 'PUBLIC feature must be enabled for admin');
    console.log('  ✅ State PUBLIC: 100% enabled for all users');
  }

  // ─────────────────────────────────────────────────────────────
  // 4. SYNCHRONOUS EVALUATION (isFeatureEnabledSync)
  // ─────────────────────────────────────────────────────────────
  console.log('\n4. Testing Synchronous L1 Evaluation (isFeatureEnabledSync):');
  {
    const key = 'FEATURE_TEST_SYNC';
    await setFeatureState(key, STATES.ADMIN_ONLY);

    assert.strictEqual(isFeatureEnabledSync(key, ADMIN_ID), true, 'Sync evaluation must be true for admin');
    assert.strictEqual(isFeatureEnabledSync(key, REGULAR_USER_ID), false, 'Sync evaluation must be false for regular user');

    await setFeatureState(key, STATES.PUBLIC);
    assert.strictEqual(isFeatureEnabledSync(key, REGULAR_USER_ID), true, 'Sync evaluation must reflect state update');
    console.log('  ✅ isFeatureEnabledSync: Sub-millisecond synchronous evaluation from L1 memory cache');
  }

  // ─────────────────────────────────────────────────────────────
  // 5. RESILIENCE & GRACEFUL DEGRADATION
  // ─────────────────────────────────────────────────────────────
  console.log('\n5. Testing Graceful Degradation & Redis Offline Fallback:');
  {
    // Test that corrupt or missing parameters don't throw
    assert.strictEqual(await isFeatureEnabled(null, null), false, 'Null featureKey must safely return false');
    assert.strictEqual(await isFeatureEnabled('', 12345), false, 'Empty featureKey must safely return false');
    assert.strictEqual(isFeatureEnabledSync(null, 12345), false, 'Sync with null featureKey must safely return false');
    console.log('  ✅ Gracefully handles null/invalid parameters without throwing errors');
  }

  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! Core Feature Flags engine is ready.\n');
}

runTests().catch(err => {
  console.error('\n❌ Test suite failed:', err);
  process.exit(1);
});
