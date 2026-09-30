// The first ten minutes: look back two weeks at what the owner sent, with the
// owner present (so Latch can ask for these one-off reads now), and show them
// their open loops right after setup.
//
//   backfill.ts run       → the candidates of the last 14 days (at most 150 sent messages) and a pending file
//   backfill.ts summary   → {text, counts, overdue, unsure}: the one message to send the owner
//   backfill.ts done      → forgets the look-back's messages; what it asked is not asked again
//
// Everything it finds goes through the same detect.ts / resolve.ts as the
// poll. Deadlines are read from when each message was sent, so an old
// "amanhã" is overdue, not due tomorrow; and nothing found here raises a
// real-time alert (it goes into the first digest).
import { isMain, run } from "./cli.ts";
import { loadConfig, type Config } from "./config.ts";
import { readPending, savePending } from "./cursor.ts";
import { withStore, type Store } from "./db.ts";
import { effectiveDeadline } from "./digest.ts";
import { normalizeHandle } from "./handles.ts";
import { appendEvent, eventsOf, evidenceOf, listCommitments, type Commitment } from "./ledger.ts";
import { callMac, type BridgeOptions } from "./mac.ts";
import { file, nowMs } from "./paths.ts";
import { ownText, type Message } from "./prefilter.ts";
import { countLinks, TEXT_MAX, walk, type Candidate, type EvidenceMessage } from "./scan-common.ts";
import { parseMessageRows } from "./scan-imessage.ts";
import { parseMailRows, type MailRow } from "./scan-mail.ts";
import { removeFile, writeJson } from "./store.ts";

export const DAYS = 14;
export const MAX_MESSAGES = 150;
export const MAX_UNSURE = 5;
export const MAX_OVERDUE = 3;

export const mailArgv = (account: string, box: "sent" | "inbox") =>
  ["plow-gog", "gmail", "search", `in:${box} newer_than:${DAYS}d`, "--max", String(MAX_MESSAGES), "--json", "--account", account];
export const IMESSAGE_ARGV = ["plow-messages", "search", "--limit", "1000", "--order", "desc"];

type Result = { candidates: Candidate[]; dropped: Record<string, number>; degraded: { source: string; reason: string; ownerAction?: string }[]; read: number };

