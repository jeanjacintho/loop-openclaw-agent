// The daily digest and the attention budget (D7): one message a day at most,
// at most five items, and nothing at all when nothing new needs the owner.
// Real time only for what is critical, at most once a day per commitment,
// never between 21:00 and 08:00 in the owner's zone.
//
//   digest.ts pick [--now ISO]        → {send, text?, items, offline?}; remembers the pick
//   digest.ts sent                    → the picked digest went out: numbers now point at its items
//   digest.ts alerts [--now ISO]      → {alerts:[{id, text}]} critical and not yet alerted today
//   digest.ts alerts --sent ID[,ID]   → records that those alerts went out
//   digest.ts item --n N              → what number N of the last digest is
//   digest.ts why --n N | --id X      → the evidence behind it
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { loadConfig, type Config } from "./config.ts";
import { health } from "./cursor.ts";
import { withStore, type Store } from "./db.ts";
import { defaultDeadline } from "./deadline.ts";
import { appendEvent, eventsOf, evidenceOf, getCommitment, listCommitments, type Commitment, type PersonView } from "./ledger.ts";
import { file, nowMs } from "./paths.ts";
import { markAsked, openQuestions } from "./people.ts";
import { readJson, removeFile, writeJson } from "./store.ts";
import { wallParts } from "./time.ts";

export const MAX_ITEMS = 5;
export const MAX_CANDIDATES = 2;
export const QUIET = { from: 21, to: 8 }; // no real-time message in this window
export const REPEAT_AFTER_DAYS = 3; // the same items are not sent again before this
export const STALE_READ_HOURS = 2; // "haven't read new messages since…"
export const NUDGE_WAIT_DAYS = 2; // after the owner chases, the wait starts again

export type Kind = "critical" | "i_owe" | "they_owe" | "looks_done" | "candidate" | "same_person";
export type Item = { n: number; kind: Kind; commitmentId?: number; people?: [number, number]; text: string };
export type DigestPick = { send: boolean; text?: string; items: Item[]; offline?: string };

type Lang = "pt" | "en";
const langOf = (c: Pick<Config, "language">): Lang => ((c.language ?? "").toLowerCase().startsWith("pt") ? "pt" : "en");

const localDay = (ms: number, tz: string) => {
  const p = wallParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
};

// The deadline the digest works with: the one written, or the default for
// its type counted from when it began ("inferred"). None for event deadlines.
export function effectiveDeadline(c: Commitment, tz: string): { at: string; inferred: boolean } | null {
  if (c.deadline.kind === "date" && c.deadline.at) return { at: c.deadline.at, inferred: c.deadline.certainty === "inferred" };
  if (c.deadline.kind === "none") return { at: defaultDeadline(c.type, c.createdAt, tz).at, inferred: true };
  return null;
}

function blocksAnother(store: Store, id: number): boolean {
  return !!store.db.prepare(`SELECT 1 FROM edges e JOIN commitments c ON c.id = e.to_id WHERE e.from_id = ? AND e.kind = 'blocks'
      AND c.status IN ('candidate', 'open', 'snoozed')`).get(id);
}

// Critical = due today and (owed by the owner to an investor or customer, or blocking another commitment).
export function isCritical(store: Store, c: Commitment, now: number, tz: string): boolean {
  if (c.status !== "open") return false;
  const d = effectiveDeadline(c, tz);
  if (!d || d.inferred || localDay(Date.parse(d.at), tz) !== localDay(now, tz)) return false;
  const important = c.direction === "i_owe" && (c.creditor.role === "investor" || c.creditor.role === "customer");
  return important || blocksAnother(store, c.id);
}

// Snoozed commitments count as open once their snooze has ended.
function active(store: Store, now: number): Commitment[] {
  const iso = new Date(now).toISOString();
  return listCommitments(store, ["open", "snoozed"]).filter((c) => c.status === "open" || (c.expectUntil !== null && c.expectUntil <= iso));
}

const nameOf = (p: PersonView) => p.name ?? p.handles[0] ?? "?";

