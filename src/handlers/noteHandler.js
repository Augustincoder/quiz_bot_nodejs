'use strict';

const db = require('../services/dbService');
const scheduleService = require('../services/scheduleService');
const edupageService = require('../services/edupageService');
const pendingStore = require('../core/pendingStore');
const { escapeHtml, truncateText, safeCallbackData } = require('../core/utils');
const logger = require('../core/logger');

const NOTE_STATE_TTL = 15 * 60 * 1000; // 15 daqiqa

/**
 * Extracts note text or media (photo, document, voice) from message or reply
 */
function extractNoteContentFromMessage(msg, commandName = 'note') {
  if (!msg) return null;

  const targetMsg = msg.reply_to_message || msg;

  let rawText = '';
  if (msg.text) {
    const regex = new RegExp(`^\\/${commandName}(?:@\\w+)?\\s*`, 'i');
    rawText = msg.text.replace(regex, '').trim();
  } else if (msg.caption) {
    const regex = new RegExp(`^\\/${commandName}(?:@\\w+)?\\s*`, 'i');
    rawText = msg.caption.replace(regex, '').trim();
  }

  // If user only sent "/note" replying to another message, extract that replied message's text/caption
  if (!rawText && msg.reply_to_message) {
    rawText = (msg.reply_to_message.text || msg.reply_to_message.caption || '').trim();
  }

  let mediaType = null;
  let mediaFileId = null;

  if (targetMsg.photo && targetMsg.photo.length > 0) {
    mediaType = 'photo';
    mediaFileId = targetMsg.photo[targetMsg.photo.length - 1].file_id;
  } else if (targetMsg.document) {
    mediaType = 'document';
    mediaFileId = targetMsg.document.file_id;
  } else if (targetMsg.voice) {
    mediaType = 'voice';
    mediaFileId = targetMsg.voice.file_id;
  }

  if (!rawText && !mediaFileId) return null;
  return {
    text: rawText || (mediaType ? `📎 ${mediaType.toUpperCase()} biriktirildi` : 'Topshiriq'),
    mediaType,
    mediaFileId,
  };
}

/**
 * Builds compact, <= 64 bytes safe occurrence keyboard for course notes
 */
function buildOccurrencesKeyboard(occurrences, currentLessonTypeCode = null) {
  const buttons = [];

  // Lecture-to-Seminar priority rule:
  // If current class is a lecture, highlight the next seminar/practice as the #1 recommended one-tap option
  const nextPracticeIdx = occurrences.findIndex(o => o.lessonType === 'practice');

  occurrences.forEach((occ, idx) => {
    let typeIcon = '📘';
    if (occ.lessonType === 'practice') typeIcon = '✍️ Amaliyot';
    else if (occ.lessonType === 'lecture') typeIcon = "📖 Ma'ruza";
    else if (occ.lessonType === 'lab') typeIcon = '🔬 Laboratoriya';

    let prefix = typeIcon;
    if (currentLessonTypeCode === 'lecture' && idx === nextPracticeIdx) {
      prefix = '🎯 Keyingi Amaliyotga';
    } else if (idx === 0) {
      prefix = `⏭ Keyingi (${typeIcon})`;
    }

    const label = `${prefix} (${occ.dateDisplay}, ${occ.period}-para)`;
    // Use short compact callback_data <= 64 bytes: `no:${idx}`
    buttons.push([{
      text: label.slice(0, 50),
      callback_data: safeCallbackData(`no:${idx}`),
    }]);
  });

  buttons.push([
    { text: '📚 Boshqa fanni tanlash', callback_data: 'np:subj' },
    { text: '❌ Bekor qilish', callback_data: 'nc:cancel' },
  ]);

  return { inline_keyboard: buttons };
}

/**
 * Renders unique subjects from group schedule using compact <= 64 bytes callback_data
 */
