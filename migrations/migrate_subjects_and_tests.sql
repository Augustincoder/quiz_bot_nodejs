-- ==============================================================================
-- MIGRATION: Connect user_tests to subjects table via subject_id with ZERO DATA LOSS
-- Safe, idempotent SQL script that can be run repeatedly without issues.
-- ==============================================================================

-- 1. Ensure any creator_id from user_tests exists in users table to satisfy
--    CONSTRAINT subjects_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(telegram_id)
INSERT INTO public.users (telegram_id, full_name, username, created_at)
SELECT DISTINCT ut.creator_id, 'Foydalanuvchi', NULL, now()
FROM public.user_tests ut
WHERE ut.creator_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.users u WHERE u.telegram_id = ut.creator_id
  )
ON CONFLICT (telegram_id) DO NOTHING;

-- 2. Populate subjects table for any user_tests that have subject names
--    Grouped by creator_id and trimmed subject name
INSERT INTO public.subjects (name, creator_id, created_at)
SELECT 
    TRIM(ut.subject) AS name,
    ut.creator_id,
    COALESCE(MIN(ut.created_at), now()) AS created_at
FROM public.user_tests ut
WHERE ut.creator_id IS NOT NULL
  AND ut.subject IS NOT NULL 
  AND TRIM(ut.subject) <> ''
  AND NOT EXISTS (
    SELECT 1 
    FROM public.subjects s 
    WHERE s.creator_id = ut.creator_id 
      AND LOWER(TRIM(s.name)) = LOWER(TRIM(ut.subject))
  )
GROUP BY ut.creator_id, TRIM(ut.subject);

-- 3. Update user_tests.subject_id to link with the corresponding subjects.id
UPDATE public.user_tests ut
SET subject_id = s.id
FROM public.subjects s
WHERE ut.creator_id = s.creator_id
  AND LOWER(TRIM(ut.subject)) = LOWER(TRIM(s.name))
  AND ut.subject_id IS NULL;

-- 4. In case any test already had subject_id but subject name was empty, sync name
UPDATE public.user_tests ut
SET subject = s.name
FROM public.subjects s
WHERE ut.subject_id = s.id
  AND (ut.subject IS NULL OR TRIM(ut.subject) = '');

-- 5. Add helpful indexes for high-speed queries and next-block lookups
CREATE INDEX IF NOT EXISTS idx_user_tests_subject_id ON public.user_tests(subject_id);
CREATE INDEX IF NOT EXISTS idx_subjects_creator_name ON public.subjects(creator_id, name);
CREATE INDEX IF NOT EXISTS idx_user_tests_creator_id ON public.user_tests(creator_id);
