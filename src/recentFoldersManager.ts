import * as vscode from 'vscode';

const STORAGE_KEY = 'sshTargets.recentFolders';

export class RecentFoldersManager {
    constructor(private state: vscode.Memento) {}

    getFolders(hostName: string): string[] {
        const all = this.state.get<Record<string, string[]>>(STORAGE_KEY, {});
        return all[hostName] ?? [];
    }

    async addFolder(hostName: string, folderPath: string): Promise<void> {
        const all = this.state.get<Record<string, string[]>>(STORAGE_KEY, {});
        const folders = all[hostName] ?? [];
        const normalized = folderPath.replace(/\/+$/, '') || '/';
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

    hasFolders(hostName: string): boolean {
        return this.getFolders(hostName).length > 0;
    }
}
