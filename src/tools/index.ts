/**
 * ToolPool Assembly
 *
 * Ported from claw-code-main harness: tool_pool.py / assemble_tool_pool()
 *
 * This is the single entry point for the tool system. It:
 *   1. Collects all ToolSpec definitions from category modules
 *   2. Filters by platform (e.g. PowerShell only on Windows)
 *   3. Applies permission gating
 *   4. Provides execute() dispatch with confirmation modals
 *   5. Exposes the LLM-facing tool schema for function calling
 */

import * as vscode from 'vscode';
import { ToolSpec, ToolContext, ToolParametersSchema, PermissionLevel } from './types';
import { ToolPermissionContext } from '../permissions';

// Import all tool modules
import { shellTools } from './shell';
import { fileTools } from './file';
import { searchTools } from './search';
import { lspTools } from './lsp';
import { webTools } from './web';
import { agentTools } from './agent';
import { taskTools } from './task';
import { communicationTools } from './communication';
import { worktreeTools } from './worktree';

// Re-export types
export { ToolSpec, ToolContext, ToolParametersSchema, PermissionLevel } from './types';
export { safeResolvePath, extractFilePath } from './file';

// ---------------------------------------------------------------------------
// All registered tools
// ---------------------------------------------------------------------------

const ALL_TOOLS: ToolSpec[] = [
    ...shellTools,
    ...fileTools,
    ...searchTools,
    ...lspTools,
    ...webTools,
    ...agentTools,
    ...taskTools,
    ...communicationTools,
    ...worktreeTools,
];

// ---------------------------------------------------------------------------
// ToolPool
// ---------------------------------------------------------------------------

export interface ToolPoolOptions {
    /** Permission context for gating tools. */
    permissions?: ToolPermissionContext;
    /** Only include tools with these permission levels. */
    allowedLevels?: PermissionLevel[];
    /** Exclude specific tool names. */
    excludeNames?: string[];
}

export class ToolPool {
    private readonly _tools: ToolSpec[];
    private readonly _toolMap: Map<string, ToolSpec>;
    private readonly _permissions: ToolPermissionContext;
    private readonly _turnState: Map<string, unknown>;

    constructor(options: ToolPoolOptions = {}) {
        const { permissions, allowedLevels, excludeNames } = options;
        this._permissions = permissions ?? new ToolPermissionContext();
        this._turnState = new Map();

        // Filter tools
        let tools = ALL_TOOLS.filter(t => {
            // Platform filter
            if (t.platforms && !t.platforms.includes(process.platform as NodeJS.Platform)) {
                return false;
            }
            // Name exclusion
            if (excludeNames?.includes(t.name)) {
                return false;
            }
            // Permission level filter
            if (allowedLevels && !allowedLevels.includes(t.permissionLevel)) {
                return false;
            }
            // Permission context (deny by name/prefix)
            if (this._permissions.blocks(t.name)) {
                return false;
            }
            return true;
        });

        this._tools = tools;
        this._toolMap = new Map(tools.map(t => [t.name, t]));

        // Inject allTools into turnState for ToolSearch
        this._turnState.set('allTools', ALL_TOOLS);
    }

    /** Get all active tools (for the LLM function-calling schema). */
    get tools(): readonly ToolSpec[] {
        return this._tools;
    }

    /** Get turn state map (shared across tool calls). */
    get turnState(): Map<string, unknown> {
        return this._turnState;
    }

    /** Number of active tools. */
    get size(): number {
        return this._tools.length;
    }

    /** Look up a tool by name. */
    getTool(name: string): ToolSpec | undefined {
        return this._toolMap.get(name);
    }

