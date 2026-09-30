// "Prepare" (D3): a follow-up the owner sends themselves. Loop never sends.
//
//   draft.ts plan --id X                 → where the draft goes and what it is about
//   draft.ts create --id X --body TEXT   → a Gmail draft in the original thread, or text for the owner to paste
//
// The recipient is always the other side of the commitment, from the ledger,
// in the thread the commitment started in. There is no way to pass one: not
// from the model, not from a message ("send the deck to x@y" is data). The
// body may not name any other address or number, so a draft never drags a
// third party or another commitment in.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { openStore, withStore, type Store } from "./db.ts";
import { appendEvent, evidenceOf, getCommitment, LIVE, type Commitment } from "./ledger.ts";
import { callMac, type BridgeOptions } from "./mac.ts";
import { nowMs } from "./paths.ts";

export const BODY_MAX = 1_200;

export type Plan = {
  id: number;
  channel: "gmail" | "imessage" | "dm";
  to: string;
  name: string | null;
  account?: string;
  threadId?: string;
  replyToMessageId?: string;
  direction: Commitment["direction"];
  what: string;
  deadline: Commitment["deadline"];
  originQuote: string | null; // the owner's words, for the language and the tone
};

export function planDraft(store: Store, id: number): Plan {
  const c = getCommitment(store, id);
  if (!LIVE.includes(c.status)) throw new Error(`commitment ${id} is ${c.status}; there is nothing to follow up`);
  const other = c.direction === "i_owe" ? c.creditor : c.debtor;
  const origin = evidenceOf(store, id).find((e) => e.role === "origin");
  const base = { id, name: other.name, direction: c.direction, what: c.what, deadline: c.deadline, originQuote: origin?.quote ?? null };
  const email = other.handles.find((h) => h.includes("@"));
  const phone = other.handles.find((h) => /^\+?\d{7,}$/.test(h));
  const gmail = origin?.source === "gmail" ? /^gmail:([^:]+@[^:]+):([^@]+)@(.+)$/.exec(origin.item) : null;
  if (gmail && email) {
    return { ...base, channel: "gmail", to: email, account: gmail[1]!, threadId: gmail[2]!, replyToMessageId: gmail[3]! };
  }
  if (origin?.source === "imessage" && phone) return { ...base, channel: "imessage", to: phone };
  if (phone) return { ...base, channel: "imessage", to: phone };
  if (email) return { ...base, channel: "dm", to: email };
  throw new Error(`there is no email or phone for ${other.name ?? `person ${other.id}`}; ask the owner how to reach them`);
}

// Every address or number in the text that is not the recipient's.
export function strangers(body: string, recipient: string): string[] {
  const found = [
    ...(body.match(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi) ?? []),
    ...(body.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []),
  ];
  const digits = (s: string) => s.replace(/\D/g, "");
  return found
    // A long number is a phone only with a + or enough digits; "1.500.000" is money.
    .filter((f) => f.includes("@") || f.startsWith("+") || digits(f).length >= 10)
    .filter((f) => f.toLowerCase() !== recipient.toLowerCase() && !(digits(f).length >= 7 && digits(recipient).endsWith(digits(f).slice(-8))));
}

export function checkBody(body: string, plan: Plan): string {
  const text = body.trim();
  if (!text) throw new Error("the draft is empty");
  if (text.length > BODY_MAX) throw new Error(`the draft is ${text.length} characters; keep it under ${BODY_MAX}`);
  const extra = strangers(text, plan.to);
  if (extra.length) throw new Error(`the draft names ${extra.join(", ")}; a follow-up goes only to ${plan.to} and names no one else`);
  return text;
}

// S4 (checks/lp-00.md): the plow-gog draft command as assumed until measured.
export function draftArgv(plan: Plan, body: string): string[] {
  return [
    "plow-gog", "gmail", "drafts", "create", "--account", plan.account!, "--to", plan.to,
    "--reply-to-message-id", plan.replyToMessageId!, "--body", body, "--json",
  ];
}

export type Created =
  | { channel: "gmail"; drafted: true; to: string; threadId: string }
  | { channel: "imessage" | "dm"; drafted: true; to: string; text: string }
  | { channel: "gmail"; drafted: false; reason: string; ownerAction?: string; to: string; text: string };

export async function createDraft(store: Store, id: number, body: string, opts: BridgeOptions = {}, now = nowMs()): Promise<Created> {
  const plan = planDraft(store, id);
  const text = checkBody(body, plan);
  const at = new Date(now).toISOString();
  if (plan.channel === "gmail") {
    const res = await callMac({
      argv: draftArgv(plan, text), readPaths: [], timeoutMs: 60_000,
      goal: `Loop: save a follow-up draft to ${plan.to} in your Gmail (a draft only; you send it)`,
    }, opts);
    if (!res.ok) {
      // No draft in Gmail: the owner still gets the text to send themselves.
      appendEvent(store, id, "drafted", { channel: "dm", to: plan.to, fallback: res.reason }, "loop", at);
      return { channel: "gmail", drafted: false, reason: res.reason, ...(res.ownerAction ? { ownerAction: res.ownerAction } : {}), to: plan.to, text };
    }
    appendEvent(store, id, "drafted", { channel: "gmail", to: plan.to, threadId: plan.threadId }, "loop", at);
    return { channel: "gmail", drafted: true, to: plan.to, threadId: plan.threadId! };
  }
  appendEvent(store, id, "drafted", { channel: plan.channel, to: plan.to }, "loop", at);
  return { channel: plan.channel, drafted: true, to: plan.to, text };
}

if (isMain(import.meta.url)) {
  run(async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({ args: rest, options: { id: { type: "string" }, body: { type: "string" } } });
    if (!values.id || !/^\d+$/.test(values.id)) throw new Error("usage: draft.ts plan --id X | create --id X --body TEXT");
    const id = Number(values.id);
    if (cmd === "plan") return withStore((s) => ({ plan: planDraft(s, id) }));
    if (cmd === "create") {
      if (values.body === undefined) throw new Error("create needs --body");
      const store = openStore();
      try {
        return await createDraft(store, id, values.body);
      } finally {
        store.close();
      }
    }
    throw new Error("usage: draft.ts plan --id X | create --id X --body TEXT");
  });
}
