// A stand-in for `node /app/openclaw.mjs cron …`: keeps jobs in the JSON file
// FAKE_CRON_FILE and understands the argv cron-backend.ts sends.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = process.env.FAKE_CRON_FILE;
const jobs = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
const [cmd, op, ...rest] = process.argv.slice(2);
const flag = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
const save = () => writeFileSync(path, JSON.stringify(jobs));
const EVERY = { "15m": 900_000 };

function apply(job) {
  if (flag("--every")) job.schedule = { kind: "every", everyMs: EVERY[flag("--every")] ?? 0 };
  if (flag("--cron")) job.schedule = { kind: "cron", expr: flag("--cron"), tz: flag("--tz") };
  if (flag("--message")) job.payload = { kind: "agentTurn", message: flag("--message"), timeoutSeconds: Number(flag("--timeout-seconds")) };
  if (flag("--session")) job.sessionTarget = flag("--session");
  if (rest.includes("--enable")) job.enabled = true;
  if (rest.includes("--disable")) job.enabled = false;
}

if (cmd !== "cron") process.exit(2);
if (op === "list") {
  process.stdout.write(JSON.stringify({ jobs, hasMore: false }));
} else if (op === "add") {
  const job = { id: `j${jobs.length + 1}`, name: flag("--name"), enabled: !rest.includes("--disabled") };
  apply(job);
  jobs.push(job);
  save();
  process.stdout.write(JSON.stringify(job));
} else {
  const job = jobs.find((j) => j.id === rest[0]);
  if (!job) {
    process.stderr.write("no such job");
    process.exit(1);
  }
  if (op === "rm") jobs.splice(jobs.indexOf(job), 1);
  else apply(job);
  save();
  process.stdout.write("{}");
}
