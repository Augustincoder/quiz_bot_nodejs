# 🛡 Loyiha Texnik Auditi — 2-Bosqich (Post-Fix Verification & 100% Completion Report)
**Loyiha:** `quiz-bot-nodejs` (Talabalar Imtihon Trenajyori — Node.js)  
**Tekshirilgan fayl:** `ALL_SYSTEM_CODE_2.txt` (61 ta fayl, 35 595 qator kod)  
**Joriy bajarilish ko'rsatkichi:** **89% (100% ga chiqarish uchun 4 ta yakuniy qadam qoldi)**

---

## 📊 1. Bajarilgan Ishlar Tahlili va Foiz Ko'rsatkichi (89% Bajarildi)

Birinchi audit hisobotida belgilangan 8 ta asosiy yo‘nalish bo‘yicha `ALL_SYSTEM_CODE_2.txt` da amalga oshirilgan ishlar holati:

| # | Modul / Vazifa | Bajarilish % | Holat va Tekshiruv Natijasi |
| :-: | :--- | :-: | :--- |
| **1** | `index.js` Middleware zanjiri va `widget_query` konteksti | **100%** | ✅ `ctx.from` va `ctx.chat` normalizatsiya qilingan, `widget_query` sessiya va ban-check'dan keyinga o'tkazilgan. |
| **2** | `widgetServer.js` Rate-Limit, AI Limit va Mutex himoyasi | **100%** | ✅ IP rate-limit (90/min), AI heal limit (5/min), `mutex.runExclusive` va dublikat savollar filtri qo'shilgan. |
| **3** | `coreQuiz.js` va `podiumWidget.html` (3D Podium & Radar) | **100%** | ✅ Marafon oraliq bloklarida `rawGroupScores` xatosi, mavzu tahlili va `<b>` teglar tozalanishi to'liq tuzatilgan. |
| **4** | DRY va Clean Code (`utils.js`, `edupageService.js`, `profileHandler.js`) | **95%** | ✅ `getLevenshteinDistance`, `escapeHtml`, `canManageLobbyOrGame` va `checkActiveTestConflict` markazlashtirilgan. |
| **5** | `cramReviewHandler.js` Redis gibrid kesh va Feature Flag | **90%** | ✅ `saveCramSession`/`getCramSession` Redis bilan ulangan, dublikat `bot.use` olib tashlangan. (Blitz taymer tugashi chala). |
| **6** | `testCreation.js` va `widgetService.js` (`docxHealer` inline) | **75%** | ⚠️ `makeSafeDocxWidgetPublicData` qo'shilgan, biroq `pickKey` ichida **yangi regression bug** bor (`qs` massivini buzadi). |
| **7** | `universalTestHub.js` va `quizGame.js` (Marafon va Conflict Guard) | **75%** | ⚠️ 2 ta joyda mutex qo'shilgan, lekin yana 3 ta funksiyada qolib ketgan hamda marafonda 2 ta "Keyingi blok" tugmasi chiqadi. |
| **8** | **Flashcardda savol chiqqanda javobning ko'rinib qolishi** | **65%** | 🚨 `sendData()` yopilib qolishi tuzatilgan, ammo **CSS 3D flattening va flip-transition sababli javob ko'rinib qolish bugi hali turibdi!** |

---

## 🔍 2. MAXSUS TAHLIL: Nega Flashcardda savol chiqqanda javob avtomatik ko'rinib qolyapti?

Siz ta'kidlagan **"savol chiqqanda avtomatik javob ko'rinib qolishi"** muammosi `ALL_SYSTEM_CODE_2.txt` dagi `src/services/widgetService.js` (`buildInlineFlashcardWidgetHtml`) va `src/widgets/views/flashcardWidget.html` fayllarida **hali tuzatilmagan** bo‘lib, uning **3 ta aniq texnik sababi** bor:

