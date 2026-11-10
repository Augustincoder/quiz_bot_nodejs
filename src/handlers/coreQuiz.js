"use strict";

const { Markup } = require("telegraf");
const mutex = require("../core/mutex");
const { SUBJECTS } = require("../config/config");
const dbService = require("../services/dbService");
const sessionService = require("../services/sessionService");
const logger = require("../core/logger");
const {
  userNameCache,
  safePercent,
  grade,
  progressBar,
  escapeHtml,
  truncateText,
  safeCallbackData,
  TTLMap,
} = require("../core/utils");
const redisConnection = require("../services/redisService");
const { buildShareLink } = require("../services/shareService");
const featureFlagService = require("../services/featureFlagService");

const lastGroupQuizCache = new TTLMap(24 * 3600 * 1000, 500);

async function getLastGroupQuiz(chatId) {
  const cid = String(chatId);
  const mem = lastGroupQuizCache.get(cid);
  if (mem) return mem;
  try {
    const raw = await redisConnection.get(`last_group_quiz:${cid}`);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}


// ─── REDIS-BACKED ACTIVE POLLS VA GROUP CACHE ─────────────────────────────
// Endi server o'chib yonsa ham hech bir guruh reytingi yo'qolmaydi!
const activePollsCache = {
  set: async (pollId, data) => await redisConnection.set(`poll_cache:${pollId}`, JSON.stringify(data), "EX", 600), // 10 daqiqa yashaydi
  get: async (pollId) => {
    const d = await redisConnection.get(`poll_cache:${pollId}`);
    return d ? JSON.parse(d) : null;
  },
  delete: async (pollId) => await redisConnection.del(`poll_cache:${pollId}`)
};

const groupTestCache = {
  set: async (chatId, data) => await redisConnection.set(`group_cache:${chatId}`, JSON.stringify(data), "EX", 3600), // 1 soat yashaydi
  get: async (chatId) => {
    const d = await redisConnection.get(`group_cache:${chatId}`);
    return d ? JSON.parse(d) : null;
  },
  delete: async (chatId) => await redisConnection.del(`group_cache:${chatId}`)
};

async function cancelSessionTimer(session, chatId) {
  try {
    const { quizTimerQueue } = require("../jobs/queues");
    if (!quizTimerQueue) return;
    const jId = session?.timerJobId || (session?.pollId ? `timeout_${chatId}_${session?.qIdx}_${session.pollId}` : `timeout_${chatId}_${session?.qIdx}`);
    await quizTimerQueue.getJob(jId).then(j => j && j.remove()).catch(() => {});
    if (!session?.timerJobId && session?.qIdx !== undefined) {
      quizTimerQueue.getJob(`timeout_${chatId}_${session.qIdx}`).then(j => j && j.remove()).catch(() => {});
      quizTimerQueue.getJob(`timeout:${chatId}:${session.qIdx}`).then(j => j && j.remove()).catch(() => {});
    }
  } catch {}
}
// ─── Redis-backed Mistakes Cache ─────────────────────────────
const lastMistakesCache = {
  set: async (chatId, mistakes) => {
    if (!mistakes || mistakes.length === 0) return;
    await redisConnection.set(
      `mistakes:${chatId}`,
      JSON.stringify(mistakes),
      "EX",
      3600,
    );
  },
  get: async (chatId) => {
    const data = await redisConnection.get(`mistakes:${chatId}`);
    return data ? JSON.parse(data) : [];
  },
  clear: async (chatId) => {
    await redisConnection.del(`mistakes:${chatId}`).catch(() => {});
  },
};

function resolveTestName(tId, blockName) {
  const sid = String(tId);
  if (sid === "mock" || sid.startsWith("mock_")) return "🎲 Aralash Test";
  if (sid === "adaptive" || sid.startsWith("adaptive_")) return "🎯 AI Adaptiv Test";
  if (sid === "retry" || sid.startsWith("retry_")) return "🔄 Xatolar ustida ishlash";
  if (sid.startsWith("ugc_")) return `📝 ${blockName || "Maxsus Test"}`;
  return `${tId}-Blok`;
}

// ─── TUGMALARNI YASASH FUNKSIYASI (YANGILANGAN) ───
async function buildFinishButtons(tId, subjectKey, mistakesCount = 0, session = null) {
  const btns = [];

  // Agar xatolar bo'lsa, 2 ta tugmani ham chiqaramiz
  if (mistakesCount > 0) {
    btns.push([
      Markup.button.callback("❌ Xatolarni ko'rish", "review_mistakes"),
    ]);
    btns.push([
      Markup.button.callback(
        `🔄 Xatolar ustida ishlash (${mistakesCount} ta)`,
        safeCallbackData(`wm_menu_${subjectKey}`, 64),
      ),
    ]);
  }

  const sid = String(tId);
  const isUgcSession = sid.startsWith("ugc_") || Boolean(session?.creatorId) || Boolean(session?.subjectId);
  if (isUgcSession) {
    let subjectId = session?.subjectId;
    if (sid === "retry" || sid.startsWith("retry_")) {
      btns.push([
        Markup.button.callback(
          "🔁 Xatolarni qayta ishlash",
          safeCallbackData(`wm_start_quiz_${subjectKey}`, 64),
        ),
      ]);
      if (subjectId) {
        btns.push([
          Markup.button.callback("📚 Fan bloklari", safeCallbackData(`ugc_subj_${subjectId}`, 64)),
        ]);
      }
      btns.push([Markup.button.callback("📥 Javonga saqlash", "shelf_save_init")]);
      btns.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
      return btns;
    }
    const rawTestId = sid.startsWith("ugc_") ? parseInt(sid.replace("ugc_", ""), 10) : parseInt(sid, 10);
    let nextBlock = null;

    // Agar sessionda subjectId bo'lmasa, testDb dan aniqlaymiz
    if (!subjectId && !isNaN(rawTestId)) {
      try {
        const testDb = await dbService.getUserTest(rawTestId);
        if (testDb?.subject_id) subjectId = testDb.subject_id;
      } catch {}
    }

    if (subjectId) {
      try {
        const blocks = await dbService.getSubjectBlocks(subjectId);
        const curIdx = blocks.findIndex((b) => parseInt(b.id, 10) === rawTestId);
        if (curIdx !== -1 && curIdx + 1 < blocks.length) {
          nextBlock = blocks[curIdx + 1];
        }
      } catch (err) {
        console.error("Error finding next UGC block:", err.message);
      }
    }

    if (nextBlock) {
      btns.push([
        Markup.button.callback(
          `➡️ Keyingi (${nextBlock.block_name})`,
          safeCallbackData(`ugc_start_${nextBlock.id}`, 64),
        ),
      ]);
    }

    if (!isNaN(rawTestId)) {
      btns.push([
        Markup.button.callback(
          "🔁 Qayta ishlash",
          safeCallbackData(`ugc_start_${rawTestId}`, 64),
        ),
      ]);
    }

    if (subjectId) {
      btns.push([
        Markup.button.callback(
          "📚 Fan bloklari",
          safeCallbackData(`ugc_subj_${subjectId}`, 64),
        ),
      ]);
    }

    btns.push([Markup.button.callback("📥 Javonga saqlash", "shelf_save_init")]);
    btns.push([Markup.button.callback("🏠 Asosiy Menyu", "back_to_main")]);
    return btns;
  } else if (sid === "mock" || sid.startsWith("mock_")) {
    btns.push([
      Markup.button.callback("🎲 Yana aralash", safeCallbackData(`mock_${subjectKey}`, 64)),
    ]);
  } else if (sid === "adaptive" || sid.startsWith("adaptive_")) {
    btns.push([
      Markup.button.callback("🎯 Yana adaptiv", safeCallbackData(`adaptive_${subjectKey}`, 64)),
    ]);
  } else if (sid === "retry" || sid.startsWith("retry_")) {
    if (mistakesCount > 0) {
      btns.push([
        Markup.button.callback("🔁 Xatolarni qayta ishlash", safeCallbackData(`wm_start_quiz_${subjectKey}`, 64)),
      ]);
    }
    if (sid.startsWith("retry_")) {
      const originalId = parseInt(sid.replace("retry_", ""), 10);
      if (!isNaN(originalId) && originalId > 0 && originalId < 1000000) {
        const memDb = require("../core/bot").memoryDb || {};
        if ((memDb[subjectKey] || {})[originalId]) {
          btns.push([
            Markup.button.callback(
              `🔁 ${originalId}-Blokni qayta ishlash`,
              safeCallbackData(`post_start_${subjectKey}_${originalId}`, 64),
            ),
          ]);
        }
        if ((memDb[subjectKey] || {})[originalId + 1]) {
          btns.push([
            Markup.button.callback(
              `➡️ Keyingi (${originalId + 1}-Blok)`,
              safeCallbackData(`post_start_${subjectKey}_${originalId + 1}`, 64),
            ),
          ]);
        }
      }
    }
  } else {
    btns.push([
      Markup.button.callback(
        "🔁 Qayta ishlash",
        safeCallbackData(`post_start_${subjectKey}_${tId}`, 64),
      ),
    ]);
    const memDb = require("../core/bot").memoryDb || {};
    if ((memDb[subjectKey] || {})[tId + 1]) {
      btns.push([
        Markup.button.callback(
          `➡️ Keyingi (${tId + 1}-Blok)`,
          safeCallbackData(`post_start_${subjectKey}_${tId + 1}`, 64),
        ),
      ]);
    }
  }

  btns.push([Markup.button.callback("📥 Javonga saqlash", "shelf_save_init")]);
  btns.push([
    Markup.button.callback("🔙 Fan menyusi", safeCallbackData(`post_subj_${subjectKey}`, 64)),
    Markup.button.callback("🏠 Asosiy", "post_main"),
  ]);

  return btns;
}

async function sendNextQuestion(chatId, telegram) {
  let session;
  try {
    session = await sessionService.getActiveTest(chatId);
    if (!session) return;
    if (session.status === "paused" || session.finished) return;
    if (session.qIdx >= session.sessionQuestions.length)
      return finishTest(chatId, telegram);

    session.transitionLock = null;
    session.questionState = "ACTIVE";

    const q = session.sessionQuestions[session.qIdx];
    const progress = `[${session.qIdx + 1}/${session.sessionQuestions.length}]`;
    const labels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

    // Variantlar sonini 2 dan 10 gacha xavfsiz chegaralaymiz
    let options = Array.isArray(q.options) ? [...q.options] : [];
    if (options.length < 2) {
      options = ["A varianti", "B varianti"];
    } else if (options.length > 10) {
      options = options.slice(0, 10);
    }

    let correctIndex = typeof q.correct_index === "number" ? q.correct_index : 0;
    if (correctIndex < 0 || correctIndex >= options.length) {
      correctIndex = 0;
    }
    // Bug #9 fix: Sinxronlash (Poll va savol indeksi 100% mos bo'lishi shart)
    q.options = options;
    q.correct_index = correctIndex;

    const qFull = `${progress} ${q.question || ""}`;
    const needsSplit =
      qFull.length > 255 || options.some((o) => String(o).length > 100);

    let pollQ, pollOpts;
    if (needsSplit) {
      let text =
        `📑 <b>Savol ${progress}</b>\n\n${escapeHtml(q.question || "")}\n\n` +
        options
          .map(
            (opt, i) =>
              `<b>${labels[i] || i + 1})</b> ${escapeHtml(String(opt))}`,
          )
          .join("\n");
      text = truncateText(text, 4000);
      const splitOpts = { parse_mode: "HTML" };
      if (session.messageThreadId) splitOpts.message_thread_id = session.messageThreadId;

      // Retry sendMessage on rate limit (429) or transient network error (BUG-13 fix)
      let sendMsgAttempts = 0;
      while (sendMsgAttempts < 3) {
        sendMsgAttempts++;
        try {
          await telegram.sendMessage(chatId, text, splitOpts);
          break;
        } catch (sErr) {
          const sMsg = String(sErr?.message || '');
          if (sMsg.includes('429') || sErr?.parameters?.retry_after) {
            const wait = Math.min((sErr?.parameters?.retry_after || 1) * 1000, 5000);
            await new Promise((r) => setTimeout(r, wait));
          } else if (/ETIMEDOUT|ECONNRESET|502|503/.test(sMsg)) {
            await new Promise((r) => setTimeout(r, 1000));
          } else {
            break;
          }
        }
      }

      pollQ = `${progress} To'g'ri variantni belgilang:`.slice(0, 300);
      pollOpts = options.map((_, i) => `${labels[i] || i + 1} varianti`);
    } else {
      pollQ = qFull.slice(0, 300);
      pollOpts = options.map((o) => (String(o).trim() || "Variant").slice(0, 100));
    }

    // Unikal variantlar tekshiruvi (BUG-05 fix)
    const seenOpts = new Set();
    pollOpts = pollOpts.map((opt, idx) => {
      let candidate = String(opt).trim() || "Variant";
      if (seenOpts.has(candidate.toLowerCase())) {
        const suffix = ` (${idx + 1})`;
        candidate = candidate.slice(0, 100 - suffix.length) + suffix;
      }
      seenOpts.add(candidate.toLowerCase());
      return candidate.slice(0, 100);
    });
    let msg;
    let sendAttempts = 0;
    const maxSendAttempts = 3;
    let explanationError = false;

    while (sendAttempts < maxSendAttempts) {
      sendAttempts++;
      try {
        const pollExtra = {
          type: "quiz",
          correct_option_id: correctIndex,
          is_anonymous: false,
          open_period: 30,
        };
        if (session.messageThreadId) {
          pollExtra.message_thread_id = session.messageThreadId;
        }
        if (q.explanation && !explanationError) {
          const { safeTruncateExplanation } = require("../core/questionUtils");
          const exp = safeTruncateExplanation(escapeHtml(String(q.explanation).trim()), 200);
          pollExtra.explanation = exp;
          pollExtra.explanation_parse_mode = "HTML";
        }
        msg = await telegram.sendPoll(chatId, pollQ, pollOpts, pollExtra);
        break;
      } catch (e) {
        const errMsg = String(e?.message || '');
        const isTransientNetwork =
          errMsg.includes('ETIMEDOUT') ||
          errMsg.includes('ECONNRESET') ||
          errMsg.includes('ECONNREFUSED') ||
          errMsg.includes('502') ||
          errMsg.includes('503') ||
          errMsg.includes('504');

        // Transient network error -> wait 1s and retry without logging to error stream
        if (isTransientNetwork && sendAttempts < maxSendAttempts) {
          console.warn(`[coreQuiz] Transient network error on sendPoll for ${chatId} (attempt ${sendAttempts}/${maxSendAttempts}): ${errMsg}. Retrying after 1s...`);
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        console.error(`sendPoll error [${chatId}] attempt ${sendAttempts}:`, e.message);

        const migrateTo = e?.parameters?.migrate_to_chat_id || e?.response?.parameters?.migrate_to_chat_id;
        const isFatalChatError =
          errMsg.includes('bot was kicked') ||
          errMsg.includes('not a member') ||
          errMsg.includes('bot was blocked') ||
          errMsg.includes('chat not found') ||
          errMsg.includes('TOPIC_CLOSED') ||
          errMsg.includes('chat write forbidden') ||
          errMsg.includes('group chat was upgraded') ||
          !!migrateTo;

        if (isFatalChatError) {
          console.warn(`[coreQuiz] Fatal chat error detected for chatId ${chatId}: ${errMsg} (migrateTo: ${migrateTo}). Force stopping session.`);
          await sessionService.deleteActiveTest(chatId).catch(() => {});
          await sessionService.deleteWaitingRoom(chatId).catch(() => {});
          if (session?.pollId) {
            await sessionService.deletePollChat(session.pollId).catch(() => {});
          }
          await cancelSessionTimer(session, chatId);
          return;
        }

        // 1. Explanation HTML parsing error -> retry without parse_mode
        if (errMsg.includes("can't parse entities") || errMsg.includes('parse entities')) {
          explanationError = true;
          continue;
        }

        // 2. 429 Too Many Requests -> wait retry_after and retry same question
        const retryAfter = e?.parameters?.retry_after || e?.response?.parameters?.retry_after;
        if (retryAfter || errMsg.includes('429') || errMsg.includes('Too Many Requests')) {
          const waitSec = Number(retryAfter) || 2;
          console.warn(`[coreQuiz] Rate limit (429) on sendPoll for ${chatId}. Waiting ${waitSec}s...`);
          await new Promise(r => setTimeout(r, waitSec * 1000));
          continue;
        }



        session.sendErrors = (session.sendErrors || 0) + 1;
        const errSendOpts = { parse_mode: "HTML" };
        if (session.messageThreadId) errSendOpts.message_thread_id = session.messageThreadId;

        if (session.sendErrors >= 3) {
          session.status = "paused";
          await sessionService.setActiveTest(chatId, session);
          await telegram.sendMessage(
            chatId,
            `⚠️ <b>Texnik xatolik:</b> Telegram savollarni yuborishda muammo yuzaga keldi. Test avtomatik pauza qilindi.\n\nIltimos, birozdan so'ng "▶️ Davom etish" tugmasini bosing.`,
            {
              ...errSendOpts,
              ...Markup.inlineKeyboard([
                [Markup.button.callback("▶️ Davom etish", "pause_resume")],
                [Markup.button.callback("🏁 Yakunlash", "pause_finish")],
              ]),
            }
          ).catch(() => { });
          return;
        }

        // 🛑 UX Flow: Faqat haqiqiy xato savol bo'lsagina o'tkazib yuboramiz
        await telegram.sendMessage(
          chatId,
          `⚠️ <b>Texnik xatolik:</b> Bu savolni Telegram qabul qilmadi. Savol o'tkazib yuborildi.`,
          errSendOpts
        ).catch(() => { });

        // O'tkazib yuborilgan savolni xato (wrong) deb belgilaymiz
        session.wrong++;
        session.mistakes.push({
          question: String(q.question || "Noma'lum savol").substring(0, 100),
          correct_ans: options[correctIndex] || "Noma'lum",
          wrong_ans: "⚠️ Savol yuklanmadi",
          options: options,
          correct_index: correctIndex,
        });
        session.qIdx++;
        await sessionService.setActiveTest(chatId, session);

        // Kaskadli qulashning oldini olish uchun 1 soniya kutamiz
        await new Promise(r => setTimeout(r, 1000));
        return sendNextQuestion(chatId, telegram);
      }
    }
    session.sendErrors = 0;
    session.pollId = msg.poll.id;
    session.msgId = msg.message_id;

    if (session.chatType !== "private") {
      await activePollsCache.set(msg.poll.id, {
        chatId: chatId,
        correct_index: q.correct_index,
        qData: q,
        expectedParticipantsCount: session.expectedParticipantsCount || 0,
        readyUserIds: session.readyUserIds || [],
        autoAdvance: session.autoAdvance !== false,
        sentAt: Date.now(),
      });
      if (!(await groupTestCache.get(chatId))) {
        await groupTestCache.set(chatId, { scores: session.groupScores || {} });
      }
    }

    session.pollId = msg.poll.id;
    session.msgId = msg.message_id;
    session.transitionLock = null;
    session.questionState = "ACTIVE";
    const timerJobId = `timeout_${chatId}_${session.qIdx}_${msg.poll.id}`;
    session.timerJobId = timerJobId;
    await sessionService.setActiveTest(chatId, session);
    await sessionService.setPollChat(msg.poll.id, String(chatId));

    const { quizTimerQueue } = require("../jobs/queues");

    try {
      await quizTimerQueue.add(
        "timeout",
        { chatId, expectedIdx: session.qIdx, pollId: msg.poll.id },
        {
          delay: 31_000,
          jobId: timerJobId,
          removeOnComplete: true,
        },
      );
    } catch (timerErr) {
      console.warn(`[coreQuiz] Failed to schedule timer job for chatId ${chatId}:`, timerErr?.message);
    }
  } catch (e) {
    console.error(`sendNextQuestion fatal [${chatId}]:`, e.message);
    const errMsg = String(e?.message || '');
    const migrateTo = e?.parameters?.migrate_to_chat_id || e?.response?.parameters?.migrate_to_chat_id;
    const isFatalChatError =
      errMsg.includes('bot was kicked') ||
      errMsg.includes('not a member') ||
      errMsg.includes('bot was blocked') ||
      errMsg.includes('chat not found') ||
      errMsg.includes('TOPIC_CLOSED') ||
      errMsg.includes('chat write forbidden') ||
      errMsg.includes('group chat was upgraded') ||
      !!migrateTo;

    if (isFatalChatError) {
      console.warn(`[coreQuiz] Fatal chat error detected for chatId ${chatId}: ${errMsg} (migrateTo: ${migrateTo}). Force stopping session.`);
      await sessionService.deleteActiveTest(chatId).catch(() => {});
      await sessionService.deleteWaitingRoom(chatId).catch(() => {});
      if (session?.pollId) {
        await sessionService.deletePollChat(session.pollId).catch(() => {});
      }
      await cancelSessionTimer(session, chatId);
      return;
    }

    // Kutilmagan boshqa xatoliklarda sessiya qotib qolmasligi uchun pause holatiga o'tkazamiz
    try {
      if (session) {
        session.status = "paused";
        await sessionService.setActiveTest(chatId, session);
        const errOpts = {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard([
            [Markup.button.callback("▶️ Davom etish", "pause_resume")],
            [Markup.button.callback("🏁 Yakunlash", "pause_finish")],
          ]),
        };
        if (session.messageThreadId) errOpts.message_thread_id = session.messageThreadId;
        await telegram.sendMessage(
          chatId,
          `⚠️ <b>Texnik xatolik:</b> Savol yuklashda kutilmagan nosozlik yuz berdi. Test vaqtincha to'xtatildi.\n\n"▶️ Davom etish" orqali davom ettirishingiz yoki "🏁 Yakunlash" ni bosishingiz mumkin.`,
          errOpts
        ).catch(() => {});
      }
    } catch {}
  }
}

// ─── 3D PODIUM, TIE-BREAKER & PERSONAL ANALYSIS ───────────────────
function sortGroupScores(scores) {
  if (!scores) return [];
  const entries = Array.isArray(scores)
    ? scores
    : Object.entries(scores).map(([k, v]) => ({
        userId: v.userId || k,
        ...v,
      }));

  return [...entries].sort((a, b) => {
    const diffCorrect = (b.correct || 0) - (a.correct || 0);
    if (diffCorrect !== 0) return diffCorrect;
    const timeA = typeof a.totalTimeMs === "number" ? a.totalTimeMs : 0;
    const timeB = typeof b.totalTimeMs === "number" ? b.totalTimeMs : 0;
    const diffTime = timeA - timeB;
    if (diffTime !== 0) return diffTime;
    return (
      String(a.name || "").localeCompare(String(b.name || "")) ||
      String(a.userId || "").localeCompare(String(b.userId || ""))
    );
  });
}

function formatPublicPodium(scores) {
  const sortedEntries = sortGroupScores(scores);
  const medals = ["🥇", "🥈", "🥉"];
  const top3 = sortedEntries.slice(0, 3);

  let body = "";
  if (top3.length === 0) {
    body = "😔 Hech kim javob bermadi.";
  } else {
    body = top3
      .map(
        (s, i) =>
          `${medals[i]} <b>${escapeHtml(s.name)}</b>: ${s.correct} to'g'ri, ${s.wrong} xato`
      )
      .join("\n");
    if (sortedEntries.length > 3) {
      body += "\n\n👥 <i>Qolgan ishtirokchilar o'z natijasini quyidagi tugma orqali ko'rishi mumkin:</i>";
    }
  }
  return { body, sortedEntries, top3 };
}

function generateGhostCoachAdvice(userData, session, categories) {
  const correct = userData?.correct || 0;
  const wrong = userData?.wrong || 0;
  const totalAnswered = correct + wrong;
  const pct = totalAnswered > 0 ? Math.round((correct / totalAnswered) * 100) : 0;

  if (totalAnswered === 0) {
    return "🎯 <b>Ghost Coach maslahati:</b> Testda faolroq qatnashib, o'z bilimingizni sinab ko'ring!";
  }

  if (wrong === 0) {
    return "🔥 <b>Ghost Coach maslahati:</b> Benuqson g'alaba! Siz barcha savollarga 100% to'g'ri javob berdingiz. Siz haqiqiy chempionsiz!";
  }

  let weakCategory = null;
  if (Array.isArray(categories) && categories.length > 0) {
    const weakList = [...categories]
      .filter((c) => c.wrong > 0)
      .sort((a, b) => (b.wrong / (b.total || 1)) - (a.wrong / (a.total || 1)));
    if (weakList.length > 0 && weakList[0].name && weakList[0].name !== "Umumiy") {
      weakCategory = weakList[0].name;
    }
  }

  const topicHint = weakCategory
    ? ` Ayniqsa <b>${escapeHtml(weakCategory)}</b> mavzusiga e'tibor qaratishingizni tavsiya qilaman.`
    : "";

  if (pct >= 80) {
    return `🎯 <b>Ghost Coach maslahati:</b> Ajoyib natija! Faqat ${wrong} ta xatolik bo'ldi.${topicHint} Xatolar ustida ishlab, 100% lik marraga osonlikcha erishasiz!`;
  }
  if (pct >= 50) {
    return `🎯 <b>Ghost Coach maslahati:</b> Yaxshi harakat! Biroq ${wrong} ta xato bor.${topicHint} Xatolar ro'yxatini ko'rib chiqing va qayta urinib ko'ring!`;
  }
  return `🎯 <b>Ghost Coach maslahati:</b> Bugungi ${wrong} ta xato — yangi bilim olish uchun ajoyib imkoniyat.${topicHint} Qaytadan tayyorlanib, marrani zabt eting!`;
}

function generatePersonalAnalysis(userId, session) {
  const scores = session?.groupScores || session?.marathonGlobalScores || {};
  const sorted = sortGroupScores(scores);
  const total = sorted.length;
  const userIndex = sorted.findIndex((s) => String(s.userId || s.id) === String(userId));

  const userData = userIndex !== -1 ? sorted[userIndex] : (scores[userId] || {
    userId,
    name: "Talaba",
    correct: 0,
    wrong: 0,
    totalTimeMs: 0,
    mistakes: [],
  });

  const rank = userIndex !== -1 ? userIndex + 1 : total + 1;
  const rankStr = `${rank} / ${total || 1}`;
  const pctRank = total > 0 ? Math.max(1, Math.min(100, Math.round((rank / total) * 100))) : 100;
  const percentile = `Top ${pctRank}%`;

  const correct = userData.correct || 0;
  const wrong = userData.wrong || 0;
  const totalAnswered = correct + wrong;
  const accuracy = totalAnswered > 0 ? Math.round((correct / totalAnswered) * 100) : 0;
  const totalTimeMs = userData.totalTimeMs || 0;
  const timeFormatted = `${(totalTimeMs / 1000).toFixed(1)}s`;

  // Category / topic breakdown
  const categoryStats = {};
  const mistakes = Array.isArray(userData.mistakes) ? userData.mistakes : [];
  const mistakesQuestions = new Set(mistakes.map((m) => m.question).filter(Boolean));

  if (Array.isArray(session?.sessionQuestions) && session.sessionQuestions.length > 0) {
    for (const q of session.sessionQuestions) {
      const cat = q.category || q.topic || session.blockName || session.subjectKey || "Umumiy";
      if (!categoryStats[cat]) {
        categoryStats[cat] = { name: cat, correct: 0, wrong: 0, total: 0 };
      }
      categoryStats[cat].total++;
      if (mistakesQuestions.has(q.question)) {
        categoryStats[cat].wrong++;
      } else {
        categoryStats[cat].correct++;
      }
    }
  } else {
    const cat = session?.blockName || session?.subjectKey || "Umumiy";
    categoryStats[cat] = {
      name: cat,
      correct: correct,
      wrong: wrong,
      total: totalAnswered,
    };
  }

  const categories = Object.values(categoryStats);
  let categoryBreakdownText = "";
  if (categories.length > 0) {
    const lines = categories.map((c) => {
      const cPct = c.total > 0 ? Math.round((c.correct / c.total) * 100) : 0;
      return `• <b>${escapeHtml(c.name)}</b>: ${c.correct}/${c.total} to'g'ri (${cPct}%)`;
    });
    categoryBreakdownText = `📂 <b>Mavzular bo'yicha tahlil:</b>\n${lines.join("\n")}`;
  }

  const ghostCoachAdvice = generateGhostCoachAdvice(userData, session, categories);

  // Mistakes review formatting
  let mistakesText = "";
  if (mistakes.length > 0) {
    const displayMistakes = mistakes.slice(0, 3);
    const mLines = displayMistakes.map((m, idx) => {
      const qText = escapeHtml(truncateText(m.question || "Savol", 80));
      const wText = escapeHtml(truncateText(m.wrong_ans || "Noto'g'ri", 50));
      const cText = escapeHtml(truncateText(m.correct_ans || "To'g'ri", 50));
      return `${idx + 1}. <b>${qText}</b>\n   ❌ Sizning javobingiz: <i>${wText}</i>\n   ✅ To'g'ri javob: <b>${cText}</b>`;
    });
    mistakesText = `❌ <b>Xatoliklar ko'rib chiqishi (${mistakes.length} ta):</b>\n${mLines.join("\n")}`;
    if (mistakes.length > 3) {
      mistakesText += `\n<i>...va yana ${mistakes.length - 3} ta xato</i>`;
    }
  }

  const userName = userData.name || "Talaba";
  const text =
    `📊 <b>Shaxsiy Natijangiz Tahlili (Radar)</b>\n\n` +
    `👤 <b>Qatnashchi:</b> ${escapeHtml(userName)}\n` +
    `🏆 <b>Reytingdagi o'rningiz:</b> <b>${rankStr}</b> (${percentile})\n` +
    `⏱ <b>Javob berish vaqti:</b> ${timeFormatted}\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `✅ To'g'ri javoblar:    <b>${correct} ta</b>\n` +
    `❌ Noto'g'ri javoblar: <b>${wrong} ta</b>\n` +
    `🎯 Aniqlik ko'rsatkichi: <b>${accuracy}%</b>\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    (categoryBreakdownText ? `${categoryBreakdownText}\n\n` : "") +
    `${ghostCoachAdvice}\n\n` +
    (mistakesText ? `${mistakesText}\n\n` : "") +
    `<i>💡 Ushbu tahlil faqat sizga ko'rinadi (ephemeral).</i>`;

  return {
    userId,
    userName,
    rank,
    total,
    rankStr,
    percentile,
    correct,
    wrong,
    totalAnswered,
    accuracy,
    totalTimeMs,
    timeFormatted,
    categories,
    categoryBreakdownText,
    ghostCoachAdvice,
    mistakes,
    mistakesText,
    text: truncateText(text, 4000),
  };
}

async function cbMyGroupQuizResult(ctx, testSession = null) {
  const userId = ctx.from?.id;
  if (!userId) return;

  const chatId = ctx.chat?.id;
  if (!featureFlagService.isFeatureEnabledSync('FEATURE_TOP3_PODIUM', userId, { chatId, isGroup: true })) {
    return ctx.answerCbQuery("ℹ️ Ushbu funksiya hozirda faol emas.", { show_alert: true });
  }

  let session = testSession;
  if (!session && chatId) {
    session = (await sessionService.getActiveTest(chatId)) ||
      (await getLastGroupQuiz(chatId));
  }

  const scores = session?.groupScores || session?.marathonGlobalScores || {};
  const hasParticipated = Object.entries(scores).some(
    ([k, v]) => String(v.userId || k) === String(userId)
  );

  if (!hasParticipated) {
    const toast = "ℹ️ Siz ushbu testda qatnashmagansiz. Keyingi safar sizni ham kutamiz!";
    return ctx.answerCbQuery(toast, { show_alert: true });
  }

  const analysis = generatePersonalAnalysis(userId, session);

  let replyMarkup = undefined;
  try {
    const widgetService = require("../services/widgetService");
    const baseUrl = (process.env.BASE_URL || process.env.APP_URL || "").replace(/\/+$/, "");
    if (baseUrl) {
      const top3Sorted = sortGroupScores(scores).slice(0, 3);
      const token = widgetService.createWidgetToken(userId, "podium", {
        chatId,
        top3: top3Sorted.map((t) => ({
          name: t.name,
          score: t.correct,
          timeFormatted: `${((t.totalTimeMs || 0) / 1000).toFixed(1)}s`,
        })),
        personal: {
          rank: analysis.rank,
          total: analysis.total,
          percentile: analysis.percentile,
          correct: analysis.correct,
          timeFormatted: analysis.timeFormatted,
          advice: analysis.ghostCoachAdvice,
        },
      });
      replyMarkup = {
        inline_keyboard: [
          [
            {
              text: "🏛 3D Radar & Shohsupani ochish",
              web_app: { url: `${baseUrl}/widget/${token}` },
            },
          ],
        ],
      };
    }
  } catch {}

  const sendOptions = {
    parse_mode: "HTML",
    ephemeral_message_parameters: {
      target_user_id: userId,
    },
    ephemeralMessageParameters: {
      userId: userId,
    },
  };
  if (replyMarkup) {
    sendOptions.reply_markup = replyMarkup;
  }

  try {
    if (ctx.telegram?.sendMessage && chatId) {
      await ctx.telegram.sendMessage(chatId, analysis.text, sendOptions);
    } else if (typeof ctx.reply === "function") {
      await ctx.reply(analysis.text, sendOptions);
    }
    await ctx.answerCbQuery().catch(() => {});
  } catch (err) {
    // Fallback: alert popup with summary or direct private message
    const alertSummary = `📊 O'rin: ${analysis.rankStr} (${analysis.percentile}) | ✅ ${analysis.correct} | ❌ ${analysis.wrong}\n\n${analysis.ghostCoachAdvice}`.replace(/<[^>]*>/g, "");
    try {
      await ctx.answerCbQuery(alertSummary.slice(0, 195), { show_alert: true });
    } catch (e2) {
      if (ctx.telegram?.sendMessage) {
        await ctx.telegram.sendMessage(userId, analysis.text, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        }).catch(() => {});
      }
    }
  }
}

// ─── TESTNI YAKUNLASH VA NATIJALARNI HISOBLASH ─────────────────
async function finishTest(chatId, telegram) {
  let isMarathonContinuing = false;
  const unlock = await mutex.lock(`finish:${chatId}`);
  let session;
  try {
    session = await sessionService.getActiveTest(chatId);
    if (!session || session.finished || session.isFinished) return;
    session.finished = true;
    session.isFinished = true;
    session.questionState = "FINISHED";
    await sessionService.setActiveTest(chatId, session);
  } finally {
    unlock();
  }

  await cancelSessionTimer(session, chatId);

  // BUG-07: Agar ochiq poll qolgan bo'lsa (masalan /stop bosilganda), uni yopamiz
  if (session.msgId) {
    await telegram.stopPoll(chatId, session.msgId).catch(() => {});
  }

  await activePollsCache.delete(session.pollId);
  if (session.chatType !== "private") {
    const groupEntry = await groupTestCache.get(chatId);
    if (groupEntry) {
      session.groupScores = groupEntry.scores;
    }
    await groupTestCache.delete(chatId);
  }
  const tId = session.testId;
  const sid = String(tId);
  const tName = resolveTestName(tId, session.blockName);
  const subjName = SUBJECTS[session.subjectKey] || session.subjectKey;
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  const time = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, "0")}:${(elapsed % 60).toString().padStart(2, "0")}`;

  let text;
  let buttons = [];

  try {
    if (session.chatType === "private") {
      // ─── SHAXSIY TEST YAKUNI ───
      // UX FLOW: Xatolar qaysi blokdan ekanligi va oldingi natijani xotiraga yozamiz
      const isUgc = String(tId).startsWith('ugc_') || Boolean(session.creatorId) || Boolean(session.subjectId) || Boolean(session.isUgc);
      await redisConnection.set(`mistakes_meta:${chatId}`, JSON.stringify({
        subjectKey: session.subjectKey,
        testId: tId,
        blockName: tName,
        correct: session.correct,
        wrong: session.wrong,
        isUgc: isUgc,
        subjectId: session.subjectId || null,
      }), "EX", 3600).catch(() => { });

      if (Array.isArray(session.mistakes) && session.mistakes.length > 0) {
        await lastMistakesCache.set(chatId, session.mistakes).catch(() => { });
      } else if (sid === "retry" || sid.startsWith("retry_")) {
        await lastMistakesCache.clear(chatId).catch(() => {});
      }

      const answeredTotal = session.correct + session.wrong;
      const totalQuestions = session.sessionQuestions.length || answeredTotal;
      const skipped = Math.max(0, totalQuestions - answeredTotal);
      const pct = safePercent(session.correct, totalQuestions);

      if (answeredTotal > 0) {
        dbService.updateUserStats(
            chatId,
            session.correct,
            session.wrong + skipped,
            session.subjectKey,
            tId,
            session.mistakes,
          )
          .catch((e) => console.error("Stats update error:", e.message));
      }

      if (session.shelfFolder) {
        dbService.saveTestToShelf(chatId, session.shelfFolder, {
          testId: tId,
          testName: session.blockName || tName,
          subject: session.subjectKey,
          subjectId: session.subjectId || null,
          creatorId: session.creatorId || null,
          isUgc: Boolean(session.isUgc),
          questions: session.sessionQuestions,
          progress: {
            current_index: totalQuestions,
            correct: session.correct || 0,
            mistakes: session.mistakes || [],
          },
        }).catch(() => {});
      }

      // Telemetry
      logger.info("test:finish", {
        chatId,
        subject: session.subjectKey,
        testId: tId,
        correct: session.correct,
        wrong: session.wrong,
        skipped,
        percent: pct,
        elapsed,
      });

      // Dinamik va motivatsion xabarlar
      let funFeedback;
      if (pct === 100) {
        funFeedback = `\n\n🔥 <b>Super-Miya!</b> Siz shunchaki yonayapsiz! 100% to'g'ri javob. Barcha savollarni «chaqib» tashladingiz! 🏆`;
      } else if (pct >= 80) {
        funFeedback = `\n\n😎 <b>Ajoyib natija!</b> Siz deyarli ustoz darajasidasiz. Yana ozgina harakat qilsangiz, 100% lik marra sizniki bo'ladi! 🚀`;
      } else if (pct >= 50) {
        funFeedback = `\n\n👍 <b>Yomon emas, lekin...</b> siz bundan ham zo'riga qodirsiz! O'tkazib yuborilgan «zarbalarni» qayta ishlab chiqamizmi? 🥊\n\n👇 Quyidagi <b>«🔄 Xatolar ustida ishlash»</b> tugmasini bosing.`;
      } else {
        funFeedback = `\n\n😅 <b>Oups...</b> Bugun yulduzlar siz tomonda emas shekilli. Taslim bo'lish yo'q! Xatolarni qayta ishlab, tezda «qasos» oling! ⚔️\n\n👇 Quyidagi <b>«🔄 Xatolar ustida ishlash»</b> tugmasini bosing.`;
      }

      text =
        `🏁 <b>Test Yakunlandi!</b>\n\n` +
        `📚 ${escapeHtml(subjName)} — ${escapeHtml(tName)}\n` +
        `${progressBar(Math.round(pct), 100)}\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `✅ To'g'ri:    <b>${session.correct} ta</b>\n` +
        `❌ Xato:       <b>${session.wrong} ta</b>\n` +
        `⏭ O'tkazildi: <b>${skipped} ta</b>\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `🎯 Natija: <b>${pct}%</b> — ${grade(pct)}\n` +
        `⏱ Vaqt: <b>${time}</b>` +
        funFeedback;

      let saveTestId = tId;
      if (saveTestId === "mock" || saveTestId === "adaptive" || saveTestId === "retry") {
        saveTestId = `${saveTestId}_${Date.now()}`;
      }
      const shelfData = {
        testId: saveTestId,
        testName: tName,
        subject: session.subjectKey,
        questions: session.sessionQuestions || [],
        progress: {
          current_index: session.sessionQuestions.length,
          correct: session.correct || 0,
          mistakes: session.mistakes || [],
        },
      };

      // Redisga 24 soatga (86400 soniya) saqlaymiz! Endi server o'chib yonsa ham yo'qolmaydi.
      await redisConnection
        .set(`shelf_pending:${chatId}`, JSON.stringify(shelfData), "EX", 86400)
        .catch((e) => console.error("Redis shelf save error:", e));

      // 🔴 FIX: ReferenceError ning oldi olindi va to'g'ri hisob-kitob kiritildi
      const mistakesCount = (session.mistakes || []).length;
      buttons = await buildFinishButtons(tId, session.subjectKey, mistakesCount, session);
    } else {
      const groupEntry = await groupTestCache.get(chatId);
      if (groupEntry) {
        session.groupScores = groupEntry.scores;
        await groupTestCache.delete(chatId);
      }

      // Marafon bo'lsa, oraliq natijalarni global reytingga qo'shamiz
      if (session.isMarathon) {
        if (!session.marathonGlobalScores) session.marathonGlobalScores = {};
        for (const [uid, sc] of Object.entries(session.groupScores)) {
          if (!session.marathonGlobalScores[uid]) {
            session.marathonGlobalScores[uid] = {
              userId: uid,
              name: sc.name,
              correct: 0,
              wrong: 0,
              totalTimeMs: 0,
              mistakes: [],
            };
          }
          session.marathonGlobalScores[uid].correct += sc.correct;
          session.marathonGlobalScores[uid].wrong += sc.wrong;
          session.marathonGlobalScores[uid].totalTimeMs =
            (session.marathonGlobalScores[uid].totalTimeMs || 0) + (sc.totalTimeMs || 0);
          if (Array.isArray(sc.mistakes)) {
            session.marathonGlobalScores[uid].mistakes =
              (session.marathonGlobalScores[uid].mistakes || []).concat(sc.mistakes);
          }
        }
      }

      // Qaysi reytingni ko'rsatishni aniqlaymiz (Oraliq yoki Yakuniy)
      const scoresToUse =
        session.isMarathon &&
          session.currentBlockIdx >= session.marathonBlocks.length - 1
          ? session.marathonGlobalScores
          : session.isMarathon
            ? session.groupScores
            : session.groupScores;

      const targetUserId = session.initiatorId || session.creatorId || session.userId || null;
      const isPodiumEnabled = featureFlagService.isFeatureEnabledSync('FEATURE_TOP3_PODIUM', targetUserId, { chatId, isGroup: true });

      let body = "";
      if (isPodiumEnabled) {
        const podiumRes = formatPublicPodium(scoresToUse);
        body = podiumRes.body;
      } else {
        const entries = Object.values(scoresToUse || {});
        const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
        const sortedEntries = entries.sort((a, b) => (b.correct || 0) - (a.correct || 0));
        const topEntries = sortedEntries.slice(0, 25);
        body = topEntries.length
          ? topEntries
            .map(
              (s, i) =>
                `${medals[i] ?? "🔸"} <b>${escapeHtml(s.name)}</b>: ${s.correct} to'g'ri, ${s.wrong} xato`,
            )
            .join("\n")
          : "😔 Hech kim javob bermadi.";
        if (sortedEntries.length > 25) {
          body += `\n<i>...va yana ${sortedEntries.length - 25} nafar ishtirokchi</i>`;
        }
      }

      // MARAFON: Agar hali bloklar qolgan bo'lsa
      if (
        session.isMarathon &&
        session.currentBlockIdx < session.marathonBlocks.length - 1 &&
        !session.forceStopped
      ) {
        session.currentBlockIdx++;
        const nextBlock = session.marathonBlocks[session.currentBlockIdx];
        const { prepareShuffledQuestions } = require("../core/questionUtils");
        session.sessionQuestions = prepareShuffledQuestions(
          nextBlock.questions,
        );
        session.testId = nextBlock.id || nextBlock.test_id;
        session.blockName = nextBlock.block_name;
        session.qIdx = 0;
        session.consecutiveTimeouts = 0;
        session.pollId = null;
        session.msgId = null;
        session.groupScores = {};
        session.finished = false;
        session.isFinished = false;
        session.questionState = "PREPARING";
        session.transitionLock = null;

        await sessionService.setActiveTest(chatId, session);

        text = `🏁 <b>${session.currentBlockIdx}-Blok Yakunlandi!</b>\n\n🏆 <b>Bu blok bo'yicha oraliq natijalar:</b>\n${body}\n\n⏳ <i>Keyingi navbat: <b>${escapeHtml(nextBlock.block_name)}</b></i>`;
        text = truncateText(text, 4000);

        const interButtons = [];
        if (isPodiumEnabled) {
          interButtons.push([
            {
              text: "📊 Mening Tahlilim (Faqat Menga)",
              callback_data: "my_group_quiz_result",
            },
          ]);
        }
        interButtons.push([
          {
            text: "▶️ Keyingi blokni boshlash",
            callback_data: "room_next_block",
          },
        ]);

        const interOpts = {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: interButtons,
          },
        };
        if (session.messageThreadId) interOpts.message_thread_id = session.messageThreadId;
        await telegram.sendMessage(chatId, text, interOpts);

        // 5 daqiqalik marafon avto-finish taymeri (BUG-07 fix)
        try {
          const { quizTimerQueue } = require("../jobs/queues");
          await quizTimerQueue.add(
            "timeout",
            { chatId, qIdx: -1, isMarathonWait: true },
            { jobId: `marathon_wait:${chatId}:${session.currentBlockIdx}`, delay: 5 * 60 * 1000, removeOnComplete: true }
          );
        } catch {}

        isMarathonContinuing = true;
        return; // Sessiyani o'chirmaymiz
      } else {
        // YAKUNIY REYTING (Oddiy blok yoki Marafon oxiri)
        const botInfo = await telegram.getMe();
        let targetLink = '';
        const isUgc = String(tId).startsWith('ugc_') || Boolean(session.creatorId) || Boolean(session.subjectId);
        if (isUgc) {
          if (session.isMarathon) {
            const mSubjId = session.subjectId || session.marathonBlocks?.[0]?.subject_id || session.marathonBlocks?.[0]?.test_id || 1;
            targetLink = buildShareLink(botInfo.username, 's', mSubjId, true);
          } else {
            const rawTestId = String(tId).startsWith('ugc_') ? parseInt(String(tId).replace('ugc_', ''), 10) : tId;
            targetLink = buildShareLink(botInfo.username, 't', rawTestId, true);
          }
        } else {
          // Rasmiy test havolasi
          if (session.isMarathon) {
            targetLink = `https://t.me/${botInfo.username}?startgroup=offs_${session.subjectKey}`;
          } else {
            targetLink = `https://t.me/${botInfo.username}?startgroup=offt_${session.subjectKey}_${tId}`;
          }
        }
        const shareLink = `https://t.me/share/url?url=${encodeURIComponent(targetLink)}&text=${encodeURIComponent("🏆 Bizning guruh reytingimiz chiroyli chiqdi! Siz ham do'stlar bilan o'ynang.")}`;

        if (session.isMarathon) {
          let globalBody;
          if (isPodiumEnabled) {
            const res = formatPublicPodium(session.marathonGlobalScores);
            globalBody = res.body;
          } else {
            const globalEntries = Object.values(session.marathonGlobalScores || {}).sort((a, b) => (b.correct || 0) - (a.correct || 0));
            const topGlobal = globalEntries.slice(0, 25);
            const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
            globalBody = topGlobal.length
              ? topGlobal
                .map(
                  (s, i) =>
                    `${medals[i] ?? "🔸"} <b>${escapeHtml(s.name)}</b>: ${s.correct} to'g'ri, ${s.wrong} xato`,
                )
                .join("\n")
              : "😔 Hech kim javob bermadi.";
            if (globalEntries.length > 25) {
              globalBody += `\n<i>...va yana ${globalEntries.length - 25} nafar ishtirokchi</i>`;
            }
          }
          text = `🏆 <b>MARAFON YAKUNLANDI!</b>\n\n📚 Fan: <b>${escapeHtml(subjName)}</b>\nJami: <b>${session.marathonBlocks.length} ta blok</b> o'ynaldi\n⏱ Umumiy vaqt: <b>${time}</b>\n\n👑 <b>YAKUNIY CHEMPIONLAR REYTINGI:</b>\n${globalBody}`;
        } else {
          text = `🏁 <b>Musobaqa Yakunlandi!</b>\n\n📚 Fan: <b>${escapeHtml(subjName)}</b>\n🔖 Blok: <b>${escapeHtml(tName)}</b>\n⏱ Vaqt: <b>${time}</b>\n\n🏆 <b>Yakuniy Reyting:</b>\n${body}`;
        }

        buttons = [];
        if (isPodiumEnabled) {
          buttons.push([
            Markup.button.callback(
              "📊 Mening Tahlilim (Faqat Menga)",
              "my_group_quiz_result",
            ),
          ]);
        }
        buttons.push([
          Markup.button.url(
            "↗️ Do'stlarga maqtanib qo'yish (Ulashish)",
            shareLink,
          ),
        ]);
      }
    }

    text = truncateText(text, 4000);
    const finishOpts = {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    };
    if (session.messageThreadId) finishOpts.message_thread_id = session.messageThreadId;

    await telegram.sendMessage(chatId, text, finishOpts);
  } catch (e) {
    console.error(`finishTest send error [${chatId}]:`, e.message);
  } finally {
    if (session?.chatType !== "private" && session) {
      lastGroupQuizCache.set(chatId, session);
      await redisConnection.set(`last_group_quiz:${chatId}`, JSON.stringify(session), "EX", 86400).catch(() => {});
    }
    if (session?.pollId)
      await sessionService.deletePollChat(session.pollId).catch(() => { });
    if (!isMarathonContinuing) {
      await sessionService.deleteActiveTest(chatId).catch(() => { });
    }
  }
}

