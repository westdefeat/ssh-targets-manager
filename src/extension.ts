import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { parseSSHConfig, SSHHost } from './sshConfigParser';
import { FavoriteManager } from './favoriteManager';
import { RecentFoldersManager } from './recentFoldersManager';
import { SshTargetsWebviewProvider, GroupData, HostData } from './sshTargetsWebviewProvider';

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext) {
    log = vscode.window.createOutputChannel('SSH Targets Manager', { log: true });
    context.subscriptions.push(log);
    log.info('Extension activating');
    const favorites = new FavoriteManager(context.globalState);
    const recentFolders = new RecentFoldersManager(context.globalState);
    let allHosts: SSHHost[] = [];

    const webviewProvider = new SshTargetsWebviewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SshTargetsWebviewProvider.viewId,
            webviewProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
    );

    // --- Data building ---

    function toHostData(h: SSHHost): HostData {
        return {
            name: h.name,
            hostname: h.hostname,
            user: h.user,
            port: h.port,
            isFavorite: favorites.has(h.name),
            folders: recentFolders.getFolders(h.name),
        };
    }

    function buildGroups(): GroupData[] {
        const groups: GroupData[] = [];

        const favSet = favorites.getAll();
        const favHosts = allHosts.filter(h => favSet.has(h.name));
        if (favHosts.length > 0) {
            groups.push({ label: 'Favorites', isFavorites: true, hosts: favHosts.map(toHostData) });
        }

        const config = vscode.workspace.getConfiguration('sshTargetsManager');
        const customGroups: Record<string, string> = config.get('customGroups', {});
        const autoGroup: boolean = config.get('autoGroupBySubnet', true);

        if (Object.keys(customGroups).length > 0) {
            groupByCustomRules(allHosts, customGroups, groups);
        } else if (autoGroup) {
            groupBySubnet(allHosts, groups);
        } else {
            groups.push({ label: 'All Hosts', isFavorites: false, hosts: allHosts.map(toHostData) });
        }

        return groups;
    }

    function groupBySubnet(hosts: SSHHost[], out: GroupData[]) {
        const buckets = new Map<string, SSHHost[]>();
        const other: SSHHost[] = [];
        for (const h of hosts) {
            const m = h.hostname.match(/^(\d+\.\d+\.\d+)\.\d+$/);
            if (m) {
                let arr = buckets.get(m[1]);
                if (!arr) { arr = []; buckets.set(m[1], arr); }
                arr.push(h);
            } else {
                other.push(h);
            }
        }
        const sorted = [...buckets.entries()].sort(([a], [b]) => {
            const pa = a.split('.').map(Number);
            const pb = b.split('.').map(Number);
            for (let i = 0; i < pa.length; i++) {
                if (pa[i] !== pb[i]) { return pa[i] - pb[i]; }
            }
            return 0;
        });
        for (const [subnet, children] of sorted) {
            out.push({ label: `${subnet}.x`, isFavorites: false, hosts: children.map(toHostData) });
        }
        if (other.length > 0) {
            out.push({ label: 'Other', isFavorites: false, hosts: other.map(toHostData) });
        }
    }

    function groupByCustomRules(hosts: SSHHost[], rules: Record<string, string>, out: GroupData[]) {
        const compiled = Object.entries(rules).map(([name, pattern]) => ({
            name, re: new RegExp(pattern),
        }));
        const buckets = new Map<string, SSHHost[]>();
        const other: SSHHost[] = [];
        for (const h of hosts) {
            let matched = false;
            for (const { name, re } of compiled) {
                if (re.test(h.hostname) || re.test(h.name)) {
                    let arr = buckets.get(name);
                    if (!arr) { arr = []; buckets.set(name, arr); }
                    arr.push(h);
                    matched = true;
                    break;
                }
            }
            if (!matched) { other.push(h); }
        }
        for (const { name } of compiled) {
            const children = buckets.get(name);
            if (children && children.length > 0) {
                out.push({ label: name, isFavorites: false, hosts: children.map(toHostData) });
            }
        }
        if (other.length > 0) {
            out.push({ label: 'Other', isFavorites: false, hosts: other.map(toHostData) });
        }
    }

    function refreshView() {
        webviewProvider.updateData(buildGroups());
    }

    function loadHosts() {
        const paths = getConfigPaths();
        log.info(`Loading SSH config from ${paths.length} path(s): ${paths.join(', ')}`);
        allHosts = [];
        for (const p of paths) {
            try {
                const content = fs.readFileSync(p, 'utf-8');
                const hosts = parseSSHConfig(content);
                log.info(`  ${p}: parsed ${hosts.length} host(s)`);
                allHosts.push(...hosts);
            } catch (err: any) {
                log.warn(`  ${p}: failed to read — ${err.message}`);
            }
        }
        log.info(`Total hosts loaded: ${allHosts.length}`);
        refreshView();
    }

    // --- Webview action buttons ---

    webviewProvider.onAction(async (msg) => {
        const host = allHosts.find(h => h.name === msg.host);
        if (!host) {
            log.warn(`Action "${msg.action}" — host not found: ${msg.host}`);
            return;
        }
        log.info(`Action "${msg.action}" on host "${host.name}"${msg.folder ? ` folder="${msg.folder}"` : ''}`);
        switch (msg.action) {
            case 'connect':
                openRemote(host, false);
                break;
            case 'connectNewWindow':
                openRemote(host, true);
                break;
            case 'connectFolder':
                openRemote(host, false, msg.folder);
                break;
            case 'connectFolderNewWindow':
                openRemote(host, true, msg.folder);
                break;
            case 'openTerminal':
                openSshTerminal(host);
                break;
            case 'addFavorite':
                await favorites.add(host.name);
                refreshView();
                break;
            case 'removeFavorite':
                await favorites.remove(host.name);
                refreshView();
                break;
            case 'addFolder': {
                const folderPath = await vscode.window.showInputBox({
                    prompt: `Remote folder path for ${host.name}`,
                    placeHolder: '/home/username/project',
                });
                if (folderPath) {
                    await recentFolders.addFolder(host.name, folderPath);
                    refreshView();
                }
                break;
            }
            case 'removeFolder':
                if (msg.folder) {
                    await recentFolders.removeFolder(host.name, msg.folder);
                    refreshView();
                }
                break;
        }
    });

    // --- File watchers ---

    for (const p of getConfigPaths()) {
        try {
            const dir = path.dirname(p);
            const base = path.basename(p);
            const watcher = vscode.workspace.createFileSystemWatcher(
                new vscode.RelativePattern(vscode.Uri.file(dir), base),
            );
            watcher.onDidChange(() => { log.info(`Config file changed: ${p}`); loadHosts(); });
            watcher.onDidCreate(() => { log.info(`Config file created: ${p}`); loadHosts(); });
            watcher.onDidDelete(() => { log.info(`Config file deleted: ${p}`); loadHosts(); });
            context.subscriptions.push(watcher);
        } catch (err: any) {
            log.warn(`Failed to watch config file ${p}: ${err.message}`);
        }
    }

    // --- Commands (context menu + title bar) ---

    const reg = vscode.commands.registerCommand;

    context.subscriptions.push(
        reg('sshTargets.connect', (ctx?: any) => {
            if (!ctx?.hostName) { return; }
            const host = allHosts.find(h => h.name === ctx.hostName);
            if (host) { openRemote(host, false, ctx.folderPath); }
        }),

        reg('sshTargets.connectNewWindow', (ctx?: any) => {
            if (!ctx?.hostName) { return; }
            const host = allHosts.find(h => h.name === ctx.hostName);
            if (host) { openRemote(host, true, ctx.folderPath); }
        }),

        reg('sshTargets.openTerminal', (ctx?: any) => {
            if (!ctx?.hostName) { return; }
            const host = allHosts.find(h => h.name === ctx.hostName);
            if (host) { openSshTerminal(host); }
        }),

        reg('sshTargets.addFolder', async (ctx?: any) => {
            if (!ctx?.hostName) { return; }
            const host = allHosts.find(h => h.name === ctx.hostName);
            if (!host) { return; }
            const folderPath = await vscode.window.showInputBox({
                prompt: `Remote folder path for ${host.name}`,
                placeHolder: '/home/username/project',
            });
            if (folderPath) {
                await recentFolders.addFolder(host.name, folderPath);
                refreshView();
            }
        }),

        reg('sshTargets.removeFolder', async (ctx?: any) => {
            if (ctx?.hostName && ctx?.folderPath) {
                await recentFolders.removeFolder(ctx.hostName, ctx.folderPath);
                refreshView();
            }
        }),

        reg('sshTargets.addFavorite', async (ctx?: any) => {
            if (ctx?.hostName) {
                await favorites.add(ctx.hostName);
                refreshView();
            }
        }),

        reg('sshTargets.removeFavorite', async (ctx?: any) => {
            if (ctx?.hostName) {
                await favorites.remove(ctx.hostName);
                refreshView();
            }
        }),

        reg('sshTargets.copyHostname', (ctx?: any) => {
            if (!ctx?.hostName) { return; }
            const host = allHosts.find(h => h.name === ctx.hostName);
            if (host) {
                vscode.env.clipboard.writeText(host.hostname);
                vscode.window.showInformationMessage(`Copied: ${host.hostname}`);
            }
        }),

        reg('sshTargets.copySshCommand', (ctx?: any) => {
            if (!ctx?.hostName) { return; }
            const host = allHosts.find(h => h.name === ctx.hostName);
            if (host) {
                const cmd = `ssh ${host.name}`;
                vscode.env.clipboard.writeText(cmd);
                vscode.window.showInformationMessage(`Copied: ${cmd}`);
            }
        }),

        reg('sshTargets.removeHost', async (ctx?: any) => {
            if (!ctx?.hostName) { return; }
            const host = allHosts.find(h => h.name === ctx.hostName);
            if (!host) { return; }
            const confirm = await vscode.window.showWarningMessage(
                `Remove host "${host.name}" (${host.hostname})?`,
                { modal: true }, 'Remove',
            );
            if (confirm !== 'Remove') { return; }

            const configPath = path.join(os.homedir(), '.ssh', 'config');
            try {
                const content = fs.readFileSync(configPath, 'utf-8');
                const lines = content.split(/\r?\n/);
                const out: string[] = [];
                let skip = false;
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (/^Host\s/i.test(trimmed)) {
                        const name = trimmed.replace(/^Host\s+/i, '').trim();
                        skip = (name === host.name);
                    }
                    if (!skip) { out.push(line); }
                }
                fs.writeFileSync(configPath, out.join('\n'), 'utf-8');
                await favorites.remove(host.name);
                loadHosts();
                vscode.window.showInformationMessage(`Host "${host.name}" removed.`);
            } catch (err: any) {
                log.error(`Failed to remove host "${host.name}": ${err.message}`);
                vscode.window.showErrorMessage(`Failed to remove host: ${err.message}`);
            }
        }),

        reg('sshTargets.refresh', () => loadHosts()),

        reg('sshTargets.openSshConfig', () => {
            const defaultPath = path.join(os.homedir(), '.ssh', 'config');
            vscode.workspace.openTextDocument(defaultPath).then(
                doc => vscode.window.showTextDocument(doc),
            );
        }),

        reg('sshTargets.addHost', () => {
            showAddHostPanel(allHosts, loadHosts);
        }),
    );

    // --- Auto-record remote folders ---

    function recordRemoteFolders() {
        const wsFolders = vscode.workspace.workspaceFolders;
        if (!wsFolders || wsFolders.length === 0) { return; }
        let recorded = false;
        for (const ws of wsFolders) {
            if (ws.uri.scheme !== 'vscode-remote') { continue; }
            const match = ws.uri.authority.match(/^ssh-remote\+(.+)$/);
            if (!match) { continue; }
            const hostName = match[1];
            const folderPath = ws.uri.path;
            if (hostName && folderPath && folderPath !== '/') {
                log.info(`Auto-recording remote folder: ${hostName}:${folderPath}`);
                recentFolders.addFolder(hostName, folderPath);
                recorded = true;
            }
        }
        if (recorded) { refreshView(); }
    }

    recordRemoteFolders();
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => recordRemoteFolders()),
    );

    loadHosts();
}

