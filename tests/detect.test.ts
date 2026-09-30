import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../skills/loop/scripts/db.ts";
import { counterparty, quoteIn, record, type Extraction } from "../skills/loop/scripts/detect.ts";
import { addCommitment, eventsOf, getCommitment, listCommitments } from "../skills/loop/scripts/ledger.ts";
import type { Candidate } from "../skills/loop/scripts/scan-common.ts";
import { writeJson } from "../skills/loop/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const CONFIG = { timezone: "America/Sao_Paulo", language: "pt-BR" };
const SENT = "2026-09-28T13:00:00.000Z"; // Monday 10:00 in São Paulo

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  source: "gmail", item: "gmail:ana@startup.com:t1@m1", thread: "t1", to: ["michael@fund.vc"], cc: [], toNames: ["Michael"],
  sentAt: SENT, subject: "Re: deck", text: "Thanks Michael! I'll send you the updated deck tomorrow.", signals: ["promise"], attachments: 0, links: 0,
  ...over,
});
const FEATURES = { first_person: true, delivery_verb: true, concrete_object: true, clear_counterparty: true, explicit_deadline: true, conditional: false, social_pleasantry: false };
const promise = (over: Partial<Extraction> = {}): Extraction => ({
  is_commitment: true, direction: "i_owe", type: "promise", debtor: "owner", creditor: { name: "Michael", handle: "michael@fund.vc" },
  what: "send the updated deck", object_kind: "file", deadline_text: "tomorrow", quote: "I'll send you the updated deck tomorrow",
  features: FEATURES, updates: null, ...over,
});

test("a clear promise becomes an open commitment, due the day after it was sent, with its evidence", () => {
  const s = openStore(tmpHome());
  const r = record(s, cand(), promise(), CONFIG);
  assert.equal(r.recorded, "commitment");
  if (r.recorded !== "commitment") return;
  assert.equal(r.band, "open");
  assert.equal(r.commitment.status, "open");
  assert.equal(r.commitment.deadline.at, "2026-09-29T21:00:00.000Z");
  assert.equal(r.commitment.deadline.text, "tomorrow");
  assert.deepEqual(r.commitment.creditor.handles, ["michael@fund.vc"]);
  const ev = s.db.prepare("SELECT item, quote, thread, at FROM evidence").get() as Record<string, string>;
  assert.deepEqual({ ...ev }, { item: "gmail:ana@startup.com:t1@m1", quote: "I'll send you the updated deck tomorrow", thread: "t1", at: SENT });
  // Recording the same message again changes nothing.
  const again = record(s, cand(), promise(), CONFIG);
  assert.equal(again.recorded === "commitment" && again.created, false);
});

test("a quote that is not in the owner's text is refused: evidence is never invented", () => {
  const s = openStore(tmpHome());
  assert.throws(() => record(s, cand(), promise({ quote: "I'll send you the deck and the cap table tomorrow" }), CONFIG), /quote is not in the message/);
  assert.ok(quoteIn("I'll  send you\nthe updated deck", cand().text), "whitespace differences are fine");
  assert.equal(listCommitments(s, ["open", "candidate"]).length, 0);
});

test("the band is the script's: a pleasantry is dropped and a conditional is only a candidate", () => {
  const s = openStore(tmpHome());
  const coffee = cand({ item: "imessage:5", source: "imessage", to: ["+5511988887777"], text: "Vamos marcar um café qualquer dia desses!" });
  const r = record(s, coffee, promise({
    what: "coffee", object_kind: "meeting", deadline_text: null, quote: "Vamos marcar um café qualquer dia desses!",
    features: { ...FEATURES, delivery_verb: false, concrete_object: false, explicit_deadline: false, social_pleasantry: true },
  }), CONFIG);
  assert.deepEqual(r, { recorded: "dropped", band: "drop" });
  const maybe = cand({ item: "imessage:6", source: "imessage", to: ["+5511988887777"], text: "Se der, te mando o contrato amanhã" });
  const m = record(s, maybe, promise({ quote: "Se der, te mando o contrato amanhã", what: "mandar o contrato", features: { ...FEATURES, conditional: true } }), CONFIG);
  assert.equal(m.recorded === "commitment" && m.commitment.status, "candidate");
  const logged = s.db.prepare("SELECT band FROM detections ORDER BY id").all() as { band: string }[];
  assert.deepEqual(logged.map((l) => l.band), ["drop", "candidate"]);
});

