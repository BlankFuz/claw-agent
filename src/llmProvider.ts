import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { ToolPool } from './tools/index';
import { buildSystemPrompt } from './systemPrompt';
import { UsageSummary } from './costTracker';

export type Provider = 'OpenAI' | 'OpenRouter' | 'Anthropic' | 'Local';

export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}

export interface ImageAttachment {
    /** Base64-encoded image data (no data: prefix). */
    data: string;
    /** MIME type, e.g. 'image/png', 'image/jpeg'. */
    mediaType: string;
}

export interface ChatMessage {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: ToolCall[];
    toolCallId?: string;
    /** Images attached to a user message (for multimodal models). */
    images?: ImageAttachment[];
}

export interface LLMResponse {
    text?: string;
    thinking?: string;
    toolCalls?: ToolCall[];
    usage?: UsageSummary;
}

/** Callback for streaming text deltas. */
export type StreamCallback = (delta: string) => void;

/** Callback for streaming thinking deltas (extended thinking). */
export type ThinkingStreamCallback = (delta: string) => void;

export interface AskLLMOptions {
    provider: Provider;
    apiKey: string;
    messages: ChatMessage[];
    baseUrl?: string;
    model?: string;
    /** ToolPool instance — provides the LLM-facing tool definitions. */
    toolPool?: ToolPool;
    onStream?: StreamCallback;
    onThinkingStream?: ThinkingStreamCallback;
    signal?: AbortSignal;
    /** Enable extended thinking (Anthropic only). Budget in tokens (default 10000). */
    thinkingBudget?: number;
    /** Plan mode — omit tools so the model only reasons, doesn't act. */
    planMode?: boolean;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function askLLM(opts: AskLLMOptions): Promise<LLMResponse> {
    const { provider, apiKey } = opts;
    // Local provider doesn't need a real key; others do
    if (provider !== 'Local' && (!apiKey || !apiKey.trim())) {
        throw new Error('API Key is required');
    }

    if (provider === 'OpenAI' || provider === 'OpenRouter' || provider === 'Local') {
        return askOpenAI(opts);
    } else if (provider === 'Anthropic') {
        return askAnthropic(opts);
    }

    throw new Error(`Unsupported provider: ${provider}`);
}

// ---------------------------------------------------------------------------
// OpenAI / OpenRouter
// ---------------------------------------------------------------------------

async function askOpenAI(opts: AskLLMOptions): Promise<LLMResponse> {
    const { provider, apiKey, messages, baseUrl, model, onStream, signal, toolPool } = opts;
    const isRouter = provider === 'OpenRouter';
    const isLocal = provider === 'Local';

    const openai = new OpenAI({
        apiKey: apiKey || (isLocal ? 'not-needed' : ''),
        baseURL: baseUrl || (isRouter ? 'https://openrouter.ai/api/v1' : undefined),
        defaultHeaders: isRouter ? { "X-Title": "Claw Agent" } : undefined,
    });

    const systemPrompt = buildSystemPrompt(toolPool, opts.planMode);

    const toolDefs = toolPool
        ? (opts.planMode
            ? toolPool.toLLMToolDefinitions().filter(t => {
                  const spec = toolPool.getTool(t.name);
                  return spec && (spec.permissionLevel === 'read' || spec.permissionLevel === 'network');
              })
            : toolPool.toLLMToolDefinitions())
        : [];
    const openaiTools = toolDefs.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters as unknown as Record<string, unknown> }
    }));

    // Bidirectional orphan filtering: every tool_call must have a tool_result and vice versa.
    // Strict providers (e.g. Minimax) reject messages where pairs are incomplete.
    const allToolCallIds = new Set<string>();
    const allToolResultIds = new Set<string>();
    for (const m of messages) {
        if (m.role === 'assistant' && m.toolCalls) {
            for (const tc of m.toolCalls) { allToolCallIds.add(tc.id); }
        }
        if (m.role === 'tool' && m.toolCallId) {
            allToolResultIds.add(m.toolCallId);
        }
    }
    const pairedIds = new Set<string>();
    for (const id of allToolCallIds) {
        if (allToolResultIds.has(id)) { pairedIds.add(id); }
    }

    const cleanMessages = messages.filter(m => {
        // Remove orphaned tool results (no matching tool call)
        if (m.role === 'tool' && m.toolCallId && !pairedIds.has(m.toolCallId)) {
            return false;
        }
        return true;
    });

    const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: systemPrompt },
        ...cleanMessages.map(m => mapToOpenAIMessage(m, pairedIds)),
    ];

    // -- Streaming path --
    if (onStream) {
        const stream = await openai.chat.completions.create({
            model: model || (isRouter ? 'anthropic/claude-3.5-sonnet' : isLocal ? (model || 'default') : 'gpt-4o'),
            messages: openaiMessages,
            tools: openaiTools,
            tool_choice: 'auto',
            stream: true,
        });

        let text = '';
        const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map();
        let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };

        for await (const chunk of stream) {
            if (signal?.aborted) { break; }
            const delta = chunk.choices[0]?.delta;
            if (!delta) { continue; }

            if (delta.content) {
                text += delta.content;
                onStream(delta.content);
            }

            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    const existing = toolCallsMap.get(tc.index);
                    if (!existing) {
                        toolCallsMap.set(tc.index, {
                            id: tc.id || '',
                            name: tc.function?.name || '',
                            args: tc.function?.arguments || '',
                        });
                    } else {
                        if (tc.id) { existing.id = tc.id; }
                        if (tc.function?.name) { existing.name += tc.function.name; }
                        if (tc.function?.arguments) { existing.args += tc.function.arguments; }
                    }
                }
            }

            if (chunk.usage) {
                usage = { inputTokens: chunk.usage.prompt_tokens || 0, outputTokens: chunk.usage.completion_tokens || 0 };
            }
        }

        const toolCalls = Array.from(toolCallsMap.values())
            .filter(tc => tc.name)
            .map(tc => ({ id: tc.id, name: tc.name, arguments: JSON.parse(tc.args || '{}') }));

        return {
            text: text || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage,
        };
    }

    // -- Non-streaming path --
    const response = await openai.chat.completions.create({
        model: model || (isRouter ? 'anthropic/claude-3.5-sonnet' : isLocal ? (model || 'default') : 'gpt-4o'),
        messages: openaiMessages,
        tools: openaiTools,
        tool_choice: 'auto',
    });

    const firstChoice = response.choices[0];
    if (!firstChoice) {
        throw new Error('No response returned from the API');
    }

    const usage: UsageSummary = {
        inputTokens: response.usage?.prompt_tokens || 0,
        outputTokens: response.usage?.completion_tokens || 0,
    };

    const msg = firstChoice.message;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
        return {
            text: msg.content || undefined,
            toolCalls: msg.tool_calls
                .filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => tc.type === 'function')
                .map(tc => ({
                    id: tc.id,
                    name: tc.function.name,
                    arguments: JSON.parse(tc.function.arguments),
                })),
            usage,
        };
    }
    return { text: msg.content || '', usage };
}

