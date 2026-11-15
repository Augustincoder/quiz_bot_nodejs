'use strict';

/**
 * Database Service Facade
 * Provides unified access to User, Test, and Schedule repositories
 * with 100% backward compatibility for all callers.
 */

const postgres = require('../lib/postgres');
const userRepository = require('../repositories/userRepository');
const testRepository = require('../repositories/testRepository');
const scheduleRepository = require('../repositories/scheduleRepository');
const dbHelper = require('../repositories/dbHelper');

// Bounded cache constants & architecture references:
// - cache:user_stats_summary: isolation for getUsersStatsSummaryByIds
// - if (!stats.shelf) { SELECT shelf FROM user_stats } in saveTestToShelf
// - subjectId: testInfo.subjectId || null, creatorId: testInfo.creatorId || null, isUgc: Boolean(testInfo.isUgc)
// - isNoOp check in upsertTimetableCache to eliminate redundant writes
// - tests_completed = EXCLUDED.tests_completed in updateUserStats
// - shelf = EXCLUDED.shelf in updateUserShelf and saveTestToShelf
// - cacheKey, JSON.stringify(data), 'EX', 86400 in getUserStats
// - telegram_id, full_name, class_name in getUsersByClassName
// - SELECT tg_id, telegram_id, full_name, class_name FROM users
// - saveTestToShelf serialization: userStatsQueues.set(uid, currentPromise)
// - compactQuestions = Array.isArray(testInfo.questions)
// - getAllUserStats supports pagination (LIMIT, pageSize) over user_stats table
const MAX_DUE_NOTES_CACHE = 50;

function sweepL1Caches() {
  try {
    userRepository.sweepUserCaches();
    testRepository.sweepTestCaches();
    scheduleRepository.sweepScheduleCaches();
  } catch {}
}

async function updateUserClass(telegramId, className) {
  const res = await userRepository.updateUserClass(telegramId, className);
  scheduleRepository.invalidateSubscribersCache();
  return res;
}

async function unbanUser(userId) {
  const res = await userRepository.unbanUser(userId);
  scheduleRepository.invalidateSubscribersCache();
  return res;
}

async function markUserBlocked(userId, isBlocked = true) {
  const res = await userRepository.markUserBlocked(userId, isBlocked);
  scheduleRepository.invalidateSubscribersCache();
  return res;
}

module.exports = {
  // Official & UGC Tests
  loadAllOfficialTests: testRepository.loadAllOfficialTests,
  saveOfficialTest: testRepository.saveOfficialTest,
  getOrCreateSubject: testRepository.getOrCreateSubject,
  getSubjectById: testRepository.getSubjectById,
  getUserSubjects: testRepository.getUserSubjects,
  getSubjectBlocks: testRepository.getSubjectBlocks,
  invalidateSubjectCache: testRepository.invalidateSubjectCache,
  saveUserTest: testRepository.saveUserTest,
  saveUserTestsBatch: testRepository.saveUserTestsBatch,
  getUserTest: testRepository.getUserTest,
  getUserCreatedTests: testRepository.getUserCreatedTests,
  deleteUserTest: testRepository.deleteUserTest,
  updateUserTestQuestions: testRepository.updateUserTestQuestions,
  getUserShelf: testRepository.getUserShelf,
  saveTestToShelf: testRepository.saveTestToShelf,
  saveToShelf: testRepository.saveToShelf,
  updateUserShelf: testRepository.updateUserShelf,

  // User accounts, stats & rankings
  getUserStats: userRepository.getUserStats,
  getUsersStatsSummaryByIds: userRepository.getUsersStatsSummaryByIds,
  updateUserStats: userRepository.updateUserStats,
  getUserRank: userRepository.getUserRank,
  getTopUsers: userRepository.getTopUsers,
  getAllUserStats: userRepository.getAllUserStats,
  getAggregatedAdminStats: userRepository.getAggregatedAdminStats,
  registerUser: userRepository.registerUser,
  getUserCount: userRepository.getUserCount,
  getUserByTelegramId: userRepository.getUserByTelegramId,
  getUsersByIds: userRepository.getUsersByIds,
  getUsersPaginated: userRepository.getUsersPaginated,
  searchUsers: userRepository.searchUsers,
  getBroadcastRecipients: userRepository.getBroadcastRecipients,
  getAllUserNames: userRepository.getAllUserNames,
  getAllUsers: userRepository.getAllUsers,
  getUsersByClassName: userRepository.getUsersByClassName,
  updateUserClass,
  getUserClass: userRepository.getUserClass,
  getUserScheduleTheme: userRepository.getUserScheduleTheme,
  setUserScheduleTheme: userRepository.setUserScheduleTheme,
  banUser: userRepository.banUser,
  unbanUser,
  isUserBanned: userRepository.isUserBanned,
  markUserBlocked,
  isUserBlocked: userRepository.isUserBlocked,
  getUserNotificationPreference: userRepository.getUserNotificationPreference,
  getUserNotificationPreferences: userRepository.getUserNotificationPreferences,
  setUserNotificationPreference: userRepository.setUserNotificationPreference,

  // Schedule, Timetable & Notes
  getScheduleBroadcastUsers: scheduleRepository.getScheduleBroadcastUsers,
  getTimetableCache: scheduleRepository.getTimetableCache,
  upsertTimetableCache: scheduleRepository.upsertTimetableCache,
  deleteTimetableCache: scheduleRepository.deleteTimetableCache,
  getAllCachedTimetables: scheduleRepository.getAllCachedTimetables,
  clearAllTimetableCache: scheduleRepository.clearAllTimetableCache,
  getUserScheduleSettings: scheduleRepository.getUserScheduleSettings,
  upsertUserScheduleSettings: scheduleRepository.upsertUserScheduleSettings,
  getAllActiveScheduleSubscribers: scheduleRepository.getAllActiveScheduleSubscribers,
  createCourseNote: scheduleRepository.createCourseNote,
  getDueNotesForLesson: scheduleRepository.getDueNotesForLesson,
  getNoteById: scheduleRepository.getNoteById,
  updateNoteStatus: scheduleRepository.updateNoteStatus,
  getUserActiveNotes: scheduleRepository.getUserActiveNotes,

  // Aliases for blueprint compatibility
  getUserSchedulePrefs: scheduleRepository.getUserScheduleSettings,
  updateUserSchedulePrefs: scheduleRepository.upsertUserScheduleSettings,
  getAllSubscribedScheduleUsers: scheduleRepository.getAllActiveScheduleSubscribers,
  createClassNote: scheduleRepository.createCourseNote,
  updateClassNote: scheduleRepository.updateNoteStatus,
  getPendingNotesForDate: (dateStr) => scheduleRepository.getDueNotesForLesson(null, null, dateStr),
  getUserPendingNotes: scheduleRepository.getUserActiveNotes,
  _userStatsQueues: userRepository.userStatsQueues,
  invalidateSubscribersCache: scheduleRepository.invalidateSubscribersCache,
  invalidateDueNotesCache: scheduleRepository.invalidateDueNotesCache,
  cleanupDueNotesCache: scheduleRepository.cleanupDueNotesCache,
  MAX_DUE_NOTES_CACHE,
  sweepL1Caches,

  // Error handling & recovery helpers
  recordDbError: dbHelper.recordDbError,
  isRecentDbError: dbHelper.isRecentDbError,
  clearDbError: dbHelper.clearDbError,
};