// --- Remote connection ---

const homeDirCache = new Map<string, string>();

function queryRemoteHome(hostName: string): Promise<string | undefined> {
    const cached = homeDirCache.get(hostName);
    if (cached) {
        log.debug(`queryRemoteHome("${hostName}"): cache hit → ${cached}`);
        return Promise.resolve(cached);
    }
    log.info(`queryRemoteHome("${hostName}"): querying via ssh...`);
    const startTime = Date.now();
    return new Promise(resolve => {
        execFile(
            'ssh',
            ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', hostName, 'echo', '$HOME'],
            { timeout: 20000 },
            (err, stdout, stderr) => {
                const elapsed = Date.now() - startTime;
                const home = stdout?.trim();
                if (!err && home && home.startsWith('/')) {
                    homeDirCache.set(hostName, home);
                    log.info(`queryRemoteHome("${hostName}"): success → ${home} (${elapsed}ms)`);
                    resolve(home);
                } else {
                    const reason = err?.killed ? 'timeout' : (stderr?.trim() || err?.message || 'unknown');
                    log.warn(`queryRemoteHome("${hostName}"): failed — ${reason} (${elapsed}ms)`);
                    resolve(undefined);
                }
            },
        );
    });
}

function fallbackHomeDir(host: SSHHost): string {
    const user = host.user;
    if (!user) { return '/'; }
    return user === 'root' ? '/root' : `/home/${user}`;
}

