import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const FILE_NAME = '.ssh-targets-folders.json';
const SCHEMA_VERSION = 1;

export interface SharedFolderEntry {
    host: string;
    folder: string;
    lastUsed: number;
}

interface SharedFolderFile {
    version: number;
    folders: SharedFolderEntry[];
}

function normalizeFolder(folder: string): string {
    return folder.replace(/\/+$/, '') || '/';
}

function dedupKey(host: string, folder: string): string {
    return `${host.toLowerCase()}\0${normalizeFolder(folder).toLowerCase()}`;
}

/**
 * SharedFolderStore persists the recent-folder list in a single JSON file under
 * ~/.ssh/ so that all editors (Cursor, Trae, VS Code, …) share the same data.
 *
 * Edge cases handled:
 *  - ~/.ssh missing on first write -> mkdir -p
 *  - file missing / empty / non-file -> treated as "no data", no error
 *  - file corrupted -> backed up to *.corrupted-<ts> and a fresh store is used
 *  - permission denied on read or write -> logged, callers fall back to in-memory only
 *  - schema version mismatch -> logged, existing entries are still loaded
 *  - concurrent writes within the same extension instance -> serialized via a write queue
 *  - atomic disk write via tmp + rename, file mode 0600
 */
export class SharedFolderStore {
    private entries: Map<string, SharedFolderEntry> = new Map();
    private readonly filePath: string;
    private writeQueue: Promise<void> = Promise.resolve();
    private flushFailureLogged = false;
    private readonly log: vscode.LogOutputChannel;

    constructor(log: vscode.LogOutputChannel) {
        this.log = log;
        this.filePath = path.join(os.homedir(), '.ssh', FILE_NAME);
    }

    get location(): string {
        return this.filePath;
    }

    size(): number {
        return this.entries.size;
    }

    load(): SharedFolderEntry[] {
        for (const e of this.loadFromDisk()) {
            this.entries.set(dedupKey(e.host, e.folder), e);
        }
        return this.snapshot();
    }

    /**
     * Merge in entries from another source (e.g., this editor's legacy globalState,
     * or `_workbench.getRecentlyOpened`). Dedup is by (host, folder) — when both
     * sources have the same key, the entry with the larger lastUsed wins.
     */
    merge(entries: Array<{ host: string; folder: string; lastUsed?: number }>): { added: number; updated: number } {
        let added = 0;
        let updated = 0;
        for (const e of entries) {
            if (!e || typeof e.host !== 'string' || typeof e.folder !== 'string') { continue; }
            const folder = normalizeFolder(e.folder);
            const key = dedupKey(e.host, folder);
            const lastUsed = typeof e.lastUsed === 'number' && Number.isFinite(e.lastUsed) ? e.lastUsed : 0;
            const incoming: SharedFolderEntry = { host: e.host, folder, lastUsed };
            const existing = this.entries.get(key);
            if (!existing) {
                this.entries.set(key, incoming);
                added++;
            } else if (lastUsed > existing.lastUsed) {
                this.entries.set(key, incoming);
                updated++;
            }
        }
        return { added, updated };
    }

    upsert(host: string, folder: string, lastUsed: number = Date.now()): void {
        const normalized = normalizeFolder(folder);
        this.entries.set(dedupKey(host, normalized), { host, folder: normalized, lastUsed });
    }

    remove(host: string, folder: string): boolean {
        return this.entries.delete(dedupKey(host, normalizeFolder(folder)));
    }

    getFolders(host: string): string[] {
        return Array.from(this.entries.values())
            .filter(e => e.host === host)
            .sort((a, b) => b.lastUsed - a.lastUsed)
            .map(e => e.folder);
    }

    getFoldersForAliases(hostNames: string[]): string[] {
        const aliasesLower = new Set(
            hostNames.filter(h => typeof h === 'string' && h.length > 0).map(h => h.toLowerCase()),
        );
        if (aliasesLower.size === 0) { return []; }
        const seen = new Set<string>();
        const folders: string[] = [];
        for (const e of this.snapshot()) {
            if (aliasesLower.has(e.host.toLowerCase()) && !seen.has(e.folder)) {
                seen.add(e.folder);
                folders.push(e.folder);
            }
        }
        return folders;
    }

    hasFolders(host: string): boolean {
        for (const e of this.entries.values()) {
            if (e.host === host) { return true; }
        }
        return false;
    }

