// Records what the model found in one scanned message. The model reads the
// candidate and reports an extraction; this script decides everything that
// can be decided without it, and refuses what does not hold:
//
//  - the message must be a candidate the scan handed over (never a message
//    the model names on its own);
//  - the quote must be a substring of the owner's own text, so evidence is
//    never invented;
//  - the other side is taken from the message's recipients, never from text
//    (CC is not a creditor, and an unclear recipient caps the band);
//  - the band comes from the features (confidence.ts), not from the model;
//  - the deadline is resolved from when the message was sent (deadline.ts);
//  - an update to an open commitment must concern the same person.
//
//   detect.ts record --item I --json '<extraction>'
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { band as bandOf, parseFeatures, type Band, type Features } from "./confidence.ts";
import { loadConfig, type Config } from "./config.ts";
import { readPending, type SourceName } from "./cursor.ts";
import { withStore, type Store } from "./db.ts";
import { resolveDeadline, type Resolved } from "./deadline.ts";
import { isEmail, isPhone, normalizeHandle, sameHandle } from "./handles.ts";
import {
  addCommitment, addEvidence, appendEvent, calibrationState, getCommitment, LIVE, OBJECT_KINDS, personByHandle, TYPES,
  type Commitment, type CommitmentType, type Deadline, type Direction, type ObjectKind, type PersonInput,
} from "./ledger.ts";
import { nowMs } from "./paths.ts";
import { enrich } from "./people.ts";
import { ignored } from "./feedback.ts";
import type { Candidate } from "./scan-common.ts";

export type PersonRef = "owner" | { name?: string | null; handle?: string | null };
export type Extraction = {
  is_commitment: boolean;
  direction?: Direction;
  type?: CommitmentType;
  debtor?: PersonRef;
  creditor?: PersonRef;
  what?: string;
  object_kind?: ObjectKind;
  deadline_text?: string | null;
  quote?: string;
  features?: Features;
  updates?: { id: number; change: "deadline" | "cancel" } | null;
};

export type Recorded =
  | { recorded: "not_commitment" }
  | { recorded: "dropped"; band: "drop"; ignored?: true }
  | { recorded: "commitment"; created: boolean; band: Exclude<Band, "drop">; commitment: Commitment; ambiguous?: string }
  | { recorded: "update"; change: "deadline" | "cancel"; commitment: Commitment };

// The pending scans, and the backfill's (LP-13), are the only places a candidate comes from.
export function findCandidate(item: string): Candidate {
  const sources: (SourceName | "backfill")[] = ["mail", "imessage", "backfill"];
  for (const s of sources) {
    const pending = readPending<unknown, Candidate>(s as SourceName);
    const found = pending?.candidates.find((c) => c.item === item);
    if (found) return found;
  }
  throw new Error(`${item} is not a candidate from the last scan; only scanned messages can become commitments`);
}

const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

export function quoteIn(quote: string, text: string): boolean {
  const q = squash(quote);
  return q.length > 0 && squash(text).includes(q);
}

// Who the other side is, from where the message went. The model's handle
// only picks among the recipients; it never adds one.
export function counterparty(c: Candidate, ref: PersonRef | undefined): { person: PersonInput; ambiguous?: string } {
  const named = ref && ref !== "owner" ? ref : {};
  const name = named.name?.trim() || undefined;
  const handle = named.handle && (isEmail(named.handle) || isPhone(named.handle)) ? normalizeHandle(named.handle) : undefined;
  const inTo = handle ? c.to.find((t) => sameHandle(t, handle)) : undefined;
  if (inTo) return { person: { name, handles: [inTo] } };
  if (c.to.length === 1) {
    return { person: { name: name ?? c.toNames[0], handles: [c.to[0]!] }, ...(handle ? { ambiguous: "the named handle is not the recipient" } : {}) };
  }
  if (handle && c.cc.some((t) => sameHandle(t, handle))) return { person: { name, handles: [handle] }, ambiguous: "the other side is only in CC" };
  if (!name) throw new Error("the message has several recipients; name who the commitment is with");
  return { person: { name }, ambiguous: "several recipients, none named by handle" };
}

