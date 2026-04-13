/**
 * Checkpoint system — tracks file edits made by the agent so users can rewind.
 *
 * Each user prompt creates a checkpoint. Before any file-modifying tool executes,
 * the original file content is snapshotted to `.claw-checkpoints/<id>/`. On rewind,
 * snapshots are copied back to their original locations.
 *
 * No git dependency — pure file I/O.
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileSnapshot {
    /** Path relative to workspace root. */
    relativePath: string;
    /** Full path on disk. */
    absolutePath: string;
    /** False if the file didn't exist before the agent created it. */
    existed: boolean;
    /** Path to the saved copy inside .claw-checkpoints/. */
    snapshotFile: string;
}

export interface Checkpoint {
    /** Matches the userMsgIndex — ordinal count of user messages. */
    id: number;
    /** Index in _history[] where the user message was pushed. */
    historyIndex: number;
    timestamp: number;
    snapshots: FileSnapshot[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHECKPOINT_DIR_NAME = '.claw-checkpoints';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------------------------------------------------------------------------
// CheckpointManager
// ---------------------------------------------------------------------------

export class CheckpointManager {
    private _checkpoints: Map<number, Checkpoint> = new Map();
    private _activeCheckpoint: Checkpoint | null = null;
    private _checkpointDir: string;
    /** Tracks files already snapshotted in the active checkpoint (dedup). */
    private _activeSnapshotPaths: Set<string> = new Set();

    constructor(private _workspaceRoot: string) {
        this._checkpointDir = path.join(_workspaceRoot, CHECKPOINT_DIR_NAME);
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /**
     * Start a new checkpoint before a user prompt is processed.
     * Call this BEFORE pushing the user message to history.
     */
    createCheckpoint(id: number, historyIndex: number): Checkpoint {
        const cp: Checkpoint = {
            id,
            historyIndex,
            timestamp: Date.now(),
            snapshots: [],
        };
        this._checkpoints.set(id, cp);
        this._activeCheckpoint = cp;
        this._activeSnapshotPaths.clear();
        return cp;
    }

    /**
     * Snapshot a file BEFORE it gets modified by a tool.
     * Safe to call multiple times for the same file within one checkpoint — only
     * the first call (original state) is recorded.
     *
     * @param filePath Relative or absolute path to the file being edited.
     */
    snapshotFile(filePath: string): void {
        if (!this._activeCheckpoint) { return; }

        const abs = path.isAbsolute(filePath)
            ? path.normalize(filePath)
            : path.normalize(path.resolve(this._workspaceRoot, filePath));

        // Validate inside workspace
        const normalizedRoot = path.normalize(this._workspaceRoot) + path.sep;
        if (!abs.startsWith(normalizedRoot) && abs !== path.normalize(this._workspaceRoot)) {
            return; // outside workspace, skip
        }

        const rel = path.relative(this._workspaceRoot, abs);

        // Dedup: only snapshot the first time per file per checkpoint
        if (this._activeSnapshotPaths.has(rel)) { return; }
        this._activeSnapshotPaths.add(rel);

        const cpDir = path.join(this._checkpointDir, String(this._activeCheckpoint.id));
        const snapshotDest = path.join(cpDir, rel);
        const existed = fs.existsSync(abs);

        if (existed) {
            // Ensure destination directory exists
            fs.mkdirSync(path.dirname(snapshotDest), { recursive: true });
            fs.copyFileSync(abs, snapshotDest);
        }

        this._activeCheckpoint.snapshots.push({
            relativePath: rel,
            absolutePath: abs,
            existed,
            snapshotFile: snapshotDest,
        });

        // Ensure .claw-checkpoints has its own .gitignore
        this._ensureGitignore();
    }

    /**
     * Restore files to the state captured at checkpoint `id`.
     * Also cascades: restores files edited in ALL later checkpoints.
     */
    restoreCheckpoint(id: number): { restored: string[]; deleted: string[]; errors: string[] } {
        const restored: string[] = [];
        const deleted: string[] = [];
        const errors: string[] = [];

        // Collect all checkpoints from `id` onward (inclusive)
        const sortedIds = Array.from(this._checkpoints.keys()).sort((a, b) => a - b);
        const relevantIds = sortedIds.filter(cpId => cpId >= id);

        // Process in reverse order (latest first) to handle overlapping file edits correctly.
        // If file X was edited in checkpoint 2 and again in checkpoint 4, restoring checkpoint 2
        // means we want checkpoint 2's snapshot of X (the original before prompt 2), not
        // checkpoint 4's (which captured the state AFTER prompt 2 already changed it).
        // By processing 4 first then 2, checkpoint 2's snapshot overwrites 4's.
        for (const cpId of relevantIds.reverse()) {
            const cp = this._checkpoints.get(cpId);
            if (!cp) { continue; }

            for (const snap of cp.snapshots) {
                try {
                    if (snap.existed) {
                        // Restore original content
                        if (fs.existsSync(snap.snapshotFile)) {
                            fs.mkdirSync(path.dirname(snap.absolutePath), { recursive: true });
                            fs.copyFileSync(snap.snapshotFile, snap.absolutePath);
                            restored.push(snap.relativePath);
                        }
                    } else {
                        // File was created by agent — delete it
                        if (fs.existsSync(snap.absolutePath)) {
                            fs.unlinkSync(snap.absolutePath);
                            deleted.push(snap.relativePath);
                            // Clean up empty parent directories
                            this._cleanEmptyDirs(path.dirname(snap.absolutePath));
                        }
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`${snap.relativePath}: ${msg}`);
                }
            }
        }

        return { restored, deleted, errors };
    }

    /** Get a checkpoint by ID. */
    get(id: number): Checkpoint | undefined {
        return this._checkpoints.get(id);
    }

    /** Delete checkpoints after a given ID and clean up their snapshot dirs. */
    pruneAfter(id: number): void {
        for (const [cpId] of this._checkpoints) {
            if (cpId > id) {
                this._removeCheckpointDir(cpId);
                this._checkpoints.delete(cpId);
            }
        }
        // Also remove the checkpoint at `id` since we've restored to before it
        this._removeCheckpointDir(id);
        this._checkpoints.delete(id);
    }

    /** Clean up checkpoint directories older than 30 days. */
    cleanupOld(): void {
        try {
            if (!fs.existsSync(this._checkpointDir)) { return; }
            const entries = fs.readdirSync(this._checkpointDir);
            const now = Date.now();
            for (const entry of entries) {
                if (entry === '.gitignore') { continue; }
                const fullPath = path.join(this._checkpointDir, entry);
                try {
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory() && (now - stat.mtimeMs) > MAX_AGE_MS) {
                        fs.rmSync(fullPath, { recursive: true, force: true });
                    }
                } catch { /* skip entries we can't stat */ }
            }
        } catch { /* checkpoint dir doesn't exist or can't be read */ }
    }

    /** Reset all in-memory state and optionally remove checkpoint dir. */
    clear(): void {
        this._checkpoints.clear();
        this._activeCheckpoint = null;
        this._activeSnapshotPaths.clear();
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    private _removeCheckpointDir(id: number): void {
        try {
            const dir = path.join(this._checkpointDir, String(id));
            if (fs.existsSync(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        } catch { /* best effort */ }
    }

    /** Remove empty ancestor directories up to (but not including) workspace root. */
    private _cleanEmptyDirs(dir: string): void {
        const normalizedRoot = path.normalize(this._workspaceRoot);
        let current = path.normalize(dir);
        while (current !== normalizedRoot && current.startsWith(normalizedRoot)) {
            try {
                const entries = fs.readdirSync(current);
                if (entries.length === 0) {
                    fs.rmdirSync(current);
                    current = path.dirname(current);
                } else {
                    break;
                }
            } catch { break; }
        }
    }

    /** Ensure .claw-checkpoints/.gitignore exists so snapshots aren't committed. */
    private _ensureGitignore(): void {
        try {
            const gitignorePath = path.join(this._checkpointDir, '.gitignore');
            if (!fs.existsSync(gitignorePath)) {
                fs.mkdirSync(this._checkpointDir, { recursive: true });
                fs.writeFileSync(gitignorePath, '# Auto-generated by Claw Agent — checkpoint file snapshots\n*\n');
            }
        } catch { /* best effort */ }
    }
}
