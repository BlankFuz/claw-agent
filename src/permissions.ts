/**
 * Tool permission filtering.
 * Ported from claw-code-main harness: permissions.py / ToolPermissionContext
 *
 * Supports gating by:
 *   - Tool name (exact match)
 *   - Name prefix (e.g. "Web" blocks WebFetch + WebSearch)
 *   - Permission level (read, write, execute, network, agent)
 */

import { PermissionLevel } from './tools/types';

export interface PermissionDenial {
    toolName: string;
    reason: string;
}

export class ToolPermissionContext {
    private readonly denyNames: Set<string>;
    private readonly denyPrefixes: string[];
    private readonly denyLevels: Set<PermissionLevel>;

    constructor(
        denyNames: string[] = [],
        denyPrefixes: string[] = [],
        denyLevels: PermissionLevel[] = [],
    ) {
        this.denyNames = new Set(denyNames.map(n => n.toLowerCase()));
        this.denyPrefixes = denyPrefixes.map(p => p.toLowerCase());
        this.denyLevels = new Set(denyLevels);
    }

    /** Check if a tool is blocked by name or prefix. */
    blocks(toolName: string): boolean {
        const lowered = toolName.toLowerCase();
        if (this.denyNames.has(lowered)) { return true; }
        return this.denyPrefixes.some(prefix => lowered.startsWith(prefix));
    }

    /** Check if a permission level is blocked. */
    blocksLevel(level: PermissionLevel): boolean {
        return this.denyLevels.has(level);
    }

    /** Attempt to use a tool — returns a denial if blocked, or null if allowed. */
    check(toolName: string): PermissionDenial | null {
        if (this.blocks(toolName)) {
            return { toolName, reason: `Tool "${toolName}" is not permitted in this session.` };
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// Preset permission profiles
// ---------------------------------------------------------------------------

/** No restrictions — all tools allowed. */
export function permissionsFullAccess(): ToolPermissionContext {
    return new ToolPermissionContext();
}

/** Read-only — blocks write, execute, network, agent tools. */
export function permissionsReadOnly(): ToolPermissionContext {
    return new ToolPermissionContext([], [], ['write', 'execute', 'network', 'agent']);
}

/** Safe mode — blocks execute and network tools. */
export function permissionsSafeMode(): ToolPermissionContext {
    return new ToolPermissionContext([], [], ['execute', 'network']);
}

/** Custom — block specific tools by name. */
export function permissionsCustom(denyNames: string[], denyPrefixes: string[] = []): ToolPermissionContext {
    return new ToolPermissionContext(denyNames, denyPrefixes);
}
