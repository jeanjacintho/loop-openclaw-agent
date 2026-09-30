import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fail, ok } from "../skills/loop/scripts/cursor.ts";
import { openStore, type Store } from "../skills/loop/scripts/db.ts";
import { alerts, item, markAlerted, pick, sent, why } from "../skills/loop/scripts/digest.ts";
import { addCommitment, appendEvent, type NewCommitment } from "../skills/loop/scripts/ledger.ts";
import type { Config } from "../skills/loop/scripts/config.ts";
import { writeJson } from "../skills/loop/scripts/store.ts";
import { cli, tmpHome } from "./helpers.ts";

const CONFIG: Config = {
  ownerName: "Ana", timezone: "America/Sao_Paulo", language: "pt-BR", digestTime: "08:30",
  sources: { mail: null, imessage: true }, setupDoneAt: "2026-09-01T00:00:00Z",
};
// Thursday 1 Oct 2026, 08:30 in São Paulo.
const NOW = Date.parse("2026-10-01T11:30:00Z");
const DAY = 86_400_000;
const eod = (ymd: string) => `${ymd}T21:00:00.000Z`;
let seq = 0;

function setup(): Store {
  const home = tmpHome();
  process.env.LOOP_HOME = home;
  writeJson(join(home, "config.json"), CONFIG);
  return openStore(home);
}

function add(s: Store, over: Partial<NewCommitment> & { due?: string | null }): number {
  const { due, ...rest } = over;
  seq++;
  return addCommitment(s, {
    direction: "i_owe", type: "promise", debtor: "owner", creditor: { name: `P${seq}`, handles: [`p${seq}@x.com`] },
    what: `task${seq}`, objectKind: "other", band: "open",
    deadline: due === null ? { kind: "none" } : { kind: "date", at: due ?? eod("2026-09-29") },
    evidence: [{ source: "imessage", item: `imessage:${1000 + seq}`, quote: `quote ${seq}`, at: "2026-09-25T12:00:00Z" }],
    ...rest,
  }, "loop", "2026-09-25T12:00:00.000Z").commitment.id;
}

test("nothing needs the owner: no message at all", () => {
  const s = setup();
  add(s, { due: eod("2026-10-10") });
  assert.deepEqual(pick(s, CONFIG, NOW), { send: false, items: [] });
});

test("the order is critical, what the owner owes, what they are owed (blockers first), looks done, then at most two candidates; five at most", () => {
  const s = setup();
  const theirs = add(s, { direction: "they_owe", type: "request", debtor: { name: "Lucas", handles: ["lucas@x.com"] }, creditor: "owner", what: "as métricas" });
  const blocker = add(s, { direction: "they_owe", type: "request", debtor: { name: "Rafa", handles: ["rafa@x.com"] }, creditor: "owner", what: "o contrato" });
  const blocked = add(s, { due: eod("2026-10-20"), what: "o update" });
  s.db.prepare("INSERT INTO edges (from_id, to_id, kind) VALUES (?, ?, 'blocks')").run(blocker, blocked);
  const mine = add(s, { what: "o deck" });
  const critical = add(s, { due: eod("2026-10-01"), creditor: { name: "Michael", handles: ["michael@fund.vc"], role: "investor" }, what: "o term sheet" });
  const done = add(s, { due: eod("2026-10-15"), what: "a intro" });
  appendEvent(s, done, "looks_done", { item: "imessage:1" });
  add(s, { band: "candidate", due: eod("2026-10-15") });
  add(s, { band: "candidate", due: eod("2026-10-15") });
  const p = pick(s, CONFIG, NOW);
  assert.equal(p.send, true);
  assert.deepEqual(p.items.map((i) => [i.kind, i.commitmentId]), [
    ["critical", critical], ["i_owe", mine], ["they_owe", blocker], ["they_owe", theirs], ["looks_done", done],
  ]);
  assert.equal(p.text!.split("\n")[0], "🔁 Loop — 5 coisas hoje");
  assert.match(p.text!, /^1\. ⚠️ Michael espera: o term sheet — prazo hoje\.$/m);
  assert.match(p.text!, /^2\. P\d+ espera: o deck — venceu ter\., 29 de set\.\.?$/m);
  assert.match(p.text!, /^4\. Lucas te deve: as métricas/m);
  assert.match(p.text!, /Responda com o número/);
});

