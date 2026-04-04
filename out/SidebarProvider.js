"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SidebarProvider = void 0;
const vscode = require("vscode");
const llmProvider_1 = require("./llmProvider");
const index_1 = require("./tools/index");
const costTracker_1 = require("./costTracker");
const permissions_1 = require("./permissions");
const sessionStore_1 = require("./sessionStore");
const HARNESS_CONFIG = {
    maxTurns: 32,
    compactAfterMessages: 40,
    defaultThinkingBudget: 10000,
    /** Fraction of model's max context at which to auto-compact. */
    autoCompactRatio: 0.85,
};
/** Known context window sizes (tokens) for common models. */
const MODEL_CONTEXT_LIMITS = {
    // Anthropic
    'claude-sonnet-4-20250514': 200_000,
    'claude-opus-4-20250514': 200_000,
    'claude-sonnet-4-5-20250514': 200_000,
    'claude-haiku-3-5-20241022': 200_000,
    'claude-sonnet-4-6-20250725': 1_000_000,
    'claude-opus-4-6-20250725': 1_000_000,
    // OpenAI
    'gpt-4o': 128_000,
    'gpt-4o-mini': 128_000,
    'gpt-4-turbo': 128_000,
    'gpt-4': 8_192,
    'o1': 200_000,
    'o1-mini': 128_000,
    'o1-preview': 128_000,
    'o3': 200_000,
    'o3-mini': 200_000,
    'o4-mini': 200_000,
    // DeepSeek
    'deepseek/deepseek-chat': 64_000,
    'deepseek/deepseek-r1': 64_000,
    // Gemini
    'google/gemini-2.5-pro': 1_000_000,
    'google/gemini-2.5-flash': 1_000_000,
    'google/gemini-2.0-flash': 1_000_000,
    // Llama
    'meta-llama/llama-3.1-405b-instruct': 128_000,
    'meta-llama/llama-3.1-70b-instruct': 128_000,
    'meta-llama/llama-4-maverick': 1_000_000,
};
/** Default context limit when model is unknown. Conservative to avoid 400s. */
const DEFAULT_CONTEXT_LIMIT = 128_000;
function getContextLimit(model, provider) {
    if (!model) {
        // Default per provider when no model specified
        if (provider === 'Anthropic') {
            return 200_000;
        }
        if (provider === 'OpenAI') {
            return 128_000;
        }
        if (provider === 'Local') {
            return 32_000;
        }
        return DEFAULT_CONTEXT_LIMIT;
    }
    // Exact match
    if (MODEL_CONTEXT_LIMITS[model]) {
        return MODEL_CONTEXT_LIMITS[model];
    }
    // Prefix match (e.g. "gpt-4o-2024-08-06" → "gpt-4o")
    for (const [key, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
        if (model.startsWith(key) || model.includes(key)) {
            return limit;
        }
    }
    // Heuristic by name patterns
    const m = model.toLowerCase();
    if (m.includes('claude') && (m.includes('4-6') || m.includes('4.6'))) {
        return 1_000_000;
    }
    if (m.includes('claude')) {
        return 200_000;
    }
    if (m.includes('gpt-4o') || m.includes('gpt-4-turbo')) {
        return 128_000;
    }
    if (m.includes('gemini')) {
        return 1_000_000;
    }
    if (m.includes('deepseek')) {
        return 64_000;
    }
    if (m.includes('llama-4')) {
        return 1_000_000;
    }
    if (m.includes('llama')) {
        return 128_000;
    }
    if (m.includes('qwen')) {
        return 128_000;
    }
    if (m.includes('mistral')) {
        return 128_000;
    }
    return DEFAULT_CONTEXT_LIMIT;
}
class SidebarProvider {
    _extensionUri;
    _globalState;
    _view;
    _history = [];
    _costTracker = new costTracker_1.CostTracker();
    _sessionStore;
    _toolPool;
    _abortController = null;
    _thinkingEnabled = true;
    _autoApprove = false;
    _lastContextTokens = 0;
    _currentModel;
    _currentProvider;
    constructor(_extensionUri, _globalState) {
        this._extensionUri = _extensionUri;
        this._globalState = _globalState;
        this._sessionStore = new sessionStore_1.SessionStore(_globalState);
        this._toolPool = (0, index_1.assembleToolPool)({ permissions: (0, permissions_1.permissionsFullAccess)() });
        const saved = this._sessionStore.load();
        if (saved) {
            this._history = saved.messages;
            this._costTracker.record('restored', saved.usage.inputTokens, saved.usage.outputTokens);
        }
    }
    /** Public clear for the newChat command */
    clearHistory() {
        this._history = [];
        this._costTracker.reset();
        this._lastContextTokens = 0;
        this._sessionStore.clear();
        this._toolPool.resetTurn();
        if (this._view) {
            this._view.webview.postMessage({ type: 'cleared' });
            this._view.webview.postMessage({ type: 'contextBar', value: { percent: 0, label: '' } });
        }
    }
    /** Add code selection to the chat as context. Called from editor right-click. */
    addCodeContext(snippet) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'addCodeContext',
                value: snippet,
            });
        }
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        this._sendSavedSettings(webviewView);
        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case "webviewReady":
                    // Webview JS is loaded — now safe to replay history
                    this._replayHistory(webviewView);
                    break;
                case "askAgent":
                    await this._handleAskAgent(webviewView, data.value);
                    break;
                case "cancelAgent":
                    this._handleCancel();
                    break;
                case "clearHistory":
                    this.clearHistory();
                    break;
                case "compactHistory":
                    await this._handleCompact(webviewView, data.value);
                    break;
                case "toggleThinking":
                    this._thinkingEnabled = !!data.value;
                    break;
                case "toggleAutoApprove":
                    this._autoApprove = !!data.value;
                    break;
                case "saveSettings":
                    this._saveSettings(data.value);
                    break;
                case "confirmToolResponse":
                    this._handleConfirmResponse(!!data.value);
                    break;
                case "searchFiles":
                    this._handleSearchFiles(webviewView, data.value);
                    break;
                case "readFileForAttach":
                    this._handleReadFileForAttach(webviewView, data.value);
                    break;
                case "exportConversation":
                    this._handleExportConversation(webviewView);
                    break;
                case "importConversation":
                    this._handleImportConversation(webviewView);
                    break;
                case "refreshGit":
                    this._handleRefreshGit(webviewView);
                    break;
                case "fetchModels":
                    this._handleFetchModels(webviewView, data.value);
                    break;
            }
        });
    }
    // ── Agent loop ──────────────────────────────────────────────────────────
    async _handleAskAgent(webviewView, value) {
        if (!value || typeof value !== 'object') {
            return;
        }
        const provider = value.provider;
        const apiKey = value.apiKey;
        const prompt = value.prompt;
        const baseUrl = value.baseUrl;
        const model = value.model;
        const rawImages = value.images;
        const fileAttachments = value.fileAttachments;
        // Track current model/provider for context limit lookups
        this._currentModel = model;
        this._currentProvider = provider;
        if (!apiKey) {
            webviewView.webview.postMessage({ type: 'addResponse', value: 'Please set your API key in the settings panel above.' });
            webviewView.webview.postMessage({ type: 'done' });
            return;
        }
        if (!prompt || !prompt.trim()) {
            webviewView.webview.postMessage({ type: 'done' });
            return;
        }
        // Handle /learn command — inject workspace exploration prompt
        let fullPrompt = prompt;
        if (prompt.trim() === '/learn') {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'the current directory';
            fullPrompt = `You are being asked to thoroughly learn and explore this workspace to build deep context for future questions. Spend this entire turn exploring the codebase. Do NOT ask the user any questions — just explore autonomously.

Your goal is to build a comprehensive understanding of:
1. **Project structure** — Use bash (ls, tree, or dir) to map the directory layout. Start from the workspace root: ${wsRoot}
2. **Key configuration files** — Read package.json, tsconfig.json, Cargo.toml, pyproject.toml, Makefile, docker-compose.yml, or whatever build/config files exist
3. **Entry points** — Find and read main entry files (index.ts, main.py, App.tsx, etc.)
4. **Architecture** — Use glob_search and grep_search to understand the project's module structure, key abstractions, data models, and API boundaries
5. **Dependencies** — Check what libraries/frameworks are used
6. **Tests** — Find where tests live and what testing frameworks are used
7. **Documentation** — Read any README, CONTRIBUTING, or doc files

At the end, provide a clear, well-structured summary of everything you learned about this workspace. Include:
- What the project is and what it does
- Tech stack and key dependencies
- Directory structure overview
- Key files and their purposes
- Architecture patterns you noticed
- Any issues or observations

Be thorough. Use multiple tools in sequence. Read important files fully. This is your one chance to deeply understand the codebase.`;
        }
        else if (prompt.trim().startsWith('/commit')) {
            const userMsg = prompt.trim().slice('/commit'.length).trim();
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
            fullPrompt = `Perform a git commit in the workspace root: ${wsRoot}

Steps:
1. Run \`git status\` to see what files have changed (staged and unstaged)
2. Run \`git diff\` and \`git diff --staged\` to review the actual changes
3. Stage the appropriate files with \`git add\` — stage all modified/new files unless something looks like it shouldn't be committed (e.g. .env, credentials, large binaries). If unsure, mention it.
4. Create the commit:
${userMsg
                ? `   - Use this commit message: "${userMsg}"`
                : `   - Auto-generate a concise, descriptive commit message based on the changes. Focus on the "why" not the "what". Use conventional commit style if the repo already uses it.`}
5. Show the result with \`git log --oneline -3\` so the user can see it worked.

If there are no changes to commit, just tell the user. Do NOT ask questions — just do it.`;
        }
        else if (prompt.trim().startsWith('/push')) {
            const pushArgs = prompt.trim().slice('/push'.length).trim();
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';
            fullPrompt = `Push commits to remote in the workspace root: ${wsRoot}

Steps:
1. Run \`git status\` and \`git log --oneline -5\` to show current state
2. Run \`git remote -v\` to confirm the remote
3. Push with: \`git push ${pushArgs || 'origin HEAD'}\`
4. Report the result — show what was pushed and to where.

If the push fails (e.g. need to set upstream), fix it automatically with \`git push -u origin HEAD\`. Do NOT ask questions — just do it.`;
        }
        else if (prompt.trim().startsWith('/style')) {
            const styleRequest = prompt.trim().slice('/style'.length).trim();
            fullPrompt = `You are now acting as a **senior CSS/UI styling specialist**. Your expertise covers:
- CSS3, Flexbox, Grid, animations, transitions, transforms
- Responsive design (media queries, container queries, clamp(), fluid typography)
- Modern CSS (custom properties, :has(), :is(), nesting, @layer, @scope)
- CSS-in-JS, Tailwind, SCSS/SASS, styled-components, CSS Modules
- Accessibility (contrast, focus states, reduced-motion, screen readers)
- Cross-browser compatibility and performance
- Dark mode / theming patterns

**Your approach for this task:**
1. First, find the relevant files — use glob_search to locate stylesheets, component files, or layout files related to the request
2. Read the existing styles and HTML/JSX structure to understand what's already there
3. Make precise, clean CSS changes — prefer modern CSS over hacks
4. Keep changes minimal and scoped — don't restyle unrelated things
5. Test for responsiveness if the request involves layout
6. If the user attached an image (screenshot/mockup), match that design closely

**The user's styling request:**

${styleRequest}`;
        }
        else if (prompt.trim() === '/review') {
            fullPrompt = `Review the recent code changes in this workspace for potential issues.

Steps:
1. Run \`git diff\` to see unstaged changes, and \`git diff --staged\` for staged changes
2. If no uncommitted changes, run \`git log --oneline -5\` then \`git diff HEAD~1\` to review the last commit
3. Analyze the changes for:
   - Bugs or logic errors
   - Security vulnerabilities (injection, hardcoded secrets, etc.)
   - Style inconsistencies
   - Missing error handling
   - Performance issues
4. Provide a clear summary with specific line references and suggestions.

Be constructive and specific. Do NOT ask questions — just review.`;
        }
        if (fileAttachments && fileAttachments.length > 0) {
            const fileContext = fileAttachments.map(f => `--- ${f.path} ---\n${f.content}`).join('\n\n');
            fullPrompt = `${prompt}\n\n<attached_files>\n${fileContext}\n</attached_files>`;
        }
        const images = rawImages?.length
            ? rawImages.map(img => ({ data: img.data, mediaType: img.mediaType }))
            : undefined;
        this._history.push({ role: 'user', content: fullPrompt, ...(images ? { images } : {}) });
        this._toolPool.resetTurn();
        this._abortController = new AbortController();
        const postMessage = (msg) => {
            webviewView.webview.postMessage(msg);
        };
        const isAnthropic = provider === 'Anthropic';
        const thinkingBudget = (isAnthropic && this._thinkingEnabled)
            ? HARNESS_CONFIG.defaultThinkingBudget : undefined;
        try {
            let turnsUsed = 0;
            while (turnsUsed < HARNESS_CONFIG.maxTurns) {
                if (this._abortController.signal.aborted) {
                    webviewView.webview.postMessage({ type: 'addResponse', value: '(Cancelled)' });
                    break;
                }
                turnsUsed++;
                const llmOpts = {
                    provider: provider,
                    apiKey, messages: this._history, baseUrl, model,
                    toolPool: this._toolPool,
                    signal: this._abortController.signal,
                    planMode: false,
                    thinkingBudget,
                    onStream: (delta) => {
                        webviewView.webview.postMessage({ type: 'streamDelta', value: delta });
                    },
                    onThinkingStream: (delta) => {
                        webviewView.webview.postMessage({ type: 'thinkingDelta', value: delta });
                    },
                };
                const response = await (0, llmProvider_1.askLLM)(llmOpts);
                if (response.usage) {
                    this._costTracker.record(`turn-${turnsUsed}`, response.usage.inputTokens, response.usage.outputTokens);
                    // Track context size for auto-compact & context bar
                    this._lastContextTokens = response.usage.inputTokens;
                    this._postContextBar(webviewView);
                }
                if (response.thinking) {
                    webviewView.webview.postMessage({ type: 'thinkingEnd', value: response.thinking });
                }
                this._history.push({
                    role: 'assistant',
                    content: response.text || '',
                    ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}),
                });
                webviewView.webview.postMessage({ type: 'streamEnd' });
                if (response.toolCalls && response.toolCalls.length > 0) {
                    for (const tc of response.toolCalls) {
                        webviewView.webview.postMessage({ type: 'addProgress', value: tc.name });
                        const result = await this._toolPool.execute(tc.name, tc.arguments, {
                            workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
                            signal: this._abortController.signal,
                            postMessage,
                            confirmInChat: (toolName, summary) => this._confirmInChat(webviewView, toolName, summary, tc.arguments),
                            autoApprove: this._autoApprove,
                        });
                        this._history.push({ role: 'tool', content: result, toolCallId: tc.id });
                        // Quiet tools: show compact inline instead of full result block
                        const quietTools = ['TodoWrite', 'Sleep'];
                        const shellTools = ['bash', 'PowerShell'];
                        if (quietTools.includes(tc.name)) {
                            webviewView.webview.postMessage({
                                type: 'quietToolResult',
                                value: { name: tc.name, result: result.substring(0, 200) },
                            });
                        }
                        else if (shellTools.includes(tc.name)) {
                            webviewView.webview.postMessage({
                                type: 'shellResult',
                                value: {
                                    command: String(tc.arguments.command || ''),
                                    output: result.substring(0, 2000),
                                    exitOk: !result.startsWith('Tool "') && !result.includes('STDERR:'),
                                },
                            });
                        }
                        else {
                            webviewView.webview.postMessage({
                                type: 'toolResult',
                                value: { name: tc.name, result: result.substring(0, 800) },
                            });
                        }
                    }
                    // Auto-compact if context is getting too large
                    const ctxLimit = this._getContextLimit();
                    const compactThreshold = Math.floor(ctxLimit * HARNESS_CONFIG.autoCompactRatio);
                    if (this._lastContextTokens >= compactThreshold) {
                        webviewView.webview.postMessage({
                            type: 'compactDone',
                            value: `Auto-compacting: context reached ${Math.round(this._lastContextTokens / 1000)}k tokens...`,
                        });
                        await this._handleCompact(webviewView, this._getCurrentSettings());
                        this._lastContextTokens = 0;
                        this._postContextBar(webviewView);
                    }
                }
                else {
                    break;
                }
            }
            if (turnsUsed >= HARNESS_CONFIG.maxTurns) {
                webviewView.webview.postMessage({
                    type: 'addResponse',
                    value: `Reached max ${HARNESS_CONFIG.maxTurns} turns. Send another message to continue.`,
                });
            }
            this._compactHistoryIfNeeded();
            this._sessionStore.save('default', this._history, this._costTracker.totalUsage);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            webviewView.webview.postMessage({ type: 'streamEnd' });
            webviewView.webview.postMessage({ type: 'addResponse', value: `Error: ${message}` });
        }
        finally {
            this._abortController = null;
            this._postUsage(webviewView);
            webviewView.webview.postMessage({ type: 'done' });
        }
    }
    _replayHistory(webviewView) {
        if (this._history.length === 0) {
            return;
        }
        for (const msg of this._history) {
            if (msg.role === 'user') {
                webviewView.webview.postMessage({ type: 'addUserMessage', value: msg.content });
            }
            else if (msg.role === 'assistant' && msg.content) {
                webviewView.webview.postMessage({ type: 'addResponse', value: msg.content });
            }
        }
        this._postUsage(webviewView);
    }
    _handleCancel() {
        if (this._abortController) {
            this._abortController.abort();
        }
        // Resolve any pending confirmation as denied
        if (this._pendingConfirmResolve) {
            this._pendingConfirmResolve(false);
            this._pendingConfirmResolve = null;
        }
    }
    // ── Inline confirmation ────────────────────────────────────────────────
    _pendingConfirmResolve = null;
    async _confirmInChat(webviewView, toolName, summary, args) {
        // Build diff data for file tools
        let diff;
        if (args && (toolName === 'write_file' || toolName === 'edit_file')) {
            try {
                const filePath = (args.path || args.file_path || args.filePath || '');
                const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
                if (filePath && wsRoot) {
                    const path = await Promise.resolve().then(() => require('path'));
                    const uri = vscode.Uri.file(path.resolve(wsRoot, filePath));
                    let oldContent = '';
                    try {
                        const data = await vscode.workspace.fs.readFile(uri);
                        oldContent = Buffer.from(data).toString('utf-8');
                    }
                    catch { /* new file */ }
                    if (toolName === 'write_file') {
                        diff = { filePath, oldStr: oldContent, newStr: args.content || '' };
                    }
                    else if (toolName === 'edit_file') {
                        const oldString = args.old_string || '';
                        const newString = args.new_string || '';
                        diff = { filePath, oldStr: oldString, newStr: newString };
                    }
                }
            }
            catch { /* ignore — fall back to plain summary */ }
        }
        return new Promise((resolve) => {
            this._pendingConfirmResolve = resolve;
            webviewView.webview.postMessage({
                type: 'confirmTool',
                value: { name: toolName, summary, diff },
            });
        });
    }
    _handleConfirmResponse(allowed) {
        if (this._pendingConfirmResolve) {
            this._pendingConfirmResolve(allowed);
            this._pendingConfirmResolve = null;
        }
    }
    // ── File search for @-mentions ────────────────────────────────────────
    async _handleSearchFiles(webviewView, query) {
        if (!query || query.length < 1) {
            webviewView.webview.postMessage({ type: 'fileSearchResults', value: [] });
            return;
        }
        try {
            const pattern = `**/*${query}*`;
            const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 15);
            const results = uris.map(u => vscode.workspace.asRelativePath(u));
            webviewView.webview.postMessage({ type: 'fileSearchResults', value: results });
        }
        catch {
            webviewView.webview.postMessage({ type: 'fileSearchResults', value: [] });
        }
    }
    async _handleReadFileForAttach(webviewView, filePath) {
        try {
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            const path = await Promise.resolve().then(() => require('path'));
            const uri = vscode.Uri.file(path.resolve(wsRoot, filePath));
            const data = await vscode.workspace.fs.readFile(uri);
            const content = Buffer.from(data).toString('utf-8');
            // Limit to first 500 lines to avoid token bloat
            const lines = content.split('\n');
            const truncated = lines.length > 500
                ? lines.slice(0, 500).join('\n') + `\n\n(... truncated, ${lines.length - 500} more lines)`
                : content;
            webviewView.webview.postMessage({
                type: 'fileContentForAttach',
                value: { path: filePath, content: truncated },
            });
        }
        catch (err) {
            webviewView.webview.postMessage({
                type: 'fileContentForAttach',
                value: { path: filePath, content: '(could not read file)', error: true },
            });
        }
    }
    // ── Export / Import ──────────────────────────────────────────────────
    async _handleExportConversation(webviewView) {
        if (this._history.length === 0) {
            webviewView.webview.postMessage({ type: 'exportDone', value: 'Nothing to export (no conversation yet).' });
            return;
        }
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
            const defaultUri = vscode.Uri.file((vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '') + `/claw-conversation-${timestamp}.json`);
            const uri = await vscode.window.showSaveDialog({
                defaultUri,
                filters: { 'JSON': ['json'], 'All Files': ['*'] },
                title: 'Export Conversation',
            });
            if (!uri) {
                webviewView.webview.postMessage({ type: 'exportDone', value: 'Export cancelled.' });
                return;
            }
            const exportData = {
                version: 1,
                exportedAt: new Date().toISOString(),
                messageCount: this._history.length,
                usage: this._costTracker.totalUsage,
                messages: this._history,
            };
            const content = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
            await vscode.workspace.fs.writeFile(uri, content);
            webviewView.webview.postMessage({
                type: 'exportDone',
                value: `Exported ${this._history.length} messages to ${vscode.workspace.asRelativePath(uri)}`,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            webviewView.webview.postMessage({ type: 'exportDone', value: `Export failed: ${message}` });
        }
    }
    async _handleImportConversation(webviewView) {
        try {
            const uris = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { 'JSON': ['json'], 'All Files': ['*'] },
                title: 'Import Conversation',
            });
            if (!uris || uris.length === 0) {
                webviewView.webview.postMessage({ type: 'importDone', value: 'Import cancelled.' });
                return;
            }
            const data = await vscode.workspace.fs.readFile(uris[0]);
            const json = JSON.parse(Buffer.from(data).toString('utf-8'));
            if (!json.messages || !Array.isArray(json.messages)) {
                webviewView.webview.postMessage({ type: 'importDone', value: 'Invalid file: no messages array found.' });
                return;
            }
            // Replace current history
            this._history = json.messages;
            this._costTracker.reset();
            if (json.usage) {
                this._costTracker.record('imported', json.usage.inputTokens || 0, json.usage.outputTokens || 0);
            }
            this._sessionStore.save('default', this._history, this._costTracker.totalUsage);
            // Refresh the webview
            webviewView.webview.postMessage({ type: 'cleared' });
            this._replayHistory(webviewView);
            this._postUsage(webviewView);
            webviewView.webview.postMessage({
                type: 'importDone',
                value: `Imported ${this._history.length} messages from ${vscode.workspace.asRelativePath(uris[0])}`,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            webviewView.webview.postMessage({ type: 'importDone', value: `Import failed: ${message}` });
        }
    }
    // ── Git status ──────────────────────────────────────────────────────
    async _handleRefreshGit(webviewView) {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!wsRoot) {
            webviewView.webview.postMessage({ type: 'gitStatus', value: null });
            return;
        }
        try {
            const cp = await Promise.resolve().then(() => require('child_process'));
            const { promisify } = await Promise.resolve().then(() => require('util'));
            const exec = promisify(cp.exec);
            const [branchResult, statusResult] = await Promise.all([
                exec('git rev-parse --abbrev-ref HEAD', { cwd: wsRoot }).catch(() => ({ stdout: '' })),
                exec('git status --porcelain', { cwd: wsRoot }).catch(() => ({ stdout: '' })),
            ]);
            const branch = (branchResult.stdout || '').trim();
            if (!branch) {
                webviewView.webview.postMessage({ type: 'gitStatus', value: null });
                return;
            }
            const lines = (statusResult.stdout || '').trim().split('\n').filter((l) => l.length > 0);
            let staged = 0, modified = 0, untracked = 0;
            for (const line of lines) {
                const x = line[0], y = line[1];
                if (x === '?' && y === '?') {
                    untracked++;
                }
                else if (x !== ' ' && x !== '?') {
                    staged++;
                }
                if (y !== ' ' && y !== '?') {
                    modified++;
                }
            }
            webviewView.webview.postMessage({
                type: 'gitStatus',
                value: { branch, staged, modified, untracked },
            });
        }
        catch {
            webviewView.webview.postMessage({ type: 'gitStatus', value: null });
        }
    }
    /** Model list cache — avoid re-fetching on every provider switch. */
    _modelCache = new Map();
    async _handleFetchModels(webviewView, value) {
        const provider = value?.provider;
        const apiKey = value?.apiKey;
        const baseUrl = value?.baseUrl;
        // Check cache (5 minute TTL)
        const cached = this._modelCache.get(provider);
        if (cached && Date.now() - cached.ts < 300_000) {
            webviewView.webview.postMessage({ type: 'modelList', value: { provider, models: cached.models } });
            return;
        }
        try {
            let models = [];
            if (provider === 'OpenRouter') {
                const res = await fetch('https://openrouter.ai/api/v1/models');
                const json = await res.json();
                const filtered = (json.data || [])
                    .filter((m) => {
                    const id = m.id.toLowerCase();
                    // Filter to popular/useful models
                    return id.includes('claude') || id.includes('gpt') || id.includes('o1')
                        || id.includes('o3') || id.includes('o4') || id.includes('gemini')
                        || id.includes('deepseek') || id.includes('llama')
                        || id.includes('mistral') || id.includes('qwen');
                });
                // Cache context_length from API into our lookup table
                for (const m of filtered) {
                    if (m.context_length && m.context_length > 0) {
                        MODEL_CONTEXT_LIMITS[m.id] = m.context_length;
                    }
                }
                models = filtered
                    .map((m) => ({ id: m.id, name: m.name || m.id }))
                    .sort((a, b) => a.name.localeCompare(b.name));
            }
            else if (provider === 'OpenAI') {
                const url = (baseUrl || 'https://api.openai.com/v1') + '/models';
                const res = await fetch(url, {
                    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
                });
                const json = await res.json();
                models = (json.data || [])
                    .filter((m) => {
                    const id = m.id.toLowerCase();
                    return (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4'))
                        && !id.includes('realtime') && !id.includes('audio')
                        && !id.includes('search') && !id.includes('transcri');
                })
                    .map((m) => ({ id: m.id, name: m.id }))
                    .sort((a, b) => a.id.localeCompare(b.id));
            }
            else if (provider === 'Local') {
                const url = (baseUrl || 'http://localhost:11434/v1') + '/models';
                const res = await fetch(url, {
                    headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {},
                });
                const json = await res.json();
                models = (json.data || [])
                    .map((m) => ({ id: m.id, name: m.id }))
                    .sort((a, b) => a.id.localeCompare(b.id));
            }
            if (models.length > 0) {
                this._modelCache.set(provider, { models, ts: Date.now() });
            }
            webviewView.webview.postMessage({ type: 'modelList', value: { provider, models } });
        }
        catch {
            webviewView.webview.postMessage({ type: 'modelList', value: { provider, models: [] } });
        }
    }
    async _handleCompact(webviewView, settings) {
        const before = this._history.length;
        if (before <= 4) {
            webviewView.webview.postMessage({ type: 'compactDone', value: 'Nothing to compact (history too short).' });
            return;
        }
        const provider = settings?.provider;
        const apiKey = settings?.apiKey;
        const baseUrl = settings?.baseUrl;
        const model = settings?.model;
        if (!apiKey) {
            // Fallback: naive compaction if no API key available
            this._naiveCompact(webviewView);
            return;
        }
        webviewView.webview.postMessage({ type: 'compactDone', value: 'Summarizing conversation...' });
        try {
            // Build a text representation of the conversation for the LLM to summarize
            const conversationText = this._history.map(m => {
                if (m.role === 'user') {
                    return `USER: ${m.content}`;
                }
                if (m.role === 'assistant') {
                    let text = `ASSISTANT: ${m.content || ''}`;
                    if (m.toolCalls?.length) {
                        text += '\n  Tool calls: ' + m.toolCalls.map(tc => `${tc.name}(${JSON.stringify(tc.arguments).substring(0, 100)})`).join(', ');
                    }
                    return text;
                }
                if (m.role === 'tool') {
                    return `TOOL RESULT: ${m.content.substring(0, 200)}`;
                }
                return '';
            }).join('\n');
            const summaryPrompt = [{
                    role: 'user',
                    content: `Summarize this conversation into a concise context block. Preserve:
- What files were read, created, or modified (with paths)
- Key decisions made and why
- Current state of the task (what's done, what's pending)
- Any errors encountered and how they were resolved
- Important code patterns or conventions discovered

Be concise but thorough. Format as a structured summary the assistant can use to continue working without losing context.

CONVERSATION:
${conversationText.substring(0, 12000)}`
                }];
            const response = await (0, llmProvider_1.askLLM)({
                provider: provider,
                apiKey,
                messages: summaryPrompt,
                baseUrl,
                model,
            });
            const summary = response.text || 'Summary could not be generated.';
            if (response.usage) {
                this._costTracker.record('compact', response.usage.inputTokens, response.usage.outputTokens);
            }
            // Keep last few recent messages for immediate context
            const recentCount = Math.min(6, Math.floor(before * 0.2));
            let sliceStart = before - recentCount;
            while (sliceStart < before && this._history[sliceStart].role !== 'user') {
                sliceStart++;
            }
            const recentMessages = this._history.slice(sliceStart);
            // Replace history with: summary as a user/assistant pair + recent messages
            this._history = [
                { role: 'user', content: '[Previous conversation was compacted. Here is the summary of what happened:]' },
                { role: 'assistant', content: summary },
                ...recentMessages,
            ];
            this._sessionStore.save('default', this._history, this._costTracker.totalUsage);
            webviewView.webview.postMessage({
                type: 'compactDone',
                value: `Compacted: ${before} messages → ${this._history.length} (summary + ${recentMessages.length} recent). Context preserved.`,
            });
            this._postUsage(webviewView);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            webviewView.webview.postMessage({
                type: 'compactDone',
                value: `Summary failed (${message}). Falling back to naive compaction.`,
            });
            this._naiveCompact(webviewView);
        }
    }
    /** Simple fallback compaction without LLM — just trims old messages. */
    _naiveCompact(webviewView) {
        const before = this._history.length;
        const keepCount = Math.max(4, Math.floor(before * 0.4));
        let sliceStart = before - keepCount;
        while (sliceStart < before && this._history[sliceStart].role !== 'user') {
            sliceStart++;
        }
        const removed = sliceStart - 1;
        this._history = [this._history[0], ...this._history.slice(sliceStart)];
        this._sessionStore.save('default', this._history, this._costTracker.totalUsage);
        webviewView.webview.postMessage({
            type: 'compactDone',
            value: `Compacted (no summary): removed ${removed} messages, kept ${this._history.length}.`,
        });
    }
    _compactHistoryIfNeeded() {
        if (this._history.length <= HARNESS_CONFIG.compactAfterMessages) {
            return;
        }
        const keep = Math.floor(HARNESS_CONFIG.compactAfterMessages * 0.75);
        let sliceStart = this._history.length - keep;
        // Walk forward to find a safe cut point — don't slice in the middle
        // of an assistant+tool group. A safe start is a 'user' message.
        while (sliceStart < this._history.length && this._history[sliceStart].role !== 'user') {
            sliceStart++;
        }
        this._history = [this._history[0], ...this._history.slice(sliceStart)];
    }
    _postUsage(webviewView) {
        const status = this._costTracker.formatStatus();
        if (status) {
            webviewView.webview.postMessage({ type: 'usage', value: status });
        }
    }
    _getContextLimit() {
        return getContextLimit(this._currentModel, this._currentProvider);
    }
    _postContextBar(webviewView) {
        const limit = this._getContextLimit();
        const pct = Math.min(100, Math.round((this._lastContextTokens / limit) * 100));
        const k = (n) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;
        webviewView.webview.postMessage({
            type: 'contextBar',
            value: {
                percent: pct,
                label: `${k(this._lastContextTokens)} / ${k(limit)} tokens`,
            },
        });
    }
    /** Get current settings from saved state (for auto-compact). */
    _getCurrentSettings() {
        const saved = this._globalState.get('claw-agent.settings');
        if (!saved) {
            return {};
        }
        // Extract the active provider's settings
        const provider = saved.provider || 'Anthropic';
        const ps = saved.providerSettings;
        if (ps && ps[provider]) {
            return { provider, apiKey: ps[provider].apiKey, baseUrl: ps[provider].baseUrl, model: ps[provider].model };
        }
        // Fallback to old flat format
        return saved;
    }
    _saveSettings(settings) {
        this._globalState.update('claw-agent.settings', settings);
        vscode.window.showInformationMessage('Settings saved.');
    }
    _sendSavedSettings(webviewView) {
        const saved = this._globalState.get('claw-agent.settings');
        if (saved) {
            webviewView.webview.postMessage({ type: 'loadSettings', value: saved });
        }
    }
    revive(panel) { this._view = panel; }
    // ── Webview HTML ────────────────────────────────────────────────────────
    _getHtmlForWebview(webview) {
        const toolCount = this._toolPool.size;
        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.js'));
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src data: https: ${webview.cspSource};">
<title>Claw Agent</title>
<style>
:root {
  --radius: 6px;
  --gap: 10px;
  --surface: var(--vscode-editor-background);
  --surface-raised: var(--vscode-sideBar-background, var(--vscode-editor-background));
  --border: var(--vscode-widget-border, rgba(128,128,128,0.2));
  --accent: var(--vscode-textLink-foreground, #4da6ff);
  --text: var(--vscode-editor-foreground);
  --text-muted: var(--vscode-descriptionForeground, rgba(200,200,200,0.6));
  --input-bg: var(--vscode-input-background);
  --input-fg: var(--vscode-input-foreground);
  --input-border: var(--vscode-input-border, rgba(128,128,128,0.3));
  --btn-bg: var(--vscode-button-background);
  --btn-fg: var(--vscode-button-foreground);
  --btn-hover: var(--vscode-button-hoverBackground);
  --btn2-bg: var(--vscode-button-secondaryBackground);
  --btn2-fg: var(--vscode-button-secondaryForeground);
  --code-bg: var(--vscode-textCodeBlock-background, rgba(0,0,0,0.2));
  --mono: var(--vscode-editor-font-family, 'Consolas', monospace);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
  font-size: 13px; color: var(--text); background: var(--surface);
}

/* ── Layout ── */
.app { display: flex; flex-direction: column; height: 100vh; }

/* ── Top bar ── */
.topbar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
  flex-shrink: 0;
}
.topbar-title {
  font-weight: 600; font-size: 13px;
  display: flex; align-items: center; gap: 6px;
}
.topbar-title svg { width: 16px; height: 16px; stroke: var(--accent); fill: none; }
.topbar-spacer { flex: 1; }
.topbar-btn {
  background: none; border: none; color: var(--text-muted); cursor: pointer;
  padding: 2px 4px; border-radius: 3px; font-size: 11px;
  display: flex; align-items: center; gap: 3px;
}
.topbar-btn:hover { color: var(--text); background: rgba(128,128,128,0.15); }
.topbar-btn.active { color: var(--accent); }

/* ── Settings drawer ── */
.settings-drawer {
  display: none; padding: 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
}
.settings-drawer.open { display: block; }
.settings-row { display: flex; gap: 6px; margin-bottom: 6px; align-items: center; }
.settings-row label { font-size: 11px; color: var(--text-muted); min-width: 55px; }
.settings-row select, .settings-row input {
  flex: 1; padding: 4px 6px; font-size: 12px;
  background: var(--input-bg); color: var(--input-fg);
  border: 1px solid var(--input-border); border-radius: 3px;
  font-family: inherit;
}
.settings-actions { display: flex; gap: 6px; margin-top: 6px; }
.settings-actions button {
  padding: 3px 10px; font-size: 11px; border: none; border-radius: 3px;
  cursor: pointer; font-family: inherit;
}
.btn-save { background: var(--btn-bg); color: var(--btn-fg); }
.btn-save:hover { background: var(--btn-hover); }

/* ── Messages ── */
.messages {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  padding: var(--gap); scroll-behavior: smooth;
}
.messages::-webkit-scrollbar { width: 4px; }
.messages::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 2px; }

.msg { margin-bottom: var(--gap); animation: fadeIn 0.15s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

/* User message */
.msg-user {
  display: flex; gap: 8px;
}
.msg-user-avatar {
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--accent); color: var(--surface);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; flex-shrink: 0; margin-top: 2px;
}
.msg-user-body {
  background: rgba(128,128,128,0.08); border-radius: var(--radius);
  padding: 8px 12px; max-width: 100%;
  line-height: 1.5; white-space: pre-wrap; word-wrap: break-word;
}

/* Assistant message */
.msg-assistant {
  padding: 2px 0;
  line-height: 1.6; white-space: pre-wrap; word-wrap: break-word;
}

/* Tool progress */
.msg-progress {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: var(--text-muted);
  padding: 4px 0;
}
.msg-progress .spinner {
  width: 12px; height: 12px; border: 2px solid var(--border);
  border-top-color: var(--accent); border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Tool result */
.msg-tool {
  background: var(--code-bg); border-radius: var(--radius);
  border-left: 3px solid var(--accent);
  padding: 6px 10px; font-size: 12px;
  max-height: 200px; overflow-y: auto;
  font-family: var(--mono); line-height: 1.4;
  white-space: pre-wrap; word-wrap: break-word;
}
.msg-tool-name {
  font-size: 11px; font-weight: 600; color: var(--accent);
  margin-bottom: 4px; font-family: var(--mono);
}

/* Quiet tool result (TodoWrite, Sleep, etc.) */
.msg-quiet-tool {
  font-size: 11px; color: var(--text-muted); padding: 2px 0;
  font-family: var(--mono); opacity: 0.7;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Shell command result (like Claude Code) */
.msg-shell {
  background: var(--code-bg); border-radius: var(--radius);
  border-left: 3px solid var(--vscode-terminal-ansiGreen, #89d185);
  overflow: hidden;
}
.msg-shell.shell-error {
  border-left-color: var(--vscode-terminal-ansiRed, #f48771);
}
.msg-shell-cmd {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px; cursor: pointer; user-select: none;
  font-family: var(--mono); font-size: 12px; font-weight: 600;
  color: var(--vscode-terminal-ansiGreen, #89d185);
}
.msg-shell.shell-error .msg-shell-cmd {
  color: var(--vscode-terminal-ansiRed, #f48771);
}
.msg-shell-cmd .shell-chevron {
  transition: transform 0.15s; font-size: 10px;
}
.msg-shell-cmd .shell-chevron.open { transform: rotate(90deg); }
.msg-shell-output {
  display: none; padding: 4px 10px 8px; font-family: var(--mono);
  font-size: 11px; line-height: 1.4; max-height: 300px; overflow-y: auto;
  white-space: pre-wrap; word-wrap: break-word; color: var(--text);
  border-top: 1px solid var(--border);
}
.msg-shell-output.open { display: block; }

/* System message for slash commands */
.msg-system-cmd {
  font-size: 11px; color: var(--accent); padding: 4px 0;
  font-family: var(--mono); font-style: italic;
}

/* Inline tool confirmation */
.msg-confirm {
  background: var(--code-bg); border-radius: var(--radius);
  border-left: 3px solid var(--vscode-editorWarning-foreground, #cca700);
  padding: 8px 12px;
}
.msg-confirm-header {
  font-size: 12px; font-weight: 600; margin-bottom: 4px;
  color: var(--vscode-editorWarning-foreground, #cca700);
}
.msg-confirm-summary {
  font-family: var(--mono); font-size: 12px;
  padding: 4px 8px; margin-bottom: 8px;
  background: rgba(0,0,0,0.15); border-radius: 3px;
  white-space: pre-wrap; word-wrap: break-word;
}
.msg-confirm-actions {
  display: flex; gap: 8px;
}
.msg-confirm-actions button {
  padding: 4px 14px; font-size: 12px; border: none; border-radius: 3px;
  cursor: pointer; font-family: inherit; font-weight: 600;
}
.confirm-allow {
  background: var(--btn-bg); color: var(--btn-fg);
}
.confirm-allow:hover { background: var(--btn-hover); }
.confirm-deny {
  background: var(--btn2-bg); color: var(--btn2-fg);
}
.confirm-deny:hover { opacity: 0.8; }

/* Thinking */
.msg-thinking {
  border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden; margin-bottom: 4px;
}
.msg-thinking summary {
  cursor: pointer; padding: 5px 10px;
  font-size: 11px; color: var(--text-muted);
  background: rgba(128,128,128,0.06);
  user-select: none; list-style: none;
  display: flex; align-items: center; gap: 6px;
}
.msg-thinking summary::before { content: '\\25B6'; font-size: 8px; transition: transform 0.15s; }
.msg-thinking[open] summary::before { transform: rotate(90deg); }
.msg-thinking summary:hover { color: var(--text); background: rgba(128,128,128,0.1); }
.thinking-content {
  padding: 8px 10px; font-size: 12px;
  white-space: pre-wrap; word-wrap: break-word;
  max-height: 300px; overflow-y: auto;
  color: var(--text-muted); line-height: 1.5;
  border-top: 1px solid var(--border);
}
.thinking-streaming {
  display: flex; align-items: center; gap: 6px;
  font-size: 11px; color: var(--text-muted); padding: 4px 0;
}
.thinking-streaming .spinner {
  width: 10px; height: 10px; border: 1.5px solid var(--border);
  border-top-color: var(--text-muted); border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* System */
.msg-system {
  text-align: center; color: var(--text-muted);
  font-size: 11px; padding: 16px 0 8px;
}

/* Code blocks */
pre {
  background: var(--code-bg); padding: 10px 12px;
  border-radius: var(--radius); overflow-x: auto;
  font-family: var(--mono); font-size: 12px;
  line-height: 1.5; margin: 6px 0;
  border: 1px solid var(--border);
  position: relative;
}
pre .code-lang {
  position: absolute; top: 4px; right: 8px;
  font-size: 10px; color: var(--text-muted); opacity: 0.6;
  text-transform: uppercase; pointer-events: none;
}
pre .copy-btn {
  position: absolute; top: 4px; right: 4px;
  background: rgba(128,128,128,0.2); border: none; color: var(--text-muted);
  font-size: 10px; padding: 2px 6px; border-radius: 3px; cursor: pointer;
  opacity: 0; transition: opacity 0.15s;
}
pre:hover .copy-btn { opacity: 1; }
pre:hover .code-lang { opacity: 0; }
pre .copy-btn:hover { background: rgba(128,128,128,0.4); color: var(--text); }
code {
  font-family: var(--mono); font-size: 12px;
  background: var(--code-bg); padding: 1px 5px;
  border-radius: 3px;
}
pre code { background: none; padding: 0; border: none; }

/* Syntax highlighting */
.tok-kw { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
.tok-str { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
.tok-num { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
.tok-cm { color: var(--vscode-symbolIcon-commentForeground, #6a9955); font-style: italic; }
.tok-fn { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
.tok-typ { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
.tok-op { color: var(--vscode-symbolIcon-operatorForeground, #d4d4d4); }
.tok-pn { color: var(--vscode-symbolIcon-variableForeground, #9cdcfe); }

/* Markdown elements in assistant messages */
.msg-assistant h1, .msg-assistant h2, .msg-assistant h3 {
  font-weight: 600; margin: 8px 0 4px;
}
.msg-assistant h1 { font-size: 16px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
.msg-assistant h2 { font-size: 14px; }
.msg-assistant h3 { font-size: 13px; color: var(--text-muted); }
.msg-assistant ul, .msg-assistant ol {
  margin: 4px 0; padding-left: 20px;
}
.msg-assistant li { margin: 2px 0; line-height: 1.5; }
.msg-assistant a { color: var(--accent); text-decoration: none; }
.msg-assistant a:hover { text-decoration: underline; }
.msg-assistant blockquote {
  border-left: 3px solid var(--border); padding: 2px 10px;
  margin: 4px 0; color: var(--text-muted);
}
.msg-assistant hr {
  border: none; border-top: 1px solid var(--border); margin: 8px 0;
}
.msg-assistant table {
  border-collapse: collapse; margin: 6px 0; font-size: 12px;
}
.msg-assistant th, .msg-assistant td {
  border: 1px solid var(--border); padding: 4px 8px;
}
.msg-assistant th { background: var(--code-bg); font-weight: 600; }

/* Diff preview */
.diff-view {
  background: var(--code-bg); border-radius: var(--radius);
  border: 1px solid var(--border); overflow: hidden;
  font-family: var(--mono); font-size: 11px; line-height: 1.5;
  margin: 4px 0; max-height: 300px; overflow-y: auto;
}
.diff-header {
  padding: 4px 10px; font-size: 11px; font-weight: 600;
  color: var(--text-muted); background: rgba(128,128,128,0.08);
  border-bottom: 1px solid var(--border);
}
.diff-line { padding: 0 10px; white-space: pre-wrap; word-wrap: break-word; }
.diff-del { background: rgba(255,80,80,0.15); color: #f48771; }
.diff-add { background: rgba(80,200,80,0.15); color: #89d185; }
.diff-ctx { color: var(--text-muted); }

/* Image attachments */
.image-preview-area {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 6px 10px 0; max-height: 120px; overflow-y: auto;
}
.image-preview-area:empty { display: none; }
.img-thumb {
  position: relative; width: 60px; height: 60px;
  border-radius: 4px; overflow: hidden; border: 1px solid var(--border);
}
.img-thumb img { width: 100%; height: 100%; object-fit: cover; }
.img-thumb .img-remove {
  position: absolute; top: -2px; right: -2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--vscode-terminal-ansiRed, #f48771); color: #fff;
  border: none; font-size: 10px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  line-height: 1;
}
.msg-user-images {
  display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px;
}
.msg-user-images img {
  max-width: 200px; max-height: 150px; border-radius: 4px;
  border: 1px solid var(--border); cursor: pointer;
}

/* @-file mention autocomplete */
.mention-dropdown {
  position: absolute; bottom: 100%; left: 0; right: 0;
  background: var(--surface-raised); border: 1px solid var(--border);
  border-radius: var(--radius); max-height: 180px; overflow-y: auto;
  display: none; z-index: 10; margin-bottom: 2px;
  box-shadow: 0 -2px 8px rgba(0,0,0,0.2);
}
.mention-dropdown.open { display: block; }
.mention-item {
  padding: 5px 10px; font-size: 12px; cursor: pointer;
  font-family: var(--mono); color: var(--text);
  display: flex; align-items: center; gap: 6px;
}
.mention-item:hover, .mention-item.selected {
  background: rgba(128,128,128,0.15);
}
.mention-item .mention-icon { color: var(--accent); font-size: 11px; }
.cmd-name { color: var(--accent); font-weight: 600; }
.cmd-desc { color: var(--text-muted); margin-left: 6px; font-size: 11px; }

/* File chips (attached files) */
.file-chips {
  display: flex; flex-wrap: wrap; gap: 4px;
  padding: 4px 10px 0;
}
.file-chips:empty { display: none; }
.file-chip {
  display: inline-flex; align-items: center; gap: 4px;
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 3px; padding: 2px 6px; font-size: 11px;
  font-family: var(--mono); color: var(--accent);
}
.file-chip .chip-remove {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; font-size: 12px; padding: 0 2px; line-height: 1;
}
.file-chip .chip-remove:hover { color: var(--vscode-terminal-ansiRed, #f48771); }

/* ── Input area ── */
.input-area {
  flex-shrink: 0; padding: 8px 10px;
  border-top: 1px solid var(--border);
  background: var(--surface-raised);
}
.input-row { display: flex; gap: 6px; align-items: flex-end; }
.input-wrap {
  flex: 1; position: relative;
  border: 1px solid var(--input-border); border-radius: var(--radius);
  background: var(--input-bg);
  transition: border-color 0.15s;
}
.input-wrap:focus-within { border-color: var(--accent); }
.input-wrap textarea {
  width: 100%; min-height: 40px; max-height: 200px;
  padding: 8px 10px; resize: none; border: none;
  background: transparent; color: var(--input-fg);
  font-family: inherit; font-size: 13px; line-height: 1.4;
  outline: none;
}
.input-hint {
  font-size: 10px; color: var(--text-muted); padding: 0 10px 4px;
}
.send-btn {
  width: 34px; height: 34px; border-radius: var(--radius);
  background: var(--btn-bg); color: var(--btn-fg);
  border: none; cursor: pointer; display: flex;
  align-items: center; justify-content: center;
  flex-shrink: 0; transition: background 0.15s;
}
.send-btn:hover { background: var(--btn-hover); }
.send-btn:disabled { opacity: 0.4; cursor: default; }
.send-btn svg { width: 16px; height: 16px; }
.cancel-btn {
  width: 34px; height: 34px; border-radius: var(--radius);
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  color: var(--btn-fg); border: none; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.cancel-btn svg { width: 14px; height: 14px; }

/* ── Context bar ── */
.context-bar {
  padding: 2px 10px; display: none;
}
.context-bar.visible { display: block; }
.context-bar-track {
  height: 4px; background: var(--border); border-radius: 2px;
  overflow: hidden; position: relative;
}
.context-bar-fill {
  height: 100%; border-radius: 2px;
  background: var(--accent);
  transition: width 0.3s ease, background 0.3s ease;
  width: 0%;
}
.context-bar-fill.warn { background: var(--vscode-editorWarning-foreground, #cca700); }
.context-bar-fill.critical { background: var(--vscode-terminal-ansiRed, #f48771); }
.context-bar-label {
  font-size: 9px; color: var(--text-muted);
  text-align: right; margin-top: 1px;
}

/* ── Usage bar ── */
.usage-bar {
  font-size: 10px; color: var(--text-muted);
  text-align: right; padding: 2px 10px 4px;
}

/* ── Git status bar ── */
.git-bar {
  display: none; align-items: center; gap: 6px;
  padding: 4px 10px; font-size: 11px;
  border-top: 1px solid var(--border);
  background: var(--surface-raised);
  font-family: var(--mono);
  color: var(--text-muted);
}
.git-bar.visible { display: flex; }
.git-branch {
  display: flex; align-items: center; gap: 4px;
  font-weight: 600; color: var(--accent);
}
.git-branch svg { width: 12px; height: 12px; stroke: var(--accent); fill: none; }
.git-stats { display: flex; gap: 8px; }
.git-stat { display: flex; align-items: center; gap: 2px; }
.git-stat.staged { color: var(--vscode-terminal-ansiGreen, #89d185); }
.git-stat.modified { color: var(--vscode-editorWarning-foreground, #cca700); }
.git-stat.untracked { color: var(--text-muted); }
.git-bar-spacer { flex: 1; }
.git-refresh {
  background: none; border: none; color: var(--text-muted);
  cursor: pointer; padding: 2px; border-radius: 3px; font-size: 11px;
  display: flex; align-items: center;
}
.git-refresh:hover { color: var(--text); background: rgba(128,128,128,0.15); }

</style>
</head>
<body>
<div class="app">

  <!-- Top bar -->
  <div class="topbar">
    <div class="topbar-title">
      <svg viewBox="0 0 24 24" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M4 17l6-6-6-6"/><path d="M12 19h8"/><circle cx="20" cy="5" r="2"/>
      </svg>
      Claw Agent
    </div>
    <div class="topbar-spacer"></div>
    <button class="topbar-btn" id="export-btn" title="Export conversation">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </button>
    <button class="topbar-btn" id="import-btn" title="Import conversation">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
    </button>
    <button class="topbar-btn" id="thinking-btn" title="Toggle extended thinking">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></svg>
      Think
    </button>
    <button class="topbar-btn" id="auto-approve-btn" title="Toggle auto-approve tools (YOLO mode)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      Ask
    </button>
    <button class="topbar-btn" id="settings-btn" title="Settings">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
  </div>

  <!-- Settings drawer -->
  <div class="settings-drawer" id="settings-drawer">
    <div class="settings-row">
      <label>Provider</label>
      <select id="provider-select">
        <option value="Anthropic">Anthropic</option>
        <option value="OpenAI">OpenAI</option>
        <option value="OpenRouter">OpenRouter</option>
        <option value="Local">Local (Ollama, LM Studio, etc.)</option>
      </select>
    </div>
    <div class="settings-row">
      <label>API Key</label>
      <input type="password" id="api-key" placeholder="sk-..." />
    </div>
    <div class="settings-row">
      <label>Base URL</label>
      <input type="text" id="base-url" placeholder="(optional)" />
    </div>
    <div class="settings-row">
      <label>Model</label>
      <select id="model-select"><option value="">(default)</option></select>
    </div>
    <div class="settings-row" id="custom-model-row" style="display:none;">
      <label></label>
      <input type="text" id="custom-model" placeholder="model-id" />
    </div>
    <div class="settings-actions">
      <button class="btn-save" id="save-settings-btn">Save</button>
    </div>
  </div>

  <!-- Messages -->
  <div class="messages" id="chat-messages">
    <div class="msg-system">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="margin-bottom:6px;">
        <path d="M4 17l6-6-6-6"/><path d="M12 19h8"/><circle cx="20" cy="5" r="2"/>
      </svg>
      <div style="margin-top:4px;">Claw Agent</div>
      <div style="margin-top:2px;font-size:10px;">${toolCount} tools ready</div>
    </div>
  </div>

  <!-- Context bar -->
  <div class="context-bar" id="context-bar">
    <div class="context-bar-track">
      <div class="context-bar-fill" id="context-bar-fill"></div>
    </div>
    <div class="context-bar-label" id="context-bar-label"></div>
  </div>

  <!-- Usage -->
  <div class="usage-bar" id="usage-bar"></div>

  <!-- Git status bar -->
  <div class="git-bar" id="git-bar">
    <div class="git-branch" id="git-branch">
      <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
      <span id="git-branch-name"></span>
    </div>
    <div class="git-stats" id="git-stats"></div>
    <div class="git-bar-spacer"></div>
    <button class="git-refresh" id="git-refresh" title="Refresh git status">&#x21bb;</button>
  </div>

  <!-- Input -->
  <div class="input-area">
    <div class="image-preview-area" id="image-previews"></div>
    <div class="file-chips" id="file-chips"></div>
    <div class="input-row">
      <div class="input-wrap">
        <div class="mention-dropdown" id="command-dropdown"></div>
        <div class="mention-dropdown" id="mention-dropdown"></div>
        <textarea id="prompt-input" placeholder="Ask Claw Agent... (paste images, @file to attach)" rows="1"></textarea>
        <div class="input-hint">Enter to send, Shift+Enter for new line, @ to attach files</div>
      </div>
      <button class="send-btn" id="send-btn" title="Send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </button>
      <button class="cancel-btn" id="cancel-btn" style="display:none;" title="Cancel">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2"/></svg>
      </button>
    </div>
  </div>
</div>

<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
exports.SidebarProvider = SidebarProvider;
function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
//# sourceMappingURL=SidebarProvider.js.map