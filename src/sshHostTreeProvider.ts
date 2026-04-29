import * as vscode from 'vscode';
import { SSHHost } from './sshConfigParser';
import { FavoriteManager } from './favoriteManager';
import { RecentFoldersManager } from './recentFoldersManager';

export interface GroupNode {
    kind: 'group';
    label: string;
    children: SSHHost[];
    isFavorites: boolean;
}

export interface HostNode {
    kind: 'host';
    host: SSHHost;
    isFavorite: boolean;
}

export interface FolderNode {
    kind: 'folder';
    host: SSHHost;
    folderPath: string;
}

export type TreeElement = GroupNode | HostNode | FolderNode;

export class SSHHostTreeProvider implements vscode.TreeDataProvider<TreeElement> {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    private allHosts: SSHHost[] = [];
    private _filter = '';

    constructor(
        private favorites: FavoriteManager,
        private folders: RecentFoldersManager,
    ) {}

    load(hosts: SSHHost[]) {
        this.allHosts = hosts;
        this._onDidChange.fire();
    }

    setFilter(query: string) {
        this._filter = query.toLowerCase().trim();
        this._onDidChange.fire();
    }

    clearFilter() {
        this._filter = '';
        this._onDidChange.fire();
    }

    get filterActive(): boolean {
        return this._filter.length > 0;
    }

    get currentFilter(): string {
        return this._filter;
    }

    refresh() {
        this._onDidChange.fire();
    }

    getTreeItem(el: TreeElement): vscode.TreeItem {
        if (el.kind === 'group') {
            return this.buildGroupItem(el);
        }
        if (el.kind === 'folder') {
            return this.buildFolderItem(el);
        }
        return this.buildHostItem(el);
    }

    getChildren(el?: TreeElement): TreeElement[] {
        if (!el) {
            return this.buildRootGroups();
        }
        if (el.kind === 'group') {
            return el.children.map(h => ({
                kind: 'host' as const,
                host: h,
                isFavorite: this.favorites.has(h.name),
            }));
        }
        if (el.kind === 'host') {
            return this.folders.getFolders(el.host.name).map(p => ({
                kind: 'folder' as const,
                host: el.host,
                folderPath: p,
            }));
        }
        return [];
    }

    private buildGroupItem(g: GroupNode): vscode.TreeItem {
        const ti = new vscode.TreeItem(
            g.label,
            vscode.TreeItemCollapsibleState.Expanded,
        );
        ti.description = `${g.children.length}`;
        ti.iconPath = g.isFavorites
            ? new vscode.ThemeIcon('star-full')
            : new vscode.ThemeIcon('server-environment');
        ti.contextValue = 'sshGroup';
        return ti;
    }

    private buildHostItem(el: HostNode): vscode.TreeItem {
        const { host, isFavorite } = el;
        const hasFolders = this.folders.hasFolders(host.name);
        const state = hasFolders
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        const ti = new vscode.TreeItem(host.name, state);

        ti.tooltip = this.buildTooltip(host);
        ti.iconPath = new vscode.ThemeIcon('remote');
        ti.contextValue = isFavorite ? 'sshHostFavorite' : 'sshHost';

        return ti;
    }

    private buildFolderItem(f: FolderNode): vscode.TreeItem {
        const segments = f.folderPath.split('/').filter(Boolean);
        const label = segments.length > 0 ? segments[segments.length - 1] : '/';
        const ti = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        ti.description = f.folderPath;
        ti.iconPath = new vscode.ThemeIcon('folder');
        ti.contextValue = 'sshFolder';
        ti.tooltip = `${f.host.name}:${f.folderPath}`;
        return ti;
    }

    private buildTooltip(host: SSHHost): vscode.MarkdownString {
        const lines = [`**${host.name}**`, ''];
        lines.push(`Host: \`${host.hostname}\``);
        if (host.user) { lines.push(`User: \`${host.user}\``); }
        if (host.port) { lines.push(`Port: \`${host.port}\``); }
        for (const [k, v] of Object.entries(host.rawConfig)) {
            if (!['hostname', 'user', 'port'].includes(k)) {
                lines.push(`${k}: \`${v}\``);
            }
        }
        return new vscode.MarkdownString(lines.join('  \n'));
    }

    private buildRootGroups(): GroupNode[] {
        let hosts = this.allHosts;

        if (this._filter) {
            const q = this._filter;
            hosts = hosts.filter(h =>
                h.name.toLowerCase().includes(q) ||
                h.hostname.toLowerCase().includes(q) ||
                (h.user?.toLowerCase().includes(q) ?? false) ||
                this.folders.getFolders(h.name).some(f => f.toLowerCase().includes(q)),
            );
        }

        const groups: GroupNode[] = [];

        const favSet = this.favorites.getAll();
        const favHosts = hosts.filter(h => favSet.has(h.name));
        if (favHosts.length > 0) {
            groups.push({
                kind: 'group',
                label: 'Favorites',
                children: favHosts,
                isFavorites: true,
            });
        }

        const config = vscode.workspace.getConfiguration('sshTargetsManager');
        const customGroups: Record<string, string> = config.get('customGroups', {});
        const autoGroup: boolean = config.get('autoGroupBySubnet', true);

        if (Object.keys(customGroups).length > 0) {
            this.groupByCustomRules(hosts, customGroups, groups);
        } else if (autoGroup) {
            this.groupBySubnet(hosts, groups);
        } else {
            groups.push({
                kind: 'group',
                label: 'All Hosts',
                children: hosts,
                isFavorites: false,
            });
        }

        return groups;
    }

    private groupBySubnet(hosts: SSHHost[], out: GroupNode[]) {
        const buckets = new Map<string, SSHHost[]>();
        const other: SSHHost[] = [];

        for (const h of hosts) {
            const subnet = extractSubnet(h.hostname);
            if (subnet) {
                let arr = buckets.get(subnet);
                if (!arr) { arr = []; buckets.set(subnet, arr); }
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
            out.push({ kind: 'group', label: `${subnet}.x`, children, isFavorites: false });
        }

        if (other.length > 0) {
            out.push({ kind: 'group', label: 'Other', children: other, isFavorites: false });
        }
    }

    private groupByCustomRules(
        hosts: SSHHost[],
        rules: Record<string, string>,
        out: GroupNode[],
    ) {
        const compiled = Object.entries(rules).map(([name, pattern]) => ({
            name,
            re: new RegExp(pattern),
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
                out.push({ kind: 'group', label: name, children, isFavorites: false });
            }
        }

        if (other.length > 0) {
            out.push({ kind: 'group', label: 'Other', children: other, isFavorites: false });
        }
    }
}

function extractSubnet(hostname: string): string | null {
    const m = hostname.match(/^(\d+\.\d+\.\d+)\.\d+$/);
    return m ? m[1] : null;
}
