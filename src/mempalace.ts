/**
 * MemPalace Integration (Optional)
 *
 * Detects if MemPalace is installed locally and provides:
 *   - Auto-save conversations on compact
 *   - Auto-recall relevant context on new sessions
 *   - Manual /memory search
 *   - MemPalaceSearch tool for the LLM agent
 *   - /memory-setup for one-click install
 *
 * If MemPalace is not installed, all methods are safe no-ops.
 */

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';

const execAsync = promisify(cp.exec);
const execFileAsync = promisify(cp.execFile);

/** Common exec options — forces UTF-8 output to avoid Windows cp1252 encoding crashes. */
const EXEC_ENV = { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };

/** Safe exec helper — uses execFile (no shell) to prevent command injection. */
async function safeExec(
    cmd: string,
    args: string[],
    options: { timeout?: number; maxBuffer?: number; env?: Record<string, string | undefined> } = {},
): Promise<{ stdout: string; stderr: string }> {
    const opts = {
        ...options,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...options.env },
    };
    return execFileAsync(cmd, args, opts);
}

export interface MemPalaceSearchResult {
    text: string;
    wing?: string;
    room?: string;
    date?: string;
    score?: number;
}

export class MemPalace {
    private _available: boolean | null = null;   // null = not checked yet
    private _pythonCmd: string = 'python';
    private _palacePath: string;

    constructor() {
        this._palacePath = path.join(os.homedir(), '.mempalace');
    }

    /** Check if mempalace is installed. Caches the result. */
    async isAvailable(): Promise<boolean> {
        if (this._available !== null) { return this._available; }

        // Try python, python3 — use a simple import check instead of `status`
        // because `status` may write warnings to stderr and throw
        for (const cmd of ['python', 'python3']) {
            try {
                const { stdout } = await safeExec(
                    cmd, ['-c', 'import mempalace; print("mempalace_ok")'],
                    { timeout: 10000, maxBuffer: 512 * 1024 },
                );
                if (stdout.includes('mempalace_ok')) {
                    this._pythonCmd = cmd;
                    this._available = true;
                    return true;
                }
            } catch {
                // Not available with this command
            }
        }

        this._available = false;
        return false;
    }

    /** Reset the cached availability check (e.g., after /memory-setup). */
    resetCache(): void {
        this._available = null;
    }

    /** Get palace status summary. */
    async getStatus(): Promise<string> {
        if (!await this.isAvailable()) { return 'MemPalace is not installed. Run `/memory-setup` to install.'; }

        try {
            const { stdout } = await safeExec(
                this._pythonCmd, ['-m', 'mempalace', 'status'],
                { timeout: 15000, maxBuffer: 512 * 1024 },
            );
            return stdout.trim() || 'MemPalace is installed but returned no status.';
        } catch (err: unknown) {
            const execErr = err as { stdout?: string; stderr?: string };
            if (execErr.stdout?.trim()) { return execErr.stdout.trim(); }
            return `Error getting status: ${err instanceof Error ? err.message : String(err)}`;
        }
    }