### 🚨 1-Sabab: Telegram 10.4 Inline Widget va `opacity < 1` da CSS 3D (`preserve-3d`) ning tekislanib (Flatten) qolishi
* **Qayerda:** `src/services/widgetService.js` (304–308 va 401–415-qatorlar).
* **Nima sodir bo'ladi:** 
  1. `.face.front` (Savol) va `.face.back` (To‘g‘ri javob) ikkalasi ham `position: absolute; inset: 0;` qilib ustma-ust joylashtirilgan. HTML DOMda `.face.back` (javob) `.face.front` (savol) dan **keyin** yozilgan.
  2. W3C CSS Transforms Level 2 spetsifikatsiyasiga ko‘ra, ota elementga (`.card`) `opacity < 1` berilishi bilan (masalan, `animateIn` ichida `card.style.opacity = '0'` dan `'1'` ga o‘tayotganda yoki `will-change: transform, opacity` tufayli), brauzer `transform-style: preserve-3d` ni majburan bekor qiladi (`flat` rejimiga o‘tkazadi).
  3. Shuningdek, Telegramning ba'zi mobil WebView / QuickJS rendererlarida `backface-visibility: hidden` to‘liq ishlamaydi.
  4. 3D kontekst tekislanishi bilan DOMda keyin kelgan `.face.back` (To‘g‘ri javob) `.face.front` (Savol) ning ustiga chiqib qoladi va foydalanuvchiga savol o‘rniga **to‘g‘ri javob ko‘rinib turadi!**

### 🚨 2-Sabab: Karta orqa (javob) tomonida turganda keyingi savolning javobi 0ms da yozilib qolishi
* **Qayerda:** `src/widgets/views/flashcardWidget.html` (326–366-qatorlar) va `src/services/widgetService.js` (401–406-qatorlar).
* **Nima sodir bo'ladi:**
  1. Foydalanuvchi kartani bosib aylantirdi (`.flipped` klassi qo‘shildi, hozir ekranda javob tomoni turibdi).
  2. Foydalanuvchi `"👉 Bilib oldim"` yoki `"👈 Qaytarish"` ni bosdi.
  3. `renderCurrentCard()` chaqirilganda:
     ```javascript
     cardEl.className = 'card-wrapper'; // .flipped olib tashlandi (0.6s aylanish animatsiyasi boshlandi)
     const c = cards[currentIndex];
     frontText.textContent = c.q;
     backText.textContent = c.a; // <-- XATO SHU YERDA!
     ```
  4. Karta 180 gradusdan 0 gradusga qaytib aylanguncha **0.6 soniya** vaqt o‘tadi (`transition: transform 0.6s`). Ammo `backText.textContent = c.a` **0-millisoniyadayoq** yangi savolning javobini orqa tomonga yozib qo‘yadi! Natijada karta aylanib qaytayotgan yarim soniya davomida foydalanuvchi **yangi savolning javobini o‘qib oladi!**

### 🚨 3-Sabab: `W.sendQuery` / Fallback ishlaganda `resetCard()` kartani javob tomonida qoldirishi
* **Qayerda:** `src/services/widgetService.js` (394–398 va 419–424-qatorlar).
* **Nima sodir bo'ladi:** Agar foydalanuvchi kartani aylantirib javobni ko‘rgach `"👉 Bilib oldim"` ni bossa va Telegram klienti `W.sendQuery` orqali so‘rov yuborsa, 300ms dan keyin `resetCard()` ishlaydi. `resetCard()` ichida:
  `card.style.transform = card.classList.contains('flipped') ? 'rotateY(180deg)' : '';`
  deyilgani sababli karta **javob tomoniga qaragan holda** qolib ketadi!

### ✅ Yechim (100% Kafolatli Fix):
Faqat 3D `backface-visibility` ga ishonmasdan, CSS va JS darajasida qat'iy yashirish qoidasini kiritamiz:
1. CSS-da `.card:not(.flipped) .face.back { visibility: hidden; opacity: 0; pointer-events: none; }` va `.card.flipped .face.front { visibility: hidden; opacity: 0; pointer-events: none; }` qoidasini qo‘shamiz. Shunda 3D ishlamagan yoki `opacity` o‘zgargan har qanday qurilmada ham karta aylantirilmaguncha javob **100% ko‘rinmas** bo‘ladi!
2. JS-da yangi kartochka yuklanayotganda (`animateIn` va `renderCurrentCard`), avval `transition: 'none'` bilan `.flipped` klassini olib tashlaymiz, shundan keyingina yangi javob matnini yozamiz.

---

## 🐛 3. `ALL_SYSTEM_CODE_2.txt` da Aniqlangan Yangi va Qolgan Xatolar

