# Smart Feature Flag & Rollout Governance System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a production-grade, declarative Feature Flag & Governance Engine in `quiz_bot_nodejs` featuring zero-config self-registration, deterministic canary percentage rollout, automated error threshold circuit-breakers (Auto-Kill Switch), beta tester cohort management, and an interactive in-chat Admin Dashboard (`/flags`).

**Architecture:**
- **Engine Core (`src/services/featureFlagService.js`):** Stateful Redis-backed service with local in-memory L1 cache (5s TTL) evaluating rollout states (`OFF`, `ADMIN_ONLY`, `BETA_USERS`, `PERCENTAGE`, `PUBLIC`) with deterministic Murmur/FNV hashing across user and chat scopes.
- **Circuit Breaker & Auto-Kill Switch:** Integrates with `errorReporterService.js`. When unhandled errors for a feature exceed the safety threshold (3 errors within 5 minutes), the feature automatically downgrades to `ADMIN_ONLY` and fires an emergency alert to the bot owner.
- **Admin Control Plane (`src/handlers/featureFlagAdminHandler.js`):** In-chat Telegraf interactive menu allowing 1-tap state cycling, percentage adjustment, and `/beta_add` / `/beta_remove` cohort commands.
- **Feature Protection:** Integrates into `coreQuiz.js` (Podium), `keyboards.js` (Flashcards), `testCreation.js` (Smart Docx Healer), and `widgetService.js` (Widgets) with graceful fallbacks.

**Tech Stack:** Node.js, Redis (`ioredis`), Telegraf 4.x, Crypto (deterministic hashing).

