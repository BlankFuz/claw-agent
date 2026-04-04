"use strict";
/**
 * ToolSpec Schema Pattern
 *
 * Every tool in Claw Agent conforms to this schema. It is the equivalent
 * of the harness's ToolPool + ToolPermissionContext + tool_snapshot.json
 * patterns, unified into a single TypeScript-first type system.
 *
 * Each ToolSpec declares:
 *   - name, category, description  (metadata)
 *   - parameters                    (JSON Schema for LLM function calling)
 *   - requiresConfirmation          (modal confirmation before execution)
 *   - permissionLevel               (used by ToolPermissionContext gating)
 *   - execute()                     (the runtime implementation)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineTool = defineTool;
// ---------------------------------------------------------------------------
// Helper: build a ToolSpec with defaults
// ---------------------------------------------------------------------------
function defineTool(spec) {
    return spec;
}
//# sourceMappingURL=types.js.map