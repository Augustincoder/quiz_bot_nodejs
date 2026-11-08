# Donate (Qo'llab-quvvatlash) Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-friendly "Donat qilish" (Donate/Support) flow to the bot that displays a 1-tap copyable card number (`CARD_NUMBER` from `.env`, cardholder "Avazov Muhammadamin") and allows users to submit a payment screenshot/receipt that is cleanly forwarded to `ADMIN_ID` with quick reply actions.

**Architecture:** A dedicated `donateHandler.js` handles the donation view, receipt state (`States.DONATE_SCREENSHOT`), and forwarding to admin via Telegram Bot API with quick-reply buttons. `getMainKeyboard` includes the "💖 Donat qilish" button, and `CARD_NUMBER` is exported from `src/config/config.js`.

**Tech Stack:** Node.js, Telegraf, Winston.

## Global Constraints

- Card holder is hardcoded as "Avazov Muhammadamin".
- Card number is loaded from `process.env.CARD_NUMBER` via `src/config/config.js` (with formatted 4-digit grouping for display if 16 digits, and 1-tap copyable `<code>...</code>` block).
- User state `States.DONATE_SCREENSHOT` must be cleanly cleared upon receipt submission, cancellation, or menu navigation (preventing stale wizard state bleed per Bug 48).
- Photos and image documents must be supported for receipt uploads.
- Forwarded message to `ADMIN_ID` must include user metadata (name, username, ID, group, timestamp) and quick-action buttons (`reply_${userId}_${msgId}`, `admin_show_user_${userId}`).

## Review Focus

- Empty or unconfigured `CARD_NUMBER`: must gracefully inform user without crashing.
- User sends non-image text during screenshot wait: must prompt politely without losing state, unless it's a command/menu button (which resets state).
- Group chat safety: donate flow is private chat only; commands in groups should redirect to private chat.
- Safe callback answers: all callback queries must call `safeAnswerCb` to prevent Telegram spinner hangs.

---

### Task 1: Configuration & State Setup

**Files:**
- Modify: `src/config/config.js`
- Modify: `.env.example`
- Modify: `src/core/utils.js`
- Test: `scripts/test_donate_feature.js`

**Interfaces:**
- Produces: `CARD_NUMBER` in `src/config/config.js`
- Produces: `States.DONATE_SCREENSHOT` in `src/core/utils.js`

- [ ] **Step 1: Write failing test in `scripts/test_donate_feature.js`**
  Assert `config.CARD_NUMBER !== undefined` and `States.DONATE_SCREENSHOT === 'donate:screenshot'`.

- [ ] **Step 2: Run test to verify failure (RED)**
  Run: `node scripts/test_donate_feature.js`
  Expected: FAIL.

- [ ] **Step 3: Implement `CARD_NUMBER` in `config.js`, `.env.example` and `States.DONATE_SCREENSHOT` in `utils.js`**

- [ ] **Step 4: Run test to verify it passes (GREEN)**
  Run: `node scripts/test_donate_feature.js`
  Expected: PASS.

---

### Task 2: Donate Handler (`src/handlers/donateHandler.js`)

**Files:**
- Create: `src/handlers/donateHandler.js`
- Modify: `scripts/test_donate_feature.js`

**Interfaces:**
- Produces:
  - `cbDonateMenu(ctx)`
  - `cbDonateSent(ctx)`
  - `cbCancelDonate(ctx)`
  - `onDonateScreenshot(ctx, next)`
  - `formatCardDisplay(cardNumber)`
  - `register(bot)`

- [ ] **Step 1: Write unit tests in `scripts/test_donate_feature.js` for `donateHandler`**
  Test `formatCardDisplay` (formats 16-digit card into 4x4 blocks, escapes HTML), callback response structure, and state changes.

- [ ] **Step 2: Run test to verify failure (RED)**
  Run: `node scripts/test_donate_feature.js`
  Expected: FAIL (`donateHandler` not found).

- [ ] **Step 3: Implement `src/handlers/donateHandler.js`**
  Implement card presentation, receipt upload state, and admin forwarding with user context.

- [ ] **Step 4: Run test to verify it passes (GREEN)**
  Run: `node scripts/test_donate_feature.js`
  Expected: PASS.

---

### Task 3: Keyboards & Index Integration

**Files:**
- Modify: `src/keyboards/keyboards.js`
- Modify: `index.js`
- Modify: `scripts/test_donate_feature.js`

**Interfaces:**
- Consumes: `donateHandler` in `index.js` and `donate_menu` button in `keyboards.js`.

- [ ] **Step 1: Write test verifying `getMainKeyboard()` includes `donate_menu`**

- [ ] **Step 2: Run test to verify failure (RED)**
  Run: `node scripts/test_donate_feature.js`
  Expected: FAIL.

- [ ] **Step 3: Integrate `getMainKeyboard` button and mount `donateHandler` in `index.js`**
  Update `getMainKeyboard()` to pair `💖 Donat qilish` and `📞 Adminga Murojaat` in row 5. Mount in `index.js` handlers and state dispatcher.

- [ ] **Step 4: Run test to verify it passes (GREEN)**
  Run: `node scripts/test_donate_feature.js`
  Expected: PASS.

---

### Task 4: Full Suite Verification & Regression Check

**Files:**
- Modify: `package.json`
- Execute: Full test suite

- [ ] **Step 1: Add `test_donate_feature.js` to `package.json`**
- [ ] **Step 2: Run `cmd /c npm test` to verify all 39 test suites pass**
