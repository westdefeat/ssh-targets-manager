import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { execFile, spawn } from 'child_process';
import { parseSSHConfig, SSHHost } from './sshConfigParser';
import { FavoriteManager } from './favoriteManager';
import { RecentFoldersManager } from './recentFoldersManager';
import { SharedFolderStore } from './sharedFolderStore';
import { getHostAliases, SSHHostTreeProvider, TreeElement } from './sshHostTreeProvider';

const MIGRATION_NOTICE_KEY = 'sshTargets.sharedStoreMigrationNoticeShown';

let log: vscode.LogOutputChannel;

export function activate(context: vscode.ExtensionContext) {
    const activateStartedAt = Date.now();
    log = vscode.window.createOutputChannel('SSH Targets Manager', { log: true });
    context.subscriptions.push(log);
    log.info('Extension activating');
    const favorites = new FavoriteManager(context.globalState);

    // Shared on-disk store under ~/.ssh/.ssh-targets-folders.json.
    // This is the source of truth across Cursor / Trae / VS Code / etc.
    const sharedFolders = new SharedFolderStore(log);
    sharedFolders.load();
    const recentFolders = new RecentFoldersManager(context.globalState, sharedFolders);

    maybeAnnounceMigration(context, recentFolders.migrationResult);

    let allHosts: SSHHost[] = [];

    const treeProvider = new SSHHostTreeProvider(favorites, recentFolders);
    const treeView = vscode.window.createTreeView('sshTargetsView', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
    });
    context.subscriptions.push(
        treeView,
    );

    // --- Data building ---

    function reportPerf(name: string, durationMs: number, detail?: string) {
        log.info(`[perf] ${name}: ${durationMs.toFixed(1)}ms${detail ? ` (${detail})` : ''}`);
    }

    function refreshView() {
        treeProvider.refresh();
    }

    function loadHosts() {
        const startedAt = Date.now();
        const paths = getConfigPaths();
        log.info(`Loading SSH config from ${paths.length} path(s): ${paths.join(', ')}`);
        allHosts = [];
        for (const p of paths) {
            try {
                const fileStartedAt = Date.now();
                const content = fs.readFileSync(p, 'utf-8');
                const readMs = Date.now() - fileStartedAt;
                const parseStartedAt = Date.now();
                const hosts = parseSSHConfig(content);
                const parseMs = Date.now() - parseStartedAt;
                log.info(`  ${p}: parsed ${hosts.length} host(s)`);
                reportPerf(
                    'sshConfig.readParse',
                    Date.now() - fileStartedAt,
                    `${hosts.length} host(s), ${content.length} byte(s), read ${readMs}ms, parse ${parseMs}ms`,
                );
                allHosts.push(...hosts);
            } catch (err: any) {
                log.warn(`  ${p}: failed to read — ${err.message}`);
            }
        }
        log.info(`Total hosts loaded: ${allHosts.length}`);
        reportPerf('data.loadHosts.total', Date.now() - startedAt, `${allHosts.length} host(s)`);
        treeProvider.load(allHosts);
    }

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

    function resolveContext(ctx?: any): { host?: SSHHost; folderPath?: string } {
        if (!ctx) { return {}; }
        const el = ctx as TreeElement;
        if (el.kind === 'host') {
            return { host: el.host };
        }
        if (el.kind === 'folder') {
            return { host: el.host, folderPath: el.folderPath };
        }
        if (ctx.hostName) {
            return {
                host: allHosts.find(h => h.name === ctx.hostName),
                folderPath: ctx.folderPath,
            };
        }
        return {};
    }

    function setTreeFilter(value: string) {
        treeProvider.setFilter(value);
        treeView.message = treeProvider.filterActive
            ? `Filtered: "${treeProvider.currentFilter}"`
            : undefined;
        vscode.commands.executeCommand('setContext', 'sshTargetsFilterActive', treeProvider.filterActive);
    }

    function showFilterInput() {
        const input = vscode.window.createInputBox();
        input.title = 'Filter SSH Targets';
        input.placeholder = 'Filter by host, hostname, user, or folder';
        input.value = treeProvider.currentFilter;
        input.prompt = treeProvider.filterActive
            ? 'The current filter remains visible in the SSH Targets view after this box closes.'
            : undefined;
        input.onDidChangeValue(value => setTreeFilter(value));
        input.onDidAccept(() => input.hide());
        input.onDidHide(() => input.dispose());
        input.show();
    }

    context.subscriptions.push(
        reg('sshTargets.connect', (ctx?: any) => {
            const { host, folderPath } = resolveContext(ctx);
            if (host) { openRemote(host, false, folderPath); }
        }),

        reg('sshTargets.connectNewWindow', (ctx?: any) => {
            const { host, folderPath } = resolveContext(ctx);
            if (host) { openRemote(host, true, folderPath); }
        }),

        reg('sshTargets.openTerminal', (ctx?: any) => {
            const { host, folderPath } = resolveContext(ctx);
            if (host) { openSshTerminal(host, folderPath); }
        }),

        reg('sshTargets.addFolder', async (ctx?: any) => {
            const { host } = resolveContext(ctx);
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
            const { host, folderPath } = resolveContext(ctx);
            if (host && folderPath) {
                await recentFolders.removeFolderForAliases(getHostAliases(host), folderPath);
                refreshView();
            }
        }),

        reg('sshTargets.addFavorite', async (ctx?: any) => {
            const { host } = resolveContext(ctx);
            if (host) {
                await favorites.add(host.name);
                refreshView();
            }
        }),

        reg('sshTargets.removeFavorite', async (ctx?: any) => {
            const { host } = resolveContext(ctx);
            if (host) {
                await favorites.remove(host.name);
                refreshView();
            }
        }),

        reg('sshTargets.copyHostname', (ctx?: any) => {
            const { host } = resolveContext(ctx);
            if (host) {
                vscode.env.clipboard.writeText(host.hostname);
                vscode.window.showInformationMessage(`Copied: ${host.hostname}`);
            }
        }),

        reg('sshTargets.copySshCommand', (ctx?: any) => {
            const { host } = resolveContext(ctx);
            if (host) {
                const cmd = `ssh ${host.name}`;
                vscode.env.clipboard.writeText(cmd);
                vscode.window.showInformationMessage(`Copied: ${cmd}`);
            }
        }),

        reg('sshTargets.removeHost', async (ctx?: any) => {
            const { host } = resolveContext(ctx);
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

        reg('sshTargets.filter', () => showFilterInput()),

        reg('sshTargets.clearFilter', () => setTreeFilter('')),

        reg('sshTargets.showStorageLocation', async () => {
            const filePath = sharedFolders.location;
            const exists = fs.existsSync(filePath);
            if (!exists) {
                const choice = await vscode.window.showInformationMessage(
                    `Shared folder store not created yet: ${filePath}`,
                    'Reveal parent folder',
                );
                if (choice === 'Reveal parent folder') {
                    vscode.env.openExternal(vscode.Uri.file(path.dirname(filePath)));
                }
                return;
            }
            try {
                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch (err: any) {
                log.error(`Failed to open ${filePath}: ${err?.message ?? String(err)}`);
                vscode.window.showErrorMessage(`Failed to open ${filePath}: ${err?.message ?? String(err)}`);
            }
        }),
    );

    // --- Auto-record remote folders ---

    async function recordRemoteFolderUri(uri: vscode.Uri, source: string): Promise<boolean> {
        if (uri.scheme !== 'vscode-remote') { return false; }
        const match = uri.authority.match(/^ssh-remote\+(.+)$/);
        if (!match) { return false; }
        const remoteHostName = parseRemoteAuthorityHost(match[1]);
        const hostName = resolveConfigHostName(remoteHostName);
        const folderPath = uri.path;
        if (!hostName || !folderPath || folderPath === '/') { return false; }
        log.info(`Auto-recording remote folder from ${source}: ${remoteHostName} -> ${hostName}:${folderPath}`);
        await recentFolders.addFolder(hostName, folderPath);
        return true;
    }

    async function recordRemoteFolders() {
        const wsFolders = vscode.workspace.workspaceFolders;
        if (!wsFolders || wsFolders.length === 0) { return; }
        let recorded = false;
        for (const ws of wsFolders) {
            recorded = await recordRemoteFolderUri(ws.uri, 'workspace') || recorded;
        }
        if (recorded) { refreshView(); }
    }

    async function importRecentlyOpenedRemoteFolders() {
        let recentlyOpened: unknown;
        try {
            recentlyOpened = await vscode.commands.executeCommand('_workbench.getRecentlyOpened');
        } catch (err: any) {
            log.debug(`importRecentlyOpenedRemoteFolders: unavailable — ${err?.message ?? String(err)}`);
            return;
        }

        const uris = collectRecentlyOpenedFolderUris(recentlyOpened);
        let recorded = false;
        for (const uri of uris) {
            recorded = await recordRemoteFolderUri(uri, 'recently opened') || recorded;
        }
        if (recorded) { refreshView(); }
    }

    function resolveConfigHostName(remoteHostName: string): string {
        const remoteLower = remoteHostName.toLowerCase();
        const matched = allHosts.find(h =>
            h.name.toLowerCase() === remoteLower ||
            h.hostname.toLowerCase() === remoteLower,
        );
        return matched?.name ?? remoteHostName;
    }

    loadHosts();
    void recordRemoteFolders();
    void importRecentlyOpenedRemoteFolders();
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => { void recordRemoteFolders(); }),
    );

    vscode.commands.executeCommand('setContext', 'sshTargetsFilterActive', false);
    reportPerf('extension.activate', Date.now() - activateStartedAt, `${allHosts.length} host(s)`);
}

