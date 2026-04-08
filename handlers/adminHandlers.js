'use strict';

const fs           = require('fs');
const path         = require('path');
const { Markup }   = require('telegraf');
const { ADMIN_ID, SUBJECTS } = require('../config');
const statsManager = require('../statsManager');
const { invalidateBlocksCache } = require('../keyboards');
const {
  States, setState, clearState, updateData, getData, getState,
  safeEdit, backToMainKb, progressBar, parseSuffix,
  parseDocxQuestions, parseTextQuestions,
} = require('../utils');

function isAdmin(userId) { return userId === ADMIN_ID; }

// ─── Admin Panel ─────────────────────────────────────────────

async function showAdminPanel(ctx) {
  const users = await statsManager.getAllUsers();
  const text  =
    `👨‍💻 *ADMIN PANEL*\n\n` +
    `👥 Jami foydalanuvchilar: *${users.length} ta*\n\n` +
    `Bo\'limni tanlang:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('📢 Barchaga xabar yuborish', 'admin_broadcast')],
    [Markup.button.callback('👥 Foydalanuvchilar', 'admin_users_page_0')],
    [Markup.button.callback('➕ Rasmiy test qo\'shish', 'admin_add_test')],
    [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
  ]);
  return { text, kb };
}

async function cmdAdmin(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Siz admin emassiz!');
  const { text, kb } = await showAdminPanel(ctx);
  await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
}

async function cbAdminPanelMain(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const { text, kb } = await showAdminPanel(ctx);
  await safeEdit(ctx, text, kb);
}

async function cbAdminCancel(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  const { text, kb } = await showAdminPanel(ctx);
  await safeEdit(ctx, text, kb);
}

// ─── Foydalanuvchilar ro'yxati ────────────────────────────────

async function cbAdminUsersList(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();

  const page    = parseInt(parseSuffix(ctx.callbackQuery.data, 'admin_users_page_'), 10);
  const users   = await statsManager.getAllUsers();
  if (!users.length) return ctx.reply('Foydalanuvchilar yo\'q.');

  const perPage    = 15;
  const totalPages = Math.max(1, Math.ceil(users.length / perPage));
  const p          = Math.max(0, Math.min(page, totalPages - 1));
  const chunk      = users.slice(p * perPage, (p + 1) * perPage);

  const lines = chunk.map((u, i) => {
    const name     = u.full_name || 'Ismsiz';
    const userLink = `[${name}](tg://user?id=${u.telegram_id})`;
    const uname    = u.username && u.username !== "yo'q" ? ` (@${u.username})` : '';
    return `*${p * perPage + i + 1}.* ${userLink}${uname}`;
  });

  const nav = [];
  if (p > 0)            nav.push(Markup.button.callback('⬅️', `admin_users_page_${p - 1}`));
  if (p < totalPages-1) nav.push(Markup.button.callback('➡️', `admin_users_page_${p + 1}`));

  const buttons = [];
  if (nav.length) buttons.push(nav);
  buttons.push([Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]);

  await safeEdit(ctx,
    `👥 *Foydalanuvchilar (${p + 1}/${totalPages}):*\n\n` + lines.join('\n'),
    Markup.inlineKeyboard(buttons),
  );
}

// ─── Broadcast ───────────────────────────────────────────────

async function cbAdminBroadcast(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  setState(ctx, States.ADMIN_BROADCAST);
  await ctx.reply(
    '📢 *Ommaviy xabar*\n\nBarcha foydalanuvchilarga yuboriladigan matnni yozing:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
  );
}

async function onBroadcastMessage(ctx) {
  clearState(ctx);
  const users  = await statsManager.getAllUsers();
  const status = await ctx.reply(`⏳ ${users.length} ta foydalanuvchiga yuborilmoqda...`);

  let ok = 0;
  const BATCH = 25;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    await Promise.all(batch.map(async u => {
      try {
        await ctx.telegram.sendMessage(u.telegram_id, ctx.message.text);
        ok++;
      } catch { /* blocked or inactive */ }
    }));
    await new Promise(r => setTimeout(r, 500)); // throttle
  }

  await ctx.telegram.editMessageText(
    ctx.chat.id, status.message_id, undefined,
    `✅ *Yakunlandi!*\n\n🟢 Yetib bordi: ${ok} ta\n🔴 Bloklaganlar: ${users.length - ok} ta`,
    { parse_mode: 'Markdown' },
  );
}

// ─── Foydalanuvchiga javob ────────────────────────────────────

async function cbReplyStart(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();
  const targetId = parseSuffix(ctx.callbackQuery.data, 'reply_');
  await updateData(ctx, { target_id: targetId });
  setState(ctx, States.ADMIN_REPLY);
  await ctx.reply('✍️ Foydalanuvchiga javobingizni yozing:',
    Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]),
  );
}

