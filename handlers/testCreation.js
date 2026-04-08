'use strict';

const fs           = require('fs');
const path         = require('path');
const { Markup }   = require('telegraf');
const statsManager = require('../statsManager');
const {
  States, setState, clearState, updateData, getData, getState,
  safeEdit, safeDelete, backToMainKb,
  progressBar, parseSuffix, parseDocxQuestions, parseTextQuestions,
} = require('../utils');

// ─── Keyboards ───────────────────────────────────────────────
function questionsSummaryKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Yakunlash va Saqlash', 'finish_test_creation')],
    [Markup.button.callback('❌ Bekor qilish', 'cancel_creation')],
  ]);
}

function cancelKb(cb = 'cancel_creation') {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', cb)]]);
}

// ─── Handlers ────────────────────────────────────────────────

async function cbCreateTest(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();

  const tests    = await statsManager.getUserCreatedTests(ctx.from.id);
  const subjects = {};
  for (const t of tests) {
    if (!subjects[t.subject]) subjects[t.subject] = [];
    subjects[t.subject].push(t);
  }

  const buttons = [];
  if (Object.keys(subjects).length > 0) {
    buttons.push([Markup.button.callback('── Mavjud fanlaringiz ──', 'ignore')]);
    for (const [subj, subTests] of Object.entries(subjects)) {
      buttons.push([Markup.button.callback(
        `📁 ${subj}  •  ${subTests.length} ta blok`,
        `ct_exist_${subTests[0].id}`,
      )]);
    }
    buttons.push([Markup.button.callback('➕ Yangi fan yaratish', 'ct_new')]);
  } else {
    buttons.push([Markup.button.callback('➕ Birinchi fanimni yarataman', 'ct_new')]);
  }
  buttons.push([Markup.button.callback('🔙 Asosiy Menyu', 'back_to_main')]);

  await safeEdit(ctx,
    '📝 *Test Yaratish*\n\n' +
    'O\'z testlaringizni yarating va do\'stlaringiz bilan ulashing!\n\n' +
    '📌 *Qo\'llanma:*\n' +
    '1️⃣ Fan tanlang yoki yangi fan yarating\n' +
    '2️⃣ Blok nomi bering\n' +
    '3️⃣ Savollarni yuboring\n' +
    '4️⃣ Havolani do\'stlaringizga yuboring\n\n' +
    '👇 Boshlash uchun quyidan tanlang:',
    Markup.inlineKeyboard(buttons),
  );
}

async function cbCtNew(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.CREATE_SUBJECT);
  await safeEdit(ctx,
    '📝 *Yangi Fan — 1-qadam*\n\n' +
    'Fan nomini kiriting:\n' +
    '_Masalan: Anatomiya, Fizika 1-kurs, Tarix_\n\n' +
    '⌨️ Quyiga yozing:',
    cancelKb(),
  );
}

async function cbCtExist(ctx) {
  await ctx.answerCbQuery();
  const refId    = parseSuffix(ctx.callbackQuery.data, 'ct_exist_');
  const testData = await statsManager.getUserTest(refId);
  if (!testData) return ctx.answerCbQuery('❌ Fan topilmadi!', { show_alert: true });

  await updateData(ctx, { subject: testData.subject });
  setState(ctx, States.CREATE_NAME);
  await safeEdit(ctx,
    `✅ Fan tanlandi: *${testData.subject}*\n\n` +
    `📝 *Yangi Blok — 2-qadam*\n\n` +
    `Yangi blok nomini yozing:\n` +
    `_Masalan: 1-Mavzu, 5-Bob, Yakuniy imtihon_\n\n` +
    `⌨️ Quyiga yozing:`,
    cancelKb(),
  );
}

