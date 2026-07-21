# Quiz Bot Node.js — Faza 3: Kontent (PDF/Docx), WebApp Auth & Admin API, Sentry va Pipeline Sayqallash Implementation Plan
> **Loyihaning joriy holati:** Faza 1 va Faza 2 100% Yakunlangan (`v2.5.0` Barqaror holat) → **Maqsad:** Faza 3 (`v3.0.0` To'liq Prod-Ready Holati)

---

## 1. Faza 3 — Umumiy Arxitektura va Modullar

Faza 3 botga maxsus hujjatlar (`.pdf` va `.docx`) dan AI yordamida test tuzish imkoniyatini qo'shadi, Telegram WebApp hamda Admin Dashboard uchun xavfsiz REST API o'rnatadi va yuqori yuklamada (Load Test) ishlash uchun Redis pipeline hamda Sentry tracing tahlilini sayqallaydi:

```mermaid
graph TD
    P3[Faza 3: Kontent + Admin + Sayqal] --> M1[3.1 PDF/Docx AI Test Generatori]
    P3 --> M2[3.2 WebApp Auth & Admin REST API]
    P3 --> M3[3.3 Sentry Tracing & Monitoring]
    P3 --> M4[3.4 Redis Pipeline Optimizatsiyasi]

    M1 --> M1_1[pdfHandler.js: pdf-parse + mammoth]
    M1 --> M1_2[Free 1/kun limit, Premium cheksiz]

    M2 --> M2_1[src/api/webapp.js: HMAC SHA256 initData validation]
    M2 --> M2_2[src/api/admin.js: /payments tasdiqlash endpointi]

    M3 --> M3_1[aiService va kritik nuqtalarda Sentry.withScope]
    
    M4 --> M4_1[sessionService.js: redis.pipeline() bilan tezlashtirish]
```

---

## 2. Bajaruvchi va Nazoratchi Model (Primary Agent + Universal Supervisory Subagents)

Bu fazada **kod yozish va integratsiyani to'g'ridan-to'g'ri Primary Agent (Bosh Agent)** amalga oshiradi. Subagentlar esa bitta vazifaga bog'lanmagan **Universal Nazoratchi (Supervisory / Audit Agents)** sifatida ishlaydi:
1. **`strict-quality-enforcer` (Universal Sifat Nazoratchisi):**
   - Har bir bosqich yakunida kodni o'qib, `TODO`, placeholder, xato yashirish yoki chala mantiq yo'qligini tekshiradi.
2. **`codebase-security-auditor` (Universal Xavfsizlik va Kriptografiya Nazoratchisi):**
   - Telegram WebApp `initData` HMAC SHA-256 algoritmining to'g'riligini, hujjat yuklashda xotira to'lib ketish xavfini va Redis TTL xavfsizligini audit qiladi.

---

## 3. Bosqichma-Bosqich Implementation Jadvali

| Bosqich | Bajaruvchi | Nazorat qiluvchi Subagent | Asosiy Fayllar | Kutilayotgan Natija | Holati |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **3.1** | **Primary Agent** | `strict-quality-enforcer` | `src/handlers/pdfHandler.js`<br>`src/index.js` | ✅ BAJARILDI / TASDIQLANDI |
| **3.2** | **Primary Agent** | `codebase-security-auditor` | `src/api/webapp.js`<br>`src/api/admin.js`<br>`src/index.js` | ✅ BAJARILDI / TASDIQLANDI (HMAC SHA256 Safe) |
| **3.3** | **Primary Agent** | `strict-quality-enforcer` | `src/services/sessionService.js` | ✅ BAJARILDI / TASDIQLANDI (Redis Pipeline) |
| **3.4** | **Primary Agent** | `strict-quality-enforcer` | Barcha yangi va o'zgartirilgan fayllar | ✅ APPROVED (100% Complete v3.0.0) |

---

## 4. Bajarish Qoidalari
- Hamma kodlar **Senior Level Node.js** standartida yoziladi.
- Eski ishlayotgan har qanday o'yin, faza 1 va faza 2 modullari buzilmaydi.
