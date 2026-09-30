import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../skills/loop/scripts/db.ts";
import {
  addCommitment, addEvidence, appendEvent, dueBy, eventsOf, findByPerson, getCommitment, listCommitments, project, retain,
  type NewCommitment,
} from "../skills/loop/scripts/ledger.ts";
import { cli, SCRIPTS, tmpHome } from "./helpers.ts";

const AT = "2026-09-28T14:00:00.000Z";

function deck(over: Partial<NewCommitment> = {}): NewCommitment {
  return {
    direction: "i_owe", type: "promise", debtor: "owner",
    creditor: { name: "Michael", handles: ["michael@fund.vc"] },
    what: "send the updated deck", objectKind: "file", band: "open",
    deadline: { kind: "date", at: "2026-09-29T21:00:00.000Z", text: "tomorrow", certainty: "firm" },
    evidence: [{ source: "gmail", item: "gmail:me@owner.co:t1@m1", quote: "I'll send you the updated deck tomorrow", at: AT, author: "owner", thread: "t1" }],
    ...over,
  };
}

function store() {
  return openStore(tmpHome());
}

test("a commitment without evidence is refused", () => {
  const s = store();
  assert.throws(() => addCommitment(s, deck({ evidence: [] })), /at least one evidence/);
  assert.throws(() => addCommitment(s, { ...deck(), evidence: undefined } as unknown as NewCommitment), /at least one evidence/);
  assert.equal(listCommitments(s, ["open", "candidate"]).length, 0);
});

test("an evidence item without a known prefix is refused", () => {
  const s = store();
  for (const item of ["mail:t1@m1", "gmail:t1@m1", "imessage:abc", "plow:onlychat", "https://mail.google.com/x"]) {
    assert.throws(() => addCommitment(s, deck({ evidence: [{ source: "gmail", item, quote: "q", at: AT }] })), /evidence item/, item);
  }
  assert.throws(() => addCommitment(s, deck({ evidence: [{ source: "imessage", item: "gmail:me@owner.co:t1@m1", quote: "q", at: AT }] })), /imessage:<rowid>/);
  assert.ok(addCommitment(s, deck({ evidence: [{ source: "imessage", item: "imessage:4812", quote: "mando amanhã", at: AT }] })).created);
  assert.ok(addCommitment(s, deck({ evidence: [{ source: "plow", item: "plow:cht_1:msg_2", quote: "anota", at: AT }] })).created);
});

test("a quote is cut to 280 characters", () => {
  const s = store();
  const long = "I'll send the deck. ".repeat(40);
  const { commitment } = addCommitment(s, deck({ evidence: [{ source: "gmail", item: "gmail:me@owner.co:t9@m9", quote: long, at: AT }] }));
  const [ev] = s.db.prepare("SELECT quote FROM evidence WHERE commitment_id = ?").all(commitment.id) as { quote: string }[];
  assert.equal(ev!.quote.length, 280);
  assert.ok(long.replace(/\s+/g, " ").startsWith(ev!.quote));
});

test("adding the same (source, item, what) twice is idempotent", () => {
  const s = store();
  const first = addCommitment(s, deck());
  const again = addCommitment(s, deck({ what: "  Send the UPDATED deck!  " }));
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.commitment.id, first.commitment.id);
  assert.equal(listCommitments(s, ["open"]).length, 1);
  assert.equal((s.db.prepare("SELECT count(*) AS n FROM people").get() as { n: number }).n, 2, "no orphan person from the repeat");
  // A different commitment in the same message is a second commitment.
  assert.equal(addCommitment(s, deck({ what: "intro to Sarah", objectKind: "intro" })).created, true);
});

test("deadline_changed moves the derived deadline and keeps the previous one", () => {
  const s = store();
  const { commitment } = addCommitment(s, deck());
  const moved = appendEvent(s, commitment.id, "deadline_changed",
    { deadline: { kind: "date", at: "2026-10-05T21:00:00.000Z", text: "monday" } }, "loop", "2026-09-29T10:00:00.000Z");
  assert.equal(moved.deadline.at, "2026-10-05T21:00:00.000Z");
  assert.equal(moved.deadline.text, "monday");
  const change = eventsOf(s, commitment.id).find((e) => e.kind === "deadline_changed")!;
  assert.equal((change.payload.previous as { at: string }).at, "2026-09-29T21:00:00.000Z");
  // The row is the projection of the events.
  const events = eventsOf(s, commitment.id).map((e) => ({ kind: e.kind, payload: e.payload, actor: e.actor, at: e.at }));
  assert.deepEqual(project(events).deadline, moved.deadline);
});