function openSshTerminal(host: SSHHost) {
    const args = [host.name];
    log.info(`openSshTerminal: ssh ${args.join(' ')}`);
    try {
        const term = vscode.window.createTerminal({
            name: `SSH: ${host.name}`,
            shellPath: 'ssh',
            shellArgs: args,
        });
        term.show();
    } catch (err: any) {
        const message = err?.message || String(err);
        log.error(`openSshTerminal: failed to create terminal — ${message}`);
        log.show(true);
        vscode.window.showErrorMessage(`Failed to open SSH terminal: ${message}`);
    }
}

async function openRemote(host: SSHHost, forceNewWindow: boolean, folderPath?: string) {
    log.info(`openRemote: host="${host.name}" forceNewWindow=${forceNewWindow} folderPath=${folderPath ?? '(auto)'}`);
    let target: string;
    if (folderPath) {
        target = folderPath;
    } else {
        const queried = await queryRemoteHome(host.name);
        if (queried) {
            target = queried;
        } else {
            target = fallbackHomeDir(host);
            log.info(`openRemote: using fallback home dir → ${target}`);
        }
    }
    const uri = vscode.Uri.parse(`vscode-remote://ssh-remote+${host.name}${target}`);
    log.info(`openRemote: opening ${uri.toString()}`);
    vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow });
}