async function onReplyMessage(ctx) {
  const data = await getData(ctx);
  clearState(ctx);
  try {
    await ctx.telegram.sendMessage(
      parseInt(data.target_id, 10),
      `📩 *Admin javobi:*\n\n${ctx.message.text}`,
      { parse_mode: 'Markdown' },
    );
    await ctx.reply('✅ Javob yuborildi.');
  } catch {
    await ctx.reply('❌ Foydalanuvchiga xabar yuborib bo\'lmadi.');
  }
}

// ─── Rasmiy test qo'shish ─────────────────────────────────────

function adminControlsKb() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📝 Matn', 'adm_switch_text'),
      Markup.button.callback('📄 Word', 'adm_switch_docx'),
    ],
    [Markup.button.callback('👁 Ko\'rib chiqish', 'adm_preview')],
    [Markup.button.callback('✅ Saqlash', 'adm_finish')],
    [Markup.button.callback('🗑 Tozalash', 'adm_reset')],
    [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
  ]);
}

async function adminPrompt(ctx, fmt, total, edit = false) {
  const fmtLabel = fmt === 'text' ? '📝 Matn' : '📄 Word (.docx)';
  const bar      = progressBar(Math.min(total, 30), 30);
  const hint     = fmt === 'text'
    ? '📝 Matn formatida savollar yuboring:\n```\nSavol?\n#To\'g\'ri javob\nXato 1\nXato 2\n```\n_Savollar orasida bo\'sh qator bo\'lsin._'
    : '📄 Word (.docx) fayl yuboring:\n```\nSavol matni\n#To\'g\'ri javob\nXato javob\n```\n_Savollar orasida bo\'sh qator bo\'lsin._';

  const text =
    `➕ *Rasmiy test qo\'shish*\n\n` +
    `📌 Format: ${fmtLabel}\n` +
    `📊 Yig\'ilgan: *${total} ta savol*\n${bar}\n\n${hint}\n\n` +
    `Format o\'zgartirish, ko\'rish yoki saqlash:`;

  if (edit) {
    await safeEdit(ctx, text, adminControlsKb());
  } else {
    await ctx.reply(text, { parse_mode: 'Markdown', ...adminControlsKb() });
  }
}

async function cbAdminAddTest(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery();

  const buttons = Object.entries(SUBJECTS).map(([k, v]) => [
    Markup.button.callback(v, `adm_subj_${k}`),
  ]);
  buttons.push([Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]);
  await safeEdit(ctx, '📂 *Rasmiy test qo\'shish*\n\nQaysi fanga?', Markup.inlineKeyboard(buttons));
  setState(ctx, States.ADM_CREATE_SUBJECT);
}

async function cbAdmSubj(ctx) {
  await ctx.answerCbQuery();
  const subj   = parseSuffix(ctx.callbackQuery.data, 'adm_subj_');
  const memDb  = require('../bot').memoryDb;
  const existing = Object.keys(memDb[subj] || {});
  const existInfo = existing.length ? `\n📋 Mavjud bloklar: ${existing.join(', ')}` : '';

  await updateData(ctx, { subject: subj });
  setState(ctx, States.ADM_CREATE_TEST_ID);
  await safeEdit(ctx,
    `✅ Fan: *${SUBJECTS[subj] || subj}*\n\n` +
    `🔢 Blok raqamini kiriting:\n_(Agar raqam mavjud bo\'lsa, yangilanadi)_${existInfo}\n\n⌨️ Raqam yozing:`,
    Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]),
  );
}

async function onAdmTestId(ctx) {
  const text = (ctx.message.text || '').trim();
  if (!/^\d+$/.test(text)) return ctx.reply('⚠️ Faqat raqam kiriting (1, 2, 15...):');
  await updateData(ctx, { test_id: parseInt(text, 10) });
  setState(ctx, States.ADM_CREATE_FORMAT);
  await ctx.reply(
    `✅ Blok raqami: *${text}*\n\nSavollarni qaysi formatda yuborasiz?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Matn formatida', 'adm_fmt_text')],
        [Markup.button.callback('📄 Word fayl (.docx)', 'adm_fmt_docx')],
        [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
      ]),
    },
  );
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

  const lines = questions.slice(0, 20).map((q, i) =>
    `*${i + 1}.* ${q.question}\n✅ ${q.options[q.correct_index]}`
  );
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
  if (data.format !== 'text') {
    return ctx.reply('⚠️ Hozir *Word* formati tanlangan.\n📝 Matn tugmasini bosing.', { parse_mode: 'Markdown' });
  }
  const newQs = parseTextQuestions(ctx.message.text);
  if (!newQs.length) {
    return ctx.reply(
      '⚠️ Savol topilmadi!\n\n```\nSavol?\n#To\'g\'ri javob\nXato 1\n```\n`#` belgisini unutmang.',
      { parse_mode: 'Markdown' },
    );
  }
  const questions = [...(data.questions || []), ...newQs];
  await updateData(ctx, { questions });
  await adminPrompt(ctx, 'text', questions.length);
}

