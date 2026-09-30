import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { finish, IMESSAGE_ARGV, mailArgv, runBackfill, summary } from "../skills/loop/scripts/backfill.ts";
import type { Config } from "../skills/loop/scripts/config.ts";
import { readPending } from "../skills/loop/scripts/cursor.ts";
import { openStore } from "../skills/loop/scripts/db.ts";
import { record } from "../skills/loop/scripts/detect.ts";
import { alerts, item, pick } from "../skills/loop/scripts/digest.ts";
import { eventsOf, getCommitment } from "../skills/loop/scripts/ledger.ts";
import { judge, pairsFor, pendingEvidence } from "../skills/loop/scripts/resolve.ts";
import { writeJson } from "../skills/loop/scripts/store.ts";
import { tmpHome } from "./helpers.ts";

const CONFIG: Config = {
  ownerName: "Ana", timezone: "America/Sao_Paulo", language: "pt-BR", digestTime: "08:30",
  sources: { mail: { accounts: ["ana@startup.com"] }, imessage: true }, setupDoneAt: "2026-09-30T12:00:00Z",
};
const NOW = Date.parse("2026-09-30T13:00:00Z"); // Wednesday 10:00 in São Paulo
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const FEATURES = { first_person: true, delivery_verb: true, concrete_object: true, clear_counterparty: true, explicit_deadline: true, conditional: false, social_pleasantry: false };

function mac(respond: (argv: string[]) => unknown[]) {
  const calls: string[][] = [];
  const fetch = (async (_u: string, init: RequestInit) => {
    const argv = JSON.parse(String(init.body)).params.arguments.argv as string[];
    calls.push(argv);
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: JSON.stringify(respond(argv)) }) }] } }));
  }) as unknown as typeof globalThis.fetch;
  return { calls, opts: { fetch, token: "t" } };
}

function setup() {
  const home = tmpHome();
  process.env.LOOP_HOME = home;
  writeJson(join(home, "config.json"), CONFIG);
  return home;
}

const SENT = [
  { id: "m1", threadId: "t1", date: ago(10), from: "ana@startup.com", to: "Michael <michael@fund.vc>", subject: "deck", body: "Te mando o deck atualizado amanhã." },
  { id: "m0", threadId: "t0", date: ago(20), from: "ana@startup.com", to: "old@x.com", subject: "old", body: "Vou mandar a proposta amanhã." },
  { id: "m2", threadId: "t2", date: ago(5), from: "ana@startup.com", to: "sarah@acme.com", subject: "hi", body: "Obrigada pela conversa de hoje." },
];

test("the look-back reads 14 days once, with the owner present, and hands over only the owner's commitment candidates", async () => {
  setup();
  const { calls, opts } = mac((argv) => (argv.includes("in:sent newer_than:14d") ? SENT : []));
  const r = await runBackfill(opts, NOW);
  assert.deepEqual(calls, [mailArgv("ana@startup.com", "sent"), mailArgv("ana@startup.com", "inbox"), IMESSAGE_ARGV]);
  assert.deepEqual(r.candidates.map((c) => [c.item, c.backfill]), [["gmail:ana@startup.com:t1@m1", true]]);
  assert.deepEqual(r.dropped, { no_commitment_phrase: 1 });
  assert.equal(r.read, 2, "the 20-day-old message is outside the window");
});

test("at most 150 sent messages, the newest", async () => {
  setup();
  const rows = Array.from({ length: 160 }, (_, i) => ({ rowid: i + 1, is_from_me: 1, handle: "+5511988887777", text: `Vou te mandar o item ${i} amanhã`, date: ago(13 - i * 0.05) }));
  const { opts } = mac((argv) => (argv[0] === "plow-messages" ? rows : []));
  const r = await runBackfill(opts, NOW);
  assert.equal(r.read, 150);
  assert.equal(r.dropped.over_cap, 10);
  assert.equal(r.candidates[0]!.item, "imessage:11");
});