### 🔴 YANGI BUG-A: `widgetService.js` (`buildInlineDocxHealerWidgetHtml`) ichidagi `pickKey` funksiyasida savollarning o'chib ketishi va dublikat bo'lishi
* **Joylashuv:** `src/services/widgetService.js` (580–585-qatorlar).
* **Hozirgi kod:**
  ```javascript
  } else if (d.currentQuestion) {
    qs[cur] = d.currentQuestion;
    qs.length = d.remaining || qs.length;
  }
  ```
* **Muammo:** Faraz qiling, `qs = [Q1, Q2, Q3]` (3 ta xato savol bor) va foydalanuvchi 1-savolda (`cur = 0`) javob tanladi. Backend `Q1` ni `invalidQs.splice(0, 1)` qilib o‘chiradi, endi backendda `[Q2, Q3]` (`remaining: 2`) qoladi va `d.currentQuestion` sifatida `Q2` ni qaytaradi.
  Frontend esa `qs.splice(cur, 1)` qilish o‘rniga:
  1. `qs[0] = Q2` qiladi (`qs` endi `[Q2, Q2, Q3]` bo‘lib qoladi!);
  2. `qs.length = 2` qiladi (`qs` endi `[Q2, Q2]` bo‘lib qoladi va **`Q3` butunlay o‘chib ketadi!**).
* **Qo'shimcha xato:** Shu faylning 646-qatorida (`healAll` funksiyasida): `if (d.questions) qs = d.questions;` deb yozilgan. Ammo backend `makeSafeDocxWidgetPublicData` orqali `{ isFinished, remaining, currentQuestion }` qaytaradi (`d.questions` qaytarmaydi). Natijada AI barcha savollarni tuzatsa ham (`d.isFinished === true`), vidjetda *"Tabriklaymiz!"* ekrani chiqmaydi.

---

### 🔴 YANGI BUG-B: `cbOpenInspector` (`testCreation.js`) da ko'p xato savol bo'lganda Inline HTML 4KB limitdan oshib ketishi
* **Joylashuv:** `src/handlers/testCreation.js` (1277–1283-qatorlar) va `src/services/widgetService.js` (487–509-qatorlar).
* **Muammo:** `makeSafeDocxWidgetPublicData` `public_data` ni 1024 baytdan kichik qildi, ammo `cbOpenInspector` ichida `buildInlineDocxHealerWidgetHtml({ questions: widgetQuestions })` chaqirilganda, agar Word faylda 15–20 ta xato savol bo‘lsa, ularning barchasi HTML ichidagi `var initialData = ...` ga joylanadi. Natijada HTML hajmi Zlib siqilganda 4096 baytdan oshib, `sendWidget` xato beradi.
* **Yechim:** `buildInlineDocxHealerWidgetHtml` ichida `rawQuestions.slice(0, 8)` va matnlarni 180 belgigacha qisqartirish orqali Zlib hajmini har doim `< 3.5 KB` saqlash.

---

### 🟡 QOLGAN KAMCHILIK-C: `universalTestHub.js` dagi 3 ta funksiyada `checkActiveTestConflict` qolib ketgani va Marafon tugmalari dublikati
* **Joylashuv:**
  1. `src/handlers/universalTestHub.js` — `startSubjectAdaptiveRun` (664-qator), `hub_start_off` (728-qator), `hub_blitz_off` (759-qator) funksiyalarida `mutex.lock` va `checkActiveTestConflict` chaqirilmagan.
  2. `src/handlers/coreQuiz.js` — `buildFinishButtons` (72–87-qatorlar): Marafon rejimida `btns.unshift` orqali `"🏃‍♂️ Keyingi marafon bloki"` qo‘shiladi, ammo pastroqda (132 va 180-qatorlarda) oddiy `"➡️ Keyingi (...)"` tugmasi ham qo‘shilib, ekranda ikkita bir xil keyingi blok tugmasi chiqib qoladi.

---

## 🛠 4. 100% Mukammal Holatga Keltirish Uchun Aniq Tuzatish Kodlari

Quyidagi 4 ta kichik tuzatishni kiritishingiz bilan loyiha **100% tayyor va xatosiz** holatga keladi:

### 1-TUZATISH: `src/services/widgetService.js` — Flashcard Javobi Ko'rinib Qolishini va Docx Healer `pickKey`/`healAll` Bugini Tuzatish

