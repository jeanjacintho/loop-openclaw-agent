// What the owner tells Loop about its commitments, in their DM. Every
// command writes one event as the owner; "not a commitment" also feeds the
// calibration (ledger.ts calibrate).
//
//   feedback.ts done     --id X            it happened
//   feedback.ts not      --id X            not a commitment (rejected; counts against its band)
//   feedback.ts yes      --id X            a candidate is a real commitment
//   feedback.ts reopen   --id X            "no, not yet": closed by mistake
//   feedback.ts postpone --id X --text T   new deadline, in their words ("sexta", "dia 10")
//   feedback.ts snooze   --id X --text T   leave it alone until then
//   feedback.ts ignore   --id X --by kind|person   stop tracking this kind of thing / this person
//   feedback.ts note     --chat U --text T --json '<what they said>'   "anota: prometi X pro Y até Z"
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { loadConfig, type Config } from "./config.ts";
import { withStore, type Store } from "./db.ts";
import { resolveDeadline } from "./deadline.ts";
import { quoteIn } from "./detect.ts";
import { isEmail, isPhone, normalizeHandle } from "./handles.ts";
import {
  addCommitment, appendEvent, calibrate, getCommitment, OBJECT_KINDS, TYPES,
  type Commitment, type CommitmentType, type Deadline, type ObjectKind, type PersonInput,
} from "./ledger.ts";
import { nowMs } from "./paths.ts";
import { enrich } from "./people.ts";

const iso = (ms: number) => new Date(ms).toISOString();

function deadlineFrom(text: string, config: Pick<Config, "timezone" | "language">, now: number): Partial<Deadline> {
  const r = resolveDeadline({ text, sentAt: iso(now), tz: config.timezone, locale: config.language });
  if (r.kind === "date") return { kind: "date", at: r.at, text: r.text, certainty: r.certainty };
  if (r.kind === "event") return { kind: "event", event: r.event, text: r.text };
  throw new Error(`"${text}" is not a day Loop can read; ask the owner for a day or a date`);
}

export function done(store: Store, id: number, now = nowMs()): Commitment {
  return appendEvent(store, id, "resolved", {}, "owner", iso(now));
}

export function notACommitment(store: Store, id: number, now = nowMs()) {
  const c = getCommitment(store, id);
  const commitment = appendEvent(store, id, "rejected", { reason: "not a commitment", band: c.band, features: c.features }, "owner", iso(now));
  return { commitment, calibration: calibrate(store, iso(now)) };
}

export function yes(store: Store, id: number, now = nowMs()): Commitment {
  return appendEvent(store, id, "confirmed", {}, "owner", iso(now));
}

export function reopen(store: Store, id: number, now = nowMs()): Commitment {
  return appendEvent(store, id, "reopened", { reason: "owner" }, "owner", iso(now));
}

export function postpone(store: Store, id: number, text: string, config: Pick<Config, "timezone" | "language">, now = nowMs()): Commitment {
  return appendEvent(store, id, "deadline_changed", { deadline: deadlineFrom(text, config, now) }, "owner", iso(now));
}

export function snooze(store: Store, id: number, text: string, config: Pick<Config, "timezone" | "language">, now = nowMs()): Commitment {
  const d = deadlineFrom(text, config, now);
  if (d.kind !== "date") throw new Error("a snooze needs a day");
  return appendEvent(store, id, "snoozed", { until: d.at }, "owner", iso(now));
}

export type Rule = { objectKind: ObjectKind | null; type: CommitmentType | null; personId: number | null };

export function ignore(store: Store, id: number, by: "kind" | "person", now = nowMs()) {
  const c = getCommitment(store, id);
  const other = c.direction === "i_owe" ? c.creditor : c.debtor;
  const rule: Rule = by === "kind" ? { objectKind: c.objectKind, type: c.type, personId: null } : { objectKind: null, type: null, personId: other.id };
  return store.tx(() => {
    store.db.prepare("INSERT INTO ignore_rules (object_kind, type, person_id, created_at) VALUES (?, ?, ?, ?)").run(rule.objectKind, rule.type, rule.personId, iso(now));
    const commitment = ["candidate", "open", "snoozed"].includes(c.status)
      ? appendEvent(store, id, "rejected", { reason: `ignore ${by}`, band: c.band, features: c.features }, "owner", iso(now))
      : c;
    return { rule, commitment };
  });
}

