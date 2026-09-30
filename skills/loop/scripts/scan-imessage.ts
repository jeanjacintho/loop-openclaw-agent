// Scans the iMessages the owner sent, for commitment candidates.
//
// One fixed argv (SEARCH_ARGV: the newest 200 messages), so Latch can remember
// the owner's approval for the scheduled poll; what is new is cut locally by
// rowid against the cursor (D8). Only the owner's own messages in direct
// chats are candidates; group chats wait for a later version.
//
//   scan-imessage.ts scan     → {candidates, dropped, degraded, …} and a pending file
//   scan-imessage.ts commit   → moves the cursor past what scan handed over
//   scan-imessage.ts probe    → runs the exact argv once, for the owner to approve
import { isMain, run } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { commit, fail, ok, readCursor, savePending } from "./cursor.ts";
import { isEmail, isPhone, normalizeHandle } from "./handles.ts";
import { callMac, type BridgeOptions, type MacCommand } from "./mac.ts";
import { nowMs } from "./paths.ts";
import { countLinks, rowsOf, TEXT_MAX, toIso, walk, type Candidate } from "./scan-common.ts";

export const SEARCH_ARGV = ["plow-messages", "search", "--limit", "200", "--order", "desc"];
export const SEARCH_LIMIT = 200;

export const searchCommand: MacCommand = {
  argv: SEARCH_ARGV, readPaths: ["~/Library/Messages"], timeoutMs: 60_000,
  goal: "Loop: read your recent iMessages to keep track of what you promised and asked for (only your own messages become commitments)",
};

export type MessageRow = {
  rowid: number; fromMe: boolean; group: boolean; handle: string | null; name: string | null;
  text: string; at: string | null; attachments: number;
};

const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

export function parseMessageRows(output: string): { rows: MessageRow[]; unreadable: number } {
  const rows: MessageRow[] = [];
  let unreadable = 0;
  for (const r of rowsOf(output)) {
    const rowid = Number(r.rowid ?? r.ROWID ?? r.id);
    if (!Number.isInteger(rowid) || rowid < 0) {
      unreadable++;
      continue;
    }
    const chat = String(r.chat_identifier ?? r.chatIdentifier ?? "");
    const participants = Array.isArray(r.participants) ? r.participants.length : 0;
    const group = truthy(r.is_group ?? r.isGroup) || r.chat_style === 43 || participants > 1 || /^chat\d+/i.test(chat);
    const rawHandle = [r.handle, r.chat_identifier, r.chatIdentifier, r.to, r.sender].find((h) => typeof h === "string" && (isEmail(h) || isPhone(h))) as string | undefined;
    const attachments = Array.isArray(r.attachments) ? r.attachments.length
      : truthy(r.has_attachment ?? r.hasAttachment ?? r.cache_has_attachments) ? 1 : Number(r.attachment_count ?? 0) || 0;
    rows.push({
      rowid, fromMe: truthy(r.is_from_me ?? r.isFromMe ?? r.from_me), group,
      handle: rawHandle ? normalizeHandle(rawHandle) : null,
      name: typeof (r.display_name ?? r.name ?? r.contact) === "string" ? String(r.display_name ?? r.name ?? r.contact) : null,
      text: typeof (r.text ?? r.body) === "string" ? String(r.text ?? r.body) : "",
      at: toIso(r.date ?? r.sent_at ?? r.sentAt ?? r.timestamp), attachments,
    });
  }
  rows.sort((a, b) => a.rowid - b.rowid);
  return { rows, unreadable };
}

export function forward(from: number | null, to: number): number {
  if (from !== null && to < from) throw new Error(`the iMessage cursor never moves back (at ${from}, asked ${to})`);
  return to;
}

export type ScanResult = {
  source: "imessage";
  disabled?: true;
  candidates: Candidate[];
  dropped: Record<string, number>;
  degraded: { reason: string; detail?: string; ownerAction?: string }[];
  initialized?: true;
  failing?: { failingSince: string; warn: boolean };
};

export async function scanIMessage(opts: BridgeOptions = {}, now = nowMs()): Promise<ScanResult> {
  const config = loadConfig();
  const result: ScanResult = { source: "imessage", candidates: [], dropped: {}, degraded: [] };
  if (!config.sources.imessage) return { ...result, disabled: true };
  const res = await callMac(searchCommand, opts);
  let parsed: ReturnType<typeof parseMessageRows> | undefined;
  if (res.ok) {
    try {
      parsed = parseMessageRows(res.output);
    } catch (err) {
      result.degraded.push({ reason: "unreadable", detail: (err as Error).message });
    }
  } else {
    result.degraded.push({ reason: res.reason, ...(res.detail ? { detail: res.detail } : {}), ...(res.ownerAction ? { ownerAction: res.ownerAction } : {}) });
  }
  if (!parsed) return { ...result, failing: fail("imessage", now) };
  ok("imessage", now);
  if (parsed.unreadable) result.dropped.unreadable = parsed.unreadable;
  const pos = readCursor<number>("imessage").pos;
  const newest = parsed.rows.at(-1)?.rowid ?? 0;
  if (pos === null) {
    // The first scan never reads history: it only marks where "new" starts.
    savePending("imessage", { scannedAt: new Date(now).toISOString(), next: newest, candidates: [] });
    return { ...result, initialized: true };
  }
  const fresh = parsed.rows.filter((r) => r.rowid > pos);
  // The newest 200 are all past the cursor: some messages in between were never read.
  if (parsed.rows.length >= SEARCH_LIMIT && fresh.length === parsed.rows.length && parsed.rows[0]!.rowid > pos + 1) {
    result.degraded.push({ reason: "imessage-gap", detail: `more than ${SEARCH_LIMIT} messages since the last read; older ones were skipped` });
  }
  const walked = walk(fresh, (r) => {
    if (!r.fromMe) return { skip: "received" };
    if (r.group) return { skip: "group" };
    if (!r.handle) return { skip: "no_handle" };
    return { text: r.text.trim().slice(0, TEXT_MAX), recipients: [r.handle], ownerHandles: [], attachments: r.attachments };
  }, (r, m, signals) => ({
    source: "imessage", item: `imessage:${r.rowid}`, thread: r.handle!, to: [r.handle!], cc: [], toNames: r.name ? [r.name] : [],
    sentAt: r.at ?? new Date(now).toISOString(), text: m.text, signals, attachments: r.attachments, links: countLinks(m.text),
  }));
  result.candidates = walked.candidates;
  // "received" rows are the other side talking; they are not dropped commitments.
  const { received: _r, ...dropped } = walked.dropped;
  result.dropped = { ...result.dropped, ...(dropped as Record<string, number>) };
  const next = walked.last ? walked.last.rowid : pos;
  savePending("imessage", { scannedAt: new Date(now).toISOString(), next: Math.max(next, pos), candidates: result.candidates });
  return result;
}

export async function probeIMessage(opts: BridgeOptions = {}): Promise<{ source: "imessage"; ok: boolean; reason?: string; ownerAction?: string }> {
  const res = await callMac(searchCommand, opts);
  return res.ok ? { source: "imessage", ok: true } : { source: "imessage", ok: false, reason: res.reason, ...(res.ownerAction ? { ownerAction: res.ownerAction } : {}) };
}

if (isMain(import.meta.url)) {
  run(async () => {
    const cmd = process.argv[2];
    if (cmd === "scan") return scanIMessage();
    if (cmd === "commit") return commit<number>("imessage", forward);
    if (cmd === "probe") return probeIMessage();
    throw new Error("usage: scan-imessage.ts scan | commit | probe");
  });
}
