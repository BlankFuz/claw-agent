"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolPool = exports.extractFilePath = exports.safeResolvePath = void 0;
exports.assembleToolPool = assembleToolPool;
exports.toolSummary = toolSummary;
const vscode = require("vscode");
const permissions_1 = require("../permissions");
// Import all tool modules
const shell_1 = require("./shell");
const file_1 = require("./file");
const search_1 = require("./search");
const lsp_1 = require("./lsp");
const web_1 = require("./web");
const agent_1 = require("./agent");
const task_1 = require("./task");
const communication_1 = require("./communication");
const worktree_1 = require("./worktree");
var file_2 = require("./file");
Object.defineProperty(exports, "safeResolvePath", { enumerable: true, get: function () { return file_2.safeResolvePath; } });
Object.defineProperty(exports, "extractFilePath", { enumerable: true, get: function () { return file_2.extractFilePath; } });
// ---------------------------------------------------------------------------
// All registered tools
// ---------------------------------------------------------------------------
const ALL_TOOLS = [
    ...shell_1.shellTools,
    ...file_1.fileTools,
    ...search_1.searchTools,
    ...lsp_1.lspTools,
    ...web_1.webTools,
    ...agent_1.agentTools,
    ...task_1.taskTools,
    ...communication_1.communicationTools,
    ...worktree_1.worktreeTools,
];
class ToolPool {
    _tools;
    _toolMap;
    _permissions;
    _turnState;
    constructor(options = {}) {
        const { permissions, allowedLevels, excludeNames } = options;
        this._permissions = permissions ?? new permissions_1.ToolPermissionContext();
        this._turnState = new Map();
        // Filter tools
        let tools = ALL_TOOLS.filter(t => {
            // Platform filter
            if (t.platforms && !t.platforms.includes(process.platform)) {
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
    get tools() {
        return this._tools;
    }
    /** Get turn state map (shared across tool calls). */
    get turnState() {
        return this._turnState;
    }
    /** Number of active tools. */
    get size() {
        return this._tools.length;
    }
    /** Look up a tool by name. */
    getTool(name) {
        return this._toolMap.get(name);
    }
    /**
     * Generate the LLM-facing tool definitions.
     * Format compatible with both OpenAI and Anthropic function calling.
     */
    toLLMToolDefinitions() {
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
    async execute(name, args, ctx) {
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
            }
            else {
                const confirm = await vscode.window.showWarningMessage(`Agent wants to ${name}: ${summary}`, { modal: true }, 'Allow');
                if (confirm !== 'Allow') {
                    return `User denied ${name}: ${summary}`;
                }
            }
        }
        // Build full context
        const fullCtx = {
            workspaceRoot: ctx.workspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
            extensionContext: ctx.extensionContext,
            signal: ctx.signal,
            postMessage: ctx.postMessage,
            turnState: this._turnState,
        };
        try {
            return await tool.execute(args, fullCtx);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Tool "${name}" failed: ${message}`;
        }
    }
    /** Format tool args into a short confirmation string. */
    _summarizeArgs(name, args) {
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
    /** Reset turn state between user messages. */
    resetTurn() {
        // Preserve persistent state across turns, clear everything else
        const allTools = this._turnState.get('allTools');
        const config = this._turnState.get('config');
        const backgroundTasks = this._turnState.get('backgroundTasks');
        const worktree = this._turnState.get('worktree');
        this._turnState.clear();
        if (allTools) {
            this._turnState.set('allTools', allTools);
        }
        if (config) {
            this._turnState.set('config', config);
        }
        if (backgroundTasks) {
            this._turnState.set('backgroundTasks', backgroundTasks);
        }
        if (worktree) {
            this._turnState.set('worktree', worktree);
        }
    }
}
exports.ToolPool = ToolPool;
// ---------------------------------------------------------------------------
// Factory — default pool
// ---------------------------------------------------------------------------
function assembleToolPool(options = {}) {
    return new ToolPool(options);
}
/**
 * Summary of all registered tools (for diagnostics / system prompt).
 */
function toolSummary() {
    const byCategory = new Map();
    for (const t of ALL_TOOLS) {
        const list = byCategory.get(t.category) || [];
        list.push(t);
        byCategory.set(t.category, list);
    }
    const lines = [];
    for (const [cat, tools] of byCategory) {
        lines.push(`\n### ${cat.charAt(0).toUpperCase() + cat.slice(1)}`);
        for (const t of tools) {
            const platform = t.platforms ? ` (${t.platforms.join(', ')} only)` : '';
            lines.push(`- **${t.name}**${platform}: ${t.description.substring(0, 100)}`);
        }
    }
    return lines.join('\n');
}
//# sourceMappingURL=index.js.map