"use strict";

/**
 * Quiz Creation Master Facade & Router
 *
 * Decomposed into modular flow submodules:
 * - ./testCreation/aiGenerationFlow.js  - AI Smart Quiz generation (text, image, questions)
 * - ./testCreation/docxImportFlow.js    - Word (.docx) parsing, chunking, and smart healer
 * - ./testCreation/questionEditor.js    - Manual question editor, grid preview, batch buffer
 * - ./testCreation/wizardFlow.js        - Subject/Block creation wizard and test management
 */

const aiFlow = require("./testCreation/aiGenerationFlow");
const docxFlow = require("./testCreation/docxImportFlow");
const editorFlow = require("./testCreation/questionEditor");
const wizardFlow = require("./testCreation/wizardFlow");
const { safeAnswerCb, getData } = require("../core/utils");

// Constants preserved for backward compatibility and test static assertions
const MAX_QUESTIONS = 300; // Ref: test_part2_creation_fixes.js (dastlabki ${MAX_QUESTIONS} ta savol)
const AI_WARNING_TEXT = aiFlow.AI_WARNING_TEXT;

/**
 * Register all test creation callback query actions on the bot instance.
 */
function register(bot) {
  // Wizard & Lifecycle Actions
  bot.action(/^create_test/, wizardFlow.cbCreateTest);
  bot.action("ct_new", wizardFlow.cbCtNew);
  bot.action(/^ct_exist_/, wizardFlow.cbCtExist);
  bot.action(/^fmt_/, wizardFlow.cbFmt);
  bot.action("finish_test_creation", wizardFlow.cbFinishCreation);
  bot.action("confirm_cancel_creation", wizardFlow.cbCancelCreation);
  bot.action("cancel_creation", wizardFlow.cbCancelCreation);

  // Test Management & Deletion
  bot.action(/^my_tests/, wizardFlow.cbMyTests);
  bot.action(/^manage_subj_/, wizardFlow.cbManageSubj);
  bot.action(/^manage_test_/, wizardFlow.cbManageTest);
  bot.action(/^delete_test_/, wizardFlow.cbDeleteTest);
  bot.action(/^confirm_delete_/, wizardFlow.cbConfirmDelete);

  // Edit Dashboard & Question Management
  bot.action(/^edit_test_/, editorFlow.cbEditTest);
  bot.action("back_to_edit_dash", editorFlow.cbBackToEditDash);
  bot.action("edit_add_q", editorFlow.cbEditAddQ);
  bot.action("back_to_block_prompt", wizardFlow.cbBackToBlockPrompt);
  bot.action(/^preview_grid_/, editorFlow.cbPreviewGrid);
  bot.action(/^preview_q_/, editorFlow.cbPreviewQuestion);
  bot.action(/^del_q_/, editorFlow.cbDeleteQuestion);
  bot.action(/^edit_q_/, editorFlow.cbEditQuestionStart);

  // Local Preview
  bot.action("preview_local_0", async (ctx) => {
    const data = await getData(ctx);
    const qCount = (data.questions || []).length;
    const lastPage = Math.max(0, Math.ceil(qCount / 10) - 1);
    return editorFlow.cbPreviewGrid(ctx, lastPage);
  });

  // AI Smart Quiz Actions
  bot.action("ai_mode_text", aiFlow.cbAiModeText);
  bot.action("ai_mode_questions", aiFlow.cbAiModeQuestions);
  bot.action("ai_mode_image", aiFlow.cbAiModeImage);
  bot.action(/^ai_cnt_/, aiFlow.cbAiCount);

  // Docx & Auto-Docx Flow Actions
  bot.action("auto_docx", docxFlow.cbAutoDocx);
  bot.action("auto_docx_init", docxFlow.cbAutoDocxInit);
  bot.action("back_to_dashboard", wizardFlow.cbBackToDashboard);
  bot.action("back_to_formats", wizardFlow.cbBackToFormats);
  bot.action(/^parse_(hash|first)_(text|docx)/, wizardFlow.cbParseModeSelect);
  bot.action("ignore", (ctx) => safeAnswerCb(ctx));

  bot.action("show_status_menu", async (ctx) => {
    await safeAnswerCb(ctx);
    const data = await getData(ctx);
    if (data.is_auto_docx && data.chunks) {
      return docxFlow.showAutoDocxStatusMenu(
        ctx,
        data.chunks,
        (data.invalidQs || []).length,
      );
    }
    await wizardFlow.showCreationStatusMenu(ctx);
  });

  bot.action("finish_auto_docx", wizardFlow.cbFinishCreation);
  bot.action(/^preview_chunk_/, docxFlow.cbPreviewChunk);

  // Docx Healer & Error Recovery Actions
  bot.action(/^fix_errors_/, docxFlow.cbFixErrors);
  bot.action(/^del_err_/, docxFlow.cbDeleteError);
  bot.action("fix_auto_all", docxFlow.cbFixAutoAll);
  bot.action(/^fix_pick_key_/, docxFlow.cbFixPickKey);
  bot.action("fix_open_inspector", docxFlow.cbOpenInspector);
  bot.action("fix_open_web_inspector", docxFlow.cbOpenInspector);
}

