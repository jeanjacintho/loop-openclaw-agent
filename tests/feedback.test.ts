import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore, type Store } from "../skills/loop/scripts/db.ts";
import { record } from "../skills/loop/scripts/detect.ts";
import { done, ignore, note, notACommitment, postpone, reopen, snooze, yes } from "../skills/loop/scripts/feedback.ts";
import { addCommitment, calibrate, eventsOf, getCommitment, stats, type NewCommitment } from "../skills/loop/scripts/ledger.ts";
import type { Candidate } from "../skills/loop/scripts/scan-common.ts";
import { tmpHome } from "./helpers.ts";

const CONFIG = { timezone: "America/Sao_Paulo", language: "pt-BR", domainRoles: {} };
const NOW = Date.parse("2026-09-30T13:00:00Z"); // Wednesday 10:00 in São Paulo
const FEATURES = { first_person: true, delivery_verb: true, concrete_object: true, clear_counterparty: true, explicit_deadline: true, conditional: false, social_pleasantry: false };
let n = 0;

function add(s: Store, over: Partial<NewCommitment> = {}): number {
  n++;
  return addCommitment(s, {
    direction: "i_owe", type: "promise", debtor: "owner", creditor: { name: `P${n}`, handles: [`p${n}@x.com`] },
    what: `task${n}`, objectKind: "other", band: "open", features: FEATURES,
    evidence: [{ source: n % 2 ? "gmail" : "imessage", item: n % 2 ? `gmail:ana@x.com:t${n}@m${n}` : `imessage:${n}`, quote: "q", at: "2026-09-28T13:00:00Z" }],
    ...over,
  }).commitment.id;
}

test("done, yes, reopen, postpone and snooze each write one owner event", () => {
  const s = openStore(tmpHome());
  const a = add(s);
  assert.equal(done(s, a, NOW).status, "done");
  assert.equal(reopen(s, a, NOW).status, "open");
  const moved = postpone(s, a, "sexta", CONFIG, NOW);
  assert.equal(moved.deadline.at, "2026-10-02T21:00:00.000Z", "the owner's 'sexta' is read from now");
  assert.equal(snooze(s, a, "semana que vem", CONFIG, NOW).expectUntil, "2026-10-05T21:00:00.000Z");
  assert.throws(() => postpone(s, a, "quando der", CONFIG, NOW), /not a day Loop can read/);
  const c = add(s, { band: "candidate" });
  assert.equal(yes(s, c, NOW).status, "open");
  assert.deepEqual(eventsOf(s, a).filter((e) => e.actor === "owner").map((e) => e.kind), ["resolved", "reopened", "deadline_changed", "snoozed"]);
});

test("'not a commitment' keeps the features, and stats show precision by band and by source", () => {
  const s = openStore(tmpHome());
  const bad = add(s);
  const r = notACommitment(s, bad, NOW);
  assert.equal(r.commitment.status, "dropped");
  assert.deepEqual(eventsOf(s, bad).at(-1)!.payload.features, FEATURES);
  done(s, add(s), NOW);
  done(s, add(s), NOW);
  yes(s, add(s, { band: "candidate" }), NOW);
  const p = stats(s).precision as { byBand: Record<string, { precision: number }>; bySource: Record<string, { decisions: number }> };
  assert.equal(p.byBand.open!.precision, 0.67);
  assert.equal(p.byBand.candidate!.precision, 1);
  assert.deepEqual(Object.keys(p.bySource).sort(), ["gmail", "imessage"]);
});

test("below 0.8 over the last 20 open verdicts, the open cut rises one step, once, and then counts afresh", () => {
  const s = openStore(tmpHome());
  let last: ReturnType<typeof notACommitment>["calibration"] | undefined;
  for (let i = 0; i < 15; i++) done(s, add(s), NOW + i);
  for (let i = 0; i < 4; i++) last = notACommitment(s, add(s), NOW + 100 + i).calibration;
  assert.equal(last!.raised, false, "19 verdicts: not enough yet");
  last = notACommitment(s, add(s), NOW + 200).calibration;
  assert.deepEqual(last, { raised: true, raise: 1, precision: 0.75, decisions: 20 });
  assert.equal(notACommitment(s, add(s), NOW + 300).calibration.raised, false, "the next raise needs 20 new verdicts");
  assert.equal(calibrate(s).raise, 1);
  // A detection that used to be open (score 7) is now only a candidate.
  const cand: Candidate = {
    source: "imessage", item: "imessage:9999", thread: "+5511900000000", to: ["+5511900000000"], cc: [], toNames: [], sentAt: "2026-09-30T12:00:00Z",
    text: "Te mando o contrato", signals: ["promise"], attachments: 0, links: 0,
  };
  const r = record(s, cand, {
    is_commitment: true, direction: "i_owe", type: "promise", debtor: "owner", creditor: { name: "X" }, what: "mandar o contrato",
    object_kind: "file", deadline_text: null, quote: "Te mando o contrato", features: { ...FEATURES, explicit_deadline: false },
  }, CONFIG);
  assert.equal(r.recorded === "commitment" && r.band, "candidate");
});

test("'ignore this kind' drops the commitment and every later one like it", () => {
  const s = openStore(tmpHome());
  const intro = add(s, { objectKind: "intro", type: "promise", what: "intro to Sarah" });
  assert.equal(ignore(s, intro, "kind", NOW).commitment.status, "dropped");
  const cand: Candidate = {
    source: "imessage", item: "imessage:777", thread: "+5511911112222", to: ["+5511911112222"], cc: [], toNames: [], sentAt: "2026-09-30T12:00:00Z",
    text: "Te apresento pro Pedro amanhã", signals: ["promise"], attachments: 0, links: 0,
  };
  const r = record(s, cand, {
    is_commitment: true, direction: "i_owe", type: "promise", debtor: "owner", creditor: { name: "Ana" }, what: "apresentar o Pedro",
    object_kind: "intro", deadline_text: "amanhã", quote: "Te apresento pro Pedro amanhã", features: FEATURES,
  }, CONFIG);
  assert.deepEqual(r, { recorded: "dropped", band: "drop", ignored: true });
  const pedro = add(s, { creditor: { name: "Pedro", handles: ["pedro@x.com"] } });
  ignore(s, pedro, "person", NOW);
  assert.equal(getCommitment(s, add(s, { objectKind: "file" })).status, "open", "other people and kinds are still tracked");
});

test("'anota: prometi X pro Y até Z' is an open commitment with the note as evidence", () => {
  const s = openStore(tmpHome());
  const text = "anota: prometi o deck pro Michael (michael@fund.vc) até sexta";
  const r = note(s, "cht_owner", text, {
    direction: "i_owe", type: "promise", person: { name: "Michael", handle: "michael@fund.vc" }, what: "mandar o deck", object_kind: "file",
    deadline_text: "até sexta", quote: "prometi o deck pro Michael",
  }, CONFIG, NOW);
  assert.equal(r.commitment.status, "open");
  assert.equal(r.commitment.deadline.at, "2026-10-02T21:00:00.000Z");
  assert.deepEqual(r.commitment.creditor.handles, ["michael@fund.vc"]);
  assert.equal((s.db.prepare("SELECT item FROM evidence").get() as { item: string }).item, `plow:cht_owner:${NOW}`);
  assert.throws(() => note(s, "cht_owner", text, {
    direction: "i_owe", type: "promise", person: { name: "Michael" }, what: "x", object_kind: "file", quote: "prometi tudo pro Michael",
  }, CONFIG, NOW), /quote is not in the owner's message/);
});
