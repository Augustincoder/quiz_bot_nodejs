'use strict';

const fs           = require('fs');
const path         = require('path');
const { Markup }   = require('telegraf');

const dbService = require('../services/dbService');
const {
  States, setState, clearState, updateData, getData, getState,
  safeEdit, safeDelete, backToMainKb,
  progressBar, parseSuffix, parseDocxQuestions, parseTextQuestions,
} = require('../core/utils');

const AI_WARNING_TEXT = `\n\n⚠️ *Eslatma:* _Bu javoblar tezkor AI modellarida tayyorlanmoqda va xatolar ehtimolligi bor. Rasmiy imtihonga tayyorlanayotganlar yoki Pro modellar uchun adminga murojaat qiling:_ @AvazovM`;

// FIX #5: Input uzunligi chegaralari — juda uzun nomlar tugma layoutini buzadi.
const MAX_SUBJECT_LEN = 50;
const MAX_BLOCK_LEN   = 50;

// ─── TUGMALAR GENERATORI ─────────────────────────────────────
function questionsSummaryKb() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👁 Savollarni ko\'rib chiqish', 'preview_q_0')],
    [Markup.button.callback('✅ Yakunlash va Saqlash', 'finish_test_creation')],
    [Markup.button.callback('❌ Bekor qilish', 'cancel_creation')],
  ]);
}

function getDynamicKb(data) {
  if (data.is_editing) {
    return Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Tahrirlash paneliga qaytish', 'back_to_edit_dash')]
    ]);
  }
  return questionsSummaryKb();
}

function cancelKb(cb = 'cancel_creation') {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Bekor qilish', cb)]]);
}

const FORMAT_INSTRUCTIONS = {
  quiz: '📊 *Quiz Formati*\n\nTelegram\'ning *Quiz* funksiyasidan foydalaning:\n1️⃣ 📎 belgisini bosing\n2️⃣ *Poll* → *Quiz* tanlang\n3️⃣ Savol/javob kiriting\n4️⃣ To\'g\'riligini belgilab yuboring',
  text: '📝 *Matn Formati*\n\nQuyidagi ko\'rinishda yuboring:\n```\nO\'zbekiston poytaxti?\n#Toshkent\nSamarqand\nBuxoro\nNamangan\n```',
  docx: '📄 *Word (.docx) Formati*\n\nFaylni quyidagicha tayyorlang:\n```\nSavol matni?\n#To\'g\'ri javob\nXato javob\nXato javob\n```',
};

// ─── TAHRIRLASH DASHBOARD ────────────────────────────────────
async function showEditDashboard(ctx) {
  const data = await getData(ctx);
  const questions = data.questions || [];
  const bar = progressBar(Math.min(questions.length, 50), 50);

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Yangi savol qo\'shish', 'edit_add_q')],
    [Markup.button.callback(`👁/🗑 Savollarni ko'rish va o'chirish`, 'preview_q_0')],
    [Markup.button.callback('✅ O\'zgarishlarni saqlash', 'finish_test_creation')],
    [Markup.button.callback('🔙 Saqlamasdan chiqish', `manage_test_${data.editing_test_id}`)]
  ]);

  await safeEdit(ctx,
    `✏️ *Testni Tahrirlash*\n\n📚 Fan: ${data.subject}\n📝 Blok: ${data.block_name}\n📊 Jami savollar: *${questions.length} ta*\n${bar}\n\nQuyidagi menyudan kerakli amalni tanlang:`,
    { parse_mode: 'Markdown', ...kb }
  );
}

async function cbEditTest(ctx) {
  await ctx.answerCbQuery();
  const testId = parseSuffix(ctx.callbackQuery.data, 'edit_test_');
  const testData = await dbService.getUserTest(testId);

  if (!testData || String(testData.creator_id) !== String(ctx.from.id)) {
    return ctx.answerCbQuery('❌ Ruxsat yo\'q!', { show_alert: true });
  }

  await updateData(ctx, {
    editing_test_id: testId, subject: testData.subject, block_name: testData.block_name,
    questions: testData.questions || [], is_editing: true
  });
  setState(ctx, States.CREATE_QUESTIONS);
  await showEditDashboard(ctx);
}