function getConfigPaths(): string[] {
    const defaultPath = path.join(os.homedir(), '.ssh', 'config');
    const config = vscode.workspace.getConfiguration('sshTargetsManager');
    const extra: string[] = config.get('sshConfigPaths', []);
    return [defaultPath, ...extra.filter(Boolean)];
}

function testSshConnection(user: string, ip: string): Promise<{ ok: boolean; msg: string }> {
    log.info(`testSshConnection: testing ${user}@${ip}...`);
    const startTime = Date.now();
    return new Promise(resolve => {
        execFile(
            'ssh',
            ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
             `${user}@${ip}`, 'echo', 'OK'],
            { timeout: 20000 },
            (err, stdout, stderr) => {
                const elapsed = Date.now() - startTime;
                if (!err && stdout.trim() === 'OK') {
                    log.info(`testSshConnection: ${user}@${ip} — success (${elapsed}ms)`);
                    resolve({ ok: true, msg: 'Connection successful.' });
                } else {
                    const hint = stderr?.includes('Permission denied')
                        ? 'Permission denied — public key not deployed or wrong user.'
                        : (stderr?.trim() || err?.message || 'Connection failed.');
                    log.warn(`testSshConnection: ${user}@${ip} — failed: ${hint} (${elapsed}ms)`);
                    resolve({ ok: false, msg: hint });
                }
            },
        );
    });
}

