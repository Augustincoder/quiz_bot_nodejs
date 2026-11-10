'use strict';

const cramReviewHandler = require('../handlers/cramReviewHandler');
const universalTestHub = require('../handlers/universalTestHub');

/**
 * Registers cram review and universal test hub actions into Telegraf bot.
 *
 * @param {object} bot - Telegraf bot instance
 */
function registerCramActions(bot) {
  if (!bot || typeof bot.action !== 'function') return;
  cramReviewHandler.register(bot);
  universalTestHub.register(bot);
}

module.exports = {
  memoryDb: {},
  registerCramActions,
  register: registerCramActions,
};
