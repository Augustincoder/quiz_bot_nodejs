"use strict";

const { Markup } = require("telegraf");
const mutex = require("../core/mutex");
const { SUBJECTS } = require("../config/config");
const dbService = require("../services/dbService");
const sessionService = require("../services/sessionService");
// const redisConnection = require("../services/redisService");
const logger = require("../core/logger");
const {
  userNameCache,
  safePercent,
  grade,
  progressBar,
} = require("../core/utils");
const redisConnection = require("../services/redisService");
const { pendingShelfSaves } = require("../core/pendingStore");

// ─── TTL-Wrapped In-Memory Caches (Prevent memory leaks) ────
// Each entry stores { data, ts }. A cleanup interval purges stale entries.
const groupTestCache = new Map();
const activePollsCache = new Map();

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function setCacheEntry(cache, key, data) {
  cache.set(key, { data, ts: Date.now() });
}

function getCacheEntry(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

// Periodic cleanup of stale entries
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of groupTestCache) {
    if (now - v.ts > CACHE_TTL_MS) groupTestCache.delete(k);
  }
  for (const [k, v] of activePollsCache) {
    if (now - v.ts > CACHE_TTL_MS) activePollsCache.delete(k);
  }
}, CACHE_CLEANUP_INTERVAL_MS);
cleanupTimer.unref(); // Don't prevent Node.js from exiting

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
};

function resolveTestName(tId, blockName) {
  if (String(tId) === "mock") return "🎲 Aralash Test";
  if (String(tId) === "adaptive") return "🎯 AI Adaptiv Test";
  if (String(tId).startsWith("ugc_")) return `📝 ${blockName || "Maxsus Test"}`;
  return `${tId}-Blok`;
}

// ─── TUGMALARNI YASASH FUNKSIYASI (YANGILANGAN) ───
function buildFinishButtons(tId, subjectKey, mistakesCount = 0) {
  const btns = [];

  // Agar xatolar bo'lsa, 2 ta tugmani ham chiqaramiz
  if (mistakesCount > 0) {
    btns.push([
      Markup.button.callback("❌ Xatolarni ko'rish", "review_mistakes"),
    ]);
    btns.push([
      Markup.button.callback(
        `🔄 Xatolar ustida ishlash (${mistakesCount} ta)`,
        `wm_menu_${subjectKey}`,
      ),
    ]);
  }

  const sid = String(tId);
  if (sid.startsWith("ugc_")) {
    btns.push([
      Markup.button.callback(
        "🔁 Qayta ishlash",
        `ugc_start_${sid.replace("ugc_", "")}`,
      ),
    ]);
  } else if (sid === "mock") {
    btns.push([
      Markup.button.callback("🎲 Yana aralash", `mock_${subjectKey}`),
    ]);
  } else if (sid === "adaptive") {
    btns.push([
      Markup.button.callback("🎯 Yana adaptiv", `adaptive_${subjectKey}`),
    ]);
  } else {
    btns.push([
      Markup.button.callback(
        "🔁 Qayta ishlash",
        `post_start_${subjectKey}_${tId}`,
      ),
    ]);
    const memDb = require("../core/bot").memoryDb || {};
    if ((memDb[subjectKey] || {})[tId + 1]) {
      btns.push([
        Markup.button.callback(
          `➡️ Keyingi (${tId + 1}-Blok)`,
          `post_start_${subjectKey}_${tId + 1}`,
        ),
      ]);
    }
  }

  btns.push([Markup.button.callback("📥 Javonga saqlash", "shelf_save_init")]);
  btns.push([
    Markup.button.callback("🔙 Fan menyusi", `post_subj_${subjectKey}`),
    Markup.button.callback("🏠 Asosiy", "post_main"),
  ]);

  return btns;
}

