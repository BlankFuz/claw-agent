/**
 * Git Worktree Isolation Tools
 *   #30 EnterWorktree — Create a temporary git worktree for isolated changes
 *   #31 ExitWorktree  — Clean up and optionally merge worktree changes
 *
 * Ported from claw-code-main harness: EnterWorktreeTool / ExitWorktreeTool
 *
 * Worktrees let the agent experiment in an isolated copy of the repo.
 * Changes can be committed in the worktree branch and merged back,
 * or discarded entirely — zero risk to the main working tree.
 */

import * as cp from 'child_process';
import { promisify } from 'util';
import { defineTool, ToolSpec } from './types';

const execAsync = promisify(cp.exec);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gitExec(cmd: string, cwd: string): Promise<string> {
    const { stdout } = await execAsync(`git ${cmd}`, { cwd, timeout: 15000 });
    return stdout.trim();
}

// ---------------------------------------------------------------------------
// #30 — EnterWorktree
// ---------------------------------------------------------------------------

export const enterWorktreeTool: ToolSpec = defineTool({
    name: 'EnterWorktree',
    category: 'shell',
    description:
        'Create a temporary git worktree for isolated experimentation. ' +
        'This gives you a separate copy of the repository on a new branch. ' +
        'Use this when you want to try risky changes without affecting the main working tree. ' +
        'The worktree path and branch name are stored so ExitWorktree can clean up later.',
    parameters: {
        type: 'object',
        properties: {
            branch: {
                type: 'string',
                description: 'Name for the worktree branch (default: auto-generated like "claw-worktree-abc123").',
            },
        },
        required: [],
    },
    requiresConfirmation: true,
    permissionLevel: 'execute',

    async execute(args, ctx) {
        const existing = ctx.turnState.get('worktree') as { path: string; branch: string } | undefined;
        if (existing) {
            return `Already in a worktree: ${existing.path} (branch: ${existing.branch}). Use ExitWorktree first.`;
        }

        const cwd = ctx.workspaceRoot;

        // Verify we're in a git repo
        try {
            await gitExec('rev-parse --is-inside-work-tree', cwd);
        } catch {
            return 'Not inside a git repository. Worktrees require git.';
        }

        const branch = (args.branch as string) || `claw-worktree-${Date.now().toString(36)}`;
        const path = await import('path');
        const os = await import('os');
        const worktreePath = path.join(os.tmpdir(), branch);

        try {
            await gitExec(`worktree add -b "${branch}" "${worktreePath}"`, cwd);
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return `Failed to create worktree: ${msg}`;
        }

        ctx.turnState.set('worktree', { path: worktreePath, branch });

        return [
            `Worktree created successfully.`,
            `  Branch: ${branch}`,
            `  Path:   ${worktreePath}`,
            ``,
            `You can now run commands in "${worktreePath}" to work in isolation.`,
            `Use ExitWorktree when done to clean up or merge changes back.`,
        ].join('\n');
    },
});

// ---------------------------------------------------------------------------
// #31 — ExitWorktree
// ---------------------------------------------------------------------------

export const exitWorktreeTool: ToolSpec = defineTool({
    name: 'ExitWorktree',
    category: 'shell',
    description:
        'Clean up the current git worktree. Options: "discard" removes the worktree and branch ' +
        '(no changes kept), "keep" removes the worktree but keeps the branch for manual merging, ' +
        'or "merge" attempts to merge the worktree branch into the current branch before cleanup.',
    parameters: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description: 'What to do with worktree changes.',
                enum: ['discard', 'keep', 'merge'],
                default: 'discard',
            },
        },
        required: [],
    },
    requiresConfirmation: true,
    permissionLevel: 'execute',

    async execute(args, ctx) {
        const worktree = ctx.turnState.get('worktree') as { path: string; branch: string } | undefined;
        if (!worktree) {
            return 'No active worktree. Use EnterWorktree first.';
        }

        const action = (args.action as string) || 'discard';
        const cwd = ctx.workspaceRoot;
        const results: string[] = [];

        try {
            if (action === 'merge') {
                // Get current branch
                const currentBranch = await gitExec('rev-parse --abbrev-ref HEAD', cwd);
                // Check if worktree branch has commits ahead
                try {
                    const log = await gitExec(
                        `log ${currentBranch}..${worktree.branch} --oneline`, cwd
                    );
                    if (log) {
                        await gitExec(`merge ${worktree.branch} --no-edit`, cwd);
                        results.push(`Merged ${worktree.branch} into ${currentBranch}.`);
                    } else {
                        results.push('No new commits to merge.');
                    }
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    results.push(`Merge failed: ${msg}. Branch "${worktree.branch}" kept for manual resolution.`);
                    // Don't delete branch on merge failure
                    await gitExec(`worktree remove "${worktree.path}" --force`, cwd).catch(() => {});
                    ctx.turnState.delete('worktree');
                    return results.join('\n');
                }
            }

            // Remove worktree
            await gitExec(`worktree remove "${worktree.path}" --force`, cwd).catch(() => {});
            results.push(`Worktree at ${worktree.path} removed.`);

            // Delete branch unless keeping
            if (action !== 'keep') {
                await gitExec(`branch -D "${worktree.branch}"`, cwd).catch(() => {});
                results.push(`Branch "${worktree.branch}" deleted.`);
            } else {
                results.push(`Branch "${worktree.branch}" kept for later use.`);
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            results.push(`Cleanup error: ${msg}`);
        }

        ctx.turnState.delete('worktree');
        return results.join('\n');
    },
});

export const worktreeTools: ToolSpec[] = [enterWorktreeTool, exitWorktreeTool];