    /**
     * Generate the LLM-facing tool definitions.
     * Format compatible with both OpenAI and Anthropic function calling.
     */
    toLLMToolDefinitions(): Array<{ name: string; description: string; parameters: ToolParametersSchema }> {
        return this._tools.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
        }));
    }

    /**
     * Execute a tool by name with the given arguments.
     *
     * Handles:
     *   - Tool lookup
     *   - Permission checking
     *   - User confirmation (if requiresConfirmation)
     *   - Execution with context
     *   - Error wrapping
     */
    async execute(
        name: string,
        args: Record<string, unknown>,
        ctx: Partial<ToolContext>,
    ): Promise<string> {
        const tool = this._toolMap.get(name);
        if (!tool) {
            return `Unknown tool: ${name}. Use ToolSearch to find available tools.`;
        }

        // Permission check
        const denial = this._permissions.check(name);
        if (denial) {
            return `Permission denied: ${denial.reason}`;
        }

        // Confirmation — skip if auto-approve is on, else ask in chat or modal
        if (tool.requiresConfirmation && !ctx.autoApprove) {
            const summary = this._summarizeArgs(name, args);
            if (ctx.confirmInChat) {
                const allowed = await ctx.confirmInChat(name, summary, args);
                if (!allowed) {
                    return `User denied ${name}: ${summary}`;
                }
            } else {
                const confirm = await vscode.window.showWarningMessage(
                    `Agent wants to ${name}: ${summary}`,
                    { modal: true },
                    'Allow',
                );
                if (confirm !== 'Allow') {
                    return `User denied ${name}: ${summary}`;
                }
            }
        }

        // Build full context
        const fullCtx: ToolContext = {
            workspaceRoot: ctx.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
            extensionContext: ctx.extensionContext,
            signal: ctx.signal,
            postMessage: ctx.postMessage,
            turnState: this._turnState,
        };

        try {
            return await tool.execute(args, fullCtx);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return `Tool "${name}" failed: ${message}`;
        }
    }

    /** Format tool args into a short confirmation string. */
    private _summarizeArgs(name: string, args: Record<string, unknown>): string {
        switch (name) {
            case 'bash':
            case 'PowerShell':
                return String(args.command || '').substring(0, 100);
            case 'write_file':
                return String(args.path || 'unknown file');
            case 'REPL':
                return `${args.language}: ${String(args.code || '').substring(0, 80)}`;
            default:
                return JSON.stringify(args).substring(0, 100);
        }
    }

    /** Set a value on the turn state (available to all tools). */
    setTurnState(key: string, value: unknown): void {
        this._turnState.set(key, value);
    }

    /** Reset turn state between user messages. */
    resetTurn(): void {
        // Preserve persistent state across turns, clear everything else
        const allTools = this._turnState.get('allTools');
        const config = this._turnState.get('config');
        const backgroundTasks = this._turnState.get('backgroundTasks');
        const worktree = this._turnState.get('worktree');
        const skillManager = this._turnState.get('skillManager');
        const mempalace = this._turnState.get('mempalace');
        this._turnState.clear();
        if (allTools) { this._turnState.set('allTools', allTools); }
        if (config) { this._turnState.set('config', config); }
        if (backgroundTasks) { this._turnState.set('backgroundTasks', backgroundTasks); }
        if (worktree) { this._turnState.set('worktree', worktree); }
        if (skillManager) { this._turnState.set('skillManager', skillManager); }
        if (mempalace) { this._turnState.set('mempalace', mempalace); }
    }
}

// ---------------------------------------------------------------------------
// Factory — default pool
// ---------------------------------------------------------------------------

export function assembleToolPool(options: ToolPoolOptions = {}): ToolPool {
    return new ToolPool(options);
}

/**
 * Summary of all registered tools (for diagnostics / system prompt).
 */
export function toolSummary(): string {
    const byCategory = new Map<string, ToolSpec[]>();
    for (const t of ALL_TOOLS) {
        const list = byCategory.get(t.category) || [];
        list.push(t);
        byCategory.set(t.category, list);
    }

    const lines: string[] = [];
    for (const [cat, tools] of byCategory) {
        lines.push(`\n### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
        for (const t of tools) {
            const platform = t.platforms ? ` (${t.platforms.join(', ')} only)` : '';
            lines.push(`- **${t.name}**${platform}: ${t.description.substring(0, 100)}`);
        }
    }
    return lines.join('\n');
}
