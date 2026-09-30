// Scans the mail the owner sent, for commitment candidates.
//
// The Mac is asked with one fixed argv per account (SENT_ARGV), so Latch can
// remember the owner's approval for the scheduled poll; what is new is cut
// locally against the cursor, never by changing the query (D8). Only sent
// mail is read. Whatever text the search returns is used: when a row has no
// body, the subject and snippet stand in and the scan says so (degraded).
//
//   scan-mail.ts scan     → {candidates, dropped, degraded, …} and a pending file
//   scan-mail.ts commit   → moves the cursor past what scan handed over
//   scan-mail.ts probe    → runs the exact argv once, for the owner to approve
import { isMain, run } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { commit, fail, ok, readCursor, savePending } from "./cursor.ts";
import { bareAddress, isEmail, normalizeHandle } from "./handles.ts";
import { callMac, type BridgeOptions, type MacCommand } from "./mac.ts";
import { nowMs } from "./paths.ts";
import { ownText, type Message } from "./prefilter.ts";
import { CAP, countLinks, list, rowsOf, TEXT_MAX, toIso, walk, type Candidate } from "./scan-common.ts";

export const SENT_QUERY = "in:sent newer_than:2d";

export function SENT_ARGV(account: string): string[] {
  return ["plow-gog", "gmail", "search", SENT_QUERY, "--max", "25", "--json", "--account", account];
}

export function sentCommand(account: string): MacCommand {
  return {
    argv: SENT_ARGV(account), readPaths: [], timeoutMs: 60_000,
    goal: "Loop: read the email you sent in the last two days, to keep track of what you promised and asked for",
  };
}

export type MailRow = {
  id: string; thread: string; at: string; subject: string; from: string; to: string[]; cc: string[]; toNames: string[];
  body: string | null; snippet: string; attachments: number; listId: string | null; autoSubmitted: boolean;
};
export type MailPos = { at: string; ids: string[] };
export type MailCursor = Record<string, MailPos>; // per account

