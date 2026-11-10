# Smart Feature Flag & Rollout Governance System (Arxitektura va Spetsifikatsiya)

> **Hujjat turi:** Texnik dizayn va xavfsizlik spetsifikatsiyasi (Design Doc)  
> **Loyiha:** `quiz_bot_nodejs`  
> **Sana:** 10-Noyabr, 2026-yil  
> **Status:** Tasdiqlash uchun tayyorlangan  

---

## 1. Muammo va Ehtiyoj (The Problem & The Why)

Botda yangi funksiyalar (masalan, Telegram 10.4 3D vidjetlari, yangi test turlari, AI imkoniyatlari) joriy qilinganda:
1. **Xavf:** Yangi funksiyada yashirin xatolik (bug) bo'lsa yoki kutilmagan server yuki oshib ketsa, bu butun botni (barcha 1300+ guruh va minglab talabalarni) to'xtatib qo'yishi mumkin.
2. **Qo'lda boshqarish azobi:** Har safar yangi funksiya qo'shilganda kodning har xil joylarida `if (userId === ADMIN_ID)` deb qo'lda yozib chiqish texnik qarzga (tech debt) va chalkashliklarga olib keladi.
3. **Avtomatlashgan himoya yo'qligi:** Agar yangi funksiya xato bera boshlasa, admin uni to'xtatish uchun kodni qayta ochib, o'chirib, qayta deploy qilishi kerak — bu esa kamida 10-15 daqiqa vaqt oladi.

---

## 2. Asosiy Maqsadlar va Tamoyillar (Goals & Non-Goals)

### Maqsadlar (Goals):
- **O'z-o'zini ro'yxatga olish (Zero-Config Self-Registration):** Koddagi istalgan yangi funksiya birinchi marta chaqirilgan zahoti tizim uni taniydi va sukut bo'yicha (default) eng xavfsiz `ADMIN_ONLY` rejimida registrga kiritadi.
- **Ko'p bosqichli Rollout (Ring Deployment):**
  - `OFF` — Butunlay o'chiq
  - `ADMIN_ONLY` — Faqat adminlar/yaratuvchi ko'radi (Dogfooding)
  - `BETA_USERS` — Faol starosta va talabalar ro'yxati (Closed Beta)
  - `PERCENTAGE` — Deterministik xeshlash asosida 5%, 10%, 25%, 50% foydalanuvchilar (Canary)
  - `PUBLIC` — Barcha foydalanuvchilarga 100% ochiq
- **Auto-Kill Switch (Avtomatik o'chirgich):** Agar yangi funksiya 5 daqiqa ichida belgilangan xatolik limitidan oshsa (masalan, 3 ta unhandled xatolik), tizim funksiyani avtomatik ravishda `ADMIN_ONLY` rejimiga tushiradi va adminga Sentry/Telegram orqali zudlik bilan xabar beradi.
- **Tezkorlik (Zero Overhead):** 2 darajali kesh (Local Memory 5s TTL + Redis) — funksiya tekshiruvi 0.05 millisoniyada bajariladi.
- **Telegram Admin Paneli (`/flags`):** Botdan chiqmasdan, 1 ta teginish bilan funksiya holatini o'zgartirish.

### Anti-Maqsadlar (Non-Goals):
- Tashqi pullik uchinchi tomon servislarga (LaunchDarkly, Split.io) bog'lanmaslik — tizim 100% mustaqil, o'zimizning Redis va xotiramizda ishlaydi.

---

## 3. Arxitektura va Ma'lumotlar Tuzilishi

### 3.1. Holatlar Mashinasi (Rollout States)
```
  ┌─────────┐      1-Tap      ┌──────────────┐      1-Tap      ┌──────────────┐
  │   OFF   │ ──────────────> │  ADMIN_ONLY  │ ──────────────> │  BETA_USERS  │
  └─────────┘                 └──────────────┘                 └──────────────┘
       ▲                             │                                │
       │ (Auto-Kill Switch)          │ 1-Tap                          │ 1-Tap
       │                             ▼                                ▼
       │                      ┌──────────────┐      1-Tap      ┌──────────────┐
       └───────────────────── │  PERCENTAGE  │ ──────────────> │    PUBLIC    │
                              │ (10% - 50%)  │                 │    (100%)    │
                              └──────────────┘                 └──────────────┘
```

### 3.2. Deterministik Xeshlash (Sticky Percentage)
Foydalanuvchi har safar tugmani bosganda funksiya goh ko'rinib, goh yo'qolib qolmasligi uchun Murmur/CRC32 uslubidagi deterministik formula ishlatiladi:
$$\text{Bucket} = \left(\text{Hash}(\text{userId} + \text{featureKey}) \pmod{100}\right)$$
Agar $\text{Bucket} < \text{RolloutPercentage}$ bo'lsa, ushbu foydalanuvchiga doimiy ko'rinadi.

### 3.3. Guruh va Shaxsiy Kontekst (Context Scopes)
- **Shaxsiy chat (Private):** To'g'ridan-to'g'ri `userId` tekshiriladi.
- **Guruh chati (Group):**
  - Agar guruh xabari bo'lsa: `isFeatureEnabled(feature, userId, { chatId, isGroup: true })`.
  - Agar admin guruh ichida yangi test boshlasa, tizim guruhda `ADMIN_ONLY` test rejimini faollashtirish imkonini beradi.

---

## 4. Mavjud Funksiyalarning Ro'yxatga Olinishi

Dastlabki ro'yxat:
1. `FEATURE_TOP3_PODIUM` — Guruhda faqat TOP-3 shoxsupa va Ephemeral shaxsiy natijalar.
2. `FEATURE_BLITZ_FLASHCARD` — 3D Touch/Swipeable Blitz-Flashcard o'quv vidjeti va intervalli takrorlash.
3. `FEATURE_DOCX_SMART_HEALER` — Docx yopishgan qatorlar, formatlangan kalitlarni 1-bosishda tuzatish.
4. `FEATURE_WIDGET_ENGINE` — Telegram 10.4 HTML vidjetlarini xabarlar ichida ochish.

Dastlabki holatda barchasi **`ADMIN_ONLY`** sifatida ishga tushadi.