    /**
     * Save a conversation to MemPalace.
     * Writes conversation to a temp file, then mines it.
     */
    async saveConversation(
        messages: Array<{ role: string; content: string }>,
        wingName?: string,
    ): Promise<string> {
        if (!await this.isAvailable()) { return ''; }
        if (messages.length === 0) { return 'No messages to save.'; }

        // Convert messages to plain text conversation format that mempalace understands
        // Uses ">" marker format for human messages
        const lines: string[] = [];
        for (const msg of messages) {
            if (!msg.content || msg.content.length === 0) { continue; }
            if (msg.role === 'user') {
                lines.push(`> ${msg.content}`);
            } else if (msg.role === 'assistant') {
                lines.push(msg.content);
            }
            lines.push('');
        }

        if (lines.length === 0) { return 'No content to save.'; }

        // Write to temp directory (mempalace mine expects a directory, not a file)
        const tmpDir = path.join(os.tmpdir(), `claw-mempalace-${Date.now()}`);
        const tmpFile = path.join(tmpDir, 'conversation.txt');
        try {
            fs.mkdirSync(tmpDir, { recursive: true });
            fs.writeFileSync(tmpFile, lines.join('\n'), 'utf-8');

            // Mine the conversation directory
            const mineArgs = ['-m', 'mempalace', 'mine', tmpDir, '--mode', 'convos'];
            if (wingName) {
                mineArgs.push('--wing', wingName.replace(/[^a-zA-Z0-9_-]/g, '_'));
            }

            const { stdout, stderr } = await safeExec(
                this._pythonCmd, mineArgs,
                { timeout: 30000, maxBuffer: 1024 * 1024 },
            );

            const output = stdout.trim();
            if (stderr.trim()) {
                return output ? `${output}\n${stderr.trim()}` : stderr.trim();
            }
            return output || 'Conversation saved to MemPalace.';
        } catch (err: unknown) {
            return `Failed to save: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
        }
    }

    /**
     * Search MemPalace for relevant memories.
     * Returns formatted results.
     */
    async search(query: string, wing?: string, maxResults: number = 5): Promise<MemPalaceSearchResult[]> {
        if (!await this.isAvailable()) { return []; }

        try {
            const searchArgs = ['-m', 'mempalace', 'search', query, '--results', String(maxResults)];
            if (wing) {
                searchArgs.push('--wing', wing.replace(/[^a-zA-Z0-9_-]/g, '_'));
            }

            const { stdout } = await safeExec(
                this._pythonCmd, searchArgs,
                { timeout: 15000, maxBuffer: 1024 * 1024 },
            );

            // mempalace search outputs plain text — return as a single result
            if (stdout.trim()) {
                return [{ text: stdout.trim() }];
            }
            return [];
        } catch (err: unknown) {
            // execAsync includes stdout/stderr on the error object
            const execErr = err as { stdout?: string; stderr?: string };
            const detail = execErr.stdout?.trim() || execErr.stderr?.trim() || (err instanceof Error ? err.message : String(err));
            // Friendly message when no data has been mined yet
            if (detail.includes('No palace found')) {
                return [{ text: 'No memories yet. MemPalace will start saving after your first conversation compact.' }];
            }
            return [{ text: `Search error: ${detail}` }];
        }
    }

    /**
     * Format search results for display or injection into conversation.
     */
    formatResults(results: MemPalaceSearchResult[]): string {
        if (results.length === 0) { return 'No relevant memories found.'; }

        const parts: string[] = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            let header = `**Memory ${i + 1}**`;
            if (r.wing) { header += ` (wing: ${r.wing}`; }
            if (r.room) { header += r.wing ? `, room: ${r.room})` : ` (room: ${r.room})`; }
            else if (r.wing) { header += ')'; }
            if (r.date) { header += ` — ${r.date}`; }
            parts.push(`${header}\n${r.text}`);
        }
        return parts.join('\n\n---\n\n');
    }

    /**
     * Extract structured facts from a conversation and save to MemPalace.
     *
     * Unlike saveConversation() which dumps raw text, this extracts:
     *   - Key files modified or discussed
     *   - Decisions made and their rationale
     *   - Errors encountered and fixes applied
     *   - User preferences or instructions
     *
     * Uses keyword-based extraction (no LLM call) for speed.
     */
    async extractAndSave(
        messages: Array<{ role: string; content: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> }>,
        workspaceName?: string,
    ): Promise<string> {
        if (!await this.isAvailable()) { return ''; }
        if (messages.length === 0) { return 'No messages to extract from.'; }

        const facts: string[] = [];
        const filesModified = new Set<string>();
        const toolsUsed = new Set<string>();
        const errors: string[] = [];
        const decisions: string[] = [];
        const userInstructions: string[] = [];

        for (const msg of messages) {
            const content = msg.content || '';

            // Extract tool usage
            if (msg.toolCalls) {
                for (const tc of msg.toolCalls) {
                    toolsUsed.add(tc.name);
                    // Track file paths from file-modifying tools
                    const filePath = tc.arguments?.file_path || tc.arguments?.path || tc.arguments?.filePath;
                    if (filePath && typeof filePath === 'string' && (tc.name === 'edit_file' || tc.name === 'write_file')) {
                        filesModified.add(filePath);
                    }
                }
            }

            // Extract file paths mentioned in content
            const fileMatches = content.match(/(?:[\w./\\-]+\.(?:ts|js|py|rs|go|java|tsx|jsx|css|html|json|md|yaml|yml|toml))/g);
            if (fileMatches) {
                for (const f of fileMatches.slice(0, 20)) { filesModified.add(f); }
            }

            // Extract errors from assistant messages
            if (msg.role === 'assistant' && /error|exception|failed|bug|fix/i.test(content)) {
                const errorLine = content.split('\n').find(l => /error|exception|failed/i.test(l));
                if (errorLine && errorLine.length < 200) {
                    errors.push(errorLine.trim());
                }
            }

            // Extract user preferences/decisions
            if (msg.role === 'user') {
                if (/prefer|always|never|don't|instead|use.*instead/i.test(content) && content.length < 300) {
                    userInstructions.push(content.trim());
                }
                if (/decided|decision|let's go with|approach/i.test(content) && content.length < 300) {
                    decisions.push(content.trim());
                }
            }
        }

        // Build structured output
        const date = new Date().toISOString().split('T')[0];
        facts.push(`## Session Facts (${date})`);
        if (workspaceName) { facts.push(`Workspace: ${workspaceName}`); }

        if (filesModified.size > 0) {
            const files = Array.from(filesModified).slice(0, 15);
            facts.push(`\nFiles involved: ${files.join(', ')}`);
        }
        if (toolsUsed.size > 0) {
            facts.push(`Tools used: ${Array.from(toolsUsed).join(', ')}`);
        }
        if (errors.length > 0) {
            facts.push(`\nErrors encountered:`);
            for (const e of errors.slice(0, 5)) { facts.push(`- ${e}`); }
        }
        if (decisions.length > 0) {
            facts.push(`\nDecisions:`);
            for (const d of decisions.slice(0, 5)) { facts.push(`- ${d}`); }
        }
        if (userInstructions.length > 0) {
            facts.push(`\nUser preferences:`);
            for (const u of userInstructions.slice(0, 5)) { facts.push(`- ${u}`); }
        }

        // Also do the raw save for full context
        const rawResult = await this.saveConversation(messages, workspaceName);

        // Save structured facts as a separate document
        if (facts.length > 2) {
            const tmpDir = path.join(os.tmpdir(), `claw-mempalace-facts-${Date.now()}`);
            const tmpFile = path.join(tmpDir, 'session-facts.txt');
            try {
                fs.mkdirSync(tmpDir, { recursive: true });
                fs.writeFileSync(tmpFile, facts.join('\n'), 'utf-8');

                const mineArgs = ['-m', 'mempalace', 'mine', tmpDir, '--mode', 'notes'];
                if (workspaceName) {
                    mineArgs.push('--wing', workspaceName.replace(/[^a-zA-Z0-9_-]/g, '_'));
                }
                await safeExec(this._pythonCmd, mineArgs, { timeout: 30000, maxBuffer: 1024 * 1024 });
            } catch {
                // Non-critical — raw save already succeeded
            } finally {
                try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
                try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
            }
        }

        return rawResult;
    }

    /**
     * Install mempalace via pip.
     * Returns progress messages via callback.
     */
    async install(onProgress?: (msg: string) => void): Promise<boolean> {
        const pythonCmds = ['python', 'python3'];
        let usableCmd: string | null = null;

        // Find a working python
        for (const cmd of pythonCmds) {
            try {
                await safeExec(cmd, ['--version'], { timeout: 5000 });
                usableCmd = cmd;
                break;
            } catch { /* try next */ }
        }

        if (!usableCmd) {
            onProgress?.('Python is not installed. Please install Python 3.9+ first.');
            return false;
        }

        onProgress?.(`Found ${usableCmd}. Installing mempalace...`);

        // pip often writes warnings to stderr (PATH warnings, deprecations) which
        // causes execAsync to throw even on a successful install. Run pip and
        // check success by verifying the package is importable afterwards.
        try {
            await safeExec(usableCmd, ['-m', 'pip', 'install', 'mempalace'], {
                timeout: 120000,
                maxBuffer: 4 * 1024 * 1024,
            });
        } catch {
            // May throw due to stderr warnings — check if it actually installed below
        }

        // Verify the package is importable regardless of pip's exit/stderr
        try {
            await safeExec(usableCmd, ['-c', 'import mempalace; print("ok")'], { timeout: 10000 });
            onProgress?.('mempalace package installed.');
        } catch {
            onProgress?.('pip install failed. Try running manually: `pip install mempalace`');
            return false;
        }

        // Initialize the config directory (~/.mempalace/config.json) without running
        // the full `mempalace init` which scans files, detects entities/rooms, and
        // requires interactive prompts.
        onProgress?.('Initializing MemPalace config...');
        try {
            await safeExec(
                usableCmd,
                ['-c', 'from mempalace.config import MempalaceConfig; MempalaceConfig().init(); print("ok")'],
                { timeout: 10000 },
            );
            onProgress?.('MemPalace config initialized.');
        } catch {
            // May already exist — that's fine
            onProgress?.('MemPalace config initialization complete (may already exist).');
        }

        // Reset cache and re-check
        this.resetCache();
        this._pythonCmd = usableCmd;
        const available = await this.isAvailable();
        if (available) {
            onProgress?.('MemPalace is ready! Your conversations will now be remembered across sessions.');
        } else {
            onProgress?.('Installation completed but MemPalace could not be verified. Try restarting VS Code.');
        }
        return available;
    }
}
