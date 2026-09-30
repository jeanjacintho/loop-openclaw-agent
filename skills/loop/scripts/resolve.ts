// Closing commitments when the other side delivers (or the owner does).
//
//   resolve.ts candidates   → pairs of (new message, live commitment) worth a look
//   resolve.ts judge --commitment C --item I --verdict fulfilled|partial|unrelated|cancelled [--quote Q]
//
// Only messages the last scan handed over as evidence can be judged, and only
// against a commitment the script paired them with: a message pairs with a
// commitment when it comes from the person who owes it (the delivery) or
// from the person owed it (a call-off), after the commitment began.
//
// Closing is reversible, and automatic only on strong proof (D6): the verdict
// is "fulfilled", the message comes from the debtor, it is in the same thread
// or names the same object, and when the object is a file it carries an
// attachment or a link. Anything weaker becomes "looks done?" in the digest.
// Silence never closes anything.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { readPending, type SourceName } from "./cursor.ts";
import { withStore, type Store } from "./db.ts";
import { sameHandle } from "./handles.ts";
import {
  addEvidence, appendEvent, evidenceOf, getCommitment, LIVE, listCommitments, normalizeWhat, objectWords,
  type Commitment,
} from "./ledger.ts";
import { nowMs } from "./paths.ts";
import type { EvidenceMessage } from "./scan-common.ts";

export type Pair = {
  commitment: { id: number; direction: Commitment["direction"]; what: string; objectKind: Commitment["objectKind"]; with: string | null };
  message: { item: string; direction: EvidenceMessage["direction"]; sentAt: string; text: string; attachments: number; links: number };
  role: "delivery" | "calloff"; // from the debtor, or from the creditor
  sameThread: boolean;
  sameObject: boolean;
  hasFile: boolean;
};

export type Verdict = "fulfilled" | "partial" | "unrelated" | "cancelled";
export const VERDICTS: readonly Verdict[] = ["fulfilled", "partial", "unrelated", "cancelled"];

export function pendingEvidence(): EvidenceMessage[] {
  return (["mail", "imessage"] as SourceName[]).flatMap((s) => (readPending<unknown, unknown>(s)?.evidence ?? []) as EvidenceMessage[]);
}

// Which side of the commitment wrote the message: the debtor, the creditor, or neither.
function sideOf(c: Commitment, m: EvidenceMessage): "debtor" | "creditor" | null {
  const author = m.direction === "sent" ? "owner" : m.from;
  const owner = author === "owner";
  const other = c.direction === "i_owe" ? c.creditor : c.debtor;
  const toOther = m.direction === "sent" && m.to.some((t) => other.handles.some((h) => sameHandle(h, t)));
  const fromOther = m.direction === "received" && other.handles.some((h) => sameHandle(h, m.from));
  if (c.direction === "i_owe") {
    if (owner && toOther) return "debtor";
    if (fromOther) return "creditor";
  } else {
    if (fromOther) return "debtor";
    if (owner && toOther) return "creditor";
  }
  return null;
}

export function pairsFor(store: Store, messages: EvidenceMessage[]): Pair[] {
  const live = listCommitments(store, [...LIVE]);
  const pairs: Pair[] = [];
  for (const m of messages) {
    for (const c of live) {
      const side = sideOf(c, m);
      if (!side) continue;
      const evidence = evidenceOf(store, c.id);
      if (evidence.some((e) => e.item === m.item)) continue; // the message that made it
      const origin = evidence.find((e) => e.role === "origin") ?? evidence[0];
      if (origin && m.sentAt < origin.at) continue; // before the commitment began
      // The owner chasing someone who owes them is a nudge (LP-11), not evidence of delivery.
      if (c.direction === "they_owe" && side === "creditor") continue;
      const words = objectWords(normalizeWhat(c.what));
      const text = normalizeWhat(m.text);
      pairs.push({
        commitment: { id: c.id, direction: c.direction, what: c.what, objectKind: c.objectKind, with: (c.direction === "i_owe" ? c.creditor : c.debtor).name },
        message: { item: m.item, direction: m.direction, sentAt: m.sentAt, text: m.text, attachments: m.attachments, links: m.links },
        role: side === "debtor" ? "delivery" : "calloff",
        sameThread: evidence.some((e) => e.thread !== null && e.thread === m.thread),
        sameObject: [...words].some((w) => text.split(" ").includes(w)),
        hasFile: m.attachments > 0 || m.links > 0,
      });
    }
  }
  return pairs;
}

// D6: strong enough to close without asking.
export function strongDelivery(p: Pair): boolean {
  if (p.role !== "delivery") return false;
  if (!p.sameThread && !p.sameObject) return false;
  if (p.commitment.objectKind === "file" && !p.hasFile) return false;
  return true;
}

export type Judged = { action: "resolved" | "looks_done" | "dropped" | "evidence" | "none"; commitment: Commitment };

export function judge(store: Store, messages: EvidenceMessage[], commitmentId: number, item: string, verdict: string, quote?: string, at = new Date(nowMs()).toISOString()): Judged {
  if (!VERDICTS.includes(verdict as Verdict)) throw new Error(`verdict must be one of ${VERDICTS.join(", ")}`);
  const pair = pairsFor(store, messages).find((p) => p.commitment.id === commitmentId && p.message.item === item);
  if (!pair) throw new Error(`message ${item} is not paired with commitment ${commitmentId}; judge only pairs from resolve.ts candidates`);
  const message = messages.find((m) => m.item === item)!;
  if (verdict === "unrelated") return { action: "none", commitment: getCommitment(store, commitmentId) };
  const q = quote?.trim() && message.text.replace(/\s+/g, " ").includes(quote.replace(/\s+/g, " ").trim()) ? quote : message.text.slice(0, 280) || "(no text)";
  const author = message.direction === "sent" ? ("owner" as const) : { handles: [message.from] };
  return store.tx(() => {
    addEvidence(store, commitmentId, { source: message.source, item, quote: q, at: message.sentAt, author, thread: message.thread, role: verdict === "fulfilled" ? "resolution" : "update" }, "loop", at);
    if (verdict === "cancelled") {
      // Only the side that is owed can call it off.
      if (pair.role !== "calloff") return { action: "looks_done" as const, commitment: appendEvent(store, commitmentId, "looks_done", { item, verdict }, "loop", at) };
      return { action: "dropped" as const, commitment: appendEvent(store, commitmentId, "dropped", { reason: "called off", item }, "auto", at) };
    }
    if (verdict === "partial") return { action: "evidence" as const, commitment: getCommitment(store, commitmentId) };
    if (strongDelivery(pair)) return { action: "resolved" as const, commitment: appendEvent(store, commitmentId, "resolved", { item }, "auto", at) };
    return { action: "looks_done" as const, commitment: appendEvent(store, commitmentId, "looks_done", { item, verdict }, "loop", at) };
  });
}

if (isMain(import.meta.url)) {
  run(() => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({ args: rest, options: { commitment: { type: "string" }, item: { type: "string" }, verdict: { type: "string" }, quote: { type: "string" } } });
    const messages = pendingEvidence();
    if (cmd === "candidates") return withStore((s) => ({ pairs: pairsFor(s, messages) }));
    if (cmd === "judge") {
      if (!values.commitment || !values.item || !values.verdict) throw new Error("usage: resolve.ts judge --commitment C --item I --verdict V [--quote Q]");
      return withStore((s) => judge(s, messages, Number(values.commitment), values.item!, values.verdict!, values.quote));
    }
    throw new Error("usage: resolve.ts candidates | judge --commitment C --item I --verdict fulfilled|partial|unrelated|cancelled [--quote Q]");
  });
}
