'use strict';

const fs           = require('fs');
const path         = require('path');
const { Markup }   = require('telegraf');

const { ADMIN_ID, SUBJECTS } = require('../config/config');
const dbService = require('../services/dbService');
const {
  States, setState, clearState, updateData, getData, getState,
  safeEdit, backToMainKb, progressBar, parseSuffix,
  parseDocxQuestions, parseTextQuestions,
} = require('../core/utils');

function isAdmin(userId) { return userId === ADMIN_ID; }

// FIX #1: Barcha admin callbacklarda isAdmin tekshiruvi yo'q edi.
// Har bir funksiyada alohida tekshirish o'rniga markazlashgan guard yaratildi.
function adminGuard(fn) {
  return async (ctx, ...args) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ruxsat yo\'q!', { show_alert: true });
    return fn(ctx, ...args);
  };
}

const PER_PAGE = 15;

// ─── PANEL ───────────────────────────────────────────────────
async function buildPanelContent() {
  const users = await dbService.getAllUsers();
  const count = users ? users.length : 0;
  const text  = `👨‍💻 *ADMIN PANEL*\n\n👥 Jami foydalanuvchilar: *${count} ta*\n\nBo\'limni tanlang:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('📢 Barchaga xabar yuborish', 'admin_broadcast')],
    [Markup.button.callback('👥 Foydalanuvchilar', 'admin_users_page_0')],
    [Markup.button.callback('🔍 Foydalanuvchi qidirish', 'admin_search_user')],  // YANGI
    [Markup.button.callback('📊 Statistika', 'admin_stats')],                    // YANGI
    [Markup.button.callback('➕ Rasmiy test qo\'shish', 'admin_add_test')],
    [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
  ]);
  return { text, kb };
}

async function cmdAdmin(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Siz admin emassiz!');
  const { text, kb } = await buildPanelContent();
  await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
}

async function cbAdminPanelMain(ctx) {
  await ctx.answerCbQuery();
  const { text, kb } = await buildPanelContent();
  await safeEdit(ctx, text, kb);
}

async function cbAdminCancel(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  const { text, kb } = await buildPanelContent();
  await safeEdit(ctx, text, kb);
}


// ─── FOYDALANUVCHILAR RO'YXATI (PAGINATION) ──────────────────
// FIX #2: Pagination mavjud edi, lekin parse_mode 'Markdown' safeEdit ga
// uzatilmayotgani sababli [ism](tg://user?id=...) havolalar ishlamay,
// Telegram xatolik qaytarardi va ro'yxat ko'rsatilmasdi.
// Yechim: safeEdit ga options object sifatida parse_mode bilan uzatish.
async function cbAdminUsersList(ctx) {
  await ctx.answerCbQuery();

  const page  = parseInt(parseSuffix(ctx.callbackQuery.data, 'admin_users_page_'), 10) || 0;
  const users = await dbService.getAllUsers();
  if (!users || !users.length) return safeEdit(ctx, '👥 Hali foydalanuvchilar yo\'q.', backToMainKb());

  const totalPages = Math.max(1, Math.ceil(users.length / PER_PAGE));
  const p          = Math.max(0, Math.min(page, totalPages - 1));
  const chunk      = users.slice(p * PER_PAGE, (p + 1) * PER_PAGE);

  // FIX #3: Ism juda uzun bo'lsa xabar 4096 chegarasidan o'tib ketishi mumkin.
  // Ismlar 25 belgidan kesiladi.
  const lines = chunk.map((u, i) => {
    const rawName  = (u.full_name || 'Ismsiz').slice(0, 25);
    const userLink = `[${rawName}](tg://user?id=${u.telegram_id})`;
    const uname    = u.username && u.username !== "yo'q" ? ` @${u.username}` : '';
    return `*${p * PER_PAGE + i + 1}.* ${userLink}${uname}`;
  });

  const nav = [];
  if (p > 0)             nav.push(Markup.button.callback('⬅️', `admin_users_page_${p - 1}`));
  // FIX #4: Sahifa ko'rsatkichi tugmasi qo'shildi. "ignore" pastda ro'yxatdan o'tkazilgan.
  nav.push(Markup.button.callback(`${p + 1} / ${totalPages}`, 'ignore'));
  if (p < totalPages - 1) nav.push(Markup.button.callback('➡️', `admin_users_page_${p + 1}`));

  const buttons = [nav];
  buttons.push([Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]);

  await safeEdit(
    ctx,
    `👥 *Foydalanuvchilar* (${p * PER_PAGE + 1}–${Math.min((p + 1) * PER_PAGE, users.length)} / ${users.length}):\n\n` + lines.join('\n'),
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) }
  );
}


