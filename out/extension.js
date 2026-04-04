"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const SidebarProvider_1 = require("./SidebarProvider");
function activate(context) {
    const sidebarProvider = new SidebarProvider_1.SidebarProvider(context.extensionUri, context.globalState);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("claw-agent.sidebarView", sidebarProvider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    // Open / focus the chat panel
    context.subscriptions.push(vscode.commands.registerCommand('claw-agent.openChat', () => {
        vscode.commands.executeCommand('claw-agent.sidebarView.focus');
    }));
    // New chat (clear history)
    context.subscriptions.push(vscode.commands.registerCommand('claw-agent.newChat', () => {
        sidebarProvider.clearHistory();
    }));
    // Add selection to Claw Agent context
    context.subscriptions.push(vscode.commands.registerCommand('claw-agent.addToContext', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (!text) {
            return;
        }
        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const lang = editor.document.languageId;
        sidebarProvider.addCodeContext({ filePath, startLine, endLine, lang, code: text });
        // Focus the sidebar
        vscode.commands.executeCommand('claw-agent.sidebarView.focus');
    }));
    // Add selection and ask about it
    context.subscriptions.push(vscode.commands.registerCommand('claw-agent.addToContextAndAsk', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const selection = editor.selection;
        const text = editor.document.getText(selection);
        if (!text) {
            return;
        }
        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const lang = editor.document.languageId;
        sidebarProvider.addCodeContext({ filePath, startLine, endLine, lang, code: text });
        // Focus the sidebar and prompt
        vscode.commands.executeCommand('claw-agent.sidebarView.focus');
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map