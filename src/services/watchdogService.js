'use strict';

const logger = require('../core/logger');
const scheduleService = require('./scheduleService');

// Northflank / Render 512MB RAM safety thresholds:
// 1. Heap threshold: 280MB V8 heap
// 2. RSS threshold: 360MB process resident memory (Northflank/Render SIGKILLs container at 512MB)
// 3. Native Off-Heap threshold: 40MB C++ / Sharp buffers
const HEAP_THRESHOLD_BYTES = 280 * 1024 * 1024;
const RSS_THRESHOLD_BYTES = 360 * 1024 * 1024;
const EXTERNAL_THRESHOLD_BYTES = 40 * 1024 * 1024;
const CHECK_INTERVAL_MS = 30 * 1000;
const HYGIENE_INTERVAL_MS = 5 * 60 * 1000;

let _timer = null;
let _hygieneTimer = null;
let _isRunning = false;

function runMemoryHygieneSweep() {
  try {
    const now = Date.now();
    try {
      const pendingStore = require('../core/pendingStore');
      if (typeof pendingStore.cleanup === 'function') pendingStore.cleanup(now);
    } catch {}

    try {
      const sessionService = require('./sessionService');
      if (typeof sessionService.cleanupExpired === 'function') sessionService.cleanupExpired(now);
    } catch {}

    try {
      const roomManager = require('../socket/roomManager');
      if (typeof roomManager.cleanupDeadRooms === 'function') roomManager.cleanupDeadRooms(now);
    } catch {}

    try {
      const mutex = require('../core/mutex');
      if (typeof mutex.cleanup === 'function') mutex.cleanup();
    } catch {}

    try {
      const dbService = require('./dbService');
      if (typeof dbService.cleanupDueNotesCache === 'function') dbService.cleanupDueNotesCache(now);
    } catch {}

    try {
      const scheduleHandler = require('../handlers/scheduleHandler');
      if (typeof scheduleHandler.cleanup === 'function') scheduleHandler.cleanup();
    } catch {}

    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const externalMb = Math.round(((mem.external || 0) + (mem.arrayBuffers || 0)) / 1024 / 1024);

    if ((rssMb > 350 || externalMb > 40) && typeof global.gc === 'function') {
      global.gc();
      logger.debug('Proactive memory hygiene sweep GC completed', { rssMb, externalMb });
    }
  } catch (err) {
    logger.debug('Memory hygiene sweep error:', { error: err.message });
  }
}

function checkMemory() {
  try {
    const mem = process.memoryUsage();
    const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
    const heapTotalMb = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMb = Math.round(mem.rss / 1024 / 1024);
    const externalMb = Math.round(((mem.external || 0) + (mem.arrayBuffers || 0)) / 1024 / 1024);

    const isHeapHigh = mem.heapUsed > HEAP_THRESHOLD_BYTES;
    const isRssHigh = mem.rss > RSS_THRESHOLD_BYTES;
    const isExternalHigh = ((mem.external || 0) + (mem.arrayBuffers || 0)) > EXTERNAL_THRESHOLD_BYTES;

    if (isHeapHigh || isRssHigh || isExternalHigh) {
      logger.warn(`🚨 Surgical RAM Watchdog Alert: Heap ${heapUsedMb}MB (Total: ${heapTotalMb}MB) / External ${externalMb}MB / RSS ${rssMb}MB exceeded safe ceiling. Initiating disposable cache purge...`);

      // 1. Clear ONLY disposable timetable PNG image buffers (quizzes and sessions are 100% untouched)
      scheduleService.clearImageMemoryCache();

      // 2. Pause non-essential background CDN pre-warming if active
      try {
        const timetableCdnService = require('./timetableCdnService');
        if (typeof timetableCdnService.stopPrewarmWorker === 'function') {
          timetableCdnService.stopPrewarmWorker();
        }
      } catch (e) {
        logger.debug('Watchdog prewarm stop check:', { error: e.message });
      }

      // 3. Proactive sweep of state stores
      runMemoryHygieneSweep();

      // 4. Invoke V8 garbage collector if exposed
      if (typeof global.gc === 'function') {
        global.gc();
        const afterMem = process.memoryUsage();
        const afterHeapMb = Math.round(afterMem.heapUsed / 1024 / 1024);
        const afterRssMb = Math.round(afterMem.rss / 1024 / 1024);
        const freedMb = heapUsedMb - afterHeapMb;
        logger.info(`✅ Surgical RAM Watchdog: GC completed. Heap ${heapUsedMb}MB -> ${afterHeapMb}MB (Freed: ${freedMb}MB), RSS: ${afterRssMb}MB. Active quizzes remain 100% intact.`);
      } else {
        logger.warn('⚠️ Surgical RAM Watchdog: Disposable image cache cleared, but global.gc is not exposed.');
      }
    }
  } catch (err) {
    logger.error('Error in Surgical RAM Watchdog:', { error: err.message });
  }
}

function startWatchdog() {
  if (_isRunning) return;
  _isRunning = true;
  _timer = setInterval(checkMemory, CHECK_INTERVAL_MS);
  if (_timer.unref) _timer.unref(); // Do not hold event loop open on process exit

  _hygieneTimer = setInterval(runMemoryHygieneSweep, HYGIENE_INTERVAL_MS);
  if (_hygieneTimer.unref) _hygieneTimer.unref();

  logger.info('🛡️ Surgical RAM Watchdog active (360MB RSS, 280MB Heap, 40MB External, Quiz-safe)');
}

function stopWatchdog() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  if (_hygieneTimer) {
    clearInterval(_hygieneTimer);
    _hygieneTimer = null;
  }
  _isRunning = false;
}

const { CircuitBreaker } = require('../core/circuitBreaker');

module.exports = {
  startWatchdog,
  stopWatchdog,
  checkMemory,
  CircuitBreaker,
};

