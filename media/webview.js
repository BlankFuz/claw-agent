// ── Global error handler — surfaces silent webview errors ──
window.onerror = function(msg, src, line, col) {
    var el = document.getElementById('chat-messages') || document.body;
    var d = document.createElement('div');
    d.style.cssText = 'color:#ff6b6b;font-size:11px;padding:6px 10px;font-family:monospace;background:rgba(255,50,50,0.1);border-left:3px solid #ff6b6b;margin:4px 0;';
    d.textContent = 'JS Error: ' + msg + ' (line ' + line + ')';
    el.appendChild(d);
};

const vscode = acquireVsCodeApi();
const $ = (s) => document.getElementById(s);
const sendBtn = $('send-btn');
const cancelBtn = $('cancel-btn');
const input = $('prompt-input');
const messagesDiv = $('chat-messages');
const usageBar = $('usage-bar');
const providerSelect = $('provider-select');
const apiKeyInput = $('api-key');
const baseUrlInput = $('base-url');
const modelSelect = $('model-select');
const customModelInput = $('custom-model');
const customModelRow = $('custom-model-row');
const thinkingBtn = $('thinking-btn');
const autoApproveBtn = $('auto-approve-btn');
const settingsBtn = $('settings-btn');
const settingsDrawer = $('settings-drawer');
const saveSettingsBtn = $('save-settings-btn');
const contextBar = $('context-bar');
const contextBarFill = $('context-bar-fill');
const contextBarLabel = $('context-bar-label');
const imagePreviews = $('image-previews');
const fileChips = $('file-chips');
const mentionDropdown = $('mention-dropdown');
const exportBtn = $('export-btn');
const importBtn = $('import-btn');
const gitBar = $('git-bar');
const gitBranchName = $('git-branch-name');
const gitStats = $('git-stats');
const gitRefreshBtn = $('git-refresh');

let streamingDiv = null;
let streamingRawText = '';
let thinkingStreamDiv = null;
let isRunning = false;
let thinkingEnabled = true;
var queuedMessage = null; // { text, images, files }
var codeContexts = []; // { filePath, startLine, endLine, lang, code }
var userMsgCounter = 0;

// ── Slash command autocomplete ──
const commandDropdown = $('command-dropdown');
var SLASH_COMMANDS = [
    { cmd: '/commit', desc: 'Stage changes and commit', args: '[message]' },
    { cmd: '/push', desc: 'Push commits to remote', args: '[remote] [branch]' },
    { cmd: '/review', desc: 'Review recent changes for issues' },
    { cmd: '/style', desc: 'CSS/styling expert mode', args: '<description>' },
    { cmd: '/learn', desc: 'Explore workspace for deep context' },
    { cmd: '/compact', desc: 'Compress conversation history' },
    { cmd: '/clear', desc: 'Clear chat and start fresh' },
    { cmd: '/export', desc: 'Export conversation as JSON' },
    { cmd: '/import', desc: 'Import a saved conversation' },
    { cmd: '/git', desc: 'Refresh git status' },
    { cmd: '/skill-create', desc: 'Create a new custom skill', args: '<name>' },
    { cmd: '/skill-list', desc: 'List all available skills' },
    { cmd: '/skill-delete', desc: 'Delete a custom skill', args: '<name>' },
    { cmd: '/memory', desc: 'Search past conversations', args: '<query>' },
    { cmd: '/memory-status', desc: 'Show MemPalace status' },
    { cmd: '/memory-setup', desc: 'Install MemPalace (one-time)' },
    { cmd: '/help', desc: 'Show all commands' },
];
var skillCommands = []; // populated from extension
var cmdActive = false;
var cmdSelectedIdx = 0;
var cmdFiltered = [];

function openCommandDropdown(query) {
    var q = query.toLowerCase();
    cmdFiltered = SLASH_COMMANDS.filter(function(c) {
        return c.cmd.substring(1).startsWith(q);
    });
    if (cmdFiltered.length === 0) {
        closeCommandDropdown();
        return;
    }
    cmdActive = true;
    cmdSelectedIdx = 0;
    renderCommandDropdown();
}

function renderCommandDropdown() {
    commandDropdown.innerHTML = '';
    cmdFiltered.forEach(function(c, idx) {
        var item = document.createElement('div');
        item.className = 'mention-item' + (idx === cmdSelectedIdx ? ' selected' : '');
        item.innerHTML = '<span class="cmd-name">' + c.cmd + '</span>' +
            (c.args ? ' <span class="cmd-desc">' + c.args + '</span>' : '') +
            '<span class="cmd-desc"> — ' + c.desc + '</span>';
        item.addEventListener('mousedown', function(e) {
            e.preventDefault();
            selectCommand(idx);
        });
        commandDropdown.appendChild(item);
    });
    commandDropdown.classList.add('open');
}

function selectCommand(idx) {
    var c = cmdFiltered[idx];
    if (!c) return;
    input.value = c.cmd + (c.args ? ' ' : '');
    input.focus();
    // Move cursor to end
    input.selectionStart = input.selectionEnd = input.value.length;
    closeCommandDropdown();
}

function closeCommandDropdown() {
    cmdActive = false;
    cmdFiltered = [];
    commandDropdown.classList.remove('open');
    commandDropdown.innerHTML = '';
}

