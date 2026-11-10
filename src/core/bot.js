'use strict';

const cramReviewHandler = require('../handlers/cramReviewHandler');

/**
 * Registers cram review and blitz-flashcard actions into Telegraf bot.
 * Actions:
 * - cram_start_:subj_:id
 * - cram_reveal_:idx
 * - cram_hide_:idx
 * - cram_known_:idx
 * - cram_repeat_:idx
 * - cram_exit
 *
 * @param {object} bot - Telegraf bot instance
 */
function registerCramActions(bot) {
  if (!bot || typeof bot.action !== 'function') return;
  return cramReviewHandler.register(bot);
}

module.exports = {
  memoryDb: {},
  registerCramActions,
  register: registerCramActions,
};