function parseRemoteAuthorityHost(value: string): string {
    const decoded = decodeURIComponent(value);
    const jsonHost = parseHexJsonHostName(decoded);
    return jsonHost ?? decoded;
}

function parseHexJsonHostName(value: string): string | undefined {
    if (!/^[\da-f]+$/i.test(value) || value.length % 2 !== 0) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(Buffer.from(value, 'hex').toString('utf8')) as { hostName?: unknown };
        return typeof parsed.hostName === 'string' && parsed.hostName ? parsed.hostName : undefined;
    } catch {
        return undefined;
    }
}

function collectRecentlyOpenedFolderUris(value: unknown): vscode.Uri[] {
    const result: vscode.Uri[] = [];
    if (!isRecord(value)) { return result; }
    const workspaces = value.workspaces;
    if (!Array.isArray(workspaces)) { return result; }

    for (const entry of workspaces) {
        if (!isRecord(entry)) { continue; }
        const folderUri = uriFromUnknown(entry.folderUri);
        if (folderUri) {
            result.push(folderUri);
            continue;
        }

        const workspace = entry.workspace;
        if (isRecord(workspace)) {
            const configPath = uriFromUnknown(workspace.configPath);
            if (configPath) { result.push(configPath); }
        }
    }

    return result;
}

function uriFromUnknown(value: unknown): vscode.Uri | undefined {
    if (value instanceof vscode.Uri) {
        return value;
    }
    if (typeof value === 'string') {
        return vscode.Uri.parse(value);
    }
    if (isRecord(value)) {
        const external = value.external;
        if (typeof external === 'string') {
            return vscode.Uri.parse(external);
        }
        const scheme = value.scheme;
        const authority = value.authority;
        const pathValue = value.path;
        if (typeof scheme === 'string' && typeof authority === 'string' && typeof pathValue === 'string') {
            return vscode.Uri.from({ scheme, authority, path: pathValue });
        }
    }
    return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
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

function openSshTerminal(host: SSHHost, folderPath?: string) {
    const args = folderPath
        ? ['-t', host.name, `cd ${quotePosixPath(folderPath)} && exec "\${SHELL:-/bin/sh}" -l`]
        : [host.name];
    log.info(`openSshTerminal: ssh ${args.join(' ')}`);
    try {
        const term = vscode.window.createTerminal({
            name: folderPath ? `SSH: ${host.name}:${folderPath}` : `SSH: ${host.name}`,
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

function quotePosixPath(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
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

function maybeAnnounceMigration(
    context: vscode.ExtensionContext,
    result: { migrated: number; storePath: string },
) {
    if (result.migrated <= 0) { return; }
    if (context.globalState.get<boolean>(MIGRATION_NOTICE_KEY, false)) { return; }
    log.info(`Migrated ${result.migrated} folder record(s) to shared store at ${result.storePath}`);
    const message =
        `SSH Targets Manager: migrated ${result.migrated} folder record(s) from this editor's ` +
        `local storage to ${result.storePath}. This file is now shared with all editors ` +
        `(Cursor, Trae, VS Code, …) — open each editor once to merge its history.`;
    vscode.window
        .showInformationMessage(message, 'Open file')
        .then(choice => {
            if (choice === 'Open file') {
                vscode.workspace.openTextDocument(result.storePath).then(
                    doc => vscode.window.showTextDocument(doc, { preview: true }),
                    (err: any) => log.error(`Failed to open ${result.storePath}: ${err?.message ?? String(err)}`),
                );
            }
        });
    context.globalState.update(MIGRATION_NOTICE_KEY, true).then(
        () => { /* no-op */ },
        () => { /* best-effort */ },
    );
}
