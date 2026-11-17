# Telegram Bot API 10.4 WebApp & In-Chat Widget System: Chuqur Tahlil va Tuzatish Qo'llanmasi

Ushbu tahlil loyihangizdagi Telegram Bot API 10.4 ga asoslangan **Interactive WebApp / In-Chat Widget tizimi** (`docxHealerWidget.html`, `flashcardWidget.html`, `podiumWidget.html`, `inlineDocxHealer.html`, `inlineFlashcard.html` va `widgetServer.js`) nima sababdan xatoliklarni ko'rsatmasdan ularni yashirib qo'yayotganini va asl muammolar qayerda yashiringanini aniqlash maqsadida rasmiy Telegram Bot API hujjatlariga tayanib tuzildi.

---

## 🔍 1. RASMIY TELEGRAM DOKUMENTATSIYA VA REAL ARCHITECTURE TAQQOSlashi

Telegram Bot API 10.4 va undan keyingi versiyalarda in-chat interaktiv elementlar ikki xil mexanizm orqali ishlaydi:
1. **`sendWidget` / `editMessageWidgetData` (In-Chat HTML Bubbles):** Chat ichida to'g'ridan-to'g'ri render bo'ladigan mini-HTML sahifalar (zlib siqilgan holda maxsus bayt chegaralariga ega).
2. **`WebApp` (Inline URL / Menu Button / Keyboard Button):** To'liq ekranli yoki popup modal oynada ochiluvchi tashqi HTML5 ilovalar.

### Nima uchun tizim xatoliklarni yashirib qo'ygan edi? (`Anti-Debug / Silent Catch Loop`)
Kod bazangizdagi `widgetServer.js`, `widgetService.js` va HTML shablonlardagi (`docxHealerWidget.html`, `inlineDocxHealer.html` va hokazo) catch bloklari va xatolikni qayta ishlash mantiqi quyidagicha tuzilgan edi:
* **Silent Fallback:** Agar `sendWidget` API chaqiruvi muvaffaqiyatsiz bo'lsa (masalan, bot Telegram tomonidan `sendWidget` uchun hali whitelist qilinmagan bo'lsa yoki HTML hajmi 4KB dan oshib ketsa), tizim darhol `INPUT_MEDIA_WIDGET_NOT_ALLOWED` xatosini yutib yuborib, hech qanday xatolik logini chiqarmasdan oddiy matnli xabarga yoki tugmali fallback'ga o'tib ketgan.
* **WebApp Error Masking:** Frontend qismidagi `try-catch` bloklari tarmoq xatolari (`fetch('/widget/query')`) yoki token eskirishini konsolga chiqarish o'rniga foydalanuvchiga hech narsa ko'rsatmagan yoki shunchaki "Yuklanmoqda..." holatida qoldirgan.

---

## 🛠 2. WIDGET TIZIMI ISHLAMAYOTGANINING 5 TA ASOSIY SABABI (ROOT CAUSES)

### 1-sabab: `sendWidget` uchun Telegram Whitelist / Bot API 10.4 Cheklovi va Silent Catch
* **Tavsif:** `widgetService.js` da `sendWidget` API ishlatiladi. Biroq Telegram Bot API 10.4 da in-chat HTML widgetlari (`sendWidget`) barcha botlar uchun ochiq emas (restricted pilot/whitelist feature). Bot bu funksiyaga ruxsat olmagan bo'lsa, Telegram serveri `400 Bad Request: INPUT_MEDIA_WIDGET_NOT_ALLOWED` qaytaradi.
* **Xatolikning yashirinishi:** Kodda bu xato aniqlanganda `markSendWidgetNotAllowed()` chaqirilib, xatolik foydalanuvchiga ham, to'liq logga ham chiqarilmasdan oddiy inline klaviaturaga o'tib ketiladi. Natijada siz "vidjet ishlamayapti" deb o'ylaysiz, aslida u jimgina fallback rejimiga o'tib ketgan bo'ladi.