async function onSubjectInput(ctx) {
  const subject = (ctx.message.text || '').trim();
  if (subject.length < 2) return ctx.reply('⚠️ Fan nomi kamida 2 ta harfdan iborat bo\'lishi kerak.\nQaytadan kiriting:');
  if (subject.length > 50) return ctx.reply(`⚠️ Fan nomi 50 ta belgidan oshmasligi kerak.\nHozir: ${subject.length} ta belgi. Qisqartiring:`);

  await updateData(ctx, { subject });
  setState(ctx, States.CREATE_NAME);
  await ctx.reply(
    `✅ Fan: *${subject}*\n\n` +
    `📝 *2-qadam: Blok nomi*\n\n` +
    `Birinchi blok nomini yozing:\n` +
    `_Masalan: 1-Mavzu, 1-Blok, Kirish_\n\n` +
    `⌨️ Quyiga yozing:`,
    { parse_mode: 'Markdown', ...cancelKb() },
  );
}

async function onNameInput(ctx) {
  const name = (ctx.message.text || '').trim();
  if (!name) return ctx.reply('⚠️ Blok nomini kiriting:');
  if (name.length > 60) return ctx.reply(`⚠️ Blok nomi 60 ta belgidan oshmasligi kerak.\nHozir: ${name.length} ta belgi. Qisqartiring:`);

  await updateData(ctx, { block_name: name });
  setState(ctx, States.CREATE_FORMAT);
  await ctx.reply(
    `✅ Blok nomi: *${name}*\n\n` +
    `📝 *3-qadam: Format tanlang*\n\n` +
    `📊 *Quiz* — Telegram viktorina (eng qulay)\n` +
    `📝 *Matn* — Oddiy matn ko\'rinishida\n` +
    `📄 *Word* — .docx fayl yuklang\n\n` +
    `⬇️ Formatni tanlang:`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 Telegram Quiz', 'fmt_quiz')],
        [Markup.button.callback('📝 Matn ko\'rinishida', 'fmt_text')],
        [Markup.button.callback('📄 Word fayl (.docx)', 'fmt_docx')],
        [Markup.button.callback('❌ Bekor qilish', 'cancel_creation')],
      ]),
    },
  );
}

const FORMAT_INSTRUCTIONS = {
  quiz: '📊 *Quiz Formati*\n\nTelegram\'ning *Quiz* funksiyasidan foydalaning:\n\n1️⃣ 📎 belgisini bosing\n2️⃣ *Poll* → *Quiz* tanlang\n3️⃣ Savol va javoblarni kiriting\n4️⃣ To\'g\'ri javobni belgilang\n5️⃣ Yuboring\n\n✅ Tugagach *Yakunlash* tugmasini bosing.',
  text: '📝 *Matn Formati*\n\nQuyidagi ko\'rinishda yuboring:\n\n```\nO\'zbekiston poytaxti?\n#Toshkent\nSamarqand\nBuxoro\nNamangan\n```\n\n📌 *Qoidalar:*\n• To\'g\'ri javob oldiga `#` qo\'ying\n• Savollar orasida bo\'sh qator bo\'lsin\n• Bir xabarda bir nechta savol mumkin\n\n✅ Tugagach *Yakunlash* tugmasini bosing.',
  docx: '📄 *Word (.docx) Formati*\n\nFaylni quyidagicha tayyorlang:\n\n```\nSavol matni?\n#To\'g\'ri javob\nXato javob\nXato javob\n```\n\n📌 *Qoidalar:*\n• To\'g\'ri javob oldiga `#` qo\'ying\n• Savollar orasida 1 ta bo\'sh qator\n• Bir nechta fayl ketma-ket mumkin\n\n✅ Tugagach *Yakunlash* tugmasini bosing.',
};

async function cbFmt(ctx) {
  await ctx.answerCbQuery();
  const fmt = parseSuffix(ctx.callbackQuery.data, 'fmt_');
  await updateData(ctx, { format: fmt, questions: [] });
  setState(ctx, States.CREATE_QUESTIONS);
  await safeEdit(ctx, FORMAT_INSTRUCTIONS[fmt], questionsSummaryKb());
}

