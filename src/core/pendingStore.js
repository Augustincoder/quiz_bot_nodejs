'use strict';
const { TTLMap } = require('./utils');

// 10 daqiqadan keyin xotiradan avtomatik o'chib ketadi (600_000 ms)
// Bu bot RAM'ini himoya qiladi
const pendingShelfSaves = new TTLMap(600_000); 

module.exports = { pendingShelfSaves };