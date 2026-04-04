"use strict";
/**
 * Language Server Protocol Tools
 *   #20 list_diagnostics    — Get workspace/file diagnostic errors and warnings
 *   #21 get_document_symbols — Get symbols (functions, classes, etc.) in a file
 *   #22 go_to_definition     — Find where a symbol is defined
 *   #23 find_references      — Find all references to a symbol
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.lspTools = exports.findReferencesTool = exports.goToDefinitionTool = exports.getDocumentSymbolsTool = exports.listDiagnosticsTool = void 0;
const vscode = require("vscode");
const types_1 = require("./types");
const file_1 = require("./file");
// ---------------------------------------------------------------------------
// #20 — list_diagnostics
// ---------------------------------------------------------------------------
exports.listDiagnosticsTool = (0, types_1.defineTool)({
    name: 'list_diagnostics',
    category: 'search',
    description: 'Get diagnostic errors and warnings from the workspace. Returns file paths, line numbers, ' +
        'severity levels, and messages for all problems detected by language servers. ' +
        'Optionally filter to a specific file path.',
    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Optional relative file path to filter diagnostics. If omitted, returns all workspace diagnostics.',
            },
            severity: {
                type: 'string',
                description: 'Filter by severity: "error", "warning", "info", or "hint". Default: all.',
                enum: ['error', 'warning', 'info', 'hint'],
            },
        },
        required: [],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const filePath = args.path;
        const severityFilter = args.severity;
        let allDiagnostics = vscode.languages.getDiagnostics();
        // Filter to specific file if requested
        if (filePath) {
            const uri = (0, file_1.safeResolvePath)(ctx.workspaceRoot, filePath);
            allDiagnostics = allDiagnostics.filter(([u]) => u.fsPath.toLowerCase() === uri.fsPath.toLowerCase());
        }
        // Map severity to vscode enum
        const severityMap = {
            'error': vscode.DiagnosticSeverity.Error,
            'warning': vscode.DiagnosticSeverity.Warning,
            'info': vscode.DiagnosticSeverity.Information,
            'hint': vscode.DiagnosticSeverity.Hint,
        };
        const severityNames = ['Error', 'Warning', 'Info', 'Hint'];
        const results = [];
        for (const [uri, diags] of allDiagnostics) {
            let filtered = diags;
            if (severityFilter && severityMap[severityFilter] !== undefined) {
                filtered = diags.filter(d => d.severity === severityMap[severityFilter]);
            }
            if (filtered.length === 0) {
                continue;
            }
            const relPath = vscode.workspace.asRelativePath(uri);
            for (const d of filtered) {
                const sev = severityNames[d.severity] || 'Unknown';
                const line = d.range.start.line + 1;
                const col = d.range.start.character + 1;
                const src = d.source ? ` [${d.source}]` : '';
                results.push(`${relPath}:${line}:${col} ${sev}${src}: ${d.message}`);
            }
        }
        if (results.length === 0) {
            return filePath
                ? `No diagnostics found for ${filePath}.`
                : 'No diagnostics found in the workspace.';
        }
        return `Found ${results.length} diagnostic(s):\n\n${results.join('\n')}`;
    },
});
// ---------------------------------------------------------------------------
// #21 — get_document_symbols
// ---------------------------------------------------------------------------
exports.getDocumentSymbolsTool = (0, types_1.defineTool)({
    name: 'get_document_symbols',
    category: 'search',
    description: 'Get all symbols (functions, classes, variables, interfaces, etc.) in a file. ' +
        'Uses VS Code\'s language server for accurate symbol detection. ' +
        'Returns symbol names, kinds, and line numbers.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the file to analyze.' },
        },
        required: ['path'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const filePath = args.path;
        const uri = (0, file_1.safeResolvePath)(ctx.workspaceRoot, filePath);
        const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
        if (!symbols || symbols.length === 0) {
            return `No symbols found in ${filePath}. The language server may not be active for this file type.`;
        }
        const kindNames = {
            [vscode.SymbolKind.File]: 'File',
            [vscode.SymbolKind.Module]: 'Module',
            [vscode.SymbolKind.Namespace]: 'Namespace',
            [vscode.SymbolKind.Package]: 'Package',
            [vscode.SymbolKind.Class]: 'Class',
            [vscode.SymbolKind.Method]: 'Method',
            [vscode.SymbolKind.Property]: 'Property',
            [vscode.SymbolKind.Field]: 'Field',
            [vscode.SymbolKind.Constructor]: 'Constructor',
            [vscode.SymbolKind.Enum]: 'Enum',
            [vscode.SymbolKind.Interface]: 'Interface',
            [vscode.SymbolKind.Function]: 'Function',
            [vscode.SymbolKind.Variable]: 'Variable',
            [vscode.SymbolKind.Constant]: 'Constant',
            [vscode.SymbolKind.String]: 'String',
            [vscode.SymbolKind.Number]: 'Number',
            [vscode.SymbolKind.Boolean]: 'Boolean',
            [vscode.SymbolKind.Array]: 'Array',
            [vscode.SymbolKind.Object]: 'Object',
            [vscode.SymbolKind.Key]: 'Key',
            [vscode.SymbolKind.Null]: 'Null',
            [vscode.SymbolKind.EnumMember]: 'EnumMember',
            [vscode.SymbolKind.Struct]: 'Struct',
            [vscode.SymbolKind.Event]: 'Event',
            [vscode.SymbolKind.Operator]: 'Operator',
            [vscode.SymbolKind.TypeParameter]: 'TypeParameter',
        };
        const lines = [];
        const formatSymbol = (sym, indent = 0) => {
            const prefix = '  '.repeat(indent);
            if ('range' in sym && 'children' in sym) {
                // DocumentSymbol
                const kind = kindNames[sym.kind] || 'Unknown';
                const line = sym.range.start.line + 1;
                lines.push(`${prefix}${kind} ${sym.name} (line ${line})`);
                for (const child of sym.children) {
                    formatSymbol(child, indent + 1);
                }
            }
            else {
                // SymbolInformation
                const kind = kindNames[sym.kind] || 'Unknown';
                const loc = sym.location;
                const line = loc.range.start.line + 1;
                lines.push(`${prefix}${kind} ${sym.name} (line ${line})`);
            }
        };
        for (const sym of symbols) {
            formatSymbol(sym);
        }
        return `Symbols in ${filePath}:\n\n${lines.join('\n')}`;
    },
});
// ---------------------------------------------------------------------------
// #22 — go_to_definition
// ---------------------------------------------------------------------------
exports.goToDefinitionTool = (0, types_1.defineTool)({
    name: 'go_to_definition',
    category: 'search',
    description: 'Find the definition location of a symbol at a specific position in a file. ' +
        'Uses VS Code\'s language server for accurate cross-file navigation. ' +
        'Returns the file path, line number, and a preview of the definition.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the file containing the symbol.' },
            line: { type: 'number', description: 'Line number (1-based) where the symbol appears.' },
            character: { type: 'number', description: 'Column number (1-based) within the line.' },
        },
        required: ['path', 'line', 'character'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const filePath = args.path;
        const line = Math.max(1, Number(args.line) || 1);
        const character = Math.max(1, Number(args.character) || 1);
        const uri = (0, file_1.safeResolvePath)(ctx.workspaceRoot, filePath);
        const position = new vscode.Position(line - 1, character - 1);
        const locations = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position);
        if (!locations || locations.length === 0) {
            return `No definition found at ${filePath}:${line}:${character}. ` +
                'The language server may not be active or the position may not be on a symbol.';
        }
        const results = [];
        for (const loc of locations.slice(0, 5)) {
            let targetUri;
            let targetRange;
            if ('targetUri' in loc) {
                // LocationLink
                targetUri = loc.targetUri;
                targetRange = loc.targetRange;
            }
            else {
                // Location
                targetUri = loc.uri;
                targetRange = loc.range;
            }
            const relPath = vscode.workspace.asRelativePath(targetUri);
            const defLine = targetRange.start.line + 1;
            const defCol = targetRange.start.character + 1;
            // Try to read a preview of the definition
            let preview = '';
            try {
                const data = await vscode.workspace.fs.readFile(targetUri);
                const content = Buffer.from(data).toString('utf-8');
                const allLines = content.split('\n');
                const start = Math.max(0, targetRange.start.line);
                const end = Math.min(allLines.length, targetRange.start.line + 5);
                preview = allLines.slice(start, end)
                    .map((l, i) => `${start + i + 1}\t${l}`)
                    .join('\n');
            }
            catch { /* ignore */ }
            results.push(`${relPath}:${defLine}:${defCol}${preview ? '\n' + preview : ''}`);
        }
        return `Definition(s) found:\n\n${results.join('\n\n')}`;
    },
});
// ---------------------------------------------------------------------------
// #23 — find_references
// ---------------------------------------------------------------------------
exports.findReferencesTool = (0, types_1.defineTool)({
    name: 'find_references',
    category: 'search',
    description: 'Find all references to a symbol at a specific position in a file. ' +
        'Uses VS Code\'s language server. Returns file paths and line numbers for each reference.',
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Relative path to the file containing the symbol.' },
            line: { type: 'number', description: 'Line number (1-based) where the symbol appears.' },
            character: { type: 'number', description: 'Column number (1-based) within the line.' },
        },
        required: ['path', 'line', 'character'],
    },
    requiresConfirmation: false,
    permissionLevel: 'read',
    async execute(args, ctx) {
        const filePath = args.path;
        const line = Math.max(1, Number(args.line) || 1);
        const character = Math.max(1, Number(args.character) || 1);
        const uri = (0, file_1.safeResolvePath)(ctx.workspaceRoot, filePath);
        const position = new vscode.Position(line - 1, character - 1);
        const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position);
        if (!locations || locations.length === 0) {
            return `No references found at ${filePath}:${line}:${character}. ` +
                'The language server may not be active or the position may not be on a symbol.';
        }
        const results = [];
        const limit = 50;
        for (const loc of locations.slice(0, limit)) {
            const relPath = vscode.workspace.asRelativePath(loc.uri);
            const refLine = loc.range.start.line + 1;
            const refCol = loc.range.start.character + 1;
            // Read the matching line for context
            let lineText = '';
            try {
                const data = await vscode.workspace.fs.readFile(loc.uri);
                const content = Buffer.from(data).toString('utf-8');
                const allLines = content.split('\n');
                if (loc.range.start.line < allLines.length) {
                    lineText = ': ' + allLines[loc.range.start.line].trim();
                }
            }
            catch { /* ignore */ }
            results.push(`${relPath}:${refLine}:${refCol}${lineText}`);
        }
        const truncated = locations.length > limit ? ` (showing first ${limit} of ${locations.length})` : '';
        return `Found ${locations.length} reference(s)${truncated}:\n\n${results.join('\n')}`;
    },
});
exports.lspTools = [
    exports.listDiagnosticsTool,
    exports.getDocumentSymbolsTool,
    exports.goToDefinitionTool,
    exports.findReferencesTool,
];
//# sourceMappingURL=lsp.js.map