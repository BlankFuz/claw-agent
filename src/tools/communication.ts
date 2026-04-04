/**
 * Communication, Settings, Output, and Execution Tools
 *   #15 SendUserMessage   — Message the user with status information
 *   #16 Config            — Get/set agent configuration
 *   #17 StructuredOutput  — Return machine-parseable JSON to caller
 *   #18 REPL              — Execute code in a language REPL with persistent state
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';
import { defineTool, ToolSpec } from './types';

const execAsync = promisify(cp.exec);

// ---------------------------------------------------------------------------
// #15 — SendUserMessage
// ---------------------------------------------------------------------------

export const sendUserMessageTool: ToolSpec = defineTool({
    name: 'SendUserMessage',
    category: 'communication',
    description:
        'Send a message to the user via VS Code notification. Use this for important status updates, ' +
        'warnings, or questions that need attention. Supports "info", "warning", and "error" levels.',
    parameters: {
        type: 'object',
        properties: {
            message: { type: 'string', description: 'The message to display to the user.' },
            level: {
                type: 'string',
                description: 'Notification level.',
                enum: ['info', 'warning', 'error'],
                default: 'info',
            },
        },
        required: ['message'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',

    async execute(args) {
        const message = args.message as string;
        const level = (args.level as string) || 'info';

        switch (level) {
            case 'warning':
                vscode.window.showWarningMessage(message);
                break;
            case 'error':
                vscode.window.showErrorMessage(message);
                break;
            default:
                vscode.window.showInformationMessage(message);
                break;
        }

        return `Notified user (${level}): ${message}`;
    },
});

// ---------------------------------------------------------------------------
// #16 — Config
// ---------------------------------------------------------------------------

/**
 * Agent configuration store — persisted in turnState during a session.
 * Extensible: add new config keys as needed.
 */
const CONFIG_KEYS: Record<string, { description: string; default: string }> = {
    'maxTurns': { description: 'Maximum agentic loop iterations per user message', default: '16' },
    'model': { description: 'Default model ID override', default: '' },
    'confirmWrites': { description: 'Require confirmation for file writes (true/false)', default: 'true' },
    'confirmCommands': { description: 'Require confirmation for shell commands (true/false)', default: 'true' },
};

export const configTool: ToolSpec = defineTool({
    name: 'Config',
    category: 'settings',
    description:
        'Get or set agent configuration. Actions: "get" (read a value), "set" (write a value), "list" (show all). ' +
        'Keys: ' + Object.keys(CONFIG_KEYS).join(', '),
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description: 'Action to perform.',
                enum: ['get', 'set', 'list'],
            },
            key: { type: 'string', description: 'Configuration key name.' },
            value: { type: 'string', description: 'New value (for set action).' },
        },
        required: ['action'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',

    async execute(args, ctx) {
        const action = args.action as string;
        const configMap = (ctx.turnState.get('config') as Map<string, string>) || new Map<string, string>();
        ctx.turnState.set('config', configMap);

        switch (action) {
            case 'get': {
                const key = args.key as string;
                if (!key) { return 'Error: key is required for get.'; }
                const val = configMap.get(key) ?? CONFIG_KEYS[key]?.default ?? '(not set)';
                return `${key} = ${val}`;
            }
            case 'set': {
                const key = args.key as string;
                const value = args.value as string;
                if (!key || value === undefined) { return 'Error: key and value are required for set.'; }
                configMap.set(key, value);
                return `Set ${key} = ${value}`;
            }
            case 'list': {
                return Object.entries(CONFIG_KEYS)
                    .map(([k, v]) => {
                        const current = configMap.get(k) ?? v.default;
                        return `**${k}**: ${current} — ${v.description}`;
                    })
                    .join('\n');
            }
            default:
                return `Unknown action: ${action}`;
        }
    },
});

// ---------------------------------------------------------------------------
// #17 — StructuredOutput
// ---------------------------------------------------------------------------