async function cbBackToEditDash(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.CREATE_QUESTIONS);
  await showEditDashboard(ctx);
}

async function cbEditAddQ(ctx) {
  await ctx.answerCbQuery();
  await safeEdit(ctx,
    `📝 *Yangi savol formatini tanlang:*\n\n⬇️ Qaysi usulda savol qo'shmoqchisiz?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🤖 AI Smart Quiz (Avtomatik)', 'fmt_ai')],
      [Markup.button.callback('📊 Telegram Quiz', 'fmt_quiz')],
      [Markup.button.callback('📝 Matn ko\'rinishida', 'fmt_text')],
      [Markup.button.callback('📄 Word fayl (.docx)', 'fmt_docx')],
      [Markup.button.callback('🔙 Tahrirlash paneliga', 'back_to_edit_dash')]
    ])
  );
}


// ─── 1. YANGI TEST YARATISH BOSQICHLARI ──────────────────────
async function cbCreateTest(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  const tests    = await dbService.getUserCreatedTests(ctx.from.id);
  const subjects = {};
  for (const t of tests) {
    if (!subjects[t.subject]) subjects[t.subject] = [];
    subjects[t.subject].push(t);
  }

  const buttons = [];
  if (Object.keys(subjects).length > 0) {
    // FIX #6: Dekorativ "header" tugma 'ignore' action ga bog'langan edi,
    // lekin handler ro'yxatga olinmagan. Endi callback_data yo'q, faqat matn.
    // Telegraf da "header" uchun to'g'ri yo'l — uni `ignore` ga bog'lash va
    // register da uni ro'yxatdan o'tkazish (pastda register ga qo'shildi).
    buttons.push([Markup.button.callback('── Mavjud fanlaringiz ──', 'ignore')]);
    for (const [subj, subTests] of Object.entries(subjects)) {
      buttons.push([Markup.button.callback(`📁 ${subj}  •  ${subTests.length} ta blok`, `ct_exist_${subTests[0].id}`)]);
    }
    buttons.push([Markup.button.callback('➕ Yangi fan yaratish', 'ct_new')]);
  } else {
    buttons.push([Markup.button.callback('➕ Birinchi fanimni yarataman', 'ct_new')]);
  }
  buttons.push([Markup.button.callback('🔙 Asosiy Menyu', 'back_to_main')]);

  await safeEdit(ctx, '📝 *Test Yaratish*\n\nO\'z testlaringizni yarating va do\'stlaringiz bilan ulashing!', Markup.inlineKeyboard(buttons));
}

async function cbCtNew(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.CREATE_SUBJECT);
  await safeEdit(ctx, '📝 *Yangi Fan — 1-qadam*\n\nFan nomini kiriting (Masalan: Anatomiya):', cancelKb());
}

async function cbCtExist(ctx) {
  await ctx.answerCbQuery();
  const refId    = parseSuffix(ctx.callbackQuery.data, 'ct_exist_');
  const testData = await dbService.getUserTest(refId);
  if (!testData) return;
  await updateData(ctx, { subject: testData.subject });
  setState(ctx, States.CREATE_NAME);
  await safeEdit(ctx, `✅ Fan: *${testData.subject}*\n\n📝 *Yangi Blok — 2-qadam*\n\nBlok nomini yozing (Masalan: 1-Mavzu):`, cancelKb());
}

async function onSubjectInput(ctx) {
  const subject = (ctx.message.text || '').trim();
  if (subject.length < 2) return ctx.reply('⚠️ Fan nomi kamida 2 ta harf bo\'lishi kerak:');
  // FIX #5: Maksimal uzunlik tekshiruvi qo'shildi.
  if (subject.length > MAX_SUBJECT_LEN) return ctx.reply(`⚠️ Fan nomi ${MAX_SUBJECT_LEN} ta belgidan oshmasligi kerak:`);
  await updateData(ctx, { subject });
  setState(ctx, States.CREATE_NAME);
  await ctx.reply(`✅ Fan: *${subject}*\n\n📝 *2-qadam: Blok nomi*\nBlok nomini yozing:`, { parse_mode: 'Markdown', ...cancelKb() });
}

async function onNameInput(ctx) {
  const name = (ctx.message.text || '').trim();
  if (!name) return ctx.reply('⚠️ Blok nomini kiriting:');
  // FIX #5: Maksimal uzunlik tekshiruvi qo'shildi.
  if (name.length > MAX_BLOCK_LEN) return ctx.reply(`⚠️ Blok nomi ${MAX_BLOCK_LEN} ta belgidan oshmasligi kerak:`);
  await updateData(ctx, { block_name: name });
  setState(ctx, States.CREATE_FORMAT);
  await ctx.reply(`✅ Blok nomi: *${name}*\n\n📝 *3-qadam: Format tanlang*`, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🤖 AI Smart Quiz (Avtomatik)', 'fmt_ai')],
      [Markup.button.callback('📊 Telegram Quiz', 'fmt_quiz')],
      [Markup.button.callback('📝 Matn', 'fmt_text')],
      [Markup.button.callback('📄 Word (.docx)', 'fmt_docx')],
      [Markup.button.callback('❌ Bekor qilish', 'cancel_creation')]
    ])
  });
}

async function cbFmt(ctx) {
  await ctx.answerCbQuery();
  const fmt = parseSuffix(ctx.callbackQuery.data, 'fmt_');
  const data = await getData(ctx);

  const patch = { format: fmt };
  if (!data.is_editing && !data.questions) patch.questions = [];
  await updateData(ctx, patch);

  const backBtnAction = data.is_editing ? 'back_to_edit_dash' : 'cancel_creation';
  const backBtnText   = data.is_editing ? '🔙 Orqaga' : '❌ Bekor qilish';

  if (fmt === 'ai') {
    await safeEdit(ctx, `🤖 *AI Smart Quiz*\n\nQaysi rejimdan foydalanasiz?`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📄 Matndan test yasash', 'ai_mode_text')],
        [Markup.button.callback('❓ Savollardan test yasash', 'ai_mode_questions')],
        [Markup.button.callback(backBtnText, backBtnAction)]
      ])
    });
    return;
  }

  setState(ctx, States.CREATE_QUESTIONS);
  await safeEdit(ctx, FORMAT_INSTRUCTIONS[fmt], getDynamicKb(data));
}


// ─── 2. AI VA SAVOL QABUL QILISH MANTIQI ─────────────────────
async function cbAiModeText(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.CREATE_AI_TEXT);
  await safeEdit(ctx, `📄 *Matndan test yasash*\n\nO'quv matnini (konspektni) shu yerga yuboring.` + AI_WARNING_TEXT, { parse_mode: 'Markdown' });
}

async function cbAiModeQuestions(ctx) {
  await ctx.answerCbQuery();
  setState(ctx, States.CREATE_AI_QUESTIONS);
  await safeEdit(ctx, `❓ *Savollardan test yasash*\n\nOchiq savollarni ro'yxat qilib yuboring.` + AI_WARNING_TEXT, { parse_mode: 'Markdown' });
}

async function onAiTextInput(ctx) {
  const text = ctx.message.text;
  if (!text || text.length < 30) return ctx.reply("⚠️ Matn juda qisqa.");
  const msg = await ctx.reply("⏳ *AI matnni tahlil qilmoqda...*", { parse_mode: 'Markdown' });
  const aiService = require('../services/aiService');
  const generatedQuestions = await aiService.generateQuizFromText(text);
  await processAiResult(ctx, msg.message_id, generatedQuestions);
}

async function onAiQuestionsInput(ctx) {
  const text = ctx.message.text;
  if (!text || text.length < 10) return ctx.reply("⚠️ Savollarni kiriting.");
  const msg = await ctx.reply("⏳ *AI javoblar tuzmoqda...*", { parse_mode: 'Markdown' });
  const aiService = require('../services/aiService');
  const generatedQuestions = await aiService.generateOptionsForQuestions(text);
  await processAiResult(ctx, msg.message_id, generatedQuestions);
}

async function processAiResult(ctx, msgId, generatedQuestions) {
  if (!generatedQuestions || !generatedQuestions.length) {
    return ctx.telegram.editMessageText(ctx.chat.id, msgId, undefined, "❌ AI test tuzishda xato qildi.");
  }
  const data = await getData(ctx);
  const questions = [...(data.questions || []), ...generatedQuestions];
  await updateData(ctx, { questions });

  await ctx.telegram.editMessageText(
    ctx.chat.id, msgId, undefined,
    `✅ *Savollar qo'shildi!*\n📊 Jami: *${questions.length} ta*\nYana yuborishingiz yoki menyudan foydalanishingiz mumkin.` + AI_WARNING_TEXT,
    { parse_mode: 'Markdown', ...getDynamicKb(data) }
  );
}

async function onDocxFile(ctx) {
  const data = await getData(ctx);
  const doc = ctx.message.document;
  if (!doc || !doc.file_name.endsWith('.docx')) return ctx.reply('⚠️ Faqat `.docx` fayl yuboring.');

  const status = await ctx.reply('⏳ Fayl o\'qilmoqda...');
  const filePath = path.join(require('os').tmpdir(), `ugc_${ctx.from.id}_${Date.now()}.docx`);
  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const https = require('https'); const http = require('http');
    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(filePath);
      const req = link.href.startsWith('https') ? https : http;
      req.get(link.href, res => { res.pipe(file); file.on('finish', () => { file.close(); resolve(); }); }).on('error', reject);
    });

    const newQs = await parseDocxQuestions(filePath);
    if (!newQs.length) return ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '❌ Fayldan savol topilmadi!');

    const questions = [...(data.questions || []), ...newQs];
    await updateData(ctx, { questions });
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, `✅ *Fayl o'qildi!* (${newQs.length} ta qo'shildi)\n📊 Jami: *${questions.length} ta*`, { parse_mode: 'Markdown', ...getDynamicKb(data) });
  } catch (e) {
    await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, undefined, '❌ Xatolik yuz berdi.');
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

