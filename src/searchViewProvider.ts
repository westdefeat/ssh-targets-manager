import * as vscode from 'vscode';

export class SearchViewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'sshTargetsSearch';

    private _onDidChangeFilter = new vscode.EventEmitter<string>();
    readonly onDidChangeFilter = this._onDidChangeFilter.event;

    private _view?: vscode.WebviewView;
    private _currentFilter = '';

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        this._setupWebview(webviewView);

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._setupWebview(webviewView);
            }
        });

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });
    }

    private _setupWebview(webviewView: vscode.WebviewView) {
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = getHtml();
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'filter') {
                this._currentFilter = msg.value;
                this._onDidChangeFilter.fire(msg.value);
            }
        });

        if (this._currentFilter) {
            setTimeout(() => {
                webviewView.webview.postMessage({
                    type: 'restore',
                    value: this._currentFilter,
                });
            }, 100);
        }
    }

    clearFilter() {
        this._currentFilter = '';
        this._onDidChangeFilter.fire('');
        this._view?.webview.postMessage({ type: 'restore', value: '' });
    }
}

function getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html { height: 28px; overflow: hidden; }
body { height: 28px; padding: 2px 8px 2px; overflow: hidden; }

.search-wrap {
    position: relative;
    display: flex;
    align-items: center;
}

input {
    width: 100%;
    padding: 3px 52px 3px 6px;
    border: 1px solid var(--vscode-input-border, transparent);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font: 13px / 20px var(--vscode-font-family, sans-serif);
    border-radius: 2px;
    outline: none;
}
input:focus {
    border-color: var(--vscode-focusBorder);
}
input::placeholder {
    color: var(--vscode-input-placeholderForeground);
}

.actions {
    position: absolute;
    right: 2px;
    display: flex;
    align-items: center;
    gap: 1px;
}

.action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    background: none;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s;
}
.action-btn.visible {
    opacity: 0.7;
    pointer-events: auto;
}
.action-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
}

.action-btn svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
    color: var(--vscode-icon-foreground, var(--vscode-input-foreground));
}

.filter-btn {
    opacity: 0.7;
    pointer-events: auto;
}
.filter-btn.active {
    opacity: 1;
    color: var(--vscode-inputOption-activeForeground, #fff);
    background: var(--vscode-inputOption-activeBackground, #007acc);
    border: 1px solid var(--vscode-inputOption-activeBorder, transparent);
}
</style></head>
<body>
<div class="search-wrap">
    <input type="text" id="q" placeholder="Filter hosts..." spellcheck="false" autofocus />
    <div class="actions">
        <button class="action-btn" id="clearBtn" title="Clear">
            <svg viewBox="0 0 16 16">
                <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.11 9.68a.48.48 0 0 1-.7.7L8 8.96l-2.41 2.42a.48.48 0 0 1-.7-.7L7.31 8.27 4.89 5.85a.48.48 0 0 1 .7-.7L8 7.57l2.41-2.42a.48.48 0 0 1 .7.7L8.69 8.27l2.42 2.41z"/>
            </svg>
        </button>
        <button class="action-btn filter-btn" id="filterBtn" title="Filter Options">
            <svg viewBox="0 0 16 16">
                <path d="M6 12v-1h4v1H6zM4 7h8v1H4V7zm-2-4h12v1H2V3z"/>
            </svg>
        </button>
    </div>
</div>
<script>
const vsc = acquireVsCodeApi();
const q = document.getElementById('q');
const clearBtn = document.getElementById('clearBtn');
let debounceTimer;

function emitFilter() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        vsc.postMessage({ type: 'filter', value: q.value });
    }, 120);
    clearBtn.classList.toggle('visible', q.value.length > 0);
}

q.addEventListener('input', emitFilter);
q.addEventListener('keydown', e => {
    if (e.key === 'Escape') { q.value = ''; emitFilter(); }
});

clearBtn.addEventListener('click', () => {
    q.value = '';
    emitFilter();
    q.focus();
});

window.addEventListener('message', e => {
    if (e.data.type === 'restore') {
        q.value = e.data.value;
        clearBtn.classList.toggle('visible', q.value.length > 0);
    }
});

window.addEventListener('focus', () => q.focus());
</script>
</body></html>`;
}