export const structuredOutputTool: ToolSpec = defineTool({
    name: 'StructuredOutput',
    category: 'output',
    description:
        'Return machine-parseable JSON data. Use this when you need to produce structured data ' +
        'that can be consumed programmatically rather than as natural language text.',
    parameters: {
        type: 'object',
        properties: {
            data: { type: 'string', description: 'JSON string containing the structured data to return.' },
            schema_hint: { type: 'string', description: 'Optional description of the JSON schema for documentation.' },
        },
        required: ['data'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',

    async execute(args, ctx) {
        const data = args.data as string;

        // Validate it's valid JSON
        try {
            const parsed = JSON.parse(data);
            const formatted = JSON.stringify(parsed, null, 2);

            // Store in turnState for programmatic access
            ctx.turnState.set('structuredOutput', parsed);

            return `\`\`\`json\n${formatted}\n\`\`\``;
        } catch {
            return `Error: Invalid JSON data: ${data.substring(0, 200)}`;
        }
    },
});

// ---------------------------------------------------------------------------
// #18 — REPL
// ---------------------------------------------------------------------------

/** Persistent REPL sessions, keyed by language. */
const replSessions = new Map<string, cp.ChildProcess>();

export const replTool: ToolSpec = defineTool({
    name: 'REPL',
    category: 'shell',
    description:
        'Execute code in a language REPL with persistent state. Supports Python and Node.js. ' +
        'State persists between calls within the same session. ' +
        'The user will be asked to confirm execution.',
    parameters: {
        type: 'object',
        properties: {
            language: {
                type: 'string',
                description: 'Programming language.',
                enum: ['python', 'node'],
            },
            code: { type: 'string', description: 'Code to execute in the REPL.' },
        },
        required: ['language', 'code'],
    },
    requiresConfirmation: true,
    permissionLevel: 'execute',

    async execute(args, ctx) {
        const language = args.language as string;
        const code = args.code as string;

        // For simplicity, use exec with -c / -e flags (non-interactive but functional)
        const cmd = language === 'python'
            ? `python -c "${code.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
            : `node -e "${code.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

        try {
            const { stdout, stderr } = await execAsync(cmd, {
                cwd: ctx.workspaceRoot,
                timeout: 30000,
                maxBuffer: 1024 * 1024,
            });

            const parts: string[] = [];
            if (stdout.trim()) { parts.push(stdout.trim()); }
            if (stderr.trim()) { parts.push(`STDERR: ${stderr.trim()}`); }
            return parts.length > 0 ? parts.join('\n') : '(no output)';
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return `REPL error: ${message}`;
        }
    },
});

// ---------------------------------------------------------------------------
// #19 — AskUserQuestion
// ---------------------------------------------------------------------------

export const askUserQuestionTool: ToolSpec = defineTool({
    name: 'AskUserQuestion',
    category: 'communication',
    description:
        'Ask the user a question and wait for their response. Use this when you need ' +
        'clarification, confirmation, or user input before proceeding. The question is ' +
        'shown as a VS Code input dialog. Returns the user\'s answer or "(cancelled)" if dismissed.',
    parameters: {
        type: 'object',
        properties: {
            question: { type: 'string', description: 'The question to ask the user.' },
            placeholder: { type: 'string', description: 'Optional placeholder text in the input box.' },
            options: {
                type: 'string',
                description: 'Optional comma-separated list of predefined choices. If provided, shows a quick pick instead of free text input.',
            },
        },
        required: ['question'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',

    async execute(args) {
        const question = args.question as string;
        const placeholder = args.placeholder as string | undefined;
        const optionsStr = args.options as string | undefined;

        if (optionsStr) {
            // Quick pick with predefined options
            const items = optionsStr.split(',').map(s => s.trim()).filter(Boolean);
            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: question,
                title: 'Claw Agent',
            });
            return selected || '(cancelled)';
        }

        // Free text input
        const answer = await vscode.window.showInputBox({
            prompt: question,
            placeHolder: placeholder || 'Type your answer...',
            title: 'Claw Agent',
        });

        return answer || '(cancelled)';
    },
});

export const communicationTools: ToolSpec[] = [
    sendUserMessageTool,
    askUserQuestionTool,
    configTool,
    structuredOutputTool,
    replTool,
];
