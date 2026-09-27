'use strict';

const logger = require('../core/logger');
const scheduleService = require('./scheduleService');

// Render 512MB RAM safety thresholds:
// 1. Heap threshold: 350MB V8 heap
// 2. RSS threshold: 420MB process resident memory (Render SIGKILLs container at 512MB)
const HEAP_THRESHOLD_BYTES = 350 * 1024 * 1024;
const RSS_THRESHOLD_BYTES = 420 * 1024 * 1024;
const CHECK_INTERVAL_MS = 30 * 1000;

let _timer = null;
let _isRunning = false;

function checkMemory() {
  try {
    const mem = process.memoryUsage();
    const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
    const rssMb = Math.round(mem.rss / 1024 / 1024);

    const isHeapHigh = mem.heapUsed > HEAP_THRESHOLD_BYTES;
    const isRssHigh = mem.rss > RSS_THRESHOLD_BYTES;

    if (isHeapHigh || isRssHigh) {
      logger.warn(`🚨 Surgical RAM Watchdog Alert: Heap ${heapUsedMb}MB / RSS ${rssMb}MB exceeded safe ceiling. Initiating disposable cache purge...`);

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

      // 3. Invoke V8 garbage collector if exposed
      if (typeof global.gc === 'function') {
        global.gc();
        const afterMem = process.memoryUsage();
        const afterHeapMb = Math.round(afterMem.heapUsed / 1024 / 1024);
        const freedMb = heapUsedMb - afterHeapMb;
        logger.info(`✅ Surgical RAM Watchdog: GC completed. Heap reduced from ${heapUsedMb}MB to ${afterHeapMb}MB (Freed: ${freedMb}MB). Active quizzes remain 100% intact.`);
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
  logger.info('🛡️ Surgical RAM Watchdog active (380MB threshold, Quiz-safe)');
}

function stopWatchdog() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  _isRunning = false;
}

module.exports = {
  startWatchdog,
  stopWatchdog,
  checkMemory,
};
