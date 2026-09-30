import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openStore } from "../skills/loop/scripts/db.ts";
import { record, type Extraction } from "../skills/loop/scripts/detect.ts";
import { addCommitment, evidenceOf, listCommitments, type NewCommitment } from "../skills/loop/scripts/ledger.ts";
import { answer, CONTACTS_ARGV, enrich, openQuestions, parseContacts, refreshContacts, roleFromDomain, setRole } from "../skills/loop/scripts/people.ts";
import type { Candidate } from "../skills/loop/scripts/scan-common.ts";
import { writeJson } from "../skills/loop/scripts/store.ts";
import { tmpHome } from "./helpers.ts";

const AT = "2026-09-28T13:00:00.000Z";
const CONFIG = { timezone: "America/Sao_Paulo", language: "pt-BR", domainRoles: { "fund.vc": "investor" as const } };
const FEATURES = { first_person: true, delivery_verb: true, concrete_object: true, clear_counterparty: true, explicit_deadline: true, conditional: false, social_pleasantry: false };

const CONTACT_LINES = [
  "/Users/ana/Library/Application Support/AddressBook/Sources/A/AddressBook-v22.abcddb|12|Michael|Chen|Fund VC|email|Michael@Fund.vc",
  "/Users/ana/Library/Application Support/AddressBook/Sources/A/AddressBook-v22.abcddb|12|Michael|Chen|Fund VC|phone|+1 (415) 555-0100",
  "/Users/ana/Library/Application Support/AddressBook/Sources/B/AddressBook-v22.abcddb|12|Lucas||Startup|phone|(11) 98888-7777",
  "/Users/ana/Library/Application Support/AddressBook/Sources/B/AddressBook-v22.abcddb|13|||Acme Inc|email|hello@acme.com",
  "garbage line",
].join("\n");

function home() {
  const h = tmpHome();
  process.env.LOOP_HOME = h;
  writeJson(join(h, "contacts.json"), { fetchedAt: AT, contacts: parseContacts(CONTACT_LINES) });
  return h;
}

test("contacts are parsed per record and source, with every email and phone normalized", () => {
  assert.deepEqual(parseContacts(CONTACT_LINES), [
    { name: "Michael Chen", org: "Fund VC", handles: ["michael@fund.vc", "+14155550100"] },
    { name: "Lucas", org: "Startup", handles: ["11988887777"] },
    { name: "Acme Inc", org: "Acme Inc", handles: ["hello@acme.com"] },
  ]);
});

test("enrich adds the other handles a contact has and the role the domain carries, never a handle from text", () => {
  const contacts = parseContacts(CONTACT_LINES);
  assert.deepEqual(enrich({ name: "Mike", handles: ["michael@fund.vc"] }, contacts, CONFIG.domainRoles),
    { name: "Mike", handles: ["michael@fund.vc", "+14155550100"], role: "investor", org: "Fund VC" });
  assert.deepEqual(enrich({ handles: ["+5511988887777"] }, contacts), { name: "Lucas", handles: ["+5511988887777"], org: "Startup" });
  assert.deepEqual(enrich({ name: "Zé", handles: ["ze@nowhere.io"] }, contacts), { name: "Zé", handles: ["ze@nowhere.io"] });
  assert.equal(roleFromDomain(["a@partners.fund.vc"], CONFIG.domainRoles), "investor");
  assert.equal(roleFromDomain(["a@notfund.vc"], CONFIG.domainRoles), undefined);
});

test("the same promise by email and by text is one commitment with two pieces of evidence", () => {
  home();
  const s = openStore(process.env.LOOP_HOME);
  const mail: Candidate = {
    source: "gmail", item: "gmail:ana@startup.com:t1@m1", thread: "t1", to: ["michael@fund.vc"], cc: [], toNames: ["Michael Chen"],
    sentAt: AT, text: "I'll send you the updated deck tomorrow.", signals: ["promise"], attachments: 0, links: 0,
  };
  const text: Candidate = { ...mail, source: "imessage", item: "imessage:501", thread: "+14155550100", to: ["+14155550100"], toNames: [], text: "Mando o deck amanhã cedo!", sentAt: "2026-09-28T15:00:00.000Z" };
  const ex = (quote: string, what: string, handle: string): Extraction => ({
    is_commitment: true, direction: "i_owe", type: "promise", debtor: "owner", creditor: { name: "Michael", handle },
    what, object_kind: "file", deadline_text: "amanhã", quote, features: FEATURES, updates: null,
  });
  const a = record(s, mail, ex("I'll send you the updated deck tomorrow.", "send the updated deck", "michael@fund.vc"), CONFIG);
  const b = record(s, text, ex("Mando o deck amanhã cedo!", "mandar o deck", "+14155550100"), CONFIG);
  assert.equal(a.recorded === "commitment" && a.created, true);
  assert.equal(b.recorded === "commitment" && b.created, false);
  const open = listCommitments(s, ["open"]);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.creditor.role, "investor");
  assert.deepEqual(open[0]!.creditor.handles.sort(), ["+14155550100", "michael@fund.vc"]);
  assert.deepEqual(evidenceOf(s, open[0]!.id).map((e) => [e.role, e.item]), [["origin", "gmail:ana@startup.com:t1@m1"], ["update", "imessage:501"]]);
  delete process.env.LOOP_HOME;
});