test("an old 'amanhã' is overdue, never a real-time alert; a delivery later in the window closes it; the summary says so", async () => {
  const home = setup();
  const deliveredLater = [
    ...SENT,
    { id: "m3", threadId: "t3", date: ago(9), from: "ana@startup.com", to: "lucas@startup.com", subject: "metrics", body: "Lucas, consegue me mandar as métricas até sexta passada?" },
    { id: "m4", threadId: "t1", date: ago(8), from: "ana@startup.com", to: "michael@fund.vc", subject: "Re: deck", body: "Segue o deck!", attachments: [{}] },
  ];
  const { opts } = mac((argv) => (argv.includes("in:sent newer_than:14d") ? deliveredLater : []));
  const r = await runBackfill(opts, NOW);
  const s = openStore(home);
  const deck = record(s, r.candidates.find((c) => c.item.endsWith("@m1"))!, {
    is_commitment: true, direction: "i_owe", type: "promise", debtor: "owner", creditor: { name: "Michael", handle: "michael@fund.vc" },
    what: "mandar o deck atualizado", object_kind: "file", deadline_text: "amanhã", quote: "Te mando o deck atualizado amanhã.", features: FEATURES,
  }, CONFIG, new Date(NOW).toISOString());
  const metrics = record(s, r.candidates.find((c) => c.item.endsWith("@m3"))!, {
    is_commitment: true, direction: "they_owe", type: "request", debtor: { name: "Lucas", handle: "lucas@startup.com" }, creditor: "owner",
    what: "mandar as métricas", object_kind: "file", deadline_text: "sexta", quote: "consegue me mandar as métricas", features: FEATURES,
  }, CONFIG, new Date(NOW).toISOString());
  const deckId = deck.recorded === "commitment" ? deck.commitment.id : 0;
  const metricsId = metrics.recorded === "commitment" ? metrics.commitment.id : 0;
  assert.equal(getCommitment(s, deckId).deadline.at, `${ago(9).slice(0, 10)}T21:00:00.000Z`, "tomorrow from when it was sent");
  assert.equal(eventsOf(s, deckId)[0]!.payload.backfill, true);
  // The deck went out two days later, in the same thread, with the file.
  const pairs = pairsFor(s, pendingEvidence());
  assert.deepEqual(pairs.map((p) => [p.commitment.id, p.message.item]), [[deckId, "gmail:ana@startup.com:t1@m4"]]);
  assert.equal(judge(s, pendingEvidence(), deckId, "gmail:ana@startup.com:t1@m4", "fulfilled").action, "resolved");
  // Lucas's metrics are overdue; they belong in the first digest, not in a real-time alert.
  s.db.prepare("UPDATE people SET role = 'customer' WHERE display_name = 'Lucas'").run();
  assert.deepEqual(alerts(s, CONFIG, NOW).alerts, []);
  const sum = summary(s, CONFIG, NOW);
  assert.equal(sum.text.split("\n")[0], "Achei 0 coisas que você prometeu e 1 que te devem nas últimas 2 semanas. 1 já passou do prazo. 1 já foi entregue.");
  assert.match(sum.text, /^1\. Lucas te deve: mandar as métricas — "consegue me mandar as métricas"$/m);
  assert.deepEqual(sum.counts, { iOwe: 0, owed: 1, overdue: 1, unsure: 0, delivered: 1 });
  finish(s, sum.items, NOW);
  assert.equal(item(1).commitmentId, metricsId, "'1 feito' after the summary means Lucas's metrics");
  assert.equal(readPending("backfill"), null, "the look-back's messages are forgotten");
  assert.equal(pick(s, CONFIG, NOW + DAY).send, true, "the first digest still comes");
  delete process.env.LOOP_HOME;
});

test("with nothing open, the summary says so in one line", () => {
  setup();
  const s = openStore(process.env.LOOP_HOME);
  assert.equal(summary(s, CONFIG, NOW).text, "Olhei as últimas 2 semanas e não achei nada em aberto. Daqui pra frente eu acompanho.");
  assert.equal(summary(s, { ...CONFIG, language: "en" }, NOW).text, "I looked at the last 2 weeks and found nothing open. I'll keep track from here.");
  delete process.env.LOOP_HOME;
});

test("even a critical commitment the look-back found (due today, to an investor) waits for the digest", () => {
  const home = setup();
  const s = openStore(home);
  const today = new Date(NOW - 2 * 3_600_000).toISOString();
  const candidate = {
    source: "gmail" as const, item: "gmail:ana@startup.com:t9@m9", thread: "t9", to: ["michael@fund.vc"], cc: [], toNames: ["Michael"],
    sentAt: today, text: "Te mando o term sheet hoje.", signals: ["promise" as const], attachments: 0, links: 0,
  };
  const extraction = {
    is_commitment: true, direction: "i_owe" as const, type: "promise" as const, debtor: "owner" as const, creditor: { name: "Michael", handle: "michael@fund.vc" },
    what: "mandar o term sheet", object_kind: "file" as const, deadline_text: "hoje", quote: "Te mando o term sheet hoje.", features: FEATURES,
  };
  const config = { ...CONFIG, domainRoles: { "fund.vc": "investor" as const } };
  record(s, { ...candidate, backfill: true }, extraction, config);
  assert.deepEqual(alerts(s, config, NOW).alerts, []);
  // The same commitment found by the live poll would alert.
  record(s, { ...candidate, item: "gmail:ana@startup.com:t9@m10", text: "Te mando o term sheet hoje mesmo, prometo." }, { ...extraction, what: "enviar o term sheet assinado", object_kind: "decision", quote: "Te mando o term sheet hoje mesmo" }, config);
  assert.equal(alerts(s, config, NOW).alerts.length, 1);
  delete process.env.LOOP_HOME;
});