// ─── YANGI: FOYDALANUVCHI QIDIRISH ───────────────────────────
async function cbAdminSearchUser(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.ADMIN_SEARCH_USER);
  await safeEdit(ctx,
    '🔍 *Foydalanuvchi qidirish*\n\nTelegram ID yoki @username yuboring:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) }
  );
}

async function onAdminSearchInput(ctx) {
  clearState(ctx);
  const query = (ctx.message.text || '').trim().replace('@', '');
  const users = await dbService.getAllUsers();
  if (!users) return ctx.reply('❌ Foydalanuvchilar topilmadi.');

  const found = users.find(u =>
    String(u.telegram_id) === query ||
    (u.username && u.username.toLowerCase() === query.toLowerCase())
  );

  if (!found) return ctx.reply(`❌ *${query}* — topilmadi.`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) });

  const stats  = await dbService.getUserStats(found.telegram_id);
  const history = stats?.history || [];
  const totalTests  = history.length;
  const avgScore    = totalTests
    ? Math.round(history.reduce((s, h) => s + (h.percent || 0), 0) / totalTests)
    : 0;

  const name    = found.full_name || 'Ismsiz';
  const uname   = found.username && found.username !== "yo'q" ? `@${found.username}` : '—';
  const classVal = found.class_name || '—';

  await ctx.reply(
    `👤 *Foydalanuvchi:* [${name}](tg://user?id=${found.telegram_id})\n` +
    `🆔 \`${found.telegram_id}\`\n` +
    `📛 Username: ${uname}\n` +
    `🎓 Guruh: ${classVal}\n\n` +
    `📊 *Statistika:*\n` +
    `📝 Jami testlar: *${totalTests} ta*\n` +
    `🎯 O'rtacha ball: *${avgScore}%*`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('↩️ Xabar yuborish', `reply_${found.telegram_id}`)],
        [Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]
      ])
    }
  );
}


// ─── YANGI: UMUMIY STATISTIKA ─────────────────────────────────
async function cbAdminStats(ctx) {
  await ctx.answerCbQuery();
  const users  = await dbService.getAllUsers();
  const count  = users ? users.length : 0;

  // Barcha userlarning statsini parallel yuklaymiz
  let totalTests = 0, totalCorrect = 0, totalWrong = 0;
  if (users && users.length) {
    const allStats = await Promise.allSettled(users.map(u => dbService.getUserStats(u.telegram_id)));
    for (const res of allStats) {
      if (res.status !== 'fulfilled' || !res.value) continue;
      const history = res.value.history || [];
      totalTests += history.length;
      for (const h of history) {
        totalCorrect += h.correct || 0;
        totalWrong   += h.wrong   || 0;
      }
    }
  }

  const totalAnswers = totalCorrect + totalWrong;
  const avgGlobal    = totalAnswers ? Math.round((totalCorrect / totalAnswers) * 100) : 0;

  await safeEdit(ctx,
    `📊 *Umumiy Statistika*\n\n` +
    `👥 Foydalanuvchilar: *${count} ta*\n` +
    `📝 Jami yechilgan testlar: *${totalTests} ta*\n` +
    `✅ Jami to\'g\'ri javoblar: *${totalCorrect} ta*\n` +
    `❌ Jami xato javoblar: *${totalWrong} ta*\n` +
    `🎯 O\'rtacha natija: *${avgGlobal}%*\n` +
    `${progressBar(avgGlobal, 100)}`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) }
  );
}


// ─── BROADCAST ───────────────────────────────────────────────
async function cbAdminBroadcast(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.ADMIN_BROADCAST);
  await safeEdit(ctx,
    '📢 *Ommaviy xabar*\n\nBarcha foydalanuvchilarga yuboriladigan matnni yozing:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) }
  );
}

