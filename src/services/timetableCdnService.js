'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('../core/logger');
const { TIMETABLE_STORAGE_CHANNEL_ID } = require('../config/config');
const { escapeHtml } = require('../core/utils');
const edupageService = require('./edupageService');
const imageService = require('./imageService');
const dbService = require('./dbService');

const ALL_THEMES = ['dark', 'light', 'vibrant'];
const DEFAULT_DELAY_MS = 2500; // 2.5s pacing between channel posts (Telegram limit: ~20-30 msgs/min)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Singleflight promise map to coalesce concurrent image generations & channel uploads
const inflightRequests = new Map();

// Status tracker for background worker
let workerState = {
  isRunning: false,
  shouldStop: false,
  startTime: null,
  total: 0,
  processed: 0,
  generated: 0,
  skipped: 0,
  failed: 0,
  currentGroup: null,
  currentTheme: null,
};

/**
 * Computes deterministic SHA-256 hash of schedule content.
 * Normalizes subject, teacher, and room to prevent false positives.
 */
function computeScheduleHash(schedule) {
  if (!schedule || typeof schedule !== 'object') return 'empty';

  const simplified = {};
  for (let d = 0; d < 6; d++) {
    if (!schedule[d]) continue;
    simplified[d] = {};
    const periods = Object.keys(schedule[d]).map(Number).sort((a, b) => a - b);
    for (const p of periods) {
      simplified[d][p] = (schedule[d][p] || []).map((l) => ({
        subject: (l.subject || '').trim(),
        teacher: (l.teacher || '').trim(),
        room: (l.room || '').trim(),
      }));
    }
  }

  return crypto.createHash('sha256').update(JSON.stringify(simplified)).digest('hex');
}

/**
 * Uploads a rendered schedule image to the Telegram Storage Channel.
 * Returns { fileId, messageId } or null.
 * Handles rate limits (HTTP 429) automatically with exponential backoff.
 */
async function uploadPhotoToChannel(telegram, imageBuffer, caption) {
  if (!TIMETABLE_STORAGE_CHANNEL_ID) {
    logger.warn('TIMETABLE_STORAGE_CHANNEL_ID is not configured. Falling back to local buffer.');
    return null;
  }

  const maxAttempts = 3;
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const channelId = String(TIMETABLE_STORAGE_CHANNEL_ID).trim();
      const sentMsg = await telegram.sendPhoto(
        channelId,
        { source: imageBuffer },
        {
          caption: caption || '📅 Dars jadvali CDN',
          parse_mode: 'HTML',
        }
      );

      const photos = sentMsg?.photo;
      if (!photos || photos.length === 0) return null;

      // The last entry is always the highest resolution photo
      const bestPhoto = photos[photos.length - 1];
      return {
        fileId: bestPhoto.file_id,
        messageId: sentMsg.message_id,
      };
    } catch (err) {
      attempts++;
      const errStr = String(err?.message || err);
      logger.warn(`Telegram channel upload error (attempt ${attempts}/${maxAttempts}):`, { error: errStr });

      const retryAfter = err?.response?.parameters?.retry_after || 0;
      if (errStr.includes('429') || retryAfter > 0) {
        const waitTime = (retryAfter > 0 ? retryAfter + 2 : 6) * 1000;
        logger.info(`Rate limited by Telegram. Waiting ${waitTime / 1000}s before retrying...`);
        await sleep(waitTime);
      } else if (attempts < maxAttempts) {
        await sleep(2000);
      } else {
        logger.error('Failed to upload timetable to storage channel after max attempts', { error: errStr });
        return null;
      }
    }
  }
  return null;
}

/**
 * Primary runtime function:
 * Resolves weekly schedule photo with multi-tier CDN caching:
 * 1. Redis / Supabase lookup (instant <100ms return if file_id exists)
 * 2. Just-In-Time (JIT) generation if cache miss -> uploads to channel -> saves to DB -> returns file_id
 *
 * @param {object} telegram Telegraf telegram client (ctx.telegram or bot.telegram)
 * @param {string} className Raw or normalized group name
 * @param {string} theme 'dark' | 'light' | 'vibrant'
 * @returns {Promise<{ fileId?: string, buffer?: Buffer, isHit: boolean } | null>}
 */
