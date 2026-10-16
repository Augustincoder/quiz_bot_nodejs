# `quiz_bot_nodejs` — Smart Timetable & Contextual Reminder Engine 2.0
## AGY CLI (AI Coding Agent) Uchun Bosqichma-Bosqich Implementatsiya Qo‘llanmasi

---

## 🤖 0-BO‘LIM: AI AGENT (AGY CLI) UCHUN QAT’IY TIZIM KO‘RSATMALARI (SYSTEM INSTRUCTIONS)

> **DIQQAT (AI Agent uchun):** Siz ushbu texnik spetsifikatsiyani `quiz_bot_nodejs` repozitoriysida amalga oshiruvchi muhandis agentsiz. Kod yozishda quyidagi **7 ta oltin qoidaga** so‘zsiz amal qiling:
>
> 1. **Zero-Friction UX ("Biz biladigan narsani userdan so‘ramaymiz"):** Agar foydalanuvchining guruhi (`student_group`) bazada saqlangan bo‘lsa, `/note` bosilganda undan guruhini ham, hozirgi fanni ham so‘ramang. Toshkent vaqti (`UTC+5`) bilan hozir qaysi para ketayotganini (yoki 20 daqiqa ichida tugaganini) avtomatik aniqlang va darhol shu fanning keyingi **Amaliyot/Seminar**, **Ma’ruza** yoki **keyingi haftadagi** darslariga (aniq sana va vaqti bilan!) biriktirish tugmalarini chiqaring.
> 2. **64-Baytlik `callback_data` Cheklovi:** Telegram inline tugmalarida `callback_data` hech qachon $64\text{ bayt}$ (UTF-8) dan oshmasligi shart. Kirill va uzun fan nomlarini **hech qachon** `callback_data` ichiga to‘g‘ridan-to‘g‘ri yozmang — faqat qisqa indeks (`sIdx`, `oIdx`) yoki 8 belgili MD5/CRC xesh ishlating.
> 3. **Toshkent Vaqt Mintaqasi (`Asia/Tashkent`, `UTC+5`):** Server `UTC` da ishlasa ham, barcha soat, daqiqa va hafta kuni hisob-kitoblari `src/core/utils.js` dagi Toshkent vaqti funksiyalari orqali bajarilishi shart.
> 4. **Idempotency (Takroriy Xabar Yubormaslik):** Har daqiqada aylanadigan dispetcher bitta eslatmani bir foydalanuvchiga 2 marta yubormasligi uchun Redis (yoki lokal TTL Map) da `notif_lock:{type}:{userId}:{date}:{periodOrTime}` kaliti bilan $24\text{ soatlik}$ (`86400s`) himoya qo‘ying.
> 5. **HTML Xavfsizligi:** Foydalanuvchi kiritgan `/note` matni, fan nomi va o‘qituvchi ismi `parse_mode: 'HTML'` da yuborilishidan oldin `escapeHtml()` dan o‘tkazilishi shart.
> 6. **1000 Qator Cheklovi:** Supabase’dan foydalanuvchilar yoki eslatmalarni o‘qishda `.range(from, to)` paginatsiyasidan foydalaning.
> 7. **Immutability:** `edupageService` va `loader` dan olingan kesh obyektlarini joyida (`.sort()`, `.splice()`) o‘zgartirmang, nusxa (`[...arr]`) oling.

---

## 📐 1-BO‘LIM: TIZIM ARXITEKTURASI VA ISHLASH MANTIG‘I

### 1.1. Eslatmalarning 4 xil rejimi (Notification Modes)

Har bir talaba `🗓 Dars jadvali` $\rightarrow$ `⚙️ Eslatma sozlamalari` menyusida o‘ziga mos rejimni tanlaydi:

1. **🌗 Smena-moslashuvchan avto-rejim (`shift_aware` — Default):**
   * Bot talabaning bugungi **1-darsi (eng erta parasi)** soat nechada boshlanishini tekshiradi.
   * Agar 1-dars soat $12:30$ gacha bo‘lsa (**1-smena**) $\rightarrow$ Kunlik jadval **ertalab `07:00` da** yuboriladi.
   * Agar 1-dars soat $13:00$ yoki undan keyin boshlansa (**2-smena / Kechki smena**) $\rightarrow$ Talabani ertalab 07:00 da uyg‘otmaydi! Kunlik jadval **soat `11:30` da** (tushlikdan oldin) yuboriladi.
   * Qo‘shimcha ravishda kechqurun **`20:00` da** ertangi kun jadvali yuboriladi.

2. **⏳ Birinchi darsdan oldin dinamik eslatma (`offset_before_first`):**
   * Foydalanuvchi offset tanlaydi: **`30 daqiqa`**, **`60 daqiqa` (1 soat)** yoki **`120 daqiqa` (2 soat)**.
   * Agar talabaning bugungi birinchi darsi $t_{\text{start}}$ da bo‘lsa (masalan, 2-para $10:00$ da yoki 3-para $13:30$ da) va offset $\Delta t = 60\text{ daqiqa}$ bo‘lsa, eslatma aynan:
     $$t_{\text{notify}} = t_{\text{start}} - \Delta t$$
     vaqtda (ya’ni $09:00$ da yoki $12:30$ da) yuboriladi.

3. **🎯 Aniq belgilangan vaqt (`custom_time`):**
   * Foydalanuvchi o‘ziga qulay aniq vaqtni tanlaydi yoki yozadi (masalan: `06:30`, `07:30`, `21:00`, `22:00`).
   * Agar tanlangan vaqt $< 14:00$ bo‘lsa, shu kungi jadvalni; agar $\ge 14:00$ bo‘lsa, ertangi kun jadvalini yuboradi.

4. **🔔 "Keyingi para" qo‘ng‘irog‘i (`next_bell_5m` — Mustaqil Toggle `ON/OFF`):**
   * Joriy para tugashiga **5 daqiqa qolganda** ($t_{\text{end}} - 5\text{ daqiqa}$) ishga tushadi.
   * **Juftlik (Double-Period) filtri:** Agar keyingi para xuddi shu fan va xuddi shu xona bo‘lsa (`durationperiods > 1`), talabani bezovta qilmaydi.
   * **Bino almashinuvi (Building Hopping) detektori:** Agar joriy para `A-bino`da, keyingi para `B-bino`da bo‘lsa, xabarda `🏃‍♂️ DIQQAT: Keyingi dars boshqa binoda! (A-bino ➡️ B-bino)` ogohlantirishi chiqadi.

---

### 1.2. Kontekstual `/note` va `/groupnote` (Aqlli Vazifa va Eslatma Tizimi)

Talaba `/note` (shaxsiy) yoki `/groupnote` (guruh starostasi/a’zosi tomonidan butun guruh uchun) buyrug‘ini beradi:

#### Ssenariy A: Talaba hozir darsda o‘tiribdi (yoki dars tugaganiga $\le 20\text{ daqiqa}$ bo‘ldi)
1. Bot Toshkent vaqti bilan talabaning guruh jadvalini tekshiradi va hozir **"Korporativ moliya (Ma’ruza)"** darsi ketayotganini (yoki hozirgina tugaganini) avtomatik biladi.
2. **Muammo:** Ma’ruza o‘qituvchisi ko‘pincha topshiriqni keyingi **Seminar/Amaliyot** darsida so‘rash uchun beradi (yoki keyingi Ma’ruzada).
3. **Yechim:** Bot foydalanuvchidan *"Qaysi fan?"* deb so‘rab o‘tirmaydi! Darhol quyidagi aqlli menyuni chiqaradi:
   > 📍 Hozir sizda **Korporativ moliya** *(Ma’ruza)* darsi.
   > 📝 Topshiriqni shu fanning qaysi darsi oldidan eslatay?
   >
   > * `[ ✍️ Keyingi Amaliyot (Juma, 17.10 • 10:00) ]` *(Eng ko‘p tanlanadigan variant!)*
   > * `[ 📖 Keyingi Ma'ruza (Dushanba, 20.10 • 08:30) ]`
   > * `[ ⏭ Keyingi haftadagi Amaliyot (Chorshanba, 22.10 • 13:30) ]`
   > * `[ 📚 Boshqa fanni tanlash... ]`

