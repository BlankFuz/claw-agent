/**
 * File Operation Tools
 *   #2  read_file    — Read files with offset/limit, supports images and notebooks
 *   #3  write_file   — Create or overwrite files
 *   #4  edit_file    — Precise string replacement with uniqueness validation
 *   #13 NotebookEdit — Jupyter notebook cell editing
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { defineTool, ToolSpec, ToolContext } from './types';

// ---------------------------------------------------------------------------
// Shared path helpers
// ---------------------------------------------------------------------------

/** Extract file path from args, accepting common aliases the LLM may use. */
export function extractFilePath(args: Record<string, unknown>): string {
    // Try exact matches first, then case-insensitive scan for any key containing "path" or "file"
    const raw = args.path ?? args.file_path ?? args.filePath ?? args.file
        ?? args.filename ?? args.fileName ?? args.filepath ?? args.target
        ?? args.destination ?? args.name;

    if (typeof raw === 'string' && raw) {
        return raw;
    }

    // Fallback: scan all keys for anything that looks like a path value
    for (const [key, val] of Object.entries(args)) {
        if (typeof val === 'string' && val && (key.toLowerCase().includes('path') || key.toLowerCase().includes('file'))) {
            return val;
        }
    }

    const receivedKeys = Object.keys(args).join(', ') || '(empty)';
    throw new Error(`Missing required parameter: path. Received keys: ${receivedKeys}`);
}

export function safeResolvePath(workspaceRoot: string, filePath: string): vscode.Uri {
    const resolved = path.resolve(workspaceRoot, filePath);
    const normalizedRoot = path.normalize(workspaceRoot) + path.sep;
    const normalizedResolved = path.normalize(resolved);

    if (!normalizedResolved.startsWith(normalizedRoot) && normalizedResolved !== path.normalize(workspaceRoot)) {
        throw new Error(`Path "${filePath}" resolves outside the workspace. Access denied.`);
    }
    return vscode.Uri.file(resolved);
}

// ---------------------------------------------------------------------------
// #2 — read_file
// ---------------------------------------------------------------------------