// ── Model dropdown ──
const ANTHROPIC_MODELS = [
    { id: '', name: '(default) Claude Sonnet 4' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-3-5-20241022', name: 'Claude Haiku 3.5' },
    { id: 'claude-sonnet-4-6-20250725', name: 'Claude Sonnet 4.6' },
    { id: 'claude-opus-4-6-20250725', name: 'Claude Opus 4.6' },
];

// Cached fetched models per provider
var fetchedModels = { OpenAI: null, OpenRouter: null, Local: null };

function getSelectedModel() {
    if (modelSelect.value === '_custom') {
        return customModelInput.value.trim();
    }
    return modelSelect.value;
}

function populateModelSelect(models, savedModel) {
    modelSelect.innerHTML = '';
    models.forEach(function(m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name;
        modelSelect.appendChild(opt);
    });
    // Add custom option
    var customOpt = document.createElement('option');
    customOpt.value = '_custom';
    customOpt.textContent = 'Custom model...';
    modelSelect.appendChild(customOpt);

    // Restore saved selection
    if (savedModel) {
        var found = models.some(function(m) { return m.id === savedModel; });
        if (found) {
            modelSelect.value = savedModel;
        } else {
            modelSelect.value = '_custom';
            customModelInput.value = savedModel;
        }
    }
    updateCustomModelVisibility();
}

function updateCustomModelVisibility() {
    var isCustom = modelSelect.value === '_custom';
    customModelRow.style.display = isCustom ? '' : 'none';
    if (!isCustom) customModelInput.value = '';
}

function loadModelsForProvider(provider, savedModel) {
    if (provider === 'Anthropic') {
        populateModelSelect(ANTHROPIC_MODELS, savedModel);
    } else if (fetchedModels[provider]) {
        populateModelSelect(fetchedModels[provider], savedModel);
    } else {
        // Show loading state and request from extension host
        modelSelect.innerHTML = '<option value="">(loading models...)</option>';
        customModelRow.style.display = 'none';
        var fetchBaseUrl = baseUrlInput.value.trim();
        // For Local, use the current baseUrl field or default
        if (provider === 'Local' && !fetchBaseUrl) {
            fetchBaseUrl = 'http://localhost:11434/v1';
        }
        vscode.postMessage({
            type: 'fetchModels',
            value: {
                provider: provider,
                apiKey: apiKeyInput.value,
                baseUrl: fetchBaseUrl,
            },
        });
    }
}

modelSelect.addEventListener('change', updateCustomModelVisibility);

// ── Image attachments ──
var pendingImages = []; // { data: base64, mediaType: string, dataUrl: string }

function addImageAttachment(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (pendingImages.length >= 5) return; // max 5 images
    var reader = new FileReader();
    reader.onload = function(e) {
        var dataUrl = e.target.result;
        var base64 = dataUrl.split(',')[1];
        var img = { data: base64, mediaType: file.type, dataUrl: dataUrl };
        pendingImages.push(img);
        renderImagePreviews();
    };
    reader.readAsDataURL(file);
}

function renderImagePreviews() {
    imagePreviews.innerHTML = '';
    pendingImages.forEach(function(img, idx) {
        var thumb = document.createElement('div');
        thumb.className = 'img-thumb';
        thumb.innerHTML = '<img src="' + img.dataUrl + '"><button class="img-remove" data-idx="' + idx + '">&times;</button>';
        thumb.querySelector('.img-remove').addEventListener('click', function() {
            pendingImages.splice(idx, 1);
            renderImagePreviews();
        });
        imagePreviews.appendChild(thumb);
    });
}

// Paste handler
input.addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
        if (items[i].type.startsWith('image/')) {
            e.preventDefault();
            addImageAttachment(items[i].getAsFile());
            return;
        }
    }
});

// Drag & drop handler
var inputArea = input.closest('.input-area');
inputArea.addEventListener('dragover', function(e) {
    e.preventDefault();
    inputArea.style.borderColor = 'var(--accent)';
});
inputArea.addEventListener('dragleave', function() {
    inputArea.style.borderColor = '';
});
inputArea.addEventListener('drop', function(e) {
    e.preventDefault();
    inputArea.style.borderColor = '';
    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files) return;
    for (var i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/')) {
            addImageAttachment(files[i]);
        }
    }
});

// ── @-file mentions ──
var attachedFiles = []; // { path: string, content: string }
var mentionQuery = '';
var mentionActive = false;
var mentionSelectedIdx = 0;
var mentionResults = [];

function renderFileChips() {
    fileChips.innerHTML = '';
    // Code context chips
    codeContexts.forEach(function(ctx, idx) {
        var chip = document.createElement('span');
        chip.className = 'file-chip';
        chip.style.borderColor = 'var(--accent)';
        chip.innerHTML = '<span class="mention-icon" style="color:var(--accent);">&lt;/&gt;</span>' +
            ctx.filePath + ':' + ctx.startLine + '-' + ctx.endLine +
            '<button class="chip-remove" data-ctx-idx="' + idx + '">&times;</button>';
        chip.querySelector('.chip-remove').addEventListener('click', function() {
            codeContexts.splice(idx, 1);
            renderFileChips();
        });
        fileChips.appendChild(chip);
    });
    // File attachment chips
    attachedFiles.forEach(function(f, idx) {
        var chip = document.createElement('span');
        chip.className = 'file-chip';
        chip.innerHTML = '<span class="mention-icon">@</span>' + f.path +
            '<button class="chip-remove" data-idx="' + idx + '">&times;</button>';
        chip.querySelector('.chip-remove').addEventListener('click', function() {
            attachedFiles.splice(idx, 1);
            renderFileChips();
        });
        fileChips.appendChild(chip);
    });
}

function openMentionDropdown(query) {
    mentionQuery = query;
    mentionActive = true;
    mentionSelectedIdx = 0;
    vscode.postMessage({ type: 'searchFiles', value: query });
}

function closeMentionDropdown() {
    mentionActive = false;
    mentionQuery = '';
    mentionResults = [];
    mentionDropdown.classList.remove('open');
    mentionDropdown.innerHTML = '';
}

function renderMentionResults(results) {
    mentionResults = results;
    mentionDropdown.innerHTML = '';
    if (results.length === 0) {
        closeMentionDropdown();
        return;
    }
    results.forEach(function(path, idx) {
        var item = document.createElement('div');
        item.className = 'mention-item' + (idx === mentionSelectedIdx ? ' selected' : '');
        item.innerHTML = '<span class="mention-icon">@</span>' + path;
        item.addEventListener('mousedown', function(e) {
            e.preventDefault();
            selectMention(path);
        });
        mentionDropdown.appendChild(item);
    });
    mentionDropdown.classList.add('open');
}

function selectMention(path) {
    // Remove the @query from the input
    var val = input.value;
    var atIdx = val.lastIndexOf('@');
    if (atIdx >= 0) {
        input.value = val.substring(0, atIdx) + val.substring(atIdx + mentionQuery.length + 1);
    }
    closeMentionDropdown();
    // Check if already attached
    if (attachedFiles.some(function(f) { return f.path === path; })) return;
    // Request file content from extension
    vscode.postMessage({ type: 'readFileForAttach', value: path });
}

input.addEventListener('input', function() {
    // Auto-resize
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';

    var val = input.value;

    // Check for slash command autocomplete — only when "/" is at position 0
    if (val.startsWith('/') && !val.includes('\n')) {
        var query = val.substring(1).split(' ')[0]; // text after "/" before first space
        if (val.indexOf(' ') === -1) {
            // Still typing the command name (no space yet)
            openCommandDropdown(query);
            return;
        }
    }
    if (cmdActive) closeCommandDropdown();

    // Check for @-mention
    var cursor = input.selectionStart;
    var beforeCursor = val.substring(0, cursor);
    var atIdx = beforeCursor.lastIndexOf('@');
    if (atIdx >= 0 && (atIdx === 0 || beforeCursor[atIdx - 1] === ' ' || beforeCursor[atIdx - 1] === '\n')) {
        var query2 = beforeCursor.substring(atIdx + 1);
        if (query2.length >= 1 && !query2.includes(' ')) {
            openMentionDropdown(query2);
            return;
        }
    }
    if (mentionActive) closeMentionDropdown();
});

