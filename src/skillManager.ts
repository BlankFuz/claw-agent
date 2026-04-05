/**
 * Skill Manager
 *
 * Discovers and loads skills from two locations:
 *   1. Built-in skills: bundled with the extension at <extensionPath>/skills/
 *   2. User skills: stored per-device at ~/.claw-agent/skills/
 *
 * Skills are invoked via /skill-<name> slash commands.
 * User skills can be created, edited, and deleted via /skill-create and /skill-delete.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface SkillInfo {
    /** Folder name (e.g. "frontend-design") */
    id: string;
    /** Human-readable name from frontmatter */
    name: string;
    /** Short description from frontmatter */
    description: string;
    /** Absolute path to the skill folder */
    folderPath: string;
    /** Absolute path to SKILL.md */
    skillMdPath: string;
    /** List of supplementary files (relative to skill folder) */
    supplementaryFiles: string[];
    /** Whether this is a built-in or user-created skill */
    source: 'built-in' | 'user';
}

/**
 * Parse YAML-like frontmatter from a SKILL.md file.
 * Expects `---` delimiters. Extracts name and description.
 */
function parseFrontmatter(content: string): { name: string; description: string; body: string } {
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) {
        return { name: '', description: '', body: content };
    }
    const frontmatter = match[1];
    const body = match[2];

    let name = '';
    let description = '';

    for (const line of frontmatter.split('\n')) {
        const nameMatch = line.match(/^name:\s*(.+)/);
        if (nameMatch) { name = nameMatch[1].trim().replace(/^["']|["']$/g, ''); }
        const descMatch = line.match(/^description:\s*(.+)/);
        if (descMatch) { description = descMatch[1].trim().replace(/^["']|["']$/g, ''); }
    }

    return { name, description, body };
}

export class SkillManager {
    private _skills: Map<string, SkillInfo> = new Map();
    private _builtInDir: string;
    private _userDir: string;

    constructor(extensionPath: string) {
        // Built-in skills: try bundled first, then sibling skills-main/
        const bundled = path.join(extensionPath, 'skills');
        const sibling = path.join(extensionPath, '..', 'skills-main', 'skills');

        if (fs.existsSync(bundled)) {
            this._builtInDir = bundled;
        } else if (fs.existsSync(sibling)) {
            this._builtInDir = sibling;
        } else {
            this._builtInDir = bundled;
        }

        // User skills: ~/.claw-agent/skills/
        this._userDir = path.join(os.homedir(), '.claw-agent', 'skills');
        this._ensureUserDir();

        this._discoverAll();
    }

    /** Ensure the user skills directory exists. */
    private _ensureUserDir(): void {
        try {
            fs.mkdirSync(this._userDir, { recursive: true });
        } catch { /* ignore */ }
    }

    /** Discover skills from both built-in and user directories. */
    private _discoverAll(): void {
        this._skills.clear();
        this._discoverFrom(this._builtInDir, 'built-in');
        // User skills override built-in if same name
        this._discoverFrom(this._userDir, 'user');
    }

    /** Scan a directory and register each skill found. */
    private _discoverFrom(dir: string, source: 'built-in' | 'user'): void {
        if (!fs.existsSync(dir)) { return; }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }

        for (const entry of entries) {
            if (!entry.isDirectory()) { continue; }

            const folderPath = path.join(dir, entry.name);
            const skillMdPath = path.join(folderPath, 'SKILL.md');

            if (!fs.existsSync(skillMdPath)) { continue; }

            try {
                const content = fs.readFileSync(skillMdPath, 'utf-8');
                const { name, description } = parseFrontmatter(content);
                const supplementary = this._listSupplementary(folderPath);

                this._skills.set(entry.name, {
                    id: entry.name,
                    name: name || entry.name,
                    description: description || `Skill: ${entry.name}`,
                    folderPath,
                    skillMdPath,
                    supplementaryFiles: supplementary,
                    source,
                });
            } catch {
                // Skip skills that fail to load
            }
        }
    }

    /** List supplementary files in a skill folder (markdown, text, scripts). */
    private _listSupplementary(folderPath: string): string[] {
        const results: string[] = [];
        const walk = (dir: string, prefix: string) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const e of entries) {
                    const relPath = prefix ? `${prefix}/${e.name}` : e.name;
                    if (e.isDirectory()) {
                        if (e.name === 'node_modules' || e.name.includes('font')) { continue; }
                        walk(path.join(dir, e.name), relPath);
                    } else if (e.name !== 'SKILL.md' && e.name !== 'LICENSE.txt') {
                        const ext = path.extname(e.name).toLowerCase();
                        if (['.md', '.txt', '.py', '.js', '.ts', '.sh', '.json', '.yaml', '.yml'].includes(ext)) {
                            results.push(relPath);
                        }
                    }
                }
            } catch { /* ignore */ }
        };
        walk(folderPath, '');
        return results;
    }

    // ── Accessors ──────────────────────────────────────────────────────────

    get skills(): SkillInfo[] {
        return Array.from(this._skills.values());
    }

    getSkill(id: string): SkillInfo | undefined {
        return this._skills.get(id);
    }

    hasSkill(id: string): boolean {
        return this._skills.has(id);
    }

    get size(): number {
        return this._skills.size;
    }

    get userSkillsDir(): string {
        return this._userDir;
    }

    // ── Loading ────────────────────────────────────────────────────────────

    loadSkillContent(id: string): string | null {
        const skill = this._skills.get(id);
        if (!skill) { return null; }
        try {
            const content = fs.readFileSync(skill.skillMdPath, 'utf-8');
            const { body } = parseFrontmatter(content);
            return body;
        } catch {
            return null;
        }
    }

    loadSupplementaryFile(skillId: string, relPath: string): string | null {
        const skill = this._skills.get(skillId);
        if (!skill) { return null; }
        const fullPath = path.join(skill.folderPath, relPath);
        if (!fullPath.startsWith(skill.folderPath)) { return null; }
        try {
            return fs.readFileSync(fullPath, 'utf-8');
        } catch {
            return null;
        }
    }

    // ── User skill CRUD ────────────────────────────────────────────────────

    /**
     * Create a new user skill with the given SKILL.md content.
     * Returns the path to the created SKILL.md.
     */
    createUserSkill(id: string, skillMdContent: string): string {
        const folderPath = path.join(this._userDir, id);
        fs.mkdirSync(folderPath, { recursive: true });
        const skillMdPath = path.join(folderPath, 'SKILL.md');
        fs.writeFileSync(skillMdPath, skillMdContent, 'utf-8');
        // Re-discover to pick up the new skill
        this._discoverAll();
        return skillMdPath;
    }

    /**
     * Delete a user skill. Returns true if deleted, false if not found or built-in.
     */
    deleteUserSkill(id: string): boolean {
        const skill = this._skills.get(id);
        if (!skill || skill.source !== 'user') { return false; }

        try {
            fs.rmSync(skill.folderPath, { recursive: true, force: true });
            this._discoverAll();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Update SKILL.md for an existing user skill.
     */
    updateUserSkill(id: string, skillMdContent: string): boolean {
        const skill = this._skills.get(id);
        if (!skill || skill.source !== 'user') { return false; }
        try {
            fs.writeFileSync(skill.skillMdPath, skillMdContent, 'utf-8');
            this._discoverAll();
            return true;
        } catch {
            return false;
        }
    }

    /** Refresh the skill registry (re-scan both directories). */
    refresh(): void {
        this._discoverAll();
    }

    // ── Prompt building ────────────────────────────────────────────────────

    buildSkillPrompt(id: string, userRequest: string): string | null {
        const skill = this._skills.get(id);
        if (!skill) { return null; }

        const content = this.loadSkillContent(id);
        if (!content) { return null; }

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '.';

        let prompt = `You are now using the **${skill.name}** skill. Follow the skill instructions below carefully to complete the user's request.

<skill_instructions>
${content.trim()}
</skill_instructions>

`;

        if (skill.supplementaryFiles.length > 0) {
            prompt += `**Supplementary skill files** available at \`${skill.folderPath}\`:\n`;
            for (const f of skill.supplementaryFiles) {
                prompt += `- \`${f}\`\n`;
            }
            prompt += `\nYou can read these files using read_file with the full path if you need additional reference material.\n\n`;
        }

        prompt += `**Workspace root**: \`${wsRoot}\`\n\n`;
        prompt += `**User's request:**\n\n${userRequest}`;

        return prompt;
    }

    /**
     * Scaffold a new user skill: creates the directory and a template SKILL.md.
     * Returns the absolute path to the created SKILL.md.
     */
    scaffoldSkill(skillName: string): string {
        const folderPath = path.join(this._userDir, skillName);
        fs.mkdirSync(folderPath, { recursive: true });

        const skillMdPath = path.join(folderPath, 'SKILL.md');
        const template = `---
name: ${skillName}
description: <one-line description — tells Claw Agent when to use this skill>
---

# ${skillName}

<!-- Write your skill instructions here. -->
<!-- Claw Agent will follow these instructions when you invoke /skill-${skillName}. -->

## When to use this skill

Describe the situations where this skill applies.

## Instructions

1. **Step one** — what to do first
2. **Step two** — what to do next
3. **Step three** — finish up

## Examples

\`\`\`
Input:  /skill-${skillName} <example request>
Output: <what Claw Agent should produce>
\`\`\`

## Tips

- Keep instructions specific and actionable
- Include quality criteria so Claw Agent knows what "good" looks like
- Mention common pitfalls to avoid
`;

        fs.writeFileSync(skillMdPath, template, 'utf-8');
        this._discoverAll();
        return skillMdPath;
    }

    /**
     * Watch the user skills directory for changes and auto-refresh.
     * Returns a Disposable to stop watching.
     */
    watchUserSkills(onRefresh?: () => void): vscode.Disposable {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.file(this._userDir), '**/SKILL.md'),
        );
        const refresh = () => {
            this._discoverAll();
            onRefresh?.();
        };
        watcher.onDidCreate(refresh);
        watcher.onDidChange(refresh);
        watcher.onDidDelete(refresh);
        return watcher;
    }

    // ── Slash commands for webview ─────────────────────────────────────────

    getSlashCommands(): Array<{ cmd: string; desc: string; args: string; source?: string }> {
        return this.skills.map(s => ({
            cmd: `/skill-${s.id}`,
            desc: s.description.substring(0, 80),
            args: '<request>',
            source: s.source,
        }));
    }
}