#### Ssenariy B: Talaba darsdan tashqari vaqtda `/note` yozdi
1. Bot guruhning fanlar ro‘yxatini chiqaradi, lekin **bugun bo‘lgan fanlarni** ro‘yxatning eng tepasiga `📍 Bugun:` belgisi bilan chiqaradi (chunki talaba katta ehtimol bilan bugungi darslardan birining vazifasini yozmoqda).
2. Fan tanlangach, xuddi Ssenariy A dagi kabi shu fanning kelgusi **Amaliyot / Seminar**, **Laboratoriya** va **Ma’ruza** darslarini aniq sanasi va vaqti bilan tugmalarda chiqaradi.

#### Media va Interaktiv Boshqaruv
* Talaba topshiriq sifatida **matn**, **rasm (doska surati)**, **ovozli xabar (`voice`)** yoki **fayl (`document`)** yuborishi mumkin.
* Belgilangan darsning:
  1. **Bir kun oldin kechqurun (`20:00` da)** — *"Ertaga [Fan] ([Dars turi]) darsi bor, quyidagi topshiriqni tayyorlashni unutmang!"* deb eslatadi.
  2. **Dars boshlanishidan `30 daqiqa` oldin** — Yana bir bor eslatadi va xabar ostida:
     * `[ ✅ Bajarildi ]` (eslatmani yopadi)
     * `[ ⏳ Keyingi darsga surish ]` (domla so‘ramay qolsa, avtomatik shu turdagi keyingi dars sanasiga ko‘chiradi!) tugmalarini chiqaradi.

---

## 🗄 2-BO‘LIM: MA’LUMOTLAR BAZASI MIGRATSIYASI (SUPABASE SQL)

Loyiha ildizida `scripts/migration_smart_schedule_v2.sql` faylini yarating va Supabase SQL Editor’da ishga tushiring:

```sql
-- 1. Users jadvaliga yangi eslatma sozlamalari ustunlarini qo'shish
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS notif_mode TEXT DEFAULT 'shift_aware', -- 'shift_aware' | 'offset_before_first' | 'custom_time' | 'disabled'
  ADD COLUMN IF NOT EXISTS notif_offset_min INTEGER DEFAULT 60,   -- 30, 60, 120 (daqiqa)
  ADD COLUMN IF NOT EXISTS notif_custom_time TEXT DEFAULT '07:00', -- 'HH:mm' formatda
  ADD COLUMN IF NOT EXISTS notif_Evening_preview BOOLEAN DEFAULT true, -- 20:00 da ertangi jadval
  ADD COLUMN IF NOT EXISTS notif_next_bell BOOLEAN DEFAULT true;  -- Para tugashidan 5 daqiqa oldin keyingi dars eslatmasi

-- 2. Kontekstual eslatmalar (/note va /groupnote) jadvali
CREATE TABLE IF NOT EXISTS public.class_notes (
  id BIGSERIAL PRIMARY KEY,
  creator_id BIGINT NOT NULL,
  group_name TEXT NOT NULL,
  is_group_note BOOLEAN DEFAULT false,          -- true bo'lsa guruhdagi barcha talabalarga boradi
  subject_name TEXT NOT NULL,                   -- Fanning to'liq nomi
  target_lesson_type TEXT DEFAULT 'ANY',        -- 'LECTURE' | 'PRACTICE' | 'LAB' | 'ANY'
  target_date TEXT NOT NULL,                    -- 'YYYY-MM-DD' formatda (Toshkent sanasi)
  target_period INTEGER NOT NULL,               -- Para raqami (1..7)
  target_start_time TEXT NOT NULL,              -- 'HH:mm' (masalan '10:00')
  note_text TEXT,                               -- Vazifa matni yoki caption
  media_type TEXT DEFAULT NULL,                 -- 'photo' | 'document' | 'voice' | NULL
  media_file_id TEXT DEFAULT NULL,              -- Telegram file_id
  status TEXT DEFAULT 'pending',                -- 'pending' | 'completed' | 'cancelled'
  notified_evening BOOLEAN DEFAULT false,       -- Kechqurungi (20:00) eslatma yuborildimi?
  notified_before_class BOOLEAN DEFAULT false,  -- Dars oldidan (30 daq) eslatma yuborildimi?
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_class_notes_active
  ON public.class_notes (status, target_date, group_name);

CREATE INDEX IF NOT EXISTS idx_class_notes_creator
  ON public.class_notes (creator_id, status);
```

---

## 🛠 3-BO‘LIM: FAYLLAR BO‘YICHA ANIQ KOD O‘ZGARISHLARI

### QADAM 1: `src/services/dbService.js` ga yangi metodlar qo‘shish

`src/services/dbService.js` faylini oching va foydalanuvchi eslatma sozlamalari hamda `class_notes` jadvali bilan ishlovchi quyidagi funksiyalarni qo‘shing (va `module.exports` ga eksport qiling):

```javascript
// === SMART SCHEDULE V2 VA CONTEXTUAL NOTES METODLARI ===

async function getUserSchedulePrefs(telegramId) {
    if (!supabase) return {
        notif_mode: 'shift_aware',
        notif_offset_min: 60,
        notif_custom_time: '07:00',
        notif_evening_preview: true,
        notif_next_bell: true
    };
    const { data, error } = await supabase
        .from('users')
        .select('student_group, schedule_notifications, notif_mode, notif_offset_min, notif_custom_time, notif_evening_preview, notif_next_bell')
        .eq('telegram_id', telegramId)
        .single();

    if (error || !data) {
        return {
            student_group: null,
            schedule_notifications: true,
            notif_mode: 'shift_aware',
            notif_offset_min: 60,
            notif_custom_time: '07:00',
            notif_evening_preview: true,
            notif_next_bell: true
        };
    }
    return {
        student_group: data.student_group,
        schedule_notifications: data.schedule_notifications !== false,
        notif_mode: data.notif_mode || 'shift_aware',
        notif_offset_min: Number(data.notif_offset_min) || 60,
        notif_custom_time: data.notif_custom_time || '07:00',
        notif_evening_preview: data.notif_evening_preview !== false,
        notif_next_bell: data.notif_next_bell !== false
    };
}

async function updateUserSchedulePrefs(telegramId, updates) {
    if (!supabase) return false;
    const { error } = await supabase
        .from('users')
        .update(updates)
        .eq('telegram_id', telegramId);
    return !error;
}

/**
 * Barcha guruh biriktirgan faol foydalanuvchilarni 1000 qator cheklovisiz paginatsiya bilan olish
 */
async function getAllSubscribedScheduleUsers() {
    if (!supabase) return [];
    const PAGE_SIZE = 1000;
    let allUsers = [];
    let from = 0;

    while (true) {
        const { data, error } = await supabase
            .from('users')
            .select('telegram_id, student_group, schedule_notifications, notif_mode, notif_offset_min, notif_custom_time, notif_evening_preview, notif_next_bell')
            .not('student_group', 'is', null)
            .range(from, from + PAGE_SIZE - 1);

        if (error || !data || data.length === 0) break;
        allUsers = allUsers.concat(data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
    }
    return allUsers;
}

async function createClassNote(notePayload) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('class_notes')
        .insert([notePayload])
        .select('*')
        .single();
    if (error) {
        logger.error(`createClassNote error: ${error.message}`);
        return null;
    }
    return data;
}

async function getPendingNotesForDate(targetDate) {
    if (!supabase) return [];
    const { data, error } = await supabase
        .from('class_notes')
        .select('*')
        .eq('status', 'pending')
        .eq('target_date', targetDate);
    if (error || !data) return [];
    return data;
}

async function getUserPendingNotes(telegramId, groupName) {
    if (!supabase) return [];
    const query = supabase
        .from('class_notes')
        .select('*')
        .eq('status', 'pending')
        .order('target_date', { ascending: true })
        .order('target_period', { ascending: true });

    if (groupName) {
        query.or(`creator_id.eq.${telegramId},and(is_group_note.eq.true,group_name.eq.${groupName})`);
    } else {
        query.eq('creator_id', telegramId);
    }

    const { data, error } = await query;
    return error || !data ? [] : data;
}

async function getNoteById(noteId) {
    if (!supabase) return null;
    const { data, error } = await supabase
        .from('class_notes')
        .select('*')
        .eq('id', noteId)
        .single();
    return error ? null : data;
}

async function updateClassNote(noteId, updates) {
    if (!supabase) return false;
    const { error } = await supabase
        .from('class_notes')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', noteId);
    return !error;
}
```

---

### QADAM 2: `src/services/scheduleService.js` ga Intellektual Tahlil Funksiyalarini Qo‘shish