function when(at: string, now: number, tz: string, lang: Lang): string {
  const day = localDay(Date.parse(at), tz);
  const today = localDay(now, tz);
  const tomorrow = localDay(now + 86_400_000, tz);
  const yesterday = localDay(now - 86_400_000, tz);
  if (day === today) return lang === "pt" ? "hoje" : "today";
  if (day === tomorrow) return lang === "pt" ? "amanhã" : "tomorrow";
  if (day === yesterday) return lang === "pt" ? "ontem" : "yesterday";
  return new Intl.DateTimeFormat(lang === "pt" ? "pt-BR" : "en-US", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(at));
}

function dueText(c: Commitment, now: number, tz: string, lang: Lang): string {
  const d = effectiveDeadline(c, tz);
  if (!d) return c.deadline.text ?? "";
  const w = when(d.at, now, tz, lang);
  const late = Date.parse(d.at) < now;
  if (lang === "pt") return `${late ? "venceu" : "prazo"} ${w}${d.inferred ? " (sem prazo dito)" : ""}`;
  return `${late ? "was due" : "due"} ${w}${d.inferred ? " (no deadline given)" : ""}`;
}

function originQuote(store: Store, id: number): string {
  const e = evidenceOf(store, id).find((x) => x.role === "origin");
  return (e?.quote ?? "").slice(0, 120);
}

function line(store: Store, kind: Kind, c: Commitment, now: number, tz: string, lang: Lang): string {
  const draft = c.lastDraftedAt ? (lang === "pt" ? " [rascunho pronto]" : " [draft ready]") : "";
  const due = dueText(c, now, tz, lang);
  switch (kind) {
    case "critical":
    case "i_owe":
      return (kind === "critical" ? "⚠️ " : "") + (lang === "pt"
        ? `${nameOf(c.creditor)} espera: ${c.what} — ${due}.${draft}`
        : `${nameOf(c.creditor)} is waiting for: ${c.what} — ${due}.${draft}`);
    case "they_owe":
      return lang === "pt" ? `${nameOf(c.debtor)} te deve: ${c.what} — ${due}.${draft}` : `${nameOf(c.debtor)} owes you: ${c.what} — ${due}.${draft}`;
    case "looks_done":
      return lang === "pt" ? `Parece feito: ${c.what} (${nameOf(c.direction === "i_owe" ? c.creditor : c.debtor)}). Confirma?` : `Looks done: ${c.what} (${nameOf(c.direction === "i_owe" ? c.creditor : c.debtor)}). Confirm?`;
    case "candidate":
      return lang === "pt" ? `"${originQuote(store, c.id)}" virou compromisso? (sim/não)` : `Is "${originQuote(store, c.id)}" a commitment? (yes/no)`;
    default:
      return "";
  }
}

function looksDone(store: Store, c: Commitment): boolean {
  const events = eventsOf(store, c.id);
  const last = events.findLastIndex((e) => e.kind === "looks_done");
  if (last < 0) return false;
  // Answered since (confirmed, reopened, a new deadline): no longer a question.
  return !events.slice(last + 1).some((e) => ["reopened", "deadline_changed", "confirmed", "resolved", "dropped", "rejected"].includes(e.kind));
}

function asked(store: Store, id: number): boolean {
  return eventsOf(store, id).some((e) => e.kind === "asked");
}