async function renderSubjectSelectionMenu(ctx, subjects, extractedContent, isEdit = false) {
  const buttons = [];
  for (let i = 0; i < subjects.length; i += 2) {
    const row = [];
    const s1 = subjects[i];
    row.push({
      text: `${s1.isToday ? '📍 ' : '📘 '}${s1.name.slice(0, 24)}`,
      callback_data: safeCallbackData(`ns:${i}`),
    });
    if (subjects[i + 1]) {
      const s2 = subjects[i + 1];
      row.push({
        text: `${s2.isToday ? '📍 ' : '📘 '}${s2.name.slice(0, 24)}`,
        callback_data: safeCallbackData(`ns:${i + 1}`),
      });
    }
    buttons.push(row);
  }
  buttons.push([{ text: '❌ Bekor qilish', callback_data: 'nc:cancel' }]);

  const text = (extractedContent
    ? `📝 <b>Topshiriq:</b> <i>${escapeHtml(extractedContent.text.slice(0, 100))}</i>\n\n`
    : '') +
    `📚 <b>Qaysi fan uchun eslatma saqlaymiz?</b>\n<i>(📍 — bugungi jadvalingizda bor fanlar)</i>`;

  const extra = { parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } };
  if (isEdit) {
    return ctx.editMessageText(text, extra).catch(() => {});
  }
  return ctx.reply(text, extra);
}

/**
 * /note and /groupnote main command handler
 */
async function handleNoteCommand(ctx, isGroupShared = false) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const prefs = await db.getUserScheduleSettings(userId);
  const groupName = prefs.group_name;

  if (!groupName) {
    return ctx.reply(
      '⚠️ <b>Guruhingiz hali belgilanmagan!</b>\n\n' +
      'Avval <b>🗓 Dars jadvali</b> bo‘limiga kirib yoki <code>/setclass GURUH</code> orqali o‘z guruhingizni kiriting. Shunda bot hozir qaysi darsda ekaningizni avtomatik aniqlaydi.',
      { parse_mode: 'HTML' }
    );
  }

  const extracted = extractNoteContentFromMessage(ctx.message, isGroupShared ? 'groupnote' : 'note');
  const now = edupageService.getTashkentNow();

  // 1. AUTO-DETECTION: Check if student is currently in an active class (or within 10 minutes after it ended)
  const activeCtx = scheduleService.getActiveOrRecentLessonContext(groupName, now);

  if (activeCtx && activeCtx.baseSubject) {
    // If student is in a lecture, prioritize next practice/seminar
    const preferredLessonType = activeCtx.lessonType === 'lecture' ? 'practice' : 'any';
    const occurrences = scheduleService.getUpcomingSubjectOccurrences(
      groupName,
      activeCtx.baseSubject,
      4,
      now,
      preferredLessonType
    );

    if (occurrences.length > 0) {
      await pendingStore.set(`note_wiz:${userId}`, {
        step: extracted ? 'AWAITING_OCCURRENCE' : 'AWAITING_CONTENT_THEN_OCCURRENCE',
        groupName,
        isGroupShared,
        selectedSubject: activeCtx.baseSubject,
        currentLessonTypeCode: activeCtx.lessonType,
        occurrences,
        content: extracted,
      }, NOTE_STATE_TTL);

      const statusBadge = activeCtx.state === 'IN_PROGRESS'
        ? '🟢 <b>Hozir sizda dars ketmoqda:</b>'
        : '🕒 <b>Hozirgina tugagan dars:</b>';

      const typeLabel = activeCtx.lessonType === 'lecture' ? "Ma'ruza" : (activeCtx.lessonType === 'practice' ? "Amaliyot" : "Dars");

      if (extracted) {
        return ctx.reply(
          `${statusBadge} <b>${escapeHtml(activeCtx.baseSubject)}</b> (${typeLabel})\n` +
          `📝 <b>Vazifa:</b> <i>${escapeHtml(extracted.text.slice(0, 120))}</i>\n\n` +
          `👇 <b>Ushbu topshiriqni shu fanning qaysi darsi oldidan eslatay?</b>`,
          {
            parse_mode: 'HTML',
            reply_markup: buildOccurrencesKeyboard(occurrences, activeCtx.lessonType),
          }
        );
      } else {
        return ctx.reply(
          `${statusBadge} <b>${escapeHtml(activeCtx.baseSubject)}</b> (${typeLabel})\n\n` +
          `✍️ <b>Domla bergan topshiriqni yuboring</b> (matn, doska rasmi, ovozli xabar yoki fayl):\n` +
          `<i>Yoki boshqa fan bo‘lsa, pastdagi tugmani bosing:</i>`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📚 Boshqa fanni tanlash', callback_data: 'np:subj' }],
                [{ text: '❌ Bekor qilish', callback_data: 'nc:cancel' }],
              ],
            },
          }
        );
      }
    }
  }

  // 2. Out of class / Fallback: show subject list prioritizing today's classes
  const subjects = scheduleService.getGroupUniqueSubjectsSorted(groupName, now);
  if (!subjects || subjects.length === 0) {
    return ctx.reply(
      `⚠️ <b>${escapeHtml(groupName)}</b> guruhi jadvalidan fanlar topilmadi.`,
      { parse_mode: 'HTML' }
    );
  }

  const limitedSubjects = subjects.slice(0, 20);
  await pendingStore.set(`note_wiz:${userId}`, {
    step: 'AWAITING_SUBJECT',
    groupName,
    isGroupShared,
    subjects: limitedSubjects,
    content: extracted,
  }, NOTE_STATE_TTL);

  return renderSubjectSelectionMenu(ctx, limitedSubjects, extracted, false);
}