async function onQuestionMessage(ctx) {
  const data = await getData(ctx);
  const questions = [...(data.questions || [])];
  const fmt = data.format;

  if (fmt === 'quiz') {
    const poll = ctx.message.poll;
    if (!poll || poll.type !== 'quiz') return;
    questions.push({ question: poll.question, options: poll.options.map(o => o.text), correct_index: poll.correct_option_id });
  } else if (fmt === 'text') {
    if (!ctx.message.text) return;
    const added = parseTextQuestions(ctx.message.text);
    if (!added.length) return ctx.reply('⚠️ Savol formati xato.');
    questions.push(...added);
  } else return;

  await updateData(ctx, { questions });
  await ctx.reply(`✅ Qabul qilindi! Jami: *${questions.length} ta*`, { parse_mode: 'Markdown', ...getDynamicKb(data) });
}


// ─── 3. KO'RIB CHIQISH (PREVIEW) VA O'CHIRISH ────────────────
async function cbPreviewQuestion(ctx) {
  await ctx.answerCbQuery();
  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, 'preview_q_'), 10);
  const data = await getData(ctx);
  const questions = data.questions || [];

  if (questions.length === 0) {
    return safeEdit(ctx, '⚠️ Hozircha savollar yo\'q!', getDynamicKb(data));
  }

  const validIdx = Math.max(0, Math.min(idx, questions.length - 1));
  const q = questions[validIdx];

  let text = `👁 *Savol* (${validIdx + 1} / ${questions.length})\n\n*${q.question}*\n\n`;
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  q.options.forEach((opt, i) => { text += `${i === q.correct_index ? '✅' : '❌'} *${labels[i]})* ${opt}\n`; });

  const nav = [];
  if (validIdx > 0) nav.push(Markup.button.callback('⬅️ Oldingi', `preview_q_${validIdx - 1}`));
  if (validIdx < questions.length - 1) nav.push(Markup.button.callback('Keyingi ➡️', `preview_q_${validIdx + 1}`));

  await safeEdit(ctx, text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
    nav,
    [Markup.button.callback('🗑 Shu savolni o\'chirish', `del_q_${validIdx}`)],
    [Markup.button.callback('🔙 Orqaga qaytish', 'preview_back')]
  ]) });
}