    hasFoldersForAliases(hostNames: string[]): boolean {
        return this.getFoldersForAliases(hostNames).length > 0;
    }

    snapshot(): SharedFolderEntry[] {
        return Array.from(this.entries.values()).sort((a, b) => b.lastUsed - a.lastUsed);
    }

    async flush(): Promise<void> {
        this.writeQueue = this.writeQueue.then(() => {
            try {
                this.writeToDiskSync();
            } catch (err: any) {
                if (!this.flushFailureLogged) {
                    this.log.error(
                        `SharedFolderStore: ${err?.message ?? String(err)} (further flush failures will be suppressed until a write succeeds)`,
                    );
                    this.flushFailureLogged = true;
                }
                throw err;
            }
        }).catch(() => { /* keep queue alive */ });
        return this.writeQueue;
    }

    // --- internals ---

    private loadFromDisk(): SharedFolderEntry[] {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(this.filePath);
        } catch (err: any) {
            if (err?.code === 'ENOENT') {
                this.log.info(`SharedFolderStore: ${this.filePath} does not exist; starting with an empty store.`);
                return [];
            }
            this.log.error(`SharedFolderStore: failed to stat ${this.filePath} — ${err?.message ?? String(err)}`);
            return [];
        }

        if (!stat.isFile()) {
            this.log.warn(`SharedFolderStore: ${this.filePath} is not a regular file; ignoring.`);
            return [];
        }
        if (stat.size === 0) {
            this.log.info(`SharedFolderStore: ${this.filePath} is empty; treating as no data.`);
            return [];
        }

        let content: string;
        try {
            content = fs.readFileSync(this.filePath, 'utf-8');
        } catch (err: any) {
            this.log.error(`SharedFolderStore: failed to read ${this.filePath} — ${err?.message ?? String(err)}`);
            return [];
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(content);
        } catch (err: any) {
            this.log.error(`SharedFolderStore: ${this.filePath} is not valid JSON — ${err?.message ?? String(err)}`);
            this.backupCorrupted();
            return [];
        }

        if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as SharedFolderFile).folders)) {
            this.log.error(`SharedFolderStore: ${this.filePath} has invalid schema; expected { version, folders[] }.`);
            this.backupCorrupted();
            return [];
        }

        const obj = parsed as SharedFolderFile;
        if (obj.version !== SCHEMA_VERSION) {
            this.log.warn(
                `SharedFolderStore: schema version mismatch (file=${obj.version}, expected=${SCHEMA_VERSION}); loading data as-is.`,
            );
        }

        const valid: SharedFolderEntry[] = [];
        for (const e of obj.folders) {
            if (!e || typeof e.host !== 'string' || typeof e.folder !== 'string') { continue; }
            const lastUsed = typeof e.lastUsed === 'number' && Number.isFinite(e.lastUsed) ? e.lastUsed : 0;
            valid.push({ host: e.host, folder: normalizeFolder(e.folder), lastUsed });
        }
        this.log.info(`SharedFolderStore: loaded ${valid.length} entry/entries from ${this.filePath}`);
        return valid;
    }

    private backupCorrupted(): void {
        try {
            const backupPath = `${this.filePath}.corrupted-${Date.now()}`;
            fs.copyFileSync(this.filePath, backupPath);
            this.log.warn(`SharedFolderStore: backed up corrupted file to ${backupPath}`);
        } catch (err: any) {
            this.log.warn(`SharedFolderStore: failed to back up corrupted file — ${err?.message ?? String(err)}`);
        }
    }

    private writeToDiskSync(): void {
        const dir = path.dirname(this.filePath);
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch (err: any) {
            throw new Error(`Failed to ensure directory ${dir}: ${err?.message ?? String(err)}`);
        }

        const payload: SharedFolderFile = {
            version: SCHEMA_VERSION,
            folders: this.snapshot(),
        };
        const json = JSON.stringify(payload, null, 2);

        const tmpPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
        try {
            fs.writeFileSync(tmpPath, json, { encoding: 'utf-8', mode: 0o600 });
            fs.renameSync(tmpPath, this.filePath);
            this.flushFailureLogged = false;
            this.log.debug(`SharedFolderStore: wrote ${payload.folders.length} entry/entries to ${this.filePath}`);
        } catch (err: any) {
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            throw new Error(`Failed to write ${this.filePath}: ${err?.message ?? String(err)}`);
        }
    }
}
