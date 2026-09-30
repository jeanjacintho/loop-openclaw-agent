import assert from "node:assert/strict";
import { test } from "node:test";
import { ownText, prefilter, signals, type Message } from "../skills/loop/scripts/prefilter.ts";

const msg = (text: string, over: Partial<Message> = {}): Message => ({
  text, recipients: ["michael@fund.vc"], ownerHandles: ["ana@startup.com"], ...over,
});
const reason = (v: ReturnType<typeof prefilter>) => (v.keep ? "keep" : v.reason);

test("promises, requests and delegations in Portuguese and English are kept", () => {
  for (const text of [
    "I'll send you the updated deck tomorrow",
    "Amanhã te mando o deck atualizado",
    "Vou revisar o contrato até sexta",
    "Can you send me the metrics by Friday?",
    "Consegue me mandar as métricas até sexta?",
    "Lucas, prepara o relatório até quinta por favor",
    "Let me check with the team and get back to you",
  ]) assert.equal(reason(prefilter(msg(text))), "keep", text);
  assert.deepEqual(signals("Lucas, prepara o relatório até quinta"), ["delegation", "deadline"]);
  assert.ok(signals("Can you send me the metrics by Friday?").includes("request"));
});

test("what cannot hold a commitment is dropped, with the reason counted", () => {
  assert.equal(reason(prefilter(msg("I'm out of the office until Monday, will reply then", { subject: "Automatic reply: deck" }))), "auto_reply");
  assert.equal(reason(prefilter(msg("I'll send it tomorrow", { autoSubmitted: true }))), "auto_reply");
  assert.equal(reason(prefilter(msg("I'll send the minutes tomorrow", { listId: "<team.startup.com>" }))), "mailing_list");
  assert.equal(reason(prefilter(msg("note to self: send the deck tomorrow", { recipients: ["ana@startup.com"] }))), "self_recipient");
  assert.equal(reason(prefilter(msg("", { attachments: 2 }))), "attachment_only");
  assert.equal(reason(prefilter(msg(""))), "empty");
  assert.equal(reason(prefilter(msg("ok, valeu!"))), "too_short");
  assert.equal(reason(prefilter(msg("Great meeting you today, the lunch was excellent"))), "no_commitment_phrase");
  // A deadline word alone ("até amanhã!" as goodbye) is not a commitment phrase.
  assert.equal(reason(prefilter(msg("foi ótimo, até amanhã então pessoal"))), "no_commitment_phrase");
});

test("a reply's quoted history, quote marks and signature are not the owner's words", () => {
  const body = [
    "Sure, I'll send the deck tomorrow.",
    "",
    "--",
    "Ana Lima, CEO",
    "",
    "On Mon, Sep 28, 2026 at 10:00 Michael <michael@fund.vc> wrote:",
    "> Can you also send me the cap table?",
  ].join("\n");
  assert.equal(ownText(body), "Sure, I'll send the deck tomorrow.");
  assert.equal(ownText("Claro, mando hoje.\n\nEm seg., 28 de set. de 2026 às 10:00, Michael escreveu:\n> me manda o deck"), "Claro, mando hoje.");
  assert.equal(ownText("> can you send it?\nyes"), "yes");
});