async function sendNextQuestion(chatId, telegram) {
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session) return;
    if (session.qIdx >= session.sessionQuestions.length)
      return finishTest(chatId, telegram);

    const q = session.sessionQuestions[session.qIdx];
    const progress = `[${session.qIdx + 1}/${session.sessionQuestions.length}]`;
    const qFull = `${progress} ${q.question}`;
    const needsSplit =
      qFull.length > 255 || q.options.some((o) => o.length > 100);

    let pollQ, pollOpts;
    if (needsSplit) {
      const labels = ["A", "B", "C", "D", "E", "F"];
      let text =
        `📑 <b>Savol ${progress}</b>\n\n${q.question}\n\n` +
        q.options.map((opt, i) => `<b>${labels[i]})</b> ${opt}`).join("\n");
      if (text.length > 4000)
        text = text.slice(0, 3900) + "\n<i>...(matn kesildi)</i>";
      await telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
      pollQ = `${progress} To'g'ri variantni belgilang:`;
      pollOpts = q.options.map((_, i) => `${labels[i]} varianti`);
    } else {
      pollQ = qFull;
      pollOpts = q.options;
    }

    let msg;
    try {
      msg = await telegram.sendPoll(chatId, pollQ, pollOpts, {
        type: "quiz",
        correct_option_id: q.correct_index,
        is_anonymous: false,
        open_period: 30,
      });
    } catch (e) {
      console.error(`sendPoll error [${chatId}]:`, e.message);
      return;
    }
    session.pollId = msg.poll.id;
    session.msgId = msg.message_id;

    if (session.chatType !== "private") {
      setCacheEntry(activePollsCache, msg.poll.id, {
        chatId: chatId,
        correct_index: q.correct_index,
        qData: q,
      });
      if (!getCacheEntry(groupTestCache, chatId)) {
        setCacheEntry(groupTestCache, chatId, {
          scores: session.groupScores || {},
        });
      }
    }

    await sessionService.setActiveTest(chatId, session);
    await sessionService.setPollChat(msg.poll.id, String(chatId));

    const { quizTimerQueue } = require("../jobs/queues");
    await quizTimerQueue.add(
      "timeout",
      { chatId, expectedIdx: session.qIdx, pollId: msg.poll.id },
      {
        delay: 31_000,
        jobId: `timeout:${chatId}:${session.qIdx}`,
        removeOnComplete: true,
      },
    );
  } catch (e) {
    console.error(`sendNextQuestion fatal [${chatId}]:`, e.message);
  }
}

