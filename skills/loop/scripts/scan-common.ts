// What both scanners share: the candidate they hand the model, the cap per
// poll, and walking new messages in order through the prefilter.
import { sameHandle } from "./handles.ts";
import { prefilter, type DropReason, type Message, type Signal } from "./prefilter.ts";

export type Candidate = {
  source: "gmail" | "imessage";
  item: string; // reopens the message: gmail:<account>:<thread>@<id>, imessage:<rowid>
  thread: string; // the Gmail thread id, or the iMessage handle of the chat
  to: string[]; // who it went to (normalized handles)
  cc: string[];
  toNames: string[];
  sentAt: string; // ISO; relative deadlines are read from here, not from the scan
  subject?: string;
  text: string; // the owner's own words; an evidence quote must be a substring of it
  signals: Signal[];
  attachments: number;
  links: number;
  backfill?: true; // from the look-back at setup, not the live poll
};

// A message to or from someone with a live commitment: possible evidence
// that it was delivered, called off or chased. Sent ones are the owner's; received
// ones are the other side's words, and are data only.
export type EvidenceMessage = {
  source: "gmail" | "imessage";
  item: string;
  thread: string;
  direction: "sent" | "received";
  from: string; // normalized handle ("owner" for the owner's own)
  to: string[];
  sentAt: string;
  text: string;
  attachments: number;
  links: number;
};

// True when any of `handles` is one of the people in `known`.
export function involves(handles: string[], known: string[]): boolean {
  return handles.some((h) => known.some((k) => sameHandle(h, k)));
}

// At most this many candidates per source per poll, oldest first. The cursor
// stops after the last one handed over, so the rest come in the next poll.
export const CAP = 40;
export const TEXT_MAX = 4_000;

export type Walked<R> = { candidates: Candidate[]; dropped: Partial<Record<DropReason | string, number>>; last: R | null; capped: boolean };

export function countLinks(text: string): number {
  return (text.match(/https?:\/\/\S+/g) ?? []).length;
}

// Rows in ascending order. `toCandidate` turns a kept row into a candidate;
// `message` gives the prefilter its view of the row, or a reason to skip it.
export function walk<R>(rows: R[], message: (r: R) => Message | { skip: string }, toCandidate: (r: R, m: Message, signals: Signal[]) => Candidate, cap = CAP): Walked<R> {
  const out: Walked<R> = { candidates: [], dropped: {}, last: null, capped: false };
  for (const row of rows) {
    if (out.candidates.length >= cap) {
      out.capped = true;
      break;
    }
    out.last = row;
    const m = message(row);
    if ("skip" in m) {
      out.dropped[m.skip] = (out.dropped[m.skip] ?? 0) + 1;
      continue;
    }
    const verdict = prefilter(m);
    if (!verdict.keep) {
      out.dropped[verdict.reason] = (out.dropped[verdict.reason] ?? 0) + 1;
      continue;
    }
    out.candidates.push(toCandidate(row, m, verdict.signals));
  }
  return out;
}

// A field that may be a string, a list, or missing, as a list of strings.
export function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => list(v));
  if (typeof value === "string") return value.split(/,(?![^<]*>)/).map((s) => s.trim()).filter(Boolean);
  if (value && typeof value === "object" && "email" in value) return list((value as { email: unknown }).email);
  return [];
}

// A date the tools may print as ISO, RFC 2822, or epoch seconds/milliseconds.
export function toIso(value: unknown): string | null {
  if (typeof value === "number" || (typeof value === "string" && /^\d{10,13}$/.test(value))) {
    const n = Number(value);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// The rows of a tool's JSON output: a list, or a list under a common key.
export function rowsOf(output: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(`the Mac's output is not JSON: ${output.slice(0, 120)}`);
  }
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  for (const key of ["messages", "threads", "results", "items", "rows", "data"]) {
    const v = (parsed as Record<string, unknown> | null)?.[key];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  throw new Error(`the Mac's output has no list of messages: ${output.slice(0, 120)}`);
}
