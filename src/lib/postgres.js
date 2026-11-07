'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { CircuitBreaker } = require('../core/circuitBreaker');
const logger = require('../core/logger');

// Northflank internal default URL (port 5432 inside Northflank cluster network)
const DEFAULT_NF_URL = 'postgresql://_24c4d3f3b7552851:_43bd4eabf61d7974c2374fef2c8f3b@primary.quiz-bot-database--hqhlj8nqhyp9.addon.code.run:5432/_62d18dea4e8b?sslmode=require&uselibpqcompat=true';
const databaseUrl = process.env.DATABASE_URL || DEFAULT_NF_URL;

let pool = null;

const postgresBreaker = new CircuitBreaker({
  name: 'postgres',
  failureThreshold: 4,
  resetTimeoutMs: 30000,
});

function isPostgresAvailable() {
  if (!pool) return false;
  return postgresBreaker.canAttempt();
}

try {
  let normalizedUrl = databaseUrl;
  if (normalizedUrl.includes('sslmode=require') && !normalizedUrl.includes('uselibpqcompat=true')) {
    normalizedUrl += (normalizedUrl.includes('?') ? '&' : '?') + 'uselibpqcompat=true';
  }

  const needsSsl = normalizedUrl.includes('sslmode=require') || 
                   normalizedUrl.includes('addon.code.run') || 
                   normalizedUrl.includes('northflank.app');

  pool = new Pool({
    connectionString: normalizedUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
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

/**
 * Execute a parameterized SQL query with CircuitBreaker protection & metrics
 */
async function query(text, params = []) {
  if (!pool) {
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