/**
 * Handles /mynotes command to display active pending notes
 */
async function handleMyNotesCommand(ctx) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const prefs = await db.getUserScheduleSettings(userId);
  const activeNotes = await db.getUserActiveNotes(userId, prefs.group_name);

  if (!activeNotes || activeNotes.length === 0) {
    return ctx.reply(
      '📭 <b>Sizda hozircha faol vazifalar yoki eslatmalar yo‘q.</b>\n\n' +
      'Yangi eslatma yaratish uchun <code>/note vazifa matni</code> yoki dars paytida rasmga olib <code>/note</code> deb yuboring.',
      { parse_mode: 'HTML' }
    );
  }

  let text = `📋 <b>Sizning faol dars eslatmalaringiz (${activeNotes.length} ta):</b>\n\n`;
  const buttons = [];

  activeNotes.slice(0, 8).forEach((note, idx) => {
    const scopeIcon = note.is_group_shared ? '👥 Guruh' : '👤 Shaxsiy';
    text += `<b>${idx + 1}. ${escapeHtml(note.subject_name)}</b> (${scopeIcon})\n` +
      `📅 <b>Sana:</b> ${note.target_date} • ${note.target_period}-para\n` +
      `📝 <b>Topshiriq:</b> <i>${escapeHtml((note.note_text || '').slice(0, 80))}</i>\n\n`;

    buttons.push([
      { text: `✅ #${idx + 1} Bajarildi`, callback_data: safeCallbackData(`nd:${note.id}`) },
      { text: `⏳ Keyingi darsga surish`, callback_data: safeCallbackData(`nsz:${note.id}`) },
    ]);
  });

  return ctx.reply(truncateText(text, 3900), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
}

/**
 * Unified callback query router for note interactions
 */
