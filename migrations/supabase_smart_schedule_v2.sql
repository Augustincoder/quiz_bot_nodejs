-- ====================================================================
-- SMART TIMETABLE & CONTEXTUAL REMINDER ENGINE v2.0 - SUPABASE MIGRATION
-- Repozitoriy: quiz_bot_nodejs
-- ====================================================================

-- 1. FOYDALANUVCHILARNING JADVAL VA ESLATMA SOZLAMALARI JADVALI
CREATE TABLE IF NOT EXISTS public.user_schedule_settings (
  telegram_id BIGINT PRIMARY KEY,
  group_name TEXT,
  notify_mode TEXT NOT NULL DEFAULT 'shift_aware' CHECK (notify_mode IN ('shift_aware', 'offset_before_first', 'custom_time', 'standard_both', 'disabled')),
  offset_minutes INTEGER NOT NULL DEFAULT 60 CHECK (offset_minutes IN (10, 15, 20, 30, 60, 120)),
  custom_morning_time TEXT DEFAULT '07:00',
  custom_evening_time TEXT DEFAULT '20:00',
  pre_class_5min_bell BOOLEAN NOT NULL DEFAULT true,
  building_change_alert BOOLEAN NOT NULL DEFAULT true,
  quiet_hours_enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indekslar
CREATE INDEX IF NOT EXISTS idx_user_schedule_settings_group 
  ON public.user_schedule_settings (group_name);
CREATE INDEX IF NOT EXISTS idx_user_schedule_settings_mode 
  ON public.user_schedule_settings (notify_mode);

-- Mavjud public.users jadvaliga ham mos maydonlarni qo'shib qo'yamiz (orqaga moslik uchun)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS notif_mode TEXT DEFAULT 'shift_aware',
      ADD COLUMN IF NOT EXISTS notif_offset_min INTEGER DEFAULT 60,
      ADD COLUMN IF NOT EXISTS notif_custom_time TEXT DEFAULT '07:00',
      ADD COLUMN IF NOT EXISTS notif_evening_preview BOOLEAN DEFAULT true,
      ADD COLUMN IF NOT EXISTS notif_next_bell BOOLEAN DEFAULT true;
  END IF;
END $$;

-- 2. KONTEKSTUAL VAZIFALAR VA DARSLIK ESLATMALARI (/note, /groupnote) JADVALI
CREATE TABLE IF NOT EXISTS public.course_notes (
  id BIGSERIAL PRIMARY KEY,
  creator_id BIGINT NOT NULL,
  group_name TEXT NOT NULL,
  is_group_shared BOOLEAN NOT NULL DEFAULT false,
  subject_name TEXT NOT NULL,
  subject_norm TEXT NOT NULL,
  target_lesson_type TEXT NOT NULL DEFAULT 'any' CHECK (target_lesson_type IN ('lecture', 'practice', 'lab', 'any')),
  target_date TEXT NOT NULL, -- 'YYYY-MM-DD' Toshkent sanasi
  target_period INTEGER NOT NULL CHECK (target_period BETWEEN 1 AND 8),
  target_start_time TEXT, -- 'HH:mm'
  note_text TEXT,
  media_file_id TEXT,
  media_type TEXT CHECK (media_type IN ('photo', 'document', 'voice') OR media_type IS NULL),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'notified_evening', 'completed', 'snoozed', 'cancelled')),
  notified_evening_at TIMESTAMPTZ,
  notified_before_class_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- course_notes uchun qidiruv va filtr indekslari
CREATE INDEX IF NOT EXISTS idx_course_notes_due 
  ON public.course_notes (status, target_date, group_name);

CREATE INDEX IF NOT EXISTS idx_course_notes_creator 
  ON public.course_notes (creator_id, status);

CREATE INDEX IF NOT EXISTS idx_course_notes_group_active 
  ON public.course_notes (group_name, is_group_shared, status);

-- Trigger: updated_at maydonini avtomatik yangilash
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
   NEW.updated_at = NOW();
   RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_schedule_settings_updated_at ON public.user_schedule_settings;
CREATE TRIGGER trg_user_schedule_settings_updated_at
  BEFORE UPDATE ON public.user_schedule_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_course_notes_updated_at ON public.course_notes;
CREATE TRIGGER trg_course_notes_updated_at
  BEFORE UPDATE ON public.course_notes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
