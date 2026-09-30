// Loop's SQLite store (the AHA pattern): one file in the state volume, WAL,
// numbered migrations applied in order under one write lock, and `tx` for
// every write. BEGIN IMMEDIATE takes the write lock up front, so the poll and
// an owner's DM turn writing at the same time queue instead of losing a write.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { home } from "./paths.ts";

export type Store = {
  db: DatabaseSync;
  tx<T>(fn: () => T): T;
  close(): void;
};

const BUSY_MS = 10_000;
const MIGRATIONS = join(import.meta.dirname, "migrations");

export function migrations(dir = MIGRATIONS): string[] {
  return readdirSync(dir).filter((name) => /^\d{3}_.+\.sql$/.test(name)).sort()
    .map((name) => readFileSync(join(dir, name), "utf8"));
}

function locked(error: unknown): boolean {
  const e = error as { errstr?: string; message?: string };
  return e.errstr === "database is locked" || /database is locked/.test(e.message ?? "");
}

function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function execWhenFree(db: DatabaseSync, sql: string): void {
  const deadline = Date.now() + BUSY_MS;
  for (;;) {
    try {
      db.exec(sql);
      return;
    } catch (error) {
      if (!locked(error) || Date.now() >= deadline) throw error;
      wait(20);
    }
  }
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // no open transaction
  }
}

function version(db: DatabaseSync): number {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  if (!table) return 0;
  const row = db.prepare("SELECT schema_version FROM meta").get() as { schema_version: number } | undefined;
  return row?.schema_version ?? 0;
}

function migrate(db: DatabaseSync, steps: string[]): void {
  execWhenFree(db, "BEGIN IMMEDIATE");
  try {
    let current = version(db);
    steps.forEach((sql, index) => {
      const next = index + 1;
      if (current >= next) return;
      db.exec(sql);
      if (db.prepare("SELECT 1 FROM meta").get()) db.prepare("UPDATE meta SET schema_version = ?").run(next);
      else db.prepare("INSERT INTO meta (schema_version) VALUES (?)").run(next);
      current = next;
    });
    db.exec("COMMIT");
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export function openStore(dir = home(), steps = migrations()): Store {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, "loop.db"), { timeout: BUSY_MS });
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
  execWhenFree(db, "PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Quotes from private mail are wiped for real when retention clears them.
  db.exec("PRAGMA secure_delete = ON");
  migrate(db, steps);
  // Nested tx calls join the outer transaction, so ledger functions compose.
  let depth = 0;
  return {
    db,
    tx(fn) {
      if (depth > 0) return fn();
      execWhenFree(db, "BEGIN IMMEDIATE");
      depth++;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        rollback(db);
        throw error;
      } finally {
        depth--;
      }
    },
    close() {
      db.close();
    },
  };
}

// Opens the store, runs fn, and always closes it: every CLI call is one process.
export function withStore<T>(fn: (store: Store) => T, dir = home()): T {
  const store = openStore(dir);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}
