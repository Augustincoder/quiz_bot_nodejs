'use strict';

/**
 * Migration Script: Migrate existing user_tests to subjects table with zero data loss.
 * Can be executed via: node scripts/migrate_subjects_and_tests.js
 */

const { supabase } = require('../src/lib/supabase');
const logger = require('../src/core/logger');

async function runMigration() {
  if (!supabase) {
    console.error('❌ Supabase client ulanmagan! .env faylida SUPABASE_URL va SUPABASE_KEY mavjudligini tekshiring.');
    console.log('💡 Agar SQL orqali to\'g\'ridan-to\'g\'ri bajarmoqchi bo\'lsangiz, scripts/migrate_subjects_and_tests.sql faylini Supabase SQL Editor ga nusxalang.');
    process.exit(1);
  }

  console.log('🚀 Migratsiya boshlandi: user_tests -> subjects...');

  try {
    // 1. users jadvalida yo'q creator_idlarni aniqlash va kiritish
    const { data: testUsers, error: userFetchErr } = await supabase
      .from('user_tests')
      .select('creator_id')
      .not('creator_id', 'is', null);

    if (userFetchErr) throw userFetchErr;

    const uniqueCreatorIds = Array.from(new Set((testUsers || []).map((t) => String(t.creator_id)).filter(Boolean)));
    console.log(`📊 user_tests ichida ${uniqueCreatorIds.length} ta noyob creator_id topildi.`);

    for (const uid of uniqueCreatorIds) {
      await supabase
        .from('users')
        .upsert(
          { telegram_id: uid, full_name: 'Foydalanuvchi' },
          { onConflict: 'telegram_id', ignoreDuplicates: true }
        );
    }

    // 2. Mavjud fanlar va testlarni olish
    const { data: allTests, error: testErr } = await supabase
      .from('user_tests')
      .select('id, creator_id, subject, subject_id, created_at')
      .order('id', { ascending: true });

    if (testErr) throw testErr;

    const { data: existingSubjects, error: subjErr } = await supabase
      .from('subjects')
      .select('*');

    if (subjErr) throw subjErr;

    console.log(`📋 Jami testlar: ${allTests.length} ta. Mavjud fanlar: ${existingSubjects.length} ta.`);

    // creator_id + normalized_name bo'yicha subject xaritasi
    const subjectMap = new Map();
    for (const s of existingSubjects) {
      const key = `${s.creator_id}:${String(s.name || '').trim().toLowerCase()}`;
      subjectMap.set(key, s);
    }

    let createdSubjectsCount = 0;
    let updatedTestsCount = 0;

    // 3. subjects jadvalida yo'q fanlarni kiritish
    for (const t of allTests) {
      if (!t.creator_id || !t.subject) continue;
      const normName = String(t.subject).trim();
      if (!normName) continue;
      const key = `${t.creator_id}:${normName.toLowerCase()}`;

      if (!subjectMap.has(key)) {
        const { data: newSubj, error: createErr } = await supabase
          .from('subjects')
          .insert({
            name: normName,
            creator_id: String(t.creator_id),
            created_at: t.created_at || new Date().toISOString(),
          })
          .select('*')
          .single();

        if (createErr) {
          console.error(`⚠️ Fanni yaratishda xato [${normName}]:`, createErr.message);
          continue;
        }

        subjectMap.set(key, newSubj);
        createdSubjectsCount++;
      }
    }

    // 4. user_tests.subject_id ni to'ldirish
    for (const t of allTests) {
      if (!t.subject_id && t.creator_id && t.subject) {
        const normName = String(t.subject).trim();
        const key = `${t.creator_id}:${normName.toLowerCase()}`;
        const subj = subjectMap.get(key);

        if (subj) {
          const { error: updateErr } = await supabase
            .from('user_tests')
            .update({ subject_id: subj.id })
            .eq('id', t.id);

          if (updateErr) {
            console.error(`⚠️ Test ${t.id} ni yangilashda xato:`, updateErr.message);
          } else {
            updatedTestsCount++;
          }
        }
      }
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ Migratsiya muvaffaqiyatli yakunlandi!`);
    console.log(`✨ Yaratilgan yangi fanlar: ${createdSubjectsCount} ta`);
    console.log(`🔗 Yangilangan testlar (subject_id ga bog'langan): ${updatedTestsCount} ta`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  } catch (err) {
    console.error('❌ Migratsiya jarayonida kutilmagan xato:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