input.addEventListener('keydown', function(e) {
    // Slash command dropdown navigation
    if (cmdActive && cmdFiltered.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            cmdSelectedIdx = (cmdSelectedIdx + 1) % cmdFiltered.length;
            renderCommandDropdown();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            cmdSelectedIdx = (cmdSelectedIdx - 1 + cmdFiltered.length) % cmdFiltered.length;
            renderCommandDropdown();
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            selectCommand(cmdSelectedIdx);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeCommandDropdown();
            return;
        }
    }
    if (mentionActive && mentionResults.length > 0) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            mentionSelectedIdx = (mentionSelectedIdx + 1) % mentionResults.length;
            renderMentionResults(mentionResults);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            mentionSelectedIdx = (mentionSelectedIdx - 1 + mentionResults.length) % mentionResults.length;
            renderMentionResults(mentionResults);
            return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
            if (mentionActive && mentionResults.length > 0) {
                e.preventDefault();
                selectMention(mentionResults[mentionSelectedIdx]);
                return;
            }
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMentionDropdown();
            return;
        }
    }
    if (e.key === 'Escape' && queuedMessage) {
        e.preventDefault();
        queuedMessage = null;
        updateQueueHint();
        return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !mentionActive) {
        e.preventDefault();
        if (isRunning) {
            queueMessage();
        } else {
            send();
        }
    }
});

// ── Per-provider settings ──
const providerSettings = {
    Anthropic: { apiKey: '', baseUrl: '', model: '' },
    OpenAI:    { apiKey: '', baseUrl: '', model: '' },
    OpenRouter: { apiKey: '', baseUrl: '', model: '' },
    Local:     { apiKey: '', baseUrl: 'http://localhost:11434/v1', model: '' },
};

function stashCurrentProvider() {
    const p = providerSelect.value;
    if (providerSettings[p]) {
        providerSettings[p].apiKey = apiKeyInput.value;
        providerSettings[p].baseUrl = baseUrlInput.value.trim();
        providerSettings[p].model = getSelectedModel();
    }
}

function loadProviderFields(p) {
    const s = providerSettings[p] || { apiKey: '', baseUrl: '', model: '' };
    apiKeyInput.value = s.apiKey || '';
    baseUrlInput.value = s.baseUrl || '';
    loadModelsForProvider(p, s.model || '');
}

// ── Running state ──
function setRunning(running) {
    isRunning = running;
    sendBtn.style.display = running ? 'none' : '';
    cancelBtn.style.display = running ? '' : 'none';
    // Keep input enabled so user can type while agent is working
    input.disabled = false;
    updateQueueHint();
}

function updateQueueHint() {
    var hint = input.closest('.input-area').querySelector('.input-hint');
    if (!hint) return;
    if (queuedMessage) {
        hint.textContent = 'Message queued — will send when agent finishes. Esc to cancel queue.';
        hint.style.color = 'var(--accent)';
    } else if (isRunning) {
        hint.textContent = 'Agent is working. Enter to queue your next message.';
        hint.style.color = '';
    } else {
        hint.textContent = 'Enter to send, Shift+Enter for new line, @ to attach files';
        hint.style.color = '';
    }
}

// ── Thinking toggle ──
thinkingBtn.classList.add('active');
thinkingBtn.addEventListener('click', () => {
    thinkingEnabled = !thinkingEnabled;
    thinkingBtn.classList.toggle('active', thinkingEnabled);
    vscode.postMessage({ type: 'toggleThinking', value: thinkingEnabled });
});

// ── Auto-approve toggle ──
var autoApproveEnabled = false;
autoApproveBtn.addEventListener('click', () => {
    autoApproveEnabled = !autoApproveEnabled;
    autoApproveBtn.classList.toggle('active', autoApproveEnabled);
    autoApproveBtn.innerHTML = autoApproveEnabled
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> YOLO'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg> Ask';
    vscode.postMessage({ type: 'toggleAutoApprove', value: autoApproveEnabled });
});

// ── Settings drawer ──
settingsBtn.addEventListener('click', () => {
    settingsDrawer.classList.toggle('open');
});

// ── Provider switch — swap API keys ──
let lastProvider = providerSelect.value;
providerSelect.addEventListener('change', () => {
    // Stash the old provider's fields before switching
    if (providerSettings[lastProvider]) {
        providerSettings[lastProvider].apiKey = apiKeyInput.value;
        providerSettings[lastProvider].baseUrl = baseUrlInput.value.trim();
        providerSettings[lastProvider].model = getSelectedModel();
    }
    lastProvider = providerSelect.value;
    loadProviderFields(providerSelect.value);
});

// ── Save settings ──
saveSettingsBtn.addEventListener('click', () => {
    stashCurrentProvider();
    settingsDrawer.classList.remove('open');
    vscode.postMessage({
        type: 'saveSettings',
        value: {
            provider: providerSelect.value,
            providerSettings: JSON.parse(JSON.stringify(providerSettings)),
        }
    });
});

// (auto-resize and @-mention handling are in the input event listener above)

// ── Syntax highlighter (lightweight, no deps) ──
// Keyword-only highlighter: avoids complex regex escaping issues inside template literals.
// Highlights keywords, numbers, strings (simple), and comments.
var KW_SET = 'function,const,let,var,return,if,else,for,while,class,import,export,from,default,async,await,try,catch,throw,new,typeof,instanceof,switch,case,break,continue,yield,def,self,lambda,print,elif,pass,raise,with,as,None,True,False,fn,pub,mut,impl,struct,enum,match,use,mod,crate,trait,type,interface,extends,implements';
var KW_MAP = {};
KW_SET.split(',').forEach(function(k) { KW_MAP[k] = true; });

