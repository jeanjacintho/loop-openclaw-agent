import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { commit, readCursor, readPending } from "../skills/loop/scripts/cursor.ts";
import { forward as mailForward, parseMailRows, scanMail, SENT_ARGV, type MailCursor } from "../skills/loop/scripts/scan-mail.ts";
import { forward as imForward, scanIMessage, SEARCH_ARGV } from "../skills/loop/scripts/scan-imessage.ts";
import { writeJson } from "../skills/loop/scripts/store.ts";
import { tmpHome } from "./helpers.ts";

const T0 = Date.parse("2026-09-30T12:00:00Z");
const MIN = 60_000;

// A Latch relay in memory: records every argv, answers from `respond`.
function latch(respond: (argv: string[]) => unknown) {
  const calls: string[][] = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    const argv = JSON.parse(String(init.body)).params.arguments.argv as string[];
    calls.push(argv);
    const inner = respond(argv);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(inner) }] } }));
  }) as unknown as typeof globalThis.fetch;
  return { calls, opts: { fetch, token: "t" } };
}
const out = (rows: unknown) => ({ exit_code: 0, output: JSON.stringify(rows) });

function setup(sources: unknown) {
  const home = tmpHome();
  process.env.LOOP_HOME = home;
  writeJson(join(home, "config.json"), {
    ownerName: "Ana", timezone: "America/Sao_Paulo", digestTime: "08:30", sources, setupDoneAt: "2026-09-30T00:00:00Z",
  });
  return home;
}

const mail = (i: number, text: string, over: Record<string, unknown> = {}) => ({
  id: `m${i}`, threadId: `t${i}`, date: new Date(T0 + i * MIN).toISOString(), from: "Ana <ana@startup.com>",
  to: "Michael <michael@fund.vc>", subject: `Re: deck ${i}`, body: text, ...over,
});
const sms = (rowid: number, text: string, over: Record<string, unknown> = {}) => ({
  rowid, is_from_me: 1, handle: "+5511988887777", text, date: new Date(T0 + rowid * MIN).toISOString(), ...over,
});

test("the mail scan asks the Mac with the same argv every time, and never reads history on its first run", async () => {
  setup({ mail: { accounts: ["ana@startup.com"] }, imessage: false });
  let rows = [mail(1, "I'll send the deck tomorrow")];
  const { calls, opts } = latch(() => out(rows));
  const first = await scanMail(opts, T0 + 10 * MIN);
  assert.deepEqual(first.initialized, ["ana@startup.com"]);
  assert.deepEqual(first.candidates, []);
  commit<MailCursor>("mail", mailForward);
  rows = [mail(1, "I'll send the deck tomorrow"), mail(2, "Can you send me the cap table by Friday?")];
  const second = await scanMail(opts, T0 + 20 * MIN);
  assert.deepEqual(second.candidates.map((c) => c.item), ["gmail:ana@startup.com:t2@m2"]);
  assert.deepEqual(calls[0], SENT_ARGV("ana@startup.com"));
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(calls[0], ["plow-gog", "gmail", "search", "in:sent newer_than:2d", "--max", "25", "--json", "--account", "ana@startup.com"]);
});

test("the cursor moves only on commit, and a repeated scan hands over the same items without duplicates", async () => {
  setup({ mail: null, imessage: true });
  let rows = [sms(10, "ok")];
  const { opts } = latch(() => out(rows));
  await scanIMessage(opts, T0);
  commit<number>("imessage", imForward);
  assert.equal(readCursor<number>("imessage").pos, 10);
  rows = [sms(12, "Amanhã te mando o contrato revisado"), sms(11, "valeu"), sms(10, "ok")];
  const a = await scanIMessage(opts, T0 + MIN);
  const b = await scanIMessage(opts, T0 + 2 * MIN);
  assert.equal(readCursor<number>("imessage").pos, 10, "scan never moves the cursor");
  assert.deepEqual(a.candidates.map((c) => c.item), ["imessage:12"]);
  assert.deepEqual(b.candidates, a.candidates);
  assert.equal(readPending("imessage")!.candidates.length, 1);
  assert.equal(a.candidates[0]!.sentAt, new Date(T0 + 12 * MIN).toISOString(), "deadlines are read from when it was sent");
  assert.deepEqual(a.dropped, { too_short: 1 });
  assert.deepEqual(commit<number>("imessage", imForward), { pos: 12, committed: 1 });
  assert.equal(readPending("imessage"), null);
  assert.deepEqual((await scanIMessage(opts, T0 + 3 * MIN)).candidates, []);
});

test("only the owner's messages in direct chats are candidates", async () => {
  setup({ mail: null, imessage: true });
  let rows: unknown[] = [];
  const { opts } = latch(() => out(rows));
  await scanIMessage(opts, T0);
  commit<number>("imessage", imForward);
  rows = [
    sms(1, "Vou te mandar o deck amanhã cedo"),
    sms(2, "Te mando a proposta na sexta sem falta", { is_from_me: 0 }),
    sms(3, "Vou mandar o deck pra todo mundo amanhã", { chat_identifier: "chat123456", is_group: 1 }),
  ];
  const r = await scanIMessage(opts, T0 + MIN);
  assert.deepEqual(r.candidates.map((c) => c.item), ["imessage:1"]);
  assert.deepEqual(r.candidates[0]!.to, ["+5511988887777"]);
  assert.deepEqual(r.dropped, { group: 1 });
});