export async function runBackfill(opts: BridgeOptions = {}, now = nowMs()): Promise<Result> {
  const config = loadConfig();
  const since = new Date(now - DAYS * 86_400_000).toISOString();
  const out: Result = { candidates: [], dropped: {}, degraded: [], read: 0 };
  const evidence: EvidenceMessage[] = [];
  const sent: { at: string; message: Message; candidate: (m: Message, signals: Candidate["signals"]) => Candidate }[] = [];
  const count = (k: string, n = 1) => (out.dropped[k] = (out.dropped[k] ?? 0) + n);

  for (const account of config.sources.mail?.accounts ?? []) {
    for (const box of ["sent", "inbox"] as const) {
      const res = await callMac({ argv: mailArgv(account, box), readPaths: [], timeoutMs: 120_000, goal: `Loop setup: read your ${box === "sent" ? "sent" : "received"} email from the last two weeks, once, to find open commitments` }, opts);
      if (!res.ok) {
        out.degraded.push({ source: `mail:${box}`, reason: res.reason, ...(res.ownerAction ? { ownerAction: res.ownerAction } : {}) });
        continue;
      }
      let rows: MailRow[];
      try {
        rows = parseMailRows(res.output).rows.filter((r) => r.at >= since);
      } catch {
        out.degraded.push({ source: `mail:${box}`, reason: "unreadable" });
        continue;
      }
      for (const r of rows) {
        const text = ownText(r.body ?? [r.subject, r.snippet].filter(Boolean).join("\n")).slice(0, TEXT_MAX);
        const item = `gmail:${account}:${r.thread}@${r.id}`;
        const mine = box === "sent" && (!r.from || r.from === normalizeHandle(account));
        evidence.push({
          source: "gmail", item, thread: r.thread, direction: mine ? "sent" : "received", from: mine ? "owner" : r.from,
          to: mine ? [...r.to, ...r.cc] : ["owner"], sentAt: r.at, text, attachments: r.attachments, links: countLinks(text),
        });
        if (!mine) continue;
        sent.push({
          at: r.at,
          message: { text, subject: r.subject, recipients: [...r.to, ...r.cc], ownerHandles: config.sources.mail!.accounts, attachments: r.attachments, listId: r.listId, autoSubmitted: r.autoSubmitted },
          candidate: (m, signals) => ({
            source: "gmail", item, thread: r.thread, to: r.to, cc: r.cc, toNames: r.toNames, sentAt: r.at, subject: r.subject,
            text: m.text, signals, attachments: r.attachments, links: countLinks(m.text), backfill: true,
          }),
        });
      }
    }
  }

  if (config.sources.imessage) {
    const res = await callMac({ argv: IMESSAGE_ARGV, readPaths: ["~/Library/Messages"], timeoutMs: 120_000, goal: "Loop setup: read your iMessages from the last two weeks, once, to find open commitments" }, opts);
    if (!res.ok) {
      out.degraded.push({ source: "imessage", reason: res.reason, ...(res.ownerAction ? { ownerAction: res.ownerAction } : {}) });
    } else {
      for (const r of parseMessageRows(res.output).rows) {
        if (!r.at || r.at < since || r.group || !r.handle) continue;
        const item = `imessage:${r.rowid}`;
        const text = r.text.trim().slice(0, TEXT_MAX);
        evidence.push({
          source: "imessage", item, thread: r.handle, direction: r.fromMe ? "sent" : "received", from: r.fromMe ? "owner" : r.handle,
          to: r.fromMe ? [r.handle] : ["owner"], sentAt: r.at, text, attachments: r.attachments, links: countLinks(text),
        });
        if (!r.fromMe) continue;
        const handle = r.handle;
        sent.push({
          at: r.at,
          message: { text, recipients: [handle], ownerHandles: [], attachments: r.attachments },
          candidate: (m, signals) => ({
            source: "imessage", item, thread: handle, to: [handle], cc: [], toNames: r.name ? [r.name] : [], sentAt: r.at!,
            text: m.text, signals, attachments: r.attachments, links: countLinks(m.text), backfill: true,
          }),
        });
      }
    }
  }

  // The newest 150 messages the owner sent, walked oldest first.
  sent.sort((a, b) => b.at.localeCompare(a.at));
  if (sent.length > MAX_MESSAGES) count("over_cap", sent.length - MAX_MESSAGES);
  const kept = sent.slice(0, MAX_MESSAGES).reverse();
  out.read = kept.length;
  const walked = walk(kept, (s) => s.message, (s, m, signals) => s.candidate(m, signals), MAX_MESSAGES);
  out.candidates = walked.candidates;
  for (const [k, n] of Object.entries(walked.dropped)) count(k, n ?? 0);
  savePending("backfill", { scannedAt: new Date(now).toISOString(), next: null, candidates: out.candidates, evidence });
  return out;
}

type Lang = "pt" | "en";

function isBackfill(store: Store, c: Commitment): boolean {
  return eventsOf(store, c.id)[0]?.payload.backfill === true;
}