async function cbDeleteQuestion(ctx) {
  // FIX #7: answerCbQuery har doim birinchi chaqirilishi kerak.
  // Avval faqat idx to'g'ri bo'lganda chaqirilardi — noto'g'ri idx da
  // callback timeout xatosi kelib chiqishi mumkin edi.
  await ctx.answerCbQuery();

  const idx = parseInt(parseSuffix(ctx.callbackQuery.data, 'del_q_'), 10);
  const data = await getData(ctx);
  const questions = data.questions || [];

  if (idx >= 0 && idx < questions.length) {
    questions.splice(idx, 1);
    await updateData(ctx, { questions });
    // answerCbQuery yuqorida chaqirilgani sababli bu yerda yana chaqirmаymiz
  }

  if (questions.length === 0) return cbPreviewBack(ctx);
  ctx.callbackQuery.data = `preview_q_${Math.min(idx, questions.length - 1)}`;
  await cbPreviewQuestion(ctx);
}

async function cbPreviewBack(ctx) {
  await ctx.answerCbQuery();
  const data = await getData(ctx);
  if (data.is_editing) return showEditDashboard(ctx);

  await safeEdit(ctx, `✅ *Holat*\nJami savollar: *${(data.questions||[]).length} ta*`, { parse_mode: 'Markdown', ...questionsSummaryKb() });
}


