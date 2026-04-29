import * as fs from 'fs';

export interface SSHHost {
    name: string;
    hostname: string;
    user?: string;
    port?: number;
    rawConfig: Record<string, string>;
}

export function parseSSHConfig(content: string): SSHHost[] {
    const hosts: SSHHost[] = [];
    const lines = content.split(/\r?\n/);

    let current: { name: string; raw: Record<string, string> } | null = null;
    let inMatchBlock = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('#') || !trimmed) { continue; }

        if (/^match\s/i.test(trimmed)) {
            if (current) { hosts.push(buildHost(current)); current = null; }
            inMatchBlock = true;
            continue;
        }

        const kv = trimmed.match(/^(\S+)\s+(.*\S)/);
        if (!kv) { continue; }
        const [, key, value] = kv;

        if (key.toLowerCase() === 'host') {
            if (current) { hosts.push(buildHost(current)); }
            inMatchBlock = false;

            if (value.includes('*') || value.includes('?') || value.includes('!')) {
                current = null;
                continue;
            }
            current = { name: value, raw: {} };
        } else if (current && !inMatchBlock) {
            current.raw[key.toLowerCase()] = value;
        }
    }

    if (current) { hosts.push(buildHost(current)); }
    return hosts;
}

function buildHost(entry: { name: string; raw: Record<string, string> }): SSHHost {
    return {
        name: entry.name,
        hostname: entry.raw['hostname'] || entry.name,
        user: entry.raw['user'],
        port: entry.raw['port'] ? parseInt(entry.raw['port'], 10) : undefined,
        rawConfig: entry.raw,
    };
}

export function readAndParse(configPath: string): SSHHost[] {
    const content = fs.readFileSync(configPath, 'utf-8');
    return parseSSHConfig(content);
}