function highlight(code) {
    var h = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Tokenize: split into words, strings, comments, numbers, and other chars
    var out = '';
    var i = 0;
    var len = h.length;
    while (i < len) {
        var ch = h[i];
        // Line comments
        if (ch === '/' && h[i+1] === '/') {
            var end = h.indexOf('\n', i);
            if (end === -1) end = len;
            out += '<span class="tok-cm">' + h.substring(i, end) + '</span>';
            i = end;
            continue;
        }
        // Block comments
        if (ch === '/' && h[i+1] === '*') {
            var end2 = h.indexOf('*/', i + 2);
            if (end2 === -1) end2 = len; else end2 += 2;
            out += '<span class="tok-cm">' + h.substring(i, end2) + '</span>';
            i = end2;
            continue;
        }
        // Hash comments
        if (ch === '#') {
            var end3 = h.indexOf('\n', i);
            if (end3 === -1) end3 = len;
            out += '<span class="tok-cm">' + h.substring(i, end3) + '</span>';
            i = end3;
            continue;
        }
        // Strings (double or single quotes)
        if (ch === '"' || ch === "'") {
            var q = ch;
            var j = i + 1;
            while (j < len && h[j] !== q) {
                if (h[j] === '\\') j++; // skip escaped char
                j++;
            }
            j = Math.min(j + 1, len);
            out += '<span class="tok-str">' + h.substring(i, j) + '</span>';
            i = j;
            continue;
        }
        // Numbers
        if ((ch >= '0' && ch <= '9') || (ch === '.' && h[i+1] >= '0' && h[i+1] <= '9')) {
            var j2 = i;
            while (j2 < len && ((h[j2] >= '0' && h[j2] <= '9') || h[j2] === '.' || h[j2] === 'e' || h[j2] === 'E' || h[j2] === '+' || h[j2] === '-' || h[j2] === 'x' || h[j2] === 'X' || (h[j2] >= 'a' && h[j2] <= 'f') || (h[j2] >= 'A' && h[j2] <= 'F'))) j2++;
            out += '<span class="tok-num">' + h.substring(i, j2) + '</span>';
            i = j2;
            continue;
        }
        // Words (identifiers / keywords)
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
            var j3 = i + 1;
            while (j3 < len && ((h[j3] >= 'a' && h[j3] <= 'z') || (h[j3] >= 'A' && h[j3] <= 'Z') || (h[j3] >= '0' && h[j3] <= '9') || h[j3] === '_')) j3++;
            var word = h.substring(i, j3);
            if (KW_MAP[word]) {
                out += '<span class="tok-kw">' + word + '</span>';
            } else if (word[0] >= 'A' && word[0] <= 'Z') {
                out += '<span class="tok-typ">' + word + '</span>';
            } else if (j3 < len && h.substring(j3).trimStart()[0] === '(') {
                out += '<span class="tok-fn">' + word + '</span>';
            } else {
                out += word;
            }
            i = j3;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

// ── Markdown renderer ──
function md(text) {
    if (!text) return '';
    // Escape HTML
    let h = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Fenced code blocks with syntax highlighting & copy button
    var fenceRe = new RegExp('\x60\x60\x60(\\w*)\n([\\s\\S]*?)\x60\x60\x60', 'g');
    h = h.replace(fenceRe, function(_, lang, code) {
        var trimmed = code.replace(/^\n+|\n+$/g, '');
        var highlighted = highlight(trimmed);
        var langLabel = lang ? '<span class="code-lang">' + lang + '</span>' : '';
        return '<pre>' + langLabel + '<button class="copy-btn">Copy</button><code>' + highlighted + '</code></pre>';
    });

    // Inline code (must come after fenced blocks)
    var inlineCodeRe = new RegExp('\x60([^\x60\\n]+)\x60', 'g');
    h = h.replace(inlineCodeRe, '<code>$1</code>');

    // Headings
    h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Horizontal rule
    h = h.replace(/^---$/gm, '<hr>');

    // Blockquotes
    h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Bold + italic
    h = h.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Links
    h = h.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" title="$1">$1</a>');

    // Unordered lists (simple — consecutive lines starting with - or *)
    h = h.replace(/(?:^|\n)((?:[-*] .+\n?)+)/g, function(_, block) {
        const items = block.trim().split('\n').map(function(line) {
            return '<li>' + line.replace(/^[-*] /, '') + '</li>';
        }).join('');
        return '<ul>' + items + '</ul>';
    });

    // Ordered lists
    h = h.replace(/(?:^|\n)((?:\d+\. .+\n?)+)/g, function(_, block) {
        const items = block.trim().split('\n').map(function(line) {
            return '<li>' + line.replace(/^\d+\. /, '') + '</li>';
        }).join('');
        return '<ol>' + items + '</ol>';
    });

    // Tables
    h = h.replace(/(?:^|\n)(\|.+\|(?:\n\|[-: |]+\|)?(?:\n\|.+\|)+)/g, function(_, table) {
        const rows = table.trim().split('\n').filter(function(r) { return !/^\|[-: |]+\|$/.test(r); });
        if (rows.length === 0) return table;
        let html = '<table>';
        rows.forEach(function(row, i) {
            const cells = row.split('|').filter(function(c) { return c.trim() !== ''; });
            const tag = i === 0 ? 'th' : 'td';
            html += '<tr>' + cells.map(function(c) { return '<' + tag + '>' + c.trim() + '</' + tag + '>'; }).join('') + '</tr>';
        });
        html += '</table>';
        return html;
    });

    // Line breaks (but not inside pre/code blocks or already handled elements)
    h = h.replace(/\n/g, '<br>');
    // Clean up excessive <br> after block elements
    h = h.replace(/<\/(pre|h[1-3]|ul|ol|blockquote|hr|table)><br>/g, '</$1>');
    h = h.replace(/<br><(pre|h[1-3]|ul|ol|blockquote|hr|table)/g, '<$1');

    return h;
}

// ── Diff builder ──
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function buildDiffHtml(filePath, oldStr, newStr) {
    var oldLines = (oldStr || '').split('\n');
    var newLines = (newStr || '').split('\n');
    var html = '<div class="diff-view">';
    html += '<div class="diff-header">' + esc(filePath) + '</div>';
    // Show removed lines then added lines with context
    for (var i = 0; i < oldLines.length; i++) {
        if (i < newLines.length && oldLines[i] === newLines[i]) {
            html += '<div class="diff-line diff-ctx">  ' + esc(oldLines[i]) + '</div>';
        } else {
            html += '<div class="diff-line diff-del">- ' + esc(oldLines[i]) + '</div>';
        }
    }
    for (var i = 0; i < newLines.length; i++) {
        if (i >= oldLines.length || oldLines[i] !== newLines[i]) {
            html += '<div class="diff-line diff-add">+ ' + esc(newLines[i]) + '</div>';
        }
    }
    if (oldLines.length === 0 && newLines.length > 0) {
        html += '<div class="diff-line diff-ctx" style="color:var(--accent)">(new file)</div>';
    }
    html += '</div>';
    return html;
}

function scrollBottom() {
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ── Collapsible long content ──
var COLLAPSE_THRESHOLD = 400; // chars of raw text before collapsing

/**
 * If the raw text exceeds the threshold, build a collapsible DOM node
 * with a "Read more" / "Read less" toggle button.
 * Returns a DOM element (not an HTML string).
 */
function makeCollapsible(rawText, renderedHtml) {
    var wrap = document.createElement('div');
    wrap.className = 'collapsible-wrap';

    var content = document.createElement('div');
    content.className = 'collapsible-content collapsed';
    content.innerHTML = renderedHtml;

    var btn = document.createElement('button');
    btn.className = 'collapsible-toggle';
    btn.innerHTML = 'Read more <span class="collapsible-arrow">&#9660;</span>';
    btn.addEventListener('click', function() {
        var isCollapsed = content.classList.toggle('collapsed');
        if (isCollapsed) {
            btn.innerHTML = 'Read more <span class="collapsible-arrow">&#9660;</span>';
            wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
            btn.innerHTML = 'Read less <span class="collapsible-arrow">&#9650;</span>';
        }
    });

    wrap.appendChild(content);
    wrap.appendChild(btn);
    return wrap;
}

/** Returns true if the raw text is long enough to warrant collapsing. */
function needsCollapse(rawText) {
    return rawText && rawText.length > COLLAPSE_THRESHOLD;
}

// ── Add message helpers ──
function addUser(text, imageUrls, filePaths, userIdx, hasCheckpoint) {
    var idx = (userIdx != null) ? userIdx : userMsgCounter;
    var div = document.createElement('div');
    div.className = 'msg msg-user';
    div.setAttribute('data-user-index', String(idx));

    var avatar = document.createElement('div');
    avatar.className = 'msg-user-avatar';
    avatar.textContent = 'Y';

    var body = document.createElement('div');
    body.className = 'msg-user-body';

    if (needsCollapse(text)) {
        body.appendChild(makeCollapsible(text, md(text)));
    } else {
        body.innerHTML = md(text);
    }

    if (filePaths && filePaths.length > 0) {
        var chipDiv = document.createElement('div');
        chipDiv.style.cssText = 'margin-top:4px;font-size:11px;color:var(--text-muted);';
        filePaths.forEach(function(p) { chipDiv.innerHTML += '<span class="file-chip" style="margin:2px;"><span class="mention-icon">@</span>' + p + '</span> '; });
        body.appendChild(chipDiv);
    }
    if (imageUrls && imageUrls.length > 0) {
        var imgDiv = document.createElement('div');
        imgDiv.className = 'msg-user-images';
        imageUrls.forEach(function(url) { imgDiv.innerHTML += '<img src="' + url + '">'; });
        body.appendChild(imgDiv);
    }

    div.appendChild(avatar);
    div.appendChild(body);

    // Rewind button (shown on hover)
    if (hasCheckpoint !== false) {
        var rewindBtn = document.createElement('button');
        rewindBtn.className = 'msg-rewind-btn';
        rewindBtn.title = 'Rewind to this point';
        rewindBtn.innerHTML = '&#8617;';
        rewindBtn.setAttribute('data-user-index', String(idx));
        div.appendChild(rewindBtn);
    }

    if (userIdx == null) { userMsgCounter++; }
    messagesDiv.appendChild(div);
    scrollBottom();
}

function addAssistant(text) {
    const div = document.createElement('div');
    div.className = 'msg msg-assistant';
    if (needsCollapse(text)) {
        div.appendChild(makeCollapsible(text, md(text)));
    } else {
        div.innerHTML = md(text);
    }
    messagesDiv.appendChild(div);
    scrollBottom();
}

function addThinkingBlock(text) {
    const d = document.createElement('details');
    d.className = 'msg msg-thinking';
    const s = document.createElement('summary');
    s.textContent = 'Thinking';
    const c = document.createElement('div');
    c.className = 'thinking-content';
    c.innerHTML = md(text);
    d.appendChild(s); d.appendChild(c);
    // Insert before the streaming assistant div so thinking appears above the response
    if (streamingDiv && streamingDiv.parentNode === messagesDiv) {
        messagesDiv.insertBefore(d, streamingDiv);
    } else {
        messagesDiv.appendChild(d);
    }
    scrollBottom();
}

// ── Message handler ──
window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
        case 'addUserMessage': addUser(msg.value, null, null, msg.userMsgIndex, msg.hasCheckpoint); break;
        case 'addResponse': addAssistant(msg.value); break;
        case 'addProgress': {
            const div = document.createElement('div');
            div.className = 'msg msg-progress';
            div.innerHTML = '<div class="spinner"></div> ' + msg.value;
            messagesDiv.appendChild(div);
            scrollBottom();
            break;
        }
        case 'toolResult': {
            // Remove last progress spinner
            const progs = messagesDiv.querySelectorAll('.msg-progress');
            if (progs.length) progs[progs.length - 1].remove();
            const div = document.createElement('div');
            div.className = 'msg msg-tool';
            var toolNameDiv = document.createElement('div');
            toolNameDiv.className = 'msg-tool-name';
            toolNameDiv.textContent = msg.value.name || '';
            div.appendChild(toolNameDiv);
            var toolText = msg.value.result || '';
            if (needsCollapse(toolText)) {
                div.appendChild(makeCollapsible(toolText, md(toolText)));
            } else {
                var toolBody = document.createElement('div');
                toolBody.innerHTML = md(toolText);
                div.appendChild(toolBody);
            }
            messagesDiv.appendChild(div);
            scrollBottom();
            break;
        }
        case 'quietToolResult': {
            // Remove last progress spinner
            const progs2 = messagesDiv.querySelectorAll('.msg-progress');
            if (progs2.length) progs2[progs2.length - 1].remove();
            const div2 = document.createElement('div');
            div2.className = 'msg msg-quiet-tool';
            div2.textContent = (msg.value.name || '') + ': ' + (msg.value.result || '').split('\n')[0];
            messagesDiv.appendChild(div2);
            scrollBottom();
            break;
        }
        case 'shellResult': {
            // Remove last progress spinner
            const progs3 = messagesDiv.querySelectorAll('.msg-progress');
            if (progs3.length) progs3[progs3.length - 1].remove();
            const shellDiv = document.createElement('div');
            shellDiv.className = 'msg msg-shell' + (msg.value.exitOk ? '' : ' shell-error');
            const cmdDiv = document.createElement('div');
            cmdDiv.className = 'msg-shell-cmd';
            cmdDiv.innerHTML = '<span class="shell-chevron">&#9654;</span> $ ' + msg.value.command.substring(0, 200);
            const outDiv = document.createElement('div');
            outDiv.className = 'msg-shell-output';
            outDiv.textContent = msg.value.output || '(no output)';
            cmdDiv.addEventListener('click', () => {
                const chevron = cmdDiv.querySelector('.shell-chevron');
                const isOpen = outDiv.classList.toggle('open');
                if (chevron) chevron.classList.toggle('open', isOpen);
            });
            shellDiv.appendChild(cmdDiv);
            shellDiv.appendChild(outDiv);
            messagesDiv.appendChild(shellDiv);
            scrollBottom();
            break;
        }
        case 'confirmTool': {
            // Remove last progress spinner
            const progs4 = messagesDiv.querySelectorAll('.msg-progress');
            if (progs4.length) progs4[progs4.length - 1].remove();
            const confirmDiv = document.createElement('div');
            confirmDiv.className = 'msg msg-confirm';
            const header = document.createElement('div');
            header.className = 'msg-confirm-header';
            header.textContent = 'Agent wants to run: ' + msg.value.name;
            confirmDiv.appendChild(header);
            // Show diff preview for file tools, plain summary otherwise
            if (msg.value.diff) {
                const diffDiv = document.createElement('div');
                diffDiv.innerHTML = buildDiffHtml(msg.value.diff.filePath, msg.value.diff.oldStr, msg.value.diff.newStr);
                confirmDiv.appendChild(diffDiv);
            } else {
                const summary = document.createElement('div');
                summary.className = 'msg-confirm-summary';
                summary.textContent = msg.value.summary;
                confirmDiv.appendChild(summary);
            }
            const actions = document.createElement('div');
            actions.className = 'msg-confirm-actions';
            const allowBtn = document.createElement('button');
            allowBtn.className = 'confirm-allow';
            allowBtn.textContent = 'Allow';
            const denyBtn = document.createElement('button');
            denyBtn.className = 'confirm-deny';
            denyBtn.textContent = 'Deny';
            allowBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'confirmToolResponse', value: true });
                confirmDiv.remove();
                const prog = document.createElement('div');
                prog.className = 'msg msg-progress';
                prog.innerHTML = '<div class="spinner"></div> Running ' + msg.value.name + '...';
                messagesDiv.appendChild(prog);
                scrollBottom();
            });
            denyBtn.addEventListener('click', () => {
                vscode.postMessage({ type: 'confirmToolResponse', value: false });
                header.textContent = 'Denied: ' + msg.value.name;
                header.style.color = 'var(--vscode-terminal-ansiRed, #f48771)';
                actions.remove();
            });
            actions.appendChild(allowBtn);
            actions.appendChild(denyBtn);
            confirmDiv.appendChild(actions);
            messagesDiv.appendChild(confirmDiv);
            scrollBottom();
            break;
        }
        case 'compactStatus': {
            // Status update (e.g. "Summarizing...") — don't clear chat
            const statusDiv = document.createElement('div');
            statusDiv.className = 'msg msg-system-cmd';
            statusDiv.textContent = msg.value;
            messagesDiv.appendChild(statusDiv);
            scrollBottom();
            break;
        }
        case 'compactDone': {
            setRunning(false);
            // Keep old messages visible — compact only affects the backend context
            const sysDiv = document.createElement('div');
            sysDiv.className = 'msg msg-system-cmd';
            sysDiv.textContent = msg.value;
            messagesDiv.appendChild(sysDiv);
            scrollBottom();
            break;
        }
        case 'thinkingDelta':
            if (!thinkingStreamDiv) {
                thinkingStreamDiv = document.createElement('div');
                thinkingStreamDiv.className = 'msg thinking-streaming';
                thinkingStreamDiv.innerHTML = '<div class="spinner"></div> Thinking...';
                messagesDiv.appendChild(thinkingStreamDiv);
            }
            scrollBottom();
            break;
        case 'thinkingEnd':
            if (thinkingStreamDiv) { thinkingStreamDiv.remove(); thinkingStreamDiv = null; }
            if (msg.value) addThinkingBlock(msg.value);
            break;
        case 'streamDelta':
            if (!streamingDiv) {
                streamingDiv = document.createElement('div');
                streamingDiv.className = 'msg msg-assistant';
                streamingRawText = '';
                messagesDiv.appendChild(streamingDiv);
            }
            streamingRawText += msg.value;
            streamingDiv.innerHTML = md(streamingRawText);
            scrollBottom();
            break;
        case 'streamEnd':
            if (streamingDiv) {
                streamingDiv.innerHTML = md(streamingRawText);
                streamingDiv = null;
                streamingRawText = '';
            }
            break;
        case 'contextBar': {
            const pct = msg.value.percent || 0;
            contextBar.classList.toggle('visible', pct > 0);
            contextBarFill.style.width = pct + '%';
            contextBarFill.className = 'context-bar-fill' +
                (pct >= 90 ? ' critical' : pct >= 70 ? ' warn' : '');
            contextBarLabel.textContent = msg.value.label || '';
            break;
        }
        case 'usage': usageBar.textContent = msg.value; break;
        case 'done':
            setRunning(false);
            if (queuedMessage) {
                // Small delay so the UI updates before sending next
                setTimeout(sendQueued, 100);
            }
            break;
        case 'cleared':
            messagesDiv.innerHTML = '<div class="msg-system" style="padding:20px 0;font-size:11px;color:var(--text-muted);text-align:center;">Chat cleared. Ready.</div>';
            usageBar.textContent = '';
            userMsgCounter = 0;
            break;
        case 'loadSettings':
            if (msg.value) {
                // Load per-provider settings if available, else migrate old flat format
                if (msg.value.providerSettings) {
                    for (const [p, s] of Object.entries(msg.value.providerSettings)) {
                        if (providerSettings[p] && s) {
                            providerSettings[p].apiKey = s.apiKey || '';
                            providerSettings[p].baseUrl = s.baseUrl || '';
                            providerSettings[p].model = s.model || '';
                        }
                    }
                } else if (msg.value.apiKey) {
                    // Migrate old single-key format into the current provider
                    const p = msg.value.provider || 'Anthropic';
                    providerSettings[p] = {
                        apiKey: msg.value.apiKey || '',
                        baseUrl: msg.value.baseUrl || '',
                        model: msg.value.model || '',
                    };
                }
                if (msg.value.provider) providerSelect.value = msg.value.provider;
                loadProviderFields(providerSelect.value);
            }
            break;
        case 'gitStatus':
            updateGitBar(msg.value);
            break;
        case 'exportDone': {
            const sysD = document.createElement('div');
            sysD.className = 'msg msg-system-cmd';
            sysD.textContent = msg.value || 'Exported.';
            messagesDiv.appendChild(sysD);
            scrollBottom();
            break;
        }
        case 'importDone': {
            const sysI = document.createElement('div');
            sysI.className = 'msg msg-system-cmd';
            sysI.textContent = msg.value || 'Imported.';
            messagesDiv.appendChild(sysI);
            scrollBottom();
            break;
        }
        case 'modelList': {
            var ml = msg.value;
            if (ml && ml.models && ml.models.length > 0) {
                // Cache them
                if (ml.provider !== 'Anthropic') {
                    fetchedModels[ml.provider] = ml.models;
                }
                // Only update if we're still on this provider
                if (providerSelect.value === ml.provider) {
                    var saved = providerSettings[ml.provider] && providerSettings[ml.provider].model;
                    populateModelSelect(ml.models, saved || '');
                }
            } else if (ml && providerSelect.value === ml.provider) {
                // No models returned — show default + custom
                modelSelect.innerHTML = '<option value="">(default)</option><option value="_custom">Custom model...</option>';
                updateCustomModelVisibility();
            }
            break;
        }
        case 'fileSearchResults':
            if (mentionActive) renderMentionResults(msg.value || []);
            break;
        case 'fileContentForAttach':
            if (msg.value && !msg.value.error) {
                attachedFiles.push({ path: msg.value.path, content: msg.value.content });
                renderFileChips();
            }
            break;
        case 'addCodeContext':
            if (msg.value && msg.value.code) {
                codeContexts.push(msg.value);
                renderFileChips();
                input.focus();
            }
            break;
        case 'skillList':
            if (msg.value && Array.isArray(msg.value)) {
                skillCommands = msg.value;
                // Remove old dynamic skill commands (keep /skill-create, /skill-list, /skill-delete)
                var managementCmds = ['/skill-create', '/skill-list', '/skill-delete'];
                SLASH_COMMANDS = SLASH_COMMANDS.filter(function(c) {
                    return !c.cmd.startsWith('/skill-') || managementCmds.indexOf(c.cmd) !== -1;
                });
                // Add dynamic skill invocation commands
                skillCommands.forEach(function(sc) {
                    SLASH_COMMANDS.push({ cmd: sc.cmd, desc: sc.desc, args: sc.args || '<request>' });
                });
            }
            break;
    }
});