// ─── TESTNI YAKUNLASH VA NATIJALARNI HISOBLASH ─────────────────
async function finishTest(chatId, telegram) {
  const session = await sessionService.getActiveTest(chatId);
  if (!session || session.finished) return;
  session.finished = true;
  activePollsCache.delete(session.pollId);

  if (session.chatType !== "private") {
    const groupEntry = getCacheEntry(groupTestCache, chatId);
    if (groupEntry) {
      session.groupScores = groupEntry.scores;
      groupTestCache.delete(chatId);
    }
  }
  const tId = session.testId;
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
      await lastMistakesCache.set(chatId, [...session.mistakes]);

      dbService
        .updateUserStats(
          chatId,
          session.correct,
          session.wrong,
          session.subjectKey,
          tId,
          session.mistakes,
        )
        .catch((e) => console.error("Stats update error:", e.message));

      const total = session.correct + session.wrong;
      const skipped = session.sessionQuestions.length - total;
      const pct = safePercent(session.correct, total);

      // Telemetry
      logger.info("test:finish", {
        chatId,
        subject: session.subjectKey,
        testId: tId,
        correct: session.correct,
        wrong: session.wrong,
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
        `📚 ${subjName} — ${tName}\n` +
        `${progressBar(Math.round(pct), 100)}\n\n` +
        `━━━━━━━━━━━━━━━━\n` +
        `✅ To'g'ri:    <b>${session.correct} ta</b>\n` +
        `❌ Xato:       <b>${session.wrong} ta</b>\n` +
        `⏭ O'tkazildi: <b>${skipped} ta</b>\n` +
        `━━━━━━━━━━━━━━━━\n\n` +
        `🎯 Natija: <b>${pct}%</b> — ${grade(pct)}\n` +
        `⏱ Vaqt: <b>${time}</b>` +
        funFeedback;

      // Eski RAM qatorini (pendingShelfSaves.set...) o'chirib, shuni qo'ying:
      const shelfData = {
        testId: tId,
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
      buttons = buildFinishButtons(tId, session.subjectKey, mistakesCount);
    } else {
      // ─── GURUH TESTLARI (MARAFON VA REYTING) ───
      const { getCacheEntry, groupTestCache } = require("./coreQuiz") || {};
      const localGetCacheEntry =
        getCacheEntry ||
        function (cache, key) {
          const e = cache.get(key);
          return e ? e.data : null;
        };

      const groupEntry = localGetCacheEntry(groupTestCache, chatId);
      if (groupEntry) {
        session.groupScores = groupEntry.scores;
        groupTestCache.delete(chatId);
      }

      // Marafon bo'lsa, oraliq natijalarni global reytingga qo'shamiz
      if (session.isMarathon) {
        if (!session.marathonGlobalScores) session.marathonGlobalScores = {};
        for (const [uid, sc] of Object.entries(session.groupScores)) {
          if (!session.marathonGlobalScores[uid]) {
            session.marathonGlobalScores[uid] = {
              name: sc.name,
              correct: 0,
              wrong: 0,
            };
          }
          session.marathonGlobalScores[uid].correct += sc.correct;
          session.marathonGlobalScores[uid].wrong += sc.wrong;
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

      const entries = Object.values(scoresToUse);
      const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

      const body = entries.length
        ? entries
            .sort((a, b) => b.correct - a.correct)
            .map(
              (s, i) =>
                `${medals[i] ?? "🔸"} <b>${s.name}</b>: ${s.correct} to'g'ri, ${s.wrong} xato`,
            )
            .join("\n")
        : "😔 Hech kim javob bermadi.";

      // MARAFON: Agar hali bloklar qolgan bo'lsa
      if (
        session.isMarathon &&
        session.currentBlockIdx < session.marathonBlocks.length - 1
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
        session.groupScores = {}; // Keyingi blok uchun tozalaymiz
        session.finished = false; // Sessiyani ochiq qoldiramiz

        await sessionService.setActiveTest(chatId, session);

        text = `🏁 <b>${session.currentBlockIdx}-Blok Yakunlandi!</b>\n\n🏆 <b>Bu blok bo'yicha oraliq natijalar:</b>\n${body}\n\n⏳ <i>Keyingi navbat: <b>${nextBlock.block_name}</b></i>`;

        await telegram.sendMessage(chatId, text, {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "▶️ Keyingi blokni boshlash",
                  callback_data: "room_next_block",
                },
              ],
            ],
          },
        });

        return; // Sessiyani o'chirmaymiz
      } else {
        // YAKUNIY REYTING (Oddiy blok yoki Marafon oxiri)
        const botInfo = await telegram.getMe();
        const shareLink = `https://t.me/share/url?url=https://t.me/${botInfo.username}?startgroup=${session.isMarathon ? "s" : "t"}_${session.isMarathon ? session.marathonBlocks[0].test_id : tId}&text=🏆 Bizning guruh reytingimiz chiroyli chiqdi! Siz ham do'stlar bilan o'ynang.`;

        if (session.isMarathon) {
          const globalEntries = Object.values(
            session.marathonGlobalScores,
          ).sort((a, b) => b.correct - a.correct);
          const globalBody = globalEntries.length
            ? globalEntries
                .map(
                  (s, i) =>
                    `${medals[i] ?? "🔸"} <b>${s.name}</b>: ${s.correct} to'g'ri, ${s.wrong} xato`,
                )
                .join("\n")
            : "😔 Hech kim javob bermadi.";

          text = `🏆 <b>MARAFON YAKUNLANDI!</b>\n\n📚 Fan: <b>${subjName}</b>\nJami: <b>${session.marathonBlocks.length} ta blok</b> o'ynaldi\n⏱ Umumiy vaqt: <b>${time}</b>\n\n👑 <b>YAKUNIY CHEMPIONLAR REYTINGI:</b>\n${globalBody}`;
        } else {
          text = `🏁 <b>Musobaqa Yakunlandi!</b>\n\n📚 Fan: <b>${subjName}</b>\n🔖 Blok: <b>${tName}</b>\n⏱ Vaqt: <b>${time}</b>\n\n🏆 <b>Yakuniy Reyting:</b>\n${body}`;
        }

        buttons = [
          [
            Markup.button.url(
              "↗️ Do'stlarga maqtanib qo'yish (Ulashish)",
              shareLink,
            ),
          ],
        ];
      }
    }

    await telegram.sendMessage(chatId, text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(buttons),
    });
  } catch (e) {
    console.error(`finishTest send error [${chatId}]:`, e.message);
  } finally {
    if (session.pollId)
      await sessionService.deletePollChat(session.pollId).catch(() => {});
    await sessionService.deleteActiveTest(chatId).catch(() => {});
  }
}

