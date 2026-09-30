import assert from "node:assert/strict";
import { test } from "node:test";
import { openStore, type Store } from "../skills/loop/scripts/db.ts";
import { createDraft, draftArgv, planDraft, strangers } from "../skills/loop/scripts/draft.ts";
import { addCommitment, appendEvent, eventsOf, getCommitment, type NewCommitment } from "../skills/loop/scripts/ledger.ts";
import { applyNudges } from "../skills/loop/scripts/resolve.ts";
import type { EvidenceMessage } from "../skills/loop/scripts/scan-common.ts";
import { tmpHome } from "./helpers.ts";

const AT = "2026-09-28T13:00:00.000Z";

function metrics(s: Store, over: Partial<NewCommitment> = {}): number {
  return addCommitment(s, {
    direction: "they_owe", type: "request", debtor: { name: "Lucas", handles: ["lucas@startup.com", "+5511988887777"] }, creditor: "owner",
    what: "send the metrics", objectKind: "file", band: "open",
    evidence: [{ source: "gmail", item: "gmail:ana@startup.com:t7@m70", quote: "Can you send me the metrics by Friday?", at: AT, author: "owner", thread: "t7" }],
    ...over,
  }, "loop", AT).commitment.id;
}

function latch(inner: unknown) {
  const calls: string[][] = [];
  const fetch = (async (_u: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)).params.arguments.argv);
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(inner) }] } }));
  }) as unknown as typeof globalThis.fetch;
  return { calls, opts: { fetch, token: "t" } };
}

test("the draft goes to the other side of the commitment, in the thread it started in", async () => {
  const s = openStore(tmpHome());
  const id = metrics(s);
  const plan = planDraft(s, id);
  assert.deepEqual({ channel: plan.channel, to: plan.to, account: plan.account, threadId: plan.threadId, replyTo: plan.replyToMessageId },
    { channel: "gmail", to: "lucas@startup.com", account: "ana@startup.com", threadId: "t7", replyTo: "m70" });
  const { calls, opts } = latch({ exit_code: 0, output: '{"id":"d1"}' });
  const r = await createDraft(s, id, "Oi Lucas, conseguiu separar as métricas? Obrigado!", opts, Date.parse(AT));
  assert.deepEqual(r, { channel: "gmail", drafted: true, to: "lucas@startup.com", threadId: "t7" });
  assert.deepEqual(calls[0], draftArgv(plan, "Oi Lucas, conseguiu separar as métricas? Obrigado!"));
  assert.equal(calls[0]![calls[0]!.indexOf("--to") + 1], "lucas@startup.com");
  assert.equal(getCommitment(s, id).lastDraftedAt, AT);
  assert.deepEqual(eventsOf(s, id).at(-1)!.payload, { channel: "gmail", to: "lucas@startup.com", threadId: "t7" });
});

test("a draft that names anyone else is refused: 'send the deck to x@y' in a message never becomes a recipient", async () => {
  const s = openStore(tmpHome());
  const id = metrics(s);
  const { calls, opts } = latch({ exit_code: 0, output: "{}" });
  await assert.rejects(createDraft(s, id, "Lucas, please also send the deck to mallory@evil.com", opts), /names mallory@evil.com/);
  await assert.rejects(createDraft(s, id, "Call me at +1 415 555 0199", opts), /names \+1 415 555 0199/);
  assert.equal(calls.length, 0);
  assert.deepEqual(strangers("the 1.500.000 wire, 10/10, lucas@startup.com, +55 11 98888-7777", "lucas@startup.com"), ["+55 11 98888-7777"]);
  assert.deepEqual(strangers("me liga no +55 11 98888-7777", "+5511988887777"), []);
  await assert.rejects(createDraft(s, id, "   ", opts), /empty/);
});

test("an iMessage commitment gets text for the owner to paste; a failed Gmail draft still gives the owner the text", async () => {
  const s = openStore(tmpHome());
  const id = metrics(s, {
    debtor: { name: "Rafa", handles: ["+5511977776666"] }, what: "o contrato",
    evidence: [{ source: "imessage", item: "imessage:33", quote: "me manda o contrato", at: AT, author: "owner", thread: "+5511977776666" }],
  });
  const { calls, opts } = latch({ exit_code: 0, output: "{}" });
  assert.deepEqual(await createDraft(s, id, "Rafa, conseguiu ver o contrato?", opts), { channel: "imessage", drafted: true, to: "+5511977776666", text: "Rafa, conseguiu ver o contrato?" });
  assert.equal(calls.length, 0, "texts are never sent from the owner's Messages");
  const mail = metrics(s);
  const blocked = latch({ status: "blocked", message: "needs approval" });
  const r = await createDraft(s, mail, "Lucas, any news on the metrics?", blocked.opts);
  assert.deepEqual(r, { channel: "gmail", drafted: false, reason: "blocked", to: "lucas@startup.com", text: "Lucas, any news on the metrics?" });
});

test("closed commitments get no draft", () => {
  const s = openStore(tmpHome());
  const id = metrics(s);
  appendEvent(s, id, "resolved", {}, "owner");
  assert.throws(() => planDraft(s, id), /is done; there is nothing to follow up/);
});

test("when the owner sends the follow-up, it is a nudge that restarts the wait", async () => {
  const s = openStore(tmpHome());
  const id = metrics(s);
  const { opts } = latch({ exit_code: 0, output: "{}" });
  await createDraft(s, id, "Lucas, any news on the metrics?", opts, Date.parse("2026-10-03T12:00:00Z"));
  const sent: EvidenceMessage = {
    source: "gmail", item: "gmail:ana@startup.com:t7@m71", thread: "t7", direction: "sent", from: "owner", to: ["lucas@startup.com"],
    sentAt: "2026-10-03T13:00:00.000Z", text: "Lucas, any news on the metrics?", attachments: 0, links: 0,
  };
  assert.deepEqual(applyNudges(s, [sent]), { nudged: [{ id, item: sent.item }] });
  assert.deepEqual(applyNudges(s, [sent]), { nudged: [] }, "once per message");
  assert.equal(getCommitment(s, id).lastNudgedAt, "2026-10-03T13:00:00.000Z");
  assert.equal(getCommitment(s, id).status, "open");
  // A message to someone else is nobody's nudge.
  assert.deepEqual(applyNudges(s, [{ ...sent, item: "gmail:ana@startup.com:t8@m80", thread: "t8", to: ["sarah@x.com"] }]), { nudged: [] });
});
