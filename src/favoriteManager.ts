import * as vscode from 'vscode';

const STORAGE_KEY = 'sshTargets.favorites';

export class FavoriteManager {
    private favs: Set<string>;

    constructor(private state: vscode.Memento) {
        this.favs = new Set(state.get<string[]>(STORAGE_KEY, []));
    }

    has(name: string): boolean {
        return this.favs.has(name);
    }

    getAll(): Set<string> {
        return new Set(this.favs);
    }

    async add(name: string) {
        this.favs.add(name);
        await this.persist();
    }

    async remove(name: string) {
        this.favs.delete(name);
        await this.persist();
    }

    private persist() {
        return this.state.update(STORAGE_KEY, [...this.favs]);
    }
}
