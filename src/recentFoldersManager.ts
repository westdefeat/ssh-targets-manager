import * as vscode from 'vscode';
import { SharedFolderStore } from './sharedFolderStore';

const LEGACY_KEY = 'sshTargets.recentFolders';

/**
 * Public API is unchanged from the previous globalState-backed implementation,
 * so the tree provider and command code keep working. Internally everything is
 * delegated to a single SharedFolderStore that lives at ~/.ssh/.
 *
 * On construction this migrates the legacy `sshTargets.recentFolders` value out
 * of the current editor's globalState into the shared file, then clears it so
 * the migration is one-shot. After that, every editor instance reads and
 * writes the same file.
 */
export class RecentFoldersManager {
    readonly migrationResult: { migrated: number; storePath: string };

    constructor(
        private state: vscode.Memento,
        private shared: SharedFolderStore,
    ) {
        this.migrationResult = this.migrateLegacy();
    }

    private migrateLegacy(): { migrated: number; storePath: string } {
        let legacy: Record<string, string[]> | undefined;
        try {
            legacy = this.state.get<Record<string, string[]>>(LEGACY_KEY, {});
        } catch (err: any) {
            // Defensive: a malformed entry shouldn't break activation.
            return { migrated: 0, storePath: this.shared.location };
        }
        if (!legacy || typeof legacy !== 'object') {
            return { migrated: 0, storePath: this.shared.location };
        }

        const entries: Array<{ host: string; folder: string }> = [];
        for (const [host, folders] of Object.entries(legacy)) {
            if (!Array.isArray(folders)) { continue; }
            for (const folder of folders) {
                if (typeof folder !== 'string' || folder.length === 0) { continue; }
                entries.push({ host, folder });
            }
        }
        if (entries.length === 0) {
            // No legacy data, but still reset the key in case it held a stray non-object value.
            this.state.update(LEGACY_KEY, {}).then(
                () => { /* no-op */ },
                () => { /* best-effort */ },
            );
            return { migrated: 0, storePath: this.shared.location };
        }

        const result = this.shared.merge(entries);

        // Clear the legacy key (best-effort). The merge above is idempotent,
        // so a failed clear just means the next activation re-applies the same merge.
        this.state.update(LEGACY_KEY, {}).then(
            () => { /* no-op */ },
            () => { /* best-effort */ },
        );

        return {
            migrated: result.added + result.updated,
            storePath: this.shared.location,
        };
    }

    getFolders(hostName: string): string[] {
        return this.shared.getFolders(hostName);
    }

    getFoldersForAliases(hostNames: string[]): string[] {
        return this.shared.getFoldersForAliases(hostNames);
    }

    async addFolder(hostName: string, folderPath: string): Promise<void> {
        this.shared.upsert(hostName, folderPath);
        await this.shared.flush();
    }

    async removeFolder(hostName: string, folderPath: string): Promise<void> {
        this.shared.remove(hostName, folderPath);
        await this.shared.flush();
    }

    async removeFolderForAliases(hostNames: string[], folderPath: string): Promise<void> {
        const seen = new Set<string>();
        for (const hostName of hostNames) {
            if (typeof hostName !== 'string' || hostName.length === 0 || seen.has(hostName)) { continue; }
            seen.add(hostName);
            this.shared.remove(hostName, folderPath);
        }
        await this.shared.flush();
    }

    hasFolders(hostName: string): boolean {
        return this.shared.hasFolders(hostName);
    }

    hasFoldersForAliases(hostNames: string[]): boolean {
        return this.shared.hasFoldersForAliases(hostNames);
    }
}
