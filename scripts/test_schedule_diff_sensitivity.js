'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'dummy_test_token';

const {
  diffGroupSchedules,
  computeScheduleHash,
  formatChangeAlert,
} = require('../src/services/scheduleWatcherService');

function createSampleSchedule() {
  return {
    0: { // Monday
      1: [{ subject: 'Oliy matematika', room: '101', teacher: 'Prof. Aliyev' }],
      2: [{ subject: 'Iqtisodiyot nazariyasi', room: '202', teacher: 'Dots. Karimov' }],
    },
    1: { // Tuesday
      1: [{ subject: 'Ingliz tili', room: '305', teacher: 'Katta o\'qit. Smirnova' }],
    },
    2: { // Wednesday
      3: [{ subject: 'Axborot texnologiyalari', room: '401', teacher: 'Assis. Sobirov' }],
    },
    4: { // Friday
      2: [{ subject: 'Falsafa', room: '108', teacher: 'Prof. Usmonov' }],
    },
  };
}

function runTests() {
  console.log('🧪 Starting Schedule Diff Sensitivity & Change Detection Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ Passed: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAILED: ${testName} ${details ? '— ' + details : ''}`);
      failed++;
    }
  }

  const baseSched = createSampleSchedule();
  const baseHash = computeScheduleHash(baseSched);

  // 1. Unchanged schedule
  const identicalSched = JSON.parse(JSON.stringify(baseSched));
  const identicalHash = computeScheduleHash(identicalSched);
  assert(baseHash === identicalHash, 'Identical schedules produce identical hashes');
  const identicalDiffs = diffGroupSchedules(baseSched, identicalSched);
  assert(identicalDiffs.length === 0, 'Identical schedules produce 0 diffs (No false alarms)');

  // 2. Room change
  const roomChangedSched = JSON.parse(JSON.stringify(baseSched));
  roomChangedSched[0][1][0].room = '304';
  const roomDiffs = diffGroupSchedules(baseSched, roomChangedSched);
  assert(roomDiffs.length === 1, 'Room change detected');
  assert(
    roomDiffs[0]?.changes?.[0]?.kind === 'ROOM' &&
    roomDiffs[0].changes[0].from === '101' &&
    roomDiffs[0].changes[0].to === '304',
    'Room change has correct from/to values'
  );

  // 3. Teacher change
  const teacherChangedSched = JSON.parse(JSON.stringify(baseSched));
  teacherChangedSched[1][1][0].teacher = 'Dots. Ahmedov';
  const teacherDiffs = diffGroupSchedules(baseSched, teacherChangedSched);
  assert(teacherDiffs.length === 1, 'Teacher change detected');
  assert(
    teacherDiffs[0]?.changes?.[0]?.kind === 'TEACHER' &&
    teacherDiffs[0].changes[0].from === 'Katta o\'qit. Smirnova' &&
    teacherDiffs[0].changes[0].to === 'Dots. Ahmedov',
    'Teacher change has correct from/to values'
  );

  // 4. Room and Teacher change simultaneously
  const bothChangedSched = JSON.parse(JSON.stringify(baseSched));
  bothChangedSched[2][3][0].room = '502';
  bothChangedSched[2][3][0].teacher = 'Prof. Qodirov';
  const bothDiffs = diffGroupSchedules(baseSched, bothChangedSched);
  assert(bothDiffs.length === 1, 'Simultaneous room and teacher change detected');
  assert(
    bothDiffs[0]?.changes?.[0]?.kind === 'ROOM_AND_TEACHER',
    'Simultaneous change categorized as ROOM_AND_TEACHER'
  );

  // 5. Subject change (same teacher)
  const subjChangedSched = JSON.parse(JSON.stringify(baseSched));
  subjChangedSched[4][2][0].subject = 'Sotsiologiya';
  const subjDiffs = diffGroupSchedules(baseSched, subjChangedSched);
  assert(subjDiffs.length === 1, 'Subject change detected');
  assert(
    subjDiffs[0]?.changes?.[0]?.kind === 'SUBJECT' &&
    subjDiffs[0].changes[0].from === 'Falsafa' &&
    subjDiffs[0].changes[0].to === 'Sotsiologiya',
    'Subject change has correct from/to values'
  );

  // 6. Lesson moved (Rescheduling across days & periods)
  const movedSched = JSON.parse(JSON.stringify(baseSched));
  const movedLesson = movedSched[0][2][0]; // Monday Period 2: Iqtisodiyot nazariyasi
  delete movedSched[0][2]; // Removed from Monday
  movedSched[2][1] = [movedLesson]; // Moved to Wednesday Period 1
  const movedDiffs = diffGroupSchedules(baseSched, movedSched);
  assert(movedDiffs.length === 1, 'Rescheduled lesson detected');
  assert(
    movedDiffs[0]?.type === 'LESSON_MOVED' &&
    movedDiffs[0].fromDay === 0 &&
    movedDiffs[0].fromPeriod === 2 &&
    movedDiffs[0].toDay === 2 &&
    movedDiffs[0].toPeriod === 1 &&
    movedDiffs[0].subject === 'Iqtisodiyot nazariyasi',
    'Rescheduled lesson has accurate fromDay/toDay/fromPeriod/toPeriod'
  );

  // 7. Lesson added
  const addedSched = JSON.parse(JSON.stringify(baseSched));
  addedSched[1][3] = [{ subject: 'Makroiqtisodiyot', room: '204', teacher: 'Dots. Ergashev' }];
  const addedDiffs = diffGroupSchedules(baseSched, addedSched);
  assert(addedDiffs.length === 1, 'Added lesson detected');
  assert(
    addedDiffs[0]?.type === 'LESSON_ADDED' &&
    addedDiffs[0].dayIdx === 1 &&
    addedDiffs[0].period === 3 &&
    addedDiffs[0].newLessons[0].subject === 'Makroiqtisodiyot',
    'Added lesson metadata accurate'
  );

  // 8. Lesson cancelled
  const cancelledSched = JSON.parse(JSON.stringify(baseSched));
  delete cancelledSched[4][2]; // Cancel Friday Period 2
  const cancelledDiffs = diffGroupSchedules(baseSched, cancelledSched);
  assert(cancelledDiffs.length === 1, 'Cancelled lesson detected');
  assert(
    cancelledDiffs[0]?.type === 'LESSON_CANCELLED' &&
    cancelledDiffs[0].dayIdx === 4 &&
    cancelledDiffs[0].period === 2 &&
    cancelledDiffs[0].oldLessons[0].subject === 'Falsafa',
    'Cancelled lesson metadata accurate'
  );

  // 9. Initial/empty baseline fallback
  const overviewDiffs = diffGroupSchedules({}, baseSched);
  assert(overviewDiffs.length === 1, 'Missing baseline produces full overview diff');
  assert(overviewDiffs[0]?.type === 'SCHEDULE_FULL_OVERVIEW', 'Type is SCHEDULE_FULL_OVERVIEW');

  // 10. formatChangeAlert HTML formatting validation
  const alertText = formatChangeAlert('BHA-56/24i', [
    ...roomDiffs,
    ...teacherDiffs,
    ...movedDiffs,
    ...addedDiffs,
    ...cancelledDiffs,
  ]);
  assert(typeof alertText === 'string' && alertText.length > 50, 'formatChangeAlert produces message');
  assert(alertText.includes('BHA-56/24i'), 'Alert contains group name');
  assert(alertText.includes('Dars vaqti ko\'chirildi:'), 'Alert formats moved lessons');
  assert(alertText.includes('Yangi dars qo\'shildi:'), 'Alert formats added lessons');
  assert(alertText.includes('Dars bekor qilindi:'), 'Alert formats cancelled lessons');

  console.log(`\n📊 Sensitivity Test Results: ${passed} Passed, ${failed} Failed`);
  if (failed > 0) {
    process.exit(1);
  }
  console.log('🎉 All schedule diff sensitivity tests passed with 100% precision!\n');
}

runTests();