Talabaning hozir qaysi darsda o‘tirganini topish, fan nomidan yoki dars kartochkasidan uning **Ma’ruza (`LECTURE`)**, **Amaliyot/Seminar (`PRACTICE`)** yoki **Laboratoriya (`LAB`)** ekanini ajratish va kelgusi 14 kun ichidagi darslarni topish uchun `src/services/scheduleService.js` ga quyidagi funksiyalarni qo‘shing:

```javascript
/**
 * Dars matni, fan nomi yoki xona turiga qarab dars turini aniqlaydi:
 * 'LECTURE' (Ma'ruza) | 'PRACTICE' (Amaliyot / Seminar) | 'LAB' (Laboratoriya)
 */
function detectLessonType(lessonObj) {
    const raw = [
        lessonObj.subject || '',
        lessonObj.lessonType || '',
        lessonObj.type || '',
        lessonObj.room || '',
        lessonObj.group || ''
    ].join(' ').toLowerCase();

    if (/(lab|лаб|laboratoriya|лаборатория)/.test(raw)) {
        return { code: 'LAB', label: '🔬 Laboratoriya' };
    }
    if (/(amal|амал|sem|сем|amaliy|амалий|seminar|семинар|ichki|kichik|\d-guruh|\d-гуруҳ)/.test(raw)) {
        return { code: 'PRACTICE', label: '✍️ Amaliyot / Seminar' };
    }
    if (/(ma'ruza|maruza|маъруza|маъруза|lek|лек|umumiy)/.test(raw)) {
        return { code: 'LECTURE', label: "📖 Ma'ruza" };
    }
    // EduPage da kichik guruh (subgroup) ko'rsatilgan bo'lsa, odatda Amaliyot yoki Lab bo'ladi
    if (lessonObj.subgroups && lessonObj.subgroups.length > 0) {
        return { code: 'PRACTICE', label: '✍️ Amaliyot / Seminar' };
    }
    // Agar bitta darsda bir nechta guruh birlashgan bo'lsa (potok), u Ma'ruza bo'ladi
    if (lessonObj.jointGroups && lessonObj.jointGroups.length > 1) {
        return { code: 'LECTURE', label: "📖 Ma'ruza" };
    }
    return { code: 'ANY', label: '📘 Dars' };
}

/**
 * Fan nomini normallashtirish (qavs ichidagi (Ma'ruza), (Amaliy) kabi qo'shimchalarni olib tashlab asosiy fan nomini olish)
 */
function normalizeBaseSubjectName(subjectName = '') {
    return String(subjectName)
        .replace(/\((ma['’`]?ruza|amaliyot|amaliy|seminar|laboratoriya|lab|lek|sem|амалий|маъруза|семинар|лаб)[^)]*\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Xona nomidan bino kodini ajratib olish (Masalan: "A-204" -> "A", "B bino 301" -> "B", "405" -> null)
 */
function extractBuildingFromRoom(roomStr = '') {
    const clean = String(roomStr).trim().toUpperCase();
    // Kirill A, B, V, G, D larni Lotin ga o'girish
    const normalized = clean
        .replace(/^А/, 'A')
        .replace(/^Б/, 'B')
        .replace(/^В/, 'V')
        .replace(/^Г/, 'G')
        .replace(/^Д/, 'D');

    const match = normalized.match(/^([A-Z])\s*[-/.\s]?\s*\d+/i) || normalized.match(/([A-Z])\s*[-]\s*BINO/i);
    return match ? match[1].toUpperCase() : null;
}

/**
 * "HH:mm" ni kun boshidan daqiqalarga o'girish
 */
function parseTimeToMinutes(timeStr = '00:00') {
    const [h, m] = String(timeStr).split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return 0;
    return h * 60 + m;
}

/**
 * Talabaning guruhida AYNAN HOZIR qaysi dars ketayotganini (yoki 20 daqiqa oldin tugaganini,
 * yoxud 15 daqiqa ichida boshlanishini) aniqlaydi.
 */
function getActiveOrRecentLessonContext(groupName, nowTashkent = getTashkentNow()) {
    const dayIndex = nowTashkent.getDay(); // 0 = Yakshanba, 1..6 = Dushanba..Shanba
    if (dayIndex === 0) return null;

    const todayLessons = getGroupScheduleForDay(groupName, dayIndex, nowTashkent);
    if (!todayLessons || todayLessons.length === 0) return null;

    const currentMinutes = nowTashkent.getHours() * 60 + nowTashkent.getMinutes();

    for (const lesson of todayLessons) {
        const startMin = parseTimeToMinutes(lesson.startTime);
        const endMin = parseTimeToMinutes(lesson.endTime);

        // 1. Hozir dars ketmoqda (yoki boshlanishiga 15 daqiqa qoldi)
        if (currentMinutes >= startMin - 15 && currentMinutes <= endMin) {
            return {
                state: 'IN_PROGRESS',
                lesson,
                baseSubject: normalizeBaseSubjectName(lesson.subject),
                lessonType: detectLessonType(lesson)
            };
        }

        // 2. Dars hozirgina tugadi (tanaffus vaqti, tugaganiga <= 20 daqiqa bo'ldi)
        if (currentMinutes > endMin && currentMinutes <= endMin + 20) {
            return {
                state: 'JUST_FINISHED',
                lesson,
                baseSubject: normalizeBaseSubjectName(lesson.subject),
                lessonType: detectLessonType(lesson)
            };
        }
    }

    return null;
}

/**
 * Berilgan guruh va fan uchun kelgusi 21 kun ichidagi barcha darslarni (Ma'ruza, Amaliyot, Lab)
 * aniq sana, hafta kuni va para vaqti bilan topib beradi.
 */
function getUpcomingSubjectOccurrences(groupName, baseSubjectName, maxResults = 6, nowTashkent = getTashkentNow()) {
    const targetNorm = normalizeBaseSubjectName(baseSubjectName).toLowerCase();
    const results = [];
    const currentMinutes = nowTashkent.getHours() * 60 + nowTashkent.getMinutes();

    const DAY_NAMES_SHORT = ['Yak', 'Dush', 'Sesh', 'Chor', 'Pay', 'Juma', 'Shan'];

    for (let offsetDays = 0; offsetDays <= 21; offsetDays++) {
        const checkDate = new Date(nowTashkent.getTime() + offsetDays * 86400000);
        const dayIdx = checkDate.getDay();
        if (dayIdx === 0) continue; // Yakshanba dam olish kuni

        const dayLessons = getGroupScheduleForDay(groupName, dayIdx, checkDate);
        if (!dayLessons || dayLessons.length === 0) continue;

        const yyyy = checkDate.getFullYear();
        const mm = String(checkDate.getMonth() + 1).padStart(2, '0');
        const dd = String(checkDate.getDate()).padStart(2, '0');
        const dateIso = `${yyyy}-${mm}-${dd}`;
        const dateDisplay = `${dd}.${mm} (${DAY_NAMES_SHORT[dayIdx]})`;

        for (const lesson of dayLessons) {
            const lessonNorm = normalizeBaseSubjectName(lesson.subject).toLowerCase();
            if (lessonNorm !== targetNorm && !lessonNorm.includes(targetNorm) && !targetNorm.includes(lessonNorm)) {
                continue;
            }

            const startMin = parseTimeToMinutes(lesson.startTime);
            // Agar bugungi dars bo'lsa va u allaqachon boshlangan/o'tib ketgan bo'lsa, uni "kelgusi dars"ga qo'shmaymiz
            if (offsetDays === 0 && startMin <= currentMinutes + 5) {
                continue;
            }

            const detectedType = detectLessonType(lesson);
            results.push({
                dateIso,
                dateDisplay,
                dayIdx,
                offsetDays,
                period: Number(lesson.period) || 1,
                startTime: lesson.startTime || '08:30',
                endTime: lesson.endTime || '09:50',
                subject: lesson.subject,
                baseSubject: normalizeBaseSubjectName(lesson.subject),
                room: lesson.room || '',
                teacher: lesson.teacher || '',
                lessonTypeCode: detectedType.code,
                lessonTypeLabel: detectedType.label
            });

            if (results.length >= maxResults) return results;
        }
    }

    return results;
}

/**
 * Guruhning barcha unikal fanlar ro'yxatini qaytaradi (bugungi fanlarni ro'yxat boshiga chiqaradi)
 */