// ── Copy button delegation (CSP-safe) ──
document.addEventListener('click', function(e) {
    var btn = e.target.closest('.copy-btn');
    if (btn) {
        var code = btn.parentElement.querySelector('code');
        if (code) navigator.clipboard.writeText(code.textContent);
    }
});

// ── Rewind button delegation ──
function closeRewindMenu() {
    var old = document.querySelector('.rewind-menu');
    if (old) { old.remove(); }
}
document.addEventListener('click', function(e) {
    // If clicking inside an open menu, let the menu item handler deal with it
    if (e.target.closest('.rewind-menu')) { return; }
    // Close any existing menu when clicking elsewhere
    closeRewindMenu();

    var btn = e.target.closest('.msg-rewind-btn');
    if (!btn || isRunning) { return; }
    e.stopPropagation();
    var idx = parseInt(btn.getAttribute('data-user-index'), 10);

    // Build inline popup menu
    var menu = document.createElement('div');
    menu.className = 'rewind-menu';
    var options = [
        { label: 'Restore code & conversation', action: 'code_and_conversation' },
        { label: 'Restore code only', action: 'code_only' },
        { label: 'Restore conversation only', action: 'conversation_only' },
    ];
    options.forEach(function(opt) {
        var item = document.createElement('button');
        item.className = 'rewind-menu-item';
        item.textContent = opt.label;
        item.addEventListener('click', function(ev) {
            ev.stopPropagation();
            closeRewindMenu();
            vscode.postMessage({ type: 'rewindToMessage', value: { userMsgIndex: idx, action: opt.action } });
        });
        menu.appendChild(item);
    });
    btn.parentElement.appendChild(menu);
});

