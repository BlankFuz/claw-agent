/**
 * Session persistence via VS Code global state.
 * Ported from claw-code-main harness: session_store.py
 *
 * Stores conversation history per workspace so different
 * folders/workspaces don't share chat history.
 */

import * as vscode from 'vscode';
import { ChatMessage } from './llmProvider';
import { UsageSummary } from './costTracker';

const SESSION_PREFIX = 'claw-agent.session';
const SESSION_LIST_KEY = 'claw-agent.sessionList';
const MAX_STORED_MESSAGES = 50; // prevent unbounded storage growth

export interface StoredSession {
    sessionId: string;
    workspaceName: string;
    messages: ChatMessage[];
    usage: UsageSummary;
    savedAt: number;
}

/** Summary for the session switcher UI. */
export interface SessionSummary {
    key: string;
    workspaceName: string;
    messageCount: number;
    savedAt: number;
    preview: string;
}

function workspaceKey(): string {
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

function workspaceName(): string {
    return vscode.workspace.workspaceFolders?.[0]?.name || 'No Workspace';
}

export class SessionStore {
    constructor(private readonly globalState: vscode.Memento) {}

    /** Get the storage key for the current workspace. */
    private _currentKey(): string {
        return `${SESSION_PREFIX}.${workspaceKey()}`;
    }

    /** Save current session for the current workspace. */
    save(sessionId: string, messages: ChatMessage[], usage: UsageSummary): void {
        let trimmed: ChatMessage[];
        if (messages.length > MAX_STORED_MESSAGES) {
            // Always preserve the first 2 messages — they contain the compact
            // summary context (user: "[Previous conversation...]", assistant: <summary>).
            // Dropping them causes the LLM to lose all prior context on reload.
            const head = messages.slice(0, 2);
            const tail = messages.slice(-(MAX_STORED_MESSAGES - 2));
            trimmed = [...head, ...tail];
        } else {
            trimmed = messages;
        }
        const key = this._currentKey();
        const session: StoredSession = {
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
    load(): StoredSession | null {
        const key = this._currentKey();
        const data = this.globalState.get<StoredSession>(key);
        if (!data || !data.messages || !Array.isArray(data.messages)) {
            return null;
        }
        return data;
    }

    /** Clear the session for the current workspace. */
    clear(): void {
        const key = this._currentKey();
        this.globalState.update(key, undefined);
        this._removeFromSessionList(key);
    }

    /**
     * Fork the current session at a specific message index.
     * Creates a new session containing messages[0..atMessageIndex] and saves it
     * under a unique key. Returns the fork key, or null if nothing to fork.
     */
    fork(atMessageIndex: number, messages: ChatMessage[], usage: UsageSummary): string | null {
        if (atMessageIndex <= 0 || atMessageIndex > messages.length) { return null; }

        const forkedMessages = messages.slice(0, atMessageIndex);
        if (forkedMessages.length === 0) { return null; }

        // Generate a unique fork key based on timestamp
        const forkId = `${SESSION_PREFIX}.fork-${Date.now().toString(36)}`;
        const session: StoredSession = {
            sessionId: `fork-${Date.now()}`,
            workspaceName: workspaceName(),
            messages: forkedMessages.length > MAX_STORED_MESSAGES
                ? [...forkedMessages.slice(0, 2), ...forkedMessages.slice(-(MAX_STORED_MESSAGES - 2))]
                : forkedMessages,
            usage,
            savedAt: Date.now(),
        };
        this.globalState.update(forkId, session);
        this._updateSessionList(forkId, `${workspaceName()} (fork)`, session.messages.length, session.messages);
        return forkId;
    }

    /**
     * Load a specific session by key (used for loading forks).
     */
    loadByKey(key: string): StoredSession | null {
        const data = this.globalState.get<StoredSession>(key);
        if (!data || !data.messages || !Array.isArray(data.messages)) {
            return null;
        }
        return data;
    }

    /** List all saved sessions across workspaces. */
    listAll(): SessionSummary[] {
        const list = this.globalState.get<SessionSummary[]>(SESSION_LIST_KEY) || [];
        return list.sort((a, b) => b.savedAt - a.savedAt);
    }

    /** Track session in the global list for the session switcher. */
    private _updateSessionList(
        key: string, wsName: string, count: number, messages: ChatMessage[],
    ): void {
        const list = this.globalState.get<SessionSummary[]>(SESSION_LIST_KEY) || [];
        // Find first user message for preview
        const firstUser = messages.find(m => m.role === 'user');
        const preview = firstUser
            ? firstUser.content.substring(0, 80)
            : '(empty)';

        const idx = list.findIndex(s => s.key === key);
        const entry: SessionSummary = {
            key,
            workspaceName: wsName,
            messageCount: count,
            savedAt: Date.now(),
            preview,
        };
        if (idx >= 0) {
            list[idx] = entry;
        } else {
            list.push(entry);
        }
        // Keep max 20 session entries
        if (list.length > 20) {
            list.sort((a, b) => b.savedAt - a.savedAt);
            list.length = 20;
        }
        this.globalState.update(SESSION_LIST_KEY, list);
    }

    private _removeFromSessionList(key: string): void {
        const list = this.globalState.get<SessionSummary[]>(SESSION_LIST_KEY) || [];
        const filtered = list.filter(s => s.key !== key);
        this.globalState.update(SESSION_LIST_KEY, filtered);
    }
}