async function handleNoteCallback(ctx) {
  const data = ctx.callbackQuery?.data || '';
  const userId = ctx.from?.id;
  if (!userId) return;

  // 1. Mark completed action: nd:<id> or note_done:<id> or note_done_<id>
  if (data.startsWith('nd:') || data.startsWith('note_done:') || data.startsWith('note_done_')) {
    const noteId = Number(data.replace(/^(?:nd:|note_done:|note_done_)/, ''));
    const note = await db.getNoteById(noteId);
    if (!note) {
      return ctx.answerCbQuery('⚠️ Eslatma topilmadi', { show_alert: true }).catch(() => {});
    }
    const { isAdmin } = require('../core/utils');
    if (note.is_group_shared && String(note.creator_id) !== String(userId) && !isAdmin(userId)) {
      return ctx.answerCbQuery('⚠️ Guruh eslatmasini faqat uni yaratgan sardor yoki admin o‘zgartira oladi!', { show_alert: true }).catch(() => {});
    }
    await ctx.answerCbQuery('✅ Topshiriq bajarildi!').catch(() => {});
    await db.updateNoteStatus(noteId, userId, 'completed');
    return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  }

  // 2. Snooze to next occurrence: nsz:<id> or note_snooze:<id> or note_snooze_<id>
  if (data.startsWith('nsz:') || data.startsWith('note_snooze:') || data.startsWith('note_snooze_')) {
    const noteId = Number(data.replace(/^(?:nsz:|note_snooze:|note_snooze_)/, ''));
    const note = await db.getNoteById(noteId);
    if (!note) {
      return ctx.answerCbQuery('⚠️ Eslatma topilmadi', { show_alert: true }).catch(() => {});
    }
    const { isAdmin } = require('../core/utils');
    if (note.is_group_shared && String(note.creator_id) !== String(userId) && !isAdmin(userId)) {
      return ctx.answerCbQuery('⚠️ Guruh eslatmasini faqat uni yaratgan sardor yoki admin o‘zgartira oladi!', { show_alert: true }).catch(() => {});
    }

    const now = edupageService.getTashkentNow();
    const futureDate = new Date(now.getTime() + 12 * 3600 * 1000);
    const occurrences = scheduleService.getUpcomingSubjectOccurrences(
      note.group_name,
      note.subject_name,
      4,
      futureDate,
      note.target_lesson_type || 'any'
    );

    const nextOcc = occurrences.find(o => note.target_lesson_type === 'any' || o.lessonType === note.target_lesson_type) || occurrences[0];

    if (!nextOcc) {
      return ctx.answerCbQuery('⚠️ Keyingi haftada ushbu dars topilmadi', { show_alert: true }).catch(() => {});
    }

    await db.updateNoteStatus(noteId, null, 'pending', nextOcc.dateIso, nextOcc.period, nextOcc.startTime);
    await ctx.answerCbQuery(`⏳ ${nextOcc.dateDisplay} (${nextOcc.period}-para) ga ko‘chirildi!`, { show_alert: true }).catch(() => {});
    return ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  }

  // 3. Wizard interactions
  const wiz = await pendingStore.get(`note_wiz:${userId}`);
  if (data === 'nc:cancel' || data === 'note_cancel') {
    await pendingStore.del(`note_wiz:${userId}`);
    await ctx.answerCbQuery('Bekor qilindi').catch(() => {});
    return ctx.editMessageText('❌ Eslatma saqlash bekor qilindi.').catch(() => {});
  }

  if (!wiz) {
    return ctx.answerCbQuery('⏳ Sessiya vaqti tugagan. Qaytadan /note yozing.', { show_alert: true }).catch(() => {});
  }

  if (data === 'np:subj' || data === 'note_pick_subj') {
    await ctx.answerCbQuery().catch(() => {});
    const subjects = scheduleService.getGroupUniqueSubjectsSorted(wiz.groupName, edupageService.getTashkentNow()).slice(0, 20);
    wiz.step = 'AWAITING_SUBJECT';
    wiz.subjects = subjects;
    await pendingStore.set(`note_wiz:${userId}`, wiz, NOTE_STATE_TTL);
    return renderSubjectSelectionMenu(ctx, subjects, wiz.content, true);
  }

  // Pick subject by index: ns:<index> or note_subj_<index>
  if (data.startsWith('ns:') || data.startsWith('note_subj_')) {
    await ctx.answerCbQuery().catch(() => {});
    const idx = Number(data.replace(/^(?:ns:|note_subj_)/, ''));
    const picked = wiz.subjects && wiz.subjects[idx];
    if (!picked) return;

    const occurrences = scheduleService.getUpcomingSubjectOccurrences(
      wiz.groupName,
      picked.name,
      4,
      edupageService.getTashkentNow()
    );

    if (occurrences.length === 0) {
      return ctx.editMessageText(
        `⚠️ <b>${escapeHtml(picked.name)}</b> fanidan yaqin 2 hafta ichida dars topilmadi.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    wiz.selectedSubject = picked.name;
    wiz.occurrences = occurrences;

    if (!wiz.content) {
      wiz.step = 'AWAITING_CONTENT_THEN_OCCURRENCE';
      await pendingStore.set(`note_wiz:${userId}`, wiz, NOTE_STATE_TTL);
      return ctx.editMessageText(
        `📘 <b>Fan:</b> ${escapeHtml(picked.name)}\n\n` +
        `✍️ <b>Endi topshiriq matnini (yoki rasm, fayl, ovozli xabar) yuboring:</b>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    wiz.step = 'AWAITING_OCCURRENCE';
    await pendingStore.set(`note_wiz:${userId}`, wiz, NOTE_STATE_TTL);
    return ctx.editMessageText(
      `📘 <b>Fan:</b> ${escapeHtml(picked.name)}\n` +
      `📝 <b>Vazifa:</b> <i>${escapeHtml(wiz.content.text.slice(0, 120))}</i>\n\n` +
      `👇 <b>Qaysi dars oldidan eslatay?</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: buildOccurrencesKeyboard(occurrences, null),
      }
    ).catch(() => {});
  }

  // Pick occurrence: no:<index> or note_occ_<index>
  if (data.startsWith('no:') || data.startsWith('note_occ_')) {
    await ctx.answerCbQuery('✅ Saqlanmoqda...').catch(() => {});
    const occIdx = Number(data.replace(/^(?:no:|note_occ_)/, ''));
    const occ = wiz.occurrences && wiz.occurrences[occIdx];
    if (!occ || !wiz.content) return;

    const saved = await db.createCourseNote({
      creator_id: userId,
      group_name: wiz.groupName,
      is_group_shared: Boolean(wiz.isGroupShared),
      subject_name: wiz.selectedSubject,
      subject_norm: edupageService.normalizeSubjectKey(wiz.selectedSubject).toLowerCase(),
      target_lesson_type: occ.lessonType,
      target_date: occ.dateIso,
      target_period: occ.period,
      target_start_time: occ.startTime,
      note_text: wiz.content.text,
      media_type: wiz.content.mediaType,
      media_file_id: wiz.content.mediaFileId,
      status: 'pending',
    });

    await pendingStore.del(`note_wiz:${userId}`);

    if (!saved) {
      return ctx.editMessageText('❌ Saqlashda xatolik yuz berdi.').catch(() => {});
    }

    const scopeBadge = wiz.isGroupShared
      ? `👥 <b>Butun ${escapeHtml(wiz.groupName)} guruhi uchun</b>`
      : `👤 <b>Shaxsiy eslatma</b>`;

    const typeLabel = occ.lessonType === 'practice' ? "✍️ Amaliyot" : (occ.lessonType === 'lecture' ? "📖 Ma'ruza" : "Dars");

    return ctx.editMessageText(
      `✅ <b>Topshiriq muvaffaqiyatli saqlandi!</b>\n\n` +
      `${scopeBadge}\n` +
      `📘 <b>Fan:</b> ${escapeHtml(wiz.selectedSubject)}\n` +
      `🎯 <b>Dars turi:</b> ${typeLabel}\n` +
      `📅 <b>Sana va vaqt:</b> ${occ.dateDisplay} • ${occ.period}-para (${occ.startTime})\n` +
      `📝 <b>Topshiriq:</b> <i>${escapeHtml(wiz.content.text.slice(0, 200))}</i>\n\n` +
      `🔔 <i>Bot sizga darsdan 1 kun oldin kechqurun (20:00) va dars boshlanishidan 20 daqiqa oldin eslatadi!</i>`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

/**
 * Text and multimedia listener for active note creation wizard
 */
async function handleNoteWizardInput(ctx, next) {
  const userId = ctx.from?.id;
  if (!userId) return next();

  const wiz = await pendingStore.get(`note_wiz:${userId}`);
  if (!wiz) {
    return next();
  }

  const text = (ctx.message?.text || '').trim();
  const isCommand = text.startsWith('/');
  const isMainMenuButton = [
    '📅 Dars jadvali', '🧪 Testlar', '🤖 AI Yordamchi', '👤 Profil', '📊 Statistika',
    '🔍 Guruh qidirish', '🏢 Bo\'sh xonalar', '📚 Rasmiy Testlar', '📝 O\'z Testlarim',
    '🔙 Ortga', '🏠 Asosiy Menyu', '❌ Bekor qilish', '🏠 Bosh menyu'
  ].some(btn => text.includes(btn));

  // Cancel wizard if user sends another bot command or taps main menu button
  if (isCommand || isMainMenuButton) {
    await pendingStore.del(`note_wiz:${userId}`);
    return next();
  }

  if (wiz.step !== 'AWAITING_CONTENT_THEN_OCCURRENCE') {
    return next();
  }

  const content = extractNoteContentFromMessage(ctx.message, 'note');
  if (!content) {
    return ctx.reply('⚠️ Iltimos, topshiriq matnini, rasm, ovozli xabar yoki fayl yuboring.');
  }

  wiz.content = content;
  wiz.step = 'AWAITING_OCCURRENCE';
  await pendingStore.set(`note_wiz:${userId}`, wiz, NOTE_STATE_TTL);

  return ctx.reply(
    `📘 <b>Fan:</b> ${escapeHtml(wiz.selectedSubject)}\n` +
    `📝 <b>Vazifa:</b> <i>${escapeHtml(content.text.slice(0, 120))}</i>\n\n` +
    `👇 <b>Ushbu topshiriqni qaysi dars oldidan eslatay?</b>`,
    {
      parse_mode: 'HTML',
      reply_markup: buildOccurrencesKeyboard(wiz.occurrences, wiz.currentLessonTypeCode),
    }
  );
}

module.exports = {
  handleNoteCommand,
  handleMyNotesCommand,
  handleNoteCallback,
  handleNoteWizardInput,
  extractNoteContentFromMessage,
  buildOccurrencesKeyboard,
};
