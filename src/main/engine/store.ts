import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DownloadRecord, DownloadState, MediaSpec, Settings } from '../../shared/types';

export interface DownloadStore {
  loadAll(): DownloadRecord[];
  upsert(record: DownloadRecord): void;
  delete(id: string): void;
  loadSettings(): Partial<Settings>;
  saveSettings(settings: Settings): void;
  close(): void;
}


/** SQLite-backed store using Node's built-in `node:sqlite` (no native addon needed). */
export class SqliteStore implements DownloadStore {
  private db: DatabaseSync;
  private upsertStmt: StatementSync;
  private closed = false;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
      const check = this.db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
      if (check?.quick_check !== 'ok') throw new CorruptDatabaseError(`integrity check failed: ${check?.quick_check}`);
      this.migrate();
    } catch (e) {
      // Release the file handle so the caller can move a damaged file aside.
      this.db.close();
      throw isCorruption(e) ? new CorruptDatabaseError((e as Error).message) : e;
    }
    this.upsertStmt = this.db.prepare(`
      INSERT INTO downloads (id, kind, url, final_url, file_name, directory, file_name_settled, state, total_bytes,
        downloaded_bytes, resumable, etag, last_modified, error, notice, created_at, updated_at, completed_at, media)
      VALUES (:id, :kind, :url, :finalUrl, :fileName, :directory, :fileNameSettled, :state, :totalBytes,
        :downloadedBytes, :resumable, :etag, :lastModified, :error, :notice, :createdAt, :updatedAt, :completedAt, :media)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, url = excluded.url, final_url = excluded.final_url, file_name = excluded.file_name,
        directory = excluded.directory, file_name_settled = excluded.file_name_settled, state = excluded.state,
        total_bytes = excluded.total_bytes, downloaded_bytes = excluded.downloaded_bytes,
        resumable = excluded.resumable, etag = excluded.etag, last_modified = excluded.last_modified,
        error = excluded.error, notice = excluded.notice, updated_at = excluded.updated_at,
        completed_at = excluded.completed_at, media = excluded.media`);
  }

  /**
   * Brings the schema up to date one step at a time, each step in its own transaction, so a database
   * from any earlier version is upgraded in place without losing data. Steps only ever add columns
   * with defaults, so an older Haul can still open a newer database after a downgrade.
   */
  private migrate(): void {
    const version = () => (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const step = (to: number, sql: string) => {
      if (version() >= to) return;
      this.db.exec('BEGIN');
      try {
        this.db.exec(`${sql}; PRAGMA user_version = ${to};`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    };
    step(1, V1_SCHEMA);
    step(2, `ALTER TABLE downloads ADD COLUMN kind TEXT NOT NULL DEFAULT 'http'; ALTER TABLE downloads ADD COLUMN media TEXT`);
  }

  loadAll(): DownloadRecord[] {
    const rows = this.db.prepare('SELECT * FROM downloads ORDER BY created_at ASC').all() as Record<string, unknown>[];
    return rows.map(rowToRecord);
  }

  upsert(r: DownloadRecord): void {
    if (this.closed) return;
    this.upsertStmt.run({
      id: r.id,
      kind: r.kind,
      url: r.url,
      finalUrl: r.finalUrl,
      fileName: r.fileName,
      directory: r.directory,
      fileNameSettled: r.fileNameSettled ? 1 : 0,
      state: r.state,
      totalBytes: r.totalBytes,
      downloadedBytes: r.downloadedBytes,
      resumable: r.resumable === null ? null : r.resumable ? 1 : 0,
      etag: r.etag,
      lastModified: r.lastModified,
      error: r.error,
      notice: r.notice,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      completedAt: r.completedAt,
      media: r.media ? JSON.stringify(r.media) : null,
    });
  }

  delete(id: string): void {
    if (this.closed) return;
    this.db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  }

  loadSettings(): Partial<Settings> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, unknown> = {};
    for (const { key, value } of rows) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        /* ignore corrupt value; defaults apply */
      }
    }
    return out as Partial<Settings>;
  }

  saveSettings(settings: Settings): void {
    if (this.closed) return;
    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.db.exec('BEGIN');
    try {
      for (const [k, v] of Object.entries(settings)) stmt.run(k, JSON.stringify(v));
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

/** Schema of version 1 (Haul 1.0.x). Never change it: later versions add steps in `migrate()`. */
const V1_SCHEMA = `
      CREATE TABLE IF NOT EXISTS downloads (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        final_url TEXT,
        file_name TEXT NOT NULL,
        directory TEXT NOT NULL,
        file_name_settled INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        total_bytes INTEGER,
        downloaded_bytes INTEGER NOT NULL DEFAULT 0,
        resumable INTEGER,
        etag TEXT,
        last_modified TEXT,
        error TEXT,
        notice TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS downloads_created ON downloads(created_at);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

/** The database file exists but is not a readable SQLite database (damaged, truncated or overwritten). */
export class CorruptDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptDatabaseError';
  }
}

const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

function isCorruption(e: unknown): boolean {
  if (e instanceof CorruptDatabaseError) return true;
  const err = e as { errcode?: number; message?: string };
  return err?.errcode === SQLITE_CORRUPT || err?.errcode === SQLITE_NOTADB || /malformed|not a database/i.test(err?.message ?? '');
}

/**
 * Opens the store. A damaged database is moved aside (kept for inspection, never deleted) and a new,
 * empty one is created, so a corrupt file cannot stop the app from starting. Other errors, such as
 * the file being locked or the folder not being writable, are thrown.
 */
export function openStore(file: string): { store: SqliteStore; quarantined: string | null } {
  try {
    return { store: new SqliteStore(file), quarantined: null };
  } catch (e) {
    if (!(e instanceof CorruptDatabaseError)) throw e;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantined = `${file}.corrupt-${stamp}`;
    fs.renameSync(file, quarantined);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, quarantined + suffix);
    }
    return { store: new SqliteStore(file), quarantined };
  }
}

const STATES: DownloadState[] = ['queued', 'downloading', 'paused', 'completed', 'failed', 'cancelled'];

function rowToRecord(row: Record<string, unknown>): DownloadRecord {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  const state = String(row.state) as DownloadState;
  let media: MediaSpec | null = null;
  if (typeof row.media === 'string') {
    try {
      media = JSON.parse(row.media) as MediaSpec;
    } catch {
      media = null;
    }
  }
  // A media download whose details are unreadable cannot be resumed; it shows up as failed.
  const kind = row.kind === 'media' ? 'media' : 'http';
  const unusable = kind === 'media' && !media && state !== 'completed' && state !== 'cancelled';
  return {
    id: String(row.id),
    kind,
    media,
    url: String(row.url),
    finalUrl: str(row.final_url),
    fileName: String(row.file_name),
    directory: String(row.directory),
    fileNameSettled: Number(row.file_name_settled) === 1,
    state: unusable ? 'failed' : STATES.includes(state) ? state : 'failed',
    totalBytes: num(row.total_bytes),
    downloadedBytes: Number(row.downloaded_bytes ?? 0),
    resumable: row.resumable === null || row.resumable === undefined ? null : Number(row.resumable) === 1,
    etag: str(row.etag),
    lastModified: str(row.last_modified),
    error: unusable ? 'The details of this video download were damaged. Remove it and add the link again.' : str(row.error),
    notice: str(row.notice),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: num(row.completed_at),
  };
}