**Spec:** [docs/superpowers/specs/2026-11-10-smart-feature-flag-system-design.md](file:///C:/Users/user/code/quiz_bot_nodejs/docs/superpowers/specs/2026-11-10-smart-feature-flag-system-design.md)

## Global Constraints
- **Zero Downtime & Zero Overhead:** Flag evaluations must never block the event loop or crash if Redis is unavailable (instant fallback to in-memory defaults).
- **Sticky Canary Bucketing:** A user within a canary percentage must deterministically stay in that bucket without flickering on repeated actions.
- **Backward Compatibility:** All existing functionality must remain intact when any or all feature flags are set to `OFF`.
- **Security:** Modifying feature flags or beta lists must be strictly restricted to verified bot admins (`ADMIN_IDS`).

## Review Focus
1. **Redis disconnect resilience:** When Redis goes down, `isFeatureEnabled` must gracefully fall back to default configurations without throwing unhandled rejections.
2. **Deterministic percentage math:** Boundary values (0%, 100%, negative IDs, string IDs) must map to 0..99 uniformly without bias or NaN results.
3. **Group chat scope vs Private chat:** In a group chat, admin-only features must activate if the initiator is an admin or if the group is registered as a beta test chat.
4. **Auto-kill breaker reset:** After an auto-kill switch triggers, it must require explicit admin approval to re-enable, preventing continuous crash loops.
5. **Concurrent flag toggle race conditions:** Rapid toggling in the admin menu must not corrupt Redis or leave mismatched in-memory state.

---

### Task 1: Core Declarative Feature Registry & Hashing Engine

**Files:**
- Create: `src/services/featureFlagService.js`
- Create: `scripts/test_feature_flags_core.js`

**Interfaces:**
- Consumes: `redisConnection`, `ADMIN_IDS`, `ADMIN_ID`
- Produces: `isFeatureEnabled(featureKey, userId, context)`, `setFeatureState(featureKey, state, options)`, `getFeatureStates()`, `calculateUserBucket(userId, featureKey)`

- [ ] **Step 1: Write failing test for Feature Flag Engine**

Create `scripts/test_feature_flags_core.js`:
```javascript
'use strict';
const assert = require('assert');
const featureFlagService = require('../src/services/featureFlagService');

console.log('🧪 Testing Task 1: Core Feature Flag Engine & Hashing...');

// 1. Module exports
assert(typeof featureFlagService.isFeatureEnabled === 'function', 'isFeatureEnabled must be exported');
assert(typeof featureFlagService.setFeatureState === 'function', 'setFeatureState must be exported');
assert(typeof featureFlagService.calculateUserBucket === 'function', 'calculateUserBucket must be exported');

// 2. Deterministic hashing
const bucket1 = featureFlagService.calculateUserBucket(12345678, 'FEATURE_TEST');
const bucket2 = featureFlagService.calculateUserBucket(12345678, 'FEATURE_TEST');
assert.strictEqual(bucket1, bucket2, 'Hashing must be deterministic for same user and feature');
assert(bucket1 >= 0 && bucket1 < 100, `Bucket must be between 0 and 99, got: ${bucket1}`);

// 3. States evaluation
// ADMIN_ONLY state
featureFlagService.setFeatureState('TEST_FEAT', 'ADMIN_ONLY');
const adminId = 11223344;
const normalUserId = 99887766;

featureFlagService.setAdminList([adminId]);

assert.strictEqual(featureFlagService.isFeatureEnabledSync('TEST_FEAT', adminId), true, 'Admin must have access under ADMIN_ONLY');
assert.strictEqual(featureFlagService.isFeatureEnabledSync('TEST_FEAT', normalUserId), false, 'Normal user must NOT have access under ADMIN_ONLY');

// PUBLIC state
featureFlagService.setFeatureState('TEST_FEAT', 'PUBLIC');
assert.strictEqual(featureFlagService.isFeatureEnabledSync('TEST_FEAT', normalUserId), true, 'Normal user must have access under PUBLIC');

// OFF state
featureFlagService.setFeatureState('TEST_FEAT', 'OFF');
assert.strictEqual(featureFlagService.isFeatureEnabledSync('TEST_FEAT', adminId), false, 'Admin must NOT have access under OFF');

console.log('✅ Task 1 unit tests passed successfully!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_feature_flags_core.js`  
Expected: FAIL with "Cannot find module '../src/services/featureFlagService'"

- [ ] **Step 3: Implement `src/services/featureFlagService.js`**

1. Define supported states: `OFF`, `ADMIN_ONLY`, `BETA_USERS`, `PERCENTAGE`, `PUBLIC`.
2. Implement `calculateUserBucket(userId, featureKey)` using FNV-1a or crypto hash modulo 100.
3. Implement `isFeatureEnabled(featureKey, userId, context)`:
   - Check if kill-switch active -> `false`.
   - If `OFF` -> `false`.
   - If user in admin list -> `true` (unless state is `OFF`).
   - If `ADMIN_ONLY` -> `false` for non-admins.
   - If `BETA_USERS` -> check if user or group in beta list.
   - If `PERCENTAGE` -> `bucket < rolloutPercentage`.
   - If `PUBLIC` -> `true`.
4. Implement Redis sync with 5-second local in-memory L1 cache.
5. Provide synchronous evaluator `isFeatureEnabledSync` from L1 cache.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test_feature_flags_core.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/featureFlagService.js scripts/test_feature_flags_core.js
git commit -m "feat(flags): implement core declarative feature flag engine and deterministic hashing"
```

---

### Task 2: Automated Auto-Kill Switch & Error Threshold Circuit Breaker

**Files:**
- Modify: `src/services/featureFlagService.js`
- Modify: `src/services/errorReporterService.js`
- Create: `scripts/test_feature_flags_circuit_breaker.js`

**Interfaces:**
- Consumes: `errorReporterService.report`, `logger`
- Produces: `recordFeatureError(featureKey, error)`, `getFeatureHealth(featureKey)`

- [ ] **Step 1: Write failing test for Auto-Kill Switch Circuit Breaker**

Create `scripts/test_feature_flags_circuit_breaker.js`:
```javascript
'use strict';
const assert = require('assert');
const featureFlagService = require('../src/services/featureFlagService');

console.log('🧪 Testing Task 2: Auto-Kill Switch Circuit Breaker...');

featureFlagService.setFeatureState('FRAGILE_FEAT', 'PUBLIC', { errorThreshold: 3, windowSeconds: 60 });
assert.strictEqual(featureFlagService.isFeatureEnabledSync('FRAGILE_FEAT', 555), true);

// Record 2 errors (under threshold of 3)
featureFlagService.recordFeatureError('FRAGILE_FEAT', new Error('Fail 1'));
featureFlagService.recordFeatureError('FRAGILE_FEAT', new Error('Fail 2'));
assert.strictEqual(featureFlagService.isFeatureEnabledSync('FRAGILE_FEAT', 555), true, 'Should stay enabled when below error threshold');

// Record 3rd error -> triggers breaker
const tripResult = featureFlagService.recordFeatureError('FRAGILE_FEAT', new Error('Fail 3 (Critical)'));
assert(tripResult.tripped === true, 'Circuit breaker must trip when threshold is met');
assert.strictEqual(tripResult.downgradedTo, 'ADMIN_ONLY', 'Must downgrade to ADMIN_ONLY');

// Now normal user must be blocked, preventing widespread outage!
assert.strictEqual(featureFlagService.isFeatureEnabledSync('FRAGILE_FEAT', 555), false, 'Normal user must be protected by tripped breaker');

console.log('✅ Task 2 unit tests passed successfully!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_feature_flags_circuit_breaker.js`  
Expected: FAIL with "recordFeatureError is not a function"

- [ ] **Step 3: Implement Auto-Kill Switch & integrate into Error Reporter**

1. In `src/services/featureFlagService.js`:
   - Add sliding-window error counter per feature (`Map<featureKey, Array<timestamp>>`).
   - Implement `recordFeatureError(featureKey, error)`:
     - Prunes error timestamps older than window (e.g. 5 minutes).
     - Appends current timestamp.
     - If count >= threshold:
       - Automatically sets state to `ADMIN_ONLY` or `OFF`.
       - Flags `autoKillTriggered: true`, `trippedAt: Date.now()`, `reason: error.message`.
       - Triggers alert via `errorReporterService.report(...)` alerting bot owner.
       - Syncs to Redis.
2. In `src/services/errorReporterService.js`:
   - In `report(err, context)`:
     - If `context.featureKey` is provided, call `featureFlagService.recordFeatureError(context.featureKey, err)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test_feature_flags_circuit_breaker.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/featureFlagService.js src/services/errorReporterService.js scripts/test_feature_flags_circuit_breaker.js
git commit -m "feat(flags): implement automated circuit breaker and auto-kill switch"
```

---

### Task 3: In-Chat Interactive Admin Dashboard & Beta Tester Cohort Management

**Files:**
- Create: `src/handlers/featureFlagAdminHandler.js`
- Modify: `src/handlers/adminHandlers.js`
- Modify: `index.js`
- Create: `scripts/test_feature_flags_admin_handler.js`

**Interfaces:**
- Consumes: `featureFlagService`, `isAdmin`, `safeEdit`
- Produces: `cbFlagsDashboard(ctx)`, `cbToggleFlag(ctx)`, `cmdBetaAdd(ctx)`, `cmdBetaRemove(ctx)`

- [ ] **Step 1: Write failing test for Admin Dashboard Handler**

Create `scripts/test_feature_flags_admin_handler.js`:
```javascript
'use strict';
const assert = require('assert');
const handler = require('../src/handlers/featureFlagAdminHandler');

console.log('🧪 Testing Task 3: In-Chat Admin Dashboard & Beta Management...');

assert(typeof handler.renderFlagsDashboardText === 'function', 'renderFlagsDashboardText must be exported');
assert(typeof handler.buildFlagsKeyboard === 'function', 'buildFlagsKeyboard must be exported');
assert(typeof handler.cycleState === 'function', 'cycleState must be exported');

// Test state cycling: OFF -> ADMIN_ONLY -> BETA_USERS -> 20% -> 50% -> PUBLIC -> OFF
assert.strictEqual(handler.cycleState('OFF'), 'ADMIN_ONLY');
assert.strictEqual(handler.cycleState('ADMIN_ONLY'), 'BETA_USERS');
assert.strictEqual(handler.cycleState('BETA_USERS'), 'PERCENT_20');
assert.strictEqual(handler.cycleState('PERCENT_20'), 'PERCENT_50');
assert.strictEqual(handler.cycleState('PERCENT_50'), 'PUBLIC');
assert.strictEqual(handler.cycleState('PUBLIC'), 'OFF');

console.log('✅ Task 3 unit tests passed successfully!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_feature_flags_admin_handler.js`  
Expected: FAIL with "Cannot find module '../src/handlers/featureFlagAdminHandler'"

- [ ] **Step 3: Implement `src/handlers/featureFlagAdminHandler.js`**

1. Create `src/handlers/featureFlagAdminHandler.js`:
   - `renderFlagsDashboardText(flagsMap)`: returns formatted Telegram HTML displaying current feature states and health status.
   - `buildFlagsKeyboard(flagsMap)`: builds inline keyboard where each feature has an icon and 1-tap cycle callback (`flag_toggle_${key}`).
   - `cbFlagsDashboard(ctx)`: handles command `/flags` and callback `flags_dash`.
   - `cbToggleFlag(ctx)`: handles `flag_toggle_${key}`, cycles state, updates Redis, re-renders keyboard.
   - Commands `/beta_add <userId>`, `/beta_remove <userId>`, `/beta_list` with validation and persistence.
2. Connect to `adminHandlers.js` and `index.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test_feature_flags_admin_handler.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/featureFlagAdminHandler.js src/handlers/adminHandlers.js index.js scripts/test_feature_flags_admin_handler.js
git commit -m "feat(flags): implement interactive in-chat admin dashboard and beta cohort manager"
```

---

### Task 4: Integration with Telegram 10.4 Features & Route Protection

**Files:**
- Modify: `src/handlers/coreQuiz.js` (Podium & Ephemeral results protection)
- Modify: `src/keyboards/keyboards.js` (Flashcards protection)
- Modify: `src/handlers/testCreation.js` (Docx Smart Healer protection)
- Modify: `src/services/widgetService.js` (Widget engine protection)
- Create: `scripts/test_feature_flags_integration.js`

**Interfaces:**
- Consumes: `featureFlagService.isFeatureEnabled`
- Produces: Guarded execution across all 4 features with seamless fallbacks.

- [ ] **Step 1: Write failing test for Feature Flags Integration**

Create `scripts/test_feature_flags_integration.js`:
```javascript
'use strict';
const assert = require('assert');
const featureFlagService = require('../src/services/featureFlagService');
const { getBlocksKeyboard } = require('../src/keyboards/keyboards');

console.log('🧪 Testing Task 4: Feature Flags Integration & Protection...');

featureFlagService.setAdminList([11223344]);

// 1. Flashcard protection in keyboards.js
featureFlagService.setFeatureState('FEATURE_BLITZ_FLASHCARD', 'ADMIN_ONLY');

// When user is Admin:
const adminKb = getBlocksKeyboard('tarix', 0, 11223344);
const adminButtons = adminKb.reply_markup.inline_keyboard.flat();
assert(adminButtons.some(b => b.text.includes('Flashcard')), 'Admin must see Flashcard button under ADMIN_ONLY');

// When user is normal student:
const studentKb = getBlocksKeyboard('tarix', 0, 99999999);
const studentButtons = studentKb.reply_markup.inline_keyboard.flat();
assert(!studentButtons.some(b => b.text.includes('Flashcard')), 'Normal student must NOT see Flashcard button under ADMIN_ONLY');

console.log('✅ Task 4 unit tests passed successfully!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_feature_flags_integration.js`  
Expected: FAIL because `getBlocksKeyboard` does not yet accept or check `userId` with feature flags.

- [ ] **Step 3: Integrate `featureFlagService` into keyboards, coreQuiz, testCreation, and widgetService**

1. In `src/keyboards/keyboards.js`:
   - In `getBlocksKeyboard(subjectKey, page, userId)`: check `featureFlagService.isFeatureEnabledSync('FEATURE_BLITZ_FLASHCARD', userId)`. If false, omit the Flashcard button.
2. In `src/handlers/coreQuiz.js`:
   - In `finishTest`: check `featureFlagService.isFeatureEnabledSync('FEATURE_TOP3_PODIUM', userId, { isGroup: true, chatId })`. If false, use standard podium.
3. In `src/handlers/testCreation.js`:
   - In `cbFixErrors`: check `featureFlagService.isFeatureEnabledSync('FEATURE_DOCX_SMART_HEALER', ctx.from.id)`. If false, use standard text fix flow.
4. In `src/services/widgetService.js`:
   - Guard widget URL generation and routes.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test_feature_flags_integration.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/keyboards/keyboards.js src/handlers/coreQuiz.js src/handlers/testCreation.js src/services/widgetService.js scripts/test_feature_flags_integration.js
git commit -m "feat(flags): wire feature flags into podium, flashcard, docx healer, and widget modules"
```

---

### Task 5: Master Verification Suite & Package Integration

**Files:**
- Create: `scripts/test_feature_flags_master_suite.js`
- Modify: `package.json:scripts.test`

- [ ] **Step 1: Write Master Test Runner**

Create `scripts/test_feature_flags_master_suite.js`:
```javascript
'use strict';
const { execSync } = require('child_process');

console.log('🚀 Running Complete Master Test Suite for Smart Feature Flag System...\n');

const testScripts = [
  'scripts/test_feature_flags_core.js',
  'scripts/test_feature_flags_circuit_breaker.js',
  'scripts/test_feature_flags_admin_handler.js',
  'scripts/test_feature_flags_integration.js',
];

for (const script of testScripts) {
  console.log(`▶️ EXECUTING: node ${script}`);
  execSync(`node ${script}`, { stdio: 'inherit' });
  console.log(`✅ SUITE PASSED: ${script}\n`);
}

console.log('🎉 ALL FEATURE FLAG SUITES COMPLETED WITH ZERO ERRORS!');
```

- [ ] **Step 2: Run test suite**

Run: `node scripts/test_feature_flags_master_suite.js`  
Expected: PASS with 0 exit code.

- [ ] **Step 3: Update `package.json` test script**

Include `&& node scripts/test_feature_flags_master_suite.js` in `package.json`.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/test_feature_flags_master_suite.js
git commit -m "test: register and verify smart feature flag governance suite"
```