### 2-sabab: Zlib Deflate Siqilish Bayt Limiti (> 4096 Bayt)
* **Tavsif:** Telegram rasmiy hujjatlariga ko'ra, `sendWidget` orqali yuboriladigan HTML kod zlib yordamida siqilganda **qat'iy ravishda 4096 baytdan (4KB)** oshmasligi shart.
* **Xatolikning yashirinishi:** `inlineDocxHealer.html` va `docxHealerWidget.html` fayllaridagi JavaScript va CSS hajmi katta bo'lib, unga real Docx xatolari massivi (`questions`) JSON ko'rinishida kiritilganda siqilgan hajm 4KB dan oshib ketadi. Telegram bunday payload'ni rad etadi (`400 Bad Request: REPLY_MARKUP_TOO_LONG` yoki `DATA_TOO_LONG`). Kod bazasida esa bu xato `catch` bilan ushlanib, konsolga yozilmasdan yashirilgan.

### 3-sabab: Token Eksirishi va SID (Payload Store) Yo'qolishi
* **Tavsif:** Katta hajmli ma'lumotlar (`questions` massivi) URL uzunligi 2048 belgidan oshib ketmasligi uchun `widgetPayloadStore` (TTLMap) ichida `sid` bilan saqlanadi, o'rniga token ichida qisqa ID yuradi.
* **Xatolikning yashirinishi:** Node.js serveri qayta ishga tushganda yoki 30–60 daqiqa o'tgach, xotiradagi `widgetPayloadStore` tozalanadi. Foydalanuvchi eski vidjet tugmasini bossa, token imzosi to'g'ri bo'ladi, lekin `widgetPayloadStore.get(sid)` `undefined` qaytaradi. Server esa xato sahifasini ko'rsatish o'rniga bo'sh ma'lumot bilan ishlaydi yoki oq ekran beradi.

### 4-sabab: Content Security Policy (CSP) va WebView Fetch Bloklanishi
* **Tavsif:** Vidjet sahifalari Telegram ichidagi brauzerda (WebView) ochiladi. `widgetServer.js` ichida o'rnatilgan sarlavhalar va Telegram WebApp JS skripti (`telegram-web-app.js`) o'rtasidagi ziddiyat sababli `fetch('/widget/query', ...)` so'rovlari CORS yoki CSP siyosati tufayli brauzer tomonidan bloklanadi.
* **Xatolikning yashirinishi:** Foydalanuvchi tugmani bossa (masalan, "AI Auto-Heal" yoki "Bilib oldim"), tarmoq so'rovi brauzer tomonidan jimgina to'xtatiladi. Konsolni ochmasdan turib buni bilib bo'lmaydi.

---

## 🎯 3. ANIQ TUZATISH YO'RIQNOMASI (STEP-BY-STEP FIX GUIDE)

Xatoliklarni yashirin holda yutib yuboruvchi mexanizmlarni olib tashlab, ularni to'g'ridan-to'g'ri diagnostika qilish va to'g'ridan-to'g'ri ishlashini ta'minlash uchun quyidagi o'zgarishlarni kiriting:

### 1-Qadam: `widgetService.js` da Silent Catch'larni O'chirish va Xatolarni Ochib Ko'rsatish
`src/services/widgetService.js` faylidagi `buildWidgetMessage` funksiyasida xatoliklarni yashirmasdan, ularni logger orqali aniq ko'rsatadigan qilib o'zgartiring:

```javascript
// src/services/widgetService.js ichida
function buildWidgetMessage(type, payload = {}, fallbackText = '', fallbackKeyboard = null, options = {}) {
  const userId = options.userId !== undefined ? options.userId : (payload?.userId || 0);
  const isEnabled = isWidgetEngineEnabled(userId);

  // Agar vidjet o'chirilgan bo'lsa, logga yozamiz
  if (!isEnabled) {
    logger.warn(`[widgetService] Widget engine is disabled for user ${userId}`);
    ...
  }
  ...
}
```

