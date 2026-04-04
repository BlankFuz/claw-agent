"use strict";
/**
 * Shell Execution Tools
 *   #1  bash       — Execute shell commands with timeout and background support
 *   #19 PowerShell — Windows PowerShell execution (conditional on platform)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.shellTools = exports.powershellTool = exports.bashTool = void 0;
const cp = require("child_process");
const util_1 = require("util");
const types_1 = require("./types");
const execAsync = (0, util_1.promisify)(cp.exec);
// ---------------------------------------------------------------------------
// #1 — bash
// ---------------------------------------------------------------------------
exports.bashTool = (0, types_1.defineTool)({
    name: 'bash',
    category: 'shell',
    description: 'Execute a shell command in the workspace. Supports timeout (default 30s, max 120s) ' +
        'and background execution. Returns stdout and stderr. ' +
        'Use this for running builds, tests, git commands, package managers, etc. ' +
        'The user will be asked to confirm before execution.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to execute.' },
            timeout: {
                type: 'number',
                description: 'Timeout in milliseconds (default 30000, max 120000).',
                default: 30000,
            },
            run_in_background: {
                type: 'string',
                description: 'Set to "true" to run in background. Returns immediately with a handle.',
                enum: ['true', 'false'],
                default: 'false',
            },
        },
        required: ['command'],
    },
    requiresConfirmation: true,
    permissionLevel: 'execute',
    async execute(args, ctx) {
        const command = args.command;
        const timeout = Math.min(Number(args.timeout) || 30000, 120000);
        const background = args.run_in_background === 'true';
        if (background) {
            // Fire and forget — spawn detached
            const child = cp.spawn(command, [], {
                cwd: ctx.workspaceRoot,
                shell: true,
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
            return `Background process started (PID ${child.pid}). It will continue running independently.`;
        }
        const { stdout, stderr } = await execAsync(command, {
            cwd: ctx.workspaceRoot,
            timeout,
            maxBuffer: 1024 * 1024, // 1MB
        });
        const parts = [];
        if (stdout.trim()) {
            parts.push(`STDOUT:\n${stdout.trim()}`);
        }
        if (stderr.trim()) {
            parts.push(`STDERR:\n${stderr.trim()}`);
        }
        return parts.length > 0 ? parts.join('\n\n') : '(no output)';
    },
});
// ---------------------------------------------------------------------------
// #19 — PowerShell (Windows only)
// ---------------------------------------------------------------------------
exports.powershellTool = (0, types_1.defineTool)({
    name: 'PowerShell',
    category: 'shell',
    description: 'Execute a PowerShell command on Windows. Uses powershell.exe with -NoProfile -Command. ' +
        'Useful for Windows-specific operations like registry, services, or .NET calls. ' +
        'The user will be asked to confirm before execution.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The PowerShell command or script block to execute.' },
            timeout: {
                type: 'number',
                description: 'Timeout in milliseconds (default 30000, max 120000).',
                default: 30000,
            },
        },
        required: ['command'],
    },
    requiresConfirmation: true,
    permissionLevel: 'execute',
    platforms: ['win32'],
    async execute(args, ctx) {
        const command = args.command;
        const timeout = Math.min(Number(args.timeout) || 30000, 120000);
        const { stdout, stderr } = await execAsync(`powershell.exe -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`, {
            cwd: ctx.workspaceRoot,
            timeout,
            maxBuffer: 1024 * 1024,
        });
        const parts = [];
        if (stdout.trim()) {
            parts.push(`OUTPUT:\n${stdout.trim()}`);
        }
        if (stderr.trim()) {
            parts.push(`ERRORS:\n${stderr.trim()}`);
        }
        return parts.length > 0 ? parts.join('\n\n') : '(no output)';
    },
});
exports.shellTools = [exports.bashTool, exports.powershellTool];
//# sourceMappingURL=shell.js.map