async function onDocxFile(ctx) {
  const data = await getData(ctx);
  if (data.format !== 'docx') {
    return ctx.reply('⚠️ Hozir *matn* yoki *quiz* formati tanlangan.\nWord fayl yuborish uchun formatni o\'zgartiring.', { parse_mode: 'Markdown' });
  }
  const doc = ctx.message.document;
  if (!doc || !doc.file_name.endsWith('.docx')) {
    return ctx.reply('⚠️ Faqat `.docx` fayl qabul qilinadi.');
  }

  const status   = await ctx.reply('⏳ Fayl o\'qilmoqda...');
  const filePath = path.join(require('os').tmpdir(), `ugc_${ctx.from.id}_${Date.now()}.docx`);
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const https = require('https');
    const http  = require('http');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      const req  = link.href.startsWith('https') ? https : http;
      req.get(link.href, res => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); })
         .on('error', reject);
    });

    const newQs = await parseDocxQuestions(filePath);
    if (!newQs.length) {
      return ctx.telegram.editMessageText(
        ctx.chat.id, status.message_id, undefined,
        '❌ Fayldan savol topilmadi!\n\nFayl tuzilishini tekshiring:\n```\nSavol matni\n#To\'g\'ri javob\nXato javob\n```\n_Savollar orasida bo\'sh qator bo\'lsin._',
        { parse_mode: 'Markdown' },
      );
    }

    const questions = [...(data.questions || []), ...newQs];
    await updateData(ctx, { questions });
    const bar = progressBar(Math.min(questions.length, 50), 50);
    await ctx.telegram.editMessageText(
      ctx.chat.id, status.message_id, undefined,
      `✅ *Fayl o\'qildi!*\n\n📊 Bu fayldan: *${newQs.length} ta* savol\n📊 Jami: *${questions.length} ta* savol\n${bar}\n\nYana fayl yuborishingiz yoki yakunlashingiz mumkin.`,
      { parse_mode: 'Markdown', ...questionsSummaryKb() },
    );
  } catch (e) {
    console.error('UGC docx error:', e.message);
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined,
      '❌ Faylni o\'qishda xatolik yuz berdi.\nFayl buzilgan bo\'lishi mumkin. Qayta urinib ko\'ring.');
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

async function onQuestionMessage(ctx) {
  const data      = await getData(ctx);
  const questions = [...(data.questions || [])];
  const fmt       = data.format;

  if (fmt === 'quiz') {
    const poll = ctx.message.poll;
    if (!poll || poll.type !== 'quiz') {
      return ctx.reply('⚠️ Telegram *Quiz* yuboring!\n\n📎 → Poll → Quiz turini tanlang.', { parse_mode: 'Markdown' });
    }
    questions.push({
      question:      poll.question,
      options:       poll.options.map(o => o.text),
      correct_index: poll.correct_option_id,
    });
  } else if (fmt === 'text') {
    if (!ctx.message.text) return ctx.reply('⚠️ Matn ko\'rinishida savollar yuboring.');
    const added = parseTextQuestions(ctx.message.text);
    if (!added.length) {
      return ctx.reply(
        '⚠️ Savol topilmadi!\n\nTo\'g\'ri format:\n```\nSavol matni?\n#To\'g\'ri javob\nXato javob 1\nXato javob 2\n```\nTo\'g\'ri javob oldiga `#` qo\'yishni unutmang.',
        { parse_mode: 'Markdown' },
      );
    }
    questions.push(...added);
  } else if (fmt === 'docx') {
    return ctx.reply('⚠️ Word fayl (.docx) formatida `.docx` fayl yuboring.', { parse_mode: 'Markdown' });
  } else {
    return; // Unknown format
  }

  await updateData(ctx, { questions });
  const bar = progressBar(Math.min(questions.length, 50), 50);
  await ctx.reply(
    `✅ Qabul qilindi!\n\n📊 Jami savollar: *${questions.length} ta*\n${bar}\n\nDavom etishingiz yoki yakunlashingiz mumkin.`,
    { parse_mode: 'Markdown', ...questionsSummaryKb() },
  );
}

