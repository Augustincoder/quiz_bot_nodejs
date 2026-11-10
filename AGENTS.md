# AGENTS.md — Developer & AI Engineering Guidelines for `quiz_bot_nodejs`

Welcome! When working on `quiz_bot_nodejs`, you MUST ALWAYS strictly follow these senior-level engineering rules and development protocols.

---

## 🚨 MANDATORY RULE: Feature Flags & Rollout Governance

Whenever creating, modifying, or launching **ANY new feature, UI component, game mode, command, or workflow**:

1. **NEVER expose new features directly to 100% of public users on commit.**
2. **ALWAYS wrap new features in `featureFlagService`:**
   ```javascript
   const { isFeatureEnabled, isFeatureEnabledSync } = require('../services/featureFlagService');

   // In async handler:
   if (await isFeatureEnabled('FEATURE_NAME', ctx.from.id, { chatId: ctx.chat?.id, isGroup: ctx.chat?.type !== 'private' })) {
     // Render new feature
   } else {
     // Safe fallback to existing stable behavior
   }

   // Or in synchronous keyboard builder:
   if (isFeatureEnabledSync('FEATURE_NAME', userId)) {
     // Add new button
   }
   ```
3. **Declarative Self-Registration:**
   - Any new `FEATURE_*` key is automatically registered in the system upon first evaluation.
   - Its default rollout state is strictly **`ADMIN_ONLY`** (dogfooding mode).
   - Only admins (`ADMIN_IDS`) can see and test it initially.
4. **Beta Testing & Gradual Rollout Protocol:**
   - **Phase 1: Dogfooding (`ADMIN_ONLY`)** — Tested thoroughly in private and test groups by the bot owner/creator.
   - **Phase 2: Closed Beta (`BETA_USERS`)** — Tested with pilot students and starostas added via `/beta_add <user_id>`.
   - **Phase 3: Canary Rollout (`PERCENT_10`, `PERCENT_25`, `PERCENT_50`)** — Deterministic sticky user bucketing without flickering.
   - **Phase 4: General Availability (`PUBLIC`)** — 100% unlocked once telemetry and error rate remain at zero.
5. **Auto-Kill Switch Integration:**
   - If an error occurs within a new feature, pass the feature key to `errorReporter`:
     ```javascript
     errorReporter.report(err, { source: 'myFeatureHandler', featureKey: 'FEATURE_NAME' });
     ```
   - The Circuit Breaker automatically downgrades the feature to `ADMIN_ONLY` or `OFF` if errors spike (3 errors / 5 min), preventing any widespread bot outage!

---

## 🛠 Coding Standards & Senior-Level Practices

1. **Zero Downtime & Graceful Degradation:**
   - If Redis is down, `featureFlagService` and cache layers must gracefully fall back to local in-memory defaults. Never crash the bot.
2. **Strict HTML/XSS Escaping:**
   - Always sanitize user input using `escapeHtml` before rendering in Telegram HTML messages or HTML widgets. Never trust raw user input.
   - Inside HTML widget views, always use `.textContent` for DOM text insertions, never `.innerHTML` with untrusted strings.
3. **Telegram Callback & Message Limits:**
   - Inline callback data must not exceed 64 bytes (use `safeCallbackData`).
   - Use `TTLMap` with bounded sizes and explicit TTLs for all temporary session states to eliminate memory leaks.
4. **Test-Driven Development (TDD):**
   - Every new feature and fix must have an automated test suite in `scripts/test_*.js`.
   - All tests must pass cleanly (`npm test`) before pushing or creating pull requests.