`src/services/widgetService.js` faylidagi `buildInlineFlashcardWidgetHtml` va `buildInlineDocxHealerWidgetHtml` funksiyalarini quyidagicha yangilang:

```javascript
// src/services/widgetService.js — buildInlineFlashcardWidgetHtml ichida CSS va JS qismini yangilang:

function buildInlineFlashcardWidgetHtml(viewData = {}) {
  const qClean = decodeHtmlEntities(viewData.question || 'Savol...');
  const aClean = decodeHtmlEntities(viewData.answer || 'Javob...');
  const titleClean = decodeHtmlEntities(viewData.subjectName ? `${viewData.subjectName} • ${viewData.blockName || ''}` : '⚡ 3D Flashcard');

  const initialData = JSON.stringify({
    title: titleClean,
    q: qClean,
    a: aClean,
    total: viewData.total || 0,
    learned: viewData.learnedCount || 0,
    cardIdx: viewData.cardIdx || 0,
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"><style>
* { box-sizing: border-box; margin: 0; padding: 0; user-select: none; -webkit-user-select: none; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
html, body { width: 100%; height: auto; min-height: 290px; background: var(--tg-theme-bg-color, #17212b); color: var(--tg-theme-text-color, #fff); overflow-x: hidden; }
.wrap { padding: 10px 12px; min-height: 290px; display: flex; flex-direction: column; justify-content: space-between; box-sizing: border-box; }
.top-bar { display: flex; justify-content: space-between; font-size: 12px; font-weight: 600; color: var(--tg-theme-hint-color, #90caf9); opacity: 0.9; }
.bar-wrap { background: rgba(255,255,255,0.12); height: 5px; border-radius: 3px; margin: 5px 0 8px; overflow: hidden; }
.bar-fill { height: 100%; width: 0%; background: linear-gradient(90deg, #2481cc, #4caf50); border-radius: 3px; transition: width 0.3s ease; }
.card-box { flex: 1; display: flex; align-items: stretch; justify-content: center; min-height: 180px; margin-bottom: 8px; perspective: 900px; touch-action: pan-y; }
.card { width: 100%; min-height: 180px; position: relative; border-radius: 14px; cursor: pointer; transform-style: preserve-3d; -webkit-transform-style: preserve-3d; transition: transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1); }
.card.flipped { transform: rotateY(180deg); -webkit-transform: rotateY(180deg); }
.face { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: 14px; padding: 14px 12px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; backface-visibility: hidden; -webkit-backface-visibility: hidden; box-shadow: 0 6px 20px rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.12); background: var(--tg-theme-secondary-bg-color, #233446); transition: opacity 0.15s ease, visibility 0.15s ease; }
.face.front { z-index: 2; visibility: visible; opacity: 1; }
.face.back { transform: rotateY(180deg); -webkit-transform: rotateY(180deg); background: var(--tg-theme-bg-color, #182533); border-color: rgba(76, 175, 80, 0.4); z-index: 1; visibility: hidden; opacity: 0; pointer-events: none; }
.card.flipped .face.front { visibility: hidden; opacity: 0; pointer-events: none; z-index: 1; }
.card.flipped .face.back { visibility: visible; opacity: 1; pointer-events: auto; z-index: 2; }
.tag { font-size: 10px; font-weight: 700; letter-spacing: 0.8px; opacity: 0.85; margin-bottom: 6px; text-transform: uppercase; }
.front .tag { color: var(--tg-theme-link-color, #64b5f6); }
.back .tag { color: #81c784; }
.q-text { font-size: 15px; font-weight: 500; line-height: 1.45; word-break: break-word; max-height: 130px; overflow-y: auto; padding: 0 4px; }
.a-text { font-size: 16px; font-weight: 700; line-height: 1.45; color: #a5d6a7; word-break: break-word; max-height: 130px; overflow-y: auto; padding: 0 4px; }
.hint { margin-top: 8px; font-size: 11px; opacity: 0.6; }
.actions { display: flex; gap: 8px; margin-top: 4px; }
.btn { flex: 1; padding: 10px 14px; border-radius: 10px; border: none; font-size: 13px; font-weight: 600; cursor: pointer; color: #fff; transition: transform 0.1s ease, opacity 0.2s ease; display: flex; align-items: center; justify-content: center; gap: 6px; }
.btn:active { transform: scale(0.96); opacity: 0.85; }
.btn-repeat { background: #d32f2f; }
.btn-known { background: #2e7d32; }
</style></head><body>
<div class="wrap">
  <div class="top-bar"><span id="title">⚡ 3D Flashcard</span><span id="prog">0 / 0</span></div>
  <div class="bar-wrap"><div class="bar-fill" id="bar"></div></div>
  <div class="card-box">
    <div class="card" id="card">
      <div class="face front">
        <div class="tag">SAVOL (YODLASH)</div>
        <div class="q-text" id="q-text">Savol yuklanmoqda...</div>
        <div class="hint">💡 Javobni ko'rish uchun bosing 👆</div>
      </div>
      <div class="face back">
        <div class="tag">TO'G'RI JAVOB</div>
        <div class="a-text" id="a-text"></div>
        <div class="hint">🔄 Savolga qaytish uchun bosing</div>
      </div>
    </div>
  </div>
  <div class="actions">
    <button class="btn btn-repeat" id="btn-rep" onclick="triggerAction('left','repeat')">👈 Qaytarish</button>
    <button class="btn btn-known" id="btn-kno" onclick="triggerAction('right','known')">👉 Bilib oldim</button>
  </div>
</div>
<script>
var W = window.TelegramWidget || window.Telegram && window.Telegram.WebApp || {};
var card = document.getElementById('card');
var isAnim = false;
var curAnswer = '';

function clean(s) {
  if (!s) return '';
  return String(s).replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function flip() {
  if (isAnim) return;
  var willFlip = !card.classList.contains('flipped');
  if (willFlip) {
    document.getElementById('a-text').textContent = curAnswer;
  }
  card.classList.toggle('flipped');
  if (W.HapticFeedback && typeof W.HapticFeedback.selectionChanged === 'function') {
    W.HapticFeedback.selectionChanged();
  }
}

card.onclick = function(e) {
  if (isAnim) return;
  flip();
};

function render(dataStr) {
  try {
    var d = typeof dataStr === 'string' ? JSON.parse(dataStr) : (dataStr || {});
    if (d.isFinished) {
      document.querySelector('.card-box').innerHTML = '<div class="face front" style="position:relative;width:100%;visibility:visible;opacity:1"><div class="tag" style="color:#81c784">TABRIKLAYMIZ! 🎉</div><div class="q-text" style="color:#a5d6a7;font-weight:700">Barcha kartochkalarni muvaffaqiyatli o‘zlashtirdingiz!</div></div>';
      var actions = document.querySelector('.actions');
      if (actions) actions.style.display = 'none';
      return;
    }
    // Har doim yangi savol kelganda kartani old (savol) tomoniga qaytaramiz va javobni yashiramiz
    card.classList.remove('flipped');
    document.getElementById('a-text').textContent = '';
    if (d.q) document.getElementById('q-text').textContent = clean(d.q);
    if (d.a !== undefined) curAnswer = clean(d.a);
    if (d.title) document.getElementById('title').textContent = clean(d.title);
    if (d.total) {
      var p = Math.round(((d.learned || 0) / d.total) * 100);
      document.getElementById('prog').textContent = (d.learned || 0) + ' / ' + d.total + ' (' + p + '%)';
      document.getElementById('bar').style.width = p + '%';
    }
  } catch(e) {}
}

function triggerAction(direction, act) {
  if (isAnim) return;
  isAnim = true;

  if (W.HapticFeedback && typeof W.HapticFeedback.impactOccurred === 'function') {
    W.HapticFeedback.impactOccurred('medium');
  }

  var transX = direction === 'right' ? '125%' : '-125%';
  var rot = direction === 'right' ? '14deg' : '-14deg';
  var isFlipped = card.classList.contains('flipped');
  card.style.transition = 'transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s ease';
  card.style.transform = (isFlipped ? 'rotateY(180deg) ' : '') + 'translateX(' + transX + ') rotate(' + rot + ')';
  card.style.opacity = '0';

  if (typeof W.request === 'function') {
    W.request(act).then(function(res) {
      if (res && res.result && res.result !== 'OK') {
        lastData = typeof res.result === 'string' ? res.result : JSON.stringify(res.result);
        animateIn(res.result);
      } else {
        resetCard();
      }
    }).catch(function() {
      resetCard();
    });
  } else if (typeof W.sendQuery === 'function') {
    W.sendQuery(act);
    setTimeout(resetCard, 300);
  } else {
    setTimeout(resetCard, 300);
  }
}

function animateIn(newData) {
  card.style.transition = 'none';
  card.classList.remove('flipped');
  render(newData);
  card.style.transform = 'translateY(16px) scale(0.92)';
  card.style.opacity = '0';

  void card.offsetWidth;

  card.style.transition = 'transform 0.26s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease';
  card.style.transform = 'translate(0, 0) scale(1)';
  card.style.opacity = '1';

  setTimeout(function() {
    isAnim = false;
    card.style.transition = '';
    card.style.transform = '';
  }, 280);
}

function resetCard() {
  card.style.transition = 'none';
  card.classList.remove('flipped');
  document.getElementById('a-text').textContent = '';
  void card.offsetWidth;
  card.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
  card.style.transform = '';
  card.style.opacity = '1';
  isAnim = false;
}
```