// ── Export / Import ──
exportBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'exportConversation' });
});
importBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'importConversation' });
});

// ── Git status bar ──
function updateGitBar(data) {
    if (!data || !data.branch) {
        gitBar.classList.remove('visible');
        return;
    }
    gitBar.classList.add('visible');
    gitBranchName.textContent = data.branch;
    gitStats.innerHTML = '';
    if (data.staged > 0) {
        gitStats.innerHTML += '<span class="git-stat staged">+' + data.staged + ' staged</span>';
    }
    if (data.modified > 0) {
        gitStats.innerHTML += '<span class="git-stat modified">' + data.modified + ' modified</span>';
    }
    if (data.untracked > 0) {
        gitStats.innerHTML += '<span class="git-stat untracked">' + data.untracked + ' untracked</span>';
    }
    if (data.staged === 0 && data.modified === 0 && data.untracked === 0) {
        gitStats.innerHTML = '<span class="git-stat" style="color:var(--vscode-terminal-ansiGreen,#89d185)">clean</span>';
    }
}
gitRefreshBtn.addEventListener('click', function() {
    vscode.postMessage({ type: 'refreshGit' });
});

// ── Queue ──
function queueMessage() {
    var text = input.value.trim();
    if (!text) return;
    queuedMessage = {
        text: text,
        images: pendingImages.length > 0 ? pendingImages.slice() : [],
        files: attachedFiles.length > 0 ? attachedFiles.slice() : [],
        codeCtx: codeContexts.length > 0 ? codeContexts.slice() : [],
    };
    input.value = '';
    input.style.height = 'auto';
    pendingImages = [];
    renderImagePreviews();
    attachedFiles = [];
    codeContexts = [];
    renderFileChips();
    updateQueueHint();
}

