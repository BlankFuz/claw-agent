"use strict";
/**
 * Search and Discovery Tools
 *   #5  glob_search — File pattern matching, sorted by modification time
 *   #6  grep_search — Regex content search built on VS Code findFiles + regex
 *   #12 ToolSearch  — Search available tool definitions by query
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.searchTools = exports.toolSearchTool = exports.grepSearchTool = exports.globSearchTool = void 0;
const vscode = require("vscode");
const types_1 = require("./types");
// ---------------------------------------------------------------------------
// #5 — glob_search
// ---------------------------------------------------------------------------
exports.globSearchTool = (0, types_1.defineTool)({
    name: 'glob_search',
    category: 'search',
    description: 'Fast file pattern matching. Supports glob patterns like "**/*.ts" or "src/**/*.py". ' +
        'Returns matching file paths sorted by modification time (newest first). ' +
        'Truncates results at 100 entries.',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Glob pattern to match files, e.g. "**/*.ts", "src/components/**/*.tsx".' },
            path: { type: 'string', description: 'Optional subdirectory to search in (relative to workspace root). Defaults to entire workspace.' },
        },
        required: ['pattern'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const pattern = args.pattern;
        const subPath = args.path;
        const include = subPath ? new vscode.RelativePattern(vscode.Uri.file(require('path').resolve(ctx.workspaceRoot, subPath)), pattern) : pattern;
        const files = await vscode.workspace.findFiles(include, '**/node_modules/**', 100);
        if (files.length === 0) {
            return `No files matching "${pattern}"${subPath ? ` in ${subPath}` : ''}.`;
        }
        // Sort by modification time (newest first) via stat
        const withStats = await Promise.all(files.map(async (f) => {
            try {
                const stat = await vscode.workspace.fs.stat(f);
                return { uri: f, mtime: stat.mtime };
            }
            catch {
                return { uri: f, mtime: 0 };
            }
        }));
        withStats.sort((a, b) => b.mtime - a.mtime);
        const paths = withStats.map(f => vscode.workspace.asRelativePath(f.uri));
        const truncated = paths.length >= 100;
        return `Found ${paths.length} files${truncated ? ' (truncated at 100)' : ''}:\n\n${paths.join('\n')}`;
    },
});
// ---------------------------------------------------------------------------
// #6 — grep_search
// ---------------------------------------------------------------------------
exports.grepSearchTool = (0, types_1.defineTool)({
    name: 'grep_search',
    category: 'search',
    description: 'Search file contents using regex patterns. Supports case-insensitive search, ' +
        'file type filtering via glob, context lines (before/after), and result limiting. ' +
        'Returns matching lines with file paths and line numbers.',
    parameters: {
        type: 'object',
        properties: {
            pattern: { type: 'string', description: 'Regex pattern to search for in file contents.' },
            glob: { type: 'string', description: 'Glob to filter files, e.g. "**/*.ts", "*.py". Default: all files.' },
            case_insensitive: {
                type: 'string',
                description: 'Set to "true" for case-insensitive search.',
                enum: ['true', 'false'],
                default: 'false',
            },
            context_lines: {
                type: 'number',
                description: 'Number of context lines to show before and after each match. Default: 0.',
                default: 0,
            },
            head_limit: {
                type: 'number',
                description: 'Max number of matches to return. Default: 50.',
                default: 50,
            },
            path: { type: 'string', description: 'Subdirectory to search in (relative to workspace root).' },
        },
        required: ['pattern'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const pattern = args.pattern;
        const glob = args.glob || '**/*';
        const caseInsensitive = args.case_insensitive === 'true';
        const contextLines = Math.min(Number(args.context_lines) || 0, 10);
        const headLimit = Math.min(Number(args.head_limit) || 50, 200);
        const subPath = args.path;
        const flags = caseInsensitive ? 'gi' : 'g';
        let regex;
        try {
            regex = new RegExp(pattern, flags);
        }
        catch (e) {
            // If the pattern is invalid regex, escape it and search as literal string
            const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(escaped, flags);
        }
        const include = subPath ? new vscode.RelativePattern(vscode.Uri.file(require('path').resolve(ctx.workspaceRoot, subPath)), glob) : glob;
        const files = await vscode.workspace.findFiles(include, '**/node_modules/**', 500);
        const results = [];
        for (const file of files) {
            if (results.length >= headLimit) {
                break;
            }
            try {
                const data = await vscode.workspace.fs.readFile(file);
                const content = Buffer.from(data).toString('utf-8');
                // Skip likely binary files
                if (content.includes('\0')) {
                    continue;
                }
                const lines = content.split('\n');
                const relativePath = vscode.workspace.asRelativePath(file);
                for (let i = 0; i < lines.length; i++) {
                    regex.lastIndex = 0;
                    if (regex.test(lines[i])) {
                        if (contextLines > 0) {
                            const start = Math.max(0, i - contextLines);
                            const end = Math.min(lines.length - 1, i + contextLines);
                            const block = lines.slice(start, end + 1)
                                .map((l, idx) => {
                                const lineNum = start + idx + 1;
                                const marker = (start + idx === i) ? '>' : ' ';
                                return `${marker} ${lineNum}\t${l}`;
                            })
                                .join('\n');
                            results.push(`${relativePath}:${i + 1}:\n${block}`);
                        }
                        else {
                            results.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
                        }
                        if (results.length >= headLimit) {
                            break;
                        }
                    }
                }
            }
            catch {
                // skip unreadable files
            }
        }
        if (results.length === 0) {
            return `No matches for "${pattern}" in ${glob}.`;
        }
        const truncated = results.length >= headLimit;
        return `Found ${results.length} matches${truncated ? ` (limited to ${headLimit})` : ''}:\n\n${results.join('\n\n')}`;
    },
});
// ---------------------------------------------------------------------------
// #12 — ToolSearch
// ---------------------------------------------------------------------------
exports.toolSearchTool = (0, types_1.defineTool)({
    name: 'ToolSearch',
    category: 'search',
    description: 'Search available tool definitions by name or keyword. Returns matching tool names, ' +
        'categories, and descriptions. Useful for discovering which tools are available.',
    parameters: {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Search query — matches against tool names and descriptions.' },
            max_results: {
                type: 'number',
                description: 'Maximum number of results to return (default: 5).',
                default: 5,
            },
        },
        required: ['query'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        // This tool's implementation is special — it searches the ToolPool itself.
        // The actual tool list is injected via ctx.turnState by the ToolPool.
        const query = args.query.toLowerCase();
        const maxResults = Math.min(Number(args.max_results) || 5, 20);
        const allTools = ctx.turnState.get('allTools');
        if (!allTools) {
            return 'No tools registered.';
        }
        const scored = allTools.map(t => {
            let score = 0;
            const nameL = t.name.toLowerCase();
            const descL = t.description.toLowerCase();
            if (nameL === query) {
                score += 100;
            }
            else if (nameL.includes(query)) {
                score += 50;
            }
            const words = query.split(/\s+/);
            for (const w of words) {
                if (nameL.includes(w)) {
                    score += 20;
                }
                if (descL.includes(w)) {
                    score += 10;
                }
                if (t.category.includes(w)) {
                    score += 15;
                }
            }
            return { tool: t, score };
        });
        const matches = scored
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, maxResults);
        if (matches.length === 0) {
            return `No tools matching "${query}".`;
        }
        return matches
            .map(m => `**${m.tool.name}** [${m.tool.category}] — ${m.tool.description.substring(0, 120)}`)
            .join('\n\n');
    },
});
exports.searchTools = [exports.globSearchTool, exports.grepSearchTool, exports.toolSearchTool];
//# sourceMappingURL=search.js.map