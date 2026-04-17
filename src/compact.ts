/**
 * Structured Compaction Module
 *
 * Ported from claw-code-main Rust implementation (compact.rs).
 *
 * Generates deterministic, structured summaries of conversation history
 * without requiring an LLM call. Summaries merge across multiple
 * compactions so context accumulates rather than being lost.
 */

import { ChatMessage } from './llmProvider';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPACT_CONTINUATION_PREAMBLE =
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n';

const COMPACT_RECENT_MESSAGES_NOTE = 'Recent messages are preserved verbatim.';

const COMPACT_DIRECT_RESUME_INSTRUCTION =
    'Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, and do not preface with continuation text.';

/** Max chars per content block in timeline summaries. */
const BLOCK_SUMMARY_MAX_CHARS = 160;

/** Max key files to extract. */
const MAX_KEY_FILES = 8;

// ---------------------------------------------------------------------------
// Config & Result types
// ---------------------------------------------------------------------------

export interface CompactionConfig {
    /** Number of recent messages to keep verbatim after compaction. */
    preserveRecentMessages: number;
    /** Minimum estimated tokens before compaction is worthwhile. */
    maxEstimatedTokens: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
    preserveRecentMessages: 4,
    maxEstimatedTokens: 10_000,
};

export interface CompactionResult {
    summary: string;
    formattedSummary: string;
    compactedHistory: ChatMessage[];
    removedMessageCount: number;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/** Estimate tokens for a single message (~4 chars per token). */
function estimateMessageTokens(msg: ChatMessage): number {
    let chars = (msg.content || '').length;
    if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
            chars += tc.name.length + JSON.stringify(tc.arguments).length;
        }
    }
    return Math.floor(chars / 4) + 1;
}