export function pickItems(store: Store, config: Pick<Config, "timezone" | "language">, now: number): Item[] {
  const tz = config.timezone;
  const lang = langOf(config);
  const nowIso = new Date(now).toISOString();
  const live = active(store, now);
  const seen = new Set<number>();
  const out: Omit<Item, "n">[] = [];
  const push = (kind: Kind, c: Commitment) => {
    if (seen.has(c.id) || out.length >= MAX_ITEMS) return;
    seen.add(c.id);
    out.push({ kind, commitmentId: c.id, text: line(store, kind, c, now, tz, lang) });
  };
  const overdue = (c: Commitment) => {
    const d = effectiveDeadline(c, tz);
    return !!d && d.at < nowIso;
  };
  for (const c of live) if (isCritical(store, c, now, tz)) push("critical", c);
  for (const c of live.filter((x) => x.direction === "i_owe" && overdue(x))) push("i_owe", c);
  // After the owner chased it, give the other side a couple of days before listing it again.
  const waiting = (c: Commitment) => c.lastNudgedAt !== null && now - Date.parse(c.lastNudgedAt) < NUDGE_WAIT_DAYS * 86_400_000;
  const theirs = live.filter((x) => x.direction === "they_owe" && overdue(x) && !waiting(x));
  for (const c of [...theirs.filter((x) => blocksAnother(store, x.id)), ...theirs]) push("they_owe", c);
  for (const c of listCommitments(store, ["open", "snoozed", "candidate"]).filter((x) => looksDone(store, x))) push("looks_done", c);
  let candidates = 0;
  for (const c of listCommitments(store, ["candidate"])) {
    if (candidates >= MAX_CANDIDATES || asked(store, c.id)) continue;
    const before = out.length;
    push("candidate", c);
    if (out.length > before) candidates++;
  }
  for (const q of openQuestions(store)) {
    if (out.length >= MAX_ITEMS) break;
    const pair = store.db.prepare("SELECT asked_at FROM person_questions WHERE a_id = ? AND b_id = ?").get(q.a.id, q.b.id) as { asked_at: string | null };
    if (pair.asked_at) continue;
    const who = (p: PersonView) => `${nameOf(p)} (${p.handles[0] ?? "?"})`;
    out.push({ kind: "same_person", people: [q.a.id, q.b.id], text: lang === "pt" ? `${who(q.a)} e ${who(q.b)} são a mesma pessoa? (sim/não)` : `Are ${who(q.a)} and ${who(q.b)} the same person? (yes/no)` });
  }
  return out.map((x, i) => ({ ...x, n: i + 1 }));
}

