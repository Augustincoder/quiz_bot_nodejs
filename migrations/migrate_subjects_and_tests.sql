-- ==============================================================================
-- MIGRATION: Connect user_tests to subjects table via subject_id with ZERO DATA LOSS
-- Ushbu skript oldingi SQL strukturasiga (subjects_name_creator_unique) 100% mos
-- va yangi yaratilgan (subject_id IS NULL bo'lib qolgan) barcha testlarni bog'laydi.
-- ==============================================================================

-- 1. Foreign Key cheklovi xato bermasligi uchun creator_id larni users ga kiritish
INSERT INTO public.users (telegram_id, full_name, username, created_at)
SELECT DISTINCT ut.creator_id, 'Foydalanuvchi', NULL, now()
FROM public.user_tests ut
WHERE ut.creator_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.telegram_id = ut.creator_id
  )
ON CONFLICT (telegram_id) DO NOTHING;

-- 2. Yangi yaratilgan testlardagi fanlarni subjects ga qo'shish (mavjudlari ON CONFLICT orqali o'tkazib yuboriladi)
INSERT INTO public.subjects (name, creator_id)
SELECT DISTINCT TRIM(ut.subject) AS name, ut.creator_id
FROM public.user_tests ut
WHERE ut.creator_id IS NOT NULL
  AND ut.subject IS NOT NULL 
  AND TRIM(ut.subject) <> ''
ON CONFLICT (name, creator_id) DO NOTHING;

-- 3. subject_id si NULL bo'lib qolgan barcha testlarni tegishli subjects.id ga bog'lash
UPDATE public.user_tests ut
SET subject_id = s.id
FROM public.subjects s
WHERE ut.creator_id = s.creator_id
  AND (ut.subject = s.name OR LOWER(TRIM(ut.subject)) = LOWER(TRIM(s.name)))
  AND ut.subject_id IS NULL;

-- 4. Agar biror eski testda subject_id bo'lib, subject nomi bo'sh qolgan bo'lsa, nomini to'ldirish
UPDATE public.user_tests ut
SET subject = s.name
FROM public.subjects s
WHERE ut.subject_id = s.id
  AND (ut.subject IS NULL OR TRIM(ut.subject) = '');

-- 5. Tezkor navigatsiya va keyingi bloklarni bir zumda topish uchun indekslar
CREATE INDEX IF NOT EXISTS idx_user_tests_subject_id ON public.user_tests(subject_id);
CREATE INDEX IF NOT EXISTS idx_subjects_creator_name ON public.subjects(creator_id, name);
CREATE INDEX IF NOT EXISTS idx_user_tests_creator_id ON public.user_tests(creator_id);