/** Estimate total tokens for a message array. */
export function estimateSessionTokens(messages: ChatMessage[]): number {
    return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ---------------------------------------------------------------------------
// Compaction decision
// ---------------------------------------------------------------------------

/** Check whether a session should be compacted. */
export function shouldCompact(messages: ChatMessage[], config: CompactionConfig): boolean {
    const start = compactedSummaryPrefixLen(messages);
    const compactable = messages.slice(start);

    return (
        compactable.length > config.preserveRecentMessages &&
        estimateSessionTokens(compactable) >= config.maxEstimatedTokens
    );
}

// ---------------------------------------------------------------------------
// Main compaction entry point
// ---------------------------------------------------------------------------

/**
 * Compact a message history into a structured summary + recent messages.
 *
 * This is deterministic — no LLM call needed. The summary preserves:
 *   - Scope (message counts by role)
 *   - All tool names used
 *   - Last 3 user requests
 *   - Pending/TODO work inferred from keywords
 *   - Key file paths referenced
 *   - Current work state
 *   - Per-message timeline (each truncated to 160 chars)
 *
 * When compacting on top of a previous compaction, the old summary is
 * preserved as "Previously compacted context" so information accumulates.
 */
export function compactSession(
    messages: ChatMessage[],
    config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): CompactionResult {
    if (!shouldCompact(messages, config)) {
        return {
            summary: '',
            formattedSummary: '',
            compactedHistory: [...messages],
            removedMessageCount: 0,
        };
    }

    const existingSummary = extractExistingCompactedSummary(messages);
    const prefixLen = existingSummary ? 1 : 0;
    const keepFrom = Math.max(prefixLen, messages.length - config.preserveRecentMessages);

    // Find a clean user-message boundary for the cut
    let cutPoint = keepFrom;
    const maxWalk = cutPoint + Math.floor(config.preserveRecentMessages / 2);
    while (cutPoint < maxWalk && cutPoint < messages.length && messages[cutPoint].role !== 'user') {
        cutPoint++;
    }
    if (cutPoint >= messages.length) {
        cutPoint = Math.max(prefixLen, messages.length - config.preserveRecentMessages);
    }

    const removed = messages.slice(prefixLen, cutPoint);
    const preserved = messages.slice(cutPoint);

    const rawSummary = mergeCompactSummaries(
        existingSummary,
        summarizeMessages(removed),
    );
    const formattedSummary = formatCompactSummary(rawSummary);
    const continuation = getCompactContinuationMessage(rawSummary, true, preserved.length > 0);

    const compactedHistory: ChatMessage[] = [
        { role: 'user', content: continuation },
        ...preserved,
    ];

    return {
        summary: rawSummary,
        formattedSummary,
        compactedHistory,
        removedMessageCount: removed.length,
    };
}

// ---------------------------------------------------------------------------
// Summary generation
// ---------------------------------------------------------------------------

function summarizeMessages(messages: ChatMessage[]): string {
    const userCount = messages.filter(m => m.role === 'user').length;
    const assistantCount = messages.filter(m => m.role === 'assistant').length;
    const toolCount = messages.filter(m => m.role === 'tool').length;

    // Collect unique tool names
    const toolNames = new Set<string>();
    for (const m of messages) {
        if (m.toolCalls) {
            for (const tc of m.toolCalls) {
                toolNames.add(tc.name);
            }
        }
    }
    const sortedToolNames = [...toolNames].sort();

    const lines: string[] = [
        '<summary>',
        'Conversation summary:',
        `- Scope: ${messages.length} earlier messages compacted (user=${userCount}, assistant=${assistantCount}, tool=${toolCount}).`,
    ];

    if (sortedToolNames.length > 0) {
        lines.push(`- Tools used: ${sortedToolNames.join(', ')}.`);
    }

    // Recent user requests (last 3)
    const recentUserRequests = collectRecentRoleSummaries(messages, 'user', 3);
    if (recentUserRequests.length > 0) {
        lines.push('- Recent user requests:');
        for (const req of recentUserRequests) {
            lines.push(`  - ${req}`);
        }
    }

    // Pending work
    const pending = inferPendingWork(messages);
    if (pending.length > 0) {
        lines.push('- Pending work:');
        for (const item of pending) {
            lines.push(`  - ${item}`);
        }
    }

    // Key files
    const keyFiles = collectKeyFiles(messages);
    if (keyFiles.length > 0) {
        lines.push(`- Key files referenced: ${keyFiles.join(', ')}.`);
    }

    // Current work
    const currentWork = inferCurrentWork(messages);
    if (currentWork) {
        lines.push(`- Current work: ${currentWork}`);
    }

    // Key timeline — per-message summary
    lines.push('- Key timeline:');
    for (const m of messages) {
        const role = m.role;
        const content = summarizeMessageContent(m);
        lines.push(`  - ${role}: ${content}`);
    }

    lines.push('</summary>');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Summary merging (nested compaction)
// ---------------------------------------------------------------------------

function mergeCompactSummaries(
    existingSummary: string | null,
    newSummary: string,
): string {
    if (!existingSummary) {
        return newSummary;
    }

    const previousHighlights = extractSummaryHighlights(existingSummary);
    const newFormatted = formatCompactSummary(newSummary);
    const newHighlights = extractSummaryHighlights(newFormatted);
    const newTimeline = extractSummaryTimeline(newFormatted);

    const lines: string[] = ['<summary>', 'Conversation summary:'];

    if (previousHighlights.length > 0) {
        lines.push('- Previously compacted context:');
        for (const line of previousHighlights) {
            lines.push(`  ${line}`);
        }
    }

    if (newHighlights.length > 0) {
        lines.push('- Newly compacted context:');
        for (const line of newHighlights) {
            lines.push(`  ${line}`);
        }
    }

    if (newTimeline.length > 0) {
        lines.push('- Key timeline:');
        for (const line of newTimeline) {
            lines.push(`  ${line}`);
        }
    }

    lines.push('</summary>');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCompactSummary(summary: string): string {
    let result = stripTagBlock(summary, 'analysis');
    const content = extractTagBlock(result, 'summary');
    if (content !== null) {
        result = result.replace(
            `<summary>${content}</summary>`,
            `Summary:\n${content.trim()}`,
        );
    }
    return collapseBlankLines(result).trim();
}

function getCompactContinuationMessage(
    summary: string,
    suppressFollowUp: boolean,
    recentMessagesPreserved: boolean,
): string {
    let base = `${COMPACT_CONTINUATION_PREAMBLE}${formatCompactSummary(summary)}`;

    if (recentMessagesPreserved) {
        base += `\n\n${COMPACT_RECENT_MESSAGES_NOTE}`;
    }
    if (suppressFollowUp) {
        base += `\n${COMPACT_DIRECT_RESUME_INSTRUCTION}`;
    }
    return base;
}

// ---------------------------------------------------------------------------
// Content extraction helpers
// ---------------------------------------------------------------------------

function summarizeMessageContent(msg: ChatMessage): string {
    const parts: string[] = [];
    if (msg.content) {
        parts.push(msg.content);
    }
    if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
            const argsStr = JSON.stringify(tc.arguments).substring(0, 100);
            parts.push(`tool_use ${tc.name}(${argsStr})`);
        }
    }
    return truncateSummary(parts.join(' | '), BLOCK_SUMMARY_MAX_CHARS);
}

function collectRecentRoleSummaries(
    messages: ChatMessage[],
    role: string,
    limit: number,
): string[] {
    const matches = messages
        .filter(m => m.role === role && m.content?.trim())
        .slice(-limit)
        .map(m => truncateSummary(m.content, BLOCK_SUMMARY_MAX_CHARS));
    return matches;
}

function inferPendingWork(messages: ChatMessage[]): string[] {
    const keywords = ['todo', 'next', 'pending', 'follow up', 'remaining'];
    const results: string[] = [];
    // Walk backwards
    for (let i = messages.length - 1; i >= 0 && results.length < 3; i--) {
        const text = messages[i].content;
        if (!text) { continue; }
        const lower = text.toLowerCase();
        if (keywords.some(kw => lower.includes(kw))) {
            results.push(truncateSummary(text, BLOCK_SUMMARY_MAX_CHARS));
        }
    }
    return results.reverse();
}

function collectKeyFiles(messages: ChatMessage[]): string[] {
    const allText: string[] = [];
    for (const m of messages) {
        if (m.content) { allText.push(m.content); }
        if (m.toolCalls) {
            for (const tc of m.toolCalls) {
                allText.push(JSON.stringify(tc.arguments));
            }
        }
    }

    const files = new Set<string>();
    const fileExtensions = ['ts', 'tsx', 'js', 'jsx', 'json', 'md', 'py', 'rs', 'toml', 'yaml', 'yml', 'css', 'html', 'vue', 'svelte'];
    const extPattern = new RegExp(`\\.(${fileExtensions.join('|')})$`, 'i');

    for (const text of allText) {
        // Split on whitespace and common delimiters
        const tokens = text.split(/[\s,;'"`)(\[\]{}]+/);
        for (const raw of tokens) {
            // Clean up surrounding punctuation
            const candidate = raw.replace(/^[,.:;'"()]+|[,.:;'"()]+$/g, '');
            if (candidate.includes('/') && extPattern.test(candidate)) {
                files.add(candidate);
                if (files.size >= MAX_KEY_FILES) { break; }
            }
        }
        if (files.size >= MAX_KEY_FILES) { break; }
    }

    return [...files].sort();
}

function inferCurrentWork(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const text = messages[i].content?.trim();
        if (text) {
            return truncateSummary(text, 200);
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Existing summary detection (for nested compaction)
// ---------------------------------------------------------------------------

function compactedSummaryPrefixLen(messages: ChatMessage[]): number {
    return extractExistingCompactedSummary(messages) ? 1 : 0;
}

function extractExistingCompactedSummary(messages: ChatMessage[]): string | null {
    if (messages.length === 0) { return null; }
    const first = messages[0];
    if (first.role !== 'user') { return null; }
    const text = first.content || '';
    if (!text.startsWith(COMPACT_CONTINUATION_PREAMBLE.trimEnd())) { return null; }

    // Extract just the summary portion (strip preamble and trailing notes)
    let summary = text.substring(COMPACT_CONTINUATION_PREAMBLE.length);
    const recentIdx = summary.indexOf(`\n\n${COMPACT_RECENT_MESSAGES_NOTE}`);
    if (recentIdx >= 0) { summary = summary.substring(0, recentIdx); }
    const resumeIdx = summary.indexOf(`\n${COMPACT_DIRECT_RESUME_INSTRUCTION}`);
    if (resumeIdx >= 0) { summary = summary.substring(0, resumeIdx); }
    return summary.trim() || null;
}

// ---------------------------------------------------------------------------
// Tag extraction helpers (for parsing <summary>...</summary> blocks)
// ---------------------------------------------------------------------------

function extractTagBlock(content: string, tag: string): string | null {
    const start = `<${tag}>`;
    const end = `</${tag}>`;
    const startIdx = content.indexOf(start);
    if (startIdx < 0) { return null; }
    const contentStart = startIdx + start.length;
    const endIdx = content.indexOf(end, contentStart);
    if (endIdx < 0) { return null; }
    return content.substring(contentStart, endIdx);
}

function stripTagBlock(content: string, tag: string): string {
    const start = `<${tag}>`;
    const end = `</${tag}>`;
    const startIdx = content.indexOf(start);
    if (startIdx < 0) { return content; }
    const endIdx = content.indexOf(end, startIdx + start.length);
    if (endIdx < 0) { return content; }
    return content.substring(0, startIdx) + content.substring(endIdx + end.length);
}

function extractSummaryHighlights(summary: string): string[] {
    const lines: string[] = [];
    let inTimeline = false;
    const formatted = formatCompactSummary(summary);

    for (const rawLine of formatted.split('\n')) {
        const line = rawLine.trimEnd();
        if (!line || line === 'Summary:' || line === 'Conversation summary:') { continue; }
        if (line === '- Key timeline:') {
            inTimeline = true;
            continue;
        }
        if (inTimeline) { continue; }
        lines.push(line);
    }
    return lines;
}

function extractSummaryTimeline(summary: string): string[] {
    const lines: string[] = [];
    let inTimeline = false;
    const formatted = formatCompactSummary(summary);

    for (const rawLine of formatted.split('\n')) {
        const line = rawLine.trimEnd();
        if (line === '- Key timeline:') {
            inTimeline = true;
            continue;
        }
        if (!inTimeline) { continue; }
        if (!line) { break; }
        lines.push(line);
    }
    return lines;
}

// ---------------------------------------------------------------------------
// String utilities
// ---------------------------------------------------------------------------

function truncateSummary(content: string, maxChars: number): string {
    if (content.length <= maxChars) { return content; }
    return content.substring(0, maxChars) + '…';
}

function collapseBlankLines(content: string): string {
    const result: string[] = [];
    let lastBlank = false;
    for (const line of content.split('\n')) {
        const isBlank = line.trim() === '';
        if (isBlank && lastBlank) { continue; }
        result.push(line);
        lastBlank = isBlank;
    }
    return result.join('\n');
}

// ---------------------------------------------------------------------------
// Context budget enforcement (Priority 2)
// ---------------------------------------------------------------------------

/** Reserve tokens for output so we don't fill the entire context window. */
const OUTPUT_RESERVATION = 16_384;
/** Safety buffer to avoid edge cases at the exact limit. */
const BUDGET_BUFFER = 2_000;

/**
 * Get the effective input context limit, accounting for output reservation.
 * This is the maximum number of input tokens we should send to the model.
 */
export function getEffectiveContextLimit(contextWindowSize: number): number {
    return Math.max(0, contextWindowSize - OUTPUT_RESERVATION - BUDGET_BUFFER);
}

/**
 * Check whether the last known input token count exceeds the safe limit.
 * Used as a pre-flight check before sending the next request.
 */
export function isOverBudget(lastInputTokens: number, contextWindowSize: number): boolean {
    return lastInputTokens >= getEffectiveContextLimit(contextWindowSize);
}

// ---------------------------------------------------------------------------
// Tool result pruning (Priority 4)
// ---------------------------------------------------------------------------

/** Tokens worth of tool results to protect from pruning (most recent). */
const PRUNE_PROTECT_TOKENS = 40_000;

/** Stub text for pruned tool results. */
function pruneStub(originalChars: number): string {
    return `[Tool output pruned — was ${Math.round(originalChars / 1000)}k chars. Re-run the tool if this context is needed.]`;
}

/**
 * Prune older tool results to free context space.
 *
 * Walks messages newest → oldest. The most recent tool results (up to
 * PRUNE_PROTECT_TOKENS) are kept intact. Older tool results are replaced
 * with a short stub. Tool results whose name appears in `protectedTools`
 * are never pruned.
 *
 * Returns a shallow-copied message array with only the content strings
 * of pruned messages changed.
 */
export function pruneToolResults(
    messages: ChatMessage[],
    protectedTools?: Set<string>,
): ChatMessage[] {
    // First pass: identify tool result messages and their estimated tokens, newest first
    const toolResultIndices: number[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'tool') {
            toolResultIndices.push(i);
        }
    }

    if (toolResultIndices.length === 0) { return messages; }

    // Build a map from toolCallId → tool name for protection checks
    const toolIdToName = new Map<string, string>();
    if (protectedTools && protectedTools.size > 0) {
        for (const m of messages) {
            if (m.role === 'assistant' && m.toolCalls) {
                for (const tc of m.toolCalls) {
                    toolIdToName.set(tc.id, tc.name);
                }
            }
        }
    }

    // Second pass: keep recent tool results, prune older ones
    let protectedTokens = 0;
    const indicesToPrune = new Set<number>();

    for (const idx of toolResultIndices) {
        const msg = messages[idx];
        const tokens = estimateMessageTokens(msg);

        // Check if this tool is protected by name
        if (protectedTools && msg.toolCallId) {
            const toolName = toolIdToName.get(msg.toolCallId);
            if (toolName && protectedTools.has(toolName)) {
                continue; // Never prune protected tools
            }
        }

        if (protectedTokens < PRUNE_PROTECT_TOKENS) {
            protectedTokens += tokens;
            continue; // Within protection window
        }

        // Only prune if the result is large enough to matter (> 500 chars)
        if (msg.content.length > 500) {
            indicesToPrune.add(idx);
        }
    }

    if (indicesToPrune.size === 0) { return messages; }

    // Build pruned copy
    return messages.map((m, i) => {
        if (indicesToPrune.has(i)) {
            return { ...m, content: pruneStub(m.content.length) };
        }
        return m;
    });
}

// ---------------------------------------------------------------------------
// LLM-based compaction (Priority 3)
// ---------------------------------------------------------------------------

const LLM_COMPACT_SYSTEM_PROMPT = `You are a conversation summarizer. Your task is to create a detailed, structured summary of the conversation so that a new instance of the assistant can continue seamlessly.

Write the summary in this exact structure:

<summary>
1. **Primary Request and Intent**: What the user originally asked for and why.
2. **Key Technical Concepts**: Important technologies, patterns, APIs, or architectural decisions discussed.
3. **Files and Code Sections**: Specific files modified or discussed, with key details about changes.
4. **Errors and Fixes**: Any errors encountered and how they were resolved.
5. **Problem Solving**: Important decisions, trade-offs, or debugging steps taken.
6. **All User Messages**: Brief summary of every user message to preserve the full conversation arc.
7. **Pending Tasks**: Any work that was mentioned but not completed.
8. **Current Work**: What was being actively worked on when this summary was created.
9. **Optional Next Step**: If the conversation has a natural next action.
</summary>

Rules:
- Be specific: include file paths, function names, variable names, line numbers where relevant.
- Preserve all user instructions and preferences mentioned in the conversation.
- Include code snippets only when they are essential to understanding (keep them short).
- If the conversation contains multiple topics, cover all of them.
- The summary should be detailed enough that the assistant can continue without asking the user to repeat anything.`;

/**
 * Callback type for LLM calls during compaction.
 * This avoids circular dependency with llmProvider.
 */
export type LLMCompactCallback = (
    systemPrompt: string,
    userPrompt: string,
) => Promise<string>;

/**
 * LLM-based compaction: uses an LLM to produce a rich structured summary.
 *
 * Falls back to deterministic compaction if the LLM call fails.
 */
export async function compactSessionWithLLM(
    messages: ChatMessage[],
    llmCall: LLMCompactCallback,
    config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): Promise<CompactionResult> {
    const start = compactedSummaryPrefixLen(messages);
    const keep = config.preserveRecentMessages;
    const cutoff = Math.max(start, messages.length - keep);

    if (cutoff <= start) {
        return { summary: '', formattedSummary: '', compactedHistory: messages, removedMessageCount: 0 };
    }

    const messagesToSummarize = messages.slice(start, cutoff);
    const recentMessages = messages.slice(cutoff);

    // Build a text representation of the conversation for the LLM
    const conversationText = messagesToSummarize.map(m => {
        const prefix = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : `Tool(${m.toolCallId || '?'})`;
        let content = m.content || '';
        // Truncate very long messages
        if (content.length > 3000) {
            content = content.substring(0, 3000) + '\n[...truncated...]';
        }
        // Include tool call info
        if (m.toolCalls && m.toolCalls.length > 0) {
            const toolNames = m.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments).substring(0, 200)})`).join(', ');
            content += `\n[Tool calls: ${toolNames}]`;
        }
        return `### ${prefix}\n${content}`;
    }).join('\n\n');

    // Check if there was a previous compaction summary
    let previousContext = '';
    if (start > 0 && messages[0].role === 'user' && messages[0].content.includes('Summary')) {
        previousContext = `\n\nNote: This conversation was previously compacted. The earlier summary was:\n${messages[0].content.substring(0, 2000)}`;
    }

    const userPrompt = `Summarize the following conversation:${previousContext}\n\n---\n\n${conversationText}`;

    try {
        const llmSummary = await llmCall(LLM_COMPACT_SYSTEM_PROMPT, userPrompt);

        // Extract content from <summary> tags if present
        const summaryMatch = llmSummary.match(/<summary>([\s\S]*?)<\/summary>/);
        const summary = summaryMatch ? summaryMatch[1].trim() : llmSummary.trim();

        const formattedSummary = COMPACT_CONTINUATION_PREAMBLE + 'Summary:\n\n' + summary;

        const compactedHistory = getCompactContinuationMessage(formattedSummary, recentMessages);

        return {
            summary,
            formattedSummary,
            compactedHistory,
            removedMessageCount: messagesToSummarize.length,
        };
    } catch (err) {
        // Re-throw so the caller can decide whether to fall back or show an error
        throw err;
    }
}