async function handlePollAnswer(pollAnswer, telegram) {
  const pollId = pollAnswer.poll_id;

  // Agar foydalanuvchi ovozini bekor qilgan (retract) bo'lsa, option_ids bo'sh bo'ladi
  if (!pollAnswer.option_ids || pollAnswer.option_ids.length === 0) {
    return;
  }

  const cachedPoll = await activePollsCache.get(pollId);
  if (cachedPoll) {
    const { chatId, correct_index, qData } = cachedPoll;
    
    const unlockGroup = await mutex.lock(`poll:${chatId}`);
    try {
      const voter = pollAnswer.user || pollAnswer.voter_chat;
      if (!voter) return;
      const uId = voter.id;
      // Guruh testida bitta foydalanuvchi bir savolga faqat 1 marta ovoz berishi mumkin (dublyajni oldini olish)
      const added = await redisConnection.sadd(`poll_voters:${pollId}`, String(uId)).catch(() => 1);
      if (added === 0) {
        return;
      }
      redisConnection.expire(`poll_voters:${pollId}`, 600).catch(() => {});

      const isCorrect = pollAnswer.option_ids[0] === correct_index;
      const uName = pollAnswer.user
        ? [pollAnswer.user.first_name, pollAnswer.user.last_name]
            .filter(Boolean)
            .join(" ") || "Talaba"
        : (pollAnswer.voter_chat?.title || "Kanal");
      userNameCache.set(uId, uName);

      let groupEntry = await groupTestCache.get(chatId);
      if (!groupEntry) {
        groupEntry = { scores: {} };
      }

      if (!groupEntry.scores[uId]) {
        groupEntry.scores[uId] = {
          userId: uId,
          name: uName,
          correct: 0,
          wrong: 0,
          totalTimeMs: 0,
          mistakes: [],
        };
      }

      const sc = groupEntry.scores[uId];
      if (typeof sc.totalTimeMs !== "number") {
        sc.totalTimeMs = 0;
      }
      if (cachedPoll.sentAt) {
        const delta = Math.max(0, Date.now() - cachedPoll.sentAt);
        sc.totalTimeMs += delta;
      }

      if (isCorrect) {
        sc.correct++;
      } else {
        sc.wrong++;
        sc.mistakes.push({
          question: qData.question,
          correct_ans: qData.correct_text || qData.options[qData.correct_index],
          wrong_ans: qData.options[pollAnswer.option_ids[0]],
          options: qData.options,
          correct_index: qData.correct_index,
          category: qData.category || qData.topic || null,
        });
      }
      await groupTestCache.set(chatId, groupEntry);

      // Guruh testida barcha kutish zalida ro'yxatdan o'tganlar javob berganini tekshiramiz
      const voterCount = typeof redisConnection.scard === 'function'
        ? await redisConnection.scard(`poll_voters:${pollId}`).catch(() => 0)
        : 0;

      // Agar Kutish zalida "Avto-o'tish" O'CHIRILGAN bo'lsa, 30 soniyalik taymer o'zi yakunlaydi (BUG-06 fix):
      if (!cachedPoll.autoAdvance) {
        return;
      }

      // Agar "Avto-o'tish" YOQILGAN bo'lsa, ro'yxatdan o'tgan qatnashchilarni sanaymiz:
      const readySet = Array.isArray(cachedPoll.readyUserIds) && cachedPoll.readyUserIds.length > 0
        ? new Set(cachedPoll.readyUserIds.map(String))
        : null;

      let readyVoterCount = 0;
      if (readySet) {
        if (readySet.has(String(uId))) {
          await redisConnection.sadd(`poll_ready_voters:${pollId}`, String(uId)).catch(() => {});
          redisConnection.expire(`poll_ready_voters:${pollId}`, 600).catch(() => {});
        }
        readyVoterCount = typeof redisConnection.scard === 'function'
          ? await redisConnection.scard(`poll_ready_voters:${pollId}`).catch(() => 0)
          : 0;
      } else {
        readyVoterCount = voterCount;
      }

      const expCount = readySet ? readySet.size : (cachedPoll.expectedParticipantsCount || 0);
      if (expCount < 2) return;
      if (expCount >= 2 && voterCount < expCount) return;
      if (readySet && readyVoterCount < expCount) return;
      const session = await sessionService.getActiveTest(chatId);
      if (
        session &&
        session.status !== "paused" &&
        !session.finished &&
        !session.isFinished &&
        session.pollId === pollId &&
        (session.expectedParticipantsCount >= 2 || (readySet && readySet.size >= 2)) &&
        readyVoterCount >= (readySet ? readySet.size : session.expectedParticipantsCount) &&
        session.transitionLock !== session.qIdx &&
        session.questionState !== "TRANSITIONING"
      ) {
        session.transitionLock = session.qIdx;
        session.questionState = "TRANSITIONING";
        session.consecutiveTimeouts = 0;
        session.qIdx++;
        await sessionService.setActiveTest(chatId, session);

        await cancelSessionTimer(session, chatId);
        await activePollsCache.delete(pollId);
        await sessionService.deletePollChat(pollId).catch(() => {});
        try {
          await telegram.stopPoll(chatId, session.msgId);
        } catch {}

        setTimeout(() => sendNextQuestion(chatId, telegram), 1000);
      }
    } finally {
      unlockGroup();
    }
    return;
  }

  const chatId = await sessionService.getPollChat(pollId);
  if (!chatId) return;

  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session || session.finished || session.isFinished || session.pollId !== pollId || session.chatType !== "private")
      return;

    // Race condition guard: agar savol allaqachon keyingisiga o'tgan bo'lsa yoki o'tish jarayonida bo'lsa
    if (session.transitionLock === session.qIdx || session.questionState === "TRANSITIONING") {
      return;
    }
    session.transitionLock = session.qIdx;
    session.questionState = "TRANSITIONING";
    await sessionService.setActiveTest(chatId, session);

    const qData = session.sessionQuestions[session.qIdx];
    const isCorrect = pollAnswer.option_ids[0] === qData.correct_index;
    const voter = pollAnswer.user || pollAnswer.voter_chat;
    const uId = voter ? voter.id : chatId;
    const uName = pollAnswer.user
      ? [pollAnswer.user.first_name, pollAnswer.user.last_name]
          .filter(Boolean)
          .join(" ") || "Talaba"
      : (pollAnswer.voter_chat?.title || "Talaba");
    userNameCache.set(uId, uName);

    session.consecutiveTimeouts = 0;
    try {
      await telegram.stopPoll(chatId, session.msgId);
    } catch {
      /* silent */
    }

    await sessionService.deletePollChat(pollId).catch(() => {});

    // Pending savol taymerini BullMQ navbatidan bekor qilamiz
    await cancelSessionTimer(session, chatId);

    if (isCorrect) {
      session.correct++;
    } else {
      session.wrong++;
      session.mistakes.push({
        question: qData.question,
        correct_ans: qData.correct_text || qData.options[qData.correct_index],
        wrong_ans: qData.options[pollAnswer.option_ids[0]],
        options: qData.options, // <--- SHU QATOR QO'SHILADI
        correct_index: qData.correct_index,
      });
    }

    session.qIdx++;
    await sessionService.setActiveTest(chatId, session);
    // 600ms pauza: foydalanuvchi to'g'ri/xato animatsiyasini ko'rishi va Telegram rate limitiga tushmaslik uchun
    await new Promise(r => setTimeout(r, 600));
    await sendNextQuestion(chatId, telegram);
  } finally {
    unlock();
  }
}

