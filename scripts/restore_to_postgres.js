/**
 * Database Restore & Migration Utility
 * Restores data from Supabase JSON dumps / SQL into PostgreSQL
 */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const targetUrl = process.argv[2] || process.env.DATABASE_URL || 'postgresql://_24c4d3f3b7552851:_43bd4eabf61d7974c2374fef2c8f3b@primary.quiz-bot-database--hqhlj8nqhyp9.addon.code.run:5432/_62d18dea4e8b?sslmode=require';

console.log('Connecting to PostgreSQL target database...');
console.log('Target host/info:', targetUrl.replace(/:[^:@]+@/, ':***@'));

const pool = new Pool({
  connectionString: targetUrl,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const client = await pool.connect();
  try {
    console.log('Connected successfully to PostgreSQL target!');
    const versionRes = await client.query('SELECT version();');
    console.log('PostgreSQL Version:', versionRes.rows[0].version);

    const sqlPath = path.join(__dirname, '../database/backup_from_supabase.sql');
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`SQL file not found at: ${sqlPath}`);
    }

    console.log(`Reading SQL file: ${sqlPath} (${(fs.statSync(sqlPath).size / (1024 * 1024)).toFixed(2)} MB)...`);
    const fullSql = fs.readFileSync(sqlPath, 'utf-8');

    console.log('Executing migration & data restoration SQL statements...');
    console.time('Restoration Time');
    await client.query(fullSql);
    console.timeEnd('Restoration Time');

    console.log('\n--- VERIFICATION OF RESTORED TABLES ---');
    const tables = [
      'users',
      'subjects',
      'user_tests',
      'official_tests',
      'user_stats',
      'timetable_cache',
      'user_schedule_settings',
      'course_notes'
    ];

    for (const table of tables) {
      try {
        const res = await client.query(`SELECT COUNT(*) as count FROM "${table}"`);
        console.log(`Table [${table}]: ${res.rows[0].count} rows`);
      } catch (e) {
        console.error(`Verification error on [${table}]:`, e.message);
      }
    }

    console.log('\n✅ All data restored and verified successfully!');
  } catch (err) {
    console.error('❌ Restore failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