function deployPublicKey(user: string, ip: string, password: string) {
    log.info(`deployPublicKey: deploying key to ${user}@${ip}`);
    const sshDir = path.join(os.homedir(), '.ssh');
    let pubKeyPath = '';
    for (const name of ['id_ed25519.pub', 'id_rsa.pub', 'id_ecdsa.pub']) {
        const p = path.join(sshDir, name);
        if (fs.existsSync(p)) { pubKeyPath = p; break; }
    }
    if (!pubKeyPath) {
        log.warn('deployPublicKey: no local public key found');
        vscode.window.showWarningMessage('No local public key found. Generate one with ssh-keygen first.');
        return;
    }
    log.info(`deployPublicKey: using key ${pubKeyPath}`);
    const pubKey = fs.readFileSync(pubKeyPath, 'utf-8').trim();
    const remoteCmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qF '${pubKey}' ~/.ssh/authorized_keys 2>/dev/null || echo '${pubKey}' >> ~/.ssh/authorized_keys`;

    const term = vscode.window.createTerminal({ name: `Deploy key → ${ip}` });
    term.show();
    if (process.platform === 'win32') {
        term.sendText(`echo y | plink -ssh -l ${user} -pw "${password}" ${ip} "${remoteCmd}" 2>nul || ssh -o StrictHostKeyChecking=accept-new ${user}@${ip} "${remoteCmd}"`, true);
    } else {
        term.sendText(`sshpass -p '${password}' ssh -o StrictHostKeyChecking=accept-new ${user}@${ip} '${remoteCmd}' 2>/dev/null || ssh -o StrictHostKeyChecking=accept-new ${user}@${ip} '${remoteCmd}'`, true);
    }
}

function showAddHostPanel(allHosts: SSHHost[], loadHosts: () => void) {
    const panel = vscode.window.createWebviewPanel(
        'sshAddHost', 'Add SSH Host', vscode.ViewColumn.One,
        { enableScripts: true },
    );
    panel.webview.html = getAddHostHtml();
    panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.action === 'cancel') { panel.dispose(); return; }
        if (msg.action !== 'submit') { return; }

        const { user, ip, password } = msg;
        if (!user || !ip) {
            panel.webview.postMessage({ type: 'error', text: 'Username and IP are required.' });
            return;
        }
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
            panel.webview.postMessage({ type: 'error', text: 'Invalid IP format.' });
            return;
        }
        if (allHosts.some(h => h.hostname === ip && h.user === user)) {
            log.info(`addHost: ${user}@${ip} already exists`);
            panel.webview.postMessage({ type: 'error', text: `Host ${user}@${ip} already exists.` });
            return;
        }

        log.info(`addHost: testing connection to ${user}@${ip}`);
        panel.webview.postMessage({ type: 'status', text: `Testing connection to ${user}@${ip}...` });

        const result = await testSshConnection(user, ip);

        if (!result.ok && !password) {
            panel.webview.postMessage({ type: 'error', text: `Cannot connect: ${result.msg}\nProvide a password to deploy your public key.` });
            return;
        }

        const parts = ip.split('.');
        const alias = parts.slice(2).join('.') + '.' + user;
        const configPath = path.join(os.homedir(), '.ssh', 'config');
        const normalizedPassword = typeof password === 'string'
            ? password.replace(/[\r\n]+/g, ' ').trim()
            : '';
        const passwordComment = normalizedPassword ? `    # Password: ${normalizedPassword}\n` : '';
        try {
            fs.appendFileSync(
                configPath,
                `\n\nHost ${alias}\n    HostName ${ip}\n    User ${user}\n${passwordComment}`,
                'utf-8',
            );
            log.info(`addHost: wrote config entry "${alias}" (${user}@${ip}) to ${configPath}`);
        } catch (err: any) {
            log.error(`addHost: failed to write config — ${err.message}`);
            panel.webview.postMessage({ type: 'error', text: `Failed to write config: ${err.message}` });
            return;
        }

        loadHosts();
        panel.dispose();

        if (password && !result.ok) {
            deployPublicKey(user, ip, password);
            vscode.window.showInformationMessage(`Host ${alias} added. Deploying public key via terminal...`);
        } else {
            vscode.window.showInformationMessage(`Host ${alias} (${user}@${ip}) added.`);
        }
    });
}

