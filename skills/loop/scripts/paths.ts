import { join } from "node:path";

// Loop's state directory, read at call time so tests can point it elsewhere.
export function home(): string {
  return process.env.LOOP_HOME || "/var/lib/plow/loop";
}

export function file(name: string): string {
  return join(home(), name);
}

// The current instant. LOOP_NOW (an ISO time) pins it, so a scheduled turn
// and the tests see one fixed "now" across every script they run.
export function nowMs(): number {
  const pinned = process.env.LOOP_NOW;
  if (!pinned) return Date.now();
  const ms = Date.parse(pinned);
  if (Number.isNaN(ms)) throw new Error(`LOOP_NOW is not a date: ${pinned}`);
  return ms;
}