function getGroupUniqueSubjectsSorted(groupName, nowTashkent = getTashkentNow()) {
    const todayIdx = nowTashkent.getDay();
    const todaySubjects = new Set();

    if (todayIdx >= 1 && todayIdx <= 6) {
        const todayLessons = getGroupScheduleForDay(groupName, todayIdx, nowTashkent) || [];
        for (const l of todayLessons) {
            if (l.subject) todaySubjects.add(normalizeBaseSubjectName(l.subject));
        }
    }

    const allSubjects = new Set([...todaySubjects]);
    for (let d = 1; d <= 6; d++) {
        const lessons = getGroupScheduleForDay(groupName, d, nowTashkent) || [];
        for (const l of lessons) {
            if (l.subject) allSubjects.add(normalizeBaseSubjectName(l.subject));
        }
    }

    return Array.from(allSubjects).map(subj => ({
        name: subj,
        isToday: todaySubjects.has(subj)
    }));
}
```

*(Eslatma: Yuqoridagi funksiyalarni `src/services/scheduleService.js` ning `module.exports` obyektiga qo‘shishni unutmang!)*

---

### QADAM 3: Kontekstual `/note` va `/groupnote` Handleri (`src/handlers/noteHandler.js`)

Yangi **`src/handlers/noteHandler.js`** faylini yarating. Bu modul:
1. Talaba `/note` yozganda (yoki rasm/ovoz/matnga reply qilib `/note` yozganda) hozir darsda o‘tirgan-o‘tirmaganini tekshiradi.
2. Agar hozir Ma’ruza (yoki Amaliyot) ketayotgan bo‘lsa, fan nomini so‘ramasdan, shu fanning **1-navbatda keyingi Amaliyot/Seminarini**, **keyingi Ma’ruzasini** va **undan keyingi darsini** tugmalarda chiqaradi!
3. Eslatma kelganda `[✅ Bajarildi]` va `[⏳ Keyingi darsga surish]` tugmalarini boshqaradi.

```javascript
// src/handlers/noteHandler.js
const db = require('../services/dbService');
const scheduleService = require('../services/scheduleService');
const pendingStore = require('../core/pendingStore');
const { escapeHtml, getTashkentNow } = require('../core/utils');
const logger = require('../core/logger');

const NOTE_STATE_TTL = 15 * 60 * 1000; // 15 daqiqa

/**
 * Xabardan matn yoki media (photo, document, voice) ma'lumotlarini ajratib oladi
 */
function extractNoteContentFromMessage(msg, commandName = 'note') {
    if (!msg) return null;

    // Agar foydalanuvchi boshqa xabarga (masalan, rasm yoki faylga) reply qilib /note yozgan bo'lsa
    const targetMsg = msg.reply_to_message || msg;

    let rawText = '';
    if (msg.text) {
        const regex = new RegExp(`^\\/${commandName}(?:@\\w+)?\\s*`, 'i');
        rawText = msg.text.replace(regex, '').trim();
    } else if (msg.caption) {
        const regex = new RegExp(`^\\/${commandName}(?:@\\w+)?\\s*`, 'i');
        rawText = msg.caption.replace(regex, '').trim();
    }

    if (!rawText && msg.reply_to_message) {
        rawText = (msg.reply_to_message.text || msg.reply_to_message.caption || '').trim();
    }

    let mediaType = null;
    let mediaFileId = null;

    if (targetMsg.photo && targetMsg.photo.length > 0) {
        mediaType = 'photo';
        mediaFileId = targetMsg.photo[targetMsg.photo.length - 1].file_id;
    } else if (targetMsg.document) {
        mediaType = 'document';
        mediaFileId = targetMsg.document.file_id;
    } else if (targetMsg.voice) {
        mediaType = 'voice';
        mediaFileId = targetMsg.voice.file_id;
    }

    if (!rawText && !mediaFileId) return null;
    return {
        text: rawText || '📎 Media eslatma',
        mediaType,
        mediaFileId
    };
}

/**
 * Tanlangan fan uchun keyingi darslar (Amaliyot, Ma'ruza, keyingi darslar) inline klaviaturasini yasaydi.
 * Ma'ruzada o'tirgan talabaga Amaliyot/Seminar variantini eng birinchi (⭐ tavsiya) qilib ko'rsatadi!
 */
function buildOccurrencesKeyboard(occurrences, currentLessonTypeCode = null) {
    const buttons = [];

    // Agar hozir Ma'ruza bo'lsa, talaba katta ehtimol bilan Seminar/Amaliyot uchun vazifa yozmoqda
    const nextPracticeIdx = occurrences.findIndex(o => o.lessonTypeCode === 'PRACTICE');
    const nextLectureIdx = occurrences.findIndex(o => o.lessonTypeCode === 'LECTURE');

    occurrences.forEach((occ, idx) => {
        let prefix = occ.lessonTypeLabel;
        if (currentLessonTypeCode === 'LECTURE' && idx === nextPracticeIdx) {
            prefix = '⭐ Keyingi Amaliyot';
        } else if (idx === 0) {
            prefix = `⏭ Eng yaqin (${occ.lessonTypeLabel})`;
        }

        const btnLabel = `${prefix}: ${occ.dateDisplay} • ${occ.period}-para (${occ.startTime})`;
        buttons.push([{
            text: btnLabel.slice(0, 60),
            callback_data: `note_occ_${idx}`
        }]);
    });

    buttons.push([
        { text: '📚 Boshqa fanni tanlash', callback_data: 'note_pick_subj' },
        { text: '❌ Bekor qilish', callback_data: 'note_cancel' }
    ]);

    return { inline_keyboard: buttons };
}

/**
 * /note va /groupnote komandalari uchun asosiy kirish nuqtasi
 */
