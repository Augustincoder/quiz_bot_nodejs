'use strict';

process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'dummy_test_token';

const edupageService = require('../src/services/edupageService');
const scheduleService = require('../src/services/scheduleService');

async function testWeekendLogic() {
  console.log('🧪 Testing Weekend Schedule & Broadcast Prevention...\n');

  const testGroup = 'BHA-56/24i';

  // 1. Test hasClassLessonsOnDay
  const hasMon = await edupageService.hasClassLessonsOnDay(testGroup, 0);
  const hasSat = await edupageService.hasClassLessonsOnDay(testGroup, 5);
  const hasSun = await edupageService.hasClassLessonsOnDay(testGroup, 6);

  console.log(`1. hasClassLessonsOnDay for ${testGroup}:`);
  console.log(`   - Monday (0): ${hasMon ? '✅ Has lessons' : '❌ No lessons'}`);
  console.log(`   - Saturday (5): ${hasSat ? 'Has lessons' : '✅ No lessons (Expected)'}`);
  console.log(`   - Sunday (6): ${hasSun ? 'Has lessons' : '✅ No lessons (Universal day off)'}`);

  if (!hasMon || hasSun) {
    console.error('❌ FAILED: Unexpected lesson presence/absence for test group');
    process.exit(1);
  }

  // 2. Test fetchTodaySchedule on Sunday
  const sundaySchedule = await scheduleService.fetchTodaySchedule(testGroup, 6);
  console.log('\n2. fetchTodaySchedule on Sunday (6):');
  console.log(sundaySchedule);
  if (!sundaySchedule.includes('dam olish kuni')) {
    console.error('❌ FAILED: Sunday schedule did not indicate day off');
    process.exit(1);
  }

  // 3. Test fetchTodaySchedule on Saturday (for a group without Saturday lessons)
  const satSchedule = await scheduleService.fetchTodaySchedule(testGroup, 5);
  console.log('\n3. fetchTodaySchedule on Saturday (5) for group without lessons:');
  console.log(satSchedule);
  if (!satSchedule.includes('darslar yo\'q')) {
    console.error('❌ FAILED: Saturday empty schedule format mismatch');
    process.exit(1);
  }

  // 4. Test worker filter simulation
  const checkWorkerSkip = (text, day) => {
    if (day === 6) return true; // Sunday skip
    return !text ||
      text.includes('Jadval topilmadi') ||
      text.includes('xatolik') ||
      text.includes('topilmadi') ||
      text.includes('kiritilmagan') ||
      text.includes("darslar yo'q") ||
      text.includes("dars yo'q") ||
      text.includes("dam olish kuni") ||
      !text.includes('-para');
  };

  const monSchedule = await scheduleService.fetchTodaySchedule(testGroup, 0);
  const monSkipped = checkWorkerSkip(monSchedule, 0);
  const satSkipped = checkWorkerSkip(satSchedule, 5);
  const sunSkipped = checkWorkerSkip(sundaySchedule, 6);

  console.log('\n4. Worker Broadcast Skip Filter Simulation:');
  console.log(`   - Monday broadcast skipped: ${monSkipped ? '❌ YES (Bug!)' : '✅ NO (Sent to students)'}`);
  console.log(`   - Saturday empty broadcast skipped: ${satSkipped ? '✅ YES (Protected!)' : '❌ NO (Spam!)'}`);
  console.log(`   - Sunday broadcast skipped: ${sunSkipped ? '✅ YES (Protected!)' : '❌ NO (Spam!)'}`);

  if (monSkipped || !satSkipped || !sunSkipped) {
    console.error('❌ FAILED: Worker filter simulation failed');
    process.exit(1);
  }

  console.log('\n🎉 All weekend schedule tests passed successfully!');
}

testWeekendLogic().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
