import assert from "node:assert/strict";
import { test } from "node:test";
import { cronBackend, type CronJob, type Proc } from "../skills/loop/scripts/cron-backend.ts";
import { DIGEST_MESSAGE, plan, POLL_MESSAGE, reconcile, spec } from "../skills/loop/scripts/register-crons.ts";

const SPEC = spec({ digestTime: "08:30", timezone: "America/Sao_Paulo" });
const poll = (over: Partial<CronJob> = {}): CronJob => ({
  id: "j1", name: "loop-poll", enabled: true, sessionTarget: "isolated",
  schedule: { kind: "every", everyMs: 900_000 }, payload: { kind: "agentTurn", message: POLL_MESSAGE, timeoutSeconds: 600 }, ...over,
});
const digest = (over: Partial<CronJob> = {}): CronJob => ({
  id: "j2", name: "loop-digest", enabled: true, sessionTarget: "isolated",
  schedule: { kind: "cron", expr: "30 8 * * *", tz: "America/Sao_Paulo" },
  payload: { kind: "agentTurn", message: DIGEST_MESSAGE, timeoutSeconds: 600 }, ...over,
});

test("a poll every 15 minutes and a digest at the owner's time in their zone", () => {
  assert.deepEqual(SPEC.map((s) => [s.name, s.schedule]), [
    ["loop-poll", { kind: "every", every: "15m", everyMs: 900_000 }],
    ["loop-digest", { kind: "cron", expr: "30 8 * * *", tz: "America/Sao_Paulo" }],
  ]);
  assert.ok(POLL_MESSAGE.startsWith("Loop poll."));
  assert.ok(DIGEST_MESSAGE.startsWith("Loop digest."));
});

test("registered and matching jobs need nothing; drift is edited in place; duplicates and strays go", () => {
  assert.deepEqual(plan([poll(), digest()], SPEC, false), []);
  assert.deepEqual(plan([poll(), digest({ schedule: { kind: "cron", expr: "0 7 * * *", tz: "America/Sao_Paulo" } })], SPEC, false),
    [{ op: "edit", name: "loop-digest", id: "j2" }]);
  assert.deepEqual(plan([poll(), digest({ schedule: { kind: "cron", expr: "30 8 * * *", tz: "UTC" } })], SPEC, false),
    [{ op: "edit", name: "loop-digest", id: "j2" }]);
  assert.deepEqual(plan([poll({ schedule: { kind: "every", everyMs: 300_000 } }), digest()], SPEC, false),
    [{ op: "edit", name: "loop-poll", id: "j1" }]);
  assert.deepEqual(plan([poll(), poll({ id: "j9" }), digest(), poll({ id: "j5", name: "loop-old" }), poll({ id: "x", name: "meetly-poll" })], SPEC, false),
    [{ op: "remove", name: "loop-poll", id: "j9" }, { op: "remove", name: "loop-old", id: "j5" }]);
});

test("pausing disables both jobs and resuming enables them, never removing them", () => {
  assert.deepEqual(plan([poll(), digest()], SPEC, true), [
    { op: "disable", name: "loop-poll", id: "j1" }, { op: "disable", name: "loop-digest", id: "j2" },
  ]);
  assert.deepEqual(plan([poll({ enabled: false }), digest({ enabled: false })], SPEC, false), [
    { op: "enable", name: "loop-poll", id: "j1" }, { op: "enable", name: "loop-digest", id: "j2" },
  ]);
  assert.deepEqual(plan([], SPEC, true).map((a) => a.op), ["create", "create"]);
});

test("the backend sends the digest as an exact cron in the owner's zone and refuses an unreadable listing", () => {
  const calls: string[][] = [];
  const runner = (argv: string[]): Proc => {
    calls.push(argv);
    return { status: 0, stdout: argv.includes("list") ? JSON.stringify({ jobs: [], hasMore: false }) : "{}", stderr: "" };
  };
  reconcile(cronBackend(runner, ["node", "/app/openclaw.mjs"]), false, SPEC);
  const add = calls.find((c) => c.includes("add") && c.includes("loop-digest"))!;
  assert.deepEqual(add.slice(0, 6), ["node", "/app/openclaw.mjs", "cron", "add", "--name", "loop-digest"]);
  assert.ok(add.join(" ").includes("--cron 30 8 * * * --tz America/Sao_Paulo --exact --session isolated"));
  assert.ok(calls.find((c) => c.includes("loop-poll"))!.join(" ").includes("--every 15m"));
  for (const stdout of ["not json", JSON.stringify({ jobs: [{ id: 1 }] }), JSON.stringify({ jobs: [], hasMore: true })]) {
    assert.throws(() => cronBackend(() => ({ status: 0, stdout, stderr: "" })).list(), /refusing to touch the scheduler/);
  }
  assert.throws(() => cronBackend(() => ({ status: 1, stdout: "", stderr: "gateway down" })).list(), /could not list jobs/);
});