async function handlePollAnswer(pollAnswer, telegram) {
  const pollId = pollAnswer.poll_id;

  const cachedPoll = getCacheEntry(activePollsCache, pollId);
  if (cachedPoll) {
    const { chatId, correct_index, qData } = cachedPoll;
    const isCorrect = pollAnswer.option_ids[0] === correct_index;

    const uId = pollAnswer.user.id;
    const uName =
      [pollAnswer.user.first_name, pollAnswer.user.last_name]
        .filter(Boolean)
        .join(" ") || "Talaba";
    userNameCache.set(uId, uName);

    let groupEntry = getCacheEntry(groupTestCache, chatId);
    if (!groupEntry) {
      groupEntry = { scores: {} };
      setCacheEntry(groupTestCache, chatId, groupEntry);
    }

    if (!groupEntry.scores[uId]) {
      groupEntry.scores[uId] = {
        name: uName,
        correct: 0,
        wrong: 0,
        mistakes: [],
      };
    }

    const sc = groupEntry.scores[uId];
    if (isCorrect) {
      sc.correct++;
    } else {
      sc.wrong++;
      sc.mistakes.push({
        question: qData.question,
        correct_ans: qData.correct_text || qData.options[qData.correct_index],
        wrong_ans: qData.options[pollAnswer.option_ids[0]],
        options: qData.options, // <--- SHU QATOR QO'SHILADI
        correct_index: qData.correct_index,
      });
    }
    return;
  }

  const chatId = await sessionService.getPollChat(pollId);
  if (!chatId) return;

  const unlock = await mutex.lock(`poll:${chatId}`);
  try {
    const session = await sessionService.getActiveTest(chatId);
    if (!session || session.pollId !== pollId || session.chatType !== "private")
      return;

    const qData = session.sessionQuestions[session.qIdx];
    const isCorrect = pollAnswer.option_ids[0] === qData.correct_index;
    const uId = pollAnswer.user.id;
    const uName =
      [pollAnswer.user.first_name, pollAnswer.user.last_name]
        .filter(Boolean)
        .join(" ") || "Talaba";
    userNameCache.set(uId, uName);

    session.consecutiveTimeouts = 0;
    try {
      await telegram.stopPoll(chatId, session.msgId);
    } catch {
      /* silent */
    }

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
    if (!session || session.qIdx !== expectedIdx || session.pollId !== pollId)
      return;

    try {
      await telegram.stopPoll(chatId, session.msgId);
    } catch {
      /* silent */
    }

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
  getCacheEntry,
  setCacheEntry,
  groupTestCache,
  activePollsCache,
  buildFinishButtons,
};