function mapToOpenAIMessage(m: ChatMessage, pairedIds: Set<string>): OpenAI.ChatCompletionMessageParam {
    if (m.role === 'tool') {
        return { role: 'tool' as const, tool_call_id: m.toolCallId!, content: m.content };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        // Strip tool calls whose results are missing (cancelled, compacted away, etc.)
        const validCalls = m.toolCalls.filter(tc => pairedIds.has(tc.id));
        if (validCalls.length > 0) {
            return {
                role: 'assistant' as const,
                content: m.content || null,
                tool_calls: validCalls.map(tc => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                }))
            };
        }
        // All tool calls orphaned — send as plain text
        return { role: 'assistant' as const, content: m.content || '(continued)' };
    }
    // User message with images → multimodal content array
    if (m.role === 'user' && m.images && m.images.length > 0) {
        const parts: OpenAI.ChatCompletionContentPart[] = [];
        if (m.content) {
            parts.push({ type: 'text', text: m.content });
        }
        for (const img of m.images) {
            parts.push({
                type: 'image_url',
                image_url: { url: `data:${img.mediaType};base64,${img.data}` },
            });
        }
        return { role: 'user' as const, content: parts };
    }
    return { role: m.role as 'user' | 'assistant', content: m.content };
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

async function askAnthropic(opts: AskLLMOptions): Promise<LLMResponse> {
    const { apiKey, messages, baseUrl, model, onStream, onThinkingStream, signal, toolPool, thinkingBudget, planMode } = opts;

    const anthropic = new Anthropic({ apiKey, baseURL: baseUrl || undefined });

    const systemPrompt = buildSystemPrompt(toolPool, planMode);

    // In plan mode, keep only read-only tools for codebase exploration
    const toolDefs = toolPool
        ? (planMode
            ? toolPool.toLLMToolDefinitions().filter(t => {
                  const spec = toolPool.getTool(t.name);
                  return spec && (spec.permissionLevel === 'read' || spec.permissionLevel === 'network');
              })
            : toolPool.toLLMToolDefinitions())
        : [];
    const anthropicTools: Anthropic.Tool[] = toolDefs.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));

    const anthropicMessages = buildAnthropicMessages(messages);

    const useThinking = !!thinkingBudget && thinkingBudget > 0;
    const resolvedModel = model || 'claude-sonnet-4-20250514';

    // Build request params — extended thinking requires different shape
    const baseParams: Record<string, unknown> = {
        model: resolvedModel,
        system: systemPrompt,
        messages: anthropicMessages,
    };

    if (anthropicTools.length > 0) {
        baseParams.tools = anthropicTools;
    }

    if (useThinking) {
        // Extended thinking mode: generous budget so the model can reason deeply
        baseParams.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
        baseParams.max_tokens = Math.max(64000, thinkingBudget + 16384);
    } else {
        baseParams.max_tokens = 16384;
    }

    // -- Streaming path --
    if (onStream) {
        const stream = anthropic.messages.stream(baseParams as Parameters<typeof anthropic.messages.stream>[0]);

        let text = '';
        let thinking = '';
        const toolCalls: ToolCall[] = [];
        let currentToolId = '';
        let currentToolName = '';
        let currentToolInput = '';
        let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };

        // Use streamEvent for correct ordering — content_block_start fires
        // BEFORE input_json_delta, so we can set up the tool ID first.
        stream.on('streamEvent', (event) => {
            if (signal?.aborted) { return; }

            switch (event.type) {
                case 'content_block_start': {
                    const block = event.content_block;
                    if (block.type === 'tool_use') {
                        // Flush previous tool if any
                        if (currentToolId) {
                            toolCalls.push({ id: currentToolId, name: currentToolName, arguments: JSON.parse(currentToolInput || '{}') });
                        }
                        currentToolId = block.id;
                        currentToolName = block.name;
                        currentToolInput = '';
                    }
                    break;
                }
                case 'content_block_delta': {
                    const delta = event.delta as unknown as Record<string, string>;
                    if (delta.type === 'thinking_delta' && delta.thinking) {
                        thinking += delta.thinking;
                        onThinkingStream?.(delta.thinking);
                    } else if (delta.type === 'text_delta' && delta.text) {
                        text += delta.text;
                        onStream(delta.text);
                    } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                        currentToolInput += delta.partial_json;
                    }
                    break;
                }
                case 'content_block_stop': {
                    // Flush tool when its block ends
                    if (currentToolId) {
                        toolCalls.push({ id: currentToolId, name: currentToolName, arguments: JSON.parse(currentToolInput || '{}') });
                        currentToolId = '';
                        currentToolName = '';
                        currentToolInput = '';
                    }
                    break;
                }
            }
        });

        const finalMessage = await stream.finalMessage();

        // Fallback: extract from final message if streaming missed anything
        if (toolCalls.length === 0) {
            for (const block of finalMessage.content) {
                if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        name: block.name,
                        arguments: block.input as Record<string, unknown>,
                    });
                }
            }
        }
        if (!thinking) {
            for (const block of finalMessage.content) {
                if (block.type === 'thinking') {
                    const thinkBlock = block as { type: 'thinking'; thinking: string };
                    if (thinkBlock.thinking) {
                        thinking = thinkBlock.thinking;
                    }
                }
            }
        }
        if (!text) {
            for (const block of finalMessage.content) {
                if (block.type === 'text') {
                    text += block.text;
                }
            }
        }

        usage = {
            inputTokens: finalMessage.usage?.input_tokens || 0,
            outputTokens: finalMessage.usage?.output_tokens || 0,
        };

        return {
            text: text || undefined,
            thinking: thinking || undefined,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage,
        };
    }

    // -- Non-streaming path --
    const response = await anthropic.messages.create(baseParams as unknown as Anthropic.MessageCreateParams) as Anthropic.Message;

    const usage: UsageSummary = {
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
    };

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const thinkingBlocks = response.content.filter((b: { type: string }) => b.type === 'thinking') as Array<{ type: 'thinking'; thinking: string }>;
    const thinkingText = thinkingBlocks.map(t => t.thinking).join('\n') || undefined;

    if (toolUses.length > 0) {
        return {
            text: textBlocks.map(t => t.text).join('\n') || undefined,
            thinking: thinkingText,
            toolCalls: toolUses.map(tu => ({
                id: tu.id,
                name: tu.name,
                arguments: tu.input as Record<string, unknown>,
            })),
            usage,
        };
    }

    return { text: textBlocks.map(t => t.text).join('\n') || '', thinking: thinkingText, usage };
}

