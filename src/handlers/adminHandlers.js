'use strict';

const fs   = require('fs');
const path = require('path');
const { Markup } = require('telegraf');

const { ADMIN_ID, SUBJECTS }  = require('../config/config');
const dbService                = require('../services/dbService');
const {
  States, setState, clearState, updateData, getData, getState,
  safeEdit, backToMainKb, progressBar, parseSuffix,
  parseDocxQuestions, parseTextQuestions, escapeHtml, sanitizeForTelegram,
} = require('../core/utils');

const PER_PAGE = 15;

function isAdmin(userId) { return userId === ADMIN_ID; }

function adminGuard(fn) {
  return async (ctx, ...args) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ruxsat yo\'q!', { show_alert: true });
    return fn(ctx, ...args);
  };
}

// ─── PANEL ───────────────────────────────────────────────────

async function buildPanelContent() {
  const users = await dbService.getAllUsers();
  const count = users?.length ?? 0;
  const text  =
    `👨‍💻 <b>ADMIN PANEL</b>\n\n` +
    `👥 Jami foydalanuvchilar: <b>${count} ta</b>\n\n` +
    `Bo'limni tanlang:`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('📢 Barchaga xabar yuborish',    'admin_broadcast')],
    [Markup.button.callback('👥 Foydalanuvchilar',          'admin_users_page_0')],
    [Markup.button.callback('🔍 Foydalanuvchi qidirish',    'admin_search_user')],
    [Markup.button.callback('📊 Umumiy statistika',         'admin_stats')],
    [Markup.button.callback("➕ Rasmiy test qo'shish",      'admin_add_test')],
    [Markup.button.callback('🤖 AI Testlar',                'admin_ai_tests')],
    [Markup.button.callback('🏠 Asosiy Menyu',              'back_to_main')],
  ]);
  return { text, kb };
}