async function onAdmDocxContent(ctx) {
  const data = await getData(ctx);
  if (data.format !== 'docx') {
    return ctx.reply('⚠️ Hozir *Matn* formati tanlangan.\n📄 Word tugmasini bosing.', { parse_mode: 'Markdown' });
  }
  const doc = ctx.message.document;
  if (!doc || !doc.file_name.endsWith('.docx')) {
    return ctx.reply('⚠️ Faqat `.docx` fayl qabul qilinadi.');
  }

  const status   = await ctx.reply('⏳ Fayl o\'qilmoqda...');
  const filePath = path.join(require('os').tmpdir(), `admin_${ctx.from.id}_${Date.now()}.docx`);
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const http_ = link.href.startsWith('https') ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      http_.get(link.href, res => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); })
           .on('error', reject);
    });

    const newQs = await parseDocxQuestions(filePath);
    if (!newQs.length) {
      return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
        '❌ Fayldan savol topilmadi.\n\n```\nSavol\n#To\'g\'ri javob\nXato\n```', { parse_mode: 'Markdown' });
    }
    const questions = [...(data.questions || []), ...newQs];
    await updateData(ctx, { questions });
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await adminPrompt(ctx, 'docx', questions.length);
  } catch (e) {
    console.error('Admin docx error:', e.message);
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

  const { subj, test_id } = { subj: data.subject, test_id: data.test_id };
  const success = await statsManager.saveOfficialTest(subj, test_id, questions);
  if (!success) return ctx.answerCbQuery('❌ Supabase\'ga saqlashda xatolik.', { show_alert: true });

  // memory_db yangilash
  const bot = require('../bot');
  if (!bot.memoryDb[subj]) bot.memoryDb[subj] = {};
  bot.memoryDb[subj][test_id] = { test_id, range: `1-${questions.length}`, questions };
  invalidateBlocksCache(subj);

  await safeEdit(ctx,
    `✅ *Rasmiy test saqlandi!*\n\n📚 Fan: *${SUBJECTS[subj] || subj}*\n🔖 Blok: *${test_id}*\n🔢 Savollar: *${questions.length} ta*`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Yana blok', 'admin_add_test')],
      [Markup.button.callback('🔙 Admin panel', 'admin_panel_main')],
    ]),
  );
  clearState(ctx);
}

// ─── Foydalanuvchiga murojaat va javob ───────────────────────

async function cbContactAdmin(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.USER_CONTACT);
  await ctx.reply(
    '💬 *Adminga Murojaat*\n\nSavol yoki taklifingizni yozing:',
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'cancel_contact')]]) },
  );
}

async function cbCancelContact(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  await ctx.reply('❌ Murojaat bekor qilindi.', backToMainKb());
}

async function onContactMessage(ctx) {
  clearState(ctx);
  try {
    const name   = ctx.from.first_name || '';
    const lname  = ctx.from.last_name  || '';
    const fName  = [name, lname].filter(Boolean).join(' ');
    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `📨 *YANGI MUROJAAT!*\n\n👤 [${fName}](tg://user?id=${ctx.from.id})\n🆔 \`${ctx.from.id}\`\n\n💬 ${ctx.message.text}`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Javob berish', `reply_${ctx.from.id}`)]]),
      },
    );
    await ctx.reply('✅ Xabaringiz adminga yuborildi!\nTez orada javob beriladi.', backToMainKb());
  } catch {
    await ctx.reply('❌ Xabar yuborishda xatolik yuz berdi. Qayta urinib ko\'ring.', backToMainKb());
  }
}

// ─── Register ────────────────────────────────────────────────
function register(bot) {
  bot.command('admin', cmdAdmin);
  bot.action('admin_panel_main',    cbAdminPanelMain);
  bot.action('admin_cancel',        cbAdminCancel);
  bot.action(/^admin_users_page_/,  cbAdminUsersList);
  bot.action('admin_broadcast',     cbAdminBroadcast);
  bot.action(/^reply_/,             cbReplyStart);
  bot.action('admin_add_test',      cbAdminAddTest);
  bot.action(/^adm_subj_/,          cbAdmSubj);
  bot.action(/^adm_fmt_/,           cbAdmFmt);
  bot.action(/^adm_switch_/,        cbAdmSwitchFmt);
  bot.action('adm_preview',         cbAdmPreview);
  bot.action('adm_reset',           cbAdmReset);
  bot.action('adm_finish',          cbAdmFinish);
  bot.action('contact_admin',       cbContactAdmin);
  bot.action('cancel_contact',      cbCancelContact);
}

module.exports = {
  register,
  onBroadcastMessage,
  onReplyMessage,
  onAdmTestId,
  onAdmTextContent,
  onAdmDocxContent,
  onContactMessage,
};