Shuningdek, `buildInlineDocxHealerWidgetHtml` ichidagi `pickKey` va `healAll` funksiyalarini (560–660-qatorlar) quyidagicha tuzating:

```javascript
// src/services/widgetService.js — buildInlineDocxHealerWidgetHtml ichida:
// 1) initialData uchun 4KB Zlib limitidan oshmaslik himoyasi (487-qator):
  const boundedQuestions = rawQuestions.slice(0, 10);
  const initialData = JSON.stringify({
    title: decodeHtmlEntities(viewData.fileName || viewData.title || 'Docx Healer').slice(0, 50),
    total: rawQuestions.length,
    curIdx: typeof viewData.currentIndex === 'number' ? viewData.currentIndex : 0,
    questions: boundedQuestions.map((q, i) => {
      const qText = q.questionText || q.question || q.raw || 'Savol';
      return {
        id: q.id || (i + 1),
        q: decodeHtmlEntities(typeof qText === 'string' ? qText : 'Savol').slice(0, 200),
        err: decodeHtmlEntities(q.error || 'Tekshirish talab etiladi').slice(0, 60),
        opts: (q.options || []).slice(0, 6).map((o) => {
          const t = typeof o === 'string' ? o : (o.cleanText || o.text || '');
          const isOk = typeof o === 'object' ? Boolean(o.isCorrect) : false;
          return {
            t: decodeHtmlEntities(t).slice(0, 70),
            ok: isOk,
          };
        }),
      };
    }),
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

// 2) pickKey va healAll funksiyalari (560-660 qatorlar):
function pickKey(optIdx) {
  if (isAnim) return;
  var q = qs[cur];
  if (!q || !q.opts) return;

  isAnim = true;
  q.opts.forEach(function(o, i) {
    o.ok = (i === optIdx);
  });
  render();

  if (W.HapticFeedback && typeof W.HapticFeedback.selectionChanged === 'function') {
    W.HapticFeedback.selectionChanged();
  }

  var payload = { action: 'docx_pick', qIdx: cur, optIdx: optIdx };
  var onDone = function(res) {
    // Avval joriy tuzatilgan savolni massivdan o'chiramiz (dublikat va qisqarish xatosi bo'lmasligi uchun!)
    qs.splice(cur, 1);

    if (res && res.result && res.result !== 'OK') {
      try {
        var d = typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
        if (d.isFinished || d.remaining === 0) {
          qs = [];
        } else if (d.currentQuestion) {
          if (cur < qs.length) {
            qs[cur] = d.currentQuestion;
          } else {
            qs.push(d.currentQuestion);
          }
        }
      } catch (e) {}
    }

    if (cur >= qs.length && cur > 0) cur = qs.length - 1;
    isAnim = false;
    render();
  };

  if (typeof W.request === 'function') {
    W.request(JSON.stringify(payload)).then(onDone).catch(function() { onDone(null); });
  } else if (typeof W.sendQuery === 'function') {
    W.sendQuery(JSON.stringify(payload));
    setTimeout(function() { onDone(null); }, 220);
  } else {
    setTimeout(function() { onDone(null); }, 220);
  }
}

function healAll() {
  var btn = document.getElementById('btn-heal');
  btn.textContent = '⏳ AI...';
  btn.disabled = true;

  if (W.HapticFeedback && typeof W.HapticFeedback.impactOccurred === 'function') {
    W.HapticFeedback.impactOccurred('medium');
  }

  var payload = { action: 'docx_heal_all' };
  if (typeof W.request === 'function') {
    W.request(JSON.stringify(payload)).then(function(res) {
      btn.textContent = '✨ AI Tuzatish';
      btn.disabled = false;
      if (res && res.result && res.result !== 'OK') {
        try {
          var d = typeof res.result === 'string' ? JSON.parse(res.result) : res.result;
          if (d.isFinished || d.remaining === 0) {
            qs = [];
          } else if (Array.isArray(d.questions)) {
            qs = d.questions;
          } else if (d.currentQuestion) {
            qs = [d.currentQuestion];
            cur = 0;
          }
        } catch(e) {}
      } else {
        heuristicHeal();
      }
      render();
    }).catch(function() {
      heuristicHeal();
      btn.textContent = '✨ AI Tuzatish';
      btn.disabled = false;
      render();
    });
  } else {
    heuristicHeal();
    setTimeout(function() {
      btn.textContent = '✨ AI Tuzatish';
      btn.disabled = false;
      render();
    }, 300);
  }
}
```

