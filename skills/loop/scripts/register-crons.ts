// Registers Loop's cron jobs idempotently (Meetly's register-crons.ts, a port
// of The Founder Times' register_crons.py). Creates missing jobs, edits
// drifted ones in place, removes loop-* jobs outside the spec, and never
// touches a job without the loop- prefix. Never remove-then-create: a failed
// create would leave Loop with no poll. Pausing disables both jobs.
import { isMain, run } from "./cli.ts";
import { type Config } from "./config.ts";
import { cronBackend, type CronBackend, type CronJob, type JobSpec } from "./cron-backend.ts";
import { file } from "./paths.ts";
import { readJson } from "./store.ts";

export const POLL_MESSAGE = "Loop poll. Load the loop-poll skill and follow it exactly.";
export const DIGEST_MESSAGE = "Loop digest. Load the loop-digest skill and follow it exactly.";

const PREFIX = "loop-";

// Every 15 minutes: scan what the owner sent, check critical deadlines.
// Daily at the owner's digest time, in their zone: the digest.
export function spec(config: Pick<Config, "digestTime" | "timezone">): JobSpec[] {
  const [hh, mm] = config.digestTime.split(":").map(Number);
  return [
    { name: "loop-poll", schedule: { kind: "every", every: "15m", everyMs: 900_000 }, timeoutSeconds: 600, message: POLL_MESSAGE },
    { name: "loop-digest", schedule: { kind: "cron", expr: `${mm} ${hh} * * *`, tz: config.timezone }, timeoutSeconds: 600, message: DIGEST_MESSAGE },
  ];
}

export type Action = { op: "create" | "edit" | "enable" | "disable" | "remove"; name: string; id?: string };

// Drift is judged only on fields the scheduler reported; a missing field is
// left alone rather than edited on a guess.
function drifted(job: CronJob, s: JobSpec): boolean {
  const { schedule, payload } = job;
  if (schedule?.kind !== undefined && schedule.kind !== s.schedule.kind) return true;
  if (s.schedule.kind === "every" && schedule?.everyMs !== undefined && schedule.everyMs !== s.schedule.everyMs) return true;
  if (s.schedule.kind === "cron") {
    if (schedule?.expr !== undefined && schedule.expr !== s.schedule.expr) return true;
    if (schedule?.tz !== undefined && schedule.tz !== s.schedule.tz) return true;
  }
  if (payload?.message !== undefined && payload.message !== s.message) return true;
  if (payload?.timeoutSeconds !== undefined && payload.timeoutSeconds !== s.timeoutSeconds) return true;
  if (job.sessionTarget !== undefined && job.sessionTarget !== "isolated") return true;
  return false;
}

export function plan(jobs: CronJob[], specs: JobSpec[], paused: boolean): Action[] {
  const actions: Action[] = [];
  const ours = jobs.filter((j) => j.name.startsWith(PREFIX));
  for (const s of specs) {
    const [first, ...dupes] = ours.filter((j) => j.name === s.name);
    if (!first) {
      actions.push({ op: "create", name: s.name });
      continue;
    }
    if (drifted(first, s)) actions.push({ op: "edit", name: s.name, id: first.id });
    if ((first.enabled ?? true) !== !paused) {
      actions.push({ op: paused ? "disable" : "enable", name: s.name, id: first.id });
    }
    for (const d of dupes) actions.push({ op: "remove", name: d.name, id: d.id });
  }
  const names = new Set(specs.map((s) => s.name));
  for (const j of ours) {
    if (!names.has(j.name)) actions.push({ op: "remove", name: j.name, id: j.id });
  }
  return actions;
}

export function reconcile(backend: CronBackend, paused: boolean, specs: JobSpec[]): Action[] {
  const actions = plan(backend.list(), specs, paused);
  const byName = new Map(specs.map((s) => [s.name, s]));
  for (const a of actions) {
    if (a.op === "create") backend.create(byName.get(a.name)!, !paused);
    else if (a.op === "edit") backend.edit(a.id!, byName.get(a.name)!);
    else if (a.op === "enable" || a.op === "disable") backend.setEnabled(a.id!, a.op === "enable");
    else backend.remove(a.id!);
  }
  return actions;
}

export function registerFromConfig(backend: CronBackend = cronBackend()): { paused: boolean; actions: Action[] } {
  const config = readJson<Config | null>(file("config.json"), null);
  if (!config?.setupDoneAt) throw new Error("setup is not finished; run the setup first");
  const paused = config.paused === true;
  return { paused, actions: reconcile(backend, paused, spec(config)) };
}

if (isMain(import.meta.url)) run(() => registerFromConfig());