// "Haven't read new messages since X" when a source the owner turned on is failing or stale.
export function offlineLine(config: Pick<Config, "timezone" | "language" | "sources">, now: number): string | undefined {
  const lang = langOf(config);
  const h = health();
  const on = [...(config.sources.mail ? (["mail"] as const) : []), ...(config.sources.imessage ? (["imessage"] as const) : [])];
  const stale = on.map((s) => h[s]).filter((x) => x.failingSince || (x.lastOkAt && now - Date.parse(x.lastOkAt) > STALE_READ_HOURS * 3_600_000));
  if (!stale.length) return undefined;
  const since = stale.map((x) => x.lastOkAt).filter((x): x is string => !!x).sort()[0];
  const t = since
    ? new Intl.DateTimeFormat(lang === "pt" ? "pt-BR" : "en-US", { timeZone: config.timezone, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(since))
    : undefined;
  if (lang === "pt") return t ? `Não li mensagens novas desde ${t} (o Mac pode estar desligado).` : "Ainda não consegui ler suas mensagens (o Mac pode estar desligado).";
  return t ? `I haven't read new messages since ${t} (your Mac may be off).` : "I haven't been able to read your messages yet (your Mac may be off).";
}

export function render(items: Item[], lang: Lang, offline?: string): string {
  const head = lang === "pt"
    ? `🔁 Loop — ${items.length} ${items.length === 1 ? "coisa" : "coisas"} hoje`
    : `🔁 Loop — ${items.length} ${items.length === 1 ? "thing" : "things"} today`;
  const foot = lang === "pt"
    ? 'Responda com o número: "1 feito", "2 cobra", "3 sexta", "4 não".'
    : 'Reply with the number: "1 done", "2 chase", "3 Friday", "4 no".';
  return [head, ...items.map((i) => `${i.n}. ${i.text}`), ...(offline ? [offline] : []), foot].join("\n");
}

type Last = { at: string; items: Item[] };
const LAST = () => file("digest-last.json");
const PENDING = () => file("digest-pending.json");

const key = (i: Item) => (i.commitmentId !== undefined ? `c${i.commitmentId}:${i.kind}` : `p${i.people!.join("-")}`);

export function pick(store: Store, config: Config, now = nowMs()): DigestPick {
  const items = pickItems(store, config, now);
  const offline = offlineLine(config, now);
  const last = readJson<Last | null>(LAST(), null);
  // Nothing new since the last digest, and it was recent: stay quiet.
  const fresh = !last || now - Date.parse(last.at) >= REPEAT_AFTER_DAYS * 86_400_000
    || items.some((i) => !last.items.some((l) => key(l) === key(i)));
  if (!items.length || !fresh) {
    removeFile(PENDING());
    return { send: false, items, ...(offline ? { offline } : {}) };
  }
  const text = render(items, langOf(config), offline);
  writeJson(PENDING(), { at: new Date(now).toISOString(), items });
  return { send: true, text, items, ...(offline ? { offline } : {}) };
}

// The pick went out: its numbers are what the owner's replies refer to, and
// what it asked is not asked again.
export function sent(store: Store, now = nowMs()): { items: number } {
  const pending = readJson<Last | null>(PENDING(), null);
  if (!pending) throw new Error("no digest was picked; run digest.ts pick first");
  const at = new Date(now).toISOString();
  store.tx(() => {
    for (const i of pending.items) {
      if (i.kind === "candidate" && i.commitmentId !== undefined) appendEvent(store, i.commitmentId, "asked", {}, "loop", at);
      if (i.kind === "same_person" && i.people) markAsked(store, i.people[0], i.people[1], at);
    }
  });
  writeJson(LAST(), { ...pending, at });
  removeFile(PENDING());
  return { items: pending.items.length };
}

export function item(n: number): Item {
  const last = readJson<Last | null>(LAST(), null);
  const found = last?.items.find((i) => i.n === n);
  if (!found) throw new Error(`the last digest has no item ${n}`);
  return found;
}

export function alerts(store: Store, config: Config, now = nowMs()): { alerts: { id: number; text: string }[]; quiet?: true } {
  const hour = wallParts(now, config.timezone).hh;
  if (hour >= QUIET.from || hour < QUIET.to) return { alerts: [], quiet: true };
  const lang = langOf(config);
  const today = localDay(now, config.timezone);
  const out: { id: number; text: string }[] = [];
  for (const c of active(store, now)) {
    if (!isCritical(store, c, now, config.timezone)) continue;
    // Found by the backfill: it goes in the first digest, not in real time.
    const events = eventsOf(store, c.id);
    if (events[0]?.payload.backfill) continue;
    if (events.some((e) => e.kind === "alerted" && e.payload.day === today)) continue;
    out.push({ id: c.id, text: `🔁 ${line(store, "critical", c, now, config.timezone, lang)}` });
  }
  return { alerts: out };
}

export function markAlerted(store: Store, ids: number[], config: Config, now = nowMs()): { alerted: number[] } {
  const day = localDay(now, config.timezone);
  store.tx(() => {
    for (const id of ids) appendEvent(store, id, "alerted", { day }, "loop", new Date(now).toISOString());
  });
  return { alerted: ids };
}

export function why(store: Store, id: number): { commitment: Commitment; evidence: ReturnType<typeof evidenceOf> } {
  return { commitment: getCommitment(store, id), evidence: evidenceOf(store, id) };
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({ args: rest, options: { now: { type: "string" }, sent: { type: "string" }, n: { type: "string" }, id: { type: "string" } } });
    const now = values.now ? Date.parse(values.now) : nowMs();
    if (Number.isNaN(now)) throw new Error(`--now is not a date: ${values.now}`);
    const config = loadConfig();
    return withStore((store) => {
      switch (cmd) {
        case "pick":
          return pick(store, config, now);
        case "sent":
          return sent(store, now);
        case "alerts":
          return values.sent ? markAlerted(store, values.sent.split(",").map(Number), config, now) : alerts(store, config, now);
        case "item":
          return { item: item(Number(values.n)) };
        case "why": {
          const target = values.id ? { commitmentId: Number(values.id) } : item(Number(values.n));
          if (target.commitmentId === undefined) throw new Error("that item is a question about two people, not a commitment");
          return why(store, target.commitmentId);
        }
        default:
          throw new Error("usage: digest.ts pick | sent | alerts [--sent IDS] | item --n N | why --n N|--id X [--now ISO]");
      }
    });
  });
}
