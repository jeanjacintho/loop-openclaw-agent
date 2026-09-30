// Loop's ledger: people, commitments, their evidence and their events. The
// only writer of Loop's state: every script and every turn changes it through
// the functions here, which validate first and write in one transaction.
//
// A commitment changes only by an event (detected, confirmed, deadline_changed,
// resolved, reopened…). Its status, deadline and the rest of its current state
// are derived from its events by `project`; the columns in `commitments` are
// that projection, rewritten with every event.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { parseFeatures, type Features } from "./confidence.ts";
import { withStore, type Store } from "./db.ts";
import { parseHandle, sameHandle } from "./handles.ts";
import { nowMs } from "./paths.ts";

export type Direction = "i_owe" | "they_owe";
export type CommitmentType = "promise" | "request" | "delegation" | "waiting" | "decision";
export type ObjectKind = "file" | "intro" | "reply" | "meeting" | "decision" | "other";
export type DeadlineKind = "date" | "event" | "none";
export type Certainty = "firm" | "soft" | "inferred";
export type Status = "candidate" | "open" | "snoozed" | "done" | "dropped";
export type Role = "investor" | "customer" | "team" | "partner" | "other" | "unknown";
export type Source = "gmail" | "imessage" | "plow";
export type EvidenceRole = "origin" | "update" | "resolution";

export const DIRECTIONS: readonly Direction[] = ["i_owe", "they_owe"];
export const TYPES: readonly CommitmentType[] = ["promise", "request", "delegation", "waiting", "decision"];
export const OBJECT_KINDS: readonly ObjectKind[] = ["file", "intro", "reply", "meeting", "decision", "other"];
export const STATUSES: readonly Status[] = ["candidate", "open", "snoozed", "done", "dropped"];
export const ROLES: readonly Role[] = ["investor", "customer", "team", "partner", "other", "unknown"];
export const SOURCES: readonly Source[] = ["gmail", "imessage", "plow"];
export const CERTAINTIES: readonly Certainty[] = ["firm", "soft", "inferred"];
export const LIVE: readonly Status[] = ["candidate", "open", "snoozed"];

export const QUOTE_MAX = 280;

export type Deadline = { kind: DeadlineKind; at: string | null; text: string | null; event: string | null; certainty: Certainty | null };
export type PersonInput = "owner" | { name?: string; handles?: string[]; role?: Role; org?: string };
export type EvidenceInput = {
  source: Source;
  item: string;
  quote: string;
  at: string;
  author?: PersonInput;
  thread?: string;
  role?: EvidenceRole;
};
export type NewCommitment = {
  direction: Direction;
  type: CommitmentType;
  debtor: PersonInput;
  creditor: PersonInput;
  what: string;
  objectKind: ObjectKind;
  band: "open" | "candidate";
  deadline?: Partial<Deadline>;
  features?: Features;
  evidence: EvidenceInput[];
};

export type PersonView = { id: number; name: string | null; role: Role; isOwner: boolean; handles: string[] };
export type Commitment = {
  id: number;
  direction: Direction;
  type: CommitmentType;
  debtor: PersonView;
  creditor: PersonView;
  what: string;
  objectKind: ObjectKind;
  band: "open" | "candidate";
  status: Status;
  deadline: Deadline;
  expectUntil: string | null;
  closedBy: Record<string, unknown> | null;
  lastNudgedAt: string | null;
  lastDraftedAt: string | null;
  features: Features | null;
  createdAt: string;
  updatedAt: string;
};
export type EvidenceView = { id: number; role: EvidenceRole; source: Source; item: string; thread: string | null; quote: string | null; authorId: number | null; at: string };
export type EventView = { id: number; kind: EventKind; payload: Record<string, unknown>; actor: string; at: string };

// ---------------------------------------------------------------- validation

const isDate = (t: unknown): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t));
const iso = (t: string) => new Date(Date.parse(t)).toISOString();

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (!allowed.includes(value as T)) throw new Error(`${what} must be one of ${allowed.join(", ")}, got ${JSON.stringify(value)}`);
  return value as T;
}