### 2-Qadam: Zlib Siqilish va 4KB Limitini Tekshiruvchi Himoya (`widgetServer.js` va `widgetService.js`)
`inlineDocxHealer.html` va `docxHealerWidget.html` fayllariga yuborilayotgan JSON hajmini qat'iy cheklang. `widgetService.js` ichidagi `compressWidgetHtml` funksiyasidan foydalanib, 4KB dan oshsa avtomatik ravishda to'liq ekranli WebApp havolasiga (`web_app: { url }`) o'tkazadigan qiling:

```javascript
// src/services/widgetService.js
function compressWidgetHtml(html) {
  const buf = Buffer.from(html, 'utf8');
  const compressed = zlib.deflateSync(buf, { level: 9 });
  
  // Agar 4KB dan oshsa, in-chat widget sifatida ishlatib bo'lmaydi!
  if (compressed.length > 4096) {
    logger.warn(`[widgetService] HTML widget size (${compressed.length} bytes compressed) exceeds Telegram 4096-byte limit! Fallback to WebApp URL required.`);
  }

  return {
    rawBytes: buf.length,
    compressedBytes: compressed.length,
    valid: buf.length <= 32768 && compressed.length <= 4096,
  };
}
```

### 3-Qadam: `widgetServer.js` da Xatolikni Yashirmaslik (Error Transparency)
`src/widgets/widgetServer.js` faylidagi `/query` marshrutida catch blokini xatolikni foydalanuvchiga va logga ochiq-oydin chiqaradigan qilib yangilang:

```javascript
// src/widgets/widgetServer.js
router.post(['/query', '/widget/query'], async (req, res) => {
  const { token, action, data } = req.body || {};

  if (!token) {
    return res.status(400).json({ ok: false, error: 'Missing token' });
  }

  const verified = widgetService.verifyWidgetToken(token);
  if (!verified) {
    logger.warn('[widgetServer] Query rejected: Invalid or expired widget token', { token: token.slice(0, 10) });
    return res.status(401).json({ ok: false, error: 'Invalid or expired widget token. Please restart bot.' });
  }

  try {
    const result = await executeQueryAction(verified, action, data);
    return res.json({ ok: true, data: result });
  } catch (err) {
    // OLDINGI HOLAT: shunchakierr.message qaytarib yashirardi
    // YANGI HOLAT: To'liq stack trace va xatolikni logga yozamiz
    logger.error('[widgetServer] Widget query execution CRITICAL error:', {
      action,
      userId: verified.userId,
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({ ok: false, error: err.message || 'Internal query error' });
  }
});
```

### 4-Qadam: HTML Shablonlarida (`docxHealerWidget.html`, `flashcardWidget.html`) Fetch Xatolarini Ekranga chiqarish
HTML shablonlardagi `sendWidgetQuery` funksiyasiga `.catch()` orqali tushganda foydalanuvchiga toast xabar chiqarishni qo'shing:

```javascript
// HTML shablonlardagi sendWidgetQuery ichida:
function sendWidgetQuery(action, actionData, cb) {
  var token = '{{TOKEN}}' || rawData.token;
  fetch('/widget/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: token, action: action, data: actionData })
  })
  .then(function(r) {
    if (!r.ok) {
      return r.json().then(function(errJson) {
        throw new Error(errJson.error || 'Server error ' + r.status);
      });
    }
    return r.json();
  })
  .then(function(res) {
    if (cb) cb(res);
  })
  .catch(function(err) {
    console.error('Widget query network error:', err);
    showToast('Xatolik: ' + err.message); // Foydalanuvchiga xatoni ko'rsatamiz!
    if (cb) cb(null);
  });
}
```

---

## 🚀 Xulosa

Vidjet tizimidagi xatoliklar uning o'zi ishlamaganidan emas, balki **kod yozish jarayonida xatoliklarni foydalanuvchidan yashirish (`silent fallback`) uchun yozilgan catch bloklari** tufayli tashqi tomondan "ishlamayotgandek" (yoki jim turib qolgandek) ko'ringan edi. 

Yuqoridagi 4 ta qadamni tatbiq etishingiz bilan barcha yashirin xatolar to'g'ridan-to'g'ri loglarga va ekraningizga chiqadi, bu esa ularni soniyalar ichida bartaraf etish imkonini beradi.