// ─── 4. YAKUNLASH VA MENYULAR ────────────────────────────────
async function cbFinishCreation(ctx) {
  const data = await getData(ctx);
  const questions = data.questions || [];
  if (!questions.length) return ctx.answerCbQuery('❌ Savollar yo\'q!', { show_alert: true });
  await ctx.answerCbQuery();

  let testId = data.editing_test_id;
  if (testId) {
    await dbService.updateUserTestQuestions(testId, ctx.from.id, questions);
  } else {
    testId = await dbService.saveUserTest(ctx.from.id, data.subject, data.block_name, questions);
  }

  const botInfo = await ctx.telegram.getMe();
  await safeEdit(ctx, `🎉 *Muvaffaqiyatli saqlandi!*\n\n📚 Fan: *${data.subject}*\n📝 Blok: *${data.block_name}*\n🔢 Savollar: *${questions.length} ta*\n\n🔗 *Faqat shu blok:*\n\`https://t.me/${botInfo.username}?start=t_${testId}\`\n🔗 *Butun fan:*\n\`https://t.me/${botInfo.username}?start=s_${testId}\``, Markup.inlineKeyboard([[Markup.button.callback('📂 Mening Testlarim', 'my_tests')], [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]]));
  clearState(ctx);
}

async function cbCancelCreation(ctx) {
  clearState(ctx);
  await ctx.answerCbQuery();
  await safeEdit(ctx, '❌ Bekor qilindi.', backToMainKb());
}

async function cbMyTests(ctx) {
  await ctx.answerCbQuery();
  const tests = await dbService.getUserCreatedTests(ctx.from.id);
  if (!tests.length) return safeEdit(ctx, '📂 *Mening Testlarim*\nSiz hali test yaratmagansiz.', Markup.inlineKeyboard([[Markup.button.callback('📝 Test Yaratish', 'create_test')], [Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]]));

  const subjects = {};
  for (const t of tests) {
    if (!subjects[t.subject]) subjects[t.subject] = [];
    subjects[t.subject].push(t);
  }
  const buttons = [];
  for (const [subj, subTests] of Object.entries(subjects)) {
    buttons.push([Markup.button.callback(`📁 ${subj}  •  ${subTests.length} blok`, `manage_subj_${subTests[0].id}`)]);
  }
  buttons.push([Markup.button.callback('➕ Yangi fan/blok', 'create_test'), Markup.button.callback('🏠 Asosiy Menyu', 'back_to_main')]);
  await safeEdit(ctx, `📂 *Mening Fanlarim*\nFanni tanlang:`, Markup.inlineKeyboard(buttons));
}