async function cbFinishCreation(ctx) {
  const data      = await getData(ctx);
  const questions = data.questions || [];
  if (!questions.length) {
    return ctx.answerCbQuery('❌ Hech qanday savol yo\'q!\nAvval savol yuboring.', { show_alert: true });
  }
  await ctx.answerCbQuery();

  const testId = await statsManager.saveUserTest(
    ctx.from.id, data.subject, data.block_name, questions,
  );
  if (!testId) return ctx.reply('❌ Saqlashda xatolik yuz berdi.\nQayta urinib ko\'ring.');

  const botInfo   = await ctx.telegram.getMe();
  const linkBlock = `https://t.me/${botInfo.username}?start=t_${testId}`;
  const linkSubj  = `https://t.me/${botInfo.username}?start=s_${testId}`;

  await safeEdit(ctx,
    `🎉 *Blok saqlandi!*\n\n` +
    `📚 Fan: *${data.subject}*\n` +
    `📝 Blok: *${data.block_name}*\n` +
    `🔢 Savollar: *${questions.length} ta*\n\n` +
    `🔗 *Faqat shu blok:*\n\`${linkBlock}\`\n\n` +
    `🔗 *Butun fan:*\n\`${linkSubj}\`\n\n` +
    `_Havolani nusxalab do\'stlaringizga yuboring!_`,
    Markup.inlineKeyboard([
      [Markup.button.callback('➕ Yana blok qo\'shish', 'create_test')],
      [Markup.button.callback('📂 Mening Testlarim', 'my_tests')],
      [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
    ]),
  );
  clearState(ctx);
}

async function cbCancelCreation(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  await safeEdit(ctx, '❌ Test yaratish bekor qilindi.',
    backToMainKb([[Markup.button.callback('📝 Qayta yaratish', 'create_test')]]),
  );
}

// ─── Mening Testlarim ────────────────────────────────────────

async function cbMyTests(ctx) {
  await ctx.answerCbQuery();
  const tests = await statsManager.getUserCreatedTests(ctx.from.id);

  if (!tests.length) {
    return safeEdit(ctx,
      '📂 *Mening Testlarim*\n\nSiz hali test yaratmagansiz.\n\nTest yaratish uchun quyidagi tugmani bosing:',
      Markup.inlineKeyboard([
        [Markup.button.callback('📝 Test Yaratish', 'create_test')],
        [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
      ]),
    );
  }

  const subjects = {};
  for (const t of tests) {
    if (!subjects[t.subject]) subjects[t.subject] = [];
    subjects[t.subject].push(t);
  }
  const totalQ = tests.reduce((s, t) => s + (t.questions?.length || 0), 0);
  const buttons = [];
  for (const [subj, subTests] of Object.entries(subjects)) {
    const qCount = subTests.reduce((s, t) => s + (t.questions?.length || 0), 0);
    buttons.push([Markup.button.callback(
      `📁 ${subj}  •  ${subTests.length} blok, ${qCount} savol`,
      `manage_subj_${subTests[0].id}`,
    )]);
  }
  buttons.push([Markup.button.callback('➕ Yangi fan/blok', 'create_test')]);
  buttons.push([Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]);

  await safeEdit(ctx,
    `📂 *Mening Fanlarim*\n\n` +
    `📊 ${Object.keys(subjects).length} ta fan  •  ${tests.length} ta blok  •  ${totalQ} ta savol\n\n` +
    `Boshqarish uchun fanni tanlang:`,
    Markup.inlineKeyboard(buttons),
  );
}

async function cbManageSubj(ctx) {
  await ctx.answerCbQuery();
  const refId    = parseSuffix(ctx.callbackQuery.data, 'manage_subj_');
  const testData = await statsManager.getUserTest(refId);
  if (!testData) return ctx.answerCbQuery('❌ Topilmadi!', { show_alert: true });

  const tests     = await statsManager.getUserCreatedTests(ctx.from.id);
  const subjTests = tests.filter(t => t.subject === testData.subject);
  const botInfo   = await ctx.telegram.getMe();
  const link      = `https://t.me/${botInfo.username}?start=s_${refId}`;

  const buttons = subjTests.map(t => ([
    Markup.button.callback(
      `📝 ${t.block_name}  •  ${(t.questions || []).length} savol`,
      `manage_test_${t.id}`,
    ),
  ]));
  buttons.push([Markup.button.callback('➕ Bu fanga blok qo\'shish', `ct_exist_${refId}`)]);
  buttons.push([Markup.button.callback('🔙 Mening Testlarimga', 'my_tests')]);

  await safeEdit(ctx,
    `📚 *Fan:* ${testData.subject}\n\n` +
    `🔗 *Fan havolasi:*\n\`${link}\`\n` +
    `_Do\'stlaringiz barcha bloklaringizni ko\'ra oladi_\n\n` +
    `📋 Bloklar:`,
    Markup.inlineKeyboard(buttons),
  );
}

async function cbManageTest(ctx) {
  await ctx.answerCbQuery();
  const testId   = parseSuffix(ctx.callbackQuery.data, 'manage_test_');
  const testData = await statsManager.getUserTest(testId);

  if (!testData || String(testData.creator_id) !== String(ctx.from.id)) {
    return ctx.answerCbQuery('❌ Test topilmadi yoki ruxsat yo\'q!', { show_alert: true });
  }

  const botInfo = await ctx.telegram.getMe();
  const link    = `https://t.me/${botInfo.username}?start=t_${testId}`;
  const qCount  = (testData.questions || []).length;

  await safeEdit(ctx,
    `📝 *Blok Ma\'lumotlari*\n\n` +
    `📚 Fan: ${testData.subject}\n` +
    `🔖 Blok: *${testData.block_name}*\n` +
    `🔢 Savollar: *${qCount} ta*\n` +
    `📅 Yaratilgan: ${String(testData.created_at).slice(0, 10)}\n\n` +
    `🔗 *Blok havolasi:*\n\`${link}\``,
    Markup.inlineKeyboard([
      [Markup.button.callback('▶️ Testni boshlash', `ugc_start_${testId}`)],
      [Markup.button.callback('🗑 Blokni o\'chirish', `delete_test_${testId}`)],
      [Markup.button.callback('🔙 Fanga qaytish', `manage_subj_${testId}`)],
    ]),
  );
}

async function cbDeleteTest(ctx) {
  await ctx.answerCbQuery();
  const testId   = parseSuffix(ctx.callbackQuery.data, 'delete_test_');
  const testData = await statsManager.getUserTest(testId);
  if (!testData) return ctx.answerCbQuery('❌ Test topilmadi!', { show_alert: true });

  await safeEdit(ctx,
    `⚠️ *Ishonchingiz komilmi?*\n\n` +
    `🔖 Blok: *${testData.block_name}*\n` +
    `🔢 ${(testData.questions || []).length} ta savol o\'chib ketadi!\n\n` +
    `⛔ Bu amalni qaytarib bo\'lmaydi!`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ha, o\'chiraman', `confirm_delete_${testId}`)],
      [Markup.button.callback('❌ Bekor qilish', `manage_test_${testId}`)],
    ]),
  );
}