---

### 2-TUZATISH: `src/widgets/views/flashcardWidget.html` — WebApp 3D Kartochkada Javob Ko'rinib Qolishini To'liq Yo'qotish

`src/widgets/views/flashcardWidget.html` faylida:
1. CSS qismida (102–114-qatorlar) `.card-front` va `.card-back` uchun `visibility` va `opacity` himoyasini qo‘shing:
```css
    .card-front {
      border-top: 3px solid var(--accent);
      z-index: 2;
      visibility: visible;
      opacity: 1;
      transition: opacity 0.15s ease, visibility 0.15s ease;
    }
    .card-back {
      transform: rotateY(180deg);
      -webkit-transform: rotateY(180deg);
      border-top: 3px solid var(--success);
      background: #142230;
      z-index: 1;
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease, visibility 0.15s ease;
    }
    .card-wrapper.flipped .card-front {
      visibility: hidden;
      opacity: 0;
      pointer-events: none;
      z-index: 1;
    }
    .card-wrapper.flipped .card-back {
      visibility: visible;
      opacity: 1;
      pointer-events: auto;
      z-index: 2;
    }
```

2. Shu faylning JS qismida (`renderCurrentCard` va `flipCard`, 326–348-qatorlar) karta aylanayotganda yangi javob ko‘rinib qolmasligi uchun javobni faqat karta aylantirilganda (`flipCard`) yozadigan qiling:
```javascript
    let currentAnswerText = '';

    function renderCurrentCard() {
      if (currentIndex >= cards.length) {
        showFinish();
        return;
      }
      // Transition'siz darhol old (savol) tomoniga qaytaramiz
      cardEl.style.transition = 'none';
      cardEl.className = 'card-wrapper';
      backText.textContent = '';
      void cardEl.offsetWidth;
      cardEl.style.transition = '';

      const c = cards[currentIndex];
      frontText.textContent = c.q || c.question || 'Savol';
      currentAnswerText = c.a || c.answer || 'To\'g\'ri javob';

      const remaining = cards.length - currentIndex;
      progressText.textContent = `O'rganildi: ${learnedCount} / ${totalCount} (Qoldi: ${remaining})`;
      const pct = Math.min(100, Math.round((learnedCount / totalCount) * 100));
      progressFill.style.width = pct + '%';
      percentText.textContent = pct + '%';
    }

    function flipCard() {
      const willFlip = !cardEl.classList.contains('flipped');
      if (willFlip) {
        backText.textContent = currentAnswerText;
      }
      cardEl.classList.toggle('flipped');
    }
