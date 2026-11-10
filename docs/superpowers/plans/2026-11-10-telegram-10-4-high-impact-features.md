# Telegram Bot API 10.4: Senior-Level Interactive Features (3D Podium, 3D Blitz-Flashcard & Visual Docx Healer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 3 senior-level interactive features in `quiz_bot_nodejs` leveraging Telegram Bot API 10.4 capabilities (HTML Widgets, WidgetQuery, Ephemeral responses) alongside resilient fallbacks: (1) Group Quiz 3D Top-3 Podium with Private Ephemeral Knowledge Radar & Ghost Coach; (2) 3D Touch/Swipeable Blitz-Flashcard Review Widget (Anki/Quizlet grade); and (3) Docx Visual Smart Healer Widget with AI auto-recovery for glued lines, bold/underlined keys, and corrupted questions.

**Architecture:**
- **Widget Engine (`src/widgets/widgetServer.js`, `src/services/widgetService.js`):** Express-hosted lightweight, standalone interactive HTML5/CSS3/ES6 widgets served on-demand with secure HMAC tokens, bidirectional `widgetQuery` handling, and state synchronization via `editMessageWidgetData`.
- **AI Docx Healer (`src/services/aiDocxHealer.js`, `src/validators/testValidators.js`):** Robust heuristic parser detecting smashed lines, XML bold/underline markers from `mammoth`, Cyrillic/Latin letter mismatches, paired with Gemini AI auto-healing when heuristics need semantic disambiguation.
- **Ghost Coach & Ephemeral Engine (`src/handlers/coreQuiz.js`, `src/handlers/groupQuizLogic.js`):** Restricts public group post to Top 3 (or widget podium), providing a private Ephemeral Result Hub detailing rank percentile, category breakdown radar, mistake karusel, and Ghost Coach encouragement.
- **Blitz-Flashcard Handler (`src/handlers/cramReviewHandler.js`):** Powers both the 3D swipeable HTML widget and the responsive fallback keyboard, featuring swipe gestures, "Bilib oldim" / "Qiyin" spaced repetition bins, and audio TTS toggles.

**Tech Stack:** Node.js (CommonJS), Express, Telegraf 4.x, Redis (`ioredis`), Postgres, Gemini API (`@google/generative-ai`), Mammoth, HTML5/CSS 3D Transforms.