async function questionTimeout(chatId, expectedIdx, pollId, telegram) {
  activePollsCache.delete(pollId);
  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session || session.finished || session.isFinished || session.qIdx !== expectedIdx || session.pollId !== pollId)
      return;
    // 🛑 Taymer ishlaganda test pauzada bo'lsa, jarayonni e'tiborsiz qoldiramiz (Ignore)
    if (session.status === "paused") return;

    // Race condition guard: agar savol allaqachon javob berilib keyingisiga o'tgan bo'lsa
    if (session.transitionLock === expectedIdx || session.questionState === "TRANSITIONING") {
      return;
    }
    session.transitionLock = expectedIdx;
    session.questionState = "TRANSITIONING";
    await sessionService.setActiveTest(chatId, session);

    try {
      await telegram.stopPoll(chatId, session.msgId);
    } catch {
      /* silent */
    }

    await sessionService.deletePollChat(pollId).catch(() => {});

    const qData = session.sessionQuestions[expectedIdx];
    session.qIdx++;

    if (session.chatType === "private") {
      session.wrong++;
      session.consecutiveTimeouts++;
      session.mistakes.push({
        question: qData.question,
        correct_ans: qData.correct_text || qData.options[qData.correct_index],
        wrong_ans: "⏳ Vaqt tugadi",
        options: qData.options, // <--- SHU QATOR QO'SHILADI
        correct_index: qData.correct_index,
      });

      if (
        session.consecutiveTimeouts >= 2 &&
        session.qIdx < session.sessionQuestions.length
      ) {
        const remaining = session.sessionQuestions.length - session.qIdx;
        session.status = "paused";
        await sessionService.setActiveTest(chatId, session);
        await telegram.sendMessage(
          chatId,
          `⏸ <b>Ouu, qayerdasiz?</b> ☕️\n\n` +
          `Ketma-ket 2 ta savol o'tib ketdi. Qahva ichgani ketdingizmi?\n\n` +
          `Xavotir olmang, test avtomatik pauza qilindi. Qachon tayyor bo'lsangiz, davom etamiz!\n\n` +
          `━━━━━━━━━━━━━━━━\n` +
          `📊 <b>Joriy natija:</b>\n` +
          `✅ To'g'ri: <b>${session.correct} ta</b>\n` +
          `❌ Xato:    <b>${session.wrong} ta</b>\n` +
          `📌 Qolgan:  <b>${remaining} ta savol</b>\n` +
          `━━━━━━━━━━━━━━━━`,
          {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("▶️ Davom etaman", "resume_test")],
              [Markup.button.callback("🏁 Yakunlash", "force_finish")],
            ]),
          },
        );
        return;
      }
    }

    if (session.chatType !== "private") {
      const voterCount = typeof redisConnection.scard === 'function'
        ? await redisConnection.scard(`poll_voters:${pollId}`).catch(() => 0)
        : 0;
      if (voterCount === 0) {
        session.consecutiveTimeouts = (session.consecutiveTimeouts || 0) + 1;
      } else {
        session.consecutiveTimeouts = 0;
      }

      if (session.consecutiveTimeouts >= 3) {
        await telegram.sendMessage(
          chatId,
          `🛑 <b>Musobaqa to'xtatildi!</b>\n\nKetma-ket 3 ta savolga hech kim javob bermagani sababli test avtomatik yakunlandi.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
        await sessionService.setActiveTest(chatId, session);
        return finishTest(chatId, telegram);
      }
    }

    await sessionService.setActiveTest(chatId, session);
    await sendNextQuestion(chatId, telegram);
  } finally {
    unlock();
  }
}

module.exports = {
  sendNextQuestion,
  finishTest,
  handlePollAnswer,
  questionTimeout,
  lastMistakesCache,
  resolveTestName,
  groupTestCache,
  activePollsCache,
  buildFinishButtons,
  cancelSessionTimer,
  // 3D Podium & Ephemeral Knowledge Radar
  sortGroupScores,
  formatPublicPodium,
  generateGhostCoachAdvice,
  generatePersonalAnalysis,
  cbMyGroupQuizResult,
  lastGroupQuizCache,
  getLastGroupQuiz,
};