function sendQueued() {
    if (!queuedMessage) return;
    var q = queuedMessage;
    queuedMessage = null;
    // Restore queued data then send
    input.value = q.text;
    pendingImages = q.images;
    attachedFiles = q.files;
    codeContexts = q.codeCtx || [];
    if (pendingImages.length > 0) renderImagePreviews();
    if (attachedFiles.length > 0 || codeContexts.length > 0) renderFileChips();
    send();
}

// ── Send ──
function send() {
    const text = input.value.trim();
    if (!text) return;

    // Handle slash commands locally
    if (text.startsWith('/')) {
        const cmd = text.split(' ')[0].toLowerCase();
        switch (cmd) {
            case '/compact':
                addUser(text);
                setRunning(true);
                vscode.postMessage({
                    type: 'compactHistory',
                    value: {
                        provider: providerSelect.value,
                        apiKey: apiKeyInput.value,
                        baseUrl: baseUrlInput.value.trim() || undefined,
                        model: getSelectedModel() || undefined,
                    }
                });
                input.value = '';
                input.style.height = 'auto';
                return;
            case '/clear':
                vscode.postMessage({ type: 'clearHistory' });
                input.value = '';
                input.style.height = 'auto';
                return;
            case '/export':
                addUser(text);
                vscode.postMessage({ type: 'exportConversation' });
                input.value = '';
                input.style.height = 'auto';
                return;
            case '/import':
                addUser(text);
                vscode.postMessage({ type: 'importConversation' });
                input.value = '';
                input.style.height = 'auto';
                return;
            case '/git':
                addUser(text);
                vscode.postMessage({ type: 'refreshGit' });
                input.value = '';
                input.style.height = 'auto';
                return;
            case '/memory':
            case '/memory-status':
            case '/memory-setup':
                addUser(text);
                setRunning(true);
                vscode.postMessage({
                    type: 'askAgent',
                    value: {
                        provider: providerSelect.value,
                        apiKey: apiKeyInput.value,
                        prompt: text,
                        baseUrl: baseUrlInput.value.trim() || undefined,
                        model: getSelectedModel() || undefined,
                    }
                });
                input.value = '';
                input.style.height = 'auto';
                return;
            case '/learn':
                addUser('/learn');
                addAssistant('🔍 **Learning workspace...** This will take one full turn to explore the codebase.');
                setRunning(true);
                vscode.postMessage({
                    type: 'askAgent',
                    value: {
                        provider: providerSelect.value,
                        apiKey: apiKeyInput.value,
                        prompt: '/learn',
                        baseUrl: baseUrlInput.value.trim() || undefined,
                        model: getSelectedModel() || undefined,
                    }
                });
                input.value = '';
                input.style.height = 'auto';
                return;
            case '/commit': {
                var commitMsg = text.slice('/commit'.length).trim();
                addUser(text);
                setRunning(true);
                vscode.postMessage({
                    type: 'askAgent',
                    value: {
                        provider: providerSelect.value,
                        apiKey: apiKeyInput.value,
                        prompt: '/commit' + (commitMsg ? ' ' + commitMsg : ''),
                        baseUrl: baseUrlInput.value.trim() || undefined,
                        model: getSelectedModel() || undefined,
                    }
                });
                input.value = '';
                input.style.height = 'auto';
                return;
            }
            case '/push': {
                var pushArgs = text.slice('/push'.length).trim();
                addUser(text);
                setRunning(true);
                vscode.postMessage({
                    type: 'askAgent',
                    value: {
                        provider: providerSelect.value,
                        apiKey: apiKeyInput.value,
                        prompt: '/push' + (pushArgs ? ' ' + pushArgs : ''),
                        baseUrl: baseUrlInput.value.trim() || undefined,
                        model: getSelectedModel() || undefined,
                    }
                });
                input.value = '';
                input.style.height = 'auto';
                return;
            }
            case '/review': {
                addUser(text);
                setRunning(true);
                vscode.postMessage({
                    type: 'askAgent',
                    value: {
                        provider: providerSelect.value,
                        apiKey: apiKeyInput.value,
                        prompt: '/review',
                        baseUrl: baseUrlInput.value.trim() || undefined,
                        model: getSelectedModel() || undefined,
                    }
                });
                input.value = '';
                input.style.height = 'auto';
                return;
            }
            case '/style': {
                var styleMsg = text.slice('/style'.length).trim();
                if (!styleMsg) {
                    addUser(text);
                    addAssistant('Usage: **/style** `<description>` — Describe what you want styled.\nExample: `/style make the sidebar responsive with a collapsible menu`');
                    input.value = '';
                    input.style.height = 'auto';
                    return;
                }
                var styleFilePaths = attachedFiles.map(function(f) { return f.path; });
                codeContexts.forEach(function(ctx) {
                    styleFilePaths.push(ctx.filePath + ':' + ctx.startLine + '-' + ctx.endLine);
                });
                addUser(text, pendingImages.length > 0 ? pendingImages.map(function(im) { return im.dataUrl; }) : null, styleFilePaths.length > 0 ? styleFilePaths : null);
                setRunning(true);
                vscode.postMessage({
                    type: 'askAgent',
                    value: {
                        provider: providerSelect.value,
                        apiKey: apiKeyInput.value,
                        prompt: '/style ' + styleMsg,
                        baseUrl: baseUrlInput.value.trim() || undefined,
                        model: getSelectedModel() || undefined,
                        images: pendingImages.length > 0 ? pendingImages.map(function(im) { return { data: im.data, mediaType: im.mediaType }; }) : undefined,
                        fileAttachments: attachedFiles.length > 0 ? attachedFiles.slice() : undefined,
                    }
                });
                input.value = '';
                input.style.height = 'auto';
                pendingImages = [];
                renderImagePreviews();
                attachedFiles = [];
                codeContexts = [];
                renderFileChips();
                return;
            }
            case '/help': {
                addUser(text);
                var helpText = '**Available commands:**\n- **/style** `<description>` — CSS/styling expert mode\n- **/commit** `[message]` — Stage changes and commit\n- **/push** `[remote] [branch]` — Push commits to remote\n- **/review** — Review recent changes for bugs and issues\n- **/learn** — Spend a turn exploring the workspace for better context\n- **/compact** — Compress conversation history\n- **/clear** — Clear chat and start fresh\n- **/export** — Export conversation as JSON\n- **/import** — Import a saved conversation\n- **/git** — Refresh git status\n\n**Skill Management:**\n- **/skill-create** `<name> <description>` — Create a new custom skill\n- **/skill-list** — List all available skills (built-in + custom)\n- **/skill-delete** `<name>` — Delete a custom skill\n\n**Memory (MemPalace):**\n- **/memory** `<query>` — Search past conversations\n- **/memory-status** — Show MemPalace status\n- **/memory-setup** — Install MemPalace (one-time setup)\n\n- **/help** — Show this help';
                if (skillCommands.length > 0) {
                    helpText += '\n\n**Skills:**';
                    skillCommands.forEach(function(sc) {
                        helpText += '\n- **' + sc.cmd + '** `' + (sc.args || '<request>') + '` — ' + sc.desc;
                    });
                }
                addAssistant(helpText);
                input.value = '';
                input.style.height = 'auto';
                return;
            }
            default:
                // Handle /skill-* commands dynamically
                if (cmd.startsWith('/skill-')) {
                    var skillFilePaths = attachedFiles.map(function(f) { return f.path; });
                    codeContexts.forEach(function(ctx) {
                        skillFilePaths.push(ctx.filePath + ':' + ctx.startLine + '-' + ctx.endLine);
                    });
                    addUser(text, pendingImages.length > 0 ? pendingImages.map(function(im) { return im.dataUrl; }) : null, skillFilePaths.length > 0 ? skillFilePaths : null);
                    setRunning(true);
                    vscode.postMessage({
                        type: 'askAgent',
                        value: {
                            provider: providerSelect.value,
                            apiKey: apiKeyInput.value,
                            prompt: text,
                            baseUrl: baseUrlInput.value.trim() || undefined,
                            model: getSelectedModel() || undefined,
                            images: pendingImages.length > 0 ? pendingImages.map(function(im) { return { data: im.data, mediaType: im.mediaType }; }) : undefined,
                            fileAttachments: attachedFiles.length > 0 ? attachedFiles.slice() : undefined,
                        }
                    });
                    input.value = '';
                    input.style.height = 'auto';
                    pendingImages = [];
                    renderImagePreviews();
                    attachedFiles = [];
                    codeContexts = [];
                    renderFileChips();
                    return;
                }
                break;
        }
    }

    // Build code context prefix
    var codeCtxParts = [];
    if (codeContexts.length > 0) {
        codeContexts.forEach(function(ctx) {
            codeCtxParts.push('--- ' + ctx.filePath + ':' + ctx.startLine + '-' + ctx.endLine + ' (' + ctx.lang + ') ---\n' + ctx.code);
        });
    }

    var allFilePaths = attachedFiles.map(function(f) { return f.path; });
    codeContexts.forEach(function(ctx) {
        allFilePaths.push(ctx.filePath + ':' + ctx.startLine + '-' + ctx.endLine);
    });

    addUser(text, pendingImages.length > 0 ? pendingImages.map(function(im) { return im.dataUrl; }) : null, allFilePaths.length > 0 ? allFilePaths : null);
    setRunning(true);

    // Build the full prompt with code context prepended
    var fullPrompt = text;
    if (codeCtxParts.length > 0) {
        fullPrompt = '<code_context>\n' + codeCtxParts.join('\n\n') + '\n</code_context>\n\n' + text;
    }

    var msgValue = {
        provider: providerSelect.value,
        apiKey: apiKeyInput.value,
        prompt: fullPrompt,
        baseUrl: baseUrlInput.value.trim() || undefined,
        model: getSelectedModel() || undefined,
        images: pendingImages.length > 0 ? pendingImages.map(function(im) { return { data: im.data, mediaType: im.mediaType }; }) : undefined,
        fileAttachments: attachedFiles.length > 0 ? attachedFiles.slice() : undefined,
    };
    vscode.postMessage({ type: 'askAgent', value: msgValue });
    input.value = '';
    input.style.height = 'auto';
    pendingImages = [];
    renderImagePreviews();
    attachedFiles = [];
    codeContexts = [];
    renderFileChips();
}
sendBtn.addEventListener('click', function() {
    if (isRunning) {
        queueMessage();
    } else {
        send();
    }
});
// (keydown handler for Enter and @-mention navigation is above)

cancelBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'cancelAgent' });
});

// Signal that the webview is ready to receive messages
vscode.postMessage({ type: 'webviewReady' });
// Request initial git status
vscode.postMessage({ type: 'refreshGit' });
// Request available skills
vscode.postMessage({ type: 'fetchSkills' });