**Spec:** [docs/telegram_bot_api_10_4_innovations_and_roadmap.md](file:///C:/Users/user/code/quiz_bot_nodejs/docs/telegram_bot_api_10_4_innovations_and_roadmap.md)

## Global Constraints
- Clean, senior-level production code: strict error boundaries, no unhandled rejections, zero memory leaks, thorough input sanitization, and XSS prevention in HTML widget templates.
- Strict graceful degradation: Every HTML widget feature MUST have a 100% operational fallback for older Telegram clients (using Ephemeral messages, inline callbacks, or alerts).
- Rate-limit & flood-wait protection: Edits and widget data updates must catch and debounce Telegram 429 and "message is not modified" errors.
- TDD with comprehensive automated verification suites in `scripts/test_*.js`.

## Review Focus
1. **Smashed/Glued Docx text parsing:** Questions and options glued into single paragraphs (e.g. `1. Savol? A) Javob1 B) Javob2 C) Javob3 D) Javob4`) must be separated without losing text or answers.
2. **Bold/Underlined key extraction:** When docx options lack `#` but the teacher formatted the correct option in bold (`<b>`) or underline (`<u>`), the healer must automatically identify and assign `#`.
3. **Concurrent widget queries & double-taps:** User rapidly tapping "Bilib oldim" or "Kalitni tanlash" must be serialized via mutex/Redis token to prevent duplicate saves or race conditions.
4. **Group quiz tie-breakers & edge cases:** When 2 or 3 participants tie in score, rank must be decided deterministically by total response time (in ms), and <3 participants must not render empty podium slots.
5. **Widget security & token authentication:** Widget query tokens must be cryptographically signed (HMAC) to prevent unauthorized tampering or viewing of other students' personal results.

---

### Task 1: Widget Engine & Infrastructure (`src/services/widgetService.js`, `src/widgets/widgetServer.js`)

**Files:**
- Create: `src/services/widgetService.js`
- Create: `src/widgets/widgetServer.js`
- Create: `src/widgets/views/podiumWidget.html`
- Create: `src/widgets/views/flashcardWidget.html`
- Create: `src/widgets/views/docxHealerWidget.html`
- Modify: `index.js:30-70`
- Create: `scripts/test_widget_engine.js`

**Interfaces:**
- Consumes: `BOT_TOKEN`, `config.PORT`, `crypto`
- Produces: `createWidgetToken(userId, type, payload)`, `verifyWidgetToken(token)`, `renderWidgetHtml(type, data)`, `handleWidgetQuery(ctx)`

- [ ] **Step 1: Write failing test for Widget Engine**

Create `scripts/test_widget_engine.js`:
```javascript
'use strict';
const assert = require('assert');
const widgetService = require('../src/services/widgetService');

console.log('🧪 Testing Task 1: Widget Engine & Token Security...');

// 1. Token generation & verification
const testPayload = { chatId: -100123456, testId: 't_99', userId: 12345 };
const token = widgetService.createWidgetToken(12345, 'podium', testPayload);
assert(typeof token === 'string' && token.length > 20, 'Token must be a valid non-empty string');

const verified = widgetService.verifyWidgetToken(token);
assert(verified !== null, 'Valid token must be successfully verified');
assert.strictEqual(verified.userId, 12345);
assert.strictEqual(verified.type, 'podium');
assert.strictEqual(verified.payload.chatId, -100123456);

// Tampered token test
const tamperedToken = token.slice(0, -4) + 'abcd';
const failedVerification = widgetService.verifyWidgetToken(tamperedToken);
assert.strictEqual(failedVerification, null, 'Tampered token must fail verification');

// 2. HTML template renderer exists
assert(typeof widgetService.renderWidgetHtml === 'function', 'renderWidgetHtml must be exported');
const html = widgetService.renderWidgetHtml('flashcard', {
  question: 'Sinov savoli?',
  answer: 'Sinov javobi',
  qIdx: 0,
  total: 10
});
assert(html.includes('Sinov savoli?'), 'Rendered HTML must contain question text');
assert(html.includes('flashcard-container'), 'Rendered HTML must contain CSS structure');

console.log('✅ Task 1 unit tests passed successfully!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_widget_engine.js`  
Expected: FAIL with "Cannot find module '../src/services/widgetService'"

- [ ] **Step 3: Implement `widgetService.js` and `widgetServer.js`**

1. Implement `src/services/widgetService.js`:
   - Cryptographic token generator with HMAC-SHA256 using `BOT_TOKEN`.
   - Token payload caching with TTL (1 hour) in memory / Redis.
   - Template rendering function for `podium`, `flashcard`, and `docxHealer` with XSS-safe escaping.
   - `buildWidgetMessage(type, payload, fallbackText, fallbackKeyboard)`: returns Telegram 10.4 `sendWidget` parameters with automatic fallback to text + inline keyboard for older clients.
2. Implement `src/widgets/widgetServer.js` with Express router endpoints `/widget/:token` serving responsive HTML with modern CSS 3D transforms, touch gestures, and PostMessage/WidgetQuery bridges.
3. Wire `/widget` router into `index.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test_widget_engine.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/widgetService.js src/widgets/ index.js scripts/test_widget_engine.js
git commit -m "feat(widget): implement Telegram 10.4 widget engine and HMAC token security"
```

---

### Task 2: 3D Top-3 Podium & Ephemeral Knowledge Radar (`src/handlers/coreQuiz.js`, `src/handlers/quizGame.js`)

**Files:**
- Modify: `src/handlers/coreQuiz.js:540-800`
- Modify: `src/handlers/quizGame.js:1615-1640`
- Create: `scripts/test_podium_and_ghost_coach.js`

**Interfaces:**
- Consumes: `session.groupScores`, `session.sessionQuestions`, `widgetService.buildWidgetMessage`
- Produces: `formatTop3Podium(scoresMap, totalQuestions)`, `generatePersonalAnalysis(userId, session)`, `cbMyGroupQuizResult(ctx)`

- [ ] **Step 1: Write failing test for Podium & Ghost Coach**

Create `scripts/test_podium_and_ghost_coach.js`:
```javascript
'use strict';
const assert = require('assert');
const coreQuiz = require('../src/handlers/coreQuiz');

console.log('🧪 Testing Task 2: 3D Top-3 Podium & Ghost Coach...');

// 1. Tie-breaker sorting with millisecond response time
const tiedScores = {
  101: { name: 'Ali', correct: 9, wrong: 1, totalTimeMs: 45000 },
  102: { name: 'Vali', correct: 9, wrong: 1, totalTimeMs: 38000 }, // Faster!
  103: { name: 'Gani', correct: 8, wrong: 2, totalTimeMs: 40000 },
  104: { name: 'Salim', correct: 4, wrong: 6, totalTimeMs: 60000 },
};

const podium = coreQuiz.formatTop3Podium(tiedScores, 10);
// Vali should be 1st because of faster time
assert(podium.topEntries[0].name === 'Vali', 'Vali must be 1st due to faster response time');
assert(podium.topEntries[1].name === 'Ali', 'Ali must be 2nd');
assert(podium.topEntries.length === 3, 'Must only include top 3');
assert(!podium.text.includes('Salim'), 'Salim (4th) must not appear in public message');

// 2. Personal Ephemeral Analysis
const mockSession = {
  groupScores: tiedScores,
  sessionQuestions: [
    { question: 'Savol 1', category: 'Algebra', mistakes: [] },
    { question: 'Savol 2', category: 'Geometriya', mistakes: [] },
  ],
  userMistakes: {
    104: [{ question: 'Integral nima?', yourAnswer: 'Funksiya', correctAnswer: 'Boshlang\'ich funksiya' }]
  }
};

const analysis = coreQuiz.generatePersonalAnalysis(104, mockSession);
assert.strictEqual(analysis.rank, 4);
assert.strictEqual(analysis.totalParticipants, 4);
assert(analysis.percentile.includes('%'), 'Must calculate percentile');
assert(analysis.ghostCoachTip.length > 10, 'Must generate Ghost Coach recommendation');
assert(Array.isArray(analysis.mistakesReview), 'Must provide mistake review items');

console.log('✅ Task 2 unit tests passed successfully!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_podium_and_ghost_coach.js`  
Expected: FAIL with "formatTop3Podium is not a function"

- [ ] **Step 3: Implement Podium calculation, Ghost Coach analyzer, and Ephemeral response handler**

1. In `src/handlers/coreQuiz.js`:
   - Implement `formatTop3Podium(scoresMap, totalQuestions)`:
     - Sort descending: `b.correct - a.correct || a.totalTimeMs - b.totalTimeMs`.
     - Slice top 3 entries.
     - Build interactive widget or text summary with podium medals and confetti graphic.
     - Include `[ 📊 Mening Tahlilim (Faqat Menga) ]` callback.
   - Implement `generatePersonalAnalysis(userId, session)`:
     - Computes rank, percentile ranking (`(total - rank + 1) / total * 100`).
     - Category/topic breakdown.
     - Generates constructive, encouraging Ghost Coach AI advice based on mistakes.
   - Implement `cbMyGroupQuizResult(ctx)`:
     - Reads `ctx.from.id`.
     - Responds via Telegram 10.4 `ephemeralMessageParameters` (visible only to clicker).
     - Provides graceful fallback to `answerCbQuery({ show_alert: true })` or private message with clean error handling.
2. Register `my_group_quiz_result` callback in `src/handlers/quizGame.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test_podium_and_ghost_coach.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/coreQuiz.js src/handlers/quizGame.js scripts/test_podium_and_ghost_coach.js
git commit -m "feat(quiz): implement Top-3 podium tie-breakers and ephemeral personal analysis hub"
```

---

### Task 3: 3D Touch/Swipeable Blitz-Flashcard Review Widget (`src/handlers/cramReviewHandler.js`)

**Files:**
- Create: `src/handlers/cramReviewHandler.js`
- Modify: `src/keyboards/keyboards.js`
- Modify: `src/core/bot.js`
- Create: `scripts/test_blitz_flashcard.js`

**Interfaces:**
- Consumes: `SUBJECTS`, `dbService`, `widgetService`
- Produces: `startBlitzFlashcard(ctx, subjectKey, testId)`, `cramReviewHandler.register(bot)`

- [ ] **Step 1: Write failing test for Blitz Flashcard**

Create `scripts/test_blitz_flashcard.js`:
```javascript
'use strict';
const assert = require('assert');
const cramHandler = require('../src/handlers/cramReviewHandler');

console.log('🧪 Testing Task 3: 3D Blitz Flashcard Widget...');

const mockQuestions = [
  { question: 'Q1?', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
  { question: 'Q2?', options: ['W', 'X', 'Y', 'Z'], correct_index: 2 },
];

// Spaced repetition flashcard deck state
const deck = cramHandler.initFlashcardDeck(mockQuestions);
assert.strictEqual(deck.total, 2);
assert.strictEqual(deck.unlearned.length, 2);
assert.strictEqual(deck.learned.length, 0);

// Swipe Right: "Bilib oldim" (Know it)
const afterKnown = cramHandler.processCardAction(deck, 'known', 0);
assert.strictEqual(afterKnown.learned.length, 1);
assert.strictEqual(afterKnown.unlearned.length, 1);

// Swipe Left: "Qiyin / Yana ko'rsat" (Repeat later)
const afterHard = cramHandler.processCardAction(deck, 'repeat', 1);
assert.strictEqual(afterHard.unlearned[afterHard.unlearned.length - 1], 1, 'Hard question must be placed at end of deck');

// HTML Flashcard view data builder
const viewData = cramHandler.buildFlashcardViewData(deck, 'Matematika', '1-Blok');
assert(viewData.progressPercent >= 0);
assert(viewData.currentCard !== null);

console.log('✅ Task 3 unit tests passed successfully!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_blitz_flashcard.js`  
Expected: FAIL with "Cannot find module '../src/handlers/cramReviewHandler'"

- [ ] **Step 3: Implement `cramReviewHandler.js` with 3D touch widget and responsive keyboard fallback**

1. Create `src/handlers/cramReviewHandler.js`:
   - Leitner/Anki spaced-repetition deck manager (`initFlashcardDeck`, `processCardAction`).
   - Telegram 10.4 HTML Widget launcher via `widgetService.buildWidgetMessage` pointing to `flashcardWidget.html` (CSS 3D `rotateY`, touch gestures `touchstart`/`touchmove` for swipe detection).
   - Full keyboard fallback:
     - Row 1: `[ 👁 Javobni ko'rsat / Yashirish ]`
     - Row 2: `[ 👈 Qiyin (Qaytarish) ]  [ 👉 Bilib oldim ]`
     - Row 3: `[ ⚡ 5-daqiqalik Blitz ]  [ 🏁 Chiqish ]`
2. Integrate into `src/keyboards/keyboards.js` in block menus.
3. Register action handlers in `src/core/bot.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test_blitz_flashcard.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/handlers/cramReviewHandler.js src/keyboards/keyboards.js src/core/bot.js scripts/test_blitz_flashcard.js
git commit -m "feat(cram): implement 3D gesture flashcards with spaced repetition and dual fallbacks"
```

---

### Task 4: Docx Visual Smart Healer & Multi-Error AI Engine (`src/services/aiDocxHealer.js`, `src/validators/testValidators.js`, `src/handlers/testCreation.js`)

**Files:**
- Create: `src/services/aiDocxHealer.js`
- Modify: `src/validators/testValidators.js`
- Modify: `src/handlers/testCreation.js:2040-2160`
- Create: `scripts/test_smart_docx_healer.js`

**Interfaces:**
- Consumes: `mammoth`, `aiService.js`, `validateQuestion`
- Produces: `aiDocxHealer.healSmashedLine(text)`, `aiDocxHealer.detectFormattedKey(xmlOrHtml)`, `aiDocxHealer.batchAutoHeal(invalidQuestions)`

- [ ] **Step 1: Write failing test for Smart Docx Healer**

Create `scripts/test_smart_docx_healer.js`:
```javascript
'use strict';
const assert = require('assert');
const aiDocxHealer = require('../src/services/aiDocxHealer');

console.log('🧪 Testing Task 4: Docx Multi-Error AI & Visual Healer...');

// 1. Smashed line: Question and options on a single unformatted line
const smashedLine = "15. Axborot xavfsizligining 3 ta ustuni nima? A) Konfidensiallik, yaxlitlik, mavjudlik B) Tezlik, hajm, sifat C) Parol, login, kod D) Barcha javoblar noto'g'ri";
const healed1 = aiDocxHealer.healSmashedLine(smashedLine);
assert(healed1.success, 'Healer must separate smashed single line');
assert.strictEqual(healed1.questionText, 'Axborot xavfsizligining 3 ta ustuni nima?');
assert.strictEqual(healed1.options.length, 4);
assert.strictEqual(healed1.options[0].cleanText, 'Konfidensiallik, yaxlitlik, mavjudlik');

// 2. Bold / Underlined / Asterisk key detection
const htmlSnippetWithBold = `<p>O'zbekiston BMTga qachon a'zo bo'lgan?</p>
<p>A) 1991-yil</p>
<p><b>B) 1992-yil 2-mart</b></p>
<p>C) 1993-yil</p>
<p>D) 1994-yil</p>`;

const boldDetected = aiDocxHealer.detectFormattedKey(htmlSnippetWithBold);
assert.strictEqual(boldDetected.correctIndex, 1, 'Must detect option B as correct due to <b> tag');

// 3. Cyrillic/Latin letter mismatch normalization
const mixedText = "А) Variant 1\nB) Variant 2\nС) Variant 3\nD) Variant 4"; // Cyrillic А and С
const normalized = aiDocxHealer.normalizeOptionPrefixes(mixedText);
assert(!normalized.includes('А)'), 'Cyrillic А must be normalized to Latin A');
assert(!normalized.includes('С)'), 'Cyrillic С must be normalized to Latin C');

console.log('✅ Task 4 unit tests passed successfully!');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test_smart_docx_healer.js`  
Expected: FAIL with "Cannot find module '../src/services/aiDocxHealer'"