test("a blocked Latch is degraded, not 'no messages', and the owner is warned once after 30 minutes", async () => {
  setup({ mail: { accounts: ["ana@startup.com"] }, imessage: true });
  const { opts } = latch(() => ({ status: "blocked", message: "Messages access needs approval", owner_action: "Open Latch and allow Terminal to read Messages." }));
  const first = await scanIMessage(opts, T0);
  assert.deepEqual(first.candidates, []);
  assert.equal(first.degraded[0]!.reason, "blocked");
  assert.equal(first.degraded[0]!.ownerAction, "Open Latch and allow Terminal to read Messages.");
  assert.deepEqual(first.failing, { failingSince: new Date(T0).toISOString(), warn: false });
  assert.equal((await scanIMessage(opts, T0 + 20 * MIN)).failing!.warn, false);
  assert.equal((await scanIMessage(opts, T0 + 31 * MIN)).failing!.warn, true);
  assert.equal((await scanIMessage(opts, T0 + 45 * MIN)).failing!.warn, false, "warned once");
  assert.equal(readCursor("imessage").pos, null);
  const m = await scanMail(opts, T0);
  assert.equal(m.degraded[0]!.reason, "blocked");
  assert.equal(m.failing!.warn, false);
});

test("a source that is off never calls the Mac", async () => {
  setup({ mail: null, imessage: true });
  const { calls, opts } = latch(() => out([]));
  assert.equal((await scanMail(opts, T0)).disabled, true);
  setup({ mail: { accounts: ["ana@startup.com"] }, imessage: false });
  assert.equal((await scanIMessage(opts, T0)).disabled, true);
  assert.equal(calls.length, 0);
});

test("at most 40 candidates per poll; the cursor stops at the last one and the rest come next time", async () => {
  setup({ mail: null, imessage: true });
  let rows: unknown[] = [sms(100, "ok")];
  const { opts } = latch(() => out(rows));
  await scanIMessage(opts, T0);
  commit<number>("imessage", imForward);
  rows = Array.from({ length: 50 }, (_, i) => sms(101 + i, `Vou te mandar o item ${i} amanhã`)).reverse();
  const first = await scanIMessage(opts, T0 + MIN);
  assert.equal(first.candidates.length, 40);
  assert.equal(first.candidates[0]!.item, "imessage:101");
  assert.equal(commit<number>("imessage", imForward).pos, 140);
  const second = await scanIMessage(opts, T0 + 2 * MIN);
  assert.deepEqual(second.candidates.map((c) => c.item), Array.from({ length: 10 }, (_, i) => `imessage:${141 + i}`));
});

test("mail without a body is read from subject and snippet, and the scan says so", async () => {
  setup({ mail: { accounts: ["ana@startup.com"] }, imessage: false });
  let rows: unknown[] = [];
  const { opts } = latch(() => out({ threads: rows }));
  await scanMail(opts, T0);
  commit<MailCursor>("mail", mailForward);
  rows = [
    mail(1, "", { body: undefined, subject: "Deck", snippet: "I'll send you the updated deck tomorrow morning" }),
    mail(2, "I'll send the minutes tomorrow", { to: "ana@startup.com" }),
    mail(3, "Vou mandar o relatório amanhã", { listId: "<all.startup.com>" }),
  ];
  const r = await scanMail(opts, T0 + 10 * MIN);
  assert.deepEqual(r.candidates.map((c) => c.text), ["Deck\nI'll send you the updated deck tomorrow morning"]);
  assert.deepEqual(r.dropped, { self_recipient: 1, mailing_list: 1 });
  assert.equal(r.degraded.find((d) => d.reason === "mail-no-body")!.detail!.startsWith("1 sent"), true);
});

test("mail rows are parsed from the shapes the tools print, and the cursor never moves back", () => {
  const { rows, unreadable } = parseMailRows(JSON.stringify([
    { id: "b", thread_id: "t", internalDate: String(T0), from: "a@x.com", to: ["B <b@y.com>", "c@z.com"], cc: "d@w.com", subject: "s", text: "hi" },
    { id: "a", threadId: "t", date: "Wed, 30 Sep 2026 11:00:00 +0000", from: "a@x.com", to: "b@y.com", subject: "s", snippet: "x" },
    { subject: "no id" },
  ]));
  assert.equal(unreadable, 1);
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  assert.deepEqual(rows[1]!.to, ["b@y.com", "c@z.com"]);
  assert.deepEqual(rows[1]!.cc, ["d@w.com"]);
  assert.equal(rows[0]!.body, null);
  assert.throws(() => mailForward({ x: { at: "2026-10-01T00:00:00.000Z", ids: [] } }, { x: { at: "2026-09-01T00:00:00.000Z", ids: [] } }), /never moves back/);
  assert.throws(() => imForward(10, 9), /never moves back/);
  assert.deepEqual(SEARCH_ARGV, ["plow-messages", "search", "--limit", "200", "--order", "desc"]);
});
