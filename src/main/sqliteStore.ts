import { isPackaged, getAppPath, getUserDataPath, getResourcesPath } from './libs/platformAdapter';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import initSqlJs, { Database, SqlJsStatic } from 'sql.js';
import { DB_FILENAME } from './appConstants';

type ChangePayload<T = unknown> = {
  key: string;
  newValue: T | undefined;
  oldValue: T | undefined;
};

const USER_MEMORIES_MIGRATION_KEY = 'userMemories.migration.v1.completed';

// Pre-read the sql.js WASM binary from disk.
// Using fs.readFileSync (which handles non-ASCII paths via Windows wide-char APIs)
// and passing the buffer directly to initSqlJs bypasses Emscripten's file loading,
// which can fail or hang when the install path contains Chinese characters on Windows.
function loadWasmBinary(): ArrayBuffer | undefined {
  // Every candidate the sidecar might see across (Electron prod, Electron
  // dev, Tauri prod on Windows, Tauri prod on macOS, Tauri dev). Ordered by
  // likelihood so the common cases short-circuit fast. Kept exhaustive
  // because a missing WASM crashes SqliteStore.create() which takes the
  // entire sidecar down and the user just sees "sidecar unreachable".
  const exeDir = path.dirname(process.execPath);
  const resourcesDir = getResourcesPath();
  const candidates = [
    // ── Electron packaged (app.asar.unpacked path) ─────────────────
    isPackaged() ? path.join(resourcesDir, 'app.asar.unpacked/node_modules/sql.js/dist/sql-wasm.wasm') : '',
    // ── Electron dev ───────────────────────────────────────────────
    path.join(getAppPath(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
    // ── Tauri packaged (all OSes) ──────────────────────────────────
    // prepare-tauri-resources.js puts sql-wasm.wasm at
    // src-tauri/resources/sql-wasm.wasm and tauri.conf.json globs it in
    // via "resources": ["resources/**/*"]. Tauri preserves the relative
    // path, so on disk the file lands inside a nested resources/ dir
    // under the platform's resource root.
    //
    //   Windows (NSIS): install-dir/resources/sql-wasm.wasm
    //   macOS  (.app):  NoobClaw.app/Contents/Resources/resources/sql-wasm.wasm
    //
    // getResourcesPath() walks its candidate list and returns:
    //   Windows: install-dir/resources
    //   macOS:   NoobClaw.app/Contents/Resources
    // So we need BOTH `resourcesDir/sql-wasm.wasm` (Windows — one-level
    // nesting already walked) AND `resourcesDir/resources/sql-wasm.wasm`
    // (macOS — we're one level above the nested dir).
    path.join(resourcesDir, 'sql-wasm.wasm'),
    path.join(resourcesDir, 'resources', 'sql-wasm.wasm'),
    // ── macOS .app layout — explicit path from the sidecar exe ─────
    // Belt-and-braces in case getResourcesPath's candidate walker ever
    // returns a different parent. Sidecar sits at .app/Contents/MacOS/
    // and Resources is a sibling of MacOS.
    path.join(exeDir, '..', 'Resources', 'resources', 'sql-wasm.wasm'),
    path.join(exeDir, '..', 'Resources', 'sql-wasm.wasm'),
    // ── Tauri sidecar fallbacks — next to the binary ───────────────
    path.join(exeDir, 'resources', 'sql-wasm.wasm'),
    path.join(exeDir, 'sql-wasm.wasm'),
    path.join(exeDir, 'binaries', 'sql-wasm.wasm'),
    // ── Tauri dev — cwd-relative ───────────────────────────────────
    path.join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
  ].filter(Boolean);

  const tried: string[] = [];
  for (const wasmPath of candidates) {
    tried.push(wasmPath);
    try {
      if (fs.existsSync(wasmPath)) {
        const buf = fs.readFileSync(wasmPath);
        console.log(`[SqliteStore] Loaded sql-wasm.wasm from ${wasmPath}`);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      }
    } catch {}
  }
  // Log the candidates so we can diagnose missing-WASM crashes from the
  // sidecar stdout captured by Tauri.
  console.error('[SqliteStore] sql-wasm.wasm not found. Tried:\n  ' + tried.join('\n  '));
  return undefined;
}

export class SqliteStore {
  private db: Database;
  private dbPath: string;
  private emitter = new EventEmitter();
  private static sqlPromise: Promise<SqlJsStatic> | null = null;

  private constructor(db: Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  static async create(userDataPath?: string): Promise<SqliteStore> {
    const basePath = userDataPath ?? getUserDataPath();
    const dbPath = path.join(basePath, DB_FILENAME);

    // Initialize SQL.js with WASM file path (cached promise for reuse)
    if (!SqliteStore.sqlPromise) {
      const wasmBinary = loadWasmBinary();
      console.log(`[SqliteStore] WASM binary ${wasmBinary ? `found (${wasmBinary.byteLength} bytes)` : 'NOT found, using fallback'}`);
      SqliteStore.sqlPromise = wasmBinary
        ? initSqlJs({ wasmBinary })
        : initSqlJs();  // Let sql.js find WASM on its own (sidecar mode)
    }
    const SQL = await SqliteStore.sqlPromise;
    console.log(`[SqliteStore] sql.js initialized, dbPath=${dbPath}, exists=${fs.existsSync(dbPath)}`);

    // Load existing database or create new one
    let db: Database;
    if (fs.existsSync(dbPath)) {
      const buffer = fs.readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } else {
      db = new SQL.Database();
    }

    const store = new SqliteStore(db, dbPath);
    store.initializeTables(basePath);
    return store;
  }

  private initializeTables(basePath: string) {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // Create cowork tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'idle',
        pinned INTEGER NOT NULL DEFAULT 0,
        cwd TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        execution_mode TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        sequence INTEGER,
        FOREIGN KEY (session_id) REFERENCES cowork_sessions(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cowork_messages_session_id ON cowork_messages(session_id);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS cowork_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.75,
        is_explicit INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'created',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS user_memory_sources (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        session_id TEXT,
        message_id TEXT,
        role TEXT NOT NULL DEFAULT 'system',
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES user_memories(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memories_status_updated_at
      ON user_memories(status, updated_at DESC);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memories_fingerprint
      ON user_memories(fingerprint);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_session_id
      ON user_memory_sources(session_id, is_active);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_user_memory_sources_memory_id
      ON user_memory_sources(memory_id, is_active);
    `);

    // Create scheduled tasks tables
    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_json TEXT NOT NULL,
        prompt TEXT NOT NULL,
        working_directory TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        execution_mode TEXT NOT NULL DEFAULT 'auto',
        expires_at TEXT,
        notify_platforms_json TEXT NOT NULL DEFAULT '[]',
        next_run_at_ms INTEGER,
        last_run_at_ms INTEGER,
        last_status TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        running_at_ms INTEGER,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run
        ON scheduled_tasks(enabled, next_run_at_ms);
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        trigger_type TEXT NOT NULL DEFAULT 'scheduled',
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
      );
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_task_runs_task_id
        ON scheduled_task_runs(task_id, started_at DESC);
    `);

    // Create MCP servers table
    this.db.run(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        transport_type TEXT NOT NULL DEFAULT 'stdio',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // ── Cost records ────────────────────────────────────────────────
    // One row per API turn. Accumulated from the 'usage' event in
    // coworkRunner and used by WalletView to show daily / weekly
    // token consumption curves. No dollar conversion — we store raw
    // token counts and model name, the UI formats compactly.
    this.db.run(`
      CREATE TABLE IF NOT EXISTS cost_records (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cost_records_session
        ON cost_records(session_id, created_at DESC);
    `);
    this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_cost_records_time
        ON cost_records(created_at DESC);
    `);

    // Migrations - safely add columns if they don't exist
    try {
      // Check if execution_mode column exists
      const colsResult = this.db.exec("PRAGMA table_info(cowork_sessions);");
      const columns = colsResult[0]?.values.map((row) => row[1]) || [];

      if (!columns.includes('execution_mode')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN execution_mode TEXT;');
        this.save();
      }

      if (!columns.includes('pinned')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;');
        this.save();
      }

      if (!columns.includes('active_skill_ids')) {
        this.db.run('ALTER TABLE cowork_sessions ADD COLUMN active_skill_ids TEXT;');
        this.save();
      }

      // Migration: Add sequence column to cowork_messages
      const msgColsResult = this.db.exec("PRAGMA table_info(cowork_messages);");
      const msgColumns = msgColsResult[0]?.values.map((row) => row[1]) || [];

      if (!msgColumns.includes('sequence')) {
        this.db.run('ALTER TABLE cowork_messages ADD COLUMN sequence INTEGER');

        // Assign sequence numbers to existing messages by created_at and ROWID
        this.db.run(`
          WITH numbered AS (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY session_id
              ORDER BY created_at ASC, ROWID ASC
            ) as seq
            FROM cowork_messages
          )
          UPDATE cowork_messages
          SET sequence = (SELECT seq FROM numbered WHERE numbered.id = cowork_messages.id)
        `);

        this.save();
      }
    } catch {
      // Column already exists or migration not needed.
    }

    try {
      this.db.run('UPDATE cowork_sessions SET pinned = 0 WHERE pinned IS NULL;');
    } catch {
      // Column might not exist yet.
    }

    try {
      this.db.run(`UPDATE cowork_sessions SET execution_mode = 'sandbox' WHERE execution_mode = 'container';`);
      this.db.run(`
        UPDATE cowork_config
        SET value = 'sandbox'
        WHERE key = 'executionMode' AND value = 'container';
      `);
    } catch (error) {
      console.warn('Failed to migrate cowork execution mode:', error);
    }

    // Migration: Add expires_at and notify_platforms_json columns to scheduled_tasks
    try {
      const stColsResult = this.db.exec("PRAGMA table_info(scheduled_tasks);");
      if (stColsResult[0]) {
        const stColumns = stColsResult[0].values.map((row) => row[1]) || [];

        if (!stColumns.includes('expires_at')) {
          this.db.run('ALTER TABLE scheduled_tasks ADD COLUMN expires_at TEXT');
          this.save();
        }

        if (!stColumns.includes('notify_platforms_json')) {
          this.db.run("ALTER TABLE scheduled_tasks ADD COLUMN notify_platforms_json TEXT NOT NULL DEFAULT '[]'");
          this.save();
        }
      }
    } catch {
      // Migration not needed or table doesn't exist yet.
    }

    this.migrateLegacyMemoryFileToUserMemories();
    this.migrateFromElectronStore(basePath);
    this.save();
  }

  save() {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(this.dbPath, buffer);
  }

  onDidChange<T = unknown>(key: string, callback: (newValue: T | undefined, oldValue: T | undefined) => void) {
    const handler = (payload: ChangePayload<T>) => {
      if (payload.key !== key) return;
      callback(payload.newValue, payload.oldValue);
    };
    this.emitter.on('change', handler);
    return () => this.emitter.off('change', handler);
  }

  get<T = unknown>(key: string): T | undefined {
    const result = this.db.exec('SELECT value FROM kv WHERE key = ?', [key]);
    if (!result[0]?.values[0]) return undefined;
    const value = result[0].values[0][0] as string;
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      console.warn(`Failed to parse store value for ${key}`, error);
      return undefined;
    }
  }

  set<T = unknown>(key: string, value: T): void {
    const oldValue = this.get<T>(key);
    const now = Date.now();
    this.db.run(`
      INSERT INTO kv (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `, [key, JSON.stringify(value), now]);
    this.save();
    this.emitter.emit('change', { key, newValue: value, oldValue } as ChangePayload<T>);
  }

  delete(key: string): void {
    const oldValue = this.get(key);
    this.db.run('DELETE FROM kv WHERE key = ?', [key]);
    this.save();
    this.emitter.emit('change', { key, newValue: undefined, oldValue } as ChangePayload);
  }

  // Expose database for cowork operations
  getDatabase(): Database {
    return this.db;
  }

  // Expose save method for external use (e.g., CoworkStore)
  getSaveFunction(): () => void {
    return () => this.save();
  }

  private tryReadLegacyMemoryText(): string {
    const candidates = [
      path.join(process.cwd(), 'MEMORY.md'),
      path.join(getAppPath(), 'MEMORY.md'),
      path.join(process.cwd(), 'memory.md'),
      path.join(getAppPath(), 'memory.md'),
    ];

    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return fs.readFileSync(candidate, 'utf8');
        }
      } catch {
        // Skip unreadable candidates.
      }
    }
    return '';
  }

  private parseLegacyMemoryEntries(raw: string): string[] {
    const normalized = raw.replace(/```[\s\S]*?```/g, ' ');
    const lines = normalized.split(/\r?\n/);
    const entries: string[] = [];
    const seen = new Set<string>();

    for (const line of lines) {
      const match = line.trim().match(/^-+\s*(?:\[[^\]]+\]\s*)?(.+)$/);
      if (!match?.[1]) continue;
      const text = match[1].replace(/\s+/g, ' ').trim();
      if (!text || text.length < 6) continue;
      if (/^\(empty\)$/i.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(text.length > 360 ? `${text.slice(0, 359)}…` : text);
    }

    return entries.slice(0, 200);
  }

  private memoryFingerprint(text: string): string {
    const normalized = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return crypto.createHash('sha1').update(normalized).digest('hex');
  }

  private migrateLegacyMemoryFileToUserMemories(): void {
    if (this.get<string>(USER_MEMORIES_MIGRATION_KEY) === '1') {
      return;
    }

    const content = this.tryReadLegacyMemoryText();
    if (!content.trim()) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const entries = this.parseLegacyMemoryEntries(content);
    if (entries.length === 0) {
      this.set(USER_MEMORIES_MIGRATION_KEY, '1');
      return;
    }

    const now = Date.now();
    this.db.run('BEGIN TRANSACTION;');
    try {
      for (const text of entries) {
        const fingerprint = this.memoryFingerprint(text);
        const existing = this.db.exec(
          `SELECT id FROM user_memories WHERE fingerprint = ? AND status != 'deleted' LIMIT 1`,
          [fingerprint]
        );
        if (existing[0]?.values?.[0]?.[0]) {
          continue;
        }

        const memoryId = crypto.randomUUID();
        this.db.run(`
          INSERT INTO user_memories (
            id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
          ) VALUES (?, ?, ?, ?, 1, 'created', ?, ?, NULL)
        `, [memoryId, text, fingerprint, 0.9, now, now]);

        this.db.run(`
          INSERT INTO user_memory_sources (id, memory_id, session_id, message_id, role, is_active, created_at)
          VALUES (?, ?, NULL, NULL, 'system', 1, ?)
        `, [crypto.randomUUID(), memoryId, now]);
      }

      this.db.run('COMMIT;');
    } catch (error) {
      this.db.run('ROLLBACK;');
      console.warn('Failed to migrate legacy MEMORY.md entries:', error);
    }

    this.set(USER_MEMORIES_MIGRATION_KEY, '1');
  }

  private migrateFromElectronStore(userDataPath: string) {
    const result = this.db.exec('SELECT COUNT(*) as count FROM kv');
    const count = result[0]?.values[0]?.[0] as number;
    if (count > 0) return;

    const legacyPath = path.join(userDataPath, 'config.json');
    if (!fs.existsSync(legacyPath)) return;

    try {
      const raw = fs.readFileSync(legacyPath, 'utf8');
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (!data || typeof data !== 'object') return;

      const entries = Object.entries(data);
      if (!entries.length) return;

      const now = Date.now();
      this.db.run('BEGIN TRANSACTION;');
      try {
        entries.forEach(([key, value]) => {
          this.db.run(`
            INSERT INTO kv (key, value, updated_at)
            VALUES (?, ?, ?)
          `, [key, JSON.stringify(value), now]);
        });
        this.db.run('COMMIT;');
        this.save();
        console.info(`Migrated ${entries.length} entries from electron-store.`);
      } catch (error) {
        this.db.run('ROLLBACK;');
        throw error;
      }
    } catch (error) {
      console.warn('Failed to migrate electron-store data:', error);
    }
  }
}