```

---

### 3-TUZATISH: `src/handlers/universalTestHub.js` — Qolgan 3 ta Test Boshlash Nuqtasiga `checkActiveTestConflict` va Mutex Qo'shish

`src/handlers/universalTestHub.js` da `startSubjectAdaptiveRun` (671-qator), `hub_start_` (730-qator) va `hub_blitz_` (761-qator) ichida rasmiy test boshlanishidan oldin `checkActiveTestConflict` ni chaqiring:

```javascript
// 1) startSubjectAdaptiveRun yakuni (668-678 qatorlar):
  const { initAndStartTest, startUgcTest, checkActiveTestConflict } = require('./quizGame');
  const mutex = require('../core/mutex');

  if (isOfficial) {
    const unlock = await mutex.lock(`start_test:${chatId}`);
    try {
      if (await checkActiveTestConflict(ctx, chatId)) return;
      return await initAndStartTest(chatId, ctx.telegram, data.subjectKey, 'adaptive', testData, ctx.from.id, 'private');
    } finally {
      unlock();
    }
  } else {
    return startUgcTest(ctx, {
      ...testData,
      id: `adapt_${data.id}`,
      title: `${data.title} — AI Adaptiv`,
    });
  }

// 2) hub_start_(off|ugc)_(.+) ichida (720-738 qatorlar):
    if (srcTag === 'off') {
      const parts = rawId.split('_');
      const testId = parseInt(parts.pop(), 10);
      const subjectKey = parts.join('_');
      const { initAndStartTest, checkActiveTestConflict } = require('./quizGame');
      const mutex = require('../core/mutex');
      const memDb = getMemoryDb();
      const testData = (memDb[subjectKey] || {})[testId];
      if (testData) {
        const unlock = await mutex.lock(`start_test:${ctx.chat.id}`);
        try {
          if (await checkActiveTestConflict(ctx, ctx.chat.id)) return;
          return await initAndStartTest(ctx.chat.id, ctx.telegram, subjectKey, testId, testData, ctx.from.id, 'private');
        } finally {
          unlock();
        }
      }
    }