async function cbConfirmDelete(ctx) {
  await ctx.answerCbQuery();
  const testId  = parseSuffix(ctx.callbackQuery.data, 'confirm_delete_');
  const success = await statsManager.deleteUserTest(testId, ctx.from.id);

  if (success) {
    await safeEdit(ctx, '✅ Blok muvaffaqiyatli o\'chirildi.',
      Markup.inlineKeyboard([
        [Markup.button.callback('📂 Mening Testlarim', 'my_tests')],
        [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')],
      ]),
    );
  } else {
    await ctx.answerCbQuery('❌ O\'chirishda xatolik yuz berdi.', { show_alert: true });
  }
}

// ─── Register ────────────────────────────────────────────────
function register(bot) {
  bot.action('create_test',          cbCreateTest);
  bot.action('ct_new',               cbCtNew);
  bot.action(/^ct_exist_/,           cbCtExist);
  bot.action(/^fmt_/,                cbFmt);
  bot.action('finish_test_creation', cbFinishCreation);
  bot.action('cancel_creation',      cbCancelCreation);
  bot.action('my_tests',             cbMyTests);
  bot.action(/^manage_subj_/,        cbManageSubj);
  bot.action(/^manage_test_/,        cbManageTest);
  bot.action(/^delete_test_/,        cbDeleteTest);
  bot.action(/^confirm_delete_/,     cbConfirmDelete);
}

module.exports = {
  register,
  onSubjectInput,
  onNameInput,
  onDocxFile,
  onQuestionMessage,
};