// FIX #5: Broadcast tasdiqlash bosqichi yo'q edi — admin tasodifan yuborishi mumkin edi.
// Endi matn kiritilgandan so'ng preview + "✅ Tasdiqlash" / "✏️ Qayta yozish" ko'rsatiladi.
async function onBroadcastMessage(ctx) {
  const text = ctx.message.text;
  if (!text) return;
  await updateData(ctx, { broadcast_text: text });
  setState(ctx, States.ADMIN_BROADCAST_CONFIRM);

  const users = await dbService.getAllUsers();
  await ctx.reply(
    `📋 *Preview — ${users.length} ta foydalanuvchiga yuboriladi:*\n\n` +
    `─────────────────\n${text}\n─────────────────\n\n` +
    `Tasdiqlaysizmi?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Tasdiqlash va Yuborish', 'admin_broadcast_confirm')],
        [Markup.button.callback('✏️ Qayta yozish', 'admin_broadcast')],
        [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]
      ])
    }
  );
}

async function cbBroadcastConfirm(ctx) {
  await ctx.answerCbQuery();
  clearState(ctx);
  const data   = await getData(ctx);
  const text   = data.broadcast_text;
  const users  = await dbService.getAllUsers();
  if (!text || !users?.length) return safeEdit(ctx, '❌ Xatolik.', backToMainKb());

  await safeEdit(ctx, `⏳ *${users.length} ta foydalanuvchiga yuborilmoqda...*`, { parse_mode: 'Markdown' });

  let ok = 0;
  const BATCH = 25;
  for (let i = 0; i < users.length; i += BATCH) {
    await Promise.all(users.slice(i, i + BATCH).map(async u => {
      try { await ctx.telegram.sendMessage(u.telegram_id, text); ok++; } catch { /* blocked */ }
    }));
    await new Promise(r => setTimeout(r, 500));
  }

  await safeEdit(ctx,
    `✅ *Yakunlandi!*\n\n🟢 Yetib bordi: *${ok} ta*\n🔴 Bloklaganlar: *${users.length - ok} ta*`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) }
  );
}


// ─── REPLY TO USER ───────────────────────────────────────────
async function cbReplyStart(ctx) {
  await ctx.answerCbQuery();
  const targetId = parseSuffix(ctx.callbackQuery.data, 'reply_');
  await updateData(ctx, { target_id: targetId });
  setState(ctx, States.ADMIN_REPLY);
  await ctx.reply('✍️ Foydalanuvchiga javobingizni yozing:', Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]));
}

async function onReplyMessage(ctx) {
  const data = await getData(ctx);
  clearState(ctx);
  try {
    await ctx.telegram.sendMessage(parseInt(data.target_id, 10), `📩 *Admin javobi:*\n\n${ctx.message.text}`, { parse_mode: 'Markdown' });
    await ctx.reply('✅ Javob yuborildi.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]));
  } catch { await ctx.reply('❌ Foydalanuvchiga xabar yuborib bo\'lmadi.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]])); }
}


// ─── TEST QO'SHISH ────────────────────────────────────────────
function adminControlsKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Matn', 'adm_switch_text'), Markup.button.callback('📄 Word', 'adm_switch_docx')],
    [Markup.button.callback('👁 Ko\'rib chiqish', 'adm_preview')],
    [Markup.button.callback('✅ Saqlash', 'adm_finish')],
    [Markup.button.callback('🗑 Tozalash', 'adm_reset')],
    [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
  ]);
}

async function adminPrompt(ctx, fmt, total, edit = false) {
  const fmtLabel = fmt === 'text' ? '📝 Matn' : '📄 Word (.docx)';
  const bar      = progressBar(Math.min(total, 30), 30);
  const hint     = fmt === 'text' ? '📝 Matn formatida savollar yuboring' : '📄 Word (.docx) fayl yuboring';
  const text     = `➕ *Rasmiy test qo\'shish*\n\n📌 Format: ${fmtLabel}\n📊 Yig\'ilgan: *${total} ta savol*\n${bar}\n\n${hint}`;
  if (edit) await safeEdit(ctx, text, adminControlsKb());
  else await ctx.reply(text, { parse_mode: 'Markdown', ...adminControlsKb() });
}

async function cbAdminAddTest(ctx) {
  await ctx.answerCbQuery();
  const buttons = Object.entries(SUBJECTS).map(([k, v]) => [Markup.button.callback(v, `adm_subj_${k}`)]);
  buttons.push([Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]);
  await safeEdit(ctx, '📂 *Rasmiy test qo\'shish*\n\nQaysi fanga?', Markup.inlineKeyboard(buttons));
  setState(ctx, States.ADM_CREATE_SUBJECT);
}

async function cbAdmSubj(ctx) {
  await ctx.answerCbQuery();
  const subj = parseSuffix(ctx.callbackQuery.data, 'adm_subj_');
  await updateData(ctx, { subject: subj });
  setState(ctx, States.ADM_CREATE_TEST_ID);
  await safeEdit(ctx, `✅ Fan: *${SUBJECTS[subj] || subj}*\n\n🔢 Blok raqamini kiriting:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]));
}

async function onAdmTestId(ctx) {
  const text = (ctx.message.text || '').trim();
  if (!/^\d+$/.test(text)) return ctx.reply('⚠️ Faqat raqam kiriting (1, 2, 15...):');
  await updateData(ctx, { test_id: parseInt(text, 10) });
  setState(ctx, States.ADM_CREATE_FORMAT);
  await ctx.reply(`✅ Blok raqami: *${text}*\n\nSavollarni qaysi formatda yuborasiz?`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📝 Matn', 'adm_fmt_text')],
      [Markup.button.callback('📄 Word', 'adm_fmt_docx')],
      [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]
    ])
  });
}

async function cbAdmFmt(ctx) {
  await ctx.answerCbQuery();
  const fmt = parseSuffix(ctx.callbackQuery.data, 'adm_fmt_');
  await updateData(ctx, { format: fmt, questions: [] });
  setState(ctx, States.ADM_CREATE_CONTENT);
  await adminPrompt(ctx, fmt, 0, true);
}

async function cbAdmSwitchFmt(ctx) {
  await ctx.answerCbQuery();
  const fmt  = parseSuffix(ctx.callbackQuery.data, 'adm_switch_');
  const data = await getData(ctx);
  await updateData(ctx, { format: fmt });
  await adminPrompt(ctx, fmt, (data.questions || []).length, true);
}

async function cbAdmPreview(ctx) {
  const data      = await getData(ctx);
  const questions = data.questions || [];
  if (!questions.length) return ctx.answerCbQuery('❌ Hali savol yo\'q!', { show_alert: true });
  await ctx.answerCbQuery();
  const lines = questions.slice(0, 20).map((q, i) => `*${i + 1}.* ${q.question}\n✅ ${q.options[q.correct_index]}`);
  let text = `👁 *Preview — ${questions.length} ta savol:*\n\n` + lines.join('\n\n');
  if (text.length > 4000) text = text.slice(0, 3900) + `\n\n_...va yana ${questions.length - 20} ta savol_`;
  await ctx.reply(text, { parse_mode: 'Markdown' });
}

async function cbAdmReset(ctx) {
  const data = await getData(ctx);
  await updateData(ctx, { questions: [] });
  await ctx.answerCbQuery('✅ Barcha savollar o\'chirildi!', { show_alert: true });
  await adminPrompt(ctx, data.format || 'text', 0, true);
}

async function onAdmTextContent(ctx) {
  const data = await getData(ctx);
  if (data.format !== 'text') return ctx.reply('⚠️ Hozir *Word* formati tanlangan.');
  const newQs = parseTextQuestions(ctx.message.text);
  if (!newQs.length) return ctx.reply('⚠️ Savol topilmadi!');
  const questions = [...(data.questions || []), ...newQs];
  await updateData(ctx, { questions });
  await adminPrompt(ctx, 'text', questions.length);
}

async function onAdmDocxContent(ctx) {
  const data = await getData(ctx);
  if (data.format !== 'docx') return ctx.reply('⚠️ Hozir *Matn* formati tanlangan.');
  const doc = ctx.message.document;
  if (!doc || !doc.file_name.endsWith('.docx')) return ctx.reply('⚠️ Faqat `.docx` qabul qilinadi.');

  const status   = await ctx.reply('⏳ Fayl o\'qilmoqda...');
  const filePath = path.join(require('os').tmpdir(), `admin_${ctx.from.id}_${Date.now()}.docx`);
  try {
    const link  = await ctx.telegram.getFileLink(doc.file_id);
    const http_ = link.href.startsWith('https') ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      http_.get(link.href, res => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); }).on('error', reject);
    });
    const newQs = await parseDocxQuestions(filePath);
    if (!newQs.length) return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '❌ Fayldan savol topilmadi.');
    const questions = [...(data.questions || []), ...newQs];
    await updateData(ctx, { questions });
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await adminPrompt(ctx, 'docx', questions.length);
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Xatolik: ${e.message}`);
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

async function cbAdmFinish(ctx) {
  const data      = await getData(ctx);
  const questions = data.questions || [];
  if (!questions.length) return ctx.answerCbQuery('⚠️ Savol yo\'q!', { show_alert: true });
  await ctx.answerCbQuery();

  // FIX #6: { subj, test_id } = { subj: data.subject, ... } noto'g'ri pattern edi.
  // To'g'ridan-to'g'ri o'zgaruvchilar ishlatildi.
  const subject = data.subject;
  const testId  = data.test_id;

  const success = await dbService.saveOfficialTest(subject, testId, questions);
  if (!success) return ctx.answerCbQuery('❌ Supabase\'ga saqlashda xatolik.', { show_alert: true });

  await safeEdit(ctx,
    `✅ *Rasmiy test saqlandi!*\n\n📚 Fan: *${SUBJECTS[subject] || subject}*\n🔖 Blok: *${testId}*\n🔢 Savollar: *${questions.length} ta*`,
    Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]])
  );
  clearState(ctx);
}