async function cmdAdmin(ctx) {
  if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Siz admin emassiz!');
  const { text, kb } = await buildPanelContent();
  await ctx.reply(text, { parse_mode: 'HTML', ...kb });
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

// ─── USERS LIST ──────────────────────────────────────────────

async function cbAdminUsersList(ctx) {
  await ctx.answerCbQuery();
  const page  = parseInt(parseSuffix(ctx.callbackQuery.data, 'admin_users_page_'), 10) || 0;

  try {
    const users = await dbService.getAllUsers();
    if (!users?.length) return safeEdit(ctx, "👥 Hali foydalanuvchilar yo'q.", backToMainKb());

    const totalPages = Math.max(1, Math.ceil(users.length / PER_PAGE));
    const p          = Math.max(0, Math.min(page, totalPages - 1));
    const chunk      = users.slice(p * PER_PAGE, (p + 1) * PER_PAGE);

    const lines = chunk.map((u, i) => {
      const rawName  = escapeHtml(sanitizeForTelegram((u.full_name || 'Ismsiz').slice(0, 25)));
      const uname    = u.username && u.username !== "yo'q" ? ` @${sanitizeForTelegram(u.username)}` : '';
      return `<b>${p * PER_PAGE + i + 1}.</b> <a href="tg://user?id=${u.telegram_id}">${rawName}</a>${uname}`;
    });

    const nav = [];
    if (p > 0) nav.push(Markup.button.callback('⬅️', `admin_users_page_${p - 1}`));
    nav.push(Markup.button.callback(`${p + 1} / ${totalPages}`, 'ignore'));
    if (p < totalPages - 1) nav.push(Markup.button.callback('➡️', `admin_users_page_${p + 1}`));

    await safeEdit(ctx,
      `👥 <b>Foydalanuvchilar</b> ` +
      `(${p * PER_PAGE + 1}–${Math.min((p + 1) * PER_PAGE, users.length)} / ${users.length}):\n\n` +
      lines.join('\n'),
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([nav, [Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) },
    );
  } catch (e) {
    console.error('cbAdminUsersList error:', e.message);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi.', { show_alert: true });
  }
}

// ─── USER SEARCH ─────────────────────────────────────────────

async function cbAdminSearchUser(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.ADMIN_SEARCH_USER);
  await safeEdit(ctx,
    '🔍 <b>Foydalanuvchi qidirish</b>\n\nTelegram ID yoki @username yuboring:',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
  );
}

async function onAdminSearchInput(ctx) {
  clearState(ctx);
  const query = (ctx.message.text || '').trim().replace('@', '');

  try {
    const users = await dbService.getAllUsers();
    if (!users) return ctx.reply('❌ Foydalanuvchilar topilmadi.');

    const found = users.find(u =>
      String(u.telegram_id) === query ||
      (u.username && u.username.toLowerCase() === query.toLowerCase()),
    );

    if (!found) {
      return ctx.reply(
        `❌ <b>${escapeHtml(query)}</b> — topilmadi.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) },
      );
    }

    const [stats] = await Promise.allSettled([dbService.getUserStats(found.telegram_id)]);
    const history = stats.status === 'fulfilled' ? (stats.value?.history || []) : [];
    const avgScore = history.length
      ? Math.round(history.reduce((s, h) => s + (h.percent || 0), 0) / history.length)
      : 0;

    const safeName  = escapeHtml(sanitizeForTelegram(found.full_name || 'Ismsiz'));
    const uname     = found.username && found.username !== "yo'q" ? `@${sanitizeForTelegram(found.username)}` : '—';
    const classVal  = found.class_name || '—';

    await ctx.reply(
      `👤 <b>Foydalanuvchi:</b> <a href="tg://user?id=${found.telegram_id}">${safeName}</a>\n` +
      `🆔 <code>${found.telegram_id}</code>\n` +
      `📛 Username: ${uname}\n` +
      `🎓 Guruh: ${classVal}\n\n` +
      `📊 <b>Statistika:</b>\n` +
      `📝 Jami testlar: <b>${history.length} ta</b>\n` +
      `🎯 O'rtacha ball: <b>${avgScore}%</b>`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('↩️ Xabar yuborish', `reply_${found.telegram_id}`)],
          [Markup.button.callback('🔙 Admin panel', 'admin_panel_main')],
        ]),
      },
    );
  } catch (e) {
    console.error('onAdminSearchInput error:', e.message);
    await ctx.reply('❌ Qidirishda xatolik yuz berdi.', backToMainKb());
  }
}

// ─── GLOBAL STATS ────────────────────────────────────────────

async function cbAdminStats(ctx) {
  await ctx.answerCbQuery();
  try {
    const users = await dbService.getAllUsers();
    const count = users?.length ?? 0;

    let totalTests = 0, totalCorrect = 0, totalWrong = 0;
    if (users?.length) {
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
      `📊 <b>Umumiy Statistika</b>\n\n` +
      `👥 Foydalanuvchilar: <b>${count} ta</b>\n` +
      `📝 Yechilgan testlar: <b>${totalTests} ta</b>\n` +
      `✅ To'g'ri javoblar: <b>${totalCorrect} ta</b>\n` +
      `❌ Xato javoblar:    <b>${totalWrong} ta</b>\n` +
      `🎯 O'rtacha natija:  <b>${avgGlobal}%</b>\n` +
      `${progressBar(avgGlobal, 100)}`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) },
    );
  } catch (e) {
    console.error('cbAdminStats error:', e.message);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi.', { show_alert: true });
  }
}

// ─── BROADCAST ───────────────────────────────────────────────

async function cbAdminBroadcast(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.ADMIN_BROADCAST);
  await safeEdit(ctx,
    '📢 <b>Ommaviy xabar</b>\n\nBarcha foydalanuvchilarga yuboriladigan matnni yozing:',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
  );
}