- [ ] **Step 3: Implement `src/services/aiDocxHealer.js` and connect to `testCreation.js`**

1. Create `src/services/aiDocxHealer.js`:
   - `healSmashedLine(rawText)`: Regex & heuristic splitter for patterns like `(?=[A-Da-d][\)\.\-])` or `(?=[1-4][\)\.\-])`.
   - `detectFormattedKey(htmlOrXml)`: Parses tags like `<b>`, `<strong>`, `<u>`, `<mark>`, `*bold*`, `+option` to detect author's intended key without `#`.
   - `normalizeOptionPrefixes(text)`: Converts Cyrillic `А, В, С, Д, Е` to Latin `A, B, C, D, E`.
   - `batchAutoHeal(invalidQuestions, geminiApiKey)`: Auto-fixes all repairable questions via regex + Gemini fallback for complex multi-line breaks.
2. In `src/handlers/testCreation.js`:
   - Replace manual copy-paste text prompt with:
     - 1-Tap "✨ AI Barchasini Avto-Tuzatish" (`fix_auto_all`).
     - Visual Key Buttons for each extracted option.
     - Interactive Web Inspector Widget button (`fix_open_web_inspector`).
3. Wire up actions in `testCreation.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test_smart_docx_healer.js`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/aiDocxHealer.js src/validators/testValidators.js src/handlers/testCreation.js scripts/test_smart_docx_healer.js
git commit -m "feat(docx): implement AI multi-error healer, bold/underline key detection and visual inspector"
```

---

### Task 5: Master Integration, Security & Performance Verification

**Files:**
- Create: `scripts/test_master_interactive_suite.js`
- Modify: `package.json:scripts.test`

- [ ] **Step 1: Write master integration verification runner**

Create `scripts/test_master_interactive_suite.js`:
```javascript
'use strict';
const { execSync } = require('child_process');

console.log('🚀 Running Full Senior-Level Interactive Test Suite...\n');

execSync('node scripts/test_widget_engine.js', { stdio: 'inherit' });
execSync('node scripts/test_podium_and_ghost_coach.js', { stdio: 'inherit' });
execSync('node scripts/test_blitz_flashcard.js', { stdio: 'inherit' });
execSync('node scripts/test_smart_docx_healer.js', { stdio: 'inherit' });

console.log('\n🎉 ALL SENIOR-LEVEL INTERACTIVE FEATURES VERIFIED WITH ZERO ERRORS!');
```

- [ ] **Step 2: Run test suite**

Run: `node scripts/test_master_interactive_suite.js`  
Expected: PASS with 0 exit code.

- [ ] **Step 3: Update `package.json` test script**

Ensure `package.json` runs `node scripts/test_master_interactive_suite.js`.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/test_master_interactive_suite.js
git commit -m "test: verify complete interactive telegram 10.4 suite"
```
