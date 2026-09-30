// The scheduler register-crons.ts writes to: OpenClaw's own cron service,
// through `node /app/openclaw.mjs cron ...` inside the running container
// (exec inherits the gateway password, so no secret is ever an argument).
// Meetly's cron-backend.ts, with cron-expression schedules for the digest.
//
// `cron list` hides disabled jobs, so listing always passes --all, and the
// listing pages with hasMore. Never read "could not tell what is registered"
// as "nothing is": a failed command, non-JSON, a wrong shape or a truncated
// page throws, or every job would be registered twice.
import { spawnSync } from "node:child_process";

export type Proc = { status: number; stdout: string; stderr: string };
export type Runner = (argv: string[]) => Proc;

export type Schedule =
  | { kind: "every"; every: string; everyMs: number }
  | { kind: "cron"; expr: string; tz: string };

export type CronJob = {
  id: string;
  name: string;
  enabled?: boolean;
  sessionTarget?: string;
  schedule?: { kind?: string; everyMs?: number; expr?: string; tz?: string };
  payload?: { kind?: string; message?: string; timeoutSeconds?: number };
};

export type JobSpec = { name: string; schedule: Schedule; timeoutSeconds: number; message: string };

export type CronBackend = {
  list(): CronJob[];
  create(spec: JobSpec, enabled: boolean): void;
  edit(id: string, spec: JobSpec): void;
  setEnabled(id: string, enabled: boolean): void;
  remove(id: string): void;
};

export const spawnRunner: Runner = (argv) => {
  const proc = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 120_000 });
  return {
    status: proc.status ?? 1,
    stdout: proc.stdout ?? "",
    stderr: proc.stderr || (proc.error ? String(proc.error) : ""),
  };
};

function refuse(what: string): never {
  throw new Error(`refusing to touch the scheduler: ${what}`);
}

// LOOP_OPENCLAW_CLI points the tests at a stand-in for OpenClaw's CLI.
export function defaultBase(): string[] {
  return ["node", process.env.LOOP_OPENCLAW_CLI || "/app/openclaw.mjs"];
}

export function scheduleArgs(s: Schedule): string[] {
  // A daily digest runs at the owner's minute, not somewhere in a stagger window.
  return s.kind === "every" ? ["--every", s.every] : ["--cron", s.expr, "--tz", s.tz, "--exact"];
}

export function cronBackend(runner: Runner = spawnRunner, base: string[] = defaultBase()): CronBackend {
  const cron = (args: string[]): Proc => {
    const argv = [...base, "cron", ...args];
    const proc = runner(argv);
    if (proc.status !== 0) {
      throw new Error(`cron ${args[0]} failed (exit ${proc.status}):\n${proc.stdout}\n${proc.stderr}`);
    }
    return proc;
  };
  const turn = (spec: JobSpec) => [
    ...scheduleArgs(spec.schedule),
    "--session", "isolated",
    "--message", spec.message,
    "--timeout-seconds", String(spec.timeoutSeconds),
    "--no-deliver",
  ];
  return {
    list() {
      const proc = runner([...base, "cron", "list", "--all", "--json"]);
      if (proc.status !== 0) refuse(`could not list jobs (exit ${proc.status}):\n${proc.stdout}\n${proc.stderr}`);
      let listing: unknown;
      try {
        listing = JSON.parse(proc.stdout);
      } catch {
        refuse(`the job listing is not JSON: ${proc.stdout.slice(0, 200)}`);
      }
      const rows = (listing as { jobs?: unknown } | null)?.jobs;
      const valid = Array.isArray(rows) && rows.every(
        (r) => r !== null && typeof r === "object" && typeof r.id === "string" && typeof r.name === "string",
      );
      if (!valid) refuse(`the job listing has an unexpected shape: ${proc.stdout.slice(0, 200)}`);
      if ((listing as { hasMore?: unknown }).hasMore) refuse("the job listing is truncated (hasMore)");
      return rows as CronJob[];
    },
    create(spec, enabled) {
      cron(["add", "--name", spec.name, ...turn(spec), ...(enabled ? [] : ["--disabled"]), "--json"]);
    },
    edit(id, spec) {
      cron(["edit", id, ...turn(spec)]);
    },
    setEnabled(id, enabled) {
      cron(["edit", id, enabled ? "--enable" : "--disable"]);
    },
    remove(id) {
      cron(["rm", id, "--json"]);
    },
  };
}