export function summary(store: Store, config: Pick<Config, "timezone" | "language">, now = nowMs()) {
  const lang: Lang = (config.language ?? "").toLowerCase().startsWith("pt") ? "pt" : "en";
  const found = listCommitments(store, ["open", "snoozed", "candidate", "done", "dropped"]).filter((c) => isBackfill(store, c));
  const live = found.filter((c) => c.status === "open" || c.status === "snoozed");
  const iOwe = live.filter((c) => c.direction === "i_owe");
  const owed = live.filter((c) => c.direction === "they_owe");
  const nowIso = new Date(now).toISOString();
  const overdue = live.filter((c) => {
    const d = effectiveDeadline(c, config.timezone);
    return d && !d.inferred && d.at < nowIso;
  }).sort((a, b) => (a.direction === b.direction ? 0 : a.direction === "i_owe" ? -1 : 1));
  const unsure = found.filter((c) => c.status === "candidate").slice(0, MAX_UNSURE);
  const doneAlready = found.filter((c) => c.status === "done").length;
  const who = (c: Commitment) => (c.direction === "i_owe" ? c.creditor : c.debtor).name ?? (c.direction === "i_owe" ? c.creditor : c.debtor).handles[0] ?? "?";
  const quote = (c: Commitment) => evidenceOf(store, c.id).find((e) => e.role === "origin")?.quote ?? "";
  const lines: string[] = [];
  if (lang === "pt") {
    lines.push(`Achei ${iOwe.length} ${iOwe.length === 1 ? "coisa que você prometeu" : "coisas que você prometeu"} e ${owed.length} que te devem nas últimas 2 semanas.`
      + (overdue.length ? ` ${overdue.length} já ${overdue.length === 1 ? "passou" : "passaram"} do prazo.` : "")
      + (doneAlready ? ` ${doneAlready} já ${doneAlready === 1 ? "foi entregue" : "foram entregues"}.` : ""));
  } else {
    lines.push(`In the last 2 weeks I found ${iOwe.length} ${iOwe.length === 1 ? "thing you promised" : "things you promised"} and ${owed.length} owed to you.`
      + (overdue.length ? ` ${overdue.length} ${overdue.length === 1 ? "is" : "are"} past due.` : "")
      + (doneAlready ? ` ${doneAlready} already delivered.` : ""));
  }
  const shown = overdue.slice(0, MAX_OVERDUE);
  shown.forEach((c, i) => lines.push(`${i + 1}. ${c.direction === "i_owe" ? (lang === "pt" ? `${who(c)} espera` : `${who(c)} is waiting for`) : (lang === "pt" ? `${who(c)} te deve` : `${who(c)} owes you`)}: ${c.what} — "${quote(c).slice(0, 100)}"`));
  if (unsure.length) {
    lines.push(lang === "pt" ? `Confere ${unsure.length === 1 ? "esta que não tenho certeza" : `essas ${unsure.length} que não tenho certeza`}?` : `Can you check ${unsure.length === 1 ? "this one I'm not sure about" : `these ${unsure.length} I'm not sure about`}?`);
    unsure.forEach((c, i) => lines.push(`${shown.length + i + 1}. "${quote(c).slice(0, 100)}" (${who(c)})`));
    lines.push(lang === "pt" ? 'Responda "4 sim", "5 não"…' : 'Reply "4 yes", "5 no"…');
  }
  if (!found.length) lines.splice(0, lines.length, lang === "pt" ? "Olhei as últimas 2 semanas e não achei nada em aberto. Daqui pra frente eu acompanho." : "I looked at the last 2 weeks and found nothing open. I'll keep track from here.");
  const items = [...shown, ...unsure].map((c, i) => ({ n: i + 1, kind: c.status === "candidate" ? "candidate" : c.direction, commitmentId: c.id, text: "" }));
  return { text: lines.join("\n"), counts: { iOwe: iOwe.length, owed: owed.length, overdue: overdue.length, unsure: unsure.length, delivered: doneAlready }, items };
}

// The summary was sent: its numbers are what the owner's replies refer to,
// and its candidates count as asked.
export function finish(store: Store, items: { n: number; kind: string; commitmentId: number }[], now = nowMs()): { done: true } {
  const at = new Date(now).toISOString();
  store.tx(() => {
    for (const i of items) if (i.kind === "candidate") appendEvent(store, i.commitmentId, "asked", {}, "loop", at);
  });
  // The summary's numbers are what "4 sim" refers to. Dated at the epoch: it
  // numbers replies but is not a digest, so the first digest still comes.
  writeJson(file("digest-last.json"), { at: new Date(0).toISOString(), items });
  removeFile(file("pending-backfill.json"));
  return { done: true };
}

if (isMain(import.meta.url)) {
  run(async () => {
    const cmd = process.argv[2];
    if (cmd === "run") return runBackfill();
    const config = loadConfig();
    if (cmd === "summary") return withStore((s) => summary(s, config));
    if (cmd === "done") {
      if (!readPending("backfill")) return { done: true };
      return withStore((s) => finish(s, summary(s, config).items));
    }
    throw new Error("usage: backfill.ts run | summary | done");
  });
}