function text(value: unknown, what: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${what} must be a non-empty string`);
  return value.trim().slice(0, max);
}

// gmail:<account>:<thread>@<message>, imessage:<rowid>, plow:<chat>:<message>.
const ITEM: Record<Source, RegExp> = {
  gmail: /^gmail:[^\s:@]+@[^\s:@]+:[^\s@:]+@[^\s@]+$/,
  imessage: /^imessage:\d+$/,
  plow: /^plow:[^\s:]+:[^\s:]+$/,
};

export function checkItem(source: Source, item: unknown): string {
  if (typeof item !== "string" || !ITEM[source].test(item)) {
    throw new Error(`evidence item for ${source} must look like ${
      { gmail: "gmail:<account>:<thread>@<message>", imessage: "imessage:<rowid>", plow: "plow:<chat>:<message>" }[source]
    }, got ${JSON.stringify(item)}`);
  }
  return item;
}

export function cutQuote(quote: unknown): string {
  const q = text(quote, "evidence quote", 10_000).replace(/\s+/g, " ");
  return q.length <= QUOTE_MAX ? q : q.slice(0, QUOTE_MAX);
}

export function normalizeWhat(what: string): string {
  return what.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

type CheckedEvidence = { source: Source; item: string; quote: string; at: string; role: EvidenceRole; thread: string | null; author?: PersonInput };

function checkEvidence(raw: EvidenceInput, defaultRole: EvidenceRole): CheckedEvidence {
  if (raw === null || typeof raw !== "object") throw new Error("each evidence must be an object");
  const source = oneOf(raw.source, SOURCES, "evidence source");
  const item = checkItem(source, raw.item);
  if (!isDate(raw.at)) throw new Error(`evidence at must be a date, got ${JSON.stringify(raw.at)}`);
  const role = raw.role === undefined ? defaultRole : oneOf(raw.role, ["origin", "update", "resolution"] as const, "evidence role");
  const thread = raw.thread === undefined || raw.thread === null ? null : text(raw.thread, "evidence thread", 300);
  return { source, item, quote: cutQuote(raw.quote), at: iso(raw.at), role, thread, author: raw.author };
}

export function checkDeadline(raw: Partial<Deadline> | undefined): Deadline {
  if (raw === undefined || raw === null) return { kind: "none", at: null, text: null, event: null, certainty: null };
  const kind = oneOf(raw.kind ?? "none", ["date", "event", "none"] as const, "deadline kind");
  const certainty = raw.certainty === undefined || raw.certainty === null ? null : oneOf(raw.certainty, CERTAINTIES, "deadline certainty");
  const deadlineText = raw.text === undefined || raw.text === null ? null : text(raw.text, "deadline text", 200);
  if (kind === "date") {
    if (!isDate(raw.at)) throw new Error(`a date deadline needs at, got ${JSON.stringify(raw.at)}`);
    return { kind, at: iso(raw.at), text: deadlineText, event: null, certainty: certainty ?? "firm" };
  }
  if (kind === "event") {
    return { kind, at: null, text: deadlineText, event: text(raw.event, "deadline event", 200), certainty: certainty ?? "soft" };
  }
  return { kind, at: null, text: deadlineText, event: null, certainty: null };
}

function checkPerson(raw: PersonInput, what: string): PersonInput {
  if (raw === "owner") return raw;
  if (raw === null || typeof raw !== "object") throw new Error(`${what} must be "owner" or {name, handles}`);
  const handles = raw.handles ?? [];
  if (!Array.isArray(handles)) throw new Error(`${what}.handles must be a list`);
  for (const h of handles) parseHandle(String(h));
  if (!handles.length && !(typeof raw.name === "string" && raw.name.trim())) throw new Error(`${what} needs a name or a handle`);
  if (raw.role !== undefined) oneOf(raw.role, ROLES, `${what}.role`);
  return raw;
}

// ---------------------------------------------------------------- people

export function ownerId(store: Store, at: string): number {
  const row = store.db.prepare("SELECT id FROM people WHERE is_owner = 1").get() as { id: number } | undefined;
  if (row) return row.id;
  return Number(store.db.prepare("INSERT INTO people (display_name, role, is_owner, created_at) VALUES ('owner', 'unknown', 1, ?)").run(at).lastInsertRowid);
}

export function personByHandle(store: Store, raw: string): number | undefined {
  const h = parseHandle(raw);
  const row = store.db.prepare("SELECT person_id FROM handles WHERE kind = ? AND value_norm = ?").get(h.kind, h.value) as { person_id: number } | undefined;
  if (row || h.kind !== "phone") return row?.person_id;
  // +5511988887777 from iMessage and 11 98888-7777 from Contacts are one phone.
  const phones = store.db.prepare("SELECT person_id, value_norm FROM handles WHERE kind = 'phone'").all() as { person_id: number; value_norm: string }[];
  return phones.find((p) => sameHandle(p.value_norm, h.value))?.person_id;
}

export function addHandle(store: Store, personId: number, raw: string): void {
  const h = parseHandle(raw);
  store.db.prepare("INSERT OR IGNORE INTO handles (person_id, kind, value_norm) VALUES (?, ?, ?)").run(personId, h.kind, h.value);
}

// A handle already known → that person. Otherwise a new person. Never by name
// alone: two people called Pedro are two people.
export function ensurePerson(store: Store, input: PersonInput, at: string): number {
  if (input === "owner") return ownerId(store, at);
  const handles = input.handles ?? [];
  for (const h of handles) {
    const id = personByHandle(store, h);
    if (id !== undefined) {
      for (const other of handles) addHandle(store, id, other);
      store.db.prepare("UPDATE people SET display_name = coalesce(display_name, ?), org = coalesce(org, ?) WHERE id = ?")
        .run(input.name?.trim() || null, input.org ?? null, id);
      // A role the owner or the config gave is kept; only an unknown one is filled.
      if (input.role && input.role !== "unknown") store.db.prepare("UPDATE people SET role = ? WHERE id = ? AND role = 'unknown'").run(input.role, id);
      return id;
    }
  }
  const id = Number(store.db.prepare("INSERT INTO people (display_name, role, org, created_at) VALUES (?, ?, ?, ?)")
    .run(input.name?.trim() || null, input.role ?? "unknown", input.org ?? null, at).lastInsertRowid);
  for (const h of handles) addHandle(store, id, h);
  noteNamesakes(store, id, at);
  return id;
}

export const foldName = (name: string | null) => (name ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

// Someone new with the same name as someone known may be the same person on
// another handle, or a different person. Loop never decides: it notes the
// pair so the digest can ask the owner once.
function noteNamesakes(store: Store, id: number, at: string): void {
  const me = store.db.prepare("SELECT display_name FROM people WHERE id = ?").get(id) as { display_name: string | null };
  const name = foldName(me.display_name);
  if (!name) return;
  const others = store.db.prepare("SELECT id, display_name FROM people WHERE id != ? AND is_owner = 0").all(id) as { id: number; display_name: string | null }[];
  for (const o of others) {
    if (foldName(o.display_name) !== name) continue;
    const [a, b] = o.id < id ? [o.id, id] : [id, o.id];
    store.db.prepare("INSERT OR IGNORE INTO person_questions (a_id, b_id, created_at) VALUES (?, ?, ?)").run(a, b, at);
  }
}

export function personView(store: Store, id: number): PersonView {
  const row = store.db.prepare("SELECT id, display_name, role, is_owner FROM people WHERE id = ?").get(id) as
    { id: number; display_name: string | null; role: Role; is_owner: number } | undefined;
  if (!row) throw new Error(`no person ${id}`);
  const handles = (store.db.prepare("SELECT kind, value_norm FROM handles WHERE person_id = ? ORDER BY kind, value_norm").all(id) as { kind: string; value_norm: string }[])
    .map((h) => (h.kind === "plow" ? `plow:${h.value_norm}` : h.value_norm));
  return { id: row.id, name: row.display_name, role: row.role, isOwner: row.is_owner === 1, handles };
}

// ---------------------------------------------------------------- events

export const EVENT_KINDS = [
  "detected", "confirmed", "rejected", "deadline_changed", "nudged", "drafted", "resolved", "reopened", "snoozed",
  "dropped", "evidence_added", "looks_done", "alerted", "asked",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// Kinds that record something without changing the commitment's state.
const NOTES: readonly EventKind[] = ["evidence_added", "looks_done", "alerted", "asked"];

export type Derived = {
  status: Status;
  deadline: Deadline;
  expectUntil: string | null;
  closedBy: Record<string, unknown> | null;
  lastNudgedAt: string | null;
  lastDraftedAt: string | null;
};
type EventRow = { kind: EventKind; payload: Record<string, unknown>; actor: string; at: string };

function expect(state: Derived, allowed: readonly Status[], kind: string): void {
  if (!allowed.includes(state.status)) throw new Error(`cannot apply ${kind} to a ${state.status} commitment`);
}

export function applyEvent(state: Derived | null, e: EventRow): Derived {
  if (e.kind === "detected") {
    if (state) throw new Error("detected can only be the first event");
    return {
      status: e.payload.status as Status,
      deadline: checkDeadline(e.payload.deadline as Partial<Deadline>),
      expectUntil: null, closedBy: null, lastNudgedAt: null, lastDraftedAt: null,
    };
  }
  if (!state) throw new Error(`${e.kind} before detected`);
  const s = { ...state };
  switch (e.kind) {
    case "confirmed":
      expect(s, ["candidate"], e.kind);
      s.status = "open";
      return s;
    case "rejected":
    case "dropped":
      expect(s, LIVE, e.kind);
      s.status = "dropped";
      s.closedBy = { kind: e.kind, actor: e.actor, at: e.at, ...(e.payload.reason ? { reason: e.payload.reason } : {}) };
      return s;
    case "resolved":
      expect(s, LIVE, e.kind);
      s.status = "done";
      s.closedBy = { kind: "resolved", actor: e.actor, at: e.at, ...(e.payload.item ? { item: e.payload.item } : {}) };
      return s;
    case "reopened":
      expect(s, ["done", "dropped", "snoozed"], e.kind);
      s.status = "open";
      s.closedBy = null;
      s.expectUntil = null;
      return s;
    case "deadline_changed":
      expect(s, LIVE, e.kind);
      s.deadline = checkDeadline(e.payload.deadline as Partial<Deadline>);
      return s;
    case "snoozed":
      expect(s, LIVE, e.kind);
      if (!isDate(e.payload.until)) throw new Error("snoozed needs payload.until, a date");
      s.status = "snoozed";
      s.expectUntil = iso(e.payload.until);
      return s;
    case "nudged":
      expect(s, LIVE, e.kind);
      s.lastNudgedAt = isDate(e.payload.at) ? iso(e.payload.at) : e.at;
      return s;
    case "drafted":
      expect(s, LIVE, e.kind);
      s.lastDraftedAt = e.at;
      return s;
    default:
      if (NOTES.includes(e.kind)) return s;
      throw new Error(`unknown event kind: ${e.kind}`);
  }
}

export function project(events: EventRow[]): Derived {
  let state: Derived | null = null;
  for (const e of events) state = applyEvent(state, e);
  if (!state) throw new Error("a commitment with no events");
  return state;
}

function loadEvents(store: Store, id: number): EventRow[] {
  return (store.db.prepare("SELECT kind, payload_json, actor, at FROM events WHERE commitment_id = ? ORDER BY id").all(id) as
    { kind: EventKind; payload_json: string; actor: string; at: string }[])
    .map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload_json), actor: r.actor, at: r.at }));
}

function writeDerived(store: Store, id: number, d: Derived, at: string): void {
  store.db.prepare(`UPDATE commitments SET status = ?, deadline_kind = ?, deadline_at = ?, deadline_text = ?, deadline_event = ?,
      deadline_certainty = ?, expect_until = ?, closed_by = ?, last_nudged_at = ?, last_drafted_at = ?, updated_at = ? WHERE id = ?`)
    .run(d.status, d.deadline.kind, d.deadline.at, d.deadline.text, d.deadline.event, d.deadline.certainty, d.expectUntil,
      d.closedBy ? JSON.stringify(d.closedBy) : null, d.lastNudgedAt, d.lastDraftedAt, at, id);
}

function insertEvent(store: Store, id: number, e: EventRow): void {
  store.db.prepare("INSERT INTO events (commitment_id, kind, payload_json, actor, at) VALUES (?, ?, ?, ?, ?)")
    .run(id, e.kind, JSON.stringify(e.payload), e.actor, e.at);
}

// Appends one event and re-derives the commitment from all of its events.
export function appendEvent(store: Store, id: number, kind: string, payload: Record<string, unknown> = {}, actor = "loop", at = new Date(nowMs()).toISOString()): Commitment {
  const k = oneOf(kind, EVENT_KINDS, "event kind");
  if (k === "detected") throw new Error("detected is written by add");
  return store.tx(() => {
    const events = loadEvents(store, id);
    if (!events.length) throw new Error(`no commitment ${id}`);
    const before = project(events);
    const full = { ...payload };
    if (k === "deadline_changed") {
      full.deadline = checkDeadline(payload.deadline as Partial<Deadline>);
      full.previous = before.deadline;
    }
    const e: EventRow = { kind: k, payload: full, actor, at };
    const after = applyEvent(before, e);
    insertEvent(store, id, e);
    writeDerived(store, id, after, at);
    return getCommitment(store, id);
  });
}

// ---------------------------------------------------------------- commitments

type Row = {
  id: number; direction: Direction; type: CommitmentType; debtor_id: number; creditor_id: number; what: string;
  object_kind: ObjectKind; features_json: string | null; band: "open" | "candidate"; status: Status;
  deadline_kind: DeadlineKind; deadline_at: string | null; deadline_text: string | null; deadline_event: string | null;
  deadline_certainty: Certainty | null; expect_until: string | null; closed_by: string | null;
  last_nudged_at: string | null; last_drafted_at: string | null; created_at: string; updated_at: string;
};

export function toCommitment(store: Store, r: Row): Commitment {
  return {
    id: r.id, direction: r.direction, type: r.type,
    debtor: personView(store, r.debtor_id), creditor: personView(store, r.creditor_id),
    what: r.what, objectKind: r.object_kind, band: r.band, status: r.status,
    deadline: { kind: r.deadline_kind, at: r.deadline_at, text: r.deadline_text, event: r.deadline_event, certainty: r.deadline_certainty },
    expectUntil: r.expect_until, closedBy: r.closed_by ? JSON.parse(r.closed_by) : null,
    lastNudgedAt: r.last_nudged_at, lastDraftedAt: r.last_drafted_at,
    features: r.features_json ? JSON.parse(r.features_json) : null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getCommitment(store: Store, id: number): Commitment {
  const row = store.db.prepare("SELECT * FROM commitments WHERE id = ?").get(id) as Row | undefined;
  if (!row) throw new Error(`no commitment ${id}`);
  return toCommitment(store, row);
}

export function evidenceOf(store: Store, id: number): EvidenceView[] {
  return (store.db.prepare("SELECT id, role, source, item, thread, quote, author_id, at FROM evidence WHERE commitment_id = ? ORDER BY at, id").all(id) as
    { id: number; role: EvidenceRole; source: Source; item: string; thread: string | null; quote: string | null; author_id: number | null; at: string }[])
    .map((e) => ({ id: e.id, role: e.role, source: e.source, item: e.item, thread: e.thread, quote: e.quote, authorId: e.author_id, at: e.at }));
}

export function eventsOf(store: Store, id: number): EventView[] {
  return (store.db.prepare("SELECT id, kind, payload_json, actor, at FROM events WHERE commitment_id = ? ORDER BY id").all(id) as
    { id: number; kind: EventKind; payload_json: string; actor: string; at: string }[])
    .map((e) => ({ id: e.id, kind: e.kind, payload: JSON.parse(e.payload_json), actor: e.actor, at: e.at }));
}

export function dedupeKey(source: string, item: string, what: string): string {
  return createHash("sha256").update(`${source}|${item}|${normalizeWhat(what)}`).digest("hex");
}

export type CheckedCommitment = Omit<NewCommitment, "deadline" | "evidence"> & { deadline: Deadline; evidence: CheckedEvidence[] };

export function checkNew(raw: NewCommitment): CheckedCommitment {
  if (raw === null || typeof raw !== "object") throw new Error("the commitment must be a JSON object");
  const direction = oneOf(raw.direction, DIRECTIONS, "direction");
  const debtor = checkPerson(raw.debtor, "debtor");
  const creditor = checkPerson(raw.creditor, "creditor");
  if (direction === "i_owe" && debtor !== "owner") throw new Error("i_owe needs debtor \"owner\"");
  if (direction === "they_owe" && creditor !== "owner") throw new Error("they_owe needs creditor \"owner\"");
  if (debtor === "owner" && creditor === "owner") throw new Error("the owner cannot owe themselves");
  if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) throw new Error("a commitment needs at least one evidence (source, item, quote, at)");
  return {
    direction,
    type: oneOf(raw.type, TYPES, "type"),
    debtor, creditor,
    what: text(raw.what, "what", 300),
    objectKind: oneOf(raw.objectKind, OBJECT_KINDS, "objectKind"),
    band: oneOf(raw.band, ["open", "candidate"] as const, "band"),
    deadline: checkDeadline(raw.deadline),
    features: raw.features === undefined ? undefined : parseFeatures(raw.features),
    evidence: raw.evidence.map((e, i) => checkEvidence(e, i === 0 ? "origin" : "update")),
  };
}

export type AddResult = { commitment: Commitment; created: boolean; merged?: true };

export const REPEAT_WINDOW_DAYS = 7;
const STOP = new Set([
  "the", "a", "an", "to", "of", "for", "and", "on", "in", "with", "my", "your", "our", "you", "me", "it", "this", "that",
  "o", "os", "as", "de", "do", "da", "dos", "das", "para", "pra", "pro", "te", "e", "no", "na", "com", "um", "uma", "meu", "minha", "seu", "sua",
  "send", "sending", "share", "get", "give", "review", "pay", "prepare", "intro", "introduce", "reply", "update", "updated", "new",
  "mandar", "enviar", "passar", "compartilhar", "revisar", "pagar", "preparar", "apresentar", "responder", "atualizar", "atualizado", "atualizada", "novo", "nova",
]);

export function objectWords(whatNorm: string): Set<string> {
  return new Set(whatNorm.split(" ").filter((w) => w.length >= 4 && !STOP.has(w)));
}

// A live commitment between the same two people, about the same kind of
// object, sharing a content word, detected in the last week.
function findRepeat(store: Store, c: CheckedCommitment, debtorId: number, creditorId: number, at: string): number | undefined {
  const since = new Date(Date.parse(at) - REPEAT_WINDOW_DAYS * 86_400_000).toISOString();
  const rows = store.db.prepare(`SELECT id, what_norm FROM commitments WHERE debtor_id = ? AND creditor_id = ? AND direction = ? AND object_kind = ?
      AND status IN ('candidate', 'open', 'snoozed') AND created_at >= ? ORDER BY id`).all(debtorId, creditorId, c.direction, c.objectKind, since) as { id: number; what_norm: string }[];
  const mine = objectWords(normalizeWhat(c.what));
  return rows.find((r) => [...objectWords(r.what_norm)].some((w) => mine.has(w)))?.id;
}

// Idempotent on (source, item, what) of the origin evidence: a scan that runs
// again after a crash finds the commitment it already wrote.
export function addCommitment(store: Store, raw: NewCommitment, actor = "loop", at = new Date(nowMs()).toISOString()): AddResult {
  const c = checkNew(raw);
  const origin = c.evidence.find((e) => e.role === "origin") ?? c.evidence[0]!;
  const key = dedupeKey(origin.source, origin.item, c.what);
  return store.tx(() => {
    const existing = store.db.prepare("SELECT id FROM commitments WHERE dedupe_key = ?").get(key) as { id: number } | undefined;
    if (existing) return { commitment: getCommitment(store, existing.id), created: false };
    const debtorId = ensurePerson(store, c.debtor, at);
    const creditorId = ensurePerson(store, c.creditor, at);
    // The same promise seen again (in mail and in a text, or twice in a
    // week) is one commitment with more evidence, not a second commitment.
    const same = findRepeat(store, c, debtorId, creditorId, at);
    if (same !== undefined) {
      for (const e of c.evidence) {
        if (insertEvidence(store, same, { ...e, role: "update" }, at)) {
          insertEvent(store, same, { kind: "evidence_added", payload: { item: e.item, role: "update", repeat: true }, actor, at });
        }
      }
      return { commitment: getCommitment(store, same), created: false, merged: true };
    }
    const status: Status = c.band === "open" ? "open" : "candidate";
    const id = Number(store.db.prepare(`INSERT INTO commitments (direction, type, debtor_id, creditor_id, what, what_norm, object_kind,
        features_json, dedupe_key, band, status, deadline_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`)
      .run(c.direction, c.type, debtorId, creditorId, c.what, normalizeWhat(c.what), c.objectKind,
        c.features ? JSON.stringify(c.features) : null, key, c.band, status, at, at).lastInsertRowid);
    for (const e of c.evidence) insertEvidence(store, id, e, at);
    const detected: EventRow = { kind: "detected", payload: { status, band: c.band, deadline: c.deadline }, actor, at };
    insertEvent(store, id, detected);
    writeDerived(store, id, applyEvent(null, detected), at);
    return { commitment: getCommitment(store, id), created: true };
  });
}

function insertEvidence(store: Store, id: number, e: CheckedEvidence, at: string): boolean {
  const author = e.author === undefined ? null : ensurePerson(store, checkPerson(e.author, "evidence author"), at);
  const res = store.db.prepare("INSERT OR IGNORE INTO evidence (commitment_id, role, source, item, thread, quote, author_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, e.role, e.source, e.item, e.thread, e.quote, author, e.at);
  return Number(res.changes) > 0;
}

// One more piece of evidence on an existing commitment (the same promise seen
// again, a renegotiation, a delivery). Idempotent on (item, role).
export function addEvidence(store: Store, id: number, raw: EvidenceInput, actor = "loop", at = new Date(nowMs()).toISOString()): { commitment: Commitment; added: boolean } {
  const e = checkEvidence(raw, "update");
  return store.tx(() => {
    getCommitment(store, id);
    const added = insertEvidence(store, id, e, at);
    if (added) insertEvent(store, id, { kind: "evidence_added", payload: { item: e.item, role: e.role }, actor, at });
    return { commitment: getCommitment(store, id), added };
  });
}

// ---------------------------------------------------------------- queries

function rows(store: Store, sql: string, ...params: (string | number | null)[]): Commitment[] {
  return (store.db.prepare(sql).all(...params) as Row[]).map((r) => toCommitment(store, r));
}

export function listCommitments(store: Store, statuses: Status[], direction?: Direction): Commitment[] {
  const marks = statuses.map(() => "?").join(", ");
  return direction
    ? rows(store, `SELECT * FROM commitments WHERE status IN (${marks}) AND direction = ? ORDER BY coalesce(deadline_at, '9999'), id`, ...statuses, direction)
    : rows(store, `SELECT * FROM commitments WHERE status IN (${marks}) ORDER BY coalesce(deadline_at, '9999'), id`, ...statuses);
}

// Live commitments with this person on either side. A handle matches exactly;
// anything else matches the name (case-insensitive substring).
export function findByPerson(store: Store, who: string, includeClosed = false): Commitment[] {
  let ids: number[];
  try {
    const id = personByHandle(store, who);
    ids = id === undefined ? [] : [id];
  } catch {
    const needle = who.trim().toLowerCase();
    ids = (store.db.prepare("SELECT id, display_name FROM people WHERE is_owner = 0").all() as { id: number; display_name: string | null }[])
      .filter((p) => needle && (p.display_name ?? "").toLowerCase().includes(needle)).map((p) => p.id);
  }
  if (!ids.length) return [];
  const statuses = includeClosed ? STATUSES : LIVE;
  const marks = ids.map(() => "?").join(", ");
  return rows(store, `SELECT * FROM commitments WHERE (debtor_id IN (${marks}) OR creditor_id IN (${marks}))
      AND status IN (${statuses.map(() => "?").join(", ")}) ORDER BY coalesce(deadline_at, '9999'), id`, ...ids, ...ids, ...statuses);
}

// Open commitments whose date deadline is at or before `until`, and snoozed
// ones whose snooze ended by then.
export function dueBy(store: Store, until: string): Commitment[] {
  if (!isDate(until)) throw new Error(`--until must be a date, got ${until}`);
  const u = iso(until);
  return rows(store, `SELECT * FROM commitments WHERE deadline_kind = 'date' AND deadline_at <= ?
      AND (status = 'open' OR (status = 'snoozed' AND expect_until <= ?)) ORDER BY deadline_at, id`, u, u);
}

export function stats(store: Store): Record<string, unknown> {
  const count = (sql: string) => Object.fromEntries((store.db.prepare(sql).all() as { k: string; n: number }[]).map((r) => [r.k, r.n]));
  return {
    byStatus: count("SELECT status AS k, count(*) AS n FROM commitments GROUP BY status"),
    byBand: count("SELECT band AS k, count(*) AS n FROM commitments GROUP BY band"),
    byDirection: count("SELECT direction AS k, count(*) AS n FROM commitments WHERE status IN ('candidate', 'open', 'snoozed') GROUP BY direction"),
  };
}

// Retention: a commitment closed more than `days` ago keeps who, what and
// when, but loses the quoted text of its evidence.
export const RETAIN_DAYS = 90;

export function retain(store: Store, now = nowMs(), days = RETAIN_DAYS): { cleared: number } {
  const cutoff = new Date(now - days * 86_400_000).toISOString();
  return store.tx(() => {
    const res = store.db.prepare(`UPDATE evidence SET quote = NULL WHERE quote IS NOT NULL AND commitment_id IN
        (SELECT id FROM commitments WHERE status IN ('done', 'dropped') AND updated_at < ?)`).run(cutoff);
    return { cleared: Number(res.changes) };
  });
}

// ---------------------------------------------------------------- CLI

function jsonArg(values: { json?: string; "json-file"?: string }): unknown {
  const raw = values.json ?? (values["json-file"] ? readFileSync(values["json-file"], "utf8") : undefined);
  if (raw === undefined) throw new Error("pass --json '<object>' or --json-file F");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`--json is not valid JSON: ${(err as Error).message}`);
  }
}

function idArg(raw: string | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`--id must be a commitment id, got ${raw}`);
  return Number(raw);
}

export const USAGE = "usage: ledger.ts add --json J | event --id X --kind K [--json P] [--actor A] | evidence --id X --json E | "
  + "get --id X | list [--status S[,S]] [--direction D] | find --person P [--all] | due --until ISO | stats | retain";

export function main(argv: string[]): unknown {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      json: { type: "string" }, "json-file": { type: "string" }, id: { type: "string" }, kind: { type: "string" },
      actor: { type: "string" }, status: { type: "string" }, direction: { type: "string" }, person: { type: "string" },
      all: { type: "boolean" }, until: { type: "string" },
    },
  });
  return withStore((store) => {
    switch (cmd) {
      case "add":
        return addCommitment(store, jsonArg(values) as NewCommitment, values.actor ?? "loop");
      case "event": {
        if (!values.kind) throw new Error("event needs --kind");
        const payload = values.json !== undefined || values["json-file"] !== undefined ? jsonArg(values) : {};
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("the event payload must be an object");
        return { commitment: appendEvent(store, idArg(values.id), values.kind, payload as Record<string, unknown>, values.actor ?? "loop") };
      }
      case "evidence":
        return addEvidence(store, idArg(values.id), jsonArg(values) as EvidenceInput, values.actor ?? "loop");
      case "get": {
        const id = idArg(values.id);
        return { commitment: getCommitment(store, id), evidence: evidenceOf(store, id), events: eventsOf(store, id) };
      }
      case "list": {
        const statuses = (values.status ?? "open").split(",").map((s) => oneOf(s.trim(), STATUSES, "--status"));
        const direction = values.direction === undefined ? undefined : oneOf(values.direction, DIRECTIONS, "--direction");
        return { commitments: listCommitments(store, statuses, direction) };
      }
      case "find":
        if (!values.person) throw new Error("find needs --person");
        return { commitments: findByPerson(store, values.person, values.all === true) };
      case "due":
        return { commitments: dueBy(store, values.until ?? "") };
      case "stats":
        return stats(store);
      case "retain":
        return retain(store);
      default:
        throw new Error(USAGE);
    }
  });
}

if (isMain(import.meta.url)) run(() => main(process.argv.slice(2)));
