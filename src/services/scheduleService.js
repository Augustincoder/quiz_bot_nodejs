'use strict';

const { getFormattedSchedule, getRawSchedule, getEmptyRoomsText } = require('./edupageService');
const { generateScheduleImage } = require('./imageService');

// O'ZGARISH: specificDayIdx qo'shildi
async function fetchTodaySchedule(className, specificDayIdx = null) {
    let dayOfWeek;
    if (specificDayIdx !== null && specificDayIdx !== undefined) {
        dayOfWeek = specificDayIdx;
    } else {
        const date = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
        dayOfWeek = (date.getDay() + 6) % 7;
    }
    return await getFormattedSchedule(className, dayOfWeek < 6 ? dayOfWeek : 0);
}

async function fetchWeeklyScheduleImage(className) {
    const schedule = await getRawSchedule(className);
    if (!schedule || Object.keys(schedule).length === 0) return null;
    return await generateScheduleImage(className, schedule);
}

async function fetchEmptyRooms(className, dayIdx, periodNum, offsetDays) {
    return await getEmptyRoomsText(className, dayIdx, periodNum, offsetDays);
}

module.exports = { 
    fetchTodaySchedule, 
    fetchWeeklyScheduleImage, 
    fetchEmptyRooms 
};