test("resolved → done, reopened → open, and closing records who closed it", () => {
  const s = store();
  const { commitment } = addCommitment(s, deck());
  const done = appendEvent(s, commitment.id, "resolved", { item: "gmail:me@owner.co:t1@m7" }, "auto");
  assert.equal(done.status, "done");
  assert.deepEqual({ kind: done.closedBy!.kind, actor: done.closedBy!.actor, item: done.closedBy!.item },
    { kind: "resolved", actor: "auto", item: "gmail:me@owner.co:t1@m7" });
  assert.throws(() => appendEvent(s, commitment.id, "resolved"), /cannot apply resolved to a done/);
  const again = appendEvent(s, commitment.id, "reopened", { reason: "not yet" }, "owner");
  assert.equal(again.status, "open");
  assert.equal(again.closedBy, null);
  assert.deepEqual(eventsOf(s, commitment.id).map((e) => e.kind), ["detected", "resolved", "reopened"]);
});

test("a candidate is not listed as open until confirmed; rejected drops it", () => {
  const s = store();
  const c = addCommitment(s, deck({ band: "candidate" })).commitment;
  assert.equal(c.status, "candidate");
  assert.equal(listCommitments(s, ["open"]).length, 0);
  assert.equal(listCommitments(s, ["candidate"]).length, 1);
  assert.equal(appendEvent(s, c.id, "confirmed", {}, "owner").status, "open");
  assert.equal(listCommitments(s, ["open"]).length, 1);
  const other = addCommitment(s, deck({ band: "candidate", what: "call Ana" })).commitment;
  assert.equal(appendEvent(s, other.id, "rejected", { reason: "not a commitment" }, "owner").status, "dropped");
  assert.throws(() => appendEvent(s, other.id, "confirmed"), /cannot apply confirmed/);
});

test("the direction must match who owes: the owner is the debtor of i_owe and the creditor of they_owe", () => {
  const s = store();
  assert.throws(() => addCommitment(s, deck({ debtor: { name: "Lucas", handles: ["+5511988887777"] } })), /i_owe needs debtor/);
  assert.throws(() => addCommitment(s, deck({ direction: "they_owe", type: "request" })), /they_owe needs creditor/);
  const lucas = addCommitment(s, deck({
    direction: "they_owe", type: "request", debtor: { name: "Lucas", handles: ["+55 11 98888-7777"] }, creditor: "owner",
    what: "send the metrics", objectKind: "file",
  })).commitment;
  assert.equal(lucas.debtor.name, "Lucas");
  assert.deepEqual(lucas.debtor.handles, ["+5511988887777"]);
  assert.equal(lucas.creditor.isOwner, true);
});

test("people are matched by handle, never by name alone", () => {
  const s = store();
  const a = addCommitment(s, deck({ creditor: { name: "Pedro", handles: ["pedro@a.com"] }, what: "a" })).commitment;
  const b = addCommitment(s, deck({ creditor: { name: "Pedro", handles: ["pedro@b.com"] }, what: "b" })).commitment;
  const c = addCommitment(s, deck({ creditor: { name: "Pedro Alves", handles: ["PEDRO@a.com"] }, what: "c" })).commitment;
  assert.notEqual(a.creditor.id, b.creditor.id);
  assert.equal(a.creditor.id, c.creditor.id);
  assert.equal(findByPerson(s, "pedro@b.com").length, 1);
  assert.equal(findByPerson(s, "pedro").length, 3);
});

test("due lists open date deadlines up to a time, and snoozed ones whose snooze ended", () => {
  const s = store();
  const a = addCommitment(s, deck()).commitment;
  addCommitment(s, deck({ what: "later", deadline: { kind: "date", at: "2026-10-20T21:00:00.000Z" } }));
  addCommitment(s, deck({ what: "no date", deadline: { kind: "none" } }));
  assert.deepEqual(dueBy(s, "2026-09-30T00:00:00Z").map((c) => c.id), [a.id]);
  appendEvent(s, a.id, "snoozed", { until: "2026-10-02T12:00:00Z" }, "owner");
  assert.deepEqual(dueBy(s, "2026-09-30T00:00:00Z"), []);
  assert.deepEqual(dueBy(s, "2026-10-03T00:00:00Z").map((c) => c.id), [a.id]);
});

