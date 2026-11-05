-- ============================================================================
-- SUPABASE OPTIMIZATION & SECURITY (RLS) MIGRATION SCRIPT
-- ============================================================================

-- 1. Dublikat indeksni o'chirish (Write I/O ni kamaytiradi)
DROP INDEX IF EXISTS public.idx_timetable_cache_lookup;

-- 2. user_tests jadvali uchun tezkor kompozit indeks (creator_id + id DESC)
CREATE INDEX IF NOT EXISTS idx_user_tests_creator_id_desc
  ON public.user_tests (creator_id, id DESC);

-- 3. Barcha ommaviy jadvallarda Row Level Security (RLS) ni yoqish
ALTER TABLE IF EXISTS public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.official_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.kahoot_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.user_schedule_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.course_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.timetable_cache ENABLE ROW LEVEL SECURITY;

-- 4. service_role uchun to'liq ruxsat (Node.js backend service_role ishlatsa avtomatik o'tadi,
-- ammo explicit policy bo'lishi eng yaxshi amaliyot hisoblanadi)
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'users', 'user_stats', 'user_tests', 'official_tests',
    'kahoot_questions', 'subjects', 'user_schedule_settings',
    'course_notes', 'timetable_cache'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = tbl) THEN
      EXECUTE format('DROP POLICY IF EXISTS "service_role_all_access" ON public.%I', tbl);
      EXECUTE format(
        'CREATE POLICY "service_role_all_access" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)',
        tbl
      );
    END IF;
  END LOOP;
END
$$;