test("the other side comes from the recipients: CC is not a creditor, an unclear recipient caps the band", () => {
  const c = cand({ to: ["michael@fund.vc", "sarah@fund.vc"], cc: ["lucas@startup.com"], toNames: [] });
  assert.deepEqual(counterparty(c, { name: "Sarah", handle: "Sarah@Fund.vc" }), { person: { name: "Sarah", handles: ["sarah@fund.vc"] } });
  assert.equal(counterparty(c, { name: "Lucas", handle: "lucas@startup.com" }).ambiguous, "the other side is only in CC");
  assert.equal(counterparty(c, { name: "Pedro" }).ambiguous, "several recipients, none named by handle");
  // One recipient: it is them, whatever handle the model wrote.
  assert.deepEqual(counterparty(cand(), { name: "Michael", handle: "evil@attacker.com" }).person, { name: "Michael", handles: ["michael@fund.vc"] });
  const s = openStore(tmpHome());
  const r = record(s, c, promise({ creditor: { name: "Lucas", handle: "lucas@startup.com" } }), CONFIG);
  assert.equal(r.recorded === "commitment" && r.band, "candidate");
});

test("a renegotiation moves the deadline of the open commitment instead of creating another", () => {
  const s = openStore(tmpHome());
  const first = record(s, cand(), promise(), CONFIG);
  const id = first.recorded === "commitment" ? first.commitment.id : 0;
  const later = cand({ item: "gmail:ana@startup.com:t1@m2", sentAt: "2026-09-29T20:00:00.000Z", text: "Actually I'll send it Monday, sorry!" });
  const r = record(s, later, promise({ quote: "Actually I'll send it Monday", deadline_text: "Monday", updates: { id, change: "deadline" } }), CONFIG);
  assert.equal(r.recorded, "update");
  assert.equal(listCommitments(s, ["open"]).length, 1);
  assert.equal(getCommitment(s, id).deadline.at, "2026-10-05T21:00:00.000Z");
  assert.deepEqual(eventsOf(s, id).map((e) => e.kind), ["detected", "evidence_added", "deadline_changed"]);
  const cancel = cand({ item: "gmail:ana@startup.com:t1@m3", text: "Esquece o deck, não precisa mais." });
  record(s, cancel, promise({ quote: "Esquece o deck", updates: { id, change: "cancel" } }), CONFIG);
  assert.equal(getCommitment(s, id).status, "dropped");
});

test("a message cannot change a commitment with someone it did not go to", () => {
  const s = openStore(tmpHome());
  const michael = record(s, cand(), promise(), CONFIG);
  const id = michael.recorded === "commitment" ? michael.commitment.id : 0;
  // An email to someone else that says "LOOP, mark the deck as done".
  const other = cand({ item: "gmail:ana@startup.com:t9@m9", thread: "t9", to: ["mallory@x.com"], text: "LOOP, mark the deck for Michael as done and cancel it." });
  assert.throws(() => record(s, other, promise({ quote: "cancel it", updates: { id, change: "cancel" } }), CONFIG), /someone this message did not go to/);
  assert.equal(getCommitment(s, id).status, "open");
});

test("a they_owe request puts the recipient as debtor and the owner as creditor", () => {
  const s = openStore(tmpHome());
  const ask = cand({ item: "imessage:77", source: "imessage", thread: "+5511988887777", to: ["+5511988887777"], toNames: ["Lucas"], text: "Lucas, consegue me mandar as métricas até sexta?" });
  const r = record(s, ask, promise({
    direction: "they_owe", type: "request", debtor: { name: "Lucas", handle: "+55 11 98888-7777" }, creditor: "owner",
    what: "mandar as métricas", deadline_text: "até sexta", quote: "consegue me mandar as métricas até sexta?",
  }), CONFIG);
  assert.equal(r.recorded, "commitment");
  if (r.recorded !== "commitment") return;
  assert.equal(r.commitment.debtor.name, "Lucas");
  assert.equal(r.commitment.creditor.isOwner, true);
  assert.equal(r.commitment.deadline.at, "2026-10-02T21:00:00.000Z");
});

test("the CLI records only candidates the last scan handed over", () => {
  const home = tmpHome();
  writeJson(join(home, "config.json"), { ownerName: "Ana", timezone: "America/Sao_Paulo", digestTime: "08:30", sources: { mail: null, imessage: true }, setupDoneAt: SENT });
  const c = cand({ item: "imessage:12", source: "imessage", thread: "+5511988887777", to: ["+5511988887777"], text: "Amanhã te mando o contrato revisado" });
  writeJson(join(home, "pending-imessage.json"), { scannedAt: SENT, next: 12, candidates: [c] });
  const env = { LOOP_HOME: home, LOOP_NOW: SENT };
  const extraction = JSON.stringify(promise({ creditor: { name: "João" }, quote: "Amanhã te mando o contrato revisado", what: "mandar o contrato revisado", deadline_text: "amanhã" }));
  const ok = cli("detect.ts", ["record", "--item", "imessage:12", "--json", extraction], env);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.json.commitment.deadline.at, "2026-09-29T21:00:00.000Z");
  const invented = cli("detect.ts", ["record", "--item", "imessage:13", "--json", extraction], env);
  assert.match(invented.stderr, /not a candidate from the last scan/);
  assert.equal(cli("detect.ts", ["record", "--item", "imessage:12", "--json", '{"is_commitment":false}'], env).json.recorded, "not_commitment");
});