function getAddHostHtml(): string {
    return /* html */ `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;justify-content:center;padding:40px 20px}
.card{width:100%;max-width:400px}
h2{font-size:16px;font-weight:600;margin-bottom:20px}
.field{margin-bottom:14px}
label{display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--vscode-descriptionForeground)}
input,select{width:100%;padding:5px 8px;border:1px solid var(--vscode-input-border,transparent);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:13px var(--vscode-font-family);border-radius:3px;outline:none}
input:focus,select:focus{border-color:var(--vscode-focusBorder)}
.hint{font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px}
.btns{display:flex;gap:10px;margin-top:20px;justify-content:flex-end}
button{padding:6px 16px;border:none;border-radius:3px;cursor:pointer;font:13px var(--vscode-font-family)}
.btn-ok{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.btn-ok:hover{background:var(--vscode-button-hoverBackground)}
.btn-ok:disabled{opacity:.5;cursor:default}
.btn-cancel{background:var(--vscode-button-secondaryBackground,rgba(128,128,128,.2));color:var(--vscode-button-secondaryForeground,var(--vscode-foreground))}
.msg{font-size:12px;margin-top:10px;display:none}
.msg.err{color:var(--vscode-errorForeground,#f44)}
.msg.info{color:var(--vscode-descriptionForeground)}
.user-row{display:flex;gap:8px}
.user-row select{width:auto;min-width:100px}
.user-row input{flex:1}
</style></head><body>
<div class="card">
<h2>Add SSH Host</h2>
<div class="field">
    <label>Username</label>
    <div class="user-row">
        <select id="userPreset"><option value="xiaolin">xiaolin</option><option value="lynxi">lynxi</option><option value="_custom">Custom...</option></select>
        <input id="userCustom" type="text" placeholder="Enter username" style="display:none"/>
    </div>
</div>
<div class="field">
    <label>IP Address</label>
    <input id="ip" type="text" value="192.168." placeholder="192.168.x.x" autofocus/>
</div>
<div class="field">
    <label>Password <span style="font-weight:400">(optional)</span></label>
    <input id="pw" type="password" placeholder="Leave empty if key already deployed"/>
    <div class="hint">If key auth fails and password is provided, your public key will be deployed automatically.</div>
</div>
<div class="msg" id="msg"></div>
<div class="btns">
    <button class="btn-cancel" id="cancelBtn">Cancel</button>
    <button class="btn-ok" id="okBtn">Add Host</button>
</div>
</div>
<script>
const vsc=acquireVsCodeApi();
const sel=document.getElementById('userPreset'),cust=document.getElementById('userCustom');
const ipEl=document.getElementById('ip'),pwEl=document.getElementById('pw'),msgEl=document.getElementById('msg'),okBtn=document.getElementById('okBtn');
sel.addEventListener('change',()=>{if(sel.value==='_custom'){cust.style.display='';cust.focus()}else{cust.style.display='none'}});
function getUser(){return sel.value==='_custom'?cust.value.trim():sel.value}
function submit(){
    msgEl.style.display='none';
    okBtn.disabled=true;okBtn.textContent='Testing...';
    vsc.postMessage({action:'submit',user:getUser(),ip:ipEl.value.trim(),password:pwEl.value});
}
okBtn.addEventListener('click',submit);
document.getElementById('cancelBtn').addEventListener('click',()=>vsc.postMessage({action:'cancel'}));
document.addEventListener('keydown',ev=>{if(ev.key==='Enter')submit();if(ev.key==='Escape')vsc.postMessage({action:'cancel'})});
window.addEventListener('message',ev=>{
    const d=ev.data;
    if(d.type==='error'){msgEl.className='msg err';msgEl.textContent=d.text;msgEl.style.display='block';okBtn.disabled=false;okBtn.textContent='Add Host'}
    if(d.type==='status'){msgEl.className='msg info';msgEl.textContent=d.text;msgEl.style.display='block'}
});
</script>
</body></html>`;
}

export function deactivate() {}
