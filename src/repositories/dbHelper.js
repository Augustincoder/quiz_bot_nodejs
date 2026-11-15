'use strict';

let _lastDbError = null;

function recordDbError(err) {
  _lastDbError = {
    message: String(err?.message || 'Database error'),
    timestamp: Date.now(),
  };
}

function isRecentDbError() {
  if (!_lastDbError) return false;
  return (Date.now() - _lastDbError.timestamp) < 20000;
}

function clearDbError() {
  _lastDbError = null;
}

module.exports = {
  recordDbError,
  isRecentDbError,
  clearDbError,
};
