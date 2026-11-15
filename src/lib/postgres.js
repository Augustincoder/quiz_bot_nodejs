'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { CircuitBreaker } = require('../core/circuitBreaker');
const logger = require('../core/logger');

const databaseUrl = process.env.DATABASE_URL ? String(process.env.DATABASE_URL).trim() : '';

let pool = null;

const postgresBreaker = new CircuitBreaker({
  name: 'postgres',
  failureThreshold: 4,
  resetTimeoutMs: 30000,
});

function isPostgresAvailable() {
  if (!pool || !databaseUrl) return false;
  return postgresBreaker.canAttempt();
}

if (!databaseUrl) {
  logger.warn('DATABASE_URL is not set in environment. PostgreSQL disabled; running in offline/in-memory mode.');
  pool = new Pool({
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
  });
  pool.on('error', () => {});
} else {
  try {
    let normalizedUrl = databaseUrl;
    if (normalizedUrl.includes('sslmode=require') && !normalizedUrl.includes('uselibpqcompat=true')) {
      normalizedUrl += (normalizedUrl.includes('?') ? '&' : '?') + 'uselibpqcompat=true';
    }

    const rejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true';
    const needsSsl = normalizedUrl.includes('sslmode=require') || 
                     normalizedUrl.includes('addon.code.run') || 
                     normalizedUrl.includes('northflank.app');

    pool = new Pool({
      connectionString: normalizedUrl,
      ssl: needsSsl ? { rejectUnauthorized, ca: process.env.DB_SSL_CA || undefined } : false,
      max: parseInt(process.env.DB_POOL_MAX, 10) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000, // 5s connection timeout
    });

    pool.on('error', (err) => {
      logger.error('Unexpected error on idle PostgreSQL client:', { error: err.message });
    });
  } catch (err) {
    logger.error('PostgreSQL Pool initialization failed:', { error: err.message });
  }
}

/**
 * Execute a parameterized SQL query with CircuitBreaker protection & metrics
 */
async function query(text, params = []) {
  if (!pool || !databaseUrl) {
    throw new Error('PostgreSQL pool is not initialized');
  }

  if (!postgresBreaker.canAttempt()) {
    throw new Error('CircuitBreaker:postgres is OPEN (PostgreSQL temporarily unavailable)');
  }

  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    postgresBreaker.recordSuccess();
    const duration = Date.now() - start;
    if (duration > 1500) {
      logger.warn('Slow PostgreSQL query detected:', { duration, query: text.slice(0, 100) });
    }
    return res;
  } catch (err) {
    const duration = Date.now() - start;
    postgresBreaker.recordFailure(err);
    logger.error('PostgreSQL query error:', { error: err.message, query: text.slice(0, 100), duration });
    throw err;
  }
}

/**
 * Execute a block of queries inside an atomic transaction (BEGIN ... COMMIT / ROLLBACK)
 */
async function withTransaction(callback) {
  if (!pool) throw new Error('PostgreSQL pool is not initialized');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  withTransaction,
  isPostgresAvailable,
  postgresBreaker,
};
