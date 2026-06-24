import * as vscode from 'vscode';

const STORAGE_KEY = 'sshTargets.recentFolders';

export class RecentFoldersManager {
    constructor(private state: vscode.Memento) {}

    getFolders(hostName: string): string[] {
        const all = this.state.get<Record<string, string[]>>(STORAGE_KEY, {});
        return all[hostName] ?? [];
    }

    getFoldersForAliases(hostNames: string[]): string[] {
        const all = this.state.get<Record<string, string[]>>(STORAGE_KEY, {});
        const seen = new Set<string>();
        const folders: string[] = [];
        for (const hostName of unique(hostNames)) {
            for (const folder of all[hostName] ?? []) {
                if (!seen.has(folder)) {
                    seen.add(folder);
                    folders.push(folder);
                }
            }
        }
        return folders;
    }

    async addFolder(hostName: string, folderPath: string): Promise<void> {
        const all = this.state.get<Record<string, string[]>>(STORAGE_KEY, {});
        const folders = all[hostName] ?? [];
        const normalized = normalizeFolderPath(folderPath);
        const idx = folders.indexOf(normalized);
        if (idx >= 0) { folders.splice(idx, 1); }
        folders.unshift(normalized);
        all[hostName] = folders;
        await this.state.update(STORAGE_KEY, all);
    }

    async removeFolder(hostName: string, folderPath: string): Promise<void> {
        const all = this.state.get<Record<string, string[]>>(STORAGE_KEY, {});
        const folders = all[hostName] ?? [];
        const idx = folders.indexOf(folderPath);
        if (idx >= 0) {
            folders.splice(idx, 1);
            if (folders.length === 0) {
                delete all[hostName];
            } else {
                all[hostName] = folders;
            }
            await this.state.update(STORAGE_KEY, all);
        }
    }

    async removeFolderForAliases(hostNames: string[], folderPath: string): Promise<void> {
        const all = this.state.get<Record<string, string[]>>(STORAGE_KEY, {});
        const normalized = normalizeFolderPath(folderPath);
        let changed = false;
        for (const hostName of unique(hostNames)) {
            const folders = all[hostName];
            if (!folders) { continue; }
            const idx = folders.indexOf(normalized);
            if (idx < 0) { continue; }
            folders.splice(idx, 1);
            if (folders.length === 0) {
                delete all[hostName];
            } else {
                all[hostName] = folders;
            }
            changed = true;
        }
        if (changed) {
            await this.state.update(STORAGE_KEY, all);
        }
    }

    hasFolders(hostName: string): boolean {
        return this.getFolders(hostName).length > 0;
    }

    hasFoldersForAliases(hostNames: string[]): boolean {
        return this.getFoldersForAliases(hostNames).length > 0;
    }
}

function normalizeFolderPath(folderPath: string): string {
    return folderPath.replace(/\/+$/, '') || '/';
}

function unique(values: string[]): string[] {
    return [...new Set(values.filter(Boolean))];
}