test("more evidence on an existing commitment is recorded once", () => {
  const s = store();
  const { commitment } = addCommitment(s, deck());
  const ev = { source: "imessage" as const, item: "imessage:77", quote: "mando o deck amanhã", at: AT, author: "owner" as const };
  assert.equal(addEvidence(s, commitment.id, ev).added, true);
  assert.equal(addEvidence(s, commitment.id, ev).added, false);
  assert.deepEqual(eventsOf(s, commitment.id).map((e) => e.kind), ["detected", "evidence_added"]);
});

test("retention clears quotes of commitments closed more than 90 days ago, and nothing else", () => {
  const s = store();
  const old = addCommitment(s, deck(), "loop", "2026-01-01T00:00:00.000Z").commitment;
  appendEvent(s, old.id, "resolved", {}, "owner", "2026-01-02T00:00:00.000Z");
  const live = addCommitment(s, deck({ what: "still open" }), "loop", "2026-01-01T00:00:00.000Z").commitment;
  assert.deepEqual(retain(s, Date.parse("2026-09-30T00:00:00Z")), { cleared: 1 });
  const quote = (id: number) => (s.db.prepare("SELECT quote FROM evidence WHERE commitment_id = ?").get(id) as { quote: string | null }).quote;
  assert.equal(quote(old.id), null);
  assert.ok(quote(live.id));
  assert.equal(getCommitment(s, old.id).what, "send the updated deck");
});

test("the CLI prints one JSON line, and an error on stderr with a non-zero exit", () => {
  const env = { LOOP_HOME: tmpHome(), LOOP_NOW: AT };
  const added = cli("ledger.ts", ["add", "--json", JSON.stringify(deck())], env);
  assert.equal(added.status, 0, added.stderr);
  assert.equal(added.json.created, true);
  const id = String(added.json.commitment.id);
  assert.equal(cli("ledger.ts", ["event", "--id", id, "--kind", "snoozed", "--json", '{"until":"2026-10-01T00:00:00Z"}', "--actor", "owner"], env).json.commitment.status, "snoozed");
  const got = cli("ledger.ts", ["get", "--id", id], env).json;
  assert.equal(got.evidence[0].item, "gmail:me@owner.co:t1@m1");
  assert.deepEqual(got.events.map((e: { kind: string }) => e.kind), ["detected", "snoozed"]);
  assert.equal(cli("ledger.ts", ["list", "--status", "open,snoozed", "--direction", "i_owe"], env).json.commitments.length, 1);
  assert.equal(cli("ledger.ts", ["find", "--person", "michael@fund.vc"], env).json.commitments.length, 1);
  assert.equal(cli("ledger.ts", ["stats"], env).json.byStatus.snoozed, 1);
  const bad = cli("ledger.ts", ["event", "--id", id, "--kind", "exploded"], env);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /^error: event kind must be one of/);
  assert.equal(bad.stdout, "");
});

// The poll and an owner's DM turn can write at the same moment: each is its
// own process. Two writers, 25 commitments each, none lost.
test("two processes writing at once lose no write", async () => {
  const home = tmpHome();
  const writer = (tag: string) => new Promise<number>((resolve, reject) => {
    const code = `
      import { withStore } from ${JSON.stringify(join(SCRIPTS, "db.ts"))};
      import { addCommitment } from ${JSON.stringify(join(SCRIPTS, "ledger.ts"))};
      for (let i = 0; i < 25; i++) withStore((s) => addCommitment(s, {
        direction: "i_owe", type: "promise", debtor: "owner", creditor: { name: "P", handles: ["p${tag}@x.com"] },
        what: "thing ${tag} " + i, objectKind: "other", band: "open",
        evidence: [{ source: "imessage", item: "imessage:" + (${tag === "a" ? 1000 : 2000} + i), quote: "vou mandar", at: "${AT}" }],
      }));`;
    const proc = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, LOOP_HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    proc.on("exit", (status) => (status === 0 ? resolve(status) : reject(new Error(err))));
  });
  await Promise.all([writer("a"), writer("b")]);
  const s = openStore(home);
  assert.equal(listCommitments(s, ["open"]).length, 50);
  s.close();
});