async function onBroadcastMessage(ctx) {
  const text = ctx.message?.text;
  if (!text) return;

  try {
    await updateData(ctx, { broadcast_text: text });
    setState(ctx, States.ADMIN_BROADCAST_CONFIRM);

    const users = await dbService.getAllUsers();
    await ctx.reply(
      `📋 <b>Preview</b> — <b>${users?.length ?? 0} ta</b> foydalanuvchiga yuboriladi:\n\n` +
      `───────────────\n${escapeHtml(text)}\n───────────────\n\n` +
      `Tasdiqlaysizmi?`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Tasdiqlash va Yuborish', 'admin_broadcast_confirm')],
          [Markup.button.callback('✏️ Qayta yozish',          'admin_broadcast')],
          [Markup.button.callback('❌ Bekor qilish',          'admin_cancel')],
        ]),
      },
    );
  } catch (e) {
    console.error('onBroadcastMessage error:', e.message);
  }
}

async function cbBroadcastConfirm(ctx) {
  await ctx.answerCbQuery();
  clearState(ctx);

  try {
    const data  = await getData(ctx);
    const text  = data.broadcast_text;
    const users = await dbService.getAllUsers();
    if (!text || !users?.length) return safeEdit(ctx, '❌ Xatolik yuz berdi.', backToMainKb());

    await safeEdit(ctx, `⏳ <b>${users.length} ta foydalanuvchiga yuborilmoqda...</b>`, { parse_mode: 'HTML' });

    let ok = 0;
    const BATCH = 25;
    for (let i = 0; i < users.length; i += BATCH) {
      await Promise.allSettled(users.slice(i, i + BATCH).map(async u => {
        try { await ctx.telegram.sendMessage(u.telegram_id, text); ok++; } catch { /* blocked */ }
      }));
      await new Promise(r => setTimeout(r, 500));
    }

    await safeEdit(ctx,
      `✅ <b>Yakunlandi!</b>\n\n` +
      `🟢 Yetib bordi: <b>${ok} ta</b>\n` +
      `🔴 Bloklaganlar: <b>${users.length - ok} ta</b>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) },
    );
  } catch (e) {
    console.error('cbBroadcastConfirm error:', e.message);
  }
}

// ─── REPLY TO USER ───────────────────────────────────────────

async function cbReplyStart(ctx) {
  await ctx.answerCbQuery();
  // callback data: reply_{userId}  yoki  reply_{userId}_{msgId}
  const parts    = ctx.callbackQuery.data.split('_');
  const targetId = parts[1];
  const msgId    = parts[2] || null;   // contactAdmin dan kelsa msg id ham bor

  await updateData(ctx, { target_id: targetId, target_msg_id: msgId });
  setState(ctx, States.ADMIN_REPLY);
  await ctx.reply(
    '✍️ Foydalanuvchiga javobingizni yuboring.\nMatn, rasm, video yoki ovozli xabar bo\'lishi mumkin.',
    {
      reply_parameters: {
        message_id: ctx.callbackQuery.message.message_id,
        allow_sending_without_reply: true,
      },
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]),
    },
  );
}

async function onReplyMessage(ctx) {
  const data = await getData(ctx);
  clearState(ctx);

  const targetUserId = parseInt(data.target_id, 10);
  const targetMsgId  = data.target_msg_id ? parseInt(data.target_msg_id, 10) : null;

  try {
    // "Admindan javob:" belgisini foydalanuvchining ASAL murojaatiga reply qilib yuboramiz
    await ctx.telegram.sendMessage(targetUserId, `👨‍💻 <b>Admindan javob:</b>`, {
      parse_mode: 'HTML',
      ...(targetMsgId ? {
        reply_parameters: {
          message_id: targetMsgId,
          allow_sending_without_reply: true,
        }
      } : {}),
    });

    // Admin xabarini (matn, media, ovoz — nima bo'lsa) nusxalaymiz
    await ctx.telegram.copyMessage(targetUserId, ctx.chat.id, ctx.message.message_id);

    await ctx.reply('✅ Javob yuborildi.', Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]));
  } catch (e) {
    console.error('onReplyMessage error:', e.message);
    // Fallback: foydalanuvchi asl xabarini o'chirgan bo'lsa
    try {
      await ctx.telegram.copyMessage(targetUserId, ctx.chat.id, ctx.message.message_id);
      await ctx.reply('✅ Javob yuborildi (reply bo\'lmadi — foydalanuvchi asl xabarini o\'chirgan).', Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]));
    } catch {
      await ctx.reply("❌ Foydalanuvchiga xabar yuborib bo'lmadi — botni bloklagan bo'lishi mumkin.", Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]));
    }
  }
}

// ─── TEST CREATION ────────────────────────────────────────────

function adminControlsKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📝 Matn', 'adm_switch_text'), Markup.button.callback('📄 Word', 'adm_switch_docx')],
    [Markup.button.callback("👁 Ko'rib chiqish", 'adm_preview')],
    [Markup.button.callback('✅ Saqlash', 'adm_finish')],
    [Markup.button.callback('🗑 Tozalash', 'adm_reset')],
    [Markup.button.callback('❌ Bekor qilish', 'admin_cancel')],
  ]);
}

async function adminPrompt(ctx, fmt, total, edit = false) {
  const fmtLabel = fmt === 'text' ? '📝 Matn' : '📄 Word (.docx)';
  const bar      = progressBar(Math.min(total, 30), 30);
  const hint     = fmt === 'text' ? '📝 Matn formatida savollar yuboring' : '📄 Word (.docx) fayl yuboring';
  const text     =
    `➕ <b>Rasmiy test qo'shish</b>\n\n` +
    `📌 Format: ${fmtLabel}\n` +
    `📊 Yig'ilgan: <b>${total} ta savol</b>\n` +
    `${bar}\n\n${hint}`;
  if (edit) await safeEdit(ctx, text, { parse_mode: 'HTML', ...adminControlsKb() });
  else await ctx.reply(text, { parse_mode: 'HTML', ...adminControlsKb() });
}

async function cbAdminAddTest(ctx) {
  await ctx.answerCbQuery();
  const buttons = Object.entries(SUBJECTS).map(([k, v]) => [Markup.button.callback(v, `adm_subj_${k}`)]);
  buttons.push([Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]);
  await safeEdit(ctx, "📂 <b>Rasmiy test qo'shish</b>\n\nQaysi fanga?", { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) });
  setState(ctx, States.ADM_CREATE_SUBJECT);
}

async function cbAdmSubj(ctx) {
  await ctx.answerCbQuery();
  const subj = parseSuffix(ctx.callbackQuery.data, 'adm_subj_');
  await updateData(ctx, { subject: subj });
  setState(ctx, States.ADM_CREATE_TEST_ID);
  await safeEdit(ctx,
    `✅ Fan: <b>${escapeHtml(SUBJECTS[subj] || subj)}</b>\n\n🔢 Blok raqamini kiriting:`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', 'admin_cancel')]]) },
  );
}

async function onAdmTestId(ctx) {
  const text = (ctx.message.text || '').trim();
  if (!/^\d+$/.test(text)) return ctx.reply('⚠️ Faqat raqam kiriting (1, 2, 15...):');
  await updateData(ctx, { test_id: parseInt(text, 10) });
  setState(ctx, States.ADM_CREATE_FORMAT);
  await ctx.reply(
    `✅ Blok raqami: <b>${text}</b>\n\nSavollarni qaysi formatda yuborasiz?`,
    {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Matn', 'adm_fmt_text')],
        [Markup.button.callback('📄 Word', 'adm_fmt_docx')],
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
    `<b>${i + 1}.</b> ${escapeHtml(q.question)}\n✅ ${escapeHtml(q.options[q.correct_index])}`,
  );
  let text = `👁 <b>Preview — ${questions.length} ta savol:</b>\n\n` + lines.join('\n\n');
  if (text.length > 4000) text = text.slice(0, 3900) + `\n\n<i>...va yana ${questions.length - 20} ta savol</i>`;
  await ctx.reply(text, { parse_mode: 'HTML' });
}

async function cbAdmReset(ctx) {
  const data = await getData(ctx);
  await updateData(ctx, { questions: [] });
  await ctx.answerCbQuery("✅ Barcha savollar o'chirildi!", { show_alert: true });
  await adminPrompt(ctx, data.format || 'text', 0, true);
}

async function onAdmTextContent(ctx) {
  const data = await getData(ctx);
  if (data.format !== 'text') return ctx.reply('⚠️ Hozir <b>Word</b> formati tanlangan.', { parse_mode: 'HTML' });
  const newQs = parseTextQuestions(ctx.message.text);
  if (!newQs.length) return ctx.reply('⚠️ Savol topilmadi! Format: savol, variantlar, # to\'g\'ri javob.');
  const questions = [...(data.questions || []), ...newQs];
  await updateData(ctx, { questions });
  await adminPrompt(ctx, 'text', questions.length);
}

async function onAdmDocxContent(ctx) {
  const data = await getData(ctx);
  if (data.format !== 'docx') return ctx.reply('⚠️ Hozir <b>Matn</b> formati tanlangan.', { parse_mode: 'HTML' });
  const doc = ctx.message.document;
  if (!doc || !doc.file_name.endsWith('.docx')) return ctx.reply('⚠️ Faqat <code>.docx</code> qabul qilinadi.', { parse_mode: 'HTML' });

  const status   = await ctx.reply('⏳ Fayl o\'qilmoqda...');
  const filePath = path.join(require('os').tmpdir(), `admin_${ctx.from.id}_${Date.now()}.docx`);

  try {
    const link  = await ctx.telegram.getFileLink(doc.file_id);
    const proto = link.href.startsWith('https') ? require('https') : require('http');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      proto.get(link.href, res => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); }).on('error', reject);
    });

    const newQs = await parseDocxQuestions(filePath);
    if (!newQs.length) {
      await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '❌ Fayldan savol topilmadi.');
      return;
    }

    const questions = [...(data.questions || []), ...newQs];
    await updateData(ctx, { questions });
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => {});
    await adminPrompt(ctx, 'docx', questions.length);
  } catch (e) {
    console.error('onAdmDocxContent error:', e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `❌ Xatolik: ${escapeHtml(e.message)}`).catch(() => {});
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

async function cbAdmFinish(ctx) {
  const data      = await getData(ctx);
  const questions = data.questions || [];
  if (!questions.length) return ctx.answerCbQuery('⚠️ Savol yo\'q!', { show_alert: true });
  await ctx.answerCbQuery();

  const subject = data.subject;
  const testId  = data.test_id;

  try {
    const success = await dbService.saveOfficialTest(subject, testId, questions);
    if (!success) return ctx.answerCbQuery("❌ Supabase'ga saqlashda xatolik.", { show_alert: true });

    await safeEdit(ctx,
      `✅ <b>Rasmiy test saqlandi!</b>\n\n` +
      `📚 Fan: <b>${escapeHtml(SUBJECTS[subject] || subject)}</b>\n` +
      `🔖 Blok: <b>${testId}</b>\n` +
      `🔢 Savollar: <b>${questions.length} ta</b>`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Admin panel', 'admin_panel_main')]]) },
    );
    clearState(ctx);
  } catch (e) {
    console.error('cbAdmFinish error:', e.message);
    await ctx.answerCbQuery('❌ Xatolik yuz berdi.', { show_alert: true });
  }
}

// ─── USER → ADMIN CONTACT ─────────────────────────────────────

// Funksiya mantiqi
// async function cbContactAdmin(ctx) {
//   await ctx.answerCbQuery().catch(() => {});
  
//   const text = `👨‍💻 *Adminga Murojaat*

// Bot ishlashida xatolikka duch keldingizmi yoki o'z takliflaringiz bormi? Biz foydalanuvchilarimizning fikrlarini doim qadrlaymiz!

// 👇 *To'g'ridan-to'g'ri admin bilan bog'lanish uchun quyidagi manzilga yozing:*
// @AvazovM

// _Xabaringizni iloji boricha batafsil yozib qoldiring, admin imkon qadar tezroq javob beradi._`;

//   // Eski xabarni o'zgartiramiz
//   const { safeEdit } = require('./src/core/utils'); // Yo'lini o'zingizning papkangizga moslang
//   await safeEdit(ctx, text, {
//     parse_mode: 'Markdown',
//     ...Markup.inlineKeyboard([
//       [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]
//     ])
//   });
// }

async function cbCancelContact(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  await ctx.reply('❌ Murojaat bekor qilindi.', backToMainKb());
}

async function onContactMessage(ctx) {
  clearState(ctx);
  try {
    const fName = escapeHtml(sanitizeForTelegram([ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')));
    await ctx.telegram.sendMessage(
      ADMIN_ID,
      `📨 <b>YANGI MUROJAAT!</b>\n\n` +
      `👤 <a href="tg://user?id=${ctx.from.id}">${fName}</a>\n` +
      `🆔 <code>${ctx.from.id}</code>\n\n` +
      `💬 ${escapeHtml(ctx.message.text)}`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Javob berish', `reply_${ctx.from.id}`)]]),
      },
    );
    await ctx.reply('✅ Xabaringiz adminga yuborildi!', backToMainKb());
  } catch {
    await ctx.reply('❌ Xatolik yuz berdi.', backToMainKb());
  }
}

// ─── REGISTER ────────────────────────────────────────────────

function register(bot) {
  bot.command('admin', cmdAdmin);

  bot.action('admin_panel_main',        adminGuard(cbAdminPanelMain));
  bot.action('admin_cancel',            adminGuard(cbAdminCancel));
  bot.action(/^admin_users_page_/,      adminGuard(cbAdminUsersList));
  bot.action('admin_search_user',       adminGuard(cbAdminSearchUser));
  bot.action('admin_stats',             adminGuard(cbAdminStats));
  bot.action('admin_broadcast',         adminGuard(cbAdminBroadcast));
  bot.action('admin_broadcast_confirm', adminGuard(cbBroadcastConfirm));
  bot.action(/^reply_/,                 adminGuard(cbReplyStart));
  bot.action('admin_add_test',          adminGuard(cbAdminAddTest));
  bot.action(/^adm_subj_/,             adminGuard(cbAdmSubj));
  bot.action(/^adm_fmt_/,              adminGuard(cbAdmFmt));
  bot.action(/^adm_switch_/,           adminGuard(cbAdmSwitchFmt));
  bot.action('adm_preview',            adminGuard(cbAdmPreview));
  bot.action('adm_reset',              adminGuard(cbAdmReset));
  bot.action('adm_finish',             adminGuard(cbAdmFinish));

  // bot.action('contact_admin',  cbContactAdmin);
  bot.action('cancel_contact', cbCancelContact);
  bot.action('ignore', ctx => ctx.answerCbQuery());

  // Wire ADMIN_SEARCH_USER text messages inside register to avoid modifying index.js
  bot.on('message', async (ctx, next) => {
    const state = getState(ctx);
    if (state === States.ADMIN_SEARCH_USER && ctx.message?.text && isAdmin(ctx.from?.id)) {
      return onAdminSearchInput(ctx);
    }
    return next();
  });
}

module.exports = {
  register,
  onBroadcastMessage, onReplyMessage,
  onAdmTestId, onAdmTextContent, onAdmDocxContent,
  onContactMessage, onAdminSearchInput,
};