// ─── USER → ADMIN MUROJAAT ───────────────────────────────────
async function cbContactAdmin(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.USER_CONTACT);
  await ctx.reply('💬 *Adminga Murojaat*\n\nSavol yoki taklifingizni yozing:', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'cancel_contact')]])
  });
}

async function cbCancelContact(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  await ctx.reply('❌ Murojaat bekor qilindi.', backToMainKb());
}

async function onContactMessage(ctx) {
  clearState(ctx);
  try {
    const fName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `📨 *YANGI MUROJAAT!*\n\n👤 [${fName}](tg://user?id=${ctx.from.id})\n🆔 \`${ctx.from.id}\`\n\n💬 ${ctx.message.text}`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Javob berish', `reply_${ctx.from.id}`)]]) }
    );
    await ctx.reply('✅ Xabaringiz adminga yuborildi!', backToMainKb());
  } catch { await ctx.reply('❌ Xatolik yuz berdi.', backToMainKb()); }
}


// ─── REGISTER ────────────────────────────────────────────────
function register(bot) {
  bot.command('admin', cmdAdmin);

  // FIX #1: adminGuard() wrapper bilan barcha admin callbacklar himoyalandi.
  bot.action('admin_panel_main',          adminGuard(cbAdminPanelMain));
  bot.action('admin_cancel',              adminGuard(cbAdminCancel));
  bot.action(/^admin_users_page_/,        adminGuard(cbAdminUsersList));
  bot.action('admin_search_user',         adminGuard(cbAdminSearchUser));   // YANGI
  bot.action('admin_stats',               adminGuard(cbAdminStats));        // YANGI
  bot.action('admin_broadcast',           adminGuard(cbAdminBroadcast));
  bot.action('admin_broadcast_confirm',   adminGuard(cbBroadcastConfirm));  // YANGI
  bot.action(/^reply_/,                   adminGuard(cbReplyStart));
  bot.action('admin_add_test',            adminGuard(cbAdminAddTest));
  bot.action(/^adm_subj_/,               adminGuard(cbAdmSubj));
  bot.action(/^adm_fmt_/,                adminGuard(cbAdmFmt));
  bot.action(/^adm_switch_/,             adminGuard(cbAdmSwitchFmt));
  bot.action('adm_preview',              adminGuard(cbAdmPreview));
  bot.action('adm_reset',                adminGuard(cbAdmReset));
  bot.action('adm_finish',               adminGuard(cbAdmFinish));

  bot.action('contact_admin',  cbContactAdmin);
  bot.action('cancel_contact', cbCancelContact);

  // FIX #4: Sahifa ko'rsatkichi tugmasi uchun no-op handler.
  bot.action('ignore', ctx => ctx.answerCbQuery());
}

module.exports = {
  register,
  onBroadcastMessage, onReplyMessage,
  onAdmTestId, onAdmTextContent, onAdmDocxContent,
  onContactMessage,
  onAdminSearchInput,  // YANGI — dispatcher ga ulanadi
};