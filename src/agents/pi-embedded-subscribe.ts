import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { createStreamingDirectiveAccumulator } from "../auto-reply/reply/streaming-directives.js";
import { formatToolAggregate } from "../auto-reply/tool-meta.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { InlineCodeState } from "../markdown/code-spans.js";
import { buildCodeSpanIndex, createInlineCodeState } from "../markdown/code-spans.js";
import { EmbeddedBlockChunker } from "./pi-embedded-block-chunker.js";
import {
  isMessagingToolDuplicateNormalized,
  normalizeTextForComparison,
} from "./pi-embedded-helpers.js";
import { createEmbeddedPiSessionEventHandler } from "./pi-embedded-subscribe.handlers.js";
import type {
  EmbeddedPiSubscribeContext,
  EmbeddedPiSubscribeState,
} from "./pi-embedded-subscribe.handlers.types.js";
import type { SubscribeEmbeddedPiSessionParams } from "./pi-embedded-subscribe.types.js";
import { formatReasoningMessage } from "./pi-embedded-utils.js";

// Use a robust regex that handles newlines and case insensitivity globaly to avoid recompilation
const ROBUST_THINKING_RE = /<\s*(\/?)\s*(?:think(?:ing)?|thought|antthinking)\s*>/gis;
const FINAL_TAG_SCAN_RE = /<\s*(\/?)\s*final\s*>/gi;
const log = createSubsystemLogger("agent/embedded");

export type {
  BlockReplyChunking,
  SubscribeEmbeddedPiSessionParams,
  ToolResultFormat,
} from "./pi-embedded-subscribe.types.js";

