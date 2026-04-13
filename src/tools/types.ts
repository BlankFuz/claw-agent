/**
 * ToolSpec Schema Pattern
 *
 * Every tool in Claw Agent conforms to this schema. It is the equivalent
 * of the harness's ToolPool + ToolPermissionContext + tool_snapshot.json
 * patterns, unified into a single TypeScript-first type system.
 *
 * Each ToolSpec declares:
 *   - name, category, description  (metadata)
 *   - parameters                    (JSON Schema for LLM function calling)
 *   - requiresConfirmation          (modal confirmation before execution)
 *   - permissionLevel               (used by ToolPermissionContext gating)
 *   - execute()                     (the runtime implementation)
 */

import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Tool Categories
// ---------------------------------------------------------------------------

export type ToolCategory =
    | 'shell'
    | 'file'
    | 'search'
    | 'web'
    | 'agent'
    | 'task'
    | 'communication'
    | 'utility'
    | 'output'
    | 'settings';

// ---------------------------------------------------------------------------
// Permission Levels
// ---------------------------------------------------------------------------

/**
 * Permission levels control what gating is applied before a tool runs.
 *
 *   read     — safe, read-only operations (readFile, grep, glob, diagnostics)
 *   write    — modifies workspace files (writeFile, editFile)
 *   execute  — runs arbitrary code or commands (bash, PowerShell, REPL)
 *   network  — accesses external URLs (WebFetch, WebSearch)
 *   agent    — spawns sub-agents or loads skills
 */
export type PermissionLevel = 'read' | 'write' | 'execute' | 'network' | 'agent';

// ---------------------------------------------------------------------------
// JSON Schema subset used by LLM function calling
// ---------------------------------------------------------------------------

export interface ToolParameter {
    type: string;
    description: string;
    enum?: string[];
    default?: unknown;
}

export interface ToolParametersSchema {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
}

// ---------------------------------------------------------------------------
// Execution context passed to every tool at runtime
// ---------------------------------------------------------------------------

export interface ToolContext {
    /** Absolute path to the workspace root folder. */
    workspaceRoot: string;
    /** The VS Code ExtensionContext — access globalState, secrets, etc. */
    extensionContext?: vscode.ExtensionContext;
    /** Abort signal from the user's cancel button. */
    signal?: AbortSignal;
    /** Post a message back to the webview (for streaming / progress). */
    postMessage?: (msg: Record<string, unknown>) => void;
    /** Shared state that persists across tool calls within a single agent turn. */
    turnState: Map<string, unknown>;
    /** Inline confirmation callback — asks the user in the chat webview. */
    confirmInChat?: (toolName: string, summary: string, args?: Record<string, unknown>) => Promise<boolean>;
    /** When true, skip all tool confirmation prompts (YOLO mode). */
    autoApprove?: boolean;
    /** Hook called before file-modifying tools execute. Used by checkpoint system. */
    preExecute?: (toolName: string, args: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// ToolSpec — the core type
// ---------------------------------------------------------------------------

export interface ToolSpec {
    /** Unique tool name — sent to the LLM as the function name. */
    name: string;

    /** Human-readable category for grouping and filtering. */
    category: ToolCategory;

    /** Description shown to the LLM so it knows when/how to use this tool. */
    description: string;

    /** JSON Schema describing accepted parameters. */
    parameters: ToolParametersSchema;

    /** If true, a confirmation modal is shown to the user before execution. */
    requiresConfirmation: boolean;

    /** Permission level — checked by ToolPermissionContext before execution. */
    permissionLevel: PermissionLevel;

    /** Whether this tool is only available on certain platforms. */
    platforms?: NodeJS.Platform[];

    /**
     * Execute the tool and return a string result that is fed back to the LLM
     * as the tool_result content.
     */
    execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// ---------------------------------------------------------------------------
// Helper: build a ToolSpec with defaults
// ---------------------------------------------------------------------------

export function defineTool(spec: ToolSpec): ToolSpec {
    return spec;
}
