import * as vscode from 'vscode';

export interface GroupData {
    label: string;
    isFavorites: boolean;
    hosts: HostData[];
}

export interface HostData {
    name: string;
    hostname: string;
    user?: string;
    port?: number;
    isFavorite: boolean;
    folders: string[];
}

export class SshTargetsWebviewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'sshTargetsView';

    private _view?: vscode.WebviewView;
    private _lastData?: GroupData[];
    private _onAction = new vscode.EventEmitter<Record<string, string>>();
    readonly onAction = this._onAction.event;

    resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = getHtml();

        webviewView.webview.onDidReceiveMessage(msg => {
            this._onAction.fire(msg);
        });

        webviewView.onDidDispose(() => {
            this._view = undefined;
        });

        if (this._lastData) {
            setTimeout(() => {
                this._view?.webview.postMessage({ type: 'update', groups: this._lastData });
            }, 50);
        }
    }

    updateData(groups: GroupData[]) {
        this._lastData = groups;
        this._view?.webview.postMessage({ type: 'update', groups });
    }
}

function getHtml(): string {
    return /* html */ `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html{height:100%;overflow-x:hidden}
body{height:100%;overflow-y:auto;overflow-x:hidden;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);margin-left:-15px;margin-right:-8px}

/* Search */
.search-wrap{position:sticky;top:0;z-index:1;padding:4px 0 3px 0;display:flex;align-items:center;background:var(--vscode-sideBar-background,var(--vscode-editor-background))}
.inp-wrap{position:relative;flex:1}
.search-input{
    width:100%;padding:3px 28px 3px 6px;
    border:1px solid var(--vscode-input-border,transparent);
    background:var(--vscode-input-background);
    color:var(--vscode-input-foreground);
    font:13px/20px var(--vscode-font-family,sans-serif);
    border-radius:2px;outline:none;
}
.search-input:focus{border-color:var(--vscode-focusBorder)}
.search-input::placeholder{color:var(--vscode-input-placeholderForeground)}
.clear-btn{
    position:absolute;right:3px;top:50%;transform:translateY(-50%);
    background:none;border:none;color:var(--vscode-input-foreground);
    cursor:pointer;line-height:0;
    opacity:0;pointer-events:none;padding:2px;border-radius:3px;
}
.clear-btn.visible{opacity:.6;pointer-events:auto}
.clear-btn:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2))}
.clear-btn svg{width:14px;height:14px}

/* Scrollbar */
::-webkit-scrollbar{width:8px}
::-webkit-scrollbar-button{display:none;width:0;height:0}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,rgba(100,100,100,.4));min-height:40px;border-radius:0}
::-webkit-scrollbar-thumb:hover{background:var(--vscode-scrollbarSlider-hoverBackground,rgba(100,100,100,.6))}
::-webkit-scrollbar-thumb:active{background:var(--vscode-scrollbarSlider-activeBackground,rgba(100,100,100,.7))}
::-webkit-scrollbar-corner{background:transparent}

/* Tree */
.tree{padding:2px 0 8px}

.row{
    display:flex;align-items:center;height:24px;
    padding-right:0;cursor:default;user-select:none;white-space:nowrap;
    transition:background .08s;
}
.row:hover{background:var(--vscode-list-hoverBackground)}

/* Group */
.group-row{
    padding-left:0;cursor:pointer;height:26px;margin-top:2px;
    font-size:11px;font-weight:600;text-transform:uppercase;
    letter-spacing:.04em;
    color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground));
}
.group-row:first-child{margin-top:0}

/* Host & Folder indent */
.host-row{padding-left:16px;cursor:pointer}
.folder-row{padding-left:30px}

/* Chevron */
.chev{
    display:inline-flex;align-items:center;justify-content:center;
    width:14px;height:14px;flex-shrink:0;
    transition:transform .12s ease;
}
.chev svg{width:12px;height:12px;opacity:.7}
.chev.open{transform:rotate(90deg)}
.spacer{width:14px;flex-shrink:0;display:inline-block}

/* Icons */
.ico{
    width:16px;height:16px;display:inline-flex;
    align-items:center;justify-content:center;
    flex-shrink:0;margin-right:3px;
}
.ico svg{width:14px;height:14px;color:var(--vscode-icon-foreground,inherit);opacity:.85}

/* Labels */
.lbl{overflow:hidden;text-overflow:ellipsis;flex-shrink:1;min-width:0;font-size:12.5px}
.desc{
    flex:1;margin-left:6px;
    color:var(--vscode-descriptionForeground);
    overflow:hidden;text-overflow:ellipsis;font-size:11.5px;min-width:0;
}
.cnt{
    margin-left:6px;font-weight:400;font-size:10px;
    background:var(--vscode-badge-background,rgba(128,128,128,.15));
    color:var(--vscode-badge-foreground,inherit);
    padding:0 5px;border-radius:8px;line-height:16px;
}

/* Action buttons */
.acts{flex-shrink:0;display:none;gap:2px;margin-left:6px;margin-right:2px}
.row:hover .acts{display:flex}
.ab{
    background:none;border:none;
    color:var(--vscode-icon-foreground);cursor:pointer;
    padding:3px;border-radius:3px;line-height:0;
    opacity:.65;transition:opacity .1s,background .1s;
}
.ab:hover{background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.2));opacity:1}
.ab svg{width:14px;height:14px}

/* Empty state */
.empty{padding:24px 16px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px}
</style></head>
<body>
<div class="search-wrap">
    <div class="inp-wrap">
        <input class="search-input" id="q" placeholder="Filter hosts..." spellcheck="false" autofocus/>
        <button class="clear-btn" id="x"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg></button>
    </div>
</div>
<div class="tree" id="tree"></div>
<script>
const vsc=acquireVsCodeApi(),qEl=document.getElementById('q'),xEl=document.getElementById('x'),tEl=document.getElementById('tree');
let G=[],EX={};

const S={
chev:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5l4.5 4.5-4.5 4.5"/></svg>',
star:'<svg viewBox="0 0 16 16"><path d="M8 1.6l1.8 3.6 4 .6-2.9 2.8.7 4L8 10.6l-3.6 2 .7-4L2.2 5.8l4-.6z" fill="currentColor"/></svg>',
server:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.5" y="1.5" width="11" height="4.5" rx="1.2"/><circle cx="11" cy="3.75" r=".7" fill="currentColor" stroke="none"/><rect x="2.5" y="10" width="11" height="4.5" rx="1.2"/><circle cx="11" cy="12.25" r=".7" fill="currentColor" stroke="none"/><path d="M8 6v4"/></svg>',
monitor:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2" width="13" height="9" rx="1.5"/><path d="M6 13.5h4M8 11v2.5"/></svg>',
folder:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M1.5 4v8.5a1 1 0 001 1h11a1 1 0 001-1V5.5a1 1 0 00-1-1H7.5L6 3H2.5a1 1 0 00-1 1z"/></svg>',
play:'<svg viewBox="0 0 16 16" fill="currentColor" opacity=".85"><path d="M5.25 3.2v9.6a.5.5 0 00.76.43l7.5-4.8a.5.5 0 000-.86l-7.5-4.8a.5.5 0 00-.76.43z"/></svg>',
extLink:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5H13.5V6.5M13.5 2.5L7.5 8.5M11 9.5v4H2.5V5H7"/></svg>',
close:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
starLine:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"><path d="M8 2.2l1.6 3.2 3.5.5-2.5 2.5.6 3.5L8 10.2l-3.2 1.7.6-3.5-2.5-2.5 3.5-.5z"/></svg>',
terminal:'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M4.5 6l2.5 2-2.5 2M8.5 10h3"/></svg>',
};

function e(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

function render(){
    const q=qEl.value.toLowerCase().trim();
    let h='',any=false;
    for(const g of G){
        const hs=q?g.hosts.filter(v=>mt(v,q)):g.hosts;
        if(!hs.length)continue;
        any=true;
        const gk='g:'+g.label;
        if(EX[gk]===undefined)EX[gk]=true;
        const go=EX[gk];
        h+='<div class="row group-row" data-tg="'+e(gk)+'">'
           +'<span class="chev'+(go?' open':'')+'">'+S.chev+'</span>'
           +'<span class="ico">'+(g.isFavorites?S.star:S.server)+'</span>'
           +'<span class="lbl">'+e(g.label)+'</span><span class="cnt">'+hs.length+'</span></div>';
        if(!go)continue;
        for(const v of hs){
            const hk=gk+'|h:'+v.name;
            const hf=v.folders.length>0;
            if(EX[hk]===undefined)EX[hk]=false;
            const ho=EX[hk];
            const arr=hf?'<span class="chev'+(ho?' open':'')+'">'+S.chev+'</span>':'<span class="spacer"></span>';
            let d='';
            if(v.hostname!==v.name)d+=v.hostname;
            if(v.user)d+=' @'+v.user;
            const fi=v.isFavorite,fa=fi?'removeFavorite':'addFavorite';
            const hostCtx=e(JSON.stringify({webviewSection:'sshHost',hostName:v.name,webviewItemIsFavorite:fi,preventDefaultContextMenuItems:true}));
            h+='<div class="row host-row" data-hk="'+e(hk)+'" data-vscode-context="'+hostCtx+'">'+arr
               +'<span class="ico">'+S.monitor+'</span>'
               +'<span class="lbl">'+e(v.name)+'</span><span class="desc">'+e(d)+'</span>'
               +'<span class="acts">'
               +'<btn class="ab" data-do="connect" data-h="'+e(v.name)+'" title="Connect">'+S.play+'</btn>'
               +'<btn class="ab" data-do="connectNewWindow" data-h="'+e(v.name)+'" title="New Window">'+S.extLink+'</btn>'
               +'<btn class="ab" data-do="openTerminal" data-h="'+e(v.name)+'" title="SSH Terminal">'+S.terminal+'</btn>'
               +'<btn class="ab" data-do="'+fa+'" data-h="'+e(v.name)+'" title="Favorite">'+(fi?S.star:S.starLine)+'</btn>'
               +'</span></div>';
            if(ho&&hf)for(const f of v.folders){
                const sg=f.split('/').filter(Boolean),fn=sg.length?sg[sg.length-1]:'/';
                const folderCtx=e(JSON.stringify({webviewSection:'sshFolder',hostName:v.name,folderPath:f,preventDefaultContextMenuItems:true}));
                h+='<div class="row folder-row" data-vscode-context="'+folderCtx+'"><span class="spacer"></span>'
                   +'<span class="ico">'+S.folder+'</span>'
                   +'<span class="lbl">'+e(fn)+'</span><span class="desc">'+e(f)+'</span>'
                   +'<span class="acts">'
                   +'<btn class="ab" data-do="connectFolder" data-h="'+e(v.name)+'" data-f="'+e(f)+'" title="Connect">'+S.play+'</btn>'
                   +'<btn class="ab" data-do="connectFolderNewWindow" data-h="'+e(v.name)+'" data-f="'+e(f)+'" title="New Window">'+S.extLink+'</btn>'
                   +'<btn class="ab" data-do="removeFolder" data-h="'+e(v.name)+'" data-f="'+e(f)+'" title="Remove">'+S.close+'</btn>'
                   +'</span></div>';
            }
        }
    }
    tEl.innerHTML=any?h:'<div class="empty">No matching hosts</div>';
}

function mt(v,q){
    return v.name.toLowerCase().includes(q)
        ||v.hostname.toLowerCase().includes(q)
        ||(v.user&&v.user.toLowerCase().includes(q))
        ||v.folders.some(f=>f.toLowerCase().includes(q));
}

function toggleHost(el){
    const hk=el.dataset.hk;
    if(hk && EX[hk]!==undefined){EX[hk]=!EX[hk];render()}
}

qEl.addEventListener('input',()=>{xEl.classList.toggle('visible',qEl.value.length>0);render()});
qEl.addEventListener('keydown',ev=>{if(ev.key==='Escape'){qEl.value='';xEl.classList.remove('visible');render()}});
xEl.addEventListener('click',()=>{qEl.value='';xEl.classList.remove('visible');render();qEl.focus()});

tEl.addEventListener('click',ev=>{
    const b=ev.target.closest('[data-do]');
    if(b){const m={action:b.dataset.do};if(b.dataset.h)m.host=b.dataset.h;if(b.dataset.f)m.folder=b.dataset.f;vsc.postMessage(m);return}
    const tg=ev.target.closest('[data-tg]');
    if(tg){EX[tg.dataset.tg]=!EX[tg.dataset.tg];render();return}
    const hr=ev.target.closest('.host-row[data-hk]');
    if(hr){toggleHost(hr)}
});

tEl.addEventListener('dblclick',ev=>{
    const hr=ev.target.closest('.host-row[data-hk]');
    if(hr){toggleHost(hr)}
});

window.addEventListener('message',ev=>{if(ev.data.type==='update'){G=ev.data.groups;render()}});
window.addEventListener('focus',()=>qEl.focus());
</script>
</body></html>`;
}
