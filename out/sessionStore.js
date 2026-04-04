"use strict";
/**
 * Session persistence via VS Code global state.
 * Ported from claw-code-main harness: session_store.py
 *
 * Stores conversation history per workspace so different
 * folders/workspaces don't share chat history.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
const vscode = require("vscode");
const SESSION_PREFIX = 'claw-agent.session';
const SESSION_LIST_KEY = 'claw-agent.sessionList';
const MAX_STORED_MESSAGES = 50; // prevent unbounded storage growth
function workspaceKey() {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.toString();
    if (folder) {
        // Use a hash-like short key from the URI to keep storage keys clean
        let hash = 0;
        for (let i = 0; i < folder.length; i++) {
            hash = ((hash << 5) - hash + folder.charCodeAt(i)) | 0;
        }
        return Math.abs(hash).toString(36);
    }
    return 'no-workspace';
}
function workspaceName() {
    return vscode.workspace.workspaceFolders?.[0]?.name || 'No Workspace';
}
class SessionStore {
    globalState;
    constructor(globalState) {
        this.globalState = globalState;
    }
    /** Get the storage key for the current workspace. */
    _currentKey() {
        return `${SESSION_PREFIX}.${workspaceKey()}`;
    }
    /** Save current session for the current workspace. */
    save(sessionId, messages, usage) {
        const trimmed = messages.slice(-MAX_STORED_MESSAGES);
        const key = this._currentKey();
        const session = {
            sessionId,
            workspaceName: workspaceName(),
            messages: trimmed,
            usage,
            savedAt: Date.now(),
        };
        this.globalState.update(key, session);
        this._updateSessionList(key, workspaceName(), trimmed.length, trimmed);
    }
    /** Load the session for the current workspace, or null. */
    load() {
        const key = this._currentKey();
        const data = this.globalState.get(key);
        if (!data || !data.messages || !Array.isArray(data.messages)) {
            return null;
        }
        return data;
    }
    /** Clear the session for the current workspace. */
    clear() {
        const key = this._currentKey();
        this.globalState.update(key, undefined);
        this._removeFromSessionList(key);
    }
    /** List all saved sessions across workspaces. */
    listAll() {
        const list = this.globalState.get(SESSION_LIST_KEY) || [];
        return list.sort((a, b) => b.savedAt - a.savedAt);
    }
    /** Track session in the global list for the session switcher. */
    _updateSessionList(key, wsName, count, messages) {
        const list = this.globalState.get(SESSION_LIST_KEY) || [];
        // Find first user message for preview
        const firstUser = messages.find(m => m.role === 'user');
        const preview = firstUser
            ? firstUser.content.substring(0, 80)
            : '(empty)';
        const idx = list.findIndex(s => s.key === key);
        const entry = {
            key,
            workspaceName: wsName,
            messageCount: count,
            savedAt: Date.now(),
            preview,
        };
        if (idx >= 0) {
            list[idx] = entry;
        }
        else {
            list.push(entry);
        }
        // Keep max 20 session entries
        if (list.length > 20) {
            list.sort((a, b) => b.savedAt - a.savedAt);
            list.length = 20;
        }
        this.globalState.update(SESSION_LIST_KEY, list);
    }
    _removeFromSessionList(key) {
        const list = this.globalState.get(SESSION_LIST_KEY) || [];
        const filtered = list.filter(s => s.key !== key);
        this.globalState.update(SESSION_LIST_KEY, filtered);
    }
}
exports.SessionStore = SessionStore;
//# sourceMappingURL=sessionStore.js.map