test("candidates are asked once; the same items are not sent again for three days unless something is new", () => {
  const s = setup();
  add(s, { what: "o deck" });
  const cand = add(s, { band: "candidate", due: eod("2026-10-15") });
  const first = pick(s, CONFIG, NOW);
  assert.deepEqual(first.items.map((i) => i.kind), ["i_owe", "candidate"]);
  assert.match(first.text!, /"quote \d+" virou compromisso\? \(sim\/não\)/);
  sent(s, NOW);
  assert.equal(item(2).commitmentId, cand);
  const next = pick(s, CONFIG, NOW + DAY);
  assert.equal(next.send, false, "yesterday's items, nothing new");
  assert.deepEqual(next.items.map((i) => i.kind), ["i_owe"], "the candidate is not asked twice");
  assert.equal(pick(s, CONFIG, NOW + 3 * DAY).send, true, "after three days, a reminder");
  add(s, { what: "o contrato" });
  assert.equal(pick(s, CONFIG, NOW + DAY).send, true, "something new");
});

test("snoozed commitments stay out until the snooze ends; 'why' shows the evidence", () => {
  const s = setup();
  const id = add(s, { what: "o deck" });
  appendEvent(s, id, "snoozed", { until: "2026-10-03T12:00:00Z" }, "owner");
  assert.equal(pick(s, CONFIG, NOW).send, false);
  assert.equal(pick(s, CONFIG, NOW + 3 * DAY).items[0]!.commitmentId, id);
  assert.equal(why(s, id).evidence[0]!.quote, `quote ${seq}`);
});

test("critical alerts: once a day per commitment, never at night, and not for what the backfill found", () => {
  const s = setup();
  const id = add(s, { due: eod("2026-10-01"), creditor: { name: "Cliente", handles: ["c@acme.com"], role: "customer" } });
  add(s, { due: eod("2026-10-01") }); // due today, but not to an investor or customer
  const morning = alerts(s, CONFIG, NOW + 2 * 3_600_000);
  assert.deepEqual(morning.alerts.map((a) => a.id), [id]);
  assert.match(morning.alerts[0]!.text, /^🔁 ⚠️ Cliente espera/);
  markAlerted(s, [id], CONFIG, NOW + 2 * 3_600_000);
  assert.deepEqual(alerts(s, CONFIG, NOW + 4 * 3_600_000).alerts, []);
  assert.deepEqual(alerts(s, CONFIG, Date.parse("2026-10-01T01:30:00Z")), { alerts: [], quiet: true }, "22:30 the night before");
  assert.deepEqual(alerts(s, CONFIG, NOW + DAY).alerts, [], "tomorrow it is overdue, for the digest");
});

test("a Mac that is off shows in the digest as the time Loop last read", () => {
  const s = setup();
  add(s, { what: "o deck" });
  ok("imessage", NOW - 10 * 3_600_000);
  fail("imessage", NOW - 9 * 3_600_000);
  const p = pick(s, CONFIG, NOW);
  assert.match(p.offline!, /^Não li mensagens novas desde qua\., 22:30 \(o Mac pode estar desligado\)\.$/);
  assert.ok(p.text!.includes(p.offline!));
});

test("the CLI picks, marks sent, and answers item and why by number", () => {
  const s = setup();
  add(s, { what: "o deck" });
  s.close();
  const env = { LOOP_HOME: process.env.LOOP_HOME!, LOOP_NOW: new Date(NOW).toISOString() };
  const p = cli("digest.ts", ["pick"], env);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.json.send, true);
  assert.match(cli("digest.ts", ["item", "--n", "1"], env).stderr, /no item 1/, "numbers point at a digest only once it is sent");
  assert.deepEqual(cli("digest.ts", ["sent"], env).json, { items: 1 });
  assert.equal(cli("digest.ts", ["why", "--n", "1"], env).json.commitment.what, "o deck");
});
