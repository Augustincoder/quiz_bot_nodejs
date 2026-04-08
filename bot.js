'use strict';

/**
 * bot.js — Markaziy modul.
 * memory_db (rasmiy testlar) shu yerda saqlanadi va barcha handlerlarga
 * require('../bot').memoryDb orqali ulashiladi.
 */

let memoryDb = {};   // { subjectKey: { testId: { questions, ... } } }

module.exports = { memoryDb };