const deal = (name: string, handle: string, what: string, at = AT): NewCommitment => ({
  direction: "i_owe", type: "promise", debtor: "owner", creditor: { name, handles: [handle] }, what, objectKind: "file", band: "open",
  evidence: [{ source: "gmail", item: `gmail:ana@startup.com:${handle.replace(/\W/g, "")}@${what.replace(/\W/g, "")}`, quote: "q", at }],
});

test("two Pedros are two people; Loop asks once whether they are the same, and merges only on 'same'", () => {
  const s = openStore(tmpHome());
  const a = addCommitment(s, deal("Pedro", "pedro@a.com", "send the proposal")).commitment;
  const b = addCommitment(s, deal("Pedro", "pedro@b.com", "send the contract")).commitment;
  assert.notEqual(a.creditor.id, b.creditor.id);
  const [q] = openQuestions(s);
  assert.deepEqual([q!.a.id, q!.b.id], [a.creditor.id, b.creditor.id]);
  addCommitment(s, deal("Pedro", "pedro@c.com", "send the invoice"));
  assert.equal(openQuestions(s).length, 3, "one question per pair");
  answer(s, a.creditor.id, b.creditor.id, true);
  const merged = listCommitments(s, ["open"]).filter((c) => c.creditor.id === a.creditor.id);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0]!.creditor.handles, ["pedro@a.com", "pedro@b.com"]);
  assert.equal(openQuestions(s).length, 1, "the merged person's other question is closed too");
});

test("a repeat is only merged between the same people, same kind of object, within a week", () => {
  const s = openStore(tmpHome());
  const first = addCommitment(s, deal("Michael", "michael@fund.vc", "send the deck")).commitment;
  assert.equal(addCommitment(s, deal("Michael", "michael@fund.vc", "share deck v2")).commitment.id, first.id);
  assert.notEqual(addCommitment(s, deal("Sarah", "sarah@fund.vc", "send the deck")).commitment.id, first.id);
  assert.notEqual(addCommitment(s, { ...deal("Michael", "michael@fund.vc", "deck intro"), objectKind: "intro" }).commitment.id, first.id);
  assert.notEqual(addCommitment(s, deal("Michael", "michael@fund.vc", "send the deck again", "2026-10-09T13:00:00.000Z"), "loop", "2026-10-09T13:00:00.000Z").commitment.id, first.id);
});

test("phones match on their last digits, and the owner sets roles", () => {
  const s = openStore(tmpHome());
  const c = addCommitment(s, deal("Lucas", "+55 11 98888-7777", "send metrics")).commitment;
  const again = addCommitment(s, deal("Lucas", "11988887777", "send numbers")).commitment;
  assert.equal(again.creditor.id, c.creditor.id);
  assert.equal(setRole(s, "11 98888-7777", "team").role, "team");
  assert.throws(() => setRole(s, "11 98888-7777", "boss"), /role must be one of/);
});

test("contacts are read with one fixed command, at most once a day", async () => {
  process.env.LOOP_HOME = tmpHome();
  const calls: string[][] = [];
  const fetch = (async (_u: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)).params.arguments.argv);
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify({ exit_code: 0, output: CONTACT_LINES }) }] } }));
  }) as unknown as typeof globalThis.fetch;
  const T = Date.parse(AT);
  assert.deepEqual(await refreshContacts({ fetch, token: "t" }, 24, T), { refreshed: true, contacts: 3 });
  assert.deepEqual(await refreshContacts({ fetch, token: "t" }, 24, T + 3_600_000), { refreshed: false, contacts: 3 });
  assert.equal((await refreshContacts({ fetch, token: "t" }, 24, T + 25 * 3_600_000)).refreshed, true);
  assert.deepEqual(calls[0], CONTACTS_ARGV);
  assert.deepEqual(calls[1], calls[0]);
  delete process.env.LOOP_HOME;
});