function checkExtraction(raw: unknown): Extraction {
  if (raw === null || typeof raw !== "object") throw new Error("the extraction must be a JSON object");
  const e = raw as Extraction;
  if (typeof e.is_commitment !== "boolean") throw new Error("is_commitment must be true or false");
  if (!e.is_commitment) return e;
  if (!TYPES.includes(e.type as CommitmentType)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
  if (e.direction !== "i_owe" && e.direction !== "they_owe") throw new Error("direction must be i_owe or they_owe");
  if (!OBJECT_KINDS.includes(e.object_kind as ObjectKind)) throw new Error(`object_kind must be one of ${OBJECT_KINDS.join(", ")}`);
  if (typeof e.what !== "string" || !e.what.trim()) throw new Error("what is required");
  if (typeof e.quote !== "string" || !e.quote.trim()) throw new Error("quote is required");
  e.features = parseFeatures(e.features);
  return e;
}

function toDeadline(r: Resolved): Partial<Deadline> {
  if (r.kind === "date") return { kind: "date", at: r.at, text: r.text, certainty: r.certainty };
  if (r.kind === "event") return { kind: "event", event: r.event, text: r.text, certainty: "soft" };
  return { kind: "none", text: r.text };
}

function logDetection(store: Store, c: Candidate, isCommitment: boolean, band: string, features: Features | undefined, commitmentId: number | null, at: string): void {
  store.db.prepare("INSERT INTO detections (item, source, is_commitment, band, features_json, commitment_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(c.item, c.source, isCommitment ? 1 : 0, band, features ? JSON.stringify(features) : null, commitmentId, at);
}


// The person on the other side of a commitment, as a handle list.
function otherSide(c: Commitment): string[] {
  return (c.direction === "i_owe" ? c.creditor : c.debtor).handles;
}

export function record(store: Store, candidate: Candidate, raw: unknown, config: Pick<Config, "timezone" | "language" | "domainRoles">, at = new Date(nowMs()).toISOString()): Recorded {
  const e = checkExtraction(raw);
  if (!e.is_commitment) {
    logDetection(store, candidate, false, "none", undefined, null, at);
    return { recorded: "not_commitment" };
  }
  if (!quoteIn(e.quote!, candidate.text)) {
    throw new Error("the quote is not in the message; quote the owner's words exactly");
  }
  const evidence = { source: candidate.source, item: candidate.item, quote: e.quote!, at: candidate.sentAt, author: "owner" as const, thread: candidate.thread };
  const deadline = toDeadline(e.deadline_text ? resolveDeadline({ text: e.deadline_text, sentAt: candidate.sentAt, tz: config.timezone, locale: config.language }) : { kind: "none", text: null });

  if (e.updates) {
    const id = Number(e.updates.id);
    const target = getCommitment(store, id);
    if (!LIVE.includes(target.status)) throw new Error(`commitment ${id} is ${target.status}; only a live commitment can be updated`);
    // A message to Lucas cannot move or cancel what is owed to Michael.
    if (!otherSide(target).some((h) => candidate.to.some((t) => sameHandle(h, t)))) {
      throw new Error(`commitment ${id} is with someone this message did not go to`);
    }
    return store.tx(() => {
      addEvidence(store, id, { ...evidence, role: "update" });
      const change = e.updates!.change === "cancel" ? "cancel" : "deadline";
      const commitment = change === "cancel"
        ? appendEvent(store, id, "dropped", { reason: "cancelled", item: candidate.item }, "owner", at)
        : appendEvent(store, id, "deadline_changed", { deadline, item: candidate.item }, "owner", at);
      logDetection(store, candidate, true, "update", e.features, id, at);
      return { recorded: "update" as const, change, commitment };
    });
  }

  let band = bandOf(e.features!, calibrationState(store).raise);
  if (band === "drop") {
    logDetection(store, candidate, true, "drop", e.features, null, at);
    return { recorded: "dropped", band: "drop" };
  }
  // The owner is always one side; the other comes from the recipients.
  const found = counterparty(candidate, e.direction === "i_owe" ? e.creditor : e.debtor);
  if (found.ambiguous) band = "candidate";
  // Their other handles and name from the owner's contacts, their role from the domain.
  const other = { ...found, person: enrich(found.person, undefined, config.domainRoles) };
  // "Ignore this kind" / "ignore this person": counted, never recorded.
  const knownId = other.person === "owner" ? undefined : (other.person.handles ?? []).map((h) => personByHandle(store, h)).find((x) => x !== undefined);
  if (ignored(store, { objectKind: e.object_kind!, type: e.type!, personId: knownId ?? null })) {
    logDetection(store, candidate, true, "drop", e.features, null, at);
    return { recorded: "dropped", band: "drop", ignored: true };
  }
  return store.tx(() => {
    const { commitment, created } = addCommitment(store, {
      direction: e.direction!, type: e.type!,
      debtor: e.direction === "i_owe" ? "owner" : other.person,
      creditor: e.direction === "i_owe" ? other.person : "owner",
      what: e.what!, objectKind: e.object_kind!, band: band as "open" | "candidate", deadline, features: e.features, evidence: [evidence],
    }, "loop", at);
    if (created) logDetection(store, candidate, true, band, e.features, commitment.id, at);
    return { recorded: "commitment" as const, created, band: band as "open" | "candidate", commitment, ...(other.ambiguous ? { ambiguous: other.ambiguous } : {}) };
  });
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({ args: rest, options: { item: { type: "string" }, json: { type: "string" } } });
    if (cmd !== "record" || !values.item || values.json === undefined) throw new Error("usage: detect.ts record --item I --json '<extraction>'");
    let raw: unknown;
    try {
      raw = JSON.parse(values.json);
    } catch (err) {
      throw new Error(`--json is not valid JSON: ${(err as Error).message}`);
    }
    const candidate = findCandidate(values.item);
    const config = loadConfig();
    return withStore((store) => record(store, candidate, raw, config));
  });
}
