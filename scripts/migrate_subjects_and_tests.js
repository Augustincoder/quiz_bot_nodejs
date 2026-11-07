'use strict';

/**
 * Migration Script: Migrate existing user_tests to subjects table in PostgreSQL.
 * Can be executed via: node scripts/migrate_subjects_and_tests.js
 */

const { isPostgresAvailable, query: pgQuery, withTransaction, pool } = require('../src/lib/postgres');
const logger = require('../src/core/logger');

async function runMigration() {
  if (!isPostgresAvailable()) {
    console.error('❌ PostgreSQL ulanmagan! .env faylida DATABASE_URL mavjudligini tekshiring.');
    process.exit(1);
  }

  console.log('🚀 Migratsiya boshlandi: user_tests -> subjects (PostgreSQL)...');

  try {
    // 1. Ensure creator_ids exist in users table
    const testUsers = await pgQuery('SELECT DISTINCT creator_id FROM user_tests WHERE creator_id IS NOT NULL');
    console.log(`📊 user_tests ichida ${testUsers.rows.length} ta noyob creator_id topildi.`);

    for (const row of testUsers.rows) {
      await pgQuery(
        'INSERT INTO users (telegram_id, full_name) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
        [row.creator_id, 'Foydalanuvchi']
      );
    }

    // 2. Fetch existing subjects and tests
    const allTests = await pgQuery('SELECT id, creator_id, subject, subject_id, created_at FROM user_tests ORDER BY id ASC');
    const existingSubjects = await pgQuery('SELECT * FROM subjects');

    console.log(`📋 Jami testlar: ${allTests.rows.length} ta. Mavjud fanlar: ${existingSubjects.rows.length} ta.`);

    const subjectMap = new Map();
    for (const s of existingSubjects.rows) {
      const key = `${s.creator_id}:${String(s.subject_name || s.name || '').trim().toLowerCase()}`;
      subjectMap.set(key, s);
    }

    let createdSubjectsCount = 0;
    let updatedTestsCount = 0;

    // 3. Insert missing subjects
    for (const t of allTests.rows) {
      if (!t.creator_id || !t.subject) continue;
      const normName = String(t.subject).trim();
      if (!normName) continue;
      const key = `${t.creator_id}:${normName.toLowerCase()}`;

      if (!subjectMap.has(key)) {
        const ins = await pgQuery(
          'INSERT INTO subjects (creator_id, subject_name, subject_norm, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
          [t.creator_id, normName, normName.toLowerCase()]
        );
        const newSubj = ins.rows[0];
        subjectMap.set(key, newSubj);
        createdSubjectsCount++;
      }
    }

    // 4. Fill user_tests.subject_id
    for (const t of allTests.rows) {
      if (!t.subject_id && t.creator_id && t.subject) {
        const normName = String(t.subject).trim();
        const key = `${t.creator_id}:${normName.toLowerCase()}`;
        const subj = subjectMap.get(key);

        if (subj) {
          await pgQuery('UPDATE user_tests SET subject_id = $1 WHERE id = $2', [subj.id, t.id]);
          updatedTestsCount++;
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
  } finally {
    if (pool) await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