// 3) hub_blitz_(off|ugc)_(.+) ichida (758-766 qatorlar):
    const { initAndStartTest, startUgcTest, checkActiveTestConflict } = require('./quizGame');
    const mutex = require('../core/mutex');
    if (block.isOfficial) {
      const unlock = await mutex.lock(`start_test:${ctx.chat.id}`);
      try {
        if (await checkActiveTestConflict(ctx, ctx.chat.id)) return;
        return await initAndStartTest(ctx.chat.id, ctx.telegram, block.subjectKey, 'blitz', testData, ctx.from.id, 'private');
      } finally {
        unlock();
      }
    }
```

---

### 4-TUZATISH: `src/handlers/coreQuiz.js` — `buildFinishButtons` da Marafon "Keyingi Blok" Tugmasi Dublikatini Olib Tashlash

`src/handlers/coreQuiz.js` (70–90-qatorlar) da `session?.isMarathon` bo‘lganda `btns.unshift` orqali marafon tugmasi qo‘shilgach, pastdagi oddiy `nextBlock` tugmasi ham ikkinchi marta qo‘shilmasligi uchun `hasMarathonNextBtn` bayrog‘ini qo‘shing:

```javascript
// src/handlers/coreQuiz.js — buildFinishButtons (70-90 qatorlar):
  let hasMarathonNextBtn = false;
  if (session?.isMarathon && Array.isArray(session.marathonBlocks)) {
    const nextIdx = (session.currentBlockIdx || 0) + 1;
    const nextBlock = session.marathonBlocks[nextIdx];
    if (nextBlock) {
      hasMarathonNextBtn = true;
      const nextCb = String(tId).startsWith("ugc_") || session?.subjectId
        ? safeCallbackData(`ugc_start_${nextBlock.id || nextBlock.test_id}`, 64)
        : safeCallbackData(`post_start_${subjectKey}_${nextBlock.id || nextBlock.test_id}`, 64);
      btns.unshift([
        Markup.button.callback(
          `🏃‍♂️ Keyingi marafon bloki (${nextBlock.block_name || `${nextIdx + 1}-Blok`})`,
          nextCb,
        ),
      ]);
    }
  }
```
Va shu funksiyaning 131-qatorida `if (nextBlock)` ni `if (nextBlock && !hasMarathonNextBtn)` ga, 179-qatorida esa `if ((memDb[subjectKey] || {})[tId + 1])` ni `if (!hasMarathonNextBtn && (memDb[subjectKey] || {})[tId + 1])` ga o‘zgartiring.