async function cbManageSubj(ctx) {
  await ctx.answerCbQuery();
  const refId = parseSuffix(ctx.callbackQuery.data, 'manage_subj_');
  const testData = await dbService.getUserTest(refId);
  if (!testData) return;

  const tests = await dbService.getUserCreatedTests(ctx.from.id);
  const subjTests = tests.filter(t => t.subject === testData.subject);
  const botInfo = await ctx.telegram.getMe();

  const buttons = subjTests.map(t => ([Markup.button.callback(`📝 ${t.block_name}  •  ${(t.questions || []).length} savol`, `manage_test_${t.id}`)]));
  buttons.push([Markup.button.callback('➕ Bu fanga blok qo\'shish', `ct_exist_${refId}`)]);
  buttons.push([Markup.button.callback('🔙 Mening Testlarimga', 'my_tests')]);

  await safeEdit(ctx, `📚 *Fan:* ${testData.subject}\n🔗 *Fan havolasi:*\n\`https://t.me/${botInfo.username}?start=s_${refId}\`\n\n📋 Bloklar:`, Markup.inlineKeyboard(buttons));
}

async function cbManageTest(ctx) {
  await ctx.answerCbQuery();
  const testId = parseSuffix(ctx.callbackQuery.data, 'manage_test_');
  const testData = await dbService.getUserTest(testId);
  if (!testData) return;
  const botInfo = await ctx.telegram.getMe();

  await safeEdit(ctx, `📝 *Blok Ma\'lumotlari*\n📚 Fan: ${testData.subject}\n🔖 Blok: *${testData.block_name}*\n🔢 Savollar: *${(testData.questions || []).length} ta*\n\n🔗 *Havola:*\n\`https://t.me/${botInfo.username}?start=t_${testId}\``, Markup.inlineKeyboard([
    [Markup.button.callback('▶️ Testni boshlash', `ugc_start_${testId}`)],
    [Markup.button.callback('✏️ Tahrirlash', `edit_test_${testId}`)],
    [Markup.button.callback('🗑 Blokni o\'chirish', `delete_test_${testId}`)],
    [Markup.button.callback('🔙 Fanga qaytish', `manage_subj_${testId}`)]
  ]));
}

async function cbDeleteTest(ctx) {
  await ctx.answerCbQuery();
  const testId = parseSuffix(ctx.callbackQuery.data, 'delete_test_');
  await safeEdit(ctx, `⚠️ *Ishonchingiz komilmi?*\n⛔ Bu amalni qaytarib bo'lmaydi!`, Markup.inlineKeyboard([[Markup.button.callback('✅ Ha, o\'chiraman', `confirm_delete_${testId}`)], [Markup.button.callback('❌ Bekor qilish', `manage_test_${testId}`)]]));
}

async function cbConfirmDelete(ctx) {
  await ctx.answerCbQuery();
  const testId = parseSuffix(ctx.callbackQuery.data, 'confirm_delete_');
  await dbService.deleteUserTest(testId, ctx.from.id);
  await safeEdit(ctx, '✅ O\'chirildi.', Markup.inlineKeyboard([[Markup.button.callback('📂 Mening Testlarim', 'my_tests')]]));
}


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

  bot.action(/^edit_test_/,          cbEditTest);
  bot.action('back_to_edit_dash',    cbBackToEditDash);
  bot.action('edit_add_q',           cbEditAddQ);

  bot.action(/^preview_q_/,          cbPreviewQuestion);
  bot.action(/^del_q_/,              cbDeleteQuestion);
  bot.action('preview_back',         cbPreviewBack);

  bot.action('ai_mode_text',         cbAiModeText);
  bot.action('ai_mode_questions',    cbAiModeQuestions);

  // FIX #6: Dekorativ "header" tugma uchun no-op handler ro'yxatdan o'tkazildi.
  // Ro'yxatdan o'tkazilmagan callback_data Telegraf da warning chiqaradi.
  bot.action('ignore',               ctx => ctx.answerCbQuery());
}

module.exports = {
  register, onSubjectInput, onNameInput, onDocxFile, onQuestionMessage,
  onAiTextInput, onAiQuestionsInput
};