export function ignored(store: Store, c: { objectKind: string; type: string; personId: number | null }): boolean {
  const rules = store.db.prepare("SELECT object_kind, type, person_id FROM ignore_rules").all() as { object_kind: string | null; type: string | null; person_id: number | null }[];
  return rules.some((r) => (r.person_id !== null ? r.person_id === c.personId
    : (r.object_kind === null || r.object_kind === c.objectKind) && (r.type === null || r.type === c.type)));
}

export type Note = {
  direction: "i_owe" | "they_owe";
  type: CommitmentType;
  person: { name?: string; handle?: string };
  what: string;
  object_kind: ObjectKind;
  deadline_text?: string | null;
  quote: string;
};

// The owner's own words in their DM are a fact, not a guess: the commitment
// is open, with the note itself as evidence (source plow).
export function note(store: Store, chat: string, text: string, raw: Note, config: Pick<Config, "timezone" | "language" | "domainRoles">, now = nowMs()) {
  if (!raw || typeof raw !== "object") throw new Error("the note must be a JSON object");
  if (raw.direction !== "i_owe" && raw.direction !== "they_owe") throw new Error("direction must be i_owe or they_owe");
  if (!TYPES.includes(raw.type)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
  if (!OBJECT_KINDS.includes(raw.object_kind)) throw new Error(`object_kind must be one of ${OBJECT_KINDS.join(", ")}`);
  if (!quoteIn(raw.quote ?? "", text)) throw new Error("the quote is not in the owner's message; quote their words exactly");
  const handle = raw.person?.handle && (isEmail(raw.person.handle) || isPhone(raw.person.handle)) ? normalizeHandle(raw.person.handle) : undefined;
  if (!handle && !raw.person?.name?.trim()) throw new Error("say who it is with: a name, and an email or phone when the owner gave one");
  const other: PersonInput = enrich({ ...(raw.person.name?.trim() ? { name: raw.person.name.trim() } : {}), handles: handle ? [handle] : [] }, undefined, config.domainRoles);
  if (!/^[^\s:]+$/.test(chat)) throw new Error(`--chat must be the chat uid, got ${chat}`);
  const deadline = raw.deadline_text ? deadlineFrom(raw.deadline_text, config, now) : { kind: "none" as const };
  return addCommitment(store, {
    direction: raw.direction, type: raw.type,
    debtor: raw.direction === "i_owe" ? "owner" : other, creditor: raw.direction === "i_owe" ? other : "owner",
    what: raw.what, objectKind: raw.object_kind, band: "open", deadline,
    evidence: [{ source: "plow", item: `plow:${chat}:${now}`, quote: raw.quote, at: iso(now), author: "owner", thread: chat }],
  }, "owner", iso(now));
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({
      args: rest,
      options: { id: { type: "string" }, text: { type: "string" }, by: { type: "string" }, chat: { type: "string" }, json: { type: "string" } },
    });
    const id = () => {
      if (!values.id || !/^\d+$/.test(values.id)) throw new Error(`${cmd} needs --id <commitment id>`);
      return Number(values.id);
    };
    const text = () => {
      if (!values.text?.trim()) throw new Error(`${cmd} needs --text`);
      return values.text;
    };
    return withStore((store) => {
      switch (cmd) {
        case "done": return { commitment: done(store, id()) };
        case "not": return notACommitment(store, id());
        case "yes": return { commitment: yes(store, id()) };
        case "reopen": return { commitment: reopen(store, id()) };
        case "postpone": return { commitment: postpone(store, id(), text(), loadConfig()) };
        case "snooze": return { commitment: snooze(store, id(), text(), loadConfig()) };
        case "ignore": {
          if (values.by !== "kind" && values.by !== "person") throw new Error("ignore needs --by kind|person");
          return ignore(store, id(), values.by);
        }
        case "note": {
          if (!values.chat || values.json === undefined) throw new Error("note needs --chat <uid> --text <their message> --json '<note>'");
          let raw: Note;
          try {
            raw = JSON.parse(values.json);
          } catch (err) {
            throw new Error(`--json is not valid JSON: ${(err as Error).message}`);
          }
          return note(store, values.chat, text(), raw, loadConfig());
        }
        default:
          throw new Error("usage: feedback.ts done|not|yes|reopen --id X | postpone|snooze --id X --text T | ignore --id X --by kind|person | note --chat U --text T --json J");
      }
    });
  });
}