export function subscribeEmbeddedPiSession(params: SubscribeEmbeddedPiSessionParams) {
  const reasoningMode = params.reasoningMode ?? "off";
  const toolResultFormat = params.toolResultFormat ?? "markdown";
  const useMarkdown = toolResultFormat === "markdown";
  const state: EmbeddedPiSubscribeState = {
    assistantTexts: [],
    toolMetas: [],
    toolMetaById: new Map(),
    toolSummaryById: new Set(),
    lastToolError: undefined,
    blockReplyBreak: params.blockReplyBreak ?? "text_end",
    reasoningMode,
    includeReasoning: reasoningMode === "on",
    shouldEmitPartialReplies: !(reasoningMode === "on" && !params.onBlockReply),
    streamReasoning: reasoningMode === "stream" && typeof params.onReasoningStream === "function",
    deltaBuffer: "",
    blockBuffer: "",
    // Track if a streamed chunk opened a <think> block (stateful across chunks).
    blockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    lastStreamedAssistant: undefined,
    lastStreamedReasoning: undefined,
    lastBlockReplyText: undefined,
    assistantMessageIndex: 0,
    lastAssistantTextMessageIndex: -1,
    lastAssistantTextNormalized: undefined,
    lastAssistantTextTrimmed: undefined,
    assistantTextBaseline: 0,
    suppressBlockChunks: false, // Avoid late chunk inserts after final text merge.
    lastReasoningSent: undefined,
    lastActivityMs: Date.now(), // 🛡️ Track last stream activity for stall detection
    compactionInFlight: false,
    pendingCompactionRetry: 0,
    compactionRetryResolve: undefined,
    compactionRetryPromise: null,
    messagingToolSentTexts: [],
    messagingToolSentTextsNormalized: [],
    messagingToolSentTargets: [],
    pendingMessagingTexts: new Map(),
    pendingMessagingTargets: new Map(),
  };

  const assistantTexts = state.assistantTexts;
  const toolMetas = state.toolMetas;
  const toolMetaById = state.toolMetaById;
  const toolSummaryById = state.toolSummaryById;
  const messagingToolSentTexts = state.messagingToolSentTexts;
  const messagingToolSentTextsNormalized = state.messagingToolSentTextsNormalized;
  const messagingToolSentTargets = state.messagingToolSentTargets;
  const pendingMessagingTexts = state.pendingMessagingTexts;
  const pendingMessagingTargets = state.pendingMessagingTargets;
  const replyDirectiveAccumulator = createStreamingDirectiveAccumulator();

  const resetAssistantMessageState = (nextAssistantTextBaseline: number) => {
    state.deltaBuffer = "";
    state.blockBuffer = "";
    blockChunker?.reset();
    replyDirectiveAccumulator.reset();
    state.blockState.thinking = false;
    state.blockState.final = false;
    state.blockState.inlineCode = createInlineCodeState();
    state.lastStreamedAssistant = undefined;
    state.lastBlockReplyText = undefined;
    state.lastStreamedReasoning = undefined;
    state.lastReasoningSent = undefined;
    state.suppressBlockChunks = false;
    state.assistantMessageIndex += 1;
    state.lastAssistantTextMessageIndex = -1;
    state.lastAssistantTextNormalized = undefined;
    state.lastAssistantTextTrimmed = undefined;
    state.assistantTextBaseline = nextAssistantTextBaseline;
  };

  const rememberAssistantText = (text: string) => {
    state.lastAssistantTextMessageIndex = state.assistantMessageIndex;
    state.lastAssistantTextTrimmed = text.trimEnd();
    const normalized = normalizeTextForComparison(text);
    state.lastAssistantTextNormalized = normalized.length > 0 ? normalized : undefined;
  };

  const shouldSkipAssistantText = (text: string) => {
    if (state.lastAssistantTextMessageIndex !== state.assistantMessageIndex) return false;
    const trimmed = text.trimEnd();
    if (trimmed && trimmed === state.lastAssistantTextTrimmed) return true;
    const normalized = normalizeTextForComparison(text);
    if (normalized.length > 0 && normalized === state.lastAssistantTextNormalized) return true;
    return false;
  };

  const pushAssistantText = (text: string) => {
    if (!text) return;
    if (shouldSkipAssistantText(text)) return;
    assistantTexts.push(text);
    rememberAssistantText(text);
  };

  const finalizeAssistantTexts = (args: {
    text: string;
    addedDuringMessage: boolean;
    chunkerHasBuffered: boolean;
  }) => {
    const { text, addedDuringMessage, chunkerHasBuffered } = args;

    // If we're not streaming block replies, ensure the final payload includes
    // the final text even when interim streaming was enabled.
    if (state.includeReasoning && text && !params.onBlockReply) {
      if (assistantTexts.length > state.assistantTextBaseline) {
        assistantTexts.splice(
          state.assistantTextBaseline,
          assistantTexts.length - state.assistantTextBaseline,
          text,
        );
        rememberAssistantText(text);
      } else {
        pushAssistantText(text);
      }
      state.suppressBlockChunks = true;
    } else if (!addedDuringMessage && !chunkerHasBuffered && text) {
      // Non-streaming models (no text_delta): ensure assistantTexts gets the final
      // text when the chunker has nothing buffered to drain.
      pushAssistantText(text);
    }

    state.assistantTextBaseline = assistantTexts.length;
  };

  // ── Messaging tool duplicate detection ──────────────────────────────────────
  // Track texts sent via messaging tools to suppress duplicate block replies.
  // Only committed (successful) texts are checked - pending texts are tracked
  // to support commit logic but not used for suppression (avoiding lost messages on tool failure).
  // These tools can send messages via sendMessage/threadReply actions (or sessions_send with message).
  const MAX_MESSAGING_SENT_TEXTS = 200;
  const MAX_MESSAGING_SENT_TARGETS = 200;
  const trimMessagingToolSent = () => {
    if (messagingToolSentTexts.length > MAX_MESSAGING_SENT_TEXTS) {
      const overflow = messagingToolSentTexts.length - MAX_MESSAGING_SENT_TEXTS;
      messagingToolSentTexts.splice(0, overflow);
      messagingToolSentTextsNormalized.splice(0, overflow);
    }
    if (messagingToolSentTargets.length > MAX_MESSAGING_SENT_TARGETS) {
      const overflow = messagingToolSentTargets.length - MAX_MESSAGING_SENT_TARGETS;
      messagingToolSentTargets.splice(0, overflow);
    }
  };

  const ensureCompactionPromise = () => {
    if (!state.compactionRetryPromise) {
      state.compactionRetryPromise = new Promise((resolve) => {
        state.compactionRetryResolve = resolve;
      });
    }
  };

  const noteCompactionRetry = () => {
    state.pendingCompactionRetry += 1;
    ensureCompactionPromise();
  };

  const resolveCompactionRetry = () => {
    if (state.pendingCompactionRetry <= 0) return;
    state.pendingCompactionRetry -= 1;
    if (state.pendingCompactionRetry === 0 && !state.compactionInFlight) {
      state.compactionRetryResolve?.();
      state.compactionRetryResolve = undefined;
      state.compactionRetryPromise = null;
    }
  };

  const maybeResolveCompactionWait = () => {
    if (state.pendingCompactionRetry === 0 && !state.compactionInFlight) {
      state.compactionRetryResolve?.();
      state.compactionRetryResolve = undefined;
      state.compactionRetryPromise = null;
    }
  };

  const blockChunking = params.blockReplyChunking;
  const blockChunker = blockChunking ? new EmbeddedBlockChunker(blockChunking) : null;
  // KNOWN: Provider streams are not strictly once-only or perfectly ordered.
  // `text_end` can repeat full content; late `text_end` can arrive after `message_end`.
  // Tests: `src/agents/pi-embedded-subscribe.test.ts` (e.g. late text_end cases).
  const shouldEmitToolResult = () =>
    typeof params.shouldEmitToolResult === "function"
      ? params.shouldEmitToolResult()
      : params.verboseLevel === "on" || params.verboseLevel === "full";
  const shouldEmitToolOutput = () =>
    typeof params.shouldEmitToolOutput === "function"
      ? params.shouldEmitToolOutput()
      : params.verboseLevel === "full";
  const formatToolOutputBlock = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return "(no output)";
    if (!useMarkdown) return trimmed;
    return `\`\`\`txt\n${trimmed}\n\`\`\``;
  };
  const emitToolSummary = (toolName?: string, meta?: string) => {
    if (!params.onToolResult) return;
    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined, {
      markdown: useMarkdown,
    });
    const { text: cleanedText, mediaUrls } = parseReplyDirectives(agg);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) return;
    try {
      void params.onToolResult({
        text: cleanedText,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
      });
    } catch {
      // ignore tool result delivery failures
    }
  };
  const emitToolOutput = (toolName?: string, meta?: string, output?: string) => {
    if (!params.onToolResult || !output) return;
    const agg = formatToolAggregate(toolName, meta ? [meta] : undefined, {
      markdown: useMarkdown,
    });
    const message = `${agg}\n${formatToolOutputBlock(output)}`;
    const { text: cleanedText, mediaUrls } = parseReplyDirectives(message);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0)) return;
    try {
      void params.onToolResult({
        text: cleanedText,
        mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
      });
    } catch {
      // ignore tool result delivery failures
    }
  };

  // Robust stateful parser for thinking tags that handles:
  // 1. Tags split across chunks (e.g. <th + ink>) - via state.partialTagBuffer
  // 2. Newlines inside tags.
  // 3. Different provider variants (<think>, <thought>, <antthinking>).

  const stripBlockTags = (
    text: string,
    state: {
      thinking: boolean;
      final: boolean;
      inlineCode?: InlineCodeState;
      partialTagBuffer?: string;
    },
  ): string => {
    let input = text;

    // 0. Handle partial tags from previous chunk
    if (state.partialTagBuffer) {
      input = state.partialTagBuffer + text;
      state.partialTagBuffer = undefined;
    }

    if (!input) return input;

    // Detect potential partial tag at the end of the chunk (max 20 chars).
    // This prevents tags like <think> being split as <thi + nk> across chunks.
    const lastOpen = input.lastIndexOf("<");
    if (lastOpen !== -1 && lastOpen > input.length - 20) {
      const potentialTag = input.slice(lastOpen);
      if (!potentialTag.includes(">")) {
        // Broad check for potential thinking/final tags
        if (/^<\s*(\/?)\s*[a-z]*$/i.test(potentialTag)) {
          state.partialTagBuffer = potentialTag;
          input = input.slice(0, lastOpen);
          if (!input) return "";
        }
      }
    }

    if (reasoningMode === "off") {
      // Robustly remove tags but keep content. 
      // Replace with newline to prevent text sticking together.
      const cleaned = input.replace(ROBUST_THINKING_RE, "\n");
      return cleaned.startsWith("\n") ? cleaned.trimStart() : cleaned;
    }

    const inlineStateStart = state.inlineCode ?? createInlineCodeState();
    const codeSpans = buildCodeSpanIndex(input, inlineStateStart);

    // 1. Handle <think> blocks (stateful, strip content inside)
    let processed = "";
    ROBUST_THINKING_RE.lastIndex = 0;
    let lastIndex = 0;
    let inThinking = state.thinking;

    for (const match of input.matchAll(ROBUST_THINKING_RE)) {
      const idx = match.index ?? 0;
      if (codeSpans.isInside(idx)) continue;

      // If we were NOT in thinking, appending everything up to this tag
      if (!inThinking) {
        processed += input.slice(lastIndex, idx);
      }

      const isClose = match[1] === "/";
      if (!inThinking && !isClose) {
        // <think> start
        inThinking = true;
      } else if (inThinking && isClose) {
        // </think> end
        inThinking = false;
        // We do NOT append the content between start and end (it stays stripped)
      }
      // If we are inThinking, we skip content.

      lastIndex = idx + match[0].length;
    }

    // Append remaining text if not currently thinking
    if (!inThinking) {
      processed += input.slice(lastIndex);
    } else if (input.length - lastIndex > 5000) {
      // 🚨 EMERGENCY ESCAPE: If thinking exceeds 5000 chars without a close tag,
      // it's likely a hallucinated or malformed tag. Force output the rest.
      log.warn(
        `[ThinkingEscape] Forced escape from unclosed <think> tag after ${input.length - lastIndex} chars. ` +
        `This may indicate a malformed or hallucinated thinking tag.`
      );
      processed += input.slice(lastIndex);
      inThinking = false;
      state.partialTagBuffer = undefined;
    }
    state.thinking = inThinking;

    // 2. Handle <final> blocks...
    const finalCodeSpans = buildCodeSpanIndex(processed, inlineStateStart);
    if (!params.enforceFinalTag) {
      state.inlineCode = finalCodeSpans.inlineState;
      FINAL_TAG_SCAN_RE.lastIndex = 0;
      return stripTagsOutsideCodeSpans(processed, FINAL_TAG_SCAN_RE, finalCodeSpans.isInside);
    }

    // Strict Mode: If enforcing final tags, we MUST NOT return content unless
    // we have seen a <final> tag.
    let result = "";
    FINAL_TAG_SCAN_RE.lastIndex = 0;
    let lastFinalIndex = 0;
    let inFinal = state.final;
    let everInFinal = state.final;

    for (const match of processed.matchAll(FINAL_TAG_SCAN_RE)) {
      const idx = match.index ?? 0;
      if (finalCodeSpans.isInside(idx)) continue;
      const isClose = match[1] === "/";
      if (!inFinal && !isClose) {
        inFinal = true;
        everInFinal = true;
        lastFinalIndex = idx + match[0].length;
      } else if (inFinal && isClose) {
        result += processed.slice(lastFinalIndex, idx);
        inFinal = false;
        lastFinalIndex = idx + match[0].length;
      }
    }
    if (inFinal) {
      result += processed.slice(lastFinalIndex);
    }
    state.final = inFinal;

    if (!everInFinal) return "";

    const resultCodeSpans = buildCodeSpanIndex(result, inlineStateStart);
    state.inlineCode = resultCodeSpans.inlineState;
    return stripTagsOutsideCodeSpans(result, FINAL_TAG_SCAN_RE, resultCodeSpans.isInside);
  };

  const stripTagsOutsideCodeSpans = (
    text: string,
    pattern: RegExp,
    isInside: (index: number) => boolean,
  ) => {
    let output = "";
    let lastIndex = 0;
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const idx = match.index ?? 0;
      if (isInside(idx)) continue;
      output += text.slice(lastIndex, idx);
      lastIndex = idx + match[0].length;
    }
    output += text.slice(lastIndex);
    return output;
  };

  const emitBlockChunk = (text: string) => {
    if (state.suppressBlockChunks) return;
    // Strip <think> and <final> blocks across chunk boundaries to avoid leaking reasoning.
    const chunk = stripBlockTags(text, state.blockState).trimEnd();
    if (!chunk) return;
    if (chunk === state.lastBlockReplyText) return;

    // Only check committed (successful) messaging tool texts - checking pending texts
    // is risky because if the tool fails after suppression, the user gets no response
    const normalizedChunk = normalizeTextForComparison(chunk);
    if (isMessagingToolDuplicateNormalized(normalizedChunk, messagingToolSentTextsNormalized)) {
      log.debug(`Skipping block reply - already sent via messaging tool: ${chunk.slice(0, 50)}...`);
      return;
    }

    if (shouldSkipAssistantText(chunk)) return;

    state.lastBlockReplyText = chunk;
    assistantTexts.push(chunk);
    rememberAssistantText(chunk);
    if (!params.onBlockReply) return;
    const splitResult = replyDirectiveAccumulator.consume(chunk);
    if (!splitResult) return;
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = splitResult;
    // Skip empty payloads, but always emit if audioAsVoice is set (to propagate the flag)
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice) return;
    void params.onBlockReply({
      text: cleanedText,
      mediaUrls: mediaUrls?.length ? mediaUrls : undefined,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    });
  };

  const consumeReplyDirectives = (text: string, options?: { final?: boolean }) =>
    replyDirectiveAccumulator.consume(text, options);

  const flushBlockReplyBuffer = () => {
    if (!params.onBlockReply) return;
    if (blockChunker?.hasBuffered()) {
      blockChunker.drain({ force: true, emit: emitBlockChunk });
      blockChunker.reset();
      return;
    }
    if (state.blockBuffer.length > 0) {
      emitBlockChunk(state.blockBuffer);
      state.blockBuffer = "";
    }
  };

  const emitReasoningStream = (text: string) => {
    if (!state.streamReasoning || !params.onReasoningStream) return;
    const formatted = formatReasoningMessage(text);
    if (!formatted) return;
    if (formatted === state.lastStreamedReasoning) return;
    state.lastStreamedReasoning = formatted;
    void params.onReasoningStream({
      text: formatted,
    });
  };

  const resetForCompactionRetry = () => {
    assistantTexts.length = 0;
    toolMetas.length = 0;
    toolMetaById.clear();
    toolSummaryById.clear();
    state.lastToolError = undefined;
    messagingToolSentTexts.length = 0;
    messagingToolSentTextsNormalized.length = 0;
    messagingToolSentTargets.length = 0;
    pendingMessagingTexts.clear();
    pendingMessagingTargets.clear();
    resetAssistantMessageState(0);
  };

  const ctx: EmbeddedPiSubscribeContext = {
    params,
    state,
    log,
    blockChunking,
    blockChunker,
    shouldEmitToolResult,
    shouldEmitToolOutput,
    emitToolSummary,
    emitToolOutput,
    stripBlockTags,
    emitBlockChunk,
    flushBlockReplyBuffer,
    emitReasoningStream,
    consumeReplyDirectives,
    resetAssistantMessageState,
    resetForCompactionRetry,
    finalizeAssistantTexts,
    trimMessagingToolSent,
    ensureCompactionPromise,
    noteCompactionRetry,
    resolveCompactionRetry,
    maybeResolveCompactionWait,
  };

  const unsubscribe = params.session.subscribe(createEmbeddedPiSessionEventHandler(ctx));

  return {
    assistantTexts,
    toolMetas,
    unsubscribe,
    isCompacting: () => state.compactionInFlight || state.pendingCompactionRetry > 0,
    getMessagingToolSentTexts: () => messagingToolSentTexts.slice(),
    getMessagingToolSentTargets: () => messagingToolSentTargets.slice(),
    // Returns true if any messaging tool successfully sent a message.
    // Used to suppress agent's confirmation text (e.g., "Respondi no Telegram!")
    // which is generated AFTER the tool sends the actual answer.
    didSendViaMessagingTool: () => messagingToolSentTexts.length > 0,
    getLastToolError: () => (state.lastToolError ? { ...state.lastToolError } : undefined),
    waitForCompactionRetry: () => {
      // 🛡️ Compaction timeout protection: max 30 seconds
      const COMPACTION_TIMEOUT_MS = 30_000;

      const createTimeoutPromise = (basePromise: Promise<void>): Promise<void> => {
        return Promise.race([
          basePromise,
          new Promise<void>((resolve) => {
            setTimeout(() => {
              log.warn(`[CompactionTimeout] Compaction wait exceeded ${COMPACTION_TIMEOUT_MS}ms, proceeding anyway.`);
              resolve();
            }, COMPACTION_TIMEOUT_MS);
          }),
        ]);
      };

      if (state.compactionInFlight || state.pendingCompactionRetry > 0) {
        ensureCompactionPromise();
        return createTimeoutPromise(state.compactionRetryPromise ?? Promise.resolve());
      }
      return new Promise<void>((resolve) => {
        queueMicrotask(() => {
          if (state.compactionInFlight || state.pendingCompactionRetry > 0) {
            ensureCompactionPromise();
            void createTimeoutPromise(state.compactionRetryPromise ?? Promise.resolve()).then(resolve);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
