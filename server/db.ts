import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** better-sqlite3 wrapper with a D1-like prepare/bind/run/first/all/batch API. */
export class SqliteStatement {
  constructor(
    private readonly db: Database.Database,
    readonly sql: string,
    private readonly args: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values);
  }

  runSync(): D1Response {
    const stmt = this.db.prepare(this.sql);
    const result = stmt.run(...this.args);
    return {
      success: true,
      meta: {
        changes: result.changes,
        last_row_id: Number(result.lastInsertRowid),
        duration: 0,
        rows_read: 0,
        rows_written: result.changes,
        size_after: 0,
      },
      results: [],
    };
  }

  async run(): Promise<D1Response> {
    return this.runSync();
  }

  firstSync<T = unknown>(): T | null {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.args);
    return (row as T | undefined) ?? null;
  }

  async first<T = unknown>(): Promise<T | null> {
    return this.firstSync<T>();
  }

  allSync<T = unknown>(): D1Result<T> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.args) as T[];
    return { success: true, meta: {}, results: rows };
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    return this.allSync<T>();
  }
}

export class SqliteDatabase implements D1Database {
  private readonly db: Database.Database;
  readonly filePath: string;

  constructor(dbPath: string, schemaPath?: string) {
    this.filePath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    if (schemaPath && fs.existsSync(schemaPath)) {
      this.db.exec(fs.readFileSync(schemaPath, "utf8"));
    }
  }

  prepare(query: string): SqliteStatement {
    // 调用方须用 ? 占位 + bind；禁止把用户输入拼进 query 字符串
    return new SqliteStatement(this.db, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const tx = this.db.transaction(() => {
      const out: D1Result<T>[] = [];
      for (const stmt of statements) {
        const s = stmt as SqliteStatement;
        out.push(s.runSync() as D1Result<T>);
      }
      return out;
    });
    return tx();
  }

  close(): void {
    this.db.close();
  }

  /** Consistent online backup via better-sqlite3 (includes WAL into one .db file). */
  async backupTo(destPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await this.db.backup(destPath);
  }

  dbFilePath(): string {
    return this.filePath;
  }
}

export function createDatabase(dataDir: string, schemaPath: string): SqliteDatabase {
  const dbPath = path.join(dataDir, "ea-monitor.db");
  return new SqliteDatabase(dbPath, schemaPath);
}