async function getOrGenerateTimetablePhoto(telegram, rawClassName, theme = 'dark') {
  if (!rawClassName) return null;
  const className = edupageService.getCanonicalGroupName(rawClassName) || rawClassName.trim();
  const norm = edupageService.normalizeGroupName(className);
  if (!norm) return null;

  const validTheme = ALL_THEMES.includes(theme) ? theme : 'dark';

  // 1. Resolve current raw schedule from EduPage to verify hash
  const rawSchedule = await edupageService.getRawSchedule(className);
  if (!rawSchedule || Object.keys(rawSchedule).length === 0) {
    return null;
  }
  const currentScheduleHash = computeScheduleHash(rawSchedule);

  // 2. Fast Cache Hit check in Supabase / Redis with strict schedule_hash verification
  const cached = await dbService.getTimetableCache(className, validTheme);
  const cachedFileId = cached?.file_id || cached?.fileId;
  const cachedHash = cached?.schedule_hash || cached?.scheduleHash;

  if (cached && cachedFileId && cachedHash && cachedHash === currentScheduleHash) {
    return {
      fileId: cachedFileId,
      isHit: true,
    };
  }

  // Stale cache detected (schedule changed in EduPage) -> delete old cache entry
  let wasStale = false;
  if (cached && cachedFileId && cachedHash && cachedHash !== currentScheduleHash) {
    logger.info(`Stale timetable cache detected for ${className} [${validTheme}] (hash mismatch). Regenerating...`, {
      cachedHash,
      currentScheduleHash,
    });
    wasStale = true;
    await dbService.deleteTimetableCache(className, validTheme).catch(() => {});
  }

  // 3. Coalesce concurrent requests via Singleflight
  const inflightKey = `${norm}:${validTheme}`;
  if (inflightRequests.has(inflightKey)) {
    return inflightRequests.get(inflightKey);
  }

  const generationPromise = (async () => {
    try {
      // Re-check cache inside singleflight to avoid redundant work
      const recheck = await dbService.getTimetableCache(className, validTheme);
      const recheckFileId = recheck?.file_id || recheck?.fileId;
      const recheckHash = recheck?.schedule_hash || recheck?.scheduleHash;
      if (recheck && recheckFileId && recheckHash && recheckHash === currentScheduleHash) {
        return { fileId: recheckFileId, isHit: true, wasStale: false };
      }

      // Cache Miss / Hash Mismatch: JIT Generation
      const imageBuffer = await imageService.generateScheduleImage(className, rawSchedule, validTheme);
      if (!imageBuffer) return null;

      // 4. Upload to Channel CDN if available
      if (TIMETABLE_STORAGE_CHANNEL_ID && telegram) {
        try {
          const themeLabel = validTheme === 'light' ? 'Kunduzgi' : validTheme === 'vibrant' ? 'Neon' : 'Tungi';
          const caption = `🎓 <b>${escapeHtml(className)}</b> | 🎨 <i>${themeLabel}</i>\n<code>#hash_${currentScheduleHash.slice(0, 10)}</code>`;
          const uploadRes = await uploadPhotoToChannel(telegram, imageBuffer, caption);

          if (uploadRes?.fileId) {
            await dbService.upsertTimetableCache({
              groupName: className,
              groupNormalized: norm,
              theme: validTheme,
              fileId: uploadRes.fileId,
              channelMessageId: uploadRes.messageId,
              scheduleHash: currentScheduleHash,
            });

            // If old message exists in channel, clean up to avoid outdated posts in storage
            if (cached?.channel_message_id && cached.channel_message_id !== uploadRes.messageId) {
              telegram.deleteMessage(TIMETABLE_STORAGE_CHANNEL_ID, cached.channel_message_id).catch(() => {});
            }

            // Proactively notify enrolled group students if an outdated timetable was refreshed
            if (wasStale) {
              try {
                const scheduleWatcher = require('./scheduleWatcherService');
                if (typeof scheduleWatcher.notifyGroupScheduleChanged === 'function') {
                  scheduleWatcher.notifyGroupScheduleChanged(className, currentScheduleHash).catch(() => {});
                }
              } catch (e) {
                logger.debug('Failed to trigger notifyGroupScheduleChanged from CDN', { error: e.message });
              }
            }

            return {
              fileId: uploadRes.fileId,
              isHit: false,
              wasStale,
            };
          }
        } catch (cdnErr) {
          logger.error('JIT channel upload failed, falling back to local buffer', { error: cdnErr.message });
        }
      }

      // Fallback to local image buffer if channel CDN is not active
      return {
        buffer: imageBuffer,
        isHit: false,
        wasStale,
      };
    } finally {
      inflightRequests.delete(inflightKey);
      if (global.gc) {
        try { global.gc(); } catch {}
      }
    }
  })();

  inflightRequests.set(inflightKey, generationPromise);
  return generationPromise;
}

