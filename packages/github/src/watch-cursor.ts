import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RepoCursor {
  lastSeenAt: string;
  lastIssueNumber: number;
}

export interface DaemonState {
  schema: 'openslack.watch_cursor.v1';
  repos: Record<string, RepoCursor>;
}

const EMPTY_STATE: DaemonState = { schema: 'openslack.watch_cursor.v1', repos: {} };

export class WatchCursorStore {
  private stateDir: string;
  private cached: DaemonState | null = null;

  constructor(stateDir?: string) {
    this.stateDir = stateDir ?? join(process.cwd(), '.openslack.local', 'daemon');
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }

  private load(): DaemonState {
    if (this.cached) return this.cached;
    const path = join(this.stateDir, 'state.json');
    if (!existsSync(path)) {
      this.cached = { ...EMPTY_STATE, repos: {} };
      return this.cached;
    }
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as DaemonState;
      if (parsed.schema !== 'openslack.watch_cursor.v1') {
        this.cached = { ...EMPTY_STATE, repos: {} };
        return this.cached;
      }
      this.cached = parsed;
      return this.cached;
    } catch {
      this.cached = { ...EMPTY_STATE, repos: {} };
      return this.cached;
    }
  }

  private flush(): void {
    const state = this.load();
    const path = join(this.stateDir, 'state.json');
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  }

  getCursor(repoKey: string): RepoCursor | null {
    return this.load().repos[repoKey] ?? null;
  }

  updateCursor(repoKey: string, cursor: RepoCursor): void {
    const state = this.load();
    state.repos[repoKey] = cursor;
    this.flush();
  }

  getAllCursors(): Record<string, RepoCursor> {
    return { ...this.load().repos };
  }

  resetCursor(repoKey: string): void {
    const state = this.load();
    delete state.repos[repoKey];
    this.flush();
  }

  clearCache(): void {
    this.cached = null;
  }
}
