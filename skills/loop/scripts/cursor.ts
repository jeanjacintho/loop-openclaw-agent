// Where each scan stopped, per source, and the record of consecutive read
// failures behind the one-time "can't read your messages" warning (Meetly's
// cursor.ts, one file per source).
//
// Two phases (The Founder Times' D8): `scan` never moves the cursor. It
// writes the candidates it found and the position after them to a pending
// file; `commit` moves the cursor there once the candidates are in the
// ledger. A crash between the two re-reads the same messages, and the ledger's
// dedupe key (the evidence item) keeps them from being counted twice.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { file, nowMs } from "./paths.ts";
import { readJson, removeFile, updateJson, writeJson } from "./store.ts";

export type SourceName = "mail" | "imessage";
export const SOURCE_NAMES: readonly SourceName[] = ["mail", "imessage"];

export type Cursor<P> = {
  pos: P | null; // null until the first scan sets it
  updatedAt?: string;
  lastOkAt?: string; // the last time this source was read successfully
  failingSince?: string;
  warnedAt?: string;
};
export type Pending<P, C> = { scannedAt: string; next: P; candidates: C[]; evidence?: unknown[] };

export const WARN_AFTER_MS = 30 * 60_000;

const cursorPath = (source: SourceName) => file(`cursor-${source}.json`);
const pendingPath = (source: SourceName) => file(`pending-${source}.json`);

export function readCursor<P>(source: SourceName): Cursor<P> {
  return readJson<Cursor<P>>(cursorPath(source), { pos: null });
}

export function markFail<P>(c: Cursor<P>, now: number): { cursor: Cursor<P>; warn: boolean } {
  const failingSince = c.failingSince ?? new Date(now).toISOString();
  const cursor: Cursor<P> = { ...c, failingSince };
  const warn = !c.warnedAt && now - Date.parse(failingSince) >= WARN_AFTER_MS;
  if (warn) cursor.warnedAt = new Date(now).toISOString();
  return { cursor, warn };
}

export function markOk<P>(c: Cursor<P>, now: number): Cursor<P> {
  const { failingSince: _f, warnedAt: _w, ...rest } = c;
  return { ...rest, lastOkAt: new Date(now).toISOString() };
}

export function fail(source: SourceName, now = nowMs()): { failingSince: string; warn: boolean } {
  let warn = false;
  const cursor = updateJson<Cursor<unknown>>(cursorPath(source), { pos: null }, (c) => {
    const r = markFail(c, now);
    warn = r.warn;
    return r.cursor;
  });
  return { failingSince: cursor.failingSince!, warn };
}

export function ok(source: SourceName, now = nowMs()): Cursor<unknown> {
  return updateJson<Cursor<unknown>>(cursorPath(source), { pos: null }, (c) => markOk(c, now));
}

export function savePending<P, C>(source: SourceName, pending: Pending<P, C>): void {
  writeJson(pendingPath(source), pending);
}

export function readPending<P, C>(source: SourceName): Pending<P, C> | null {
  return readJson<Pending<P, C> | null>(pendingPath(source), null);
}

// Moves the cursor to the pending position. `forward(from, to)` refuses a
// position behind the current one: a cursor never moves back.
export function commit<P>(source: SourceName, forward: (from: P | null, to: P) => P, now = nowMs()): { pos: P | null; committed: number } {
  const pending = readPending<P, unknown>(source);
  if (!pending) return { pos: readCursor<P>(source).pos, committed: 0 };
  const cursor = updateJson<Cursor<P>>(cursorPath(source), { pos: null }, (c) => ({
    ...markOk(c, now), pos: forward(c.pos, pending.next), updatedAt: new Date(now).toISOString(),
  }));
  removeFile(pendingPath(source));
  return { pos: cursor.pos, committed: pending.candidates.length };
}

// Every source's read health, for the digest's "haven't read new messages since X".
export function health(): Record<SourceName, { lastOkAt: string | null; failingSince: string | null }> {
  const out = {} as Record<SourceName, { lastOkAt: string | null; failingSince: string | null }>;
  for (const s of SOURCE_NAMES) {
    const c = readCursor<unknown>(s);
    out[s] = { lastOkAt: c.lastOkAt ?? null, failingSince: c.failingSince ?? null };
  }
  return out;
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({ args: rest, options: { source: { type: "string" } } });
    const source = values.source as SourceName | undefined;
    if (cmd === "health") return health();
    if (!source || !SOURCE_NAMES.includes(source)) throw new Error("usage: cursor.ts health | get|fail|ok --source mail|imessage");
    if (cmd === "get") return { cursor: readCursor(source), pending: readPending(source) };
    if (cmd === "fail") return fail(source);
    if (cmd === "ok") return ok(source);
    throw new Error("usage: cursor.ts health | get|fail|ok --source mail|imessage");
  });
}