/**
 * Non-blocking helper to warm the remaining 2 themes for a requested group
 */
async function warmRemainingThemesInBackground(telegram, className, rawSchedule, scheduleHash, completedTheme) {
  if (!TIMETABLE_STORAGE_CHANNEL_ID || !telegram || workerState.isRunning) return;
  const norm = edupageService.normalizeGroupName(className);
  const remaining = ALL_THEMES.filter((t) => t !== completedTheme);

  for (const t of remaining) {
    try {
      const exists = await dbService.getTimetableCache(norm, t);
      if (exists && exists.file_id && exists.schedule_hash === scheduleHash) {
        continue; // Already fresh
      }

      await sleep(DEFAULT_DELAY_MS); // Maintain Telegram pacing
      const buf = await imageService.generateScheduleImage(className, rawSchedule, t);
      if (!buf) continue;

      const themeLabel = t === 'light' ? 'Kunduzgi' : t === 'vibrant' ? 'Neon' : 'Tungi';
      const caption = `🎓 <b>${escapeHtml(className)}</b> | 🎨 <i>${themeLabel}</i>\n<code>#hash_${scheduleHash.slice(0, 10)}</code>`;
      const uploadRes = await uploadPhotoToChannel(telegram, buf, caption);

      if (uploadRes?.fileId) {
        await dbService.upsertTimetableCache({
          groupName: className,
          groupNormalized: norm,
          theme: t,
          fileId: uploadRes.fileId,
          channelMessageId: uploadRes.messageId,
          scheduleHash,
        });
      }
    } catch (e) {
      logger.debug('warmRemainingThemes error', { group: className, theme: t, error: e.message });
    }
  }
}

/**
 * Checks if current time in Asia/Tashkent has reached or passed the stopHour (default 5 AM)
 * Window is 02:00 - 05:00. Cutoff is reached once hour is >= stopHour and before 23:00.
 */
function isTashkentCutoffReached(stopHour = 5) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tashkent',
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date());
    const hourPart = parts.find((p) => p.type === 'hour');
    const hour = hourPart ? parseInt(hourPart.value, 10) : (new Date().getUTCHours() + 5) % 24;
    return hour >= stopHour && hour < 23;
  } catch {
    const hour = (new Date().getUTCHours() + 5) % 24;
    return hour >= stopHour && hour < 23;
  }
}

/**
 * Robust, rate-limited background worker that pre-warms timetable images.
 * Concurrency = 1 (Zero server overload on Render starter dynos).
 * Prioritizes active enrolled students first, then remaining groups from groups.json.
 * Theme completion logic:
 *   - If 1 theme is already uploaded on-demand, generates the missing 2.
 *   - If 2 themes are already uploaded, completes the 3rd.
 *   - If all 3 are fresh, skips immediately (0ms cost).
 *   - Reclaims memory with global.gc() and stops gracefully at stopHourTashkent (05:00).
 *
 * @param {object} telegram Telegraf telegram client
 * @param {object} options { activeOnly: false, delayMs: 2500, stopHourTashkent: null }
 */