async function handleNoteCommand(ctx, isGroupNote = false) {
    const userId = ctx.from.id;
    const prefs = await db.getUserSchedulePrefs(userId);

    if (!prefs.student_group) {
        return ctx.reply(
            '⚠️ <b>Guruhingiz hali tanlanmagan!</b>\n\nAvval <b>🗓 Dars jadvali</b> bo‘limiga kirib, o‘z guruhingizni tanlang — shunda bot hozir qaysi darsda ekaningizni avtomatik bilib oladi.',
            { parse_mode: 'HTML' }
        );
    }

    const groupName = prefs.student_group;
    const extracted = extractNoteContentFromMessage(ctx.message, isGroupNote ? 'groupnote' : 'note');
    const now = getTashkentNow();

    // 1. AVTOMATIK KONTEKST ANIQLASH: Talaba hozir darsda o'tiribdimi?
    const activeCtx = scheduleService.getActiveOrRecentLessonContext(groupName, now);

    if (activeCtx) {
        const occurrences = scheduleService.getUpcomingSubjectOccurrences(groupName, activeCtx.baseSubject, 5, now);

        if (occurrences.length > 0) {
            await pendingStore.set(`note_wiz:${userId}`, {
                step: extracted ? 'AWAITING_OCCURRENCE' : 'AWAITING_CONTENT_THEN_OCCURRENCE',
                groupName,
                isGroupNote,
                selectedSubject: activeCtx.baseSubject,
                currentLessonTypeCode: activeCtx.lessonType.code,
                occurrences,
                content: extracted
            }, NOTE_STATE_TTL);

            const statusBadge = activeCtx.state === 'IN_PROGRESS'
                ? '🟢 Hozir sizda dars ketmoqda:'
                : '🕒 Hozirgina tugagan dars:';

            if (extracted) {
                return ctx.reply(
                    `${statusBadge} <b>${escapeHtml(activeCtx.baseSubject)}</b> (${activeCtx.lessonType.label})\n` +
                    `📝 <b>Vazifa:</b> <i>${escapeHtml(extracted.text.slice(0, 120))}</i>\n\n` +
                    `👇 <b>Ushbu topshiriqni shu fanning qaysi darsi uchun eslatay?</b>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: buildOccurrencesKeyboard(occurrences, activeCtx.lessonType.code)
                    }
                );
            } else {
                return ctx.reply(
                    `${statusBadge} <b>${escapeHtml(activeCtx.baseSubject)}</b> (${activeCtx.lessonType.label})\n\n` +
                    `✍️ <b>Domla bergan topshiriqni yuboring</b> (matn, doska rasmi, ovozli xabar yoki fayl)\n` +
                    `<i>Yoki boshqa fan bo‘lsa, pastdagi tugmani bosing:</i>`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: {
                            inline_keyboard: [
                                [{ text: '📚 Boshqa fanni tanlash', callback_data: 'note_pick_subj' }],
                                [{ text: '❌ Bekor qilish', callback_data: 'note_cancel' }]
                            ]
                        }
                    }
                );
            }
        }
    }

    // 2. AGAR HOZIR DARS VAQTI BO'LMASA -> Bugungi fanlarni tepaga chiqarib ro'yxat ko'rsatamiz
    const subjects = scheduleService.getGroupUniqueSubjectsSorted(groupName, now);
    if (subjects.length === 0) {
        return ctx.reply('⚠️ Guruhingiz jadvalidan fanlar topilmadi.', { parse_mode: 'HTML' });
    }

    await pendingStore.set(`note_wiz:${userId}`, {
        step: 'AWAITING_SUBJECT',
        groupName,
        isGroupNote,
        subjects: subjects.slice(0, 20),
        content: extracted
    }, NOTE_STATE_TTL);

    return renderSubjectSelectionMenu(ctx, subjects.slice(0, 20), extracted, false);
}

async function renderSubjectSelectionMenu(ctx, subjects, extractedContent, isEdit = false) {
    const buttons = [];
    for (let i = 0; i < subjects.length; i += 2) {
        const row = [];
        const s1 = subjects[i];
        row.push({
            text: `${s1.isToday ? '📍 ' : '📘 '}${s1.name.slice(0, 26)}`,
            callback_data: `note_subj_${i}`
        });
        if (subjects[i + 1]) {
            const s2 = subjects[i + 1];
            row.push({
                text: `${s2.isToday ? '📍 ' : '📘 '}${s2.name.slice(0, 26)}`,
                callback_data: `note_subj_${i + 1}`
            });
        }
        buttons.push(row);
    }
    buttons.push([{ text: '❌ Bekor qilish', callback_data: 'note_cancel' }]);

    const text = (extractedContent
        ? `📝 <b>Topshiriq:</b> <i>${escapeHtml(extractedContent.text.slice(0, 100))}</i>\n\n`
        : '') +
        `📚 <b>Qaysi fan uchun eslatma saqlaymiz?</b>\n<i>(📍 — bugungi jadvalingizda bor fanlar)</i>`;

    if (isEdit) {
        return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } }).catch(() => {});
    }
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
}

/**
 * Callback tugmalar: fan tanlash, dars sanasi/turini tanlash, "Bajarildi" va "Keyingi darsga surish"
 */
async function handleNoteCallback(ctx) {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from.id;

    // 1. Eslatma kelganda "✅ Bajarildi" tugmasi
    if (data.startsWith('note_done_')) {
        const noteId = Number(data.replace('note_done_', ''));
        await ctx.answerCbQuery('✅ Topshiriq bajarildi deb belgilandi!');
        await db.updateClassNote(noteId, { status: 'completed' });
        return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    }

    // 2. Eslatma kelganda "⏳ Keyingi darsga surish (Snooze)" tugmasi
    if (data.startsWith('note_snooze_')) {
        const noteId = Number(data.replace('note_snooze_', ''));
        const note = await db.getNoteById(noteId);
        if (!note) {
            return ctx.answerCbQuery('⚠️ Eslatma topilmadi', { show_alert: true });
        }

        const now = getTashkentNow();
        const futureDate = new Date(now.getTime() + 12 * 3600 * 1000); // Joriy darsdan keyingi darsni qidirish
        const occurrences = scheduleService.getUpcomingSubjectOccurrences(note.group_name, note.subject_name, 6, futureDate);
        const nextOcc = occurrences.find(o => note.target_lesson_type === 'ANY' || o.lessonTypeCode === note.target_lesson_type) || occurrences[0];

        if (!nextOcc) {
            return ctx.answerCbQuery('⚠️ Keyingi haftada ushbu dars topilmadi', { show_alert: true });
        }

        await db.updateClassNote(noteId, {
            target_date: nextOcc.dateIso,
            target_period: nextOcc.period,
            target_start_time: nextOcc.startTime,
            notified_evening: false,
            notified_before_class: false
        });

        await ctx.answerCbQuery(`⏳ ${nextOcc.dateDisplay} (${nextOcc.period}-para) ga ko'chirildi!`, { show_alert: true });
        return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    }

    // 3. Wizard jarayonidagi tugmalar
    const wiz = await pendingStore.get(`note_wiz:${userId}`);
    if (data === 'note_cancel') {
        await pendingStore.delete(`note_wiz:${userId}`);
        await ctx.answerCbQuery('Bekor qilindi');
        return ctx.editMessageText('❌ Eslatma saqlash bekor qilindi.').catch(() => {});
    }

    if (!wiz) {
        return ctx.answerCbQuery('⏳ Sessiya vaqti tugagan. Qaytadan /note yozing.', { show_alert: true });
    }

    if (data === 'note_pick_subj') {
        await ctx.answerCbQuery();
        const subjects = scheduleService.getGroupUniqueSubjectsSorted(wiz.groupName, getTashkentNow()).slice(0, 20);
        wiz.step = 'AWAITING_SUBJECT';
        wiz.subjects = subjects;
        await pendingStore.set(`note_wiz:${userId}`, wiz, NOTE_STATE_TTL);
        return renderSubjectSelectionMenu(ctx, subjects, wiz.content, true);
    }

    if (data.startsWith('note_subj_')) {
        await ctx.answerCbQuery();
        const idx = Number(data.replace('note_subj_', ''));
        const picked = wiz.subjects && wiz.subjects[idx];
        if (!picked) return;

        const occurrences = scheduleService.getUpcomingSubjectOccurrences(wiz.groupName, picked.name, 5, getTashkentNow());
        if (occurrences.length === 0) {
            return ctx.editMessageText(`⚠️ <b>${escapeHtml(picked.name)}</b> fanidan yaqin 3 hafta ichida dars topilmadi.`, { parse_mode: 'HTML' });
        }

        wiz.selectedSubject = picked.name;
        wiz.occurrences = occurrences;

        if (!wiz.content) {
            wiz.step = 'AWAITING_CONTENT_THEN_OCCURRENCE';
            await pendingStore.set(`note_wiz:${userId}`, wiz, NOTE_STATE_TTL);
            return ctx.editMessageText(
                `📘 <b>Fan:</b> ${escapeHtml(picked.name)}\n\n` +
                `✍️ <b>Endi topshiriq matnini (yoki rasm, fayl, ovozli xabar) yuboring:</b>`,
                { parse_mode: 'HTML' }
            );
        }

        wiz.step = 'AWAITING_OCCURRENCE';
        await pendingStore.set(`note_wiz:${userId}`, wiz, NOTE_STATE_TTL);
        return ctx.editMessageText(
            `📘 <b>Fan:</b> ${escapeHtml(picked.name)}\n` +
            `📝 <b>Vazifa:</b> <i>${escapeHtml(wiz.content.text.slice(0, 120))}</i>\n\n` +
            `👇 <b>Qaysi dars oldidan eslatay?</b>`,
            {
                parse_mode: 'HTML',
                reply_markup: buildOccurrencesKeyboard(occurrences, null)
            }
        );
    }

    if (data.startsWith('note_occ_')) {
        await ctx.answerCbQuery('✅ Saqlanmoqda...');
        const occIdx = Number(data.replace('note_occ_', ''));
        const occ = wiz.occurrences && wiz.occurrences[occIdx];
        if (!occ || !wiz.content) return;

        const saved = await db.createClassNote({
            creator_id: userId,
            group_name: wiz.groupName,
            is_group_note: Boolean(wiz.isGroupNote),
            subject_name: wiz.selectedSubject,
            target_lesson_type: occ.lessonTypeCode,
            target_date: occ.dateIso,
            target_period: occ.period,
            target_start_time: occ.startTime,
            note_text: wiz.content.text,
            media_type: wiz.content.mediaType,
            media_file_id: wiz.content.mediaFileId,
            status: 'pending'
        });

        await pendingStore.delete(`note_wiz:${userId}`);

        if (!saved) {
            return ctx.editMessageText('❌ Saqlashda xatolik yuz berdi.').catch(() => {});
        }

        const scopeBadge = wiz.isGroupNote
            ? `👥 <b>Butun ${escapeHtml(wiz.groupName)} guruhi uchun</b>`
            : `👤 <b>Shaxsiy eslatma</b>`;

        return ctx.editMessageText(
            `✅ <b>Topshiriq muvaffaqiyatli saqlandi!</b>\n\n` +
            `${scopeBadge}\n` +
            `📘 <b>Fan:</b> ${escapeHtml(wiz.selectedSubject)}\n` +
            `🎯 <b>Dars turi:</b> ${occ.lessonTypeLabel}\n` +
            `📅 <b>Sana va vaqt:</b> ${occ.dateDisplay} • ${occ.period}-para (${occ.startTime})\n` +
            `📝 <b>Topshiriq:</b> <i>${escapeHtml(wiz.content.text.slice(0, 200))}</i>\n\n` +
            `🔔 <i>Bot sizga darsdan 1 kun oldin kechqurun (20:00) va dars boshlanishidan 30 daqiqa oldin avtomatik eslatadi!</i>`,
            { parse_mode: 'HTML' }
        ).catch(() => {});
    }
}

/**
 * Foydalanuvchi /note bosib, keyin matn/rasm/ovoz yuborganda ushlab oluvchi tekst/media listener
 */
async function handleNoteWizardInput(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return next();

    const wiz = await pendingStore.get(`note_wiz:${userId}`);
    if (!wiz || wiz.step !== 'AWAITING_CONTENT_THEN_OCCURRENCE') {
        return next();
    }

    // Agar foydalanuvchi boshqa buyruq (/start, /help) yozsa, wizardni tozalaymiz
    if (ctx.message?.text?.startsWith('/')) {
        await pendingStore.delete(`note_wiz:${userId}`);
        return next();
    }

    const content = extractNoteContentFromMessage(ctx.message, 'note');
    if (!content) {
        return ctx.reply('⚠️ Iltimos, topshiriq matnini, rasm, ovozli xabar yoki fayl yuboring.');
    }

    wiz.content = content;
    wiz.step = 'AWAITING_OCCURRENCE';
    await pendingStore.set(`note_wiz:${userId}`, wiz, NOTE_STATE_TTL);

    return ctx.reply(
        `📘 <b>Fan:</b> ${escapeHtml(wiz.selectedSubject)}\n` +
        `📝 <b>Vazifa:</b> <i>${escapeHtml(content.text.slice(0, 120))}</i>\n\n` +
        `👇 <b>Ushbu topshiriqni qaysi dars oldidan eslatay?</b>`,
        {
            parse_mode: 'HTML',
            reply_markup: buildOccurrencesKeyboard(wiz.occurrences, wiz.currentLessonTypeCode)
        }
    );
}

module.exports = {
    handleNoteCommand,
    handleNoteCallback,
    handleNoteWizardInput
};
```

---

### QADAM 4: Aqlli Eslatmalar Dispetcheri (`src/services/smartReminderService.js`)

Yangi **`src/services/smartReminderService.js`** faylini yarating. Bu servis har daqiqada (`* * * * *`) ishga tushib:
1. **Smena-moslashuvchan (`shift_aware`)** foydalanuvchilarga 1-smena bo‘lsa `07:00` da, 2-smena (darsi $\ge 13:00$ da boshlansa) `11:30` da jadval yuboradi.
2. **Dinamik offset (`offset_before_first`)** foydalanuvchilarga birinchi darsiga aniq $X\text{ daqiqa}$ (`30`, `60`, `120`) qolganda yuboradi.
3. **Aniq vaqt (`custom_time`)** tanlaganlarga aynan ular belgilagan `HH:mm` da yuboradi.
4. **Dars tugashidan 5 daqiqa oldin (`notif_next_bell`)** keyingi dars xonasini, o‘qituvchini va bino o‘zgargan bo‘lsa `⚠️ Bino almashinuvi` ogohlantirishini yuboradi.
5. **`/note` va `/groupnote` topshiriqlarini** darsdan bir kun oldin (`20:00`) va dars boshlanishidan `30 daqiqa` oldin (rasm/ovoz/fayli bilan birga!) yuboradi.

```javascript
// src/services/smartReminderService.js
const db = require('./dbService');
const scheduleService = require('./scheduleService');
const timetableCdnService = require('./timetableCdnService');
const redisService = require('./redisService');
const { getTashkentNow, escapeHtml } = require('../core/utils');
const logger = require('../core/logger');

const localSentCache = new Map();

/**
 * Idempotency lock: Xabar aynan bir marta yuborilishini kafolatlaydi (Redis + In-Memory fallback)
 */
async function acquireNotificationLock(lockKey, ttlSeconds = 72000) {
    const now = Date.now();
    if (localSentCache.has(lockKey) && localSentCache.get(lockKey) > now) {
        return false;
    }
    localSentCache.set(lockKey, now + ttlSeconds * 1000);

    try {
        if (redisService && redisService.isReady && redisService.client) {
            const res = await redisService.client.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
            return res === 'OK';
        }
    } catch (err) {
        logger.warn(`Redis lock fallback for ${lockKey}: ${err.message}`);
    }
    return true;
}

/**
 * Asosiy har daqiqalik dispetcher (index.js dan har daqiqada chaqiriladi)
 */
async function runMinuteScheduleTick(bot) {
    const now = getTashkentNow();
    const dayIdx = now.getDay(); // 0 = Yakshanba, 1..6 = Dushanba..Shanba
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentHHMM = `${hh}:${mm}`;
    const currentMin = now.getHours() * 60 + now.getMinutes();

    const yyyy = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const todayIso = `${yyyy}-${month}-${dd}`;

    const users = await db.getAllSubscribedScheduleUsers();
    if (!users || users.length === 0) return;

    // Guruhlar bo'yicha bugungi jadvallarni bir marta hisoblab keshga olamiz
    const groupDayCache = new Map();
    const getCachedTodaySchedule = (groupName) => {
        if (dayIdx === 0) return [];
        if (!groupDayCache.has(groupName)) {
            groupDayCache.set(groupName, scheduleService.getGroupScheduleForDay(groupName, dayIdx, now) || []);
        }
        return groupDayCache.get(groupName);
    };

    // 1. FOYDALANUVCHILAR BO'YICHA KUNLIK JADVAL VA 5-DAQIQALIK QO'NG'IROQ
    for (const user of users) {
        if (user.schedule_notifications === false || user.notif_mode === 'disabled') continue;
        const groupName = user.student_group;
        if (!groupName) continue;

        const todayLessons = getCachedTodaySchedule(groupName);
        const firstLesson = todayLessons.length > 0 ? todayLessons[0] : null;
        const firstStartMin = firstLesson ? scheduleService.parseTimeToMinutes(firstLesson.startTime) : null;

        const mode = user.notif_mode || 'shift_aware';

        // --- A) KUNLIK JADVAL XULOSASI (Daily Briefing) ---
        let shouldSendTodayBriefing = false;
        let briefingReason = '';

        if (dayIdx >= 1 && dayIdx <= 6 && firstLesson) {
            if (mode === 'shift_aware') {
                // 1-smena (< 13:00) -> 07:00 da; 2-smena / kechki (>= 13:00) -> 11:30 da
                if (firstStartMin < 13 * 60 && currentHHMM === '07:00') {
                    shouldSendTodayBriefing = true;
                    briefingReason = '☀️ Ertalabki smena jadvali';
                } else if (firstStartMin >= 13 * 60 && currentHHMM === '11:30') {
                    shouldSendTodayBriefing = true;
                    briefingReason = `🌤 Tushdan keyingi smena (${firstLesson.startTime} da boshlanadi)`;
                }
            } else if (mode === 'offset_before_first') {
                const offset = Number(user.notif_offset_min) || 60;
                if (currentMin === firstStartMin - offset) {
                    shouldSendTodayBriefing = true;
                    briefingReason = `⏰ Birinchi darsingizga ${offset} daqiqa qoldi!`;
                }
            } else if (mode === 'custom_time') {
                if (user.notif_custom_time === currentHHMM && currentMin < 14 * 60) {
                    shouldSendTodayBriefing = true;
                    briefingReason = `🎯 Belgilangan vaqt (${currentHHMM}) eslatmasi`;
                }
            }
        }

        if (shouldSendTodayBriefing) {
            const lockKey = `notif_lock:daily:${user.telegram_id}:${todayIso}`;
            if (await acquireNotificationLock(lockKey, 64800)) {
                await sendDailyScheduleCard(bot, user.telegram_id, groupName, dayIdx, briefingReason);
            }
        }

        // --- B) KECHKI ERTANGI KUN ANONSI (20:00 yoki Custom Evening Time) ---
        const nextDayDate = new Date(now.getTime() + 86400000);
        const nextDayIdx = nextDayDate.getDay();
        const isCustomEvening = mode === 'custom_time' && user.notif_custom_time === currentHHMM && currentMin >= 14 * 60;
        const isStandardEvening = user.notif_evening_preview !== false && currentHHMM === '20:00' && mode !== 'custom_time';

        if (nextDayIdx >= 1 && nextDayIdx <= 6 && (isCustomEvening || isStandardEvening)) {
            const tomorrowLessons = scheduleService.getGroupScheduleForDay(groupName, nextDayIdx, nextDayDate) || [];
            if (tomorrowLessons.length > 0) {
                const lockKey = `notif_lock:evening:${user.telegram_id}:${todayIso}`;
                if (await acquireNotificationLock(lockKey, 64800)) {
                    await sendDailyScheduleCard(
                        bot,
                        user.telegram_id,
                        groupName,
                        nextDayIdx,
                        `🌙 Ertangi kun (${tomorrowLessons[0].startTime} da boshlanadi) dars jadvali:`
                    );
                }
            }
        }

        // --- C) PARA TUGASHIDAN 5 DAQIQA OLDIN "KEYINGI DARS" QO'NG'IROG'I ---
        if (dayIdx >= 1 && dayIdx <= 6 && user.notif_next_bell !== false && todayLessons.length >= 2) {
            for (let i = 0; i < todayLessons.length - 1; i++) {
                const curr = todayLessons[i];
                const next = todayLessons[i + 1];
                const currEndMin = scheduleService.parseTimeToMinutes(curr.endTime);

                if (currentMin === currEndMin - 5) {
                    // Agar 2 para ketma-ket aynan bitta fan va bitta xona bo'lsa, bezovta qilmaymiz
                    const sameSubject = scheduleService.normalizeBaseSubjectName(curr.subject) === scheduleService.normalizeBaseSubjectName(next.subject);
                    const sameRoom = (curr.room || '') === (next.room || '');
                    if (sameSubject && sameRoom) continue;

                    const lockKey = `notif_lock:bell5m:${user.telegram_id}:${todayIso}:p${curr.period}`;
                    if (await acquireNotificationLock(lockKey, 43200)) {
                        await sendNextLectureBell(bot, user.telegram_id, curr, next);
                    }
                }
            }
        }
    }

    // 2. KONTEKSTUAL TOPSHIRIQLAR (/note va /groupnote) ESLATMALARI
    await processContextualNotesTick(bot, users, now, todayIso, currentHHMM, currentMin);
}

/**
 * Para tugashidan 5 daqiqa oldin keyingi dars haqida tezkor matnli Push-xabar yuborish
 */
async function sendNextLectureBell(bot, chatId, currentLesson, nextLesson) {
    const currBld = scheduleService.extractBuildingFromRoom(currentLesson.room);
    const nextBld = scheduleService.extractBuildingFromRoom(nextLesson.room);
    const nextType = scheduleService.detectLessonType(nextLesson);

    let buildingAlert = '';
    if (currBld && nextBld && currBld !== nextBld) {
        buildingAlert = `\n🏃‍♂️ <b>DIQQAT: Boshqa binoga o‘tish kerak! (${currBld}-bino ➡️ ${nextBld}-bino)</b>`;
    }

    const msg =
        `🔔 <b>5 daqiqadan so‘ng ${currentLesson.period}-para tugaydi!</b>\n\n` +
        `👉 <b>Keyingi dars (${nextLesson.period}-para • ${nextLesson.startTime}):</b>\n` +
        `📘 <b>${escapeHtml(nextLesson.subject)}</b> (${nextType.label})\n` +
        `📍 <b>Xona:</b> ${escapeHtml(nextLesson.room || 'Noma\'lum')}${buildingAlert}\n` +
        (nextLesson.teacher ? `👨‍🏫 <b>O‘qituvchi:</b> ${escapeHtml(nextLesson.teacher)}` : '');

    await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' }).catch(() => {});
}

/**
 * Kunlik jadval kartochkasini (CDN rasm yoki matn) yuborish
 */
async function sendDailyScheduleCard(bot, chatId, groupName, dayIdx, headerCaption) {
    try {
        await timetableCdnService.sendTimetableImage(bot, chatId, groupName, dayIdx, headerCaption);
    } catch (err) {
        logger.warn(`sendDailyScheduleCard fallback for ${chatId}: ${err.message}`);
    }
}

/**
 * /note va /groupnote topshiriqlarini darsdan 1 kun oldin (20:00) va darsga 30 daqiqa qolganda eslatish
 */
async function processContextualNotesTick(bot, allUsers, now, todayIso, currentHHMM, currentMin) {
    // A) Bugungi darsga 30 daqiqa qolganda eslatish
    const todayNotes = await db.getPendingNotesForDate(todayIso);
    for (const note of todayNotes) {
        if (note.notified_before_class) continue;
        const startMin = scheduleService.parseTimeToMinutes(note.target_start_time);

        if (currentMin >= startMin - 30 && currentMin <= startMin - 25) {
            await db.updateClassNote(note.id, { notified_before_class: true });
            await deliverNoteReminder(bot, note, allUsers, `⏰ <b>Dars boshlanishiga 30 daqiqa qoldi! (${note.target_start_time})</b>`);
        }
    }

    // B) Kechqurun 20:05 da ertangi darslar uchun yozilgan topshiriqlarni eslatish
    if (currentHHMM === '20:05') {
        const tomorrow = new Date(now.getTime() + 86400000);
        const tIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
        const tomorrowNotes = await db.getPendingNotesForDate(tIso);

        for (const note of tomorrowNotes) {
            if (note.notified_evening) continue;
            await db.updateClassNote(note.id, { notified_evening: true });
            await deliverNoteReminder(bot, note, allUsers, `🌙 <b>Ertaga (${note.target_period}-para, ${note.target_start_time}) ushbu darsdan topshirig‘ingiz bor:</b>`);
        }
    }
}

async function deliverNoteReminder(bot, note, allUsers, headerTitle) {
    const recipients = note.is_group_note
        ? allUsers.filter(u => u.student_group === note.group_name).map(u => u.telegram_id)
        : [note.creator_id];

    const textBody =
        `${headerTitle}\n\n` +
        `📘 <b>Fan:</b> ${escapeHtml(note.subject_name)}\n` +
        `📝 <b>Topshiriq:</b>\n${escapeHtml(note.note_text || '')}`;

    for (const targetId of recipients) {
        const isOwner = String(targetId) === String(note.creator_id);
        const replyMarkup = isOwner
            ? {
                inline_keyboard: [[
                    { text: '✅ Bajarildi', callback_data: `note_done_${note.id}` },
                    { text: '⏳ Keyingi darsga surish', callback_data: `note_snooze_${note.id}` }
                ]]
            }
            : undefined;

        try {
            if (note.media_type === 'photo' && note.media_file_id) {
                await bot.telegram.sendPhoto(targetId, note.media_file_id, {
                    caption: textBody.slice(0, 1024),
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
                });
            } else if (note.media_type === 'document' && note.media_file_id) {
                await bot.telegram.sendDocument(targetId, note.media_file_id, {
                    caption: textBody.slice(0, 1024),
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
                });
            } else if (note.media_type === 'voice' && note.media_file_id) {
                await bot.telegram.sendVoice(targetId, note.media_file_id, {
                    caption: textBody.slice(0, 1024),
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
                });
            } else {
                await bot.telegram.sendMessage(targetId, textBody, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
                });
            }
        } catch (err) {
            logger.warn(`Failed to deliver note #${note.id} to ${targetId}: ${err.message}`);
        }
    }
}

module.exports = {
    runMinuteScheduleTick
};
```

---

### QADAM 5: `src/handlers/scheduleHandler.js` da Yangi Sozlamalar Panelini Yaratish

`src/handlers/scheduleHandler.js` fayliga foydalanuvchi o‘z eslatma rejimini (`Smena-avto`, `Darsdan X daqiqa oldin`, `Aniq vaqt` va `5-daqiqalik qo'ng'iroq`) bitta ekranda boshqara oladigan interaktiv menyuni qo‘shing:

```javascript
async function showSmartScheduleSettings(ctx) {
    const userId = ctx.from.id;
    const prefs = await db.getUserSchedulePrefs(userId);

    const modeLabels = {
        shift_aware: '🌗 Smena-avto (1-smena 07:00 / 2-smena 11:30)',
        offset_before_first: `⏳ 1-darsdan ${prefs.notif_offset_min} daqiqa oldin`,
        custom_time: `🎯 Aniq belgilangan vaqtda (${prefs.notif_custom_time})`,
        disabled: '🔕 Kunlik jadval o‘chirilgan'
    };

    const text =
        `⚙️ <b>Aqlli Dars Jadvali Eslatmalari Sozlamalari</b>\n\n` +
        `👥 <b>Guruhingiz:</b> ${escapeHtml(prefs.student_group || 'Tanlanmagan')}\n` +
        `📡 <b>Joriy rejim:</b> ${modeLabels[prefs.notif_mode] || modeLabels.shift_aware}\n` +
        `🔔 <b>Para tugashidan 5 daqiqa oldin keyingi dars eslatmasi:</b> ${prefs.notif_next_bell ? '✅ Yoqilgan' : '❌ O‘chirilgan'}\n` +
        `🌙 <b>Kechki 20:00 da ertangi jadval:</b> ${prefs.notif_evening_preview ? '✅ Yoqilgan' : '❌ O‘chirilgan'}\n\n` +
        `👇 <i>O‘zingizga eng qulay rejimni tanlang:</i>`;

    const keyboard = {
        inline_keyboard: [
            [{
                text: `${prefs.notif_mode === 'shift_aware' ? '🔘' : '⚪️'} 🌗 Smena-avto (Tavsiya etiladi)`,
                callback_data: 'sched_mode_shift'
            }],
            [
                {
                    text: `${prefs.notif_mode === 'offset_before_first' && prefs.notif_offset_min === 30 ? '🔘' : '⚪️'} ⏳ 30 daq oldin`,
                    callback_data: 'sched_offset_30'
                },
                {
                    text: `${prefs.notif_mode === 'offset_before_first' && prefs.notif_offset_min === 60 ? '🔘' : '⚪️'} ⏳ 1 soat oldin`,
                    callback_data: 'sched_offset_60'
                },
                {
                    text: `${prefs.notif_mode === 'offset_before_first' && prefs.notif_offset_min === 120 ? '🔘' : '⚪️'} ⏳ 2 soat oldin`,
                    callback_data: 'sched_offset_120'
                }
            ],
            [
                { text: '🎯 Aniq vaqt: 06:30', callback_data: 'sched_ctime_06:30' },
                { text: '🎯 07:30', callback_data: 'sched_ctime_07:30' },
                { text: '🎯 21:00', callback_data: 'sched_ctime_21:00' }
            ],
            [{
                text: `🔔 5 daqiqa oldin keyingi para eslatmasi: ${prefs.notif_next_bell ? 'ON ✅' : 'OFF ❌'}`,
                callback_data: 'sched_toggle_bell5m'
            }],
            [{
                text: `🌙 Kechqurun (20:00) ertangi jadval: ${prefs.notif_evening_preview ? 'ON ✅' : 'OFF ❌'}`,
                callback_data: 'sched_toggle_evening'
            }],
            [{
                text: `${prefs.notif_mode === 'disabled' ? '🔘' : '⚪️'} 🔕 Barcha jadval eslatmalarini o‘chirish`,
                callback_data: 'sched_mode_disabled'
            }],
            [{ text: '⬅️ Orqaga', callback_data: 'sched_back_main' }]
        ]
    };

    if (ctx.callbackQuery) {
        return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch(() => {});
    }
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
```

Va `scheduleHandler.js` ichidagi callback router’ga quyidagi tarmoqlarni qo‘shing:
* `sched_mode_shift` $\rightarrow$ `db.updateUserSchedulePrefs(userId, { notif_mode: 'shift_aware', schedule_notifications: true })`
* `sched_offset_30` | `sched_offset_60` | `sched_offset_120` $\rightarrow$ `db.updateUserSchedulePrefs(userId, { notif_mode: 'offset_before_first', notif_offset_min: min, schedule_notifications: true })`
* `sched_ctime_...` $\rightarrow$ `db.updateUserSchedulePrefs(userId, { notif_mode: 'custom_time', notif_custom_time: timeStr, schedule_notifications: true })`
* `sched_toggle_bell5m` $\rightarrow$ `notif_next_bell` ni teskarisiga o‘girish (`!prefs.notif_next_bell`).
* `sched_toggle_evening` $\rightarrow$ `notif_evening_preview` ni teskarisiga o‘girish (`!prefs.notif_evening_preview`).
* `sched_mode_disabled` $\rightarrow$ `db.updateUserSchedulePrefs(userId, { notif_mode: 'disabled', schedule_notifications: false })`

---

### QADAM 6: `index.js` ga Integratsiya Qilish (Wiring)

`index.js` faylida:
1. `noteHandler` va `smartReminderService` ni import qiling:
   ```javascript
   const { handleNoteCommand, handleNoteCallback, handleNoteWizardInput } = require('./src/handlers/noteHandler');
   const { runMinuteScheduleTick } = require('./src/services/smartReminderService');
   ```
2. Komanda va callbacklarni ro‘yxatdan o‘tkazing:
   ```javascript
   bot.command('note', (ctx) => handleNoteCommand(ctx, false));
   bot.command('groupnote', (ctx) => handleNoteCommand(ctx, true));
   bot.action(/^note_(subj_|occ_|pick_subj|cancel|done_|snooze_)/, handleNoteCallback);
   ```
3. `bot.on(['text', 'photo', 'document', 'voice'], ...)` middleware zanjirining boshiga `handleNoteWizardInput` ni qo‘shing, toki `/note` bosgandan keyin yuborilgan rasm, ovoz yoki matn darhol ushlansin.
4. Oldingi statik `0 7 * * 1-6` va `0 20 * * 0-5` cronlar o‘rniga har daqiqada ishlovchi yagona aqlli dispetcherni ulang:
   ```javascript
   cron.schedule('* * * * *', () => {
       runMinuteScheduleTick(bot).catch(err => logger.error(`Smart schedule tick error: ${err.message}`));
   });
   ```

---

## 🧪 4-BO‘LIM: AVTOMATLASHTIRILGAN VERIFIKATSIYA TESTI (`scripts/test_smart_schedule_v2.js`)

AGY CLI barcha o‘zgarishlarni kiritib bo‘lgach, `scripts/test_smart_schedule_v2.js` faylini yaratib, quyidagi 6 ta ssenariyni `assert` orqali tekshirishi va `node scripts/test_smart_schedule_v2.js` komandasida **100% PASS** olishi shart:

1. **Test 1 (Lesson Type Detection):** `"Korporativ moliya (Ma'ruza)"` $\rightarrow$ `LECTURE`, `"Korporativ moliya (Amaliyot)"` yoki subgroup bor dars $\rightarrow$ `PRACTICE`, `"Fizika (Lab)"` $\rightarrow$ `LAB`.
2. **Test 2 (Active Class Auto-Detection):** Guruhda soat `09:00` da 1-para (`08:30–09:50`) ketayotganda `getActiveOrRecentLessonContext()` aynan shu fanni `IN_PROGRESS` holatida qaytarishi; soat `10:00` da (tanaffusda) `JUST_FINISHED` holatida qaytarishi.
3. **Test 3 (Lecture $\to$ Next Practice Resolution):** Ma’ruzada o‘tirgan talaba uchun `getUpcomingSubjectOccurrences()` keyingi kunlardagi **Amaliyot/Seminar** va **Ma’ruza** darslarini aniq sanasi bilan topishi va klaviaturada Amaliyotni `⭐ Keyingi Amaliyot` sifatida ajratib ko‘rsatishi.
4. **Test 4 (Shift-Aware Logic):** 1-darsi `13:30` da boshlanadigan 2-smena guruhi uchun `07:00` da xabar ketmasdan, `11:30` da yuborilishi.
5. **Test 5 (5-Minute Bell & Building Hopping):** `A-204` xonadan `B-305` xonaga o‘tilayotganda 5 daqiqa oldingi xabarda `A-bino ➡️ B-bino` ogohlantirishi chiqishi; ketma-ket 2 para bir xil fan/xona bo‘lganda esa xabar yuborilmasligi.
6. **Test 6 (64-Byte Callback Safety):** `note_subj_0`, `note_occ_1`, `note_done_123`, `note_snooze_123` callbacklarining barchasi $\le 64\text{ bayt}$ ekanligi.