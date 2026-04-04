"use strict";
/**
 * Tool permission filtering.
 * Ported from claw-code-main harness: permissions.py / ToolPermissionContext
 *
 * Supports gating by:
 *   - Tool name (exact match)
 *   - Name prefix (e.g. "Web" blocks WebFetch + WebSearch)
 *   - Permission level (read, write, execute, network, agent)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ToolPermissionContext = void 0;
exports.permissionsFullAccess = permissionsFullAccess;
exports.permissionsReadOnly = permissionsReadOnly;
exports.permissionsSafeMode = permissionsSafeMode;
exports.permissionsCustom = permissionsCustom;
class ToolPermissionContext {
    denyNames;
    denyPrefixes;
    denyLevels;
    constructor(denyNames = [], denyPrefixes = [], denyLevels = []) {
        this.denyNames = new Set(denyNames.map(n => n.toLowerCase()));
        this.denyPrefixes = denyPrefixes.map(p => p.toLowerCase());
        this.denyLevels = new Set(denyLevels);
    }
    /** Check if a tool is blocked by name or prefix. */
    blocks(toolName) {
        const lowered = toolName.toLowerCase();
        if (this.denyNames.has(lowered)) {
            return true;
        }
        return this.denyPrefixes.some(prefix => lowered.startsWith(prefix));
    }
    /** Check if a permission level is blocked. */
    blocksLevel(level) {
        return this.denyLevels.has(level);
    }
    /** Attempt to use a tool — returns a denial if blocked, or null if allowed. */
    check(toolName) {
        if (this.blocks(toolName)) {
            return { toolName, reason: `Tool "${toolName}" is not permitted in this session.` };
        }
        return null;
    }
}
exports.ToolPermissionContext = ToolPermissionContext;
// ---------------------------------------------------------------------------
// Preset permission profiles
// ---------------------------------------------------------------------------
/** No restrictions — all tools allowed. */
function permissionsFullAccess() {
    return new ToolPermissionContext();
}
/** Read-only — blocks write, execute, network, agent tools. */
function permissionsReadOnly() {
    return new ToolPermissionContext([], [], ['write', 'execute', 'network', 'agent']);
}
/** Safe mode — blocks execute and network tools. */
function permissionsSafeMode() {
    return new ToolPermissionContext([], [], ['execute', 'network']);
}
/** Custom — block specific tools by name. */
function permissionsCustom(denyNames, denyPrefixes = []) {
    return new ToolPermissionContext(denyNames, denyPrefixes);
}
//# sourceMappingURL=permissions.js.map