async function prewarmAllTimetables(telegram, options = {}) {
  if (workerState.isRunning) {
    logger.warn('Prewarm worker is already running.');
    return { status: 'already_running', workerState };
  }

  if (!TIMETABLE_STORAGE_CHANNEL_ID) {
    logger.warn('TIMETABLE_STORAGE_CHANNEL_ID is not configured. Cannot run CDN prewarm.');
    return { status: 'missing_channel_id' };
  }

  const delayMs = options.delayMs || DEFAULT_DELAY_MS;
  const activeOnly = options.activeOnly === true;
  const stopHourTashkent = options.stopHourTashkent != null ? Number(options.stopHourTashkent) : null;

  workerState = {
    isRunning: true,
    shouldStop: false,
    startTime: Date.now(),
    mode: activeOnly ? 'active_only' : 'all_groups',
    total: 0,
    processed: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
    currentGroup: null,
    currentTheme: null,
  };

  logger.info(`🚀 Starting Timetable CDN Pre-warm Worker (mode: ${workerState.mode}, stopHour: ${stopHourTashkent ?? 'none'})...`);

  (async () => {
    try {
      // 1. Gather active groups from enrolled students
      const broadcastUsers = await dbService.getScheduleBroadcastUsers();
      const activeGroupSet = new Set(
        broadcastUsers.map((u) => (u.class_name || '').trim()).filter(Boolean)
      );

      // 2. Gather all groups from groups.json
      let allGroups = [];
      try {
        const rawJson = fs.readFileSync(path.join(__dirname, '../data/groups.json'), 'utf8');
        allGroups = JSON.parse(rawJson);
      } catch (e) {
        logger.error('Failed to read groups.json for pre-warm', { error: e.message });
      }

      // 3. Build prioritized queue: Active groups first, then remaining groups
      const prioritizedQueue = [];
      const seen = new Set();

      // Priority 1: Active user groups
      for (const grp of activeGroupSet) {
        const norm = edupageService.normalizeGroupName(grp);
        if (norm && !seen.has(norm)) {
          seen.add(norm);
          prioritizedQueue.push(grp);
        }
      }

      const activeCount = prioritizedQueue.length;
      logger.info(`📋 Pre-warm Priority 1: ${activeCount} active user groups loaded.`);

      // Priority 2: Remaining university groups
      if (!activeOnly) {
        for (const grp of allGroups) {
          if (!grp || typeof grp !== 'string') continue;
          const norm = edupageService.normalizeGroupName(grp);
          if (norm && !seen.has(norm)) {
            seen.add(norm);
            prioritizedQueue.push(grp);
          }
        }
      }

      workerState.total = prioritizedQueue.length * ALL_THEMES.length;
      logger.info(`📦 Total jobs to process: ${workerState.total} (${prioritizedQueue.length} groups × 3 themes)`);

      // 4. Sequential execution (Concurrency = 1)
      for (const groupName of prioritizedQueue) {
        if (workerState.shouldStop) {
          logger.info('🛑 Pre-warm worker stopped gracefully by signal.');
          break;
        }

        if (stopHourTashkent != null && isTashkentCutoffReached(stopHourTashkent)) {
          logger.info(`⏰ Nightly pre-warm cutoff reached (${stopHourTashkent}:00 Asia/Tashkent). Stopping gracefully.`);
          break;
        }

        const norm = edupageService.normalizeGroupName(groupName);
        if (!norm) continue;

        workerState.currentGroup = groupName;

        let rawSchedule = null;
        let scheduleHash = null;

        for (const theme of ALL_THEMES) {
          if (workerState.shouldStop) break;
          if (stopHourTashkent != null && isTashkentCutoffReached(stopHourTashkent)) {
            logger.info(`⏰ Nightly pre-warm cutoff reached during theme processing (${stopHourTashkent}:00 Asia/Tashkent). Stopping.`);
            break;
          }

          workerState.currentTheme = theme;
          workerState.processed++;

          try {
            // Lazy fetch schedule only when needed
            if (!rawSchedule) {
              rawSchedule = await edupageService.getRawSchedule(groupName);
              if (!rawSchedule || Object.keys(rawSchedule).length === 0) {
                const remaining = ALL_THEMES.length - ALL_THEMES.indexOf(theme);
                workerState.skipped += remaining;
                workerState.processed += (remaining - 1);
                break; // No schedule in EduPage, skip this group
              }
              scheduleHash = computeScheduleHash(rawSchedule);
            }

            // Check if already in Supabase/Redis cache with valid file_id
            const existing = await dbService.getTimetableCache(norm, theme);

            // If already cached and schedule hasn't changed -> SKIP! (0ms cost, theme already present)
            const existingFileId = existing?.file_id || existing?.fileId;
            if (existing && existingFileId && existing.schedule_hash === scheduleHash) {
              workerState.skipped++;
              continue;
            }

            // Generate missing or outdated theme
            logger.info(`🎨 Pre-warming missing theme '${theme}' for ${groupName} (hash: ${scheduleHash.slice(0, 8)})...`);
            let imageBuffer = await imageService.generateScheduleImage(groupName, rawSchedule, theme);
            if (!imageBuffer) {
              workerState.failed++;
              continue;
            }

            // Upload to Telegram Storage Channel CDN
            const themeLabel = theme === 'light' ? 'Kunduzgi' : theme === 'vibrant' ? 'Neon' : 'Tungi';
            const caption = `🎓 <b>${escapeHtml(groupName)}</b> | 🎨 <i>${themeLabel}</i>\n<code>#hash_${scheduleHash.slice(0, 10)}</code>`;
            const uploadRes = await uploadPhotoToChannel(telegram, imageBuffer, caption);

            // Immediately dereference buffer and reclaim memory
            imageBuffer = null;
            if (global.gc) {
              try { global.gc(); } catch (_) {}
            }

            if (uploadRes?.fileId) {
              await dbService.upsertTimetableCache({
                groupName,
                groupNormalized: norm,
                theme,
                fileId: uploadRes.fileId,
                channelMessageId: uploadRes.messageId,
                scheduleHash,
              });

              // If old message exists, clean up from channel to keep it tidy
              if (existing?.channel_message_id && existing.channel_message_id !== uploadRes.messageId) {
                telegram.deleteMessage(TIMETABLE_STORAGE_CHANNEL_ID, existing.channel_message_id).catch(() => {});
              }

              workerState.generated++;
            } else {
              workerState.failed++;
            }

            // Pacing pause to protect Render RAM/CPU and Telegram Rate Limits
            await sleep(delayMs);
          } catch (jobErr) {
            workerState.failed++;
            logger.error(`Error processing pre-warm for ${groupName} [${theme}]`, { error: jobErr.message });
            await sleep(2000);
          }
        }

        // Release schedule reference and trigger gc between groups
        rawSchedule = null;
        if (global.gc) {
          try { global.gc(); } catch (_) {}
        }
      }

      logger.info('🎉 Timetable CDN Background Pre-warm finished!', {
        mode: workerState.mode,
        total: workerState.total,
        processed: workerState.processed,
        generated: workerState.generated,
        skipped: workerState.skipped,
        failed: workerState.failed,
        durationMin: ((Date.now() - workerState.startTime) / 60000).toFixed(1),
      });
    } catch (workerErr) {
      logger.error('Fatal error in pre-warm worker:', { error: workerErr.message });
    } finally {
      workerState.isRunning = false;
      workerState.currentGroup = null;
      workerState.currentTheme = null;
    }
  })();

  return { status: 'started', workerState };
}

/**
 * Graceful worker stopper
 */
function stopPrewarmWorker() {
  if (workerState.isRunning) {
    workerState.shouldStop = true;
    return true;
  }
  return false;
}

function getWorkerStatus() {
  return { ...workerState };
}

/**
 * Cache invalidation for a class (called when schedule change is detected)
 */
async function invalidateTimetable(className) {
  if (!className) return;
  const canonical = edupageService.getCanonicalGroupName(className) || className;
  await dbService.deleteTimetableCache(canonical);
}

module.exports = {
  computeScheduleHash,
  uploadPhotoToChannel,
  getOrGenerateTimetablePhoto,
  prewarmAllTimetables,
  stopPrewarmWorker,
  getWorkerStatus,
  invalidateTimetable,
};
