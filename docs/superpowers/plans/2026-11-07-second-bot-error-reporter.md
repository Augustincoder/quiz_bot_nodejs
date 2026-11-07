# Second Bot Error Reporting System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate a resilient, flood-protected error reporter using the secondary Telegram bot (`SECOND_BOT`) to immediately alert `ADMIN_ID` of all project runtime errors and red logs.

**Architecture:** A central `errorReporterService` handles deduplication, HTML formatting, Telegram character limits, and safe dispatch via the Telegram Bot API. It hooks into `winston` as a custom Transport (capturing all 174+ `logger.error` calls across the codebase), `index.js` process events (`uncaughtException`, `unhandledRejection`, `bot.catch`), and intercepts `console.error`.

**Tech Stack:** Node.js, Telegraf/Telegram HTTP API, Winston, Dotenv.

**Spec:** `docs/superpowers/specs/2026-11-07-second-bot-error-reporter-design.md`

## Global Constraints

- Never crash the main process if Telegram network fails or `SECOND_BOT` token is invalid.
- Never trigger recursive logging loops when the reporter itself encounters an error.
- Stay under 4096-char Telegram message limit with proper HTML escaping (`<`, `>`, `&`).
- Suppress flood storms: deduplicate identical errors within a 60-second sliding window.
- Filter out benign Telegram user errors (`bot was blocked by the user`, etc.).

## Review Focus

- Malformed or 10,000+ character stack traces: must truncate safely without cutting HTML tags or throwing Telegram Bad Request.
- Error burst of 100 identical errors in 1 second (e.g. database disconnect): must send exactly 1 initial alert immediately and aggregate subsequent duplicates.
- Disconnected network or invalid `SECOND_BOT` token: must fail silently to file/console without unhandled rejection.
- Object-style errors or string errors passed to `logger.error("msg", { err })`: must extract message, stack, and metadata cleanly.
- `console.error` interception: must preserve original terminal output while safely forwarding to the reporter without infinite loops.

---

### Task 1: Configuration & Environment Setup

**Files:**
- Modify: `src/config/config.js`
- Modify: `.env.example`
- Test: `scripts/test_error_reporter.js`

**Interfaces:**
- Produces: `SECOND_BOT: string` exported from `src/config/config.js`.

- [ ] **Step 1: Write initial test for config export**
  Add test asserting `require('./src/config/config').SECOND_BOT !== undefined` in `scripts/test_error_reporter.js`.

- [ ] **Step 2: Run test to verify failure**
  Run: `node scripts/test_error_reporter.js`
  Expected: FAIL (file or export does not exist).

- [ ] **Step 3: Implement `SECOND_BOT` in `src/config/config.js` and `.env.example`**
  Extract `const SECOND_BOT = env('SECOND_BOT', '');` and export it alongside `ADMIN_ID`. Add `SECOND_BOT=` entry in `.env.example`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node scripts/test_error_reporter.js`
  Expected: PASS.

---

### Task 2: Core Error Reporter Service (`errorReporterService.js`)

**Files:**
- Create: `src/services/errorReporterService.js`
- Modify: `scripts/test_error_reporter.js`

**Interfaces:**
- Consumes: `SECOND_BOT`, `ADMIN_ID` from `src/config/config.js`.
- Produces:
  - `report(errorOrMessage, context = {}) -> Promise<boolean>`
  - `formatErrorMessage(errorOrMessage, context = {}) -> string`
  - `isBenignError(message) -> boolean`
  - `clearDedupCache() -> void` (for testing and memory maintenance)

- [ ] **Step 1: Write failing unit tests for `errorReporterService`**
  Test formatting, HTML escaping, 3500-char clamp, deduplication logic (1st sent, 2nd within 60s suppressed), and benign error filtering in `scripts/test_error_reporter.js`.

- [ ] **Step 2: Run test to verify failure**
  Run: `node scripts/test_error_reporter.js`
  Expected: FAIL (`errorReporterService` not found).

- [ ] **Step 3: Implement `errorReporterService.js`**
  Implement:
  - `isBenignError`: matches Telegram common non-critical client errors.
  - `formatErrorMessage`: builds clean HTML card with timestamp (`Asia/Tashkent`), escapes XML entities, truncates stack traces cleanly.
  - Deduplication cache with 60s TTL and count tracker.
  - Safe `sendToTelegram(text)` via HTTPS request to `https://api.telegram.org/bot<SECOND_BOT>/sendMessage`.
  - Anti-recursion protection (`isReporting` flag).

- [ ] **Step 4: Run test to verify it passes**
  Run: `node scripts/test_error_reporter.js`
  Expected: PASS.

---

### Task 3: Winston Logger Integration & Custom Transport

**Files:**
- Modify: `src/core/logger.js`
- Modify: `scripts/test_error_reporter.js`

**Interfaces:**
- Consumes: `errorReporterService.report` from `src/services/errorReporterService.js`.
- Produces: Winston logger instance with custom transport forwarding level `error` to `errorReporterService`.

- [ ] **Step 1: Write test verifying logger error interception**
  Test that `logger.error("Test error message", { extra: 123 })` triggers `errorReporterService.report`.

- [ ] **Step 2: Run test to verify failure**
  Run: `node scripts/test_error_reporter.js`
  Expected: FAIL.

- [ ] **Step 3: Implement Winston Custom Transport in `src/core/logger.js`**
  Subclass `winston.Transport` (or use `winston.format` / transport `log(info, callback)`):
  Forward `info` to `errorReporterService.report(info.message || info, info)` when `info.level === 'error'`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `node scripts/test_error_reporter.js`
  Expected: PASS.

---

### Task 4: Process-level and Global Error Hooks in `index.js`

**Files:**
- Modify: `index.js`
- Modify: `scripts/test_error_reporter.js`

**Interfaces:**
- Consumes: `errorReporterService.report` from `src/services/errorReporterService.js`.

- [ ] **Step 1: Update `index.js` process handlers & `bot.catch`**
  - Connect `process.on('unhandledRejection')` and `process.on('uncaughtException')` to ensure report is sent and flushed.
  - Connect `bot.catch` to enrich the error report with Telegram `ctx` details (user ID, updateType).
  - Wrap `console.error` with a safe spy that forwards to `errorReporterService.report` without breaking standard console output or creating loops.

- [ ] **Step 2: Add integration tests for global handlers in `scripts/test_error_reporter.js`**
  Verify `uncaughtException`, `unhandledRejection`, and `console.error` interception.

- [ ] **Step 3: Run test to verify it passes**
  Run: `node scripts/test_error_reporter.js`
  Expected: PASS.

---

### Task 5: End-to-End Verification & Test Suite Integration

**Files:**
- Modify: `package.json`
- Execute: Full test suite

- [ ] **Step 1: Add `test_error_reporter.js` to `package.json` test script**
- [ ] **Step 2: Run `cmd /c npm test` to ensure all 37 test suites pass without regression**
- [ ] **Step 3: Verify git status and clean branch**