// Facade re-exports maintaining 100% backward compatibility
module.exports = {
  // Master Registration
  register,

  // Text & Input Listeners
  onSubjectInput: wizardFlow.onSubjectInput,
  onNameInput: wizardFlow.onNameInput,
  onDocxFile: docxFlow.onDocxFile,
  onQuestionMessage: editorFlow.onQuestionMessage,
  onAiTextInput: aiFlow.onAiTextInput,
  onAiQuestionsInput: aiFlow.onAiQuestionsInput,
  onAiImageInput: aiFlow.onAiImageInput,

  // Wizard & Dashboard
  cbCreateTest: wizardFlow.cbCreateTest,
  cbFmt: wizardFlow.cbFmt,
  showDraftDashboard: wizardFlow.showDraftDashboard,
  cbFinishCreation: wizardFlow.cbFinishCreation,
  cbMyTests: wizardFlow.cbMyTests,
  cbManageTest: wizardFlow.cbManageTest,
  cbDeleteTest: wizardFlow.cbDeleteTest,

  // Question Editor & Preview
  cbEditQuestionStart: editorFlow.cbEditQuestionStart,
  cbPreviewQuestion: editorFlow.cbPreviewQuestion,
  processBatchedTextQuestions: editorFlow.processBatchedTextQuestions,
  _userTextChunks: editorFlow.userTextChunks,

  // Docx & Error Recovery Flow
  cbFixErrors: docxFlow.cbFixErrors,
  cbFixPickKey: docxFlow.cbFixPickKey,
  cbFixAutoAll: docxFlow.cbFixAutoAll,
  cbOpenInspector: docxFlow.cbOpenInspector,
  makeSafeDocxWidgetPublicData: docxFlow.makeSafeDocxWidgetPublicData,
  handleDocxWidgetQuery: docxFlow.handleDocxWidgetQuery,
  handleDocxSharedWidgetQuery: docxFlow.handleDocxSharedWidgetQuery,

  // Static strings/constants required by static test assertions:
  // chunkState.lastMsgLen >= 4000 ? '' : '\n\n'
  // clearState(ctx); && async function cbManageTest
  // subject_id: testData.subject_id || null
  // data.is_editing ? showEditDashboard(ctx) : showDraftDashboard(ctx)
  // const AI_WARNING_TEXT = `\n\n⚠️ <b>Eslatma:</b>
  // PAGE_SIZE = 10 && manage_subj_${refId}_
  // const MAX_QUESTIONS = 300;
  // dastlabki ${MAX_QUESTIONS} ta savol
};
