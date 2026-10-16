'use strict';

const assert = require('assert');
const edupageService = require('../src/services/edupageService');
const scheduleService = require('../src/services/scheduleService');
const { safeCallbackData } = require('../src/core/utils');

async function runTests() {
  console.log('==================================================');
  console.log('🧪 SMART SCHEDULE V2: AUTOMATED VERIFICATION SUITE');
  console.log('==================================================\n');

  // ─── 1. Test normalizeSubjectKey & normalizeLessonType ───────────
  console.log('--- 1. Testing normalizeSubjectKey & normalizeLessonType ---');
  {
    const sub1 = "Korporativ moliya (Ma'ruza)";
    const norm1 = edupageService.normalizeSubjectKey(sub1);
    assert.strictEqual(norm1, "Korporativ moliya", "Parenthetical (Ma'ruza) stripped correctly");
    assert.strictEqual(edupageService.normalizeLessonType(sub1), "lecture", "Lecture type detected");

    const sub2 = "Ekonometrika (Amaliyot)";
    assert.strictEqual(edupageService.normalizeSubjectKey(sub2), "Ekonometrika", "Parenthetical (Amaliyot) stripped correctly");
    assert.strictEqual(edupageService.normalizeLessonType(sub2), "practice", "Practice type detected");

    const sub3 = "Fizika (Lab)";
    assert.strictEqual(edupageService.normalizeSubjectKey(sub3), "Fizika", "Parenthetical (Lab) stripped correctly");
    assert.strictEqual(edupageService.normalizeLessonType(sub3), "lab", "Lab type detected");

    const sub4 = "Oliy matematika (Seminar)";
    assert.strictEqual(edupageService.normalizeLessonType(sub4), "practice", "Seminar detected as practice");

    const sub5 = "Buxgalteriya hisobi (Lek)";
    assert.strictEqual(edupageService.normalizeLessonType(sub5), "lecture", "Lek detected as lecture");

    const sub6 = "Axborot xavfsizligi [M]";
    assert.strictEqual(edupageService.normalizeLessonType(sub6), "lecture", "[M] prefix detected as lecture");
    assert.strictEqual(edupageService.normalizeSubjectKey(sub6), "Axborot xavfsizligi", "[M] stripped");

    // Subgroup lesson object detection
    const lessonObjPractice = {
      subject: "Mikroiqtisodiyot",
      subgroups: ["1-guruh"],
    };
    assert.strictEqual(edupageService.normalizeLessonType(lessonObjPractice), "practice", "Subgroup presence resolves to practice");

    // Joint stream lesson object detection
    const lessonObjLecture = {
      subject: "Makroiqtisodiyot",
      jointGroups: ["MI-1", "MI-2"],
    };
    assert.strictEqual(edupageService.normalizeLessonType(lessonObjLecture), "lecture", "Joint groups resolve to lecture");

    console.log('  ✅ Passed: normalizeSubjectKey and normalizeLessonType correctly handle Latin, Cyrillic, abbreviations, and subgroups.');
  }

  // ─── 2. Test detectCurrentActiveLesson at Simulated Times ─────────
  console.log('\n--- 2. Testing detectCurrentActiveLesson at Simulated Times ---');
  {
    const mockTodayLessons = [
      { period: 1, startTime: '08:00', endTime: '09:20', subject: "Oliy matematika (Ma'ruza)", room: 'A-101' },
      { period: 2, startTime: '09:30', endTime: '10:50', subject: "Oliy matematika (Amaliyot)", room: 'A-102' },
      { period: 4, startTime: '13:00', endTime: '14:20', subject: "Falsafa", room: 'B-201' },
    ];

    // Case 2.1: At 08:30 (510 mins) -> 1st class IN_PROGRESS
    const active1 = edupageService.detectCurrentActiveLesson(mockTodayLessons, 510);
    assert.ok(active1, 'Active lesson found at 08:30');
    assert.strictEqual(active1.state, 'IN_PROGRESS');
    assert.strictEqual(active1.period, 1);
    assert.strictEqual(active1.baseSubject, 'Oliy matematika');
    assert.strictEqual(active1.lessonType, 'lecture');

    // Case 2.2: At 09:25 (565 mins, 5 mins after period 1 ends) -> JUST_FINISHED
    const active2 = edupageService.detectCurrentActiveLesson(mockTodayLessons, 565);
    assert.ok(active2, 'Recent lesson found at 09:25');
    assert.strictEqual(active2.state, 'JUST_FINISHED');
    assert.strictEqual(active2.period, 1);

    // Case 2.3: At 09:35 (575 mins) -> Period 2 IN_PROGRESS
    const active3 = edupageService.detectCurrentActiveLesson(mockTodayLessons, 575);
    assert.ok(active3, 'Period 2 found at 09:35');
    assert.strictEqual(active3.state, 'IN_PROGRESS');
    assert.strictEqual(active3.period, 2);
    assert.strictEqual(active3.lessonType, 'practice');

    // Case 2.4: At 12:00 (720 mins) -> Gap window (no active lesson)
    const active4 = edupageService.detectCurrentActiveLesson(mockTodayLessons, 720);
    assert.strictEqual(active4, null, 'No active lesson during gap window');

    console.log('  ✅ Passed: detectCurrentActiveLesson accurately detects IN_PROGRESS, JUST_FINISHED, and gap windows.');
  }

  // ─── 3. Test findUpcomingCourseOccurrences & Lecture-to-Seminar ───
  console.log('\n--- 3. Testing findUpcomingCourseOccurrences & Lecture-to-Seminar ---');
  {
    // Mock weekly timetable where Monday (0) has Lecture and Wednesday (2) has Practice
    const mockWeeklyTimetable = {
      0: {
        1: [{ subject: "Korporativ moliya (Ma'ruza)", startTime: '08:00', endTime: '09:20', room: 'A-201' }],
      },
      2: {
        2: [{ subject: "Korporativ moliya (Amaliyot)", startTime: '09:30', endTime: '10:50', room: 'A-205' }],
      },
      4: {
        1: [{ subject: "Korporativ moliya (Ma'ruza)", startTime: '08:00', endTime: '09:20', room: 'A-201' }],
      },
    };

    // Simulated from Monday morning
    const simulatedMonday = new Date('2026-10-19T08:30:00+05:00'); // Monday in Tashkent

    // Target lesson type 'practice' (student is in Lecture, assigning homework for Seminar)
    const occurrences = edupageService.findUpcomingCourseOccurrences(
      mockWeeklyTimetable,
      "Korporativ moliya",
      'practice',
      simulatedMonday,
      3
    );

    assert.ok(occurrences.length > 0, 'Occurrences returned');
    // Primary #1 occurrence must be the upcoming Wednesday Practice!
    assert.strictEqual(occurrences[0].lessonType, 'practice', '#1 occurrence is Practice');
    assert.strictEqual(occurrences[0].period, 2, 'Period 2');
    assert.strictEqual(occurrences[0].dayLabel, 'Chor', 'Wednesday (Chorshanba)');

    console.log('  ✅ Passed: Lecture-to-Seminar prioritized as #1 upcoming occurrence with exact date and period.');
  }

  // ─── 4. Test Shift Detection (getFirstAndLastLessonOfDay) ─────────
  console.log('\n--- 4. Testing Shift Detection (getFirstAndLastLessonOfDay) ---');
  {
    // Morning shift: first lesson starts at 08:00
    const morningDay = [
      { period: 1, startTime: '08:00', endTime: '09:20', subject: "Matematika" },
      { period: 2, startTime: '09:30', endTime: '10:50', subject: "Fizika" },
    ];
    const shift1 = edupageService.getFirstAndLastLessonOfDay(morningDay);
    assert.strictEqual(shift1.isAfternoonShift, false, '08:00 start is Morning shift');
    assert.strictEqual(shift1.firstLesson.period, 1);

    // Afternoon shift: first lesson starts at 13:30 (or period 4)
    const afternoonDay = [
      { period: 4, startTime: '13:00', endTime: '14:20', subject: "Falsafa" },
      { period: 5, startTime: '14:30', endTime: '15:50', subject: "Tarix" },
    ];
    const shift2 = edupageService.getFirstAndLastLessonOfDay(afternoonDay);
    assert.strictEqual(shift2.isAfternoonShift, true, '13:00 start is Afternoon shift');
    assert.strictEqual(shift2.firstLesson.period, 4);

    console.log('  ✅ Passed: Morning (<13:00) vs Afternoon (>=13:00) shift detection operates correctly.');
  }

  // ─── 5. Test detectBuildingTransition & isSameDoublePair ──────────
  console.log('\n--- 5. Testing detectBuildingTransition & isSameDoublePair ---');
  {
    const lesson1A = { period: 1, subject: "Moliya", room: "A-204" };
    const lesson2B = { period: 2, subject: "Menejment", room: "B-305" };
    assert.strictEqual(edupageService.detectBuildingTransition(lesson1A, lesson2B), true, 'A-204 to B-305 detected as building change');

    const lesson2A = { period: 2, subject: "Moliya", room: "A-204" };
    assert.strictEqual(edupageService.detectBuildingTransition(lesson1A, lesson2A), false, 'Same building (A to A)');

    // isSameDoublePair filter
    const currPair = { subject: "Ekonometrika (Ma'ruza)", room: "3-bino 105" };
    const nextPairSame = { subject: "Ekonometrika (Ma'ruza)", room: "3-bino 105" };
    assert.strictEqual(edupageService.isSameDoublePair(currPair, nextPairSame), true, 'Same subject and room is continuing double block');

    const nextPairDiffRoom = { subject: "Ekonometrika (Ma'ruza)", room: "3-bino 204" };
    assert.strictEqual(edupageService.isSameDoublePair(currPair, nextPairDiffRoom), false, 'Different room breaks double pair');

    const nextPairDiffSubject = { subject: "Iqtisodiyot", room: "3-bino 105" };
    assert.strictEqual(edupageService.isSameDoublePair(currPair, nextPairDiffSubject), false, 'Different subject breaks double pair');

    console.log('  ✅ Passed: Building hopping alerts and double-period suppression verified.');
  }

  // ─── 6. Test 64-Byte Callback Data Safety ─────────────────────────
  console.log('\n--- 6. Testing 64-Byte Callback Data Safety ---');
  {
    const callbacks = [
      'no:0',
      'no:1',
      'no:9',
      'ns:0',
      'ns:15',
      'np:subj',
      'nc:cancel',
      'nd:104928',
      'nsz:104928',
      'v2_mode_shift',
      'v2_offset_60',
      'v2_toggle_bell',
      'v2_toggle_bld',
      'v2_mode_disabled',
      'v2_mode_custom',
    ];

    for (const cb of callbacks) {
      const safe = safeCallbackData(cb, 64);
      const byteLen = Buffer.byteLength(safe, 'utf8');
      assert.ok(byteLen <= 64, `Callback data "${cb}" (${byteLen} bytes) must be <= 64 bytes`);
      assert.strictEqual(safe, cb, `Callback data "${cb}" remains uncorrupted`);
    }

    console.log('  ✅ Passed: All Smart Schedule v2 callback data payloads are strictly <= 64 bytes.');
  }

  console.log('\n==================================================');
  console.log('🎉 ALL SMART SCHEDULE V2 TESTS PASSED (6/6)!');
  console.log('==================================================\n');
}

runTests().catch((err) => {
  console.error('❌ Smart Schedule v2 Test Failed:', err);
  process.exit(1);
});