function header(r: Record<string, unknown>, name: string): string | null {
  const h = r.headers;
  if (!h || typeof h !== "object") return null;
  if (Array.isArray(h)) {
    const found = h.find((x) => typeof x?.name === "string" && x.name.toLowerCase() === name.toLowerCase());
    return typeof found?.value === "string" ? found.value : null;
  }
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key ? (h as Record<string, unknown>)[key] : null;
  return typeof v === "string" ? v : null;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

// One row per message the search printed; rows without an id or a date are left out.
export function parseMailRows(output: string): { rows: MailRow[]; unreadable: number } {
  const rows: MailRow[] = [];
  let unreadable = 0;
  for (const r of rowsOf(output)) {
    const id = str(r.id) || str(r.messageId) || str(r.message_id);
    const at = toIso(r.date ?? r.internalDate ?? r.sent_at ?? r.sentAt);
    if (!id || !at) {
      unreadable++;
      continue;
    }
    const recipients = (field: string) => list(r[field]).map(bareAddress).filter(isEmail).map(normalizeHandle);
    const names = list(r.to).map((t) => t.replace(/<[^>]*>/, "").replace(/"/g, "").trim()).filter((n) => n && !isEmail(n));
    const body = [r.body, r.text, r.plain, r.content].find((b) => typeof b === "string" && b.trim()) as string | undefined;
    const attachments = Array.isArray(r.attachments) ? r.attachments.length : Number(r.attachmentCount ?? r.attachment_count ?? 0) || 0;
    const auto = header(r, "Auto-Submitted");
    rows.push({
      id, thread: str(r.threadId) || str(r.thread_id) || str(r.thread) || id, at,
      subject: str(r.subject), from: normalizeHandle(bareAddress(str(r.from))), to: recipients("to"), cc: recipients("cc"), toNames: names,
      body: body ?? null, snippet: str(r.snippet), attachments,
      listId: str(r.listId) || str(r.list_id) || header(r, "List-Id"), autoSubmitted: !!auto && auto.toLowerCase() !== "no",
    });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  return { rows, unreadable };
}

export function isNew(row: MailRow, pos: MailPos | undefined): boolean {
  return !pos || row.at > pos.at || (row.at === pos.at && !pos.ids.includes(row.id));
}

export function after(rows: MailRow[]): MailPos | null {
  const last = rows.at(-1);
  if (!last) return null;
  return { at: last.at, ids: rows.filter((r) => r.at === last.at).map((r) => r.id) };
}

// A cursor never moves back; at the same instant it collects the ids seen.
export function forward(from: MailCursor | null, to: MailCursor): MailCursor {
  const out: MailCursor = { ...(from ?? {}) };
  for (const [account, pos] of Object.entries(to)) {
    const cur = out[account];
    if (cur && pos.at < cur.at) throw new Error(`the mail cursor never moves back (${account} at ${cur.at}, asked ${pos.at})`);
    out[account] = cur && cur.at === pos.at ? { at: pos.at, ids: [...new Set([...cur.ids, ...pos.ids])] } : pos;
  }
  return out;
}

export type ScanResult = {
  source: "mail";
  disabled?: true;
  candidates: Candidate[];
  dropped: Record<string, number>;
  degraded: { account?: string; reason: string; detail?: string; ownerAction?: string }[];
  initialized?: string[];
  failing?: { failingSince: string; warn: boolean };
};

export async function scanMail(opts: BridgeOptions = {}, now = nowMs()): Promise<ScanResult> {
  const config = loadConfig();
  const result: ScanResult = { source: "mail", candidates: [], dropped: {}, degraded: [] };
  const accounts = config.sources.mail?.accounts ?? [];
  if (!accounts.length) return { ...result, disabled: true };
  const cursor = readCursor<MailCursor>("mail").pos ?? {};
  const next: MailCursor = {};
  let noBody = 0;
  let failed = false;
  for (const account of accounts) {
    const res = await callMac(sentCommand(account), opts);
    if (!res.ok) {
      failed = true;
      result.degraded.push({ account, reason: res.reason, ...(res.detail ? { detail: res.detail } : {}), ...(res.ownerAction ? { ownerAction: res.ownerAction } : {}) });
      continue;
    }
    let parsed: ReturnType<typeof parseMailRows>;
    try {
      parsed = parseMailRows(res.output);
    } catch (err) {
      failed = true;
      result.degraded.push({ account, reason: "unreadable", detail: (err as Error).message });
      continue;
    }
    if (parsed.unreadable) result.dropped.unreadable = (result.dropped.unreadable ?? 0) + parsed.unreadable;
    const pos = cursor[account];
    if (!pos) {
      // The first scan of an account never reads history: it only marks where
      // "new" starts. Looking back is the backfill, with the owner present.
      next[account] = after(parsed.rows) ?? { at: new Date(now).toISOString(), ids: [] };
      (result.initialized ??= []).push(account);
      continue;
    }
    const fresh = parsed.rows.filter((r) => isNew(r, pos));
    const walked = walk(fresh, (r) => {
      if (r.from && r.from !== normalizeHandle(account)) return { skip: "not_from_owner" };
      if (r.body === null) noBody++;
      const text = ownText(r.body ?? [r.subject, r.snippet].filter(Boolean).join("\n")).slice(0, TEXT_MAX);
      const m: Message = {
        text, subject: r.subject, recipients: [...r.to, ...r.cc], ownerHandles: accounts,
        attachments: r.attachments, listId: r.listId, autoSubmitted: r.autoSubmitted,
      };
      return m;
    }, (r, m, signals) => ({
      source: "gmail", item: `gmail:${account}:${r.thread}@${r.id}`, thread: r.thread, to: r.to, cc: r.cc, toNames: r.toNames,
      sentAt: r.at, subject: r.subject, text: m.text, signals, attachments: r.attachments, links: countLinks(m.text),
    }), CAP - result.candidates.length);
    result.candidates.push(...walked.candidates);
    for (const [k, n] of Object.entries(walked.dropped)) result.dropped[k] = (result.dropped[k] ?? 0) + (n ?? 0);
    const upTo = walked.last ? fresh.slice(0, fresh.indexOf(walked.last) + 1) : [];
    const moved = after(upTo);
    if (moved) next[account] = moved;
  }
  if (noBody) result.degraded.push({ reason: "mail-no-body", detail: `${noBody} sent message(s) came without a body; read from subject and snippet` });
  if (failed) result.failing = fail("mail", now);
  else ok("mail", now);
  savePending("mail", { scannedAt: new Date(now).toISOString(), next, candidates: result.candidates });
  return result;
}

export async function probeMail(opts: BridgeOptions = {}): Promise<{ source: "mail"; accounts: { account: string; ok: boolean; reason?: string; ownerAction?: string }[] }> {
  const accounts = loadConfig().sources.mail?.accounts ?? [];
  const out = [];
  for (const account of accounts) {
    const res = await callMac(sentCommand(account), opts);
    out.push(res.ok ? { account, ok: true } : { account, ok: false, reason: res.reason, ...(res.ownerAction ? { ownerAction: res.ownerAction } : {}) });
  }
  return { source: "mail", accounts: out };
}

if (isMain(import.meta.url)) {
  run(async () => {
    const cmd = process.argv[2];
    if (cmd === "scan") return scanMail();
    if (cmd === "commit") return commit<MailCursor>("mail", forward);
    if (cmd === "probe") return probeMail();
    throw new Error("usage: scan-mail.ts scan | commit | probe");
  });
}
