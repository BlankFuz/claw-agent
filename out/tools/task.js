"use strict";
/**
 * Task and Session Management Tools
 *   #9  TodoWrite    — Task list management with id, content, status, and priority
 *   #14 Sleep        — Wait for a duration without holding a shell process
 *   #26 TaskCreate   — Launch a managed background process
 *   #27 TaskStop     — Stop a running background task
 *   #28 TaskOutput   — Read output from a background task
 *   #29 TaskList     — List all active background tasks
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.taskTools = exports.taskListTool = exports.taskOutputTool = exports.taskStopTool = exports.taskCreateTool = exports.sleepTool = exports.todoWriteTool = void 0;
const cp = require("child_process");
const types_1 = require("./types");
function getTodos(turnState) {
    return turnState.get('todos') || [];
}
function setTodos(turnState, todos) {
    turnState.set('todos', todos);
}
// ---------------------------------------------------------------------------
// #9 — TodoWrite
// ---------------------------------------------------------------------------
exports.todoWriteTool = (0, types_1.defineTool)({
    name: 'TodoWrite',
    category: 'task',
    description: 'Create and manage a structured task list. Use this to break down complex tasks, ' +
        'track progress, and show the user what you are working on. ' +
        'Actions: "add" (create a task), "update" (change status), "list" (show all tasks), "clear" (remove all).',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description: 'Action to perform.',
                enum: ['add', 'update', 'list', 'clear'],
            },
            id: { type: 'string', description: 'Task ID (for update action).' },
            content: { type: 'string', description: 'Task description (for add action).' },
            status: {
                type: 'string',
                description: 'Task status (for add/update).',
                enum: ['pending', 'in_progress', 'completed'],
                default: 'pending',
            },
            priority: {
                type: 'string',
                description: 'Task priority (for add).',
                enum: ['low', 'medium', 'high'],
                default: 'medium',
            },
        },
        required: ['action'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const action = args.action;
        const todos = getTodos(ctx.turnState);
        switch (action) {
            case 'add': {
                const content = args.content;
                if (!content) {
                    return 'Error: content is required for add action.';
                }
                const id = `task-${Date.now().toString(36)}`;
                const status = args.status || 'pending';
                const priority = args.priority || 'medium';
                todos.push({ id, content, status, priority });
                setTodos(ctx.turnState, todos);
                ctx.postMessage?.({ type: 'addProgress', value: `Task added: ${content}` });
                return `Task "${id}" created: ${content} [${status}] (${priority})`;
            }
            case 'update': {
                const id = args.id;
                if (!id) {
                    return 'Error: id is required for update action.';
                }
                const todo = todos.find(t => t.id === id);
                if (!todo) {
                    return `Error: Task "${id}" not found.`;
                }
                if (args.status) {
                    todo.status = args.status;
                }
                if (args.content) {
                    todo.content = args.content;
                }
                setTodos(ctx.turnState, todos);
                ctx.postMessage?.({ type: 'addProgress', value: `Task ${id}: ${todo.status}` });
                return `Task "${id}" updated: ${todo.content} [${todo.status}]`;
            }
            case 'list': {
                if (todos.length === 0) {
                    return 'No tasks.';
                }
                const statusIcon = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
                return todos
                    .map(t => `${statusIcon[t.status]} ${t.id}: ${t.content} (${t.priority})`)
                    .join('\n');
            }
            case 'clear': {
                setTodos(ctx.turnState, []);
                return 'All tasks cleared.';
            }
            default:
                return `Unknown action: ${action}`;
        }
    },
});
// ---------------------------------------------------------------------------
// #14 — Sleep
// ---------------------------------------------------------------------------
exports.sleepTool = (0, types_1.defineTool)({
    name: 'Sleep',
    category: 'utility',
    description: 'Wait for a specified duration in milliseconds without holding a shell process. ' +
        'Useful for waiting between retries or for background processes to complete. ' +
        'Max duration: 30 seconds.',
    parameters: {
        type: 'object',
        properties: {
            duration_ms: {
                type: 'number',
                description: 'Duration to sleep in milliseconds (max: 30000).',
            },
        },
        required: ['duration_ms'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const duration = Math.min(Math.max(0, Number(args.duration_ms) || 1000), 30000);
        await new Promise((resolve) => {
            const timer = setTimeout(resolve, duration);
            // Allow cancellation
            if (ctx.signal) {
                ctx.signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            }
        });
        return `Slept for ${duration}ms.`;
    },
});
function getBackgroundTasks(turnState) {
    return turnState.get('backgroundTasks') || [];
}
function setBackgroundTasks(turnState, tasks) {
    turnState.set('backgroundTasks', tasks);
}
// ---------------------------------------------------------------------------
// #26 — TaskCreate
// ---------------------------------------------------------------------------
exports.taskCreateTool = (0, types_1.defineTool)({
    name: 'TaskCreate',
    category: 'task',
    description: 'Launch a shell command as a managed background task. Unlike bash with run_in_background, ' +
        'this captures stdout/stderr and lets you check status and output later via TaskOutput. ' +
        'Use for long-running processes like builds, test suites, dev servers, or file watchers.',
    parameters: {
        type: 'object',
        properties: {
            command: { type: 'string', description: 'The shell command to run in the background.' },
            label: { type: 'string', description: 'A short label for this task (e.g. "npm test", "dev server").' },
        },
        required: ['command'],
    },
    requiresConfirmation: true,
    permissionLevel: 'execute',
    async execute(args, ctx) {
        const command = args.command;
        const label = args.label || command.substring(0, 40);
        const tasks = getBackgroundTasks(ctx.turnState);
        const id = `bg-${Date.now().toString(36)}`;
        const child = cp.spawn(command, [], {
            cwd: ctx.workspaceRoot,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const task = {
            id,
            command: label,
            pid: child.pid || 0,
            startedAt: Date.now(),
            status: 'running',
            stdout: '',
            stderr: '',
            exitCode: null,
            process: child,
        };
        child.stdout?.on('data', (chunk) => {
            task.stdout += chunk.toString();
            // Keep last 50KB to avoid memory bloat
            if (task.stdout.length > 50000) {
                task.stdout = '...(truncated)\n' + task.stdout.slice(-40000);
            }
        });
        child.stderr?.on('data', (chunk) => {
            task.stderr += chunk.toString();
            if (task.stderr.length > 50000) {
                task.stderr = '...(truncated)\n' + task.stderr.slice(-40000);
            }
        });
        child.on('close', (code) => {
            task.status = code === 0 ? 'completed' : 'failed';
            task.exitCode = code;
            task.process = null;
        });
        child.on('error', (err) => {
            task.status = 'failed';
            task.stderr += `\nProcess error: ${err.message}`;
            task.process = null;
        });
        tasks.push(task);
        setBackgroundTasks(ctx.turnState, tasks);
        return `Background task "${id}" started: ${label} (PID ${task.pid}). Use TaskOutput to check results.`;
    },
});
// ---------------------------------------------------------------------------
// #27 — TaskStop
// ---------------------------------------------------------------------------
exports.taskStopTool = (0, types_1.defineTool)({
    name: 'TaskStop',
    category: 'task',
    description: 'Stop a running background task by its ID. Sends SIGTERM to the process. ' +
        'Use TaskList to find task IDs.',
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The background task ID to stop.' },
        },
        required: ['id'],
    },
    requiresConfirmation: false,
    permissionLevel: 'execute',
    async execute(args, ctx) {
        const id = args.id;
        const tasks = getBackgroundTasks(ctx.turnState);
        const task = tasks.find(t => t.id === id);
        if (!task) {
            return `Task "${id}" not found. Use TaskList to see available tasks.`;
        }
        if (task.status !== 'running') {
            return `Task "${id}" already ${task.status}.`;
        }
        if (task.process) {
            try {
                // On Windows, use taskkill for process tree
                if (process.platform === 'win32' && task.pid) {
                    cp.execSync(`taskkill /pid ${task.pid} /T /F`, { stdio: 'ignore' });
                }
                else {
                    task.process.kill('SIGTERM');
                }
            }
            catch { /* process may have already exited */ }
        }
        task.status = 'failed';
        task.exitCode = -1;
        task.process = null;
        return `Task "${id}" (${task.command}) stopped.`;
    },
});
// ---------------------------------------------------------------------------
// #28 — TaskOutput
// ---------------------------------------------------------------------------
exports.taskOutputTool = (0, types_1.defineTool)({
    name: 'TaskOutput',
    category: 'task',
    description: 'Read stdout/stderr output from a background task. Returns the current status, ' +
        'exit code (if finished), and the last N lines of output.',
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The background task ID.' },
            tail: {
                type: 'number',
                description: 'Number of lines to return from the end of output (default 50).',
                default: 50,
            },
        },
        required: ['id'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const id = args.id;
        const tail = Math.min(Math.max(1, Number(args.tail) || 50), 500);
        const tasks = getBackgroundTasks(ctx.turnState);
        const task = tasks.find(t => t.id === id);
        if (!task) {
            return `Task "${id}" not found. Use TaskList to see available tasks.`;
        }
        const elapsed = Math.round((Date.now() - task.startedAt) / 1000);
        const lines = [
            `Task: ${task.id} (${task.command})`,
            `Status: ${task.status}${task.exitCode !== null ? ` (exit code: ${task.exitCode})` : ''}`,
            `PID: ${task.pid} | Elapsed: ${elapsed}s`,
        ];
        const stdoutLines = task.stdout.trim().split('\n');
        const stderrLines = task.stderr.trim().split('\n').filter(l => l.length > 0);
        if (stdoutLines.length > 0 && stdoutLines[0] !== '') {
            const shown = stdoutLines.slice(-tail);
            lines.push(`\nSTDOUT (last ${shown.length} lines):`);
            lines.push(shown.join('\n'));
        }
        if (stderrLines.length > 0) {
            const shown = stderrLines.slice(-Math.min(tail, 20));
            lines.push(`\nSTDERR (last ${shown.length} lines):`);
            lines.push(shown.join('\n'));
        }
        return lines.join('\n');
    },
});
// ---------------------------------------------------------------------------
// #29 — TaskList
// ---------------------------------------------------------------------------
exports.taskListTool = (0, types_1.defineTool)({
    name: 'TaskList',
    category: 'task',
    description: 'List all background tasks and their current status. Shows task ID, command, PID, ' +
        'status, and elapsed time.',
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const tasks = getBackgroundTasks(ctx.turnState);
        if (tasks.length === 0) {
            return 'No background tasks.';
        }
        const statusIcon = {
            running: '[ ]',
            completed: '[x]',
            failed: '[!]',
        };
        return tasks.map(t => {
            const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
            return `${statusIcon[t.status] || '[ ]'} ${t.id}: ${t.command} (PID ${t.pid}, ${t.status}, ${elapsed}s)`;
        }).join('\n');
    },
});
exports.taskTools = [exports.todoWriteTool, exports.sleepTool, exports.taskCreateTool, exports.taskStopTool, exports.taskOutputTool, exports.taskListTool];
//# sourceMappingURL=task.js.map