export const readFileTool: ToolSpec = defineTool({
    name: 'read_file',
    category: 'file',
    description:
        'Read the contents of a file in the workspace. Supports offset and limit ' +
        'for reading specific line ranges. Returns content with line numbers. ' +
        'For large files, use offset/limit to read specific sections.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the file within the workspace.' },
            offset: {
                type: 'number',
                description: 'Line number to start reading from (0-based). Default: 0.',
                default: 0,
            },
            limit: {
                type: 'number',
                description: 'Maximum number of lines to read. Default: 2000.',
                default: 2000,
            },
        },
        required: ['path'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',

    async execute(args, ctx) {
        const filePath = extractFilePath(args);
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = Math.min(Math.max(1, Number(args.limit) || 2000), 5000);

        const uri = safeResolvePath(ctx.workspaceRoot, filePath);
        const data = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(data).toString('utf-8');
        const allLines = content.split('\n');

        const slice = allLines.slice(offset, offset + limit);
        const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`);

        let result = numbered.join('\n');
        if (offset + limit < allLines.length) {
            result += `\n\n(... ${allLines.length - offset - limit} more lines. Use offset=${offset + limit} to continue.)`;
        }
        return result;
    },
});

// ---------------------------------------------------------------------------
// #3 — write_file
// ---------------------------------------------------------------------------

export const writeFileTool: ToolSpec = defineTool({
    name: 'write_file',
    category: 'file',
    description:
        'Create a new file or overwrite an existing file with the given content. ' +
        'Use edit_file for targeted changes to existing files instead of rewriting. ' +
        'The user will be asked to confirm before writing.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to write within the workspace.' },
            content: { type: 'string', description: 'The full file content to write.' },
        },
        required: ['path', 'content'],
    },
    requiresConfirmation: true,
    permissionLevel: 'write',

    async execute(args, ctx) {
        const filePath = extractFilePath(args);
        const content = (args.content as string) ?? '';
        const uri = safeResolvePath(ctx.workspaceRoot, filePath);

        await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
        return `Successfully wrote ${content.split('\n').length} lines to ${filePath}`;
    },
});

// ---------------------------------------------------------------------------
// #4 — edit_file
// ---------------------------------------------------------------------------

export const editFileTool: ToolSpec = defineTool({
    name: 'edit_file',
    category: 'file',
    description:
        'Make a targeted edit to a file by replacing a specific string with new content. ' +
        'The old_string must match exactly (including whitespace/indentation) and must be ' +
        'unique in the file. Prefer this over write_file for modifying existing files.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the file to edit.' },
            old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique in the file.' },
            new_string: { type: 'string', description: 'The replacement string.' },
        },
        required: ['path', 'old_string', 'new_string'],
    },
    requiresConfirmation: false,
    permissionLevel: 'write',

    async execute(args, ctx) {
        const filePath = extractFilePath(args);
        const oldString = args.old_string as string;
        const newString = args.new_string as string;
        const uri = safeResolvePath(ctx.workspaceRoot, filePath);

        const data = await vscode.workspace.fs.readFile(uri);
        const fileContent = Buffer.from(data).toString('utf-8');

        // --- Exact match attempt ---
        const occurrences = fileContent.split(oldString).length - 1;

        if (occurrences === 1) {
            const updated = fileContent.replace(oldString, newString);
            await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf-8'));
            return `Successfully edited ${filePath} (replaced 1 occurrence).`;
        }

        if (occurrences > 1) {
            return `Edit failed: old_string found ${occurrences} times in ${filePath}. It must be unique — provide more surrounding context.`;
        }

        // --- Fuzzy fallback: normalize whitespace (trim each line, collapse spaces) ---
        const normalize = (s: string) => s.split('\n').map(l => l.trim()).join('\n').replace(/[ \t]+/g, ' ');
        const normalizedOld = normalize(oldString);
        const lines = fileContent.split('\n');

        // Sliding window over file lines to find a fuzzy match
        const oldLineCount = oldString.split('\n').length;
        let fuzzyStart = -1;
        let fuzzyEnd = -1;
        let fuzzyMatches = 0;

        for (let i = 0; i <= lines.length - oldLineCount; i++) {
            const window = lines.slice(i, i + oldLineCount).join('\n');
            if (normalize(window) === normalizedOld) {
                fuzzyStart = i;
                fuzzyEnd = i + oldLineCount;
                fuzzyMatches++;
                if (fuzzyMatches > 1) { break; }
            }
        }

        if (fuzzyMatches === 1) {
            // Use the FILE's actual matched lines to determine correct indentation,
            // not the LLM's old_string (which has wrong indentation — that's why exact match failed).
            const matchedLines = lines.slice(fuzzyStart, fuzzyEnd);
            const oldLLMLines = oldString.split('\n');
            const newLLMLines = newString.split('\n');

            // Detect the indent difference between what the LLM thinks (old_string line 0)
            // and what the file actually has (matched line 0). Apply that delta to new_string.
            const fileIndent0 = matchedLines[0].match(/^(\s*)/)?.[1] || '';
            const llmIndent0 = oldLLMLines[0].match(/^(\s*)/)?.[1] || '';

            const newLines = newLLMLines.map((l, idx) => {
                const trimmed = l.trimStart();
                if (trimmed.length === 0) { return ''; } // blank line stays blank

                // For each new_string line, figure out the LLM's intended indent relative to line 0
                const llmIndent = l.match(/^(\s*)/)?.[1] || '';
                const relativeIndent = llmIndent.length - llmIndent0.length;

                // For the corresponding old line in the FILE, use its actual indent if available
                if (idx < matchedLines.length) {
                    const fileLineIndent = matchedLines[idx].match(/^(\s*)/)?.[1] || '';
                    // If the LLM kept the same relative indent as old_string, use the file's indent for this line
                    const oldLLMIndent = idx < oldLLMLines.length ? (oldLLMLines[idx].match(/^(\s*)/)?.[1] || '') : '';
                    const oldRelative = oldLLMIndent.length - llmIndent0.length;
                    if (relativeIndent === oldRelative) {
                        return fileLineIndent + trimmed;
                    }
                }

                // Otherwise, apply the relative indent from the LLM on top of the file's base indent
                const indent = fileIndent0 + ' '.repeat(Math.max(0, relativeIndent));
                return indent + trimmed;
            });

            lines.splice(fuzzyStart, fuzzyEnd - fuzzyStart, ...newLines);
            const updated = lines.join('\n');
            await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf-8'));
            return `Successfully edited ${filePath} (replaced 1 occurrence via fuzzy whitespace match).`;
        }

        if (fuzzyMatches > 1) {
            return `Edit failed: old_string found ${fuzzyMatches} times (fuzzy match) in ${filePath}. Provide more surrounding context.`;
        }

        // --- Nothing found: provide helpful context ---
        const oldFirstLine = oldString.split('\n')[0].trim();
        const nearbyLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().includes(oldFirstLine)) {
                nearbyLines.push(`  Line ${i + 1}: ${lines[i].trimEnd()}`);
            }
        }
        const hint = nearbyLines.length > 0
            ? `\nDid you mean one of these lines?\n${nearbyLines.slice(0, 5).join('\n')}`
            : `\nThe first line of old_string ("${oldFirstLine.substring(0, 60)}") was not found anywhere in the file.`;
        return `Edit failed: old_string not found in ${filePath}.${hint}`;
    },
});

// ---------------------------------------------------------------------------
// #13 — NotebookEdit
// ---------------------------------------------------------------------------

export const notebookEditTool: ToolSpec = defineTool({
    name: 'NotebookEdit',
    category: 'file',
    description:
        'Edit Jupyter notebook (.ipynb) cells. Supports replacing cell content, ' +
        'inserting new cells, or deleting cells by index.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the .ipynb file.' },
            action: {
                type: 'string',
                description: 'Action to perform.',
                enum: ['replace', 'insert', 'delete'],
            },
            cell_index: { type: 'number', description: 'Zero-based index of the cell to act on.' },
            cell_type: {
                type: 'string',
                description: 'Cell type for insert/replace (default: "code").',
                enum: ['code', 'markdown', 'raw'],
                default: 'code',
            },
            content: { type: 'string', description: 'New cell content (for replace/insert).' },
        },
        required: ['path', 'action', 'cell_index'],
    },
    requiresConfirmation: true,
    permissionLevel: 'write',

    async execute(args, ctx) {
        const filePath = extractFilePath(args);
        const action = args.action as string;
        const cellIndex = Number(args.cell_index);
        const cellType = (args.cell_type as string) || 'code';
        const content = (args.content as string) || '';
        const uri = safeResolvePath(ctx.workspaceRoot, filePath);

        const data = await vscode.workspace.fs.readFile(uri);
        const notebook = JSON.parse(Buffer.from(data).toString('utf-8'));

        if (!notebook.cells || !Array.isArray(notebook.cells)) {
            return 'Error: Not a valid notebook file (no cells array).';
        }

        const newCell = {
            cell_type: cellType,
            source: content.split('\n').map((l: string, i: number, a: string[]) => i < a.length - 1 ? l + '\n' : l),
            metadata: {},
            ...(cellType === 'code' ? { outputs: [], execution_count: null } : {}),
        };

        switch (action) {
            case 'replace':
                if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
                    return `Error: Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).`;
                }
                notebook.cells[cellIndex] = { ...notebook.cells[cellIndex], ...newCell };
                break;
            case 'insert':
                notebook.cells.splice(cellIndex, 0, newCell);
                break;
            case 'delete':
                if (cellIndex < 0 || cellIndex >= notebook.cells.length) {
                    return `Error: Cell index ${cellIndex} out of range (0-${notebook.cells.length - 1}).`;
                }
                notebook.cells.splice(cellIndex, 1);
                break;
            default:
                return `Unknown action: ${action}`;
        }

        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(notebook, null, 1), 'utf-8'));
        return `Notebook ${action} at cell ${cellIndex} successful. ${notebook.cells.length} cells total.`;
    },
});

export const fileTools: ToolSpec[] = [readFileTool, writeFileTool, editFileTool, notebookEditTool];