/** Ensure a tool ID matches Anthropic's required pattern: ^[a-zA-Z0-9_-]+$ */
function sanitizeToolId(id: string): string {
    if (!id) { return 'toolu_' + Date.now().toString(36); }
    // Replace any invalid chars with underscore
    const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return sanitized || 'toolu_' + Date.now().toString(36);
}

function buildAnthropicMessages(messages: ChatMessage[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    // Build lookup sets for bidirectional validation:
    // Every tool_use must have a tool_result, and vice versa.
    const allToolUseIds = new Set<string>();
    const allToolResultIds = new Set<string>();
    for (const m of messages) {
        if (m.role === 'assistant' && m.toolCalls) {
            for (const tc of m.toolCalls) { allToolUseIds.add(sanitizeToolId(tc.id)); }
        }
        if (m.role === 'tool' && m.toolCallId) {
            allToolResultIds.add(sanitizeToolId(m.toolCallId));
        }
    }
    // IDs that have both a tool_use and a tool_result are valid pairs
    const pairedIds = new Set<string>();
    for (const id of allToolUseIds) {
        if (allToolResultIds.has(id)) { pairedIds.add(id); }
    }

    for (const m of messages) {
        // Skip orphaned tool results whose tool_use_id has no corresponding assistant tool_use
        if (m.role === 'tool' && m.toolCallId && !pairedIds.has(sanitizeToolId(m.toolCallId))) {
            continue;
        }
        if (m.role === 'tool') {
            const block: Anthropic.ToolResultBlockParam = {
                type: 'tool_result',
                tool_use_id: sanitizeToolId(m.toolCallId!),
                content: m.content,
            };
            const lastMsg = result[result.length - 1];
            if (lastMsg && lastMsg.role === 'user') {
                if (Array.isArray(lastMsg.content)) {
                    lastMsg.content.push(block);
                } else {
                    lastMsg.content = [{ type: 'text', text: lastMsg.content as string }, block];
                }
            } else {
                result.push({ role: 'user', content: [block] });
            }
        } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
            // Only include tool_uses that have matching tool_results
            const validToolCalls = m.toolCalls.filter(tc => pairedIds.has(sanitizeToolId(tc.id)));
            const blocks: Anthropic.ContentBlockParam[] = [];
            if (m.content) { blocks.push({ type: 'text', text: m.content }); }
            blocks.push(...validToolCalls.map(tc => ({
                type: 'tool_use' as const,
                id: sanitizeToolId(tc.id),
                name: tc.name,
                input: tc.arguments as Record<string, unknown>,
            })));
            // If all tool_uses were stripped, just push as text-only assistant message
            if (blocks.length === 0) {
                blocks.push({ type: 'text', text: m.content || '(continued)' });
            }
            result.push({ role: 'assistant', content: blocks });
        } else {
            // Build content blocks — include images for user messages
            const blocks: Anthropic.ContentBlockParam[] = [];
            if (m.content) {
                blocks.push({ type: 'text', text: m.content });
            }
            if (m.role === 'user' && m.images && m.images.length > 0) {
                for (const img of m.images) {
                    blocks.push({
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: img.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                            data: img.data,
                        },
                    });
                }
            }

            const hasMultiContent = blocks.length > 1 || (m.images && m.images.length > 0);

            const lastMsg = result[result.length - 1];
            if (lastMsg && lastMsg.role === m.role) {
                if (Array.isArray(lastMsg.content)) {
                    lastMsg.content.push(...blocks);
                } else {
                    lastMsg.content = [
                        { type: 'text', text: lastMsg.content as string },
                        ...blocks,
                    ];
                }
            } else if (hasMultiContent) {
                result.push({ role: m.role as 'user' | 'assistant', content: blocks });
            } else {
                result.push({ role: m.role as 'user' | 'assistant', content: m.content });
            }
